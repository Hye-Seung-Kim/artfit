// One artwork edit state per space session, shared by manual controls, the Claude edit path and both renderers.
import { useCallback, useRef, useState } from "react";
import {
  EditError, applyOps, commit, createHistory, redo, resetToInitial, undo,
  type ApplyContext, type ArtworkEditState, type EditHistory, type EditOp, type Reevaluate,
} from "@artfit/geometry";

export type AiStatus =
  | { kind: "idle" }
  | { kind: "interpreting"; message: string }
  | { kind: "applied"; message: string; summary: string[]; ms?: number }
  | { kind: "clarify"; message: string; question: string; needsInfo: boolean }
  | { kind: "failed"; message: string; reason: string }
  | { kind: "discarded"; message: string; reason: string }
  /** A change made without Claude (Undo/Redo/Reset buttons, manual controls); replaces any earlier Claude status. */
  | { kind: "local"; summary: string };

export interface EditorApi {
  history: EditHistory;
  state: ArtworkEditState;
  previous: ArtworkEditState | null;
  lastReevaluate: Reevaluate;
  ai: AiStatus;
  exchanges: { request: string; result: string }[];
  apply(ops: EditOp[], ctx: ApplyContext, source: "manual" | "claude", coalesceKey?: string): { ok: true; changes: string[] } | { ok: false; error: string; needsInfo: boolean };
  setDims(patch: Partial<Pick<ArtworkEditState, "widthM" | "depthM" | "heightM">>, coalesceKey: string): void;
  undo(): void;
  redo(): void;
  reset(): void;
  askClaude(message: string, ctxFor: () => ApplyContext, viewLabel: string): Promise<void>;
  cancelClaude(): void;
}

const newArtworkId = () => `art-${Math.random().toString(36).slice(2, 8)}`;

type ArtworkProps = Pick<ArtworkEditState, "widthM" | "depthM" | "heightM" | "baseElevationM" | "color" | "material">;
const pickArtwork = (s: ArtworkEditState): ArtworkProps => ({ widthM: s.widthM, depthM: s.depthM, heightM: s.heightM, baseElevationM: s.baseElevationM, color: s.color, material: s.material });
const sameArtwork = (a: ArtworkEditState, b: ArtworkProps) => (Object.keys(b) as (keyof ArtworkProps)[]).every((k) => a[k] === b[k]);

/** Session-scoped editor. Each space keeps its own history; switching back restores it. */
export function useArtworkEditor(spaceId: string, seed: Omit<ArtworkEditState, "spaceId" | "artworkId" | "version" | "mode" | "pose">): EditorApi {
  const sessions = useRef(new Map<string, EditHistory>());
  const artworkId = useRef(newArtworkId());
  const [, force] = useState(0);
  const [ai, setAi] = useState<AiStatus>({ kind: "idle" });
  const [exchanges, setExchanges] = useState<{ request: string; result: string }[]>([]);
  const [lastReevaluate, setLastReevaluate] = useState<Reevaluate>("none");
  const inflight = useRef<{ abort: AbortController; seq: number } | null>(null);
  const seq = useRef(0);
  const activeSpace = useRef(spaceId);
  activeSpace.current = spaceId; // live value, read when a late response arrives

  // The artwork (size, lift, finish) is the same object in every space; only its position/rotation is per space.
  // Remember the artwork as last shown so switching spaces carries it over instead of resetting it.
  const lastArtwork = useRef<ArtworkProps | null>(null);
  const shownSpace = useRef<string | null>(null);
  if (!sessions.current.has(spaceId)) {
    sessions.current.set(spaceId, createHistory({ ...seed, ...(lastArtwork.current ?? {}), artworkId: artworkId.current, spaceId, mode: "auto_best", pose: null, version: 1 }));
  } else if (shownSpace.current !== null && shownSpace.current !== spaceId && lastArtwork.current) {
    const h = sessions.current.get(spaceId)!;
    if (!sameArtwork(h.present.state, lastArtwork.current)) {
      // Returning to a space after editing the artwork elsewhere: bring this space up to date (one undoable step).
      sessions.current.set(spaceId, commit(h, { ...h.present.state, ...lastArtwork.current }, "Artwork matched to the other space", "history"));
    }
  }
  shownSpace.current = spaceId;
  const history = sessions.current.get(spaceId)!;
  lastArtwork.current = pickArtwork(history.present.state);
  // State immediately before the most recent action (commit, undo, redo or reset), per space, for the before/after view.
  const beforeLast = useRef(new Map<string, ArtworkEditState>());
  const set = (h: EditHistory) => {
    const prev = sessions.current.get(spaceId);
    if (prev) beforeLast.current.set(spaceId, prev.present.state);
    sessions.current.set(spaceId, h); force((n) => n + 1);
  };
  const current = () => sessions.current.get(spaceId)!;

  const apply: EditorApi["apply"] = (ops, ctx, source, coalesceKey) => {
    try {
      const r = applyOps(current().present.state, ops, ctx);
      set(commit(current(), r.state, r.changes.join(" · "), source, coalesceKey));
      setLastReevaluate(r.reevaluate);
      if (source === "manual") setAi({ kind: "local", summary: `Manual change: ${r.changes.join("; ")}` });
      return { ok: true, changes: r.changes };
    } catch (e) {
      if (e instanceof EditError) return { ok: false, error: e.message, needsInfo: e.needsInfo };
      throw e;
    }
  };

  const setDims: EditorApi["setDims"] = (patch, coalesceKey) => {
    const s = current().present.state;
    const next = { ...s, ...patch };
    if (next.widthM === s.widthM && next.depthM === s.depthM && next.heightM === s.heightM) return;
    if (![next.widthM, next.depthM, next.heightM].every((v) => Number.isFinite(v) && v > 0)) return;
    const label = Object.entries(patch).map(([k, v]) => `${k.replace("M", "")} ${s[k as "widthM"]} → ${v} m`).join(" · ");
    set(commit(current(), next, label, "manual", coalesceKey));
    setAi({ kind: "local", summary: `Manual change: ${label}` });
    setLastReevaluate(patch.heightM !== undefined && Object.keys(patch).length === 1 ? "none" : s.mode === "user_pose" ? "pose" : "search");
  };

  const historyAction = (kind: "undo" | "redo" | "reset") => {
    const h = current();
    set(kind === "undo" ? undo(h) : kind === "redo" ? redo(h) : resetToInitial(h));
    setLastReevaluate("pose");
    setAi({ kind: "local", summary: kind === "undo" ? "Undid the last change" : kind === "redo" ? "Redid the undone change" : "Reset to the session start" });
  };

  const cancelClaude = useCallback(() => {
    inflight.current?.abort.abort();
    inflight.current = null;
    setAi({ kind: "idle" });
  }, []);

  const askClaude: EditorApi["askClaude"] = async (message, ctxFor, viewLabel) => {
    if (inflight.current) return; // serialized: one request at a time
    const my = ++seq.current;
    const abort = new AbortController();
    inflight.current = { abort, seq: my };
    const base = current().present.state;
    const baseVersion = base.version;
    const baseSpace = spaceId;
    setAi({ kind: "interpreting", message });
    try {
      const res = await fetch("/api/workspace/edit", {
        method: "POST", headers: { "content-type": "application/json" }, signal: abort.signal,
        body: JSON.stringify({
          spaceId: baseSpace, artworkId: base.artworkId, baseVersion, message, viewLabel, recent: exchanges.slice(-3),
          state: { mode: base.mode, pose: base.pose, widthM: base.widthM, depthM: base.depthM, heightM: base.heightM, baseElevationM: base.baseElevationM, color: base.color, material: base.material },
        }),
      });
      const out = await res.json();
      if (inflight.current?.seq !== my) return; // cancelled or superseded
      // Re-validate context before applying: same space session, same artwork, same edit version.
      const now = sessions.current.get(baseSpace)?.present.state;
      if (activeSpace.current !== baseSpace || (out.spaceId && out.spaceId !== baseSpace) || !now
        || (out.artworkId && now.artworkId !== out.artworkId) || now.version !== baseVersion || (out.baseVersion != null && out.baseVersion !== baseVersion)) {
        setAi({ kind: "discarded", message, reason: "The artwork or space changed while the AI was working, so this answer was skipped." });
        return;
      }
      if (!res.ok) { setAi({ kind: "failed", message, reason: out.error ?? `HTTP ${res.status}` }); return; }
      if (out.kind === "unavailable" || out.kind === "error") { setAi({ kind: "failed", message, reason: out.reason }); return; }
      if (out.kind === "clarify" || out.kind === "unsupported") {
        setAi({ kind: "clarify", message, question: out.question, needsInfo: out.kind === "clarify" });
        setExchanges((x) => [...x, { request: message, result: `${out.kind}: ${out.question}` }]);
        return;
      }
      const ops = out.ops as EditOp[];
      if (ops.length === 1 && (ops[0].op === "undo" || ops[0].op === "redo" || ops[0].op === "reset")) {
        const h = current();
        const can = ops[0].op === "undo" ? h.past.length > 0 : ops[0].op === "redo" ? h.future.length > 0 : true;
        if (!can) { setAi({ kind: "failed", message, reason: `Nothing to ${ops[0].op}.` }); return; }
        historyAction(ops[0].op);
        const summary = [ops[0].op === "undo" ? "Reverted the last change" : ops[0].op === "redo" ? "Re-applied the undone change" : "Returned to the session start"];
        setAi({ kind: "applied", message, summary, ms: out.ms });
        setExchanges((x) => [...x, { request: message, result: summary[0] }]);
        return;
      }
      const r = apply(ops, ctxFor(), "claude");
      if (!r.ok) {
        setAi(r.needsInfo ? { kind: "clarify", message, question: r.error, needsInfo: true } : { kind: "failed", message, reason: r.error });
        setExchanges((x) => [...x, { request: message, result: `not applied: ${r.error}` }]);
        return;
      }
      setAi({ kind: "applied", message, summary: r.changes, ms: out.ms });
      setExchanges((x) => [...x, { request: message, result: r.changes.join("; ") }]);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      if (inflight.current?.seq === my) setAi({ kind: "failed", message, reason: (e as Error).message });
    } finally {
      if (inflight.current?.seq === my) inflight.current = null;
    }
  };

  const present = history.present;
  const previous = beforeLast.current.get(spaceId) ?? null;
  return {
    history, state: present.state, previous, lastReevaluate, ai, exchanges,
    apply, setDims, undo: () => historyAction("undo"), redo: () => historyAction("redo"), reset: () => historyAction("reset"),
    askClaude, cancelClaude,
  };
}
