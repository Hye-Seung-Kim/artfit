// Plan B renderer (spec §10.2): 3D planning view reconstructed from traced geometry, Showcase SDK frame (x, z; y up; m).
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { ContactShadows, Html, Line, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { bbox, centroid, pointInPolygon, roundedRect, type Obstacle, type Polygon, type SpatialAnnotation, type Vec2 } from "@artfit/geometry";
import type { Overlay } from "../workspace/overlay";
import { buildHumanFigure, figurePlacement } from "./humanFigure";
import { boxPose, buildModelGroup, disposeGroup, makeStudioEnvironment, photoTexture, type ArtworkPhoto, type ModelPart } from "./artworkModel";

const COLORS: Record<Obstacle["category"], string> = {
  column: "#555c53", fixed_fixture: "#73796e", entrance_zone: "#d9a400", restricted: "#777f89",
  movable_furniture: "#858b80", uncertain_object: "#b59a68",
};

/** Polygon on the floor plane as a flat mesh. Shape lives in (x, -z) so rotating -90° about X lands on (x, z). */
function FlatPoly({ poly, color, y = 0.002, opacity = 1 }: { poly: Polygon; color: string; y?: number; opacity?: number }) {
  const geom = useMemo(() => {
    const s = new THREE.Shape(poly.map((p) => new THREE.Vector2(p.x, -p.z)));
    return new THREE.ShapeGeometry(s);
  }, [poly]);
  return (
    <mesh geometry={geom} rotation={[-Math.PI / 2, 0, 0]} position={[0, y, 0]}>
      <meshStandardMaterial color={color} transparent={opacity < 1} opacity={opacity} side={THREE.DoubleSide} depthWrite={opacity >= 1} />
    </mesh>
  );
}

function Extruded({ poly, height, color, opacity = 1, roughness = 1, y = 0, edges }: { poly: Polygon; height: number; color: string; opacity?: number; roughness?: number; y?: number; edges?: string }) {
  const geom = useMemo(() => {
    const s = new THREE.Shape(poly.map((p) => new THREE.Vector2(p.x, -p.z)));
    return new THREE.ExtrudeGeometry(s, { depth: height, bevelEnabled: false });
  }, [poly, height]);
  const edgeGeom = useMemo(() => (edges ? new THREE.EdgesGeometry(geom) : null), [geom, edges]);
  return (
    <group position={[0, y, 0]}>
      <mesh geometry={geom} rotation={[-Math.PI / 2, 0, 0]} castShadow>
        <meshStandardMaterial color={color} transparent={opacity < 1} opacity={opacity} roughness={roughness} metalness={roughness < 0.3 ? 0.15 : 0} />
      </mesh>
      {edgeGeom && <lineSegments geometry={edgeGeom} rotation={[-Math.PI / 2, 0, 0]}><lineBasicMaterial color={edges} /></lineSegments>}
    </group>
  );
}

/** Viewer-right vector of the planning view's default camera (offset +0.15·span x, +0.8·span z from the room centre). */
export function defaultPlanViewRight(): Vec2 {
  const fx = -0.15, fz = -0.8, L = Math.hypot(fx, fz);
  return { x: -fz / L, z: fx / L };
}

export function luminance(hex: string) {
  const n = parseInt(hex.replace("#", ""), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

/** Reports the floor-plane vector pointing to the viewer's right, so "move left" follows the current camera. */
function ViewDirectionReporter({ onViewRight }: { onViewRight?: (v: Vec2) => void }) {
  const last = useRef<Vec2 | null>(null);
  const dir = useMemo(() => new THREE.Vector3(), []);
  const { camera } = useThree();
  useEffect(() => {
    // report once on mount too (the render loop pauses in background tabs)
    const t = setTimeout(() => {
      camera.getWorldDirection(dir);
      const L = Math.hypot(dir.x, dir.z);
      if (L > 1e-6 && onViewRight) { last.current = { x: -dir.z / L, z: dir.x / L }; onViewRight(last.current); }
    }, 50);
    return () => clearTimeout(t);
  }, [camera, dir, onViewRight]);
  useFrame(({ camera }) => {
    if (!onViewRight) return;
    camera.getWorldDirection(dir);
    const L = Math.hypot(dir.x, dir.z);
    if (L < 1e-6) return; // looking straight down: keep the last known direction
    const r = { x: -dir.z / L, z: dir.x / L }; // right = forward × up
    if (!last.current || Math.abs(last.current.x - r.x) + Math.abs(last.current.z - r.z) > 0.01) { last.current = r; onViewRight(r); }
  });
  return null;
}

function Outline({ poly, color, y = 0.01, width = 2, dashed = false }: { poly: Polygon; color: string; y?: number; width?: number; dashed?: boolean }) {
  const pts = [...poly, poly[0]].map((p) => [p.x, y, p.z] as [number, number, number]);
  return <Line points={pts} color={color} lineWidth={width} dashed={dashed} dashSize={0.15} gapSize={0.1} />;
}

function Wall({ a, b, t, h }: { a: Vec2; b: Vec2; t: number; h: number }) {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const ang = Math.atan2(b.z - a.z, b.x - a.x);
  return (
    <mesh position={[(a.x + b.x) / 2, h / 2, (a.z + b.z) / 2]} rotation={[0, -ang, 0]}>
      <boxGeometry args={[len, h, Math.max(t, 0.05)]} />
      <meshStandardMaterial color="#d9ddd6" transparent opacity={0.28} />
    </mesh>
  );
}

function Human({ at, yaw }: { at: Vec2; yaw: number }) {
  const fig = useMemo(() => buildHumanFigure(THREE), []);
  return (
    <group position={[at.x, 0, at.z]} rotation={[0, yaw, 0]}>
      <primitive object={fig} />
      <Html position={[0, 1.9, 0]} center><span style={{ fontSize: 10, color: "#555", whiteSpace: "nowrap" }}>1.7 m figure</span></Html>
    </group>
  );
}

export interface ViewerProps {
  annotation: SpatialAnnotation;
  overlay: Overlay | null;
  artworkHeightM: number;
  attempt: boolean; // illustrative tested conflict pose
  limiter: { label: string; artworkPoint: Vec2; limiterPoint: Vec2; text: string } | null;
  wallHeightM: number;
  /** Artwork bottom above the floor (ArtFit edit state). Only the artwork body moves; floor overlays stay down. */
  baseElevationM?: number;
  finish?: { hex: string; material: "matte" | "satin" | "gloss" };
  conflict?: boolean;
  onViewRight?: (v: Vec2) => void;
  /** Canvas area covered by floating workspace UI (px). */
  viewInset?: ViewInset;
  /** User-supplied 3D model (unit-sized geometry) drawn in place of the box, scaled to the artwork's W × H × D. */
  model?: { id: string; parts: ModelPart[]; override: { hex: string; roughness: number } | null } | null;
  /** Front photo applied to the box's front face (ignored when a 3D model is shown). */
  photo?: ArtworkPhoto | null;
  /** Group show: several works, the viewing route and standing spots (replaces the single-artwork overlay). */
  group?: {
    works: { id: string; corners: Vec2[]; heightM: number; color: string; selected: boolean; issue: boolean; locked: boolean; label: string; clearanceM: number; viewPoint: Vec2 | null; pose: { x: number; z: number; rotDeg: number }; widthM: number; depthM: number;
      look: { model?: { id: string; parts: ModelPart[] }; photo?: ArtworkPhoto } | null }[];
    route: Vec2[]; entrance: Vec2 | null; onSelect?: (id: string) => void;
    /** Drag-to-move: total floor offset in metres, reported once on release. */
    onMove?: (id: string, dx: number, dz: number) => void;
    /** Increment to play the walk-through once. */
    walkRun?: number;
  } | null;
  /** Single work: drag-to-move, total floor offset in metres reported once on release. */
  onMoveArtwork?: (dx: number, dz: number) => void;
  /** Identifies the space; its camera view is saved and restored when switching spaces. */
  viewKey?: string;
}

/**
 * Walk-through: a 1.7 m figure follows the route at an easy pace (shown 3× faster), stopping at each standing spot
 * to face the work. It replays the computed path; it does not model crowds or speed.
 */
function Walker({ path, stops, run }: { path: Vec2[]; stops: { at: Vec2; look: Vec2 }[]; run: number }) {
  const ref = useRef<THREE.Group>(null);
  const fig = useMemo(() => buildHumanFigure(THREE, { color: 0x1f7a68 }), []);
  const seg = useMemo(() => {
    const cum = [0];
    for (let k = 1; k < path.length; k++) cum.push(cum[k - 1] + Math.hypot(path[k].x - path[k - 1].x, path[k].z - path[k - 1].z));
    // Arc length of each stop = the path vertex closest to its standing spot.
    const st = stops.map((s) => { let bi = 0, bd = Infinity; path.forEach((p, i) => { const d = Math.hypot(p.x - s.at.x, p.z - s.at.z); if (d < bd) { bd = d; bi = i; } }); return { s: cum[bi], look: s.look }; }).sort((a, b) => a.s - b.s);
    return { cum, total: cum[cum.length - 1] ?? 0, stops: st };
  }, [path, stops]);
  const st = useRef({ active: false, s: 0, pause: 0, next: 0 });
  useEffect(() => { if (run > 0 && path.length > 1) st.current = { active: true, s: 0, pause: 0, next: 0 }; }, [run]); // eslint-disable-line react-hooks/exhaustive-deps
  useFrame((_, dt) => {
    const g = ref.current, v = st.current;
    if (!g) return;
    g.visible = v.active;
    if (!v.active) return;
    if (v.pause > 0) { v.pause -= dt; return; }
    const reduce = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    v.s += dt * (reduce ? 12 : 4.2);
    const stop = seg.stops[v.next];
    let face: Vec2 | null = null;
    if (stop && v.s >= stop.s) { v.s = stop.s; v.pause = reduce ? 0.6 : 1.4; v.next++; face = stop.look; }
    if (v.s >= seg.total) { v.active = false; g.visible = false; return; }
    let k = 1;
    while (k < seg.cum.length - 1 && seg.cum[k] < v.s) k++;
    const a = path[k - 1], b = path[k], L = seg.cum[k] - seg.cum[k - 1] || 1, t = Math.min(1, Math.max(0, (v.s - seg.cum[k - 1]) / L));
    const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
    g.position.set(x, 0, z);
    g.rotation.y = face ? Math.atan2(face.x - x, face.z - z) : Math.atan2(b.x - a.x, b.z - a.z);
  });
  return <group ref={ref} visible={false}><primitive object={fig} /></group>;
}

/**
 * Drag a work across the floor. While dragging, the children follow the pointer on the floor plane (y = 0) and the
 * orbit camera is paused; on release the total move is reported once (one undo step). A short click stays a click.
 */
function Draggable({ enabled, onDrop, onClick, children }: { enabled: boolean; onDrop: (dx: number, dz: number) => void; onClick?: () => void; children: React.ReactNode }) {
  const controls = useThree((st) => st.controls) as any;
  const { gl } = useThree();
  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
  const hit = useMemo(() => new THREE.Vector3(), []);
  const drag = useRef<{ x: number; z: number; id: number; moved: boolean } | null>(null);
  const [off, setOff] = useState<[number, number]>([0, 0]);
  const end = (e: any, commit: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    try { e.target?.releasePointerCapture?.(d.id); } catch { /* ignore */ }
    if (controls) controls.enabled = true;
    gl.domElement.style.cursor = "";
    const [dx, dz] = off;
    setOff([0, 0]);
    if (commit && d.moved && Math.hypot(dx, dz) >= 0.02) onDrop(dx, dz);
    else if (commit && !d.moved) onClick?.();
  };
  return (
    <group position={[off[0], 0, off[1]]}
      onPointerOver={() => { if (!drag.current) gl.domElement.style.cursor = enabled ? "grab" : "pointer"; }}
      onPointerOut={() => { if (!drag.current) gl.domElement.style.cursor = ""; }}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (!enabled) { onClick?.(); return; }
        if (!e.ray.intersectPlane(plane, hit)) return;
        (e.target as any).setPointerCapture?.(e.pointerId);
        drag.current = { x: hit.x, z: hit.z, id: e.pointerId, moved: false };
        if (controls) controls.enabled = false;
        gl.domElement.style.cursor = "grabbing";
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || !e.ray.intersectPlane(plane, hit)) return;
        e.stopPropagation();
        const dx = hit.x - d.x, dz = hit.z - d.z;
        if (Math.hypot(dx, dz) > 0.03) d.moved = true;
        setOff([Math.round(dx * 100) / 100, Math.round(dz * 100) / 100]);
      }}
      onPointerUp={(e) => { e.stopPropagation(); end(e, true); }}
      onPointerCancel={(e) => end(e, false)}
    >{children}</group>
  );
}

/** Group show layer: every work (colour = artist), the selected work's viewing room, standing spots and the route. */
function GroupLayer({ group }: { group: NonNullable<ViewerProps["group"]> }) {
  const sel = group.works.find((w) => w.selected) ?? null;
  const fig = sel?.viewPoint ?? group.works.find((w) => w.viewPoint)?.viewPoint ?? null;
  const figWork = sel ?? group.works.find((w) => w.viewPoint) ?? null;
  return (
    <>
      {group.route.length > 1 && <Line points={group.route.map((p) => [p.x, 0.03, p.z] as [number, number, number])} color="#1f7a68" lineWidth={3} />}
      {group.entrance && (
        <Html position={[group.entrance.x, 0.2, group.entrance.z]} center><span className="scene-tag">Entrance</span></Html>
      )}
      {group.works.map((w) => (
        <Draggable key={w.id} enabled={!!group.onMove && !w.locked} onClick={() => group.onSelect?.(w.id)} onDrop={(dx, dz) => group.onMove?.(w.id, dx, dz)}>
          {w.selected && <Outline poly={roundedRect(w.pose.x, w.pose.z, w.widthM, w.depthM, w.pose.rotDeg, w.clearanceM)} color={w.issue ? "#d93025" : "#2e7d4f"} dashed y={0.015} />}
          {w.look?.model
            ? <><ModelArtwork corners={w.corners} heightM={w.heightM} y={0} model={{ id: w.look.model.id, parts: w.look.model.parts, override: null }} conflict={w.issue} />
                <Outline poly={w.corners} color={w.selected ? "#6bdcc5" : "#111111"} dashed y={0.02} width={w.selected ? 2 : 1} /></>
            : <Extruded poly={w.corners} height={w.heightM} color={w.issue ? "#d93025" : w.color} opacity={w.issue ? 0.65 : w.selected ? 1 : 0.9}
                edges={w.selected ? "#6bdcc5" : w.issue ? "#d93025" : "#9aa09a"} />}
          {!w.look?.model && w.look?.photo && !w.issue && <PhotoFace corners={w.corners} heightM={w.heightM} y={0} photo={w.look.photo} />}
          {w.viewPoint && <mesh position={[w.viewPoint.x, 0.02, w.viewPoint.z]} rotation={[-Math.PI / 2, 0, 0]}><circleGeometry args={[0.12, 24]} /><meshBasicMaterial color="#1f7a68" /></mesh>}
          <Html position={[w.pose.x, w.heightM + 0.35, w.pose.z]} center>
            <span className={"scene-tag" + (w.selected ? " on" : "") + (w.issue ? " bad" : "")}>{w.label}{w.locked ? " · locked" : ""}</span>
          </Html>
        </Draggable>
      ))}
      {fig && figWork && <Human at={fig} yaw={Math.atan2(figWork.pose.x - fig.x, figWork.pose.z - fig.z)} />}
      <Walker path={group.route} stops={group.works.filter((w) => w.viewPoint).map((w) => ({ at: w.viewPoint!, look: { x: w.pose.x, z: w.pose.z } }))} run={group.walkRun ?? 0} />
    </>
  );
}

/** The artwork's front photo on the box's front face (local +z side, W × H), centre-cropped to the face. */
function PhotoFace({ corners, heightM, y, photo }: { corners: Vec2[]; heightM: number; y: number; photo: ArtworkPhoto }) {
  const { cx, cz, w, d, yaw } = boxPose(corners);
  const aspect = Math.round((w / heightM) * 100) / 100;
  const tex = useMemo(() => photoTexture(THREE, photo, aspect), [photo, aspect]);
  useEffect(() => () => tex.dispose(), [tex]);
  return (
    <group position={[cx, y, cz]} rotation={[0, yaw, 0]}>
      <mesh position={[0, heightM / 2, d / 2 + 0.004]} scale={[w, heightM, 1]}>
        <planeGeometry args={[1, 1]} />
        <meshStandardMaterial map={tex} roughness={0.85} />
      </mesh>
    </group>
  );
}

/** The imported model with its own materials, stretched to the artwork's outer box and placed on its pose. */
function ModelArtwork({ corners, heightM, y, model, conflict }: { corners: Vec2[]; heightM: number; y: number; model: NonNullable<ViewerProps["model"]>; conflict: boolean }) {
  const { gl } = useThree();
  // Image-based lighting so metals show reflections instead of flat black (applied to the model only).
  const env = useMemo(() => makeStudioEnvironment(THREE, gl), [gl]);
  useEffect(() => () => env.dispose(), [env]);
  const okey = model.override ? `${model.override.hex}:${model.override.roughness}` : "";
  const group = useMemo(() => buildModelGroup(THREE, model.parts, { override: model.override, conflict, envMap: env, envIntensity: 1.8 }), [model.id, okey, conflict, env]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => disposeGroup(group), [group]);
  const { cx, cz, w, d, yaw } = boxPose(corners);
  return <primitive object={group} position={[cx, y, cz]} rotation={[0, yaw, 0]} scale={[w, heightM, d]} />;
}

/** Pixels of the canvas covered by floating UI; the room is framed inside what remains. */
export interface ViewInset { l: number; r: number; t: number; b: number }

/** Camera + orbit target per space, kept for the app session so switching A ↔ B returns to the same view. */
const savedViews = new Map<string, { pos: THREE.Vector3; target: THREE.Vector3 }>();

function ResponsiveCamera({ x, z, span, inset, viewKey }: { x: number; z: number; span: number; inset?: ViewInset; viewKey?: string }) {
  const { camera, size, invalidate } = useThree();
  const controls = useThree((st) => st.controls) as any;
  const { l = 0, r = 0, t = 0, b = 0 } = inset ?? {};
  // Projection only (size / floating-panel inset): never moves the camera, so the user's orbit is kept.
  useEffect(() => {
    if (size.width < 10 || size.height < 10) return; // hidden canvas
    const cam = camera as THREE.PerspectiveCamera;
    const fw = Math.max(240, size.width - l - r), fh = Math.max(180, size.height - t - b);
    const insetOn = l + r + t + b > 0 && fw < size.width + 1;
    if (insetOn) { cam.aspect = fw / fh; cam.setViewOffset(fw, fh, -l, -t, size.width, size.height); }
    else { cam.clearViewOffset(); cam.aspect = size.width / Math.max(1, size.height); }
    cam.updateProjectionMatrix();
    invalidate();
  }, [camera, size.width, size.height, l, r, t, b, invalidate]);
  // Camera position: restore this space's saved view, or frame the room once. Save the view when leaving.
  const framed = useRef<string | null>(null);
  useEffect(() => {
    if (size.width < 10 || size.height < 10 || !controls) return;
    const key = viewKey ?? `${x},${z}`;
    if (framed.current === key) return;
    framed.current = key;
    const saved = viewKey ? savedViews.get(viewKey) : undefined;
    if (saved) { camera.position.copy(saved.pos); controls.target.copy(saved.target); }
    else {
      const aspect = (size.width - l - r) / Math.max(1, size.height - t - b);
      const framing = Math.max(1, 1.1 / Math.max(0.1, aspect));
      camera.position.set(x + span * .15 * framing, span * .85 * framing, z + span * .8 * framing);
      controls.target.set(x, 0, z);
    }
    controls.update();
    invalidate();
  }, [viewKey, x, z, span, size.width, size.height, controls, camera, invalidate]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    if (viewKey && controls) savedViews.set(viewKey, { pos: camera.position.clone(), target: controls.target.clone() });
  }, [viewKey, controls, camera]);
  return null;
}

export default function PlanningView({ annotation, overlay, artworkHeightM, attempt, limiter, wallHeightM, baseElevationM = 0, finish, conflict = false, onViewRight, viewInset, model, viewKey, photo, group, onMoveArtwork }: ViewerProps) {
  const c = centroid(annotation.floor);
  const bb = bbox(annotation.floor);
  const span = Math.max(bb.maxX - bb.minX, bb.maxZ - bb.minZ);
  const human = overlay ? figurePlacement(centroid(overlay.artwork), overlay.buffer, annotation.floor, pointInPolygon) : null;
  return (
    <Canvas shadows gl={{ preserveDrawingBuffer: true }} camera={{ position: [c.x + span * 0.15, span * 0.85, c.z + span * 0.8], fov: 40 }} style={{ flex: 1 }}>
      <color attach="background" args={["#f1f3ef"]} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[c.x + 5, 12, c.z + 6]} intensity={0.9} castShadow />
      <FlatPoly poly={annotation.floor} color="#e1e5dc" y={0} />
      <Outline poly={annotation.floor} color="#313a30" width={2} />
      {(annotation.walls ?? []).map((w, i) => <Wall key={i} a={w.a} b={w.b} t={w.thicknessM} h={wallHeightM} />)}
      {annotation.obstacles.map((o) => {
        const poly = o.shape.kind === "polygon" ? o.shape.poly : Array.from({ length: 64 }, (_, i) => ({ x: (o.shape as any).c.x + (o.shape as any).r * Math.cos((i / 64) * 2 * Math.PI), z: (o.shape as any).c.z + (o.shape as any).r * Math.sin((i / 64) * 2 * Math.PI) }));
        const flat = o.category === "entrance_zone" || o.category === "restricted";
        return flat
          ? <group key={o.id}><FlatPoly poly={poly} color={COLORS[o.category]} y={0.004} opacity={0.35} /><Outline poly={poly} color={COLORS[o.category]} dashed y={0.012} /></group>
          : <Extruded key={o.id} poly={poly} height={o.heightM ?? (o.category === "column" ? wallHeightM : 0.9)} color={COLORS[o.category]} opacity={o.mobility === "unknown" ? 0.75 : 1} />;
      })}
      {overlay && (
        <>
          {overlay.green.map((p, i) => <FlatPoly key={"g" + i} poly={p} color="#6bdcc5" y={0.006} opacity={0.35} />)}
          {overlay.red.map((p, i) => <FlatPoly key={"r" + i} poly={p} color="#d93025" y={0.008} opacity={0.6} />)}
          <Outline poly={overlay.buffer} color={overlay.red.length ? "#d93025" : "#2e7d4f"} dashed y={0.015} />
          <Draggable enabled={!!onMoveArtwork} onDrop={(dx, dz) => onMoveArtwork?.(dx, dz)}>
          {model ? (
            <>
              <ModelArtwork corners={overlay.artwork} heightM={artworkHeightM} y={baseElevationM} model={model} conflict={attempt || conflict} />
              {/* the outer box on the floor: what the placement check uses */}
              {baseElevationM === 0 && <Outline poly={overlay.artwork} color="#111111" dashed y={0.02} width={1} />}
            </>
          ) : <Extruded poly={overlay.artwork} height={artworkHeightM} y={baseElevationM}
            color={finish ? finish.hex : attempt ? "#d93025" : "#171717"} opacity={attempt || conflict ? 0.6 : 0.95}
            roughness={finish?.material === "gloss" ? 0.15 : finish?.material === "satin" ? 0.5 : 1}
            edges={attempt || conflict ? "#d93025" : luminance(finish?.hex ?? "#171717") > 0.5 ? "#111111" : "#9aa09a"} />}
          {!model && photo && !(attempt || conflict) && <PhotoFace corners={overlay.artwork} heightM={artworkHeightM} y={baseElevationM} photo={photo} />}
          </Draggable>
          {baseElevationM > 0 && (
            <>
              {/* floor projection of the lifted artwork + guides; the plan check uses this projection */}
              <Outline poly={overlay.artwork} color="#111111" dashed y={0.02} />
              {overlay.artwork.map((p, i) => <Line key={"v" + i} points={[[p.x, 0.02, p.z], [p.x, baseElevationM, p.z]]} color="#666" lineWidth={1} dashed dashSize={0.08} gapSize={0.06} />)}
            </>
          )}
          {human && <Human at={{ x: human.x, z: human.z }} yaw={human.yaw} />}
        </>
      )}
      {group && <GroupLayer group={group} />}
      {limiter && (
        <>
          <Line points={[[limiter.artworkPoint.x, 0.05, limiter.artworkPoint.z], [limiter.limiterPoint.x, 0.05, limiter.limiterPoint.z]]} color="#111" lineWidth={2} />
          <Html position={[(limiter.artworkPoint.x + limiter.limiterPoint.x) / 2, 0.4, (limiter.artworkPoint.z + limiter.limiterPoint.z) / 2]} center>
            <div style={{ background: "rgba(20,20,20,.85)", color: "#fff", fontSize: 11, padding: "3px 6px", borderRadius: 4, whiteSpace: "nowrap" }}>{limiter.text}</div>
          </Html>
        </>
      )}
      <ContactShadows position={[c.x, 0.001, c.z]} scale={span * 1.4} opacity={0.35} blur={2} far={4} />
      <OrbitControls maxPolarAngle={Math.PI / 2.05} makeDefault />
      <ResponsiveCamera x={c.x} z={c.z} span={span} inset={viewInset} viewKey={viewKey} />
      <ViewDirectionReporter onViewRight={onViewRight} />
    </Canvas>
  );
}
