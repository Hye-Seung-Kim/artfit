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

export type ScanOverlay = ArtworkSceneSpec & { center: Vec2; label: string; floor: Vec2[] };

type Status = { kind: "loading"; step: string } | { kind: "playing" } | { kind: "error"; reason: string };

export default function MatterportEmbed({ modelId, overlay, editVersion, onViewRight, onRenderState }: {
  modelId: string; overlay?: ScanOverlay | null;
  /** ArtFit edit version the overlay represents; reported back once it is actually in the scene. */
  editVersion?: number;
  onViewRight?: (v: Vec2) => void;
  onRenderState?: (s: string) => void;
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
  const specKey = overlay ? JSON.stringify([overlay.artwork, overlay.heightM, overlay.buffer, overlay.red.length, overlay.green.length, overlay.conflict, overlay.floorY, overlay.baseElevationM, overlay.colorHex, overlay.material, overlay.model?.id ?? null, overlay.model?.override ?? null, overlay.photo?.id ?? null]) : "none";
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

  const mode = (m: "dollhouse" | "floorplan" | "inside") => {
    const mp = sdkRef.current;
    if (!mp) return;
    setNote(null);
    if (m === "dollhouse") mp.Mode.moveTo(mp.Mode.Mode.DOLLHOUSE).catch((e: Error) => setNote(e.message));
    else if (m === "floorplan") mp.Mode.moveTo(mp.Mode.Mode.FLOORPLAN).catch((e: Error) => setNote(e.message));
    else {
      const o = overlayRef.current;
      if (!o || !sweeps.length) return;
      // Nearest viewpoint inside the matched floor region but OUTSIDE the clearance buffer, so the camera stands
      // in the same room looking at the artwork rather than inside it or behind a wall.
      const dist = (s: (typeof sweeps)[number]) => Math.hypot(s.position.x - o.center.x, s.position.z - o.center.z);
      const at = (s: (typeof sweeps)[number]) => ({ x: s.position.x, z: s.position.z });
      const inRoom = sweeps.filter((s) => pointInPolygon(at(s), o.floor) >= 0);
      const clear = inRoom.filter((s) => pointInPolygon(at(s), o.buffer) < 0);
      const pool = clear.length ? clear : inRoom.length ? inRoom : sweeps;
      const s = [...pool].sort((a, b) => dist(a) - dist(b))[0];
      if (!clear.length) setNote("No viewpoint outside the clearance zone in this room; showing the nearest one.");
      const dx = o.center.x - s.position.x, dz = o.center.z - s.position.z;
      const yaw = (Math.atan2(-dx, -dz) * 180) / Math.PI; // three.js camera looks down -Z
      const pitch = -(Math.atan2(s.position.y - o.floorY - o.heightM / 2, Math.hypot(dx, dz)) * 180) / Math.PI;
      mp.Sweep.moveTo(s.sid, { rotation: { x: pitch, y: yaw }, transition: mp.Sweep.Transition.FLY, transitionTime: 1500 })
        .catch((e: Error) => setNote("Move failed: " + e.message));
    }
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "#000", minWidth: 0 }}>
      <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
        <div ref={host} style={{ position: "absolute", inset: 0 }} />
        {status.kind !== "playing" && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#ddd", pointerEvents: "none", textAlign: "center", padding: 20 }}>
            {status.kind === "loading" ? <span><span className="spinner" /> Matterport: {status.step}…</span> : <span>Matterport scan unavailable: {status.reason}</span>}
          </div>
        )}
      </div>
      <div className="legend scan-controls" style={{ alignItems: "center" }}>
        {status.kind === "playing" && <span className="badge fit">● Artwork placed in scan · {sweeps.length} viewpoints</span>}
        {status.kind === "loading" && <span className="badge info">Loading…</span>}
        {status.kind === "error" && <span className="badge conflict">{status.reason}</span>}
        <button className="ghost" style={{ padding: "2px 8px" }} disabled={status.kind !== "playing" || !overlay} onClick={() => mode("inside")}>View artwork from inside</button>
        <button className="ghost" style={{ padding: "2px 8px" }} disabled={status.kind !== "playing"} onClick={() => mode("dollhouse")}>Dollhouse</button>
        <button className="ghost" style={{ padding: "2px 8px" }} disabled={status.kind !== "playing"} onClick={() => mode("floorplan")}>Floor plan</button>
        {status.kind === "error" && <button className="ghost" style={{ padding: "2px 8px" }} onClick={() => setAttempt((a) => a + 1)}>Retry</button>}
        {note && <span className="faint">{note}</span>}
        <span>{overlay ? overlay.label + " · " : ""}planning overlay; the scan still shows whatever was captured at scan time.</span>
      </div>
    </div>
  );
}
