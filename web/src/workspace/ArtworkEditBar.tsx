// Workspace edit surface: Claude command bar (under the viewer) + manual controls (left column).
// Both go through the same applyOps() and history, so they always edit the same artwork state.
import { useState } from "react";
import { FINISH_COLORS, type ApplyContext, type ArtworkEditState, type EditOp, type FinishColor, type FinishMaterial } from "@artfit/geometry";
import type { EditorApi } from "./useArtworkEditor";

const EXAMPLES = ["Move left 30 cm", "Turn right 15°", "Make the width 10% smaller", "Lift it 1 m off the floor", "Matte white", "Undo that"];

const FIELDS: { key: keyof ArtworkEditState | "position" | "rotation" | "finish"; label: string; get: (s: ArtworkEditState) => string }[] = [
  { key: "position", label: "Position (x, z)", get: (s) => (s.mode === "user_pose" && s.pose ? `${s.pose.x.toFixed(2)}, ${s.pose.z.toFixed(2)} m` : "best sampled") },
  { key: "rotation", label: "Rotation", get: (s) => (s.mode === "user_pose" && s.pose ? `${s.pose.rotDeg.toFixed(0)}°` : "best sampled") },
  { key: "widthM", label: "Width", get: (s) => `${s.widthM} m` },
  { key: "depthM", label: "Depth", get: (s) => `${s.depthM} m` },
  { key: "heightM", label: "Height", get: (s) => `${s.heightM} m` },
  { key: "baseElevationM", label: "Bottom above floor", get: (s) => `${s.baseElevationM} m` },
  { key: "finish", label: "Finish", get: (s) => `${FINISH_COLORS[s.color].label}, ${s.material}` },
];

export interface RendererState { plan: string; scan: string }

export function ClaudeEditBar({ editor, claudeReady, spaceName, ctxFor, viewLabel, renderers }: {
  editor: EditorApi; claudeReady: boolean | null; spaceName: string; ctxFor: () => ApplyContext; viewLabel: string; renderers: RendererState;
}) {
  const [text, setText] = useState("");
  const busy = editor.ai.kind === "interpreting";
  const send = (msg: string) => {
    const m = msg.trim();
    if (!m || busy) return;
    void editor.askClaude(m, ctxFor, viewLabel);
    setText("");
  };
  const s = editor.state, prev = editor.previous;
  const changed = prev ? FIELDS.filter((f) => f.get(prev) !== f.get(s)) : [];
  const ai = editor.ai;
  return (
    <div className="edit-bar" aria-label="Edit the artwork">
      <div className="edit-bar-head">
        <div>
          <strong>Edit the artwork</strong>
          <span className="faint"> · {spaceName} · {s.artworkId} · edit v{s.version}</span>
        </div>
        <span className="faint">{claudeReady === null ? "Checking Claude…" : claudeReady ? "Claude interprets; ArtFit applies and checks" : "Claude not connected — manual controls still work"}</span>
      </div>
      <form className="edit-bar-input" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <label htmlFor="edit-request" className="sr-only">Describe the change</label>
        <input id="edit-request" value={text} onChange={(e) => setText(e.target.value)} disabled={!claudeReady}
          placeholder={claudeReady ? "e.g. move it left 30 cm and turn it right 15°" : "Claude is not configured on the server"} autoComplete="off" />
        {busy
          ? <button type="button" onClick={editor.cancelClaude}>Cancel</button>
          : <button type="submit" className="primary" disabled={!claudeReady || !text.trim()}>Apply</button>}
      </form>
      <div className="edit-examples">
        {EXAMPLES.map((ex) => <button key={ex} type="button" className="text-button" disabled={!claudeReady || busy} onClick={() => send(ex)}>{ex}</button>)}
      </div>
      <div className="edit-status" role="status" aria-live="polite">
        {ai.kind === "interpreting" && <><span className="spinner" /> Interpreting “{ai.message}”…</>}
        {ai.kind === "applied" && <><strong>Applied</strong> “{ai.message}”: {ai.summary.join("; ")}{ai.ms ? <span className="faint"> · Claude {Math.round(ai.ms / 100) / 10}s</span> : null}</>}
        {ai.kind === "clarify" && <><strong>{ai.needsInfo ? "Needs your input" : "Not supported"}</strong> — {ai.question}</>}
        {ai.kind === "failed" && <><strong>Not applied</strong> “{ai.message}”: {ai.reason}</>}
        {ai.kind === "discarded" && <><strong>Discarded</strong> “{ai.message}”: {ai.reason}</>}
        {ai.kind === "local" && <><strong>Done</strong> — {ai.summary}</>}
        {ai.kind === "idle" && <span className="faint">Directions are relative to the {viewLabel}. Turning right = clockwise seen from above.</span>}
      </div>
      <div className="edit-compare">
        <div className="edit-history-buttons">
          <button type="button" onClick={editor.undo} disabled={!editor.history.past.length || busy}>Undo</button>
          <button type="button" onClick={editor.redo} disabled={!editor.history.future.length || busy}>Redo</button>
          <button type="button" onClick={editor.reset} disabled={busy}>Reset to session start</button>
        </div>
        <div className="faint">Current state from: {editor.history.present.label} {editor.history.present.source === "claude" ? "(Claude request)" : editor.history.present.source === "manual" ? "(manual)" : ""}</div>
        {changed.length > 0 && (
          <table className="kv edit-diff"><tbody>
            {changed.map((f) => <tr key={f.key}><td>{f.label}</td><td>{f.get(prev!)} → <strong>{f.get(s)}</strong></td></tr>)}
          </tbody></table>
        )}
        <div className="faint">Shown in: 3D planning view — {renderers.plan}; Matterport scan — {renderers.scan}.</div>
      </div>
    </div>
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
