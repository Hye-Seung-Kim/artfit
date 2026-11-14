// Plan B renderer (spec §10.2): 3D planning view reconstructed from traced geometry, Showcase SDK frame (x, z; y up; m).
import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { ContactShadows, Html, Line, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { bbox, centroid, pointInPolygon, type Obstacle, type Polygon, type SpatialAnnotation, type Vec2 } from "@artfit/geometry";
import type { Overlay } from "../workspace/overlay";
import { buildHumanFigure, figurePlacement } from "./humanFigure";

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
}

function ResponsiveCamera({ x, z, span }: { x: number; z: number; span: number }) {
  const { camera, size, invalidate } = useThree();
  useEffect(() => {
    // Preserve the full room on portrait canvases; don't reset the orbit on artwork edits.
    const framing = Math.max(1, 1.1 / (size.width / Math.max(1, size.height)));
    camera.position.set(x + span * .15 * framing, span * .85 * framing, z + span * .8 * framing);
    camera.lookAt(x, 0, z);
    invalidate();
  }, [camera, size.width, size.height, x, z, span, invalidate]);
  return null;
}

export default function PlanningView({ annotation, overlay, artworkHeightM, attempt, limiter, wallHeightM, baseElevationM = 0, finish, conflict = false, onViewRight }: ViewerProps) {
  const c = centroid(annotation.floor);
  const bb = bbox(annotation.floor);
  const span = Math.max(bb.maxX - bb.minX, bb.maxZ - bb.minZ);
  const human = overlay ? figurePlacement(centroid(overlay.artwork), overlay.buffer, annotation.floor, pointInPolygon) : null;
  return (
    <Canvas shadows camera={{ position: [c.x + span * 0.15, span * 0.85, c.z + span * 0.8], fov: 40 }} style={{ flex: 1 }}>
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
          <Extruded poly={overlay.artwork} height={artworkHeightM} y={baseElevationM}
            color={finish ? finish.hex : attempt ? "#d93025" : "#171717"} opacity={attempt || conflict ? 0.6 : 0.95}
            roughness={finish?.material === "gloss" ? 0.15 : finish?.material === "satin" ? 0.5 : 1}
            edges={attempt || conflict ? "#d93025" : luminance(finish?.hex ?? "#171717") > 0.5 ? "#111111" : "#9aa09a"} />
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
      {limiter && (
        <>
          <Line points={[[limiter.artworkPoint.x, 0.05, limiter.artworkPoint.z], [limiter.limiterPoint.x, 0.05, limiter.limiterPoint.z]]} color="#111" lineWidth={2} />
          <Html position={[(limiter.artworkPoint.x + limiter.limiterPoint.x) / 2, 0.4, (limiter.artworkPoint.z + limiter.limiterPoint.z) / 2]} center>
            <div style={{ background: "rgba(20,20,20,.85)", color: "#fff", fontSize: 11, padding: "3px 6px", borderRadius: 4, whiteSpace: "nowrap" }}>{limiter.text}</div>
          </Html>
        </>
      )}
      <ContactShadows position={[c.x, 0.001, c.z]} scale={span * 1.4} opacity={0.35} blur={2} far={4} />
      <OrbitControls target={[c.x, 0, c.z]} maxPolarAngle={Math.PI / 2.05} makeDefault />
      <ResponsiveCamera x={c.x} z={c.z} span={span} />
      <ViewDirectionReporter onViewRight={onViewRight} />
    </Canvas>
  );
}
