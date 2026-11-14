import { useEffect, useMemo, useRef, useState } from "react";
import {
  AS_SCANNED, DEFAULT_SCAN, FINISH_COLORS, FOUR_ROTATIONS, checkPose, displayM, evaluate, fmtM, passes, placementScope, resolveActiveObstacles, verticalCheck,
  type ApplyContext, type ExhibitionBrief, type SpatialAnnotation, type Vec2,
} from "@artfit/geometry";
import { api, ft, monYear, nextRequestId, type EvalResult } from "../api";
import PlanningView, { defaultPlanViewRight } from "../viewer/PlanningView";
import MatterportEmbed from "../viewer/MatterportEmbed";
import { computeOverlay } from "../workspace/overlay";
import { useWorkerScan } from "../workspace/useScan";
import { buildChecklist } from "../workspace/checklist";
import { useArtworkEditor } from "../workspace/useArtworkEditor";
import { ClaudeEditBar, ManualPlacementControls } from "../workspace/ArtworkEditBar";

type SpaceData = { annotation: SpatialAnnotation | null; inspect: any; error?: string };

function SliderNum({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label>{label}</label>
      <div className="slider">
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
        <input type="number" min={min} step={step} value={value} onChange={(e) => e.target.value !== "" && onChange(Number(e.target.value))} aria-label={`${label} (number)`} />
      </div>
    </div>
  );
}

const VERDICT = {
  fit: { cls: "fit", icon: "✓", text: "Fits traced floor constraints" },
  conflict: { cls: "conflict", icon: "✕", text: "No passing placement found among tested samples" },
  unknown: { cls: "unknown", icon: "?", text: "Spatial result unknown" },
} as const;

export default function Workspace({ spaceIds, brief, setBrief, onBack }: { spaceIds: string[]; brief: ExhibitionBrief; setBrief: (b: ExhibitionBrief) => void; onBack: () => void }) {
  const [active, setActive] = useState(spaceIds[0]);
  const [data, setData] = useState<Record<string, SpaceData>>({});
  const [view, setView] = useState<"plan" | "scan" | "split">("plan");
  const [scanOpened, setScanOpened] = useState(false);
  useEffect(() => { if (view !== "plan") setScanOpened(true); }, [view]);
  const [fourRot, setFourRot] = useState(false);
  const [server, setServer] = useState<{ res: EvalResult | null; busy: boolean; error: string | null }>({ res: null, busy: false, error: null });
  const [plan, setPlan] = useState<{ data: any; key: string; busy: boolean; error: string | null } | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);
  const latestEval = useRef("");

  useEffect(() => {
    for (const id of spaceIds) {
      if (data[id]) continue;
      Promise.all([api.inspect(id), api.geometry(id).catch(() => null)])
        .then(([inspect, g]) => setData((d) => ({ ...d, [id]: { inspect, annotation: g?.annotation ?? null } })))
        .catch((e) => setData((d) => ({ ...d, [id]: { inspect: null, annotation: null, error: e.message } })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceIds.join("|")]);

  const sd = data[active];
  const ann = sd?.annotation ?? null;
  // ArtFit internal edit state (not a CoStar/Matterport field). Sliders, manual controls and Claude all edit it.
  const editor = useArtworkEditor(active, { widthM: brief.artwork.widthM, depthM: brief.artwork.depthM, heightM: brief.artwork.heightM, baseElevationM: 0, color: "default", material: "matte" });
  const es = editor.state;
  const art = useMemo(() => ({ widthM: es.widthM, depthM: es.depthM, heightM: es.heightM }), [es.widthM, es.depthM, es.heightM]);
  // Keep the brief (used by search/alternatives/checklist) in step with the edited dimensions.
  useEffect(() => {
    const b = brief.artwork;
    if (b.widthM !== art.widthM || b.depthM !== art.depthM || b.heightM !== art.heightM) setBrief({ ...brief, artwork: art });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [art]);
  const [claudeReady, setClaudeReady] = useState<boolean | null>(null);
  useEffect(() => { fetch("/api/agent/status").then((r) => r.json()).then((j) => setClaudeReady(!!j.configured)).catch(() => setClaudeReady(false)); }, []);
  const planRight = useRef<Vec2 | null>(null);
  const scanRight = useRef<Vec2 | null>(null);
  const [scanRender, setScanRender] = useState("not opened");
  const C = brief.preferredClearanceM;
  const settings = fourRot ? { ...DEFAULT_SCAN, rotationsDeg: FOUR_ROTATIONS } : DEFAULT_SCAN;
  const scanInput = ann ? { annotation: ann, scenario: AS_SCANNED, artwork: { widthM: art.widthM, depthM: art.depthM }, settings } : null;
  const local = useWorkerScan(scanInput);
  const localEval = useMemo(() => {
    if (!local.result || !ann || !sd?.inspect || local.result.spaceId !== active) return null;
    if (local.result.artwork.widthM !== art.widthM || local.result.artwork.depthM !== art.depthM) return null; // stale
    return evaluate(local.result, C, {
      matchVerified: !!sd.inspect.matchVerified, annotation: ann, scenario: AS_SCANNED, artworkHeightM: art.heightM,
      evidenceVersion: sd.inspect.evidenceVersion, conditionEligibility: "needs_verification", evidenceIds: [],
    });
  }, [local.result, C, art.heightM, art.widthM, art.depthM, ann, sd, active]);

  // Authoritative server evaluation; responses whose fingerprint is not current are dropped (spec §9.4).
  const evalKey = JSON.stringify([active, art, C, fourRot, ann?.version]);
  useEffect(() => {
    if (!ann) { setServer({ res: null, busy: false, error: null }); return; }
    latestEval.current = evalKey;
    setServer((s) => ({ ...s, busy: true }));
    const requestId = nextRequestId();
    const t = setTimeout(() => {
      api.evaluate({ spaceId: active, artwork: art, requiredClearanceM: C, scenario: { mode: "as_scanned" }, settings: fourRot ? { rotations: "four" } : undefined, requestId })
        .then((res) => { if (latestEval.current === evalKey) setServer({ res, busy: false, error: null }); })
        .catch((e) => { if (latestEval.current === evalKey) setServer({ res: null, busy: false, error: e.message }); });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evalKey]);

  const planKey = JSON.stringify([active, brief, spaceIds]);
  const planStale = !!plan && plan.key !== planKey;
  const e = server.res?.evaluation ?? null;
  const shown = localEval ?? e; // local preview first; server confirms
  const fingerprintsAgree = !!(local.result && server.res?.scan && local.result.scanKey === server.res.scan.scanKey);

  const obstacles = ann ? resolveActiveObstacles(ann, AS_SCANNED) : [];
  const userPose = es.mode === "user_pose" && es.pose ? es.pose : null;
  // A user-placed artwork is checked exactly where it is; the search result is never substituted for it.
  const poseCheck = useMemo(() => (ann && userPose ? checkPose(ann, AS_SCANNED, art, userPose) : null), [ann, userPose?.x, userPose?.z, userPose?.rotDeg, art]);
  const searchPose = shown?.selectedPose ?? shown?.displayAttemptPose ?? null;
  const pose = userPose ?? searchPose;
  const posePasses = userPose ? !!poseCheck?.valid && passes(poseCheck.clearanceM, C) : !!shown?.selectedPose && passes(shown.selectedPose.clearanceM, C);
  const overlay = ann && pose ? computeOverlay(ann.floor, obstacles, pose, art.widthM, art.depthM, C, posePasses) : null;
  const lim = userPose
    ? (poseCheck?.valid ? { id: poseCheck.limiterId!, a: poseCheck.artworkPoint!, b: poseCheck.limiterPoint!, c: poseCheck.clearanceM! } : null)
    : shown?.selectedPose ? { id: shown.selectedPose.limiterId, a: shown.selectedPose.artworkPoint, b: shown.selectedPose.limiterPoint, c: shown.selectedPose.clearanceM } : null;
  const limiterObs = lim ? obstacles.find((o) => o.id === lim.id) : null;
  const limiter = lim ? {
    label: lim.id, artworkPoint: lim.a, limiterPoint: lim.b,
    text: `${limiterObs ? `${limiterObs.label ?? limiterObs.id} (${limiterObs.category.replace("_", " ")})` : "Floor edge / wall"} · ${fmtM(lim.c)} m`,
  } : null;
  const vertical = verticalCheck(es, ann?.ceilingHeightM ?? null);
  const scope = placementScope(es.baseElevationM);
  const finish = { hex: FINISH_COLORS[es.color].hex, material: es.material };
  const viewLabel = view === "scan" ? "Matterport scan view" : "3D planning view";
  const ctxFor = (): ApplyContext => ({
    displayedPose: pose ? { x: pose.x, z: pose.z, rotDeg: pose.rotDeg } : null,
    // Before the planning canvas reports its camera (e.g. first frame not drawn yet), use its default camera direction.
    viewRight: view === "scan" ? scanRight.current : planRight.current ?? defaultPlanViewRight(),
    viewLabel, localCeilingM: ann?.ceilingHeightM ?? null,
  });
  const obstacleName = (id: string) => { const o = obstacles.find((x) => x.id === id); return o ? `${o.label ?? o.id} (${o.category.replace("_", " ")})` : id; };
  const posText = userPose && poseCheck
    ? !poseCheck.valid
      ? `Your position conflicts: ${[poseCheck.outsideFloor ? "outside the traced floor" : null, ...poseCheck.overlappingObstacleIds.map((id) => `overlaps ${obstacleName(id)}`)].filter(Boolean).join("; ")}`
      : passes(poseCheck.clearanceM, C) ? "Fits traced floor constraints at your position" : `Your position: clearance ${fmtM(poseCheck.clearanceM!)} m is below the required ${C} m`
    : null;

  const requestPlan = () => {
    const key = planKey;
    setPlan({ data: null, key, busy: true, error: null });
    setChosen(null);
    const expected = Object.fromEntries(spaceIds.map((id) => [id, { annotationVersion: data[id]?.annotation?.version ?? null, evidenceVersion: data[id]?.inspect?.evidenceVersion ?? 0 }]));
    api.plan({ brief, failedSpaceId: active, otherSpaceIds: spaceIds.filter((x) => x !== active), expected, requestId: nextRequestId() })
      .then((d) => setPlan((p) => (p?.key === key ? { data: d, key, busy: false, error: null } : p)))
      .catch((err) => setPlan((p) => (p?.key === key ? { data: null, key, busy: false, error: err.message } : p)));
  };
  const applyKeep = (spaceId: string) => { setChosen(`Keep requirements in ${data[spaceId]?.inspect?.candidate.displayName ?? spaceId}`); setActive(spaceId); };
  const applyAdjust = (c: number) => { setChosen(`Reduce preferred clearance to ${c} m in ${sd?.inspect?.candidate.displayName}`); setBrief({ ...brief, preferredClearanceM: c }); };

  const baseVerdict = shown ? VERDICT[shown.status] : VERDICT.unknown;
  const posKind = userPose && poseCheck ? (posePasses ? "fit" : "conflict") : null;
  const v = posKind
    ? (shown?.geometryVerification === "Unknown" ? { ...VERDICT.unknown, text: "Spatial result unknown" } : { ...VERDICT[posKind], text: posText! })
    : baseVerdict;
  const headline = scope.kind === "elevated_preview" ? { ...v, text: `Floor projection: ${v.text}` } : v;
  const cand = sd?.inspect?.candidate;
  const nameOf = (id: string) => data[id]?.inspect?.candidate.displayName ?? id;
  const editNote = `Artwork state v${es.version}: ${userPose ? `placed by you at x=${userPose.x.toFixed(2)} z=${userPose.z.toFixed(2)} rot ${userPose.rotDeg}°` : "best sampled placement"}; bottom ${es.baseElevationM} m above floor${es.baseElevationM > 0 ? " (elevated preview; suspension/fixing/load not checked)" : ""}; finish ${FINISH_COLORS[es.color].label}, ${es.material}`;
  const checklist = sd?.inspect ? buildChecklist({ inspect: sd.inspect, result: server.res, brief: { ...brief, artwork: art }, requiredC: C, selectedOption: [chosen, editNote].filter(Boolean).join(" · ") }) : "";
  const [planRendered, setPlanRendered] = useState("not shown");
  useEffect(() => { setPlanRendered(view === "scan" ? "hidden in this tab (not rendered)" : ann && overlay ? `applied edit v${es.version}` : "no artwork pose to show"); }, [view, es.version, !!overlay, !!ann]);

  return (
    <main className="workspace-shell" id="main-content">
      <div className="workspace-heading"><div><div className="eyebrow">03 / The placement studio</div><h1>{cand?.displayName ?? "A study in space."}</h1><p className="faint">One artwork. Traced geometry. As-scanned conditions.</p></div><button className="text-button" onClick={onBack}>← Back to spaces</button></div>
      <div className="ws">
      {/* LEFT */}
      <section>
        <div className="card">
          <div className="eyebrow">Your work</div><h2>Artwork &amp; space</h2>
          <SliderNum label="Width (m)" value={art.widthM} min={0.5} max={12} step={0.1} onChange={(x) => editor.setDims({ widthM: x }, "slider:width")} />
          <SliderNum label="Depth (m)" value={art.depthM} min={0.5} max={10} step={0.1} onChange={(x) => editor.setDims({ depthM: x }, "slider:depth")} />
          <SliderNum label="Height (m)" value={art.heightM} min={0.3} max={8} step={0.1} onChange={(x) => editor.setDims({ heightM: x }, "slider:height")} />
          <SliderNum label="Preferred clearance (m)" value={C} min={0} max={4} step={0.05} onChange={(x) => setBrief({ ...brief, preferredClearanceM: x, minimumClearanceM: brief.minimumClearanceM != null ? Math.min(brief.minimumClearanceM, x) : null })} />
          <div>
            <label>Minimum clearance (explicit, optional)</label>
            <input type="number" step={0.05} min={0} value={brief.minimumClearanceM ?? ""} placeholder="not set"
              onChange={(ev) => setBrief({ ...brief, minimumClearanceM: ev.target.value === "" ? null : Math.min(Number(ev.target.value), C) })} />
          </div>
          <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 10 }}><input type="checkbox" checked={fourRot} onChange={(ev) => setFourRot(ev.target.checked)} /> Test 4 orientations (0/45/90/135°)</label>
        </div>
        <ManualPlacementControls editor={editor} ctxFor={ctxFor} viewLabel={viewLabel} />
        <div className="card" style={{ marginTop: 12 }}>
          <h3>Layout scenario</h3>
          <span className="badge info">As scanned — all traced contents included</span>
          <p className="faint">Hypothetical furniture removal is not enabled in this MVP. Occupancy and furniture evidence below never change with the layout.</p>
        </div>
        <div className="card" style={{ marginTop: 12 }}>
          <h3>Spaces</h3>
          {spaceIds.map((id, i) => {
            const c = data[id]?.inspect?.candidate;
            return (
              <button key={id} type="button" className={"alt space-option" + (id === active ? " rec" : "")} aria-pressed={id === active} onClick={() => setActive(id)}>
                <div className="row" style={{ justifyContent: "space-between" }}><strong>{String.fromCharCode(65 + i)} · {c?.displayName ?? id}</strong>{id === active && <span className="badge info">active</span>}</div>
                <div className="faint">{c ? `${c.spaceUse} · ${c.listedAreaSqFt?.toLocaleString() ?? "?"} SF advertised · on market ${Math.floor(c.monthsOnMarket ?? 0)} mo` : "loading…"}</div>
                <div className="faint">{data[id]?.inspect?.conditions?.occupancy?.label ?? ""} · {data[id]?.inspect?.matchVerified ? "match reviewed" : "match not verified"}</div>
              </button>
            );
          })}
        </div>
      </section>

      {/* CENTER */}
      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div className="viewer">
          <div className="tabs">
            {(["plan", "split", "scan"] as const).map((k) => <button key={k} className={view === k ? "on" : ""} onClick={() => setView(k)}>{k === "plan" ? "3D planning view" : k === "scan" ? "Original Matterport scan" : "Side by side"}</button>)}
            <span className="status-line" style={{ marginLeft: "auto" }}>{(local.busy || server.busy) && <><span className="spinner" /> Calculating</>}</span>
          </div>
          <div style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}>
            {view !== "scan" && (
              <div style={{ flex: 1, position: "relative", display: "flex", flexDirection: "column", minWidth: 0 }}>
                <div className="overlay-badges">
                  <span className="badge info">Scenario: as scanned</span>
                  <span className="badge">3D planning view reconstructed from traced geometry</span>
                  {!userPose && shown?.displayAttemptPose && <span className="badge conflict">Illustrative tested conflict</span>}
                  {userPose && <span className="badge">Position placed by you</span>}
                  {es.baseElevationM > 0 && <span className="badge">Elevated preview · {es.baseElevationM} m</span>}
                </div>
                {ann ? <PlanningView annotation={ann} overlay={overlay} artworkHeightM={art.heightM} attempt={userPose ? false : !shown?.selectedPose} conflict={!posePasses} limiter={limiter} wallHeightM={Math.min(cand?.ceilingHeightM ?? 3, 4)}
                    baseElevationM={es.baseElevationM} finish={finish} onViewRight={(r) => { planRight.current = r; }} />
                  : <div className="page muted">{sd?.error ?? (sd ? "No traced geometry for this space — spatial result unknown." : "Loading…")}</div>}
              </div>
            )}
            {scanOpened && (sd?.inspect?.match?.modelId ?? cand?.matterportModelIds?.[0])
              ? <div style={{ flex: 1, display: view === "plan" ? "none" : "flex", minWidth: 0 }}><MatterportEmbed key={active} modelId={sd?.inspect?.match?.modelId ?? cand.matterportModelIds[0]} editVersion={es.version}
                  onViewRight={(r) => { scanRight.current = r; }} onRenderState={setScanRender} overlay={overlay && pose ? {
                  baseElevationM: es.baseElevationM, colorHex: finish.hex, material: es.material,
                  artwork: overlay.artwork, center: { x: pose.x, z: pose.z }, floorY: ann?.floorElevationY ?? 0, conflict: !posePasses,
                  heightM: art.heightM, floor: ann!.floor, buffer: overlay.buffer, red: overlay.red, green: overlay.green, showFigure: true,
                  limiter: limiter ? { a: limiter.artworkPoint, b: limiter.limiterPoint } : null,
                  label: `Artwork ${art.widthM}×${art.depthM}×${art.heightM} m${es.baseElevationM > 0 ? `, bottom ${es.baseElevationM} m up (preview)` : ""} · ${posePasses && lim ? `clearance ${fmtM(lim.c)} m` : "conflict"}`,
                } : null} /></div>
              : view !== "plan" && <div className="page muted">No Matterport model associated with this space.</div>}
          </div>
          <div className="legend">
            <span><i style={{ background: "#171717" }} />Artwork</span><span><i style={{ background: "#6bdcc5" }} />Clearance passes (as scanned)</span>
            <span><i style={{ background: "#d93025" }} />Conflict</span><span><i style={{ background: "#d9a400" }} />Entrance zone</span>
            <span><i style={{ background: "#858b80" }} />Furniture</span><span><i style={{ background: "#c77d1a" }} />Uncertain object</span>
            <span>Scan capture date: {ann?.scanCapturedAt ?? "unknown"}{ann?.scanProcessedAt ? ` (Matterport processed ${ann.scanProcessedAt.slice(0, 10)})` : ""} · annotation v{ann?.version ?? "–"} {ann?.annotatedAt?.slice(0, 10)}</span>
          </div>
        </div>
        <ClaudeEditBar editor={editor} claudeReady={claudeReady} spaceName={cand?.displayName ?? active} ctxFor={ctxFor} viewLabel={viewLabel}
          renderers={{ plan: planRendered, scan: scanOpened ? scanRender : "not opened" }} />
        <div className="note">Listings come from a November 2026 snapshot. Boundaries and obstacles were traced in advance; placement search runs live on these inputs. A scan does not confirm today's vacancy.</div>
      </section>

      {/* RIGHT */}
      <section>
        <div className="card">
          <div className={`verdict ${headline.cls}`}><span aria-hidden>{headline.icon}</span>{headline.text}</div>
          <div className="faint" style={{ margin: "6px 0" }}>Scenario: as scanned · {scope.kind === "elevated_preview" ? scope.label : shown?.geometryVerification === "Verified" ? "Verified traced floor fit scope" : shown?.geometryVerification === "PotentialFit" ? "Potential fit — needs spatial verification" : "Unit-specific result unavailable"}</div>
          {scope.note && <div className="warn">{scope.note}</div>}
          {shown?.status === "unknown" && (userPose ? posText : shown.exploratoryStatus) && (
            <div className="warn">Exploratory calculation outside the unit verdict (exact suite match not verified): {userPose ? posText : shown.exploratoryStatus === "fit" ? "a sampled layout meets the clearance" : "no sampled layout meets the clearance"}.</div>
          )}
          {userPose && <div className="faint">Rows below describe the best-placement search, which is not applied while you place the artwork yourself. Use “Find best placement” to return to it.</div>}
          <table className="kv" style={{ marginTop: 8 }}>
            <tbody>
              <tr><td>Tested</td><td>{shown ? `${shown.sampledPositionCount.toLocaleString()} positions × ${shown.rotationsDeg.length} orientations (${shown.rotationsDeg.join("/")}°), 0.10 m grid` : "–"}</td></tr>
              <tr><td>Passing layouts</td><td>{shown ? shown.passCount.toLocaleString() : "–"}</td></tr>
              <tr><td>Best clearance among tested placements</td><td>{shown?.bestSampledClearanceM != null ? <>{fmtM(shown.bestSampledClearanceM)} m <span className="faint">rounded down to 0.05 m{passes(shown.bestSampledClearanceM, C) && displayM(shown.bestSampledClearanceM) < C - 1e-9 ? ` (raw ${shown.bestSampledClearanceM.toFixed(3)} m meets ${C} m)` : ""}</span></> : "No valid placement found among tested positions."}</td></tr>
              <tr><td>Required clearance</td><td>{C} m ({ft(C)})</td></tr>
              <tr><td>Limiter</td><td>{limiter ? limiter.text : shown?.displayAttemptPose ? `Tested pose blocked by ${local.result?.attemptReason ?? "?"}` : "–"}</td></tr>
              <tr><td>Local height</td><td>Top of artwork {vertical.topM.toFixed(2)} m above floor{es.baseElevationM > 0 ? ` (bottom ${es.baseElevationM} m + height ${es.heightM} m)` : ""} · {vertical.result === "unknown" ? "no reviewed local ceiling — not verified" : vertical.result === "pass" ? `✓ ${vertical.gapM!.toFixed(2)} m below the reviewed local ceiling` : `✕ ${Math.abs(vertical.gapM!).toFixed(2)} m above the reviewed local ceiling`} <div className="faint">Property ceiling (building context, not used for this check): {cand?.ceilingHeightM != null ? `${cand.ceilingHeightM.toFixed(2)} m` : "unknown"}</div></td></tr>
              <tr><td>Property door (nominal)</td><td>{server.res?.context.door.result ?? "–"} <div className="faint">{server.res?.context.door.note}</div></td></tr>
              <tr><td>Access route</td><td>Not verified</td></tr>
              <tr><td>Browser/server check</td><td>{fingerprintsAgree ? "✓ same scan fingerprint" : server.busy || local.busy ? "calculating…" : "pending"}{local.result ? <span className="faint"> · {local.result.scanDurationMs.toFixed(0)} ms in worker</span> : null}</td></tr>
            </tbody>
          </table>
          {shown?.status === "fit" && shown.heightCheck !== "pass" && <div className="faint">Floor fit; height not verified.</div>}
          {server.error && <div className="warn">Server: {server.error}</div>}
        </div>

        <div className="card" style={{ marginTop: 12 }}>
          <h3>What we know</h3><p className="faint">Condition evidence is independent of the layout.</p>
          <table className="kv"><tbody>
            <tr><td>Listing</td><td>Marketed in snapshot</td></tr>
            <tr><td>Physical occupancy</td><td>{sd?.inspect?.conditions.occupancy.label}</td></tr>
            <tr><td>Furniture</td><td>{sd?.inspect?.conditions.scanFurniture?.label ?? sd?.inspect?.conditions.furnishing.label}</td></tr>
            <tr><td>Cleared plan region</td><td>{sd?.inspect?.conditions.clearedRegion.label}</td></tr>
            <tr><td>Short-term use</td><td>{sd?.inspect?.conditions.shortTermUse.label}</td></tr>
            <tr><td>Idle signal</td><td>{cand ? `On market ${Math.floor(cand.monthsOnMarket ?? 0)} mo${cand.lastRecordedTenantLeftAt ? ` · last recorded tenant left ${monYear(cand.lastRecordedTenantLeftAt)}` : ""} · current vacancy not verified` : ""}</td></tr>
          </tbody></table>
        </div>

        <div className="card" style={{ marginTop: 12 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3>Consider your alternatives</h3>
            <button className="primary" disabled={!e || plan?.busy || spaceIds.length < 1} onClick={requestPlan}>{plan?.busy ? "Planning…" : plan && !planStale ? "Recompute" : "Compute alternatives"}</button>
          </div>
          <p className="faint">Both options are computed before you choose. Nothing is applied automatically; only preferred clearance or the candidate space can change.</p>
          {planStale && <div className="warn">Inputs changed since these alternatives were computed — recompute before choosing.</div>}
          {plan?.error && <div className="warn">{plan.error}</div>}
          {plan?.data && (() => {
            const p = plan.data;
            const kb = p.keepRequirements.best;
            const adj = p.adjustInPlace;
            return (
              <>
                <div className={"alt" + (p.recommendation === "keep" ? " rec" : "")}>
                  <strong>Keep requirements, other space</strong>
                  <div className="faint">{kb ? `${nameOf(kb.spaceId)} · scenario ${kb.scenario.mode.replace("_", " ")}` : "No other matched candidate"}</div>
                  <div>{kb ? (kb.evaluation ? `${kb.evaluation.passCount} passing floor layouts at ${brief.preferredClearanceM} m · ${kb.reason.replace(/_/g, " ")}` : kb.reason.replace(/_/g, " ")) : ""}</div>
                  {kb?.status === "verify_next" && <div className="faint">Floor-fit candidate for verification — not installation-ready.</div>}
                  <button disabled={planStale || !kb || !(kb.status === "supported" || kb.status === "verify_next")} onClick={() => applyKeep(kb.spaceId)}>Switch to this space</button>
                </div>
                <div className={"alt" + (p.recommendation === "adjust" ? " rec" : "")}>
                  <strong>Adjust preferred clearance, same space</strong>
                  <div className="faint">Same scenario ({adj.scenario.mode.replace("_", " ")}); artwork, obstacles and evidence unchanged.</div>
                  <div>{adj.status === "needs_user_minimum" ? "Set an explicit minimum clearance to enable this option." : adj.proposedClearanceM != null ? `Proposed requirement ${adj.proposedClearanceM} m (your minimum ${adj.minimumClearanceM} m). Measured best ${fmtM(adj.measuredBestM)} m rounded down.` : `Unavailable: ${adj.reason.replace(/_/g, " ")}`}</div>
                  <button disabled={planStale || adj.proposedClearanceM == null} onClick={() => applyAdjust(adj.proposedClearanceM)}>Use {adj.proposedClearanceM ?? "–"} m here</button>
                </div>
                <div className="note">
                  <strong>Recommendation: {p.recommendation === "keep" ? "keep requirements (verify next)" : p.recommendation === "adjust" ? "adjust clearance (verify next)" : "none supported"}</strong>
                  <div>{p.narration?.text}</div>
                  <div className="faint">Narration: {p.narration?.source === "llm_selected_template" ? "LLM-selected approved template" : "deterministic template"}{p.narration?.note ? ` (${p.narration.note})` : ""}</div>
                </div>
              </>
            );
          })()}
          {chosen && <div className="badge fit" style={{ marginTop: 6 }}>Applied: {chosen}</div>}
        </div>

        <div className="card" style={{ marginTop: 12 }}>
          <div className="row">
            <button className="primary" disabled={!checklist} onClick={() => navigator.clipboard.writeText(checklist).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>{copied ? "Copied ✓" : "Copy on-site checklist"}</button>
            <button onClick={() => setShowEvidence((s) => !s)}>{showEvidence ? "Hide evidence" : "Show evidence"}</button>
          </div>
          {showEvidence && sd?.inspect && (
            <div className="mono" style={{ whiteSpace: "pre-wrap", marginTop: 10, maxHeight: 360, overflow: "auto" }}>
              {`Source refs:\n${Object.entries(sd.inspect.candidate.sourceRefs).map(([k, v]) => `  ${k}: ${v}`).join("\n")}
Snapshot: ${sd.inspect.candidate.snapshotLabel} kit · loaded ${sd.inspect.candidate.loadedAt.slice(0, 19)} (load time, not source freshness)
Matched region: ${JSON.stringify(sd.inspect.match, null, 1)}
Annotation: ${ann?.annotationId} v${ann?.version} · method ${ann?.annotationMethod} · verified ${ann?.annotationVerified} · reviewer ${ann?.reviewedBy ?? "none"}
Coverage: ${ann?.obstacleCoverage} — ${ann?.coverageNotes.join(" | ")}
Scale check: ${ann?.scaleCheck ? JSON.stringify(ann.scaleCheck) : "none (no known exact-region reference yet)"}
Evidence v${sd.inspect.evidenceVersion}:\n${sd.inspect.evidence.map((x: any) => `  [${x.id}] ${x.claim}=${x.value} · ${x.sourceType} · ${x.sourceRef} · reviewed by ${x.reviewedBy ?? "nobody"}\n     ${x.note}`).join("\n")}
Missing / unresolved:\n${sd.inspect.missing.map((m: string) => "  - " + m).join("\n")}
Scan: ${server.res?.scan?.scanKey ?? "–"} · rules ${local.result?.rulesVersion ?? ""}`}
            </div>
          )}
        </div>
      </section>
      </div>
    </main>
  );
}
