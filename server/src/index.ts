import express from "express";
import { ScanCache, ScenarioError, type SpatialAnnotation } from "@artfit/geometry";
import { KitError, loadKit, type Kit } from "./adapters/costarKit.js";
import { InputError, evaluate_placement, inspect_space, plan_alternatives, search_spaces } from "./agent/tools.js";
import { TOOL_NAMES, factsFromPlan, narrate } from "./agent/narration.js";
import { AGENT_MODEL, llmConfigured, runAgent } from "./agent/loop.js";
import { interpretEdit } from "./agent/workspaceEdit.js";
import { interpretGroupEdit } from "./agent/groupEdit.js";
import { loadLedger, saveLedger } from "./evidence/ledger.js";
import { loadAnnotation, saveAnnotation } from "./scenarios/store.js";

const PORT = Number(process.env.PORT ?? 8787);
const app = express();
app.use(express.json({ limit: "2mb" }));

let kit: Kit | null = null;
let kitError: string | null = null;
const cache = new ScanCache(128);
const reqId = (req: express.Request) => String(req.body?.requestId ?? req.query.requestId ?? "");

async function boot() {
  try {
    kit = await loadKit(process.env.COSTAR_KIT_DIR ?? "", process.env.SNAPSHOT_REF_DATE ?? "2026-11-10");
    kitError = null;
    console.log(`[artfit] kit loaded in ${kit.audit.loadMs} ms: ${kit.spaces.length} space records`);
  } catch (e) {
    kitError = e instanceof KitError ? `Local CoStar kit error: ${e.message}` : `Kit load failed: ${(e as Error).message}`;
    console.error("[artfit]", kitError);
  }
}

const needKit = (): Kit => {
  if (!kit) throw new KitError(kitError ?? "kit still loading");
  return kit;
};

function handle(fn: (req: express.Request) => unknown | Promise<unknown>) {
  return async (req: express.Request, res: express.Response) => {
    try { res.json(await fn(req)); } catch (e) {
      const status = e instanceof InputError || e instanceof ScenarioError ? 400 : e instanceof KitError ? 503 : 500;
      if (status === 500) console.error(e);
      res.status(status).json({ error: (e as Error).message, kind: (e as Error).constructor.name, requestId: reqId(req) });
    }
  };
}

app.get("/api/health", handle(() => ({ ok: !!kit, kitError, audit: kit?.audit && { ...kit.audit, parseErrors: kit.audit.parseErrors.length }, tools: TOOL_NAMES, llm: process.env.LLM_PROVIDER || null })));
app.post("/api/kit/reload", handle(async () => { await boot(); return { ok: !!kit, kitError }; }));

// Spec §10.1 routes
app.post("/api/spaces/search", handle((req) => search_spaces({ kit: needKit(), cache, requestId: reqId(req) }, req.body?.brief)));
app.get("/api/spaces/:id", handle((req) => inspect_space({ kit: needKit(), cache, requestId: reqId(req) }, req.params.id)));
app.get("/api/spaces/:id/geometry", handle((req) => {
  needKit();
  const a = loadAnnotation(req.params.id);
  if (!a) throw new InputError("no traced geometry for this space");
  return { annotation: a, ledger: { match: loadLedger(req.params.id).match, evidenceVersion: loadLedger(req.params.id).evidenceVersion } };
}));
app.post("/api/placement/evaluate", handle((req) => evaluate_placement({ kit: needKit(), cache, requestId: reqId(req) }, req.body)));
app.post("/api/agent/plan", handle(async (req) => {
  const k = needKit();
  const plan = plan_alternatives({ kit: k, cache, requestId: reqId(req) }, req.body);
  const names = Object.fromEntries([req.body.failedSpaceId, ...(req.body.otherSpaceIds ?? [])].map((id: string) => [id, k.byId.get(id)?.candidate.displayName ?? id]));
  const narration = await narrate(factsFromPlan(plan, names), plan.recommendation);
  return { ...plan, narration };
}));

// Agent run (spec §8): Claude plans calls to the four tools. Streams NDJSON events so the UI shows each step.
app.post("/api/agent/run", async (req, res) => {
  let k: Kit;
  try { k = needKit(); } catch (e) { res.status(503).json({ error: (e as Error).message }); return; }
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();
  const send = (ev: unknown) => res.write(JSON.stringify(ev) + "\n");
  try {
    await runAgent(k, { kit: k, cache, requestId: reqId(req) }, { message: String(req.body?.message ?? ""), brief: req.body?.brief ?? undefined }, send);
  } catch (e) {
    send({ type: "error", message: (e as Error).message });
  }
  res.end();
});
// Workspace artwork editing (separate from the four-tool search agent): Claude → allowlisted edit ops only.
app.post("/api/workspace/edit", handle((req) => interpretEdit(needKit(), req.body)));
app.post("/api/workspace/group-edit", handle((req) => interpretGroupEdit(needKit(), req.body)));
app.get("/api/agent/status", (_req, res) => { res.json({ configured: llmConfigured(), model: AGENT_MODEL, tools: TOOL_NAMES }); });

// Internal team-only annotation/review routes (not agent tools; spec §6, §8.1).
app.get("/api/annotate/:id", handle((req) => ({ annotation: loadAnnotation(req.params.id), ledger: loadLedger(req.params.id), candidate: needKit().byId.get(req.params.id)?.candidate ?? null })));
app.put("/api/annotate/:id", handle((req) => {
  const a = req.body?.annotation as SpatialAnnotation;
  if (!a || a.spaceId !== req.params.id) throw new InputError("annotation.spaceId must match route");
  if (a.annotationVerified && !a.reviewedBy) throw new InputError("verifying an annotation requires reviewedBy");
  return { annotation: saveAnnotation(a, loadAnnotation(req.params.id)) };
}));
app.post("/api/annotate/:id/match-review", handle((req) => {
  const l = loadLedger(req.params.id);
  if (!l.match) throw new InputError("no proposed match to review");
  const { verified, reviewedBy, note } = req.body ?? {};
  if (typeof verified !== "boolean" || typeof reviewedBy !== "string" || !reviewedBy.trim()) throw new InputError("verified:boolean and reviewedBy required");
  const at = new Date().toISOString();
  const id = `ev-match-review-${l.entries.length + 1}`;
  l.entries.push({ id, claim: "model_match", value: verified ? "confirmed" : "rejected", sourceType: "scan_review", sourceRef: `matterport:${l.match.modelId}`, observedAt: null, scope: `exact suite region ${l.match.regionId}`, note: String(note ?? ""), reviewedBy: reviewedBy.trim(), reviewedAt: at });
  l.match = { ...l.match, verified, reviewedBy: reviewedBy.trim(), reviewedAt: at, evidenceIds: [...l.match.evidenceIds, id] };
  l.evidenceVersion++;
  saveLedger(l);
  return { ledger: l };
}));

app.listen(PORT, () => console.log(`[artfit] server on http://localhost:${PORT}`));
boot();
