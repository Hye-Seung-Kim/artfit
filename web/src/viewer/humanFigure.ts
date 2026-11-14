// 1.70 m reference figure built from primitives. Takes the THREE module as a parameter so the same figure is
// used inside the Matterport bundle scene (bundle's three) and the R3F planning view (our three).
// Local frame: feet at y = 0, facing +Z, height 1.70 m. Display only; never part of any calculation.
import type { Vec2 } from "@artfit/geometry";

export const FIGURE_HEIGHT_M = 1.7;

export function buildHumanFigure(THREE: any, opts: { color?: number; opacity?: number } = {}) {
  const g = new THREE.Group();
  g.name = "artfit-1.7m-figure";
  // Unlit matcap shading: reads as a rounded 3D figure WITHOUT adding lights. Lights added to the Matterport
  // scene make Showcase recompile every scan material and freeze the page.
  const matcap = makeMatcap(THREE);
  const mat = new THREE.MeshMatcapMaterial({ matcap, color: opts.color ?? 0xb7c3cf, transparent: (opts.opacity ?? 1) < 1, opacity: opts.opacity ?? 1 });
  const dark = new THREE.MeshMatcapMaterial({ matcap, color: 0x55606b });
  const add = (geo: any, m: any, x: number, y: number, z: number, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, 0, rz);
    mesh.scale.set(sx, sy, sz);
    g.add(mesh);
    return mesh;
  };
  // capsule between two heights (vertical limb segment)
  const limb = (r: number, y0: number, y1: number, x: number, z = 0, tilt = 0) =>
    add(new THREE.CapsuleGeometry(r, Math.max(0.001, y1 - y0 - 2 * r), 4, 12), mat, x + Math.sin(tilt) * (y1 - y0) / 2, (y0 + y1) / 2, z, 0, tilt);

  for (const s of [-1, 1]) {
    add(new THREE.BoxGeometry(0.1, 0.07, 0.25), dark, s * 0.1, 0.035, 0.05);   // feet
    limb(0.055, 0.06, 0.5, s * 0.1);                                           // shins
    limb(0.075, 0.46, 0.92, s * 0.1);                                          // thighs
    limb(0.045, 1.1, 1.42, s * 0.235, 0, s * 0.06);                            // upper arms
    limb(0.04, 0.84, 1.13, s * 0.255, 0.02, s * 0.03);                         // forearms
    add(new THREE.SphereGeometry(0.045, 12, 10), mat, s * 0.26, 0.8, 0.02);   // hands
    add(new THREE.SphereGeometry(0.06, 12, 10), mat, s * 0.2, 1.4, 0);        // shoulders
  }
  add(new THREE.CylinderGeometry(0.17, 0.15, 0.16, 20), mat, 0, 0.96, 0, 0, 0, 1, 1, 0.65);   // pelvis
  add(new THREE.CylinderGeometry(0.2, 0.155, 0.42, 20), mat, 0, 1.24, 0, 0, 0, 1, 1, 0.6);    // torso
  add(new THREE.CylinderGeometry(0.05, 0.055, 0.1, 12), mat, 0, 1.49, 0);                     // neck
  add(new THREE.SphereGeometry(0.1, 20, 16), mat, 0, 1.6, 0.005, 0, 0, 0.9, 1.1, 1);          // head (top ≈ 1.71 m)
  return g;
}

const matcapCache = new Map<string, { three: any; tex: any }>();
/** Small generated matcap (light from upper-left), cached per THREE instance and variant. No scene lights needed. */
export function makeMatcap(THREE: any, variant: "soft" | "satin" | "gloss" = "soft") {
  const hit = matcapCache.get(variant);
  if (hit && hit.three === THREE) return hit.tex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const stops: [number, string][] = variant === "gloss"
    ? [[0, "#ffffff"], [0.12, "#f4f4f4"], [0.2, "#b9b9b9"], [0.7, "#7a7a7a"], [1, "#2e2e2e"]]
    : variant === "satin"
      ? [[0, "#ffffff"], [0.3, "#d9d9d9"], [0.8, "#7c7c7c"], [1, "#3c3c3c"]]
      : [[0, "#ffffff"], [0.45, "#c9c9c9"], [0.85, "#6e6e6e"], [1, "#3a3a3a"]];
  const grad = ctx.createRadialGradient(46, 40, 4, 64, 64, 64);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  if ("colorSpace" in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  matcapCache.set(variant, { three: THREE, tex });
  return tex;
}

/**
 * Where to stand the figure: just outside the clearance buffer, on the traced floor, away from obstacles if
 * possible, facing the artwork. Returns position + yaw (radians, three.js Y rotation; figure faces +Z locally).
 */
export function figurePlacement(center: Vec2, buffer: Vec2[], floor: Vec2[] | null, inside: (p: Vec2, poly: Vec2[]) => number): { x: number; z: number; yaw: number } {
  const reach = (dx: number, dz: number) => {
    // distance from center to buffer boundary along (dx, dz), by marching
    let t = 0;
    while (t < 30 && inside({ x: center.x + dx * t, z: center.z + dz * t }, buffer) >= 0) t += 0.05;
    return t;
  };
  const dirs = Array.from({ length: 16 }, (_, i) => (i / 16) * Math.PI * 2);
  let best: { x: number; z: number; score: number } | null = null;
  for (const a of dirs) {
    const dx = Math.cos(a), dz = Math.sin(a);
    const d = reach(dx, dz) + 0.45;
    const p = { x: center.x + dx * d, z: center.z + dz * d };
    if (floor && inside(p, floor) < 1) continue;
    // also require some room around the feet
    const ok = !floor || [0.25, -0.25].every((o) => inside({ x: p.x + o, z: p.z }, floor) >= 0 && inside({ x: p.x, z: p.z + o }, floor) >= 0);
    if (!ok) continue;
    const score = d; // prefer the closest valid spot to the artwork
    if (!best || score < best.score) best = { ...p, score };
  }
  const p = best ?? { x: center.x + reach(1, 0) + 0.45, z: center.z };
  const yaw = Math.atan2(center.x - p.x, center.z - p.z); // rotate local +Z toward the artwork
  return { x: p.x, z: p.z, yaw };
}
