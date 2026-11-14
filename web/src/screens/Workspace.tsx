import { useEffect, useMemo, useRef, useState } from "react";
import {
  AS_SCANNED, DEFAULT_SCAN, FINISH_COLORS, FOUR_ROTATIONS, checkPose, displayM, evaluate, fmtM, passes, placementScope, resolveActiveObstacles, verticalCheck,
  type ApplyContext, type ExhibitionBrief, type SpatialAnnotation, type Vec2,
} from "@artfit/geometry";
import { api, ft, monYear, nextRequestId, type EvalResult } from "../api";
import PlanningView, { defaultPlanViewRight } from "../viewer/PlanningView";
import MatterportEmbed, { type ScanOverlay } from "../viewer/MatterportEmbed";
import { computeOverlay } from "../workspace/overlay";
import { useWorkerScan } from "../workspace/useScan";
import { buildChecklist } from "../workspace/checklist";
import { useArtworkEditor } from "../workspace/useArtworkEditor";
import { AiEditBar, ManualPlacementControls } from "../workspace/ArtworkEditBar";
import { importDimensions, isStretched, loadArtworkModel, loadArtworkPhoto, proportionalDims, type ArtworkModel, type ArtworkPhoto } from "../viewer/artworkModel";

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

/**
 * Height is shown on its own because it was the interviewed artist's real failure point: she measured the space
 * herself and still misjudged the ceiling. Only a reviewed local ceiling can pass or fail; the building figure is
 * context and is drawn dashed.
 */
function HeightCheck({ topM, liftM, heightM, localCeilingM, buildingCeilingM, result, gapM }: {
  topM: number; liftM: number; heightM: number; localCeilingM: number | null; buildingCeilingM: number | null; result: "pass" | "fail" | "unknown"; gapM: number | null;
}) {
  const H = 112, maxM = Math.max(topM, localCeilingM ?? 0, buildingCeilingM ?? 0, 1) * 1.12;
  const y = (m: number) => H - (m / maxM) * H;
  return (
    <section className={`height-check ${result}`} aria-label="Height check">
      <svg viewBox={`0 0 56 ${H + 2}`} width="56" height={H + 2} aria-hidden="true">
        <line x1="0" x2="56" y1={H} y2={H} stroke="#111" strokeWidth="1.5" />
        <rect x="20" y={y(topM)} width="16" height={(heightM / maxM) * H} fill={result === "fail" ? "#b42318" : "#111"} />
        {liftM > 0 && <line x1="28" x2="28" y1={H} y2={y(liftM)} stroke="#777" strokeDasharray="2 2" />}
        {buildingCeilingM != null && <line x1="2" x2="54" y1={y(buildingCeilingM)} y2={y(buildingCeilingM)} stroke="#8a9186" strokeDasharray="3 3" />}
        {localCeilingM != null && <line x1="0" x2="56" y1={y(localCeilingM)} y2={y(localCeilingM)} stroke={result === "fail" ? "#b42318" : "#23644e"} strokeWidth="2" />}
      </svg>
      <div>
        <div className="hc-label">Height check</div>
        <div className="hc-main">{result === "pass" ? `✓ ${gapM!.toFixed(2)} m below the ceiling` : result === "fail" ? `✕ ${Math.abs(gapM!).toFixed(2)} m taller than the ceiling` : "Ceiling here not confirmed"}</div>
        <p>Top of the work: <strong>{topM.toFixed(2)} m</strong>{liftM > 0 ? ` (lifted ${liftM} m + ${heightM} m tall)` : ""}.{localCeilingM != null ? ` Measured clear height here: ${localCeilingM.toFixed(2)} m.` : ""}</p>
        {result === "unknown" && <p className="faint">{buildingCeilingM != null ? `The building lists ${buildingCeilingM.toFixed(2)} m (dashed), but beams, ducts and lights can be lower right here. ` : ""}Measure the lowest point above the spot before you commit.</p>}
      </div>
    </section>
  );
}

const VERDICT = {
  fit: { cls: "fit", icon: "✓", text: "Fits with room to walk around" },
  conflict: { cls: "conflict", icon: "✕", text: "No spot found with enough room" },
  unknown: { cls: "unknown", icon: "?", text: "Can’t tell yet" },
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
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  // User-supplied 3D model of the artwork (display only; checks keep using its outer box).
  const [model, setModel] = useState<ArtworkModel | null>(null);
  const [modelMsg, setModelMsg] = useState<{ kind: "busy" | "error" | "info"; text: string } | null>(null);
  const [modelSizing, setModelSizing] = useState<ReturnType<typeof importDimensions> | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Front photo on the box face (interview: "my work actually in the space"). A photo and a 3D model are exclusive.
  const [photo, setPhoto] = useState<ArtworkPhoto | null>(null);
  const dragDepth = useRef(0);
  // Floating UI over the 3D canvas (desktop only): frame the room in the uncovered region.
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1101px)").matches);
  const [dockH, setDockH] = useState(0);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1101px)");
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    const dock = document.querySelector<HTMLElement>(".studio .dock");
    const ro = dock ? new ResizeObserver(() => setDockH(dock.offsetHeight)) : null;
    if (dock && ro) ro.observe(dock);
    return () => { mq.removeEventListener("change", on); ro?.disconnect(); };
  }, []);
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
  // Shown in the AI dock only while they apply to the current edit.
  const editAlerts = [
    userPose && poseCheck && !posePasses ? { tone: "conflict" as const, text: `Conflict at this position${limiter ? ` — limited by ${limiter.text}` : ""}. Not a passing layout.` } : null,
    es.baseElevationM > 0 ? { tone: "unknown" as const, text: `Lifted preview: the floor check is a projection; ${vertical.result === "unknown" ? "the ceiling height here is not confirmed, and " : ""}fixing and load are not checked.` } : null,
  ].filter(Boolean) as { text: string; tone: "conflict" | "unknown" }[];
  const finish = { hex: FINISH_COLORS[es.color].hex, material: es.material };
  // With a model loaded, its own materials are shown until the user picks a finish.
  const modelOverride = es.color === "default" ? null : { hex: finish.hex, roughness: es.material === "gloss" ? 0.15 : es.material === "satin" ? 0.5 : 0.9 };
  const modelView = model ? { id: model.id, parts: model.parts, override: modelOverride } : null;
  const importPhoto = async (file: File) => {
    setModelMsg({ kind: "busy", text: `Loading ${file.name}…` });
    try {
      const ph = await loadArtworkPhoto(file);
      setPhoto(ph); setModel(null); setModelSizing(null);
      setModelMsg({ kind: "info", text: `Photo on the front face (cropped to ${es.widthM} × ${es.heightM} m, no stretching). Checks still use the box.` });
    } catch (e) { setModelMsg({ kind: "error", text: (e as Error).message }); }
  };
  const importAny = (file: File | undefined) => {
    if (!file) return;
    if (/\.glb$/i.test(file.name)) void importModel(file);
    else if (/^image\//.test(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name)) void importPhoto(file);
    else setModelMsg({ kind: "error", text: "Drop a .glb 3D model or a JPG/PNG/WebP photo of the work." });
  };
  const importModel = async (file: File | undefined) => {
    if (!file) return;
    setModelMsg({ kind: "busy", text: `Loading ${file.name}…` });
    try {
      const m = await loadArtworkModel(file);
      const sizing = importDimensions(m, es.heightM);
      setModel(m); setPhoto(null);
      setModelSizing(sizing);
      applySize(sizing.useFile ? sizing.file : sizing.scaled, m.id);
      setModelMsg(null);
    } catch (e) {
      setModelMsg({ kind: "error", text: (e as Error).message });
    }
  };
  const applySize = (d: { widthM: number; depthM: number; heightM: number }, key: string) => {
    editor.setDims(d, `model:${key}`);
    setBrief({ ...brief, artwork: d });
  };
  const removeModel = () => { setModel(null); setModelMsg(null); setModelSizing(null); };
  const fmtDims = (d: { widthM: number; depthM: number; heightM: number }) => `${d.widthM} × ${d.depthM} × ${d.heightM} m`;
  const sizeIsFile = !!modelSizing && es.widthM === modelSizing.file.widthM && es.depthM === modelSizing.file.depthM && es.heightM === modelSizing.file.heightM;
  const stretched = !!model && isStretched(model, es);
  const dropHandlers = {
    onDragEnter: (e: React.DragEvent) => { if (!e.dataTransfer.types.includes("Files")) return; e.preventDefault(); dragDepth.current++; setDragOver(true); },
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } },
    onDragLeave: () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragOver(false); },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); dragDepth.current = 0; setDragOver(false); importAny(e.dataTransfer.files[0]); },
  };
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
      ? `Your spot doesn’t work: ${[poseCheck.outsideFloor ? "it goes past the floor edge" : null, ...poseCheck.overlappingObstacleIds.map((id) => `it overlaps ${obstacleName(id)}`)].filter(Boolean).join("; ")}`
      : passes(poseCheck.clearanceM, C) ? "Your spot works" : `Your spot is tight: ${fmtM(poseCheck.clearanceM!)} m of room, you asked for ${C} m`
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
  // Unreviewed geometry never gets a fit/conflict verdict; it gets a plainly-labelled "looks like" reading.
  const unreviewed = shown?.status === "unknown";
  const lean = posKind ?? (shown?.exploratoryStatus === "fit" ? "fit" : shown?.exploratoryStatus ? "conflict" : null);
  const v = unreviewed
    ? lean ? { ...VERDICT.unknown, text: posKind ? `Looks like ${posKind === "fit" ? "your spot works" : "your spot doesn’t work"}` : lean === "fit" ? "Looks like it fits" : "Looks too tight here" } : VERDICT.unknown
    : posKind ? { ...VERDICT[posKind], text: posText! } : baseVerdict;
  const headline = v;
  const verdictSub = scope.kind === "elevated_preview"
    ? "Lifted preview · checked against the floor outline only"
    : unreviewed ? (lean ? "Review pending · based on a draft floor plan" : "No floor plan to check against yet")
    : shown?.geometryVerification === "PotentialFit" ? "Possible fit · the floor plan still needs a check" : "Checked against a reviewed floor plan";
  const cand = sd?.inspect?.candidate;
  const nameOf = (id: string) => data[id]?.inspect?.candidate.displayName ?? id;
  const editNote = `Artwork state v${es.version}: ${userPose ? `placed by you at x=${userPose.x.toFixed(2)} z=${userPose.z.toFixed(2)} rot ${userPose.rotDeg}°` : "best sampled placement"}; bottom ${es.baseElevationM} m above floor${es.baseElevationM > 0 ? " (elevated preview; suspension/fixing/load not checked)" : ""}; finish ${FINISH_COLORS[es.color].label}, ${es.material}`;
  const checklist = sd?.inspect ? buildChecklist({ inspect: sd.inspect, result: server.res, brief: { ...brief, artwork: { ...art, baseElevationM: es.baseElevationM } }, requiredC: C, selectedOption: [chosen, editNote].filter(Boolean).join(" · ") }) : "";
  // Scan overlay for the active space; the last one per space is kept for scans that stay mounted in the background.
  const scanOverlayNow: ScanOverlay | null = overlay && pose ? {
                  baseElevationM: es.baseElevationM, colorHex: finish.hex, material: es.material,
                  model: modelView, photo: photo && !model ? photo : null,
                  artwork: overlay.artwork, center: { x: pose.x, z: pose.z }, floorY: ann?.floorElevationY ?? 0, conflict: !posePasses,
                  heightM: art.heightM, floor: ann!.floor, buffer: overlay.buffer, red: overlay.red, green: overlay.green, showFigure: true,
                  limiter: limiter ? { a: limiter.artworkPoint, b: limiter.limiterPoint } : null,
                  label: `Artwork ${art.widthM}×${art.depthM}×${art.heightM} m${es.baseElevationM > 0 ? `, bottom ${es.baseElevationM} m up (preview)` : ""} · ${posePasses && lim ? `clearance ${fmtM(lim.c)} m` : "conflict"}`,
                } : null;
  const lastScanOverlay = useRef<Record<string, ScanOverlay | null>>({});
  if (scanOverlayNow) lastScanOverlay.current[active] = scanOverlayNow;
  const activeRef = useRef(active); activeRef.current = active;
  const scanRightBy = useRef<Record<string, { x: number; z: number }>>({});
  const scanRenderBy = useRef<Record<string, string>>({});
  const scanModelOf = (id: string) => data[id]?.inspect?.match?.modelId ?? data[id]?.inspect?.candidate?.matterportModelIds?.[0] ?? null;
  const [scanSpaces, setScanSpaces] = useState<string[]>([]);
  useEffect(() => { if (scanOpened && !scanSpaces.includes(active)) setScanSpaces((list) => (list.includes(active) ? list : [...list, active])); }, [scanOpened, active]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // Switching spaces: the scan readouts follow the newly active viewer.
    scanRight.current = scanRightBy.current[active] ?? null;
    setScanRender(scanRenderBy.current[active] ?? (scanOpened ? "loading" : "not opened"));
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  const [planRendered, setPlanRendered] = useState("not shown");
  useEffect(() => { setPlanRendered(view === "scan" ? "hidden in this tab (not rendered)" : ann && overlay ? `applied edit v${es.version}` : "no artwork pose to show"); }, [view, es.version, !!overlay, !!ann]);

  return (
    <main className="studio" id="main-content" data-view={view} data-left={leftOpen ? "open" : "closed"} data-right={rightOpen ? "open" : "closed"}>
      <header className="studio-bar">
        <div className="studio-title">
          <button className="text-button" onClick={onBack}>← Spaces</button>
          <div><div className="eyebrow">03 / The placement studio</div><h1>{cand?.displayName ?? "A study in space."}</h1></div>
        </div>
        {spaceIds.length > 1 && <div className="studio-spaces" role="group" aria-label="Spaces">
          {spaceIds.map((id, i) => {
            const c = data[id]?.inspect?.candidate;
            return <button key={id} type="button" aria-pressed={id === active} onClick={() => setActive(id)}
              title={c ? `${c.spaceUse} · ${c.listedAreaSqFt?.toLocaleString() ?? "?"} SF advertised · on market ${Math.floor(c.monthsOnMarket ?? 0)} mo · ${data[id]?.inspect?.conditions?.occupancy?.label ?? ""} · ${data[id]?.inspect?.matchVerified ? "match reviewed" : "match not verified"}` : undefined}>
              <span className="mono">{String.fromCharCode(65 + i)}</span>{c?.displayName ?? "Loading…"}
            </button>;
          })}
        </div>}
        <div className="tabs" role="group" aria-label="View">
          {(["plan", "split", "scan"] as const).map((k) => <button key={k} className={view === k ? "on" : ""} aria-pressed={view === k} onClick={() => setView(k)}>{k === "plan" ? "3D planning view" : k === "scan" ? "Original Matterport scan" : "Side by side"}</button>)}
          <span className="status-line">{(local.busy || server.busy) && <><span className="spinner" /> Calculating</>}</span>
        </div>
      </header>

      <div className="studio-stage" {...dropHandlers}>
        {dragOver && <div className="drop-hint" aria-hidden="true"><strong>Drop a photo or a .glb</strong><span>A front photo goes on the box face; a 3D model replaces the box.</span></div>}
        <div className="stage-views">
            {view !== "scan" && (
              <div style={{ flex: 1, position: "relative", display: "flex", flexDirection: "column", minWidth: 0 }}>
                {ann ? <PlanningView annotation={ann} overlay={overlay} artworkHeightM={art.heightM} attempt={userPose ? false : !shown?.selectedPose} conflict={!posePasses} limiter={limiter} wallHeightM={Math.min(cand?.ceilingHeightM ?? 3, 4)}
                    baseElevationM={es.baseElevationM} finish={finish} onViewRight={(r) => { planRight.current = r; }}
                    model={modelView} viewKey={active} photo={photo}
                    viewInset={wide ? { l: leftOpen ? 312 : 0, r: rightOpen && view === "plan" ? 352 : 0, t: 44, b: dockH ? dockH + 12 : 0 } : undefined} />
                  : <div className="page muted">{sd?.error ?? (sd ? "No traced geometry for this space — spatial result unknown." : "Loading…")}</div>}
              </div>
            )}
            {/* One scan viewer per opened space, kept mounted so switching A ↔ B doesn't reload it or lose its viewpoint. */}
            {scanSpaces.map((id) => {
              const mid = scanModelOf(id);
              if (!mid) return null;
              const isActive = id === active;
              return <div key={id} style={{ flex: 1, display: isActive && view !== "plan" ? "flex" : "none", minWidth: 0 }}>
                <MatterportEmbed modelId={mid} editVersion={isActive ? es.version : undefined}
                  onViewRight={(r) => { scanRightBy.current[id] = r; if (id === activeRef.current) scanRight.current = r; }}
                  onRenderState={(st) => { scanRenderBy.current[id] = st; if (id === activeRef.current) setScanRender(st); }}
                  overlay={isActive ? scanOverlayNow ?? lastScanOverlay.current[id] ?? null : lastScanOverlay.current[id] ?? null} />
              </div>;
            })}
            {view !== "plan" && !scanModelOf(active) && <div className="page muted">No Matterport model associated with this space.</div>}
        </div>
        <div className="overlay-badges">
          {model && <span className="badge">3D model: {model.title}</span>}
          {photo && !model && <span className="badge">Front photo: {photo.fileName}</span>}
                  <span className="badge info">Scenario: as scanned</span>
                  <span className="badge">3D planning view reconstructed from traced geometry</span>
                  {!userPose && shown?.displayAttemptPose && <span className="badge conflict">Illustrative tested conflict</span>}
                  {userPose && <span className="badge">Position placed by you</span>}
                  {es.baseElevationM > 0 && <span className="badge">Elevated preview · {es.baseElevationM} m</span>}
        </div>

        <aside className={"panel panel-left" + (leftOpen ? "" : " closed")} aria-label="Your work" aria-hidden={!leftOpen}>
          <div className="panel-head">
            <div><div className="eyebrow">Your work</div><h2>Artwork &amp; space</h2></div>
            <button type="button" className="panel-hide" aria-label="Hide your work panel" onClick={() => setLeftOpen(false)}>←</button>
          </div>
          <div className="panel-body">
            <div className="card">
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
            <div className="card model-card">
              <h3>How the work looks</h3>
              {model ? <>
                <p className="model-name">{model.title}</p>
                {model.credit && <p className="faint">{[model.credit.author ? `by ${model.credit.author.replace(/\s*\(https?:[^)]*\)/, "")}` : null, model.credit.license?.replace(/\s*\(https?:[^)]*\)/, "")].filter(Boolean).join(" · ")}</p>}
                <p className="faint">{model.triangles.toLocaleString()} triangles · shown with its own materials until you pick a finish. Checks use its outer box on the floor (dashed line).</p>
                {modelSizing && <p className="faint">{sizeIsFile
                  ? <>Using the size stored in the file ({fmtDims(modelSizing.file)}). <button type="button" className="text-button" onClick={() => applySize(proportionalDims(model, modelSizing.scaled.heightM), "scaled")}>Scale to {modelSizing.scaled.heightM} m tall instead</button></>
                  : <>The file says {fmtDims(modelSizing.file)}, which may not be real meters, so it keeps its proportions at your height. <button type="button" className="text-button" onClick={() => applySize(modelSizing.file, "file")}>Use the file’s size</button></>}
                  {" "}Enter the real width, depth and height above if you know them.</p>}
                {stretched && <p className="warn">The model is stretched to {fmtDims(es)}. <button type="button" className="text-button" onClick={() => applySize(proportionalDims(model, es.heightM), "fit")}>Match the model’s proportions</button></p>}
                <div className="row"><label className="file-button">Replace<input type="file" accept=".glb,model/gltf-binary" onChange={(e) => { void importModel(e.target.files?.[0]); e.target.value = ""; }} /></label><button type="button" className="text-button" onClick={removeModel}>Back to box</button></div>
              </> : <>
                {photo
                  ? <><p className="model-name">Front photo</p><img className="photo-thumb" src={photo.thumbUrl} alt="Front photo of the artwork" /><p className="faint">{photo.fileName} · on the box’s front face, cropped to fit. Checks use the box.</p></>
                  : <p className="faint">Add a front photo to see your work on the box, or a .glb 3D model. Drag either onto the view, or choose a file.</p>}
                <div className="row">
                  <label className="file-button">{photo ? "Replace photo" : "Front photo"}<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importPhoto(f); e.target.value = ""; }} /></label>
                  <label className="file-button">3D model (.glb)<input type="file" accept=".glb,model/gltf-binary" onChange={(e) => { void importModel(e.target.files?.[0]); e.target.value = ""; }} /></label>
                  {photo && <button type="button" className="text-button" onClick={() => { setPhoto(null); setModelMsg(null); }}>Remove photo</button>}
                </div>
              </>}
              {modelMsg && <p className={modelMsg.kind === "error" ? "warn" : "faint"} role={modelMsg.kind === "error" ? "alert" : "status"}>{modelMsg.kind === "busy" && <span className="spinner" />} {modelMsg.text}</p>}
            </div>
            <ManualPlacementControls editor={editor} ctxFor={ctxFor} viewLabel={viewLabel} />
            <div className="card">
              <h3>Layout scenario</h3>
              <span className="badge info">As scanned — all traced contents included</span>
              <p className="faint">Hypothetical furniture removal is not enabled in this MVP. Occupancy and furniture evidence never change with the layout.</p>
            </div>
          </div>
        </aside>

        <aside className={"panel panel-right" + (rightOpen ? "" : " closed")} aria-label="Placement result" aria-hidden={!rightOpen}>
          <div className="panel-head">
            <div>
              <div className={`verdict ${headline.cls}`}><span aria-hidden>{headline.icon}</span>{headline.text}</div>
              <div className="faint">{verdictSub}</div>
            </div>
            <button type="button" className="panel-hide" aria-label="Hide result panel" onClick={() => setRightOpen(false)}>→</button>
          </div>
          <div className="panel-body">
            <div className="card">
          {scope.kind === "elevated_preview" && <div className="warn">The work is lifted, so only its outline on the floor is checked. Heights of furniture, hanging and load aren’t checked.</div>}
          {unreviewed && lean && <div className="warn"><strong>Why not confirmed?</strong> The floor plan was traced from the 3D scan, but nobody has yet confirmed the scan shows this exact unit or checked the tracing.{userPose && posText && !posePasses ? ` ${posText}.` : ""}</div>}
          {userPose && <div className="faint">The numbers below come from the automatic search, not your spot. “Find best placement” goes back to it.</div>}
          <HeightCheck topM={vertical.topM} liftM={es.baseElevationM} heightM={es.heightM} localCeilingM={ann?.ceilingHeightM ?? null} buildingCeilingM={cand?.ceilingHeightM ?? null} result={vertical.result} gapM={vertical.gapM ?? null} />
          <table className="kv" style={{ marginTop: 8 }}>
            <tbody>
              <tr><td>Spots tried</td><td>{shown ? `${shown.sampledPositionCount.toLocaleString()} spots × ${shown.rotationsDeg.length} angles (${shown.rotationsDeg.map((r) => `${r}°`).join(", ")}), every 10 cm` : "–"}</td></tr>
              <tr><td>Spots that work</td><td>{shown ? shown.passCount.toLocaleString() : "–"}</td></tr>
              <tr><td>Most room found</td><td>{shown?.bestSampledClearanceM != null ? <>{fmtM(shown.bestSampledClearanceM)} m around the work <span className="faint">(rounded down)</span></> : "No spot with enough room."}</td></tr>
              <tr><td>Room you asked for</td><td>{C} m ({ft(C)}) on every side</td></tr>
              <tr><td>Closest edge</td><td>{limiter ? limiter.text.replace("Floor edge / wall", "Wall or floor edge").replace(/ · ([\d.]+) m$/, " · $1 m away") : shown?.displayAttemptPose ? `Blocked by ${local.result?.attemptReason ?? "an obstacle"}` : "–"}</td></tr>
              <tr><td>Getting it in</td><td>{server.res?.context.door.result && server.res.context.door.result !== "unknown" ? server.res.context.door.result : "Door size not listed"}<div className="faint">The route to the space isn’t checked.</div></td></tr>
            </tbody>
          </table>
          {shown?.status === "fit" && shown.heightCheck !== "pass" && <div className="faint">Fits on the floor; height not confirmed.</div>}
          {server.error && <div className="warn">Server: {server.error}</div>}
            </div>
            <div className="card">
          <h3>What we know about the space</h3><p className="faint">These don’t change when you move the work.</p>
          <table className="kv"><tbody>
            <tr><td>Listing</td><td>Listed for lease (Nov 2026 data)</td></tr>
            <tr><td>Physical occupancy</td><td>{sd?.inspect?.conditions.occupancy.label}</td></tr>
            <tr><td>Furniture</td><td>{sd?.inspect?.conditions.scanFurniture?.label ?? sd?.inspect?.conditions.furnishing.label}</td></tr>
            <tr><td>Cleared plan region</td><td>{sd?.inspect?.conditions.clearedRegion.label}</td></tr>
            <tr><td>Short-term use</td><td>{sd?.inspect?.conditions.shortTermUse.label}</td></tr>
            <tr><td>Idle signal</td><td>{cand ? `On market ${Math.floor(cand.monthsOnMarket ?? 0)} mo${cand.lastRecordedTenantLeftAt ? ` · last recorded tenant left ${monYear(cand.lastRecordedTenantLeftAt)}` : ""} · current vacancy not verified` : ""}</td></tr>
          </tbody></table>
        </div>

            <div className="card">
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

            <div className="card">
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
Scan: ${server.res?.scan?.scanKey ?? "–"} · rules ${local.result?.rulesVersion ?? ""}
Browser/server check: ${fingerprintsAgree ? "same scan fingerprint" : server.busy || local.busy ? "calculating" : "pending"}${local.result ? ` · ${local.result.scanDurationMs.toFixed(0)} ms in worker` : ""}`}
            </div>
          )}
        </div>
            <div className="card legend-card">
              <h3>Legend</h3>
              <div className="legend">
            <span><i style={{ background: "#171717" }} />Artwork</span><span><i style={{ background: "#6bdcc5" }} />Clearance passes (as scanned)</span>
            <span><i style={{ background: "#d93025" }} />Conflict</span><span><i style={{ background: "#d9a400" }} />Entrance zone</span>
            <span><i style={{ background: "#858b80" }} />Furniture</span><span><i style={{ background: "#c77d1a" }} />Uncertain object</span>
            <span>Scan capture date: {ann?.scanCapturedAt ?? "unknown"}{ann?.scanProcessedAt ? ` (Matterport processed ${ann.scanProcessedAt.slice(0, 10)})` : ""} · annotation v{ann?.version ?? "–"} {ann?.annotatedAt?.slice(0, 10)}</span>
              </div>
              <p className="faint">Listings come from a November 2026 snapshot. Boundaries and obstacles were traced in advance; placement search runs live on these inputs. A scan does not confirm today's vacancy.</p>
            </div>
          </div>
        </aside>

        {!leftOpen && <button type="button" className="panel-tab panel-tab-left" onClick={() => setLeftOpen(true)}>Your work →</button>}
        {!rightOpen && <button type="button" className="panel-tab panel-tab-right" onClick={() => setRightOpen(true)}>← <span className={`tab-verdict ${headline.cls}`}>{headline.icon}</span> Result</button>}

        <AiEditBar editor={editor} aiReady={claudeReady} ctxFor={ctxFor} viewLabel={viewLabel} alerts={editAlerts}
          renderers={{ plan: planRendered, scan: scanOpened ? scanRender : "not opened" }} />
      </div>
    </main>
  );
}
