// Original Matterport scan with the planned artwork placed INSIDE it (spec §10.2 Plan A: Bundle SDK Scene API).
// <matterport-viewer> (official web component, self-hosted bundle in /public/bundle) gives us Scene.createObjects;
// the artwork, its clearance buffer and conflict regions are real scene objects in Showcase coordinates.
// The scan's captured contents are never edited.
import { useEffect, useRef, useState } from "react";
import "@matterport/webcomponent";
import { pointInPolygon, type Vec2 } from "@artfit/geometry";
import { ARTWORK_COMPONENT, artworkComponentFactory, type ArtworkSceneSpec } from "./artworkScene";

const SDK_KEY = import.meta.env.VITE_MATTERPORT_SDK_KEY as string | undefined;
const PLAY_TIMEOUT_MS = 45_000;

/** Screenshot of each live scan (by model id), used by the plan report. */
export const scanShots = new Map<string, () => Promise<string>>();

export type ScanOverlay = ArtworkSceneSpec & { center: Vec2; label: string; floor: Vec2[];
  /** Group show walk-through: works in viewing order. */
  tour?: { label: string; center: Vec2; heightM: number; sizeM: number; corners: Vec2[]; room: Vec2[] }[] };

type Status = { kind: "loading"; step: string } | { kind: "playing" } | { kind: "error"; reason: string };

export default function MatterportEmbed({ modelId, overlay, editVersion, onViewRight, onRenderState, walkRun, onFloorClick, focusKey }: {
  modelId: string; overlay?: ScanOverlay | null;
  /** ArtFit edit version the overlay represents; reported back once it is actually in the scene. */
  editVersion?: number;
  onViewRight?: (v: Vec2) => void;
  onRenderState?: (s: string) => void;
  /** "Click to place": while set, a click on the scan floor reports that floor point (Showcase x/z). */
  onFloorClick?: ((p: Vec2) => void) | null;
  /** Increment to walk the group show in viewing order (moves between real scan viewpoints). */
  walkRun?: number;
  /** Changes when the user picks a work (list, pad, plan): the camera flies to the best viewpoint for it. */
  focusKey?: string | null;
}) {
  const onViewRightRef = useRef(onViewRight); onViewRightRef.current = onViewRight;
  const onRenderStateRef = useRef(onRenderState); onRenderStateRef.current = onRenderState;
  const host = useRef<HTMLDivElement>(null);
  const sdkRef = useRef<any>(null);
  const compRef = useRef<any>(null);
  const objRef = useRef<any>(null);
  const [status, setStatus] = useState<Status>({ kind: "loading", step: "starting viewer" });
  const [attempt, setAttempt] = useState(0);
  const [sweeps, setSweeps] = useState<{ sid: string; position: { x: number; y: number; z: number } }[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const overlayRef = useRef(overlay);
  const floorClickRef = useRef(onFloorClick); floorClickRef.current = onFloorClick;
  const viewModeRef = useRef<string | null>(null); // current Showcase mode (inside / dollhouse / floorplan)
  overlayRef.current = overlay;

  // Mount <matterport-viewer>, wait for Playing, register the artwork component and create the scene object.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    if (!SDK_KEY) { setStatus({ kind: "error", reason: "VITE_MATTERPORT_SDK_KEY is not set" }); return; }
    let cancelled = false;
    const subs: { cancel(): void }[] = [];
    setStatus({ kind: "loading", step: "loading scan" });
    setSweeps([]);
    const viewer = document.createElement("matterport-viewer") as any;
    viewer.setAttribute("m", modelId);
    viewer.setAttribute("application-key", SDK_KEY);
    viewer.setAttribute("asset-base", "bundle");
    viewer.setAttribute("qs", "1");
    viewer.setAttribute("play", "1");
    viewer.setAttribute("title", "0");
    viewer.style.cssText = "display:block;width:100%;height:100%";
    viewer.addEventListener("mpViewerError", (ev: any) => { if (!cancelled) setStatus({ kind: "error", reason: ev.detail?.error?.message ?? "viewer error" }); });
    el.appendChild(viewer);
    // A background tab pauses Showcase rendering, so only count time while the page is visible.
    let visibleMs = 0;
    const tick = setInterval(() => {
      if (cancelled || sdkRef.current) return;
      if (document.visibilityState === "hidden") { setStatus({ kind: "loading", step: "waiting — tab is in the background, rendering paused" }); return; }
      visibleMs += 1000;
      if (visibleMs >= PLAY_TIMEOUT_MS) setStatus({ kind: "error", reason: `scan did not reach Playing within ${PLAY_TIMEOUT_MS / 1000}s` });
    }, 1000);
    const timeout = tick;
    (async () => {
      try {
        const mp = await viewer.playingPromise;
        scanShots.set(modelId, async () => {
          // Showcase only redraws on change; nudge the camera a hair (and back) so a fresh frame exists to capture.
          try { await mp.Camera.rotate(0.3, 0, { speed: 30 }); await mp.Camera.rotate(-0.3, 0, { speed: 30 }); } catch { /* ignore */ }
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          return mp.Renderer.takeScreenShot({ width: 1280, height: 720 }, { mattertags: false, sweeps: false });
        });
        if (cancelled) return;
        clearInterval(timeout);
        if (import.meta.env.DEV) (window as any).__mpBundle = mp; // dev-only debugging handle
        setStatus({ kind: "loading", step: "adding artwork to scene" });
        await mp.Scene.registerComponents([{ name: ARTWORK_COMPONENT, factory: artworkComponentFactory }]);
        const [obj] = await mp.Scene.createObjects(1);
        const node = obj.addNode();
        const comp = node.addComponent(ARTWORK_COMPONENT, { spec: overlayRef.current ?? null });
        obj.start();
        if (cancelled) { obj.stop(); return; }
        sdkRef.current = mp; compRef.current = comp; objRef.current = obj;
        subs.push(mp.Sweep.data.subscribe({
          onCollectionUpdated(c: Record<string, any>) { if (!cancelled) setSweeps(Object.entries(c).map(([sid, s]) => ({ sid: s.sid ?? sid, position: s.position }))); },
        }));
        subs.push(mp.Mode.current.subscribe((m: string) => { viewModeRef.current = m; }));
        // Camera yaw → viewer-right floor vector (three.js convention verified with Sweep.moveTo: forward = (−sin ψ, −cos ψ)).
        subs.push(mp.Camera.pose.subscribe((pose: any) => {
          if (cancelled || !pose?.rotation) return;
          const yaw = (pose.rotation.y * Math.PI) / 180;
          onViewRightRef.current?.({ x: Math.cos(yaw), z: -Math.sin(yaw) });
        }));
        setStatus({ kind: "playing" });
      } catch (e) {
        if (!cancelled) setStatus({ kind: "error", reason: (e as Error).message });
      }
    })();
    return () => {
      cancelled = true;
      clearInterval(timeout);
      subs.forEach((s) => s.cancel());
      try { objRef.current?.stop(); } catch { /* ignore */ }
      sdkRef.current = null; compRef.current = null; objRef.current = null;
      el.innerHTML = "";
    };
  }, [modelId, attempt]);

  // Push every new pose into the live scene component (no reload).
  const specKey = overlay ? JSON.stringify([overlay.artwork, overlay.heightM, overlay.buffer, overlay.red.length, overlay.green.length, overlay.conflict, overlay.floorY, overlay.baseElevationM, overlay.colorHex, overlay.material, overlay.model?.id ?? null, overlay.model?.override ?? null, overlay.photo?.id ?? null, overlay.group ? JSON.stringify(overlay.group, (k, v) => (k === "parts" ? undefined : k === "photo" ? v?.id ?? null : k === "model" ? v?.id ?? null : v)) : null]) : "none";
  useEffect(() => {
    if (status.kind !== "playing") { onRenderStateRef.current?.(status.kind === "loading" ? `loading (${status.step})` : `unavailable: ${status.reason}`); return; }
    if (!compRef.current) { onRenderStateRef.current?.("scene object not ready"); return; }
    try {
      compRef.current.inputs.spec = overlay ?? null;
      onRenderStateRef.current?.(overlay ? `applied edit v${editVersion ?? "?"}` : "no artwork pose to show");
    } catch (e) {
      onRenderStateRef.current?.(`failed to apply: ${(e as Error).message}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey, status.kind, editVersion]);

  /** Move to the scan viewpoint that best shows a target: in the room, outside its clearance, nearest, facing it. */
  /**
   * Move to the scan viewpoint that best shows a target: in the room, outside its viewing room and every work,
   * and far enough back that the whole work fits in the view (standing right against it makes the wide-angle
   * scan lens bend it). Then face it.
   */
  const lookAt = async (mp: any, t: { center: Vec2; heightM: number; sizeM: number; floorY: number; floor: Vec2[]; buffer: Vec2[]; avoid?: Vec2[][] }) => {
    const INSIDE = mp.Mode.Mode.INSIDE;
    const inside = () => viewModeRef.current === INSIDE || viewModeRef.current === "mode.inside";
    const dist = (s: (typeof sweeps)[number]) => Math.hypot(s.position.x - t.center.x, s.position.z - t.center.z);
    const at = (s: (typeof sweeps)[number]) => ({ x: s.position.x, z: s.position.z });
    const inRoom = sweeps.filter((s) => pointInPolygon(at(s), t.floor) >= 0 && !(t.avoid ?? []).some((a) => pointInPolygon(at(s), a) >= 0));
    const clear = inRoom.filter((s) => pointInPolygon(at(s), t.buffer) < 0);
    const ideal = Math.max(2, 1.3 * Math.max(t.sizeM, t.heightM)); // whole work in frame
    const pool = clear.length ? clear : inRoom.length ? inRoom : sweeps;
    const score = (s: (typeof sweeps)[number]) => { const d = dist(s); return d < ideal ? (ideal - d) * 3 : d - ideal; };
    const s = [...pool].sort((a, b) => score(a) - score(b))[0];
    const dx = t.center.x - s.position.x, dz = t.center.z - s.position.z;
    const rotation = { x: -(Math.atan2(s.position.y - t.floorY - t.heightM / 2, Math.hypot(dx, dz)) * 180) / Math.PI, y: (Math.atan2(-dx, -dz) * 180) / Math.PI };
    if (!inside()) await mp.Mode.moveTo(INSIDE, { sweep: s.sid, rotation, transition: mp.Mode.TransitionType?.FLY });
    try { await mp.Sweep.moveTo(s.sid, { rotation, transition: mp.Sweep.Transition.FLY, transitionTime: 1200 }); }
    catch { await mp.Camera.setRotation?.(rotation, { speed: 2 })?.catch?.(() => {}); } // already standing there: just turn
    return clear.length > 0;
  };

  // Walk-through: visit each work in viewing order from the real scan viewpoints.
  const walking = useRef(0);
  // A request made before this viewer existed is not replayed; one made while it is loading starts when ready.
  const handledWalk = useRef(walkRun ?? 0);
  const [walkNote, setWalkNote] = useState<string | null>(null);
  useEffect(() => {
    if (!walkRun || walkRun <= handledWalk.current) return;
    const mp = sdkRef.current, o = overlayRef.current;
    if (status.kind !== "playing" || !mp || !sweeps.length) { setWalkNote("The walk-through starts when the scan has loaded…"); return; }
    handledWalk.current = walkRun;
    if (!o?.tour?.length) { setWalkNote("No works placed to walk to."); return; }
    const my = ++walking.current;
    (async () => {
      await new Promise((r) => setTimeout(r, 900)); // let Showcase finish activating the current viewpoint first
      for (const [i, w] of o.tour!.entries()) {
        if (walking.current !== my) return;
        setWalkNote(`Walking the route: ${i + 1}/${o.tour!.length} · ${w.label}`);
        try { await lookAt(mp, { center: w.center, heightM: w.heightM, sizeM: w.sizeM, floorY: o.floorY, floor: o.floor, buffer: w.room, avoid: o.tour!.map((x) => x.corners) }); } catch (e) { setWalkNote("Move failed: " + (e as Error).message); return; }
        await new Promise((r) => setTimeout(r, 2200));
      }
      if (walking.current === my) setWalkNote("Walk-through finished. Scan viewpoints are where the camera was captured, so they only approximate the route.");
    })();
  }, [walkRun, status.kind, sweeps.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { walking.current++; }, []);

  const mode = (m: "dollhouse" | "floorplan" | "inside") => {
    const mp = sdkRef.current;
    if (!mp) return;
    setNote(null);
    if (m === "dollhouse") mp.Mode.moveTo(mp.Mode.Mode.DOLLHOUSE).catch((e: Error) => setNote(e.message));
    else if (m === "floorplan") mp.Mode.moveTo(mp.Mode.Mode.FLOORPLAN).catch((e: Error) => setNote(e.message));
    else {
      const o = overlayRef.current;
      const INSIDE = mp.Mode.Mode.INSIDE;
      const inside = () => viewModeRef.current === INSIDE || viewModeRef.current === "mode.inside";
      if (!o || !sweeps.length) {
        // Nothing placed yet: still bring the visitor back inside the scan (from dollhouse / floor plan).
        if (!o) setNote("No artwork placed yet; showing the scan from inside.");
        if (!inside()) mp.Mode.moveTo(INSIDE).catch((e: Error) => setNote("Move failed: " + e.message));
        return;
      }
      const sizeM = Math.max(...o.artwork.map((p) => Math.hypot(p.x - o.center.x, p.z - o.center.z))) * 2;
      lookAt(mp, { center: o.center, heightM: o.heightM, sizeM, floorY: o.floorY, floor: o.floor, buffer: o.buffer, avoid: o.group?.works.map((w) => w.corners) })
        .then((ok) => { if (!ok) setNote("No viewpoint outside the viewing room in this room; showing the nearest one."); })
        .catch((e: Error) => setNote("Move failed: " + e.message));
    }
  };

  // Fly to the selected work. The first key is the initial selection, not a user pick, so it is skipped.
  const lastFocus = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (lastFocus.current === undefined) { lastFocus.current = focusKey ?? null; return; }
    if (!focusKey || focusKey === lastFocus.current || status.kind !== "playing") return;
    lastFocus.current = focusKey;
    const t = setTimeout(() => mode("inside"), 60); // let the overlay for the new selection land first
    return () => clearTimeout(t);
  }, [focusKey, status.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "#000", minWidth: 0 }}>
      <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
        <div ref={host} style={{ position: "absolute", inset: 0 }} />
        {onFloorClick && status.kind === "playing" && (
          // Catch the click before Showcase does (a click there would walk the camera), then ask the SDK which
          // world point is under that screen position.
          <div className="place-catcher" role="button" tabIndex={0} aria-label="Click the floor to place the selected work"
            onClick={async (e) => {
              const mp = sdkRef.current, cb = floorClickRef.current;
              if (!mp || !cb) return;
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              try {
                const d = await mp.Renderer.getWorldPositionData({ x: e.clientX - r.left, y: e.clientY - r.top });
                const y0 = overlayRef.current?.floorY ?? 0;
                if (!d?.position) { setNote("Nothing there. Click on the floor."); return; }
                if (Math.abs(d.position.y - y0) > 0.35) { setNote("That's a wall or an object. Click on the floor."); return; }
                setNote(null);
                cb({ x: d.position.x, z: d.position.z });
              } catch (err) { setNote("Couldn't read that point: " + (err as Error).message); }
            }}>
            <span>Click the floor where the work should stand · Esc to cancel</span>
          </div>
        )}
        {status.kind !== "playing" && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#ddd", pointerEvents: "none", textAlign: "center", padding: 20 }}>
            {status.kind === "loading" ? <span><span className="spinner" /> Matterport: {status.step}…</span> : <span>Matterport scan unavailable: {status.reason}</span>}
          </div>
        )}
      </div>
      <div className="legend scan-controls" style={{ alignItems: "center" }}>
        {status.kind === "playing" && (overlay ? <span className="scan-state" title={`${sweeps.length} scan viewpoints`}>● Artwork overlay</span> : <span className="scan-state">Scan only</span>)}
        {status.kind === "loading" && <span className="badge info">Loading…</span>}
        {status.kind === "error" && <span className="badge conflict">{status.reason}</span>}
        <button className="ghost" style={{ padding: "2px 8px" }} disabled={status.kind !== "playing"} onClick={() => mode("inside")}>{"Inside"}</button>
        <button className="ghost" style={{ padding: "2px 8px" }} disabled={status.kind !== "playing"} onClick={() => mode("dollhouse")}>Overview</button>
        <button className="ghost" style={{ padding: "2px 8px" }} disabled={status.kind !== "playing"} onClick={() => mode("floorplan")}>Floor plan</button>
        {status.kind === "error" && <button className="ghost" style={{ padding: "2px 8px" }} onClick={() => setAttempt((a) => a + 1)}>Retry</button>}
        {note && <span className="faint">{note}</span>}
        {walkNote && <span className="faint walk-note">{walkNote}</span>}
        <details className="scan-about"><summary>About this view</summary><p>{overlay ? "Artwork is a planning overlay. " : ""}The scan shows conditions at capture time; current vacancy and furnishings need confirmation.</p></details>
      </div>
    </div>
  );
}
