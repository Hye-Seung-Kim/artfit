// Internal team-only tracing tool (spec §6). Points come from Showcase SDK Pointer.intersection (x,z floor plane; y up).
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import type { MpSdk } from "@matterport/sdk";
import { useMatterport, viewOnlyUrl } from "../viewer/useMatterport";
import { circleFrom3, ensureCCW, validatePolygon, bbox, type Obstacle, type ObstacleCategory, type SpatialAnnotation, type Vec2 } from "@artfit/geometry";
import { api } from "../api";

type P3 = { x: number; y: number; z: number };
type Tool = "floor" | "poly" | "circle" | "ceiling" | "scale";
const CATS: ObstacleCategory[] = ["column", "fixed_fixture", "entrance_zone", "restricted", "movable_furniture", "uncertain_object"];
const MOB: Record<ObstacleCategory, Obstacle["mobility"]> = { column: "permanent", fixed_fixture: "permanent", entrance_zone: "permanent", restricted: "permanent", movable_furniture: "reviewed_movable", uncertain_object: "unknown" };

function PlanSvg({ a, draft }: { a: SpatialAnnotation | null; draft: Vec2[] }) {
  const all = [...(a?.floor ?? []), ...draft, ...(a?.obstacles.flatMap((o) => (o.shape.kind === "polygon" ? o.shape.poly : [o.shape.c])) ?? [])];
  if (!all.length) return <div className="faint">No geometry yet.</div>;
  const bb = bbox(all);
  const pad = 0.5, w = bb.maxX - bb.minX + 2 * pad, h = bb.maxZ - bb.minZ + 2 * pad;
  const pts = (p: Vec2[]) => p.map((v) => `${v.x},${v.z}`).join(" ");
  return (
    <svg viewBox={`${bb.minX - pad} ${bb.minZ - pad} ${w} ${h}`} style={{ width: "100%", height: 220, background: "var(--surface-2)", borderRadius: 0 }}>
      {a && <polygon points={pts(a.floor)} fill="#e1e5dc" stroke="#444" strokeWidth={0.05} />}
      {a?.obstacles.map((o) => o.shape.kind === "polygon"
        ? <polygon key={o.id} points={pts(o.shape.poly)} fill={o.category === "entrance_zone" ? "#d9a40066" : o.category === "movable_furniture" ? "#858b80" : o.category === "uncertain_object" ? "#c77d1a" : "#666"} />
        : <circle key={o.id} cx={o.shape.c.x} cy={o.shape.c.z} r={o.shape.r} fill="#666" />)}
      {draft.length > 0 && <polyline points={pts(draft)} fill="none" stroke="#d93025" strokeWidth={0.06} />}
      {draft.map((p, i) => <circle key={i} cx={p.x} cy={p.z} r={0.08} fill="#d93025" />)}
    </svg>
  );
}

export default function Annotate() {
  const { spaceId = "" } = useParams();
  const [state, setState] = useState<{ annotation: SpatialAnnotation | null; ledger: any; candidate: any } | null>(null);
  const [a, setA] = useState<SpatialAnnotation | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [hover, setHover] = useState<P3 | null>(null);
  const [tool, setTool] = useState<Tool>("floor");
  const [cat, setCat] = useState<ObstacleCategory>("movable_furniture");
  const [label, setLabel] = useState("");
  const [draft, setDraft] = useState<P3[]>([]);
  const [reviewer, setReviewer] = useState("");
  const [expectedM, setExpectedM] = useState<number | "">("");
  const [refLabel, setRefLabel] = useState("");
  const [clickCapture, setClickCapture] = useState(false);
  const sdk = useRef<MpSdk | null>(null);
  const hoverRef = useRef<P3 | null>(null);
  const focusSink = useRef<HTMLInputElement>(null);

  const load = () => api.annotateGet(spaceId).then((s) => { setState(s); setA(s.annotation); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [spaceId]);

  const modelId = state?.ledger?.match?.modelId ?? state?.annotation?.modelId ?? state?.candidate?.matterportModelIds?.[0];
  const [mpAttempt, setMpAttempt] = useState(0);
  const mp = useMatterport(modelId, mpAttempt);
  const sdkStatus = mp.status.kind === "connected" ? `connected (${mp.status.domain}, ${mp.status.phase})` : mp.status.kind === "fallback" ? `NOT connected: ${mp.status.reason}` : mp.status.kind;
  useEffect(() => {
    if (!mp.sdk) return;
    sdk.current = mp.sdk;
    const sub = mp.sdk.Pointer.intersection.subscribe((i: any) => { if (i?.position) { hoverRef.current = { ...i.position }; setHover({ ...i.position }); } });
    return () => sub.cancel();
  }, [mp.sdk]);

  const capture = () => {
    const p = hoverRef.current;
    if (!p) { setMsg("No pointer intersection yet — hover the scan first."); return; }
    setDraft((d) => [...d, p]);
  };
  // Click-capture: a click inside the iframe blurs the parent window; take the last intersection then.
  useEffect(() => {
    if (!clickCapture) return;
    const onBlur = () => { capture(); setTimeout(() => focusSink.current?.focus(), 50); };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [clickCapture]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "c" && (e.target as HTMLElement)?.tagName !== "INPUT") capture(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const importMeasurements = async () => {
    const mp = sdk.current as any;
    if (!mp?.Measurements?.getData) { setMsg("Measurements API unavailable"); return; }
    const data = await mp.Measurements.getData();
    const pts: P3[] = data.flatMap((m: any) => m.points ?? []);
    setDraft((d) => [...d, ...pts]);
    setMsg(`Imported ${pts.length} points from Matterport measurement lines.`);
  };

  const flat = draft.map((p) => ({ x: p.x, z: p.z }));
  const ySpread = draft.length ? Math.max(...draft.map((p) => p.y)) - Math.min(...draft.map((p) => p.y)) : 0;
  const update = (patch: Partial<SpatialAnnotation>) => a && setA({ ...a, ...patch, annotationVerified: false, reviewedBy: null, reviewedAt: null });
  const base = (): SpatialAnnotation => a ?? {
    annotationId: `ann-${spaceId.replace(/[^0-9A-Za-z]/g, "_")}`, spaceId, modelId, floorId: "unknown", regionId: state?.ledger?.match?.regionId ?? "manual",
    coordinateSystem: "showcase_sdk_xz_m", floorElevationY: 0, floor: [], obstacles: [], ceilingHeightM: null, ceilingEvidenceIds: [], scaleCheck: null,
    obstacleCoverage: "unknown", coverageNotes: [], annotationVerified: false, annotationMethod: "manual_sdk_pointer_trace", annotatedBy: reviewer || "team",
    reviewedBy: null, reviewedAt: null, version: 0, annotatedAt: new Date().toISOString(), scanCapturedAt: null,
  };

  const commit = () => {
    setErr(null);
    const cur = base();
    if (tool === "floor") {
      const errs = validatePolygon(flat);
      if (errs.length) return setErr("Floor polygon: " + errs.join("; "));
      if (ySpread > 0.05) setMsg(`Warning: floor point heights differ by ${ySpread.toFixed(3)} m (> 0.05 m review heuristic).`);
      setA({ ...cur, floor: ensureCCW(flat), floorElevationY: draft.reduce((s, p) => s + p.y, 0) / draft.length, annotationMethod: "manual_sdk_pointer_trace", annotationVerified: false, reviewedBy: null });
    } else if (tool === "poly") {
      const errs = validatePolygon(flat);
      if (errs.length) return setErr("Obstacle polygon: " + errs.join("; "));
      const o: Obstacle = { id: `${cat}-${Date.now().toString(36)}`, label: label || cat.replace("_", " "), category: cat, shape: { kind: "polygon", poly: ensureCCW(flat) }, mobility: MOB[cat], evidenceIds: [], removalPermissionEvidenceIds: [], removalCompletionEvidenceIds: [], reviewNote: "" };
      setA({ ...cur, obstacles: [...cur.obstacles, o], annotationVerified: false, reviewedBy: null });
    } else if (tool === "circle") {
      if (draft.length !== 3) return setErr("Circle column needs exactly 3 cross-section points.");
      const r = circleFrom3(flat[0], flat[1], flat[2]);
      if ("error" in r) return setErr("Circle fit rejected: " + r.error + ". Use a conservative polygon or uncertain zone instead.");
      const o: Obstacle = { id: `column-${Date.now().toString(36)}`, label: label || "Round column", category: "column", shape: { kind: "circle", c: r.c, r: r.r }, mobility: "permanent", evidenceIds: [], removalPermissionEvidenceIds: [], removalCompletionEvidenceIds: [], reviewNote: `3-point fit r=${r.r.toFixed(3)} m — review` };
      setA({ ...cur, obstacles: [...cur.obstacles, o], annotationVerified: false, reviewedBy: null });
    } else if (tool === "ceiling") {
      if (draft.length < 2) return setErr("Ceiling: capture one floor point and the LOWEST overhead obstruction (beam/duct/light) over the region.");
      const h = Math.max(...draft.map((p) => p.y)) - Math.min(...draft.map((p) => p.y));
      setA({ ...cur, ceilingHeightM: Math.round(h * 1000) / 1000, ceilingEvidenceIds: [`measurement-${Date.now().toString(36)}`], annotationVerified: false, reviewedBy: null });
      setMsg(`Local minimum clear height recorded: ${h.toFixed(3)} m (add a measurement evidence entry when reviewing).`);
    } else if (tool === "scale") {
      if (draft.length !== 2 || expectedM === "" || !refLabel) return setErr("Scale check: 2 points on a known exact-region reference, its documented length and a reference label.");
      const measured = Math.hypot(draft[1].x - draft[0].x, draft[1].y - draft[0].y, draft[1].z - draft[0].z);
      const tol = 0.05;
      setA({ ...cur, scaleCheck: { referenceLabel: refLabel, measuredM: measured, expectedM: Number(expectedM), evidenceIds: [], acceptedToleranceM: tol, passed: Math.abs(measured - Number(expectedM)) <= tol }, annotationVerified: false, reviewedBy: null });
    }
    setDraft([]); setLabel("");
  };

  const save = async (verify: boolean) => {
    if (!a) return;
    if (verify && !reviewer.trim()) return setErr("Reviewer name required to verify.");
    try {
      const body = verify ? { ...a, annotationVerified: true, reviewedBy: reviewer.trim(), reviewedAt: new Date().toISOString() } : a;
      const r = await api.annotatePut(spaceId, body);
      setA(r.annotation); setMsg(`Saved annotation v${r.annotation.version}${verify ? " (verified)" : ""}. Published changes invalidate earlier results.`); setErr(null);
    } catch (e) { setErr((e as Error).message); }
  };
  const reviewMatch = async (verified: boolean) => {
    if (!reviewer.trim()) return setErr("Reviewer name required.");
    try { const r = await api.matchReview(spaceId, { verified, reviewedBy: reviewer.trim(), note: verified ? "Exact suite region confirmed in scan review" : "Rejected" }); setState((s) => s && { ...s, ledger: r.ledger }); setMsg(`Match ${verified ? "confirmed" : "rejected"}.`); }
    catch (e) { setErr((e as Error).message); }
  };
  const exportJson = () => {
    if (!a) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(a, null, 2)], { type: "application/json" }));
    const el = document.createElement("a"); el.href = url; el.download = `${spaceId.replace(/[^0-9A-Za-z]/g, "_")}.json`; el.click(); URL.revokeObjectURL(url);
  };
  const preview = useMemo(() => a, [a]);

  return (
    <div className="annot">
      <div className="mp" style={{ position: "relative" }}>
        <div ref={mp.container} className="mp-host" style={{ position: "absolute", inset: 0 }} />
        {mp.status.kind === "fallback" && modelId && <iframe title="view-only scan" src={viewOnlyUrl(modelId)} style={{ position: "absolute", inset: 0 }} />}
      </div>
      <section style={{ overflow: "auto" }}>
        <input ref={focusSink} style={{ position: "absolute", opacity: 0, width: 1, height: 1 }} aria-hidden tabIndex={-1} />
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}><h2>Annotation studio</h2><Link to="/">← App</Link></div>
          <div className="faint">{state?.candidate?.displayName ?? spaceId} · model {modelId ?? "none"} · SDK {sdkStatus} <button className="ghost" style={{ padding: "1px 6px" }} onClick={() => setMpAttempt((a) => a + 1)}>Reconnect</button></div>
          {mp.status.kind === "fallback" && <div className="warn">Tracing needs the SDK. The view-only embed cannot report pointer positions.</div>}
          <div className="mono">pointer: {hover ? `x ${hover.x.toFixed(3)} y ${hover.y.toFixed(3)} z ${hover.z.toFixed(3)}` : "–"}</div>
          {err && <div className="warn">{err}</div>}{msg && <div className="note">{msg}</div>}
        </div>
        <div className="card" style={{ marginTop: 10 }}>
          <h3>1 · Exact suite-region match</h3>
          <div className="faint">{state?.ledger?.match ? `Proposed region ${state.ledger.match.regionId} — ${state.ledger.match.notes?.join("; ")}. Verified: ${state.ledger.match.verified} ${state.ledger.match.reviewedBy ? `by ${state.ledger.match.reviewedBy}` : ""}` : "No proposed match."}</div>
          <label style={{ marginTop: 6 }}>Reviewer name</label>
          <input value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="your name" />
          <div className="row" style={{ marginTop: 6 }}>
            <button disabled={!state?.ledger?.match} onClick={() => reviewMatch(true)}>Confirm match</button>
            <button disabled={!state?.ledger?.match} onClick={() => reviewMatch(false)}>Reject</button>
          </div>
          <div className="faint">Confirm only after checking the listed suite, address and region boundary in the scan. Matching a floor number or a model name alone is not sufficient.</div>
        </div>
        <div className="card" style={{ marginTop: 10 }}>
          <h3>2 · Trace</h3>
          <div className="tool-btns">
            {(["floor", "poly", "circle", "ceiling", "scale"] as Tool[]).map((t) => <button key={t} className={tool === t ? "on" : ""} onClick={() => { setTool(t); setDraft([]); }}>{t === "floor" ? "Floor boundary" : t === "poly" ? "Obstacle polygon" : t === "circle" ? "Circle column (3-pt)" : t === "ceiling" ? "Local ceiling" : "Scale check"}</button>)}
          </div>
          {tool === "poly" && (
            <div className="row" style={{ marginTop: 6 }}>
              <select value={cat} onChange={(e) => setCat(e.target.value as ObstacleCategory)}>{CATS.map((c) => <option key={c}>{c}</option>)}</select>
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label (e.g. Desk 1)" />
            </div>
          )}
          {tool === "scale" && (
            <div className="row" style={{ marginTop: 6 }}>
              <input value={refLabel} onChange={(e) => setRefLabel(e.target.value)} placeholder="reference (dimensioned plan item)" />
              <input type="number" step={0.001} value={expectedM} onChange={(e) => setExpectedM(e.target.value === "" ? "" : Number(e.target.value))} placeholder="documented m" />
            </div>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={capture}>Capture point (C)</button>
            <label style={{ display: "inline-flex", gap: 4, margin: 0 }}><input type="checkbox" checked={clickCapture} onChange={(e) => setClickCapture(e.target.checked)} /> capture on scan click</label>
            <button onClick={importMeasurements}>Import measurement lines</button>
          </div>
          <div className="faint">Draft: {draft.length} pts{ySpread ? ` · y spread ${ySpread.toFixed(3)} m` : ""}</div>
          <div className="row" style={{ marginTop: 6 }}>
            <button onClick={() => setDraft((d) => d.slice(0, -1))}>Undo point</button>
            <button onClick={() => setDraft([])}>Clear draft</button>
            <button className="primary" onClick={commit}>Close / add</button>
          </div>
          <div className="faint">“Clear draft” only discards unsaved points — it is not a physically cleared-space claim. Trace furniture as its full conservative floor projection; occluded floor becomes a restricted zone.</div>
        </div>
        <div className="card" style={{ marginTop: 10 }}>
          <h3>3 · Review</h3>
          <PlanSvg a={preview} draft={flat} />
          {a && (
            <>
              <table className="kv"><tbody>
                <tr><td>Method</td><td>{a.annotationMethod} · v{a.version}</td></tr>
                <tr><td>Local ceiling</td><td>{a.ceilingHeightM ?? "not measured"}</td></tr>
                <tr><td>Scale check</td><td>{a.scaleCheck ? `${a.scaleCheck.referenceLabel}: ${a.scaleCheck.measuredM.toFixed(3)} vs ${a.scaleCheck.expectedM} → ${a.scaleCheck.passed ? "pass" : "fail"}` : "none"}</td></tr>
                <tr><td>Coverage</td><td>
                  <select value={a.obstacleCoverage} onChange={(e) => update({ obstacleCoverage: e.target.value as SpatialAnnotation["obstacleCoverage"] })}>
                    <option value="unknown">unknown</option><option value="partial">partial</option><option value="reviewed_complete_for_region">reviewed_complete_for_region</option>
                  </select>
                </td></tr>
                <tr><td>Scan capture date</td><td><input type="date" value={a.scanCapturedAt ?? ""} onChange={(e) => update({ scanCapturedAt: e.target.value || null })} /> <span className="faint">only if a source states it</span></td></tr>
              </tbody></table>
              <div style={{ marginTop: 6 }}>
                {a.obstacles.map((o) => (
                  <div key={o.id} className="row" style={{ justifyContent: "space-between", borderBottom: "1px solid var(--line)", padding: "3px 0" }}>
                    <span className="faint">{o.label ?? o.id} · {o.category} · {o.mobility}</span>
                    <button className="ghost" onClick={() => update({ obstacles: a.obstacles.filter((x) => x.id !== o.id) })}>remove</button>
                  </div>
                ))}
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <button onClick={() => save(false)}>Save draft</button>
                <button className="primary" onClick={() => save(true)}>Verify &amp; publish</button>
                <button onClick={exportJson}>Export JSON</button>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
