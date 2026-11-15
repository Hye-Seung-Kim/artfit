import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
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
import { GroupAiBar, GroupReviewPanel, GroupWorksPanel, groupScene, type WorkLook, useAutoPlace, useGroupEvaluation, useGroupPlanner, worksFor } from "../workspace/GroupStudio";
import { directionVector, roundedRect, workBody, type EditOp } from "@artfit/geometry";
import { withWorks } from "./Brief";
import { OccupancyCard, occupancyChecklistLine, useOccupancy } from "../workspace/Occupancy";
import { ScanMovePad } from "../workspace/ScanMovePad";
import { SpaceInfo } from "../components/SpaceInfo";
import { createPortal } from "react-dom";
import { PlanReport, type ReportInput } from "../workspace/PlanReport";
import { scanShots } from "../viewer/MatterportEmbed";
import { colorOfArtist } from "../workspace/GroupStudio";
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

export default function Workspace({ spaceIds, brief, setBrief, onBack, initialLayouts }: { spaceIds: string[]; brief: ExhibitionBrief; setBrief: Dispatch<SetStateAction<ExhibitionBrief>>; onBack: () => void; initialLayouts?: Record<string, Record<string, import("@artfit/geometry").Pose | null>> | null }) {
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
  const [infoOpen, setInfoOpen] = useState(false);
  const [report, setReport] = useState<ReportInput | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  // "Share plan" lives in the site header (top right) while the Workspace is open.
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setHeaderSlot(document.getElementById("header-actions")); }, []);
  // A brief with several works opens straight into the group show.
  const [mode, setMode] = useState<"single" | "group">(() => ((brief.works?.length ?? 0) > 1 ? "group" : "single"));
  const isGroup = mode === "group";
  // User-supplied 3D model of the artwork (display only; checks keep using its outer box).
  const [model, setModel] = useState<ArtworkModel | null>(null);
  const [modelMsg, setModelMsg] = useState<{ kind: "busy" | "error" | "info"; text: string } | null>(null);
  const [modelSizing, setModelSizing] = useState<ReturnType<typeof importDimensions> | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Front photo on the box face (interview: "my work actually in the space"). A photo and a 3D model are exclusive.
  const [photo, setPhoto] = useState<ArtworkPhoto | null>(null);
  const dragDepth = useRef(0);
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1101px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1101px)");
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
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
  // Tour-only: a listing with a linked 3D tour but no traced floor plan. Show the tour; never a placement result.
  const tourOnly = !!sd?.inspect && !ann && (sd.inspect.candidate?.matterportModelIds?.length ?? 0) > 0;
  const shownTourFor = useRef<string | null>(null);
  useEffect(() => { if (tourOnly && shownTourFor.current !== active) { shownTourFor.current = active; setView("scan"); } }, [tourOnly, active]);
  // Group show mode: several artists' works in this space (separate document with its own undo/redo).
  const [groupSelRaw, setGroupSelRaw] = useState<string | null>(null);
  // Explicit picks (list, pad, plan click) also bump a focus key so the scan camera flies to the work, even if the
  // same work is picked again.
  const [groupFocus, setGroupFocus] = useState<string | null>(null);
  const groupSel = groupSelRaw;
  const setGroupSel = (id: string | null) => { setGroupSelRaw(id); if (id) setGroupFocus(`${id}|${Date.now()}`); };
  const group = useGroupPlanner({ spaceIds, active, seed: { widthM: brief.artwork.widthM, depthM: brief.artwork.depthM, heightM: brief.artwork.heightM, clearanceM: brief.preferredClearanceM }, budget: brief.budget, currency: brief.budgetCurrency ?? "USD", initialLayouts, works: brief.works });
  // Works edited here flow back into the brief (Discover then asks for a new search; Brief shows the same list).
  useEffect(() => {
    if ((brief.works?.length ?? 0) < 2 && group.doc.works.length < 2) return; // solo: the single-work editor owns the size
    const ws = group.doc.works.map((w) => ({ id: w.id, title: w.title, artist: w.artist, widthM: w.widthM, depthM: w.depthM, heightM: w.heightM, clearanceM: w.clearanceM, required: w.required }));
    setBrief((b) => (JSON.stringify(b.works ?? []) === JSON.stringify(ws) ? b : withWorks(b, ws)));
  }, [group.doc.works]); // eslint-disable-line react-hooks/exhaustive-deps
  const gev = useGroupEvaluation(isGroup ? ann : null, group);
  const autoNote = useAutoPlace(group, ann, active, isGroup);
  // Per-work look in the group show (photo or .glb); display only, kept outside the undo history.
  const [groupLooks, setGroupLooks] = useState<Record<string, WorkLook>>({});
  const [groupLookMsg, setGroupLookMsg] = useState<string | null>(null);
  const [walkRun, setWalkRun] = useState(0);
  const gscene = groupScene(group, gev, groupSel, groupLooks);
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
  const importGroupLook = async (file: File | undefined, workId?: string | null) => {
    if (!file) return;
    const target = workId ?? groupSel ?? group.works[0]?.id;
    const w = group.works.find((x) => x.id === target);
    if (!w) return;
    setGroupSel(w.id);
    setGroupLookMsg(`Loading ${file.name}…`);
    try {
      if (/\.glb$/i.test(file.name)) {
        const m = await loadArtworkModel(file);
        setGroupLooks((l) => ({ ...l, [w.id]: { model: m } }));
        setGroupLookMsg(`${m.title} is now ${w.title}, stretched to its real size ${w.widthM} × ${w.depthM} × ${w.heightM} m.`);
      } else if (/^image\//.test(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name)) {
        const ph = await loadArtworkPhoto(file);
        setGroupLooks((l) => ({ ...l, [w.id]: { photo: ph } }));
        setGroupLookMsg(`Photo on the front of ${w.title}.`);
      } else setGroupLookMsg("Use a .glb 3D model or a JPG/PNG/WebP photo.");
    } catch (e) { setGroupLookMsg((e as Error).message); }
  };
  const dropTarget = group.works.find((w) => w.id === groupSel) ?? group.works[0];
  const dropHandlers = {
    onDragEnter: (e: React.DragEvent) => { if (!e.dataTransfer.types.includes("Files")) return; e.preventDefault(); dragDepth.current++; setDragOver(true); },
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } },
    onDragLeave: () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragOver(false); },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); dragDepth.current = 0; setDragOver(false); if (isGroup) void importGroupLook(e.dataTransfer.files[0]); else importAny(e.dataTransfer.files[0]); },
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
  const singleOcc = useOccupancy(isGroup ? null : ann, pose ? [{ id: "single", title: "Your work", widthM: art.widthM, depthM: art.depthM, clearanceM: C, pose }] : []);
  const checklist = sd?.inspect ? buildChecklist({ inspect: sd.inspect, result: server.res, brief: { ...brief, artwork: { ...art, baseElevationM: es.baseElevationM } }, requiredC: C, selectedOption: [chosen, editNote].filter(Boolean).join(" · "), peopleLine: occupancyChecklistLine(singleOcc) }) : "";
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
  // Group show in the scan: every placed work in that space (route only for the active space, where it is computed).
  const groupScanOverlay = (id: string): ScanOverlay | null => {
    const a = data[id]?.annotation;
    if (!a) return null;
    const ws = worksFor(group.doc, id).filter((w) => w.pose);
    if (!ws.length) return null;
    const target = ws.find((w) => w.id === groupSel) ?? ws[0];
    const corners = workBody(target, target.pose!);
    const issues = id === active ? new Set(gscene.works.filter((w) => w.issue).map((w) => w.id)) : new Set<string>();
    return {
      // buffer = the target's viewing room, so "Inside" stands outside it instead of against the work
      artwork: corners, heightM: target.heightM, floorY: a.floorElevationY ?? 0, buffer: roundedRect(target.pose!.x, target.pose!.z, target.widthM, target.depthM, target.pose!.rotDeg, target.clearanceM),
      red: [], green: [], conflict: false, limiter: null, showFigure: true,
      floor: a.floor, center: { x: target.pose!.x, z: target.pose!.z }, label: `Group show · ${ws.length} works`,
      group: {
        works: ws.map((w) => {
          const sc = id === active ? gscene.works.find((x) => x.id === w.id) : undefined;
          const look = groupLooks[w.id];
          return { corners: workBody(w, w.pose!), heightM: w.heightM, colorHex: sc?.color ?? "#171717", issue: issues.has(w.id), label: sc?.label ?? w.title, viewPoint: sc?.viewPoint ?? null, selected: w.id === groupSel,
            model: look?.model ? { id: look.model.id, parts: look.model.parts } : null, photo: look?.photo ?? null };
        }),
        route: id === active ? gscene.route : [], entrance: id === active ? gscene.entrance : null,
      },
      tour: id === active && gev ? gev.route.order.map((wid) => { const w = ws.find((x) => x.id === wid); return w ? { label: w.title, center: { x: w.pose!.x, z: w.pose!.z }, heightM: w.heightM, sizeM: Math.max(w.widthM, w.depthM), corners: workBody(w, w.pose!), room: roundedRect(w.pose!.x, w.pose!.z, w.widthM, w.depthM, w.pose!.rotDeg, w.clearanceM) } : null; }).filter(Boolean) as NonNullable<ScanOverlay["tour"]> : [],
    };
  };
  // Moving works from the scan (no dragging there): move pad + click-to-place. Same ops / undo steps as elsewhere.
  const [placing, setPlacing] = useState(false);
  const [padNote, setPadNote] = useState<string | null>(null);
  const moveSingleBy = (dx: number, dz: number, from: "plan" | "scan") => {
    const ctx = { ...ctxFor(), viewRight: from === "scan" ? scanRight.current : ctxFor().viewRight };
    const r = ctx.viewRight;
    if (!r) { setPadNote("The scan view direction isn't known yet."); return; }
    const f = directionVector("forward", r);
    const a = dx * r.x + dz * r.z, b = dx * f.x + dz * f.z;
    const ops: EditOp[] = [];
    if (Math.abs(a) >= 0.01) ops.push({ op: "move", direction: a > 0 ? "right" : "left", distance: { value: Math.round(Math.abs(a) * 100), unit: "cm" } });
    if (Math.abs(b) >= 0.01) ops.push({ op: "move", direction: b > 0 ? "forward" : "back", distance: { value: Math.round(Math.abs(b) * 100), unit: "cm" } });
    if (ops.length) editor.apply(ops, ctx, "manual");
  };
  const padWorks = isGroup
    ? group.works.map((w) => ({ id: w.id, title: w.title, locked: w.locked, placed: !!w.pose }))
    : [{ id: "single", title: model?.title ?? "Your work", locked: false, placed: !!pose }];
  const padSel = isGroup ? (groupSel ?? group.works.find((w) => w.pose)?.id ?? null) : "single";
  // Directions follow whichever view the pad sits on: the scan (Scan / Compare views) or the 3D plan camera.
  const padRight = () => (view === "plan" ? planRight.current ?? defaultPlanViewRight() : scanRight.current);
  const padMove = (dir: "forward" | "right" | "back" | "left", m: number) => {
    const r = padRight();
    if (!r) { setPadNote("Look around the scan once so the view direction is known."); return; }
    setPadNote(null);
    const v = directionVector(dir, r);
    if (isGroup) {
      const w = group.works.find((x) => x.id === padSel);
      if (!w?.pose || w.locked) return;
      group.setPoses({ [w.id]: { ...w.pose, x: w.pose.x + v.x * m, z: w.pose.z + v.z * m } }, `Moved ${w.title} ${Math.round(m * 100)} cm ${dir}`);
    } else moveSingleBy(v.x * m, v.z * m, view === "plan" ? "plan" : "scan");
  };
  const padRotate = (deg: number) => {
    if (isGroup) {
      const w = group.works.find((x) => x.id === padSel);
      if (!w?.pose || w.locked) return;
      group.setPoses({ [w.id]: { ...w.pose, rotDeg: ((w.pose.rotDeg + deg) % 360 + 360) % 360 } }, `Turned ${w.title} ${Math.abs(deg)}°`);
    } else editor.apply([{ op: "rotate", degrees: Math.abs(deg), rotation: deg > 0 ? "clockwise" : "counterclockwise" }], ctxFor(), "manual");
  };
  const placeAt = (p: { x: number; z: number }) => {
    if (isGroup) {
      const w = group.works.find((x) => x.id === padSel);
      if (!w?.pose || w.locked) return;
      group.setPoses({ [w.id]: { ...w.pose, x: p.x, z: p.z } }, `Placed ${w.title} by clicking the scan`);
    } else if (pose) moveSingleBy(p.x - pose.x, p.z - pose.z, "scan");
    setPlacing(false);
  };
  useEffect(() => { setPlacing(false); }, [view, active, mode]);
  useEffect(() => {
    if (!placing) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setPlacing(false); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [placing]);
  const isBlank = (src: string) => new Promise<boolean>((res) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas"); c.width = 32; c.height = 18;
      const x = c.getContext("2d")!; x.drawImage(img, 0, 0, 32, 18);
      // Blank = nearly one flat colour (the scan renderer can return its empty background).
      const d = x.getImageData(0, 0, 32, 18).data, n = d.length / 4; let sum = 0, sq = 0;
      for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += l; sq += l * l; }
      const mean = sum / n; res(Math.sqrt(Math.max(0, sq / n - mean * mean)) < 6);
    };
    img.onerror = () => res(true);
    img.src = src;
  });
  // Shareable plan report: current works + poses in this space, and pictures of the 3D plan and the scan.
  const openReport = async () => {
    if (!ann || !cand) return;
    setReportBusy(true);
    try {
      const works = isGroup ? group.works : pose ? [{ id: "single", title: model?.title ?? brief.works?.[0]?.title ?? "Your work", artist: brief.works?.[0]?.artist || "You", widthM: art.widthM, depthM: art.depthM, heightM: art.heightM, clearanceM: C, required: true, locked: false, pose: { x: pose.x, z: pose.z, rotDeg: pose.rotDeg } }] : [];
      let plan3d: string | null = null, scan: string | null = null;
      // 1) Scan picture from the scan view, if it is showing. The scan renderer sometimes returns an empty frame;
      //    retry briefly, then leave the picture out.
      const mid = scanModelOf(active);
      const shot = mid && view !== "plan" ? scanShots.get(mid) : undefined;
      for (let i = 0; shot && i < 7 && !scan; i++) {
        try { const s0 = await shot(); scan = (await isBlank(s0)) ? null : s0; } catch { scan = null; }
        if (!scan) await new Promise((r) => setTimeout(r, 600));
      }
      // 2) 3D picture from the full-width 3D plan (switch to it briefly so the whole room is framed), then switch back.
      const before = view;
      if (before !== "plan") { setView("plan"); await new Promise((r) => setTimeout(r, 900)); }
      try {
        const canvas = document.querySelector<HTMLCanvasElement>(".stage-views canvas");
        if (canvas && canvas.offsetParent) {
          const cw = canvas.width, ch = canvas.height, target = 16 / 9;
          const sw = cw / ch > target ? ch * target : cw, sh = cw / ch > target ? ch : cw / target;
          const out = document.createElement("canvas"); out.width = 1600; out.height = 900;
          out.getContext("2d")!.drawImage(canvas, (cw - sw) / 2, (ch - sh) / 2, sw, sh, 0, 0, 1600, 900);
          plan3d = out.toDataURL("image/jpeg", 0.88);
        }
      } catch { plan3d = null; }
      if (before !== "plan") setView(before);
      setReport({
        ann, works, order: isGroup && group.doc.orderSet ? group.doc.order : undefined,
        colorOf: (w) => (isGroup ? colorOfArtist(group.doc, w.artist) : "#171717"),
        space: { name: cand.displayName, address: cand.address, use: cand.spaceUse, listedSqFt: cand.listedAreaSqFt, listedCeilingM: cand.ceilingHeightM, contacts: cand.contacts ?? [] },
        brief, shots: { plan3d, scan },
      });
    } finally { setReportBusy(false); }
  };
  const [planRendered, setPlanRendered] = useState("not shown");
  useEffect(() => { setPlanRendered(view === "scan" ? "hidden in this tab (not rendered)" : ann && overlay ? `applied edit v${es.version}` : "no artwork pose to show"); }, [view, es.version, !!overlay, !!ann]);

  return (
    <main className="studio" id="main-content" data-view={view} data-left={leftOpen ? "open" : "closed"} data-right={rightOpen ? "open" : "closed"}>
      {headerSlot && createPortal(<button type="button" className="primary share-btn" disabled={!ann || reportBusy} onClick={() => void openReport()}>{reportBusy ? "Preparing…" : "Share plan"}<span aria-hidden="true">↗</span></button>, headerSlot)}
      {report && <PlanReport input={report} onClose={() => setReport(null)} />}
      <header className="studio-bar">
        <div className="studio-title">
          <button className="text-button" onClick={onBack}>← Spaces</button>
          <div><h1>{cand ? <button type="button" className="name-link" onClick={() => setInfoOpen(true)} aria-haspopup="dialog" title="Contacts and listing facts">{cand.displayName}</button> : "A study in space."}</h1></div>
          {infoOpen && cand && <SpaceInfo onClose={() => setInfoOpen(false)} data={{ name: cand.displayName, address: cand.address, use: cand.spaceUse, listedSqFt: cand.listedAreaSqFt, availability: cand.availableOnDate ? String(cand.availableOnDate).slice(0, 10) : cand.availabilityType ?? null, rate: cand.rate?.low != null ? `${cand.rate.low}${cand.rate.high && cand.rate.high !== cand.rate.low ? `–${cand.rate.high}` : ""} USD / ${cand.rate.perUnit} / ${cand.rate.basis === "Yearly" ? "yr" : "mo"}` : null, ceilingM: cand.ceilingHeightM, monthsOnMarket: cand.monthsOnMarket, brokerageCompany: cand.brokerageCompany, contacts: cand.contacts ?? [] }} />}
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
        <div className="studio-mode" role="group" aria-label="Planning mode">
          <button type="button" aria-pressed={!isGroup} onClick={() => setMode("single")}>Single work</button>
          <button type="button" aria-pressed={isGroup} onClick={() => setMode("group")}>Group show</button>
        </div>
        <div className="tabs" role="group" aria-label="View">
          {(["plan", "split", "scan"] as const).map((k) => <button key={k} className={view === k ? "on" : ""} aria-pressed={view === k} onClick={() => setView(k)}>{k === "plan" ? "3D plan" : k === "scan" ? "Scan" : "Compare views"}</button>)}
          <span className="status-line">{(local.busy || server.busy) && <><span className="spinner" /> Calculating</>}</span>
        </div>
        <div className="panel-switches" role="group" aria-label="Workspace panels">
          <button type="button" aria-expanded={leftOpen} aria-controls="artworks-panel" onClick={() => setLeftOpen((v) => !v)}>Artworks</button>
          <button type="button" aria-expanded={rightOpen} aria-controls="layout-panel" onClick={() => setRightOpen((v) => !v)}>Layout</button>
        </div>
      </header>

      <div className="studio-stage" {...dropHandlers}>
        {dragOver && <div className="drop-hint" aria-hidden="true"><strong>Drop a photo or a .glb</strong><span>{isGroup ? `It goes on ${dropTarget?.title ?? "the selected work"}${groupSel ? "" : " (select a work to choose another)"}.` : "A front photo goes on the box face; a 3D model replaces the box."}</span></div>}
        <div className="stage-views">
            {view !== "scan" && (
              <div style={{ flex: 1, position: "relative", display: "flex", flexDirection: "column", minWidth: 0 }}>
                {ann ? <PlanningView annotation={ann} overlay={isGroup ? null : overlay} artworkHeightM={art.heightM} attempt={userPose ? false : !shown?.selectedPose} conflict={!posePasses} limiter={isGroup ? null : limiter} wallHeightM={Math.min(cand?.ceilingHeightM ?? 3, 4)}
                    baseElevationM={es.baseElevationM} finish={finish} onViewRight={(r) => { planRight.current = r; }}
                    model={isGroup ? null : modelView} viewKey={active} photo={isGroup ? null : photo}
                    group={isGroup ? { ...gscene, onSelect: setGroupSel, walkRun, onMove: (id, dx, dz) => {
                      const w = group.works.find((x) => x.id === id);
                      if (!w?.pose || w.locked) return;
                      setGroupSelRaw(id); // a drag selects without flying the scan camera
                      group.setPoses({ [id]: { ...w.pose, x: w.pose.x + dx, z: w.pose.z + dz } }, `Dragged ${w.title} ${Math.round(Math.hypot(dx, dz) * 100)} cm`);
                    } } : null}
                    onMoveArtwork={isGroup ? undefined : (dx, dz) => moveSingleBy(dx, dz, "plan")}
                    viewInset={wide ? { l: 0, r: 0, t: 12, b: 12 } : undefined} />
                  : <div className="page muted">{sd?.error ?? (sd ? "No traced geometry for this space — spatial result unknown." : "Loading…")}</div>}
              </div>
            )}
            {/* One scan viewer per opened space, kept mounted so switching A ↔ B doesn't reload it or lose its viewpoint. */}
            {scanSpaces.map((id) => {
              const mid = scanModelOf(id);
              if (!mid) return null;
              const isActive = id === active;
              return <div key={id} style={{ flex: 1, display: isActive && view !== "plan" ? "flex" : "none", minWidth: 0 }}>
                <MatterportEmbed modelId={mid} editVersion={isActive ? es.version : undefined} focusKey={isActive && isGroup ? groupFocus : null} walkRun={isActive && isGroup ? walkRun : 0}
                  onViewRight={(r) => { scanRightBy.current[id] = r; if (id === activeRef.current) scanRight.current = r; }}
                  onRenderState={(st) => { scanRenderBy.current[id] = st; if (id === activeRef.current) setScanRender(st); }}
                  onFloorClick={isActive && placing ? placeAt : null}
                  overlay={isGroup ? groupScanOverlay(id) : isActive ? scanOverlayNow ?? lastScanOverlay.current[id] ?? null : lastScanOverlay.current[id] ?? null} />
              </div>;
            })}
            {view !== "plan" && !scanModelOf(active) && <div className="page muted">No Matterport model associated with this space.</div>}
            {/* Inside the view column so it never overlaps the side panels. */}
            {!tourOnly && ann && <ScanMovePad canPlace={view !== "plan"} works={padWorks} selected={padSel} onSelect={(id) => isGroup && setGroupSel(id)}
              onMove={padMove} onRotate={padRotate} placing={placing} onPlacing={setPlacing} note={padNote}
              onLock={isGroup ? () => { const w = group.works.find((x) => x.id === padSel); if (w) group.setLocked([w.id], !w.locked); } : undefined} />}
        </div>
        {tourOnly && <div className="tour-banner" role="status"><strong>3D tour only.</strong> This listing has no traced floor plan yet, so ArtFit can’t check a placement here. The tour is linked to the building and may not show the listed unit.</div>}
        {!isGroup && !tourOnly && es.baseElevationM > 0 && <div className="overlay-badges"><span className="badge">Elevated preview · {es.baseElevationM} m</span></div>}

        <aside id="artworks-panel" className={"panel panel-left" + (leftOpen ? "" : " closed")} aria-label="Artworks" hidden={!leftOpen}>
          <div className="panel-head">
            <h2>Artworks</h2>
            <button type="button" className="panel-hide" aria-label="Hide your work panel" onClick={() => setLeftOpen(false)}>←</button>
          </div>
          <div className="panel-body">
            {isGroup ? <GroupWorksPanel g={group} selected={groupSel} onSelect={setGroupSel} looks={groupLooks} lookMsg={groupLookMsg}
              onLookFile={(id, f) => void importGroupLook(f, id)} onLookRemove={(id) => { setGroupLooks((l) => { const n = { ...l }; delete n[id]; return n; }); setGroupLookMsg(null); }} viewLabel={viewLabel} viewRight={() => (view === "scan" ? scanRight.current : planRight.current ?? defaultPlanViewRight())} /> : <>
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
          </>}
          </div>
        </aside>

        <aside id="layout-panel" className={"panel panel-right" + (rightOpen ? "" : " closed")} aria-label="Layout" hidden={!rightOpen}>
          {isGroup ? <GroupReviewPanel g={group} ev={gev} ann={ann} autoNote={autoNote} spaceUse={cand?.spaceUse} onWalk={() => setWalkRun((n) => n + 1)} onSelect={setGroupSel} onHide={() => setRightOpen(false)} otherSpaces={spaceIds.filter((x) => x !== active).map((x) => ({ id: x, name: data[x]?.inspect?.candidate.displayName ?? x, ann: data[x]?.annotation ?? null }))} /> : <>
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
            <OccupancyCard est={singleOcc} spaceUse={cand?.spaceUse} />
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
          </>}
        </aside>


        {isGroup
          ? <GroupAiBar g={group} spaceId={active} ann={ann} aiReady={claudeReady} onSelect={setGroupSel} viewRight={() => (view === "scan" ? scanRight.current : planRight.current ?? defaultPlanViewRight())} />
          : <AiEditBar editor={editor} aiReady={claudeReady} ctxFor={ctxFor} viewLabel={viewLabel} alerts={editAlerts}
          renderers={{ plan: planRendered, scan: scanOpened ? scanRender : "not opened" }} />}
      </div>
    </main>
  );
}
