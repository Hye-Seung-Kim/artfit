// Workspace edit surface: AI edit dock (Claude behind the server API) (under the viewer) + manual controls (left column).
// Both go through the same applyOps() and history, so they always edit the same artwork state.
import { useEffect, useRef, useState } from "react";
import { FINISH_COLORS, type ApplyContext, type EditOp, type FinishColor, type FinishMaterial } from "@artfit/geometry";
import type { EditorApi } from "./useArtworkEditor";

const EXAMPLES = ["Width −10%", "1 m off floor", "Matte white"];

export interface RendererState { plan: string; scan: string }

/** Short display form of an applied change, e.g. "Moved left 30 cm." The full text stays in the history label. */
function shortChange(t: string): string {
  const out = t.split(/;\s*|\s·\s/).map((part) => {
    const mv = part.match(/^Moved ([\d.]+) m to the (\w+)/);
    if (mv) { const cm = Math.round(Number(mv[1]) * 100); return `Moved ${mv[2]} ${cm >= 100 ? `${(cm / 100).toFixed(2).replace(/\.?0+$/, "")} m` : `${cm} cm`}`; }
    const el = part.match(/^Bottom above floor [\d.]+ m → ([\d.]+) m/);
    if (el) return Number(el[1]) === 0 ? "Back on the floor" : `Raised ${el[1]} m off the floor`;
    return part.replace(/\s*\((?:seen from above|as seen[^)]*)\)/g, "").replace(/\s+as seen in the [\w\s]+view/g, "");
  });
  return out.join(" · ").replace(/\.?$/, ".");
}

const isFailure = (r: string) => /unavailable|no artwork pose|error|failed/i.test(r);

export function AiEditBar({ editor, aiReady, ctxFor, viewLabel, renderers, alerts }: {
  editor: EditorApi; aiReady: boolean | null; ctxFor: () => ApplyContext; viewLabel: string; renderers: RendererState;
  /** Result facts that must not be hidden after a related edit (conflict, unverified ceiling, …). */
  alerts: { text: string; tone: "conflict" | "unknown" }[];
}) {
  const [text, setText] = useState("");
  const [help, setHelp] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const logRef = useRef<HTMLOListElement>(null);
  const busy = editor.ai.kind === "interpreting";
  const send = (msg: string) => {
    const m = msg.trim();
    if (!m || busy) return;
    setExpanded(true);
    void editor.askClaude(m, ctxFor, viewLabel);
    setText("");
  };
  const ai = editor.ai;
  const log = editor.exchanges;
  const renderIssues = [
    isFailure(renderers.plan) ? `3D planning view: ${renderers.plan}` : null,
    isFailure(renderers.scan) ? `Matterport scan: ${renderers.scan}` : null,
  ].filter(Boolean) as string[];
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [log.length, busy]);
  return (
    <section className="dock" aria-label="Edit artwork with AI">
      <div className="dock-head">
        <strong>Edit with AI</strong>
        {aiReady === false
          ? <span className="dock-conn off">AI unavailable</span>
          : <span className={"dock-dot" + (aiReady ? " on" : "")} role="img" aria-label={aiReady ? "AI connected" : "Checking AI connection"} title={aiReady ? "AI connected. The AI reads your request; ArtFit applies and checks it." : "Checking AI connection…"} />}
        <button type="button" className="dock-help" aria-expanded={help} aria-controls="dock-help-text" aria-label="How directions work" onClick={() => setHelp((h) => !h)}>i</button>
        <div className="edit-history-buttons">
          <button type="button" onClick={editor.undo} disabled={!editor.history.past.length || busy}>Undo</button>
          <button type="button" onClick={editor.redo} disabled={!editor.history.future.length || busy}>Redo</button>
          <button type="button" aria-expanded={expanded} aria-controls="single-compose" aria-label={expanded ? "Collapse AI editor" : "Expand AI editor"} onClick={() => setExpanded((v) => !v)}>{expanded ? "Hide" : "Open"}</button>
        </div>
      </div>
      {help && <p id="dock-help-text" className="dock-helptext">Left and right follow the {viewLabel}. Turning right is clockwise, seen from above. Units: cm, m or ft.</p>}
      {(ai.kind === "clarify" || ai.kind === "failed" || ai.kind === "discarded" || ai.kind === "local") && (
        <div className={"dock-status" + (ai.kind === "local" ? "" : ai.kind === "clarify" ? " ask" : " bad")} role="status">
          {ai.kind === "clarify" && <><strong>{ai.needsInfo ? "Needs your input" : "Not supported"}</strong> — {ai.question}</>}
          {ai.kind === "failed" && <><strong>Not applied</strong> — {ai.reason}</>}
          {ai.kind === "discarded" && <><strong>Not applied</strong> — {ai.reason}</>}
          {ai.kind === "local" && shortChange(ai.summary.replace(/^Manual change:\s*/, ""))}
        </div>
      )}
      {(alerts.length > 0 || renderIssues.length > 0) && (
        <ul className="dock-alerts" role="status">
          {alerts.map((a) => <li key={a.text} className={a.tone}>{a.text}</li>)}
          {renderIssues.map((a) => <li key={a} className="conflict">Not shown in {a}</li>)}
        </ul>
      )}
      {busy && <p className="dock-status" role="status">Working…</p>}
      {!busy && log.length > 0 && ai.kind !== "failed" && ai.kind !== "clarify" && ai.kind !== "discarded" && <p className="dock-feedback" role="status">{shortChange(log[log.length - 1].result)}</p>}
      <div id="single-compose" className="dock-compose" hidden={!expanded}>
      <form className="edit-bar-input" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <label htmlFor="edit-request" className="sr-only">Describe the change</label>
        <input id="edit-request" value={text} onChange={(e) => setText(e.target.value)} disabled={!aiReady}
          placeholder={aiReady === false ? "AI is not available — use the controls on the left" : "Move left 30 cm"} autoComplete="off" />
        {busy
          ? <button type="button" onClick={editor.cancelClaude}>Cancel</button>
          : <button type="submit" className="primary" disabled={!aiReady || !text.trim()}>Apply<span aria-hidden="true">↵</span></button>}
      </form>
      <details className="dock-options"><summary>Examples &amp; history</summary>
      <div className="edit-examples">
        {EXAMPLES.map((ex) => <button key={ex} type="button" className="text-button" disabled={!aiReady || busy} onClick={() => send(ex)}>{ex}</button>)}
      </div>
      {(log.length > 0 || busy) && (
        <ol className="dock-log" ref={logRef} aria-live="polite">
          {log.map((x, i) => <li key={i}><span className="req">{x.request}</span><span className="res">{/^not applied/i.test(x.result) ? "Not applied." : shortChange(x.result)}</span></li>)}
          {busy && ai.kind === "interpreting" && <li><span className="req">{ai.message}</span><span className="res"><span className="spinner" /> Working…</span></li>}
        </ol>
      )}
        <button type="button" className="text-button" onClick={editor.reset} disabled={busy}>Reset artwork</button>
      </details></div>
    </section>
  );
}

export function ManualPlacementControls({ editor, ctxFor, viewLabel }: { editor: EditorApi; ctxFor: () => ApplyContext; viewLabel: string }) {
  const [err, setErr] = useState<string | null>(null);
  const run = (ops: EditOp[], key?: string) => {
    const r = editor.apply(ops, ctxFor(), "manual", key);
    setErr(r.ok ? null : r.error);
  };
  const s = editor.state;
  const step = { value: 10, unit: "cm" as const };
  return (
    <div className="card">
      <h3>Position, height &amp; finish</h3>
      <p className="faint">Arrows move 10 cm relative to the {viewLabel}. Your position is checked where you put it; it is not replaced by the search.</p>
      <div className="nudge-grid" role="group" aria-label="Move the artwork">
        <span />
        <button type="button" aria-label="Move away from you" onClick={() => run([{ op: "move", direction: "forward", distance: step }])}>↑</button>
        <span />
        <button type="button" aria-label="Move left" onClick={() => run([{ op: "move", direction: "left", distance: step }])}>←</button>
        <button type="button" aria-label="Move toward you" onClick={() => run([{ op: "move", direction: "back", distance: step }])}>↓</button>
        <button type="button" aria-label="Move right" onClick={() => run([{ op: "move", direction: "right", distance: step }])}>→</button>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button type="button" onClick={() => run([{ op: "rotate", degrees: 15, rotation: "counterclockwise" }])}>⟲ 15°</button>
        <button type="button" onClick={() => run([{ op: "rotate", degrees: 15, rotation: "clockwise" }])}>⟳ 15°</button>
        <button type="button" disabled={s.mode === "auto_best"} onClick={() => run([{ op: "find_best_placement" }])}>Find best placement</button>
      </div>
      <label htmlFor="elev">Bottom above floor (m)</label>
      <input id="elev" type="number" min={0} step={0.1} value={s.baseElevationM}
        onChange={(e) => e.target.value !== "" && run([{ op: "set_elevation", value: { value: Number(e.target.value), unit: "m" } }], "manual:elevation")} />
      <label htmlFor="finish-color">Color</label>
      <select id="finish-color" value={s.color} onChange={(e) => run([{ op: "set_finish", color: e.target.value as FinishColor, material: null }])}>
        {Object.entries(FINISH_COLORS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
      </select>
      <label htmlFor="finish-mat">Surface</label>
      <select id="finish-mat" value={s.material} onChange={(e) => run([{ op: "set_finish", color: null, material: e.target.value as FinishMaterial }])}>
        <option value="matte">Matte</option><option value="satin">Satin</option><option value="gloss">Gloss</option>
      </select>
      {err && <div className="warn" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  );
}
