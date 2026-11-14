// Bound-fact narration (spec §8.4). The LLM may only SELECT an approved template; the server fills every value.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { fmtM } from "@artfit/geometry";

export const TOOL_NAMES = ["search_spaces", "inspect_space", "evaluate_placement", "plan_alternatives"] as const;

type Rec = "keep" | "adjust" | "none";
interface Template { id: string; recommendation: Rec; text: string; applies: (f: Facts) => boolean }

/** Fact registry built only from the current deterministic tool results. Null → unknown wording. */
export type Facts = Record<string, string | null>;

export const TEMPLATES: Template[] = [
  {
    id: "floor_conflict_other_floor_fit", recommendation: "keep",
    text: "Among tested placements, {A.name} does not meet {req.clearance} under {A.scenario}. {B.name} has {B.passCount} passing floor layouts under {B.scenario} with your requirements unchanged. {B.remainingChecks}",
    applies: (f) => f["B.passCount"] !== null,
  },
  {
    id: "floor_conflict_adjust_in_place", recommendation: "adjust",
    text: "Among tested placements, {A.name} does not meet {req.clearance} under {A.scenario}. Reducing only your preferred clearance to {adj.proposed} (not below your minimum {req.minimum}) gives a passing floor layout in the same space. {A.remainingChecks}",
    applies: (f) => f["adj.proposed"] !== null,
  },
  {
    id: "floor_conflict_no_supported_option", recommendation: "none",
    text: "Among tested placements, {A.name} does not meet {req.clearance} under {A.scenario}, and no supported alternative was found. Keep-requirements option: {B.reason}. Same-space option: {adj.reason}.",
    applies: () => true,
  },
];

const BANNED = /\b(vacant|empty|unfurnished|cleared|ready|permitted|guaranteed|impossible)\b/i;
const NEGATED_OK = /\b(vacancy not verified|not verified|not confirmed)\b/i;

export function fill(text: string, facts: Facts): string {
  return text.replace(/\{([A-Za-z0-9_.]+)\}/g, (_, k) => (facts[k] ?? "unknown"));
}

/** The four MVP validation rules plus the template-skeleton check. Returns error list. */
export function validateNarration(out: { recommendation: string; templateId: string; text: string }, facts: Facts, deterministic: Rec): string[] {
  const errs: string[] = [];
  const t = TEMPLATES.find((x) => x.id === out.templateId);
  if (!t) errs.push("template not in allowlist");
  else {
    if (t.text !== out.text) errs.push("text does not match approved template skeleton");
    if (!t.applies(facts)) errs.push("template applicability predicate failed");
    if (t.recommendation !== deterministic) errs.push("template recommendation differs from deterministic result");
  }
  if (out.recommendation !== deterministic) errs.push("recommendation differs from deterministic result");
  errs.push(...checkTemplateText(out.text, facts));
  return errs;
}

/** Shared checks: placeholders resolve, no bare digits outside placeholders, no banned qualitative claims. */
export function checkTemplateText(text: string, facts: Facts): string[] {
  const errs: string[] = [];
  for (const m of text.matchAll(/\{([A-Za-z0-9_.]+)\}/g)) if (!(m[1] in facts)) errs.push(`unresolved placeholder ${m[1]}`);
  const stripped = text.replace(/\{[A-Za-z0-9_.]+\}/g, "");
  if (/\d/.test(stripped)) errs.push("bare digits outside placeholders");
  for (const sentence of stripped.split(/[.!?]/)) if (BANNED.test(sentence) && !NEGATED_OK.test(sentence)) errs.push("banned claim: " + sentence.trim());
  return errs;
}

export function deterministicNarration(facts: Facts, rec: Rec) {
  const t = TEMPLATES.find((x) => x.recommendation === rec && x.applies(facts)) ?? TEMPLATES[2];
  return { templateId: t.id, recommendation: rec, text: fill(t.text, facts), source: "deterministic_template" as const };
}

/** Build the fact registry from plan_alternatives output (values formatted here, never by the LLM). */
export function factsFromPlan(plan: any, names: Record<string, string>): Facts {
  const scen = (s: any) => (s?.mode === "hypothetical_furniture_removal" ? "the conditional furniture-removal scenario" : "the as-scanned layout");
  const remaining = (e: any) => {
    if (!e) return null;
    const items: string[] = [];
    if (e.geometryVerification !== "Verified") items.push("spatial verification");
    if (e.heightCheck !== "pass") items.push("local ceiling height");
    items.push("access route", "current vacancy (not verified)", "short-term use and cost");
    return "Still to verify: " + items.join(", ") + ".";
  };
  const best = plan.keepRequirements?.best;
  const fe = plan.failedSpace?.evaluation;
  return {
    "A.name": names[plan.failedSpace?.spaceId] ?? null,
    "A.scenario": scen(plan.failedSpace?.scenario),
    "A.remainingChecks": remaining(plan.adjustInPlace?.evaluation ?? fe),
    "req.clearance": `a preferred clearance of ${plan.brief.preferredClearanceM} m`,
    "req.minimum": plan.brief.minimumClearanceM != null ? `${plan.brief.minimumClearanceM} m` : null,
    "B.name": best ? names[best.spaceId] ?? best.spaceId : null,
    "B.passCount": best && (best.status === "supported" || best.status === "verify_next") ? String(best.evaluation?.passCount ?? 0) : null,
    "B.scenario": best ? scen(best.scenario) : null,
    "B.remainingChecks": best ? remaining(best.evaluation) : null,
    "B.reason": best ? best.reason.replace(/_/g, " ") : "no other matched candidate",
    "adj.proposed": plan.adjustInPlace?.proposedClearanceM != null ? `${plan.adjustInPlace.proposedClearanceM} m` : null,
    "adj.measured": plan.adjustInPlace?.measuredBestM != null ? `${fmtM(plan.adjustInPlace.measuredBestM)} m (rounded down)` : null,
    "adj.reason": (plan.adjustInPlace?.reason ?? "unavailable").replace(/_/g, " "),
  };
}

const Selection = z.object({
  recommendation: z.enum(["keep", "adjust", "none"]),
  templateId: z.string(),
  factRefs: z.array(z.string()),
  text: z.string(),
});

/** Optional LLM selection. Any failure → deterministic fallback (spec §8.4, §10.4). */
export async function narrate(facts: Facts, rec: Rec) {
  const fallback = deterministicNarration(facts, rec);
  if (process.env.LLM_PROVIDER !== "anthropic" || !process.env.LLM_API_KEY) return { ...fallback, note: "LLM not configured" };
  try {
    const client = new Anthropic({ apiKey: process.env.LLM_API_KEY, timeout: 20_000, maxRetries: 1 });
    const available = Object.entries(facts).map(([k, v]) => `${k}: ${v === null ? "null" : "available"}`).join("\n");
    const resp = await client.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 2000,
      output_config: { effort: "low", format: zodOutputFormat(Selection) },
      system: "You select an explanation template for an art-space placement result. You never invent numbers, dimensions, counts, prices or condition claims. Copy the chosen template text EXACTLY, placeholders included. Use only templates whose recommendation equals the deterministic recommendation.",
      messages: [{
        role: "user",
        content: `Deterministic recommendation: ${rec}\n\nApproved templates (id | recommendation | text):\n${TEMPLATES.map((t) => `${t.id} | ${t.recommendation} | ${t.text}`).join("\n")}\n\nFacts (values withheld; null means unknown):\n${available}`,
      }],
    });
    const out = resp.parsed_output;
    if (!out) return { ...fallback, note: "LLM output unparseable" };
    const errs = validateNarration(out, facts, rec);
    if (errs.length) return { ...fallback, note: "LLM selection rejected: " + errs.join("; ") };
    return { templateId: out.templateId, recommendation: rec, text: fill(out.text, facts), source: "llm_selected_template" as const };
  } catch (e) {
    return { ...fallback, note: "LLM unavailable: " + (e as Error).message.slice(0, 120) };
  }
}
