// Display-only overlay geometry (spec §7.10). Verdicts never come from this file.
import polygonClipping, { type MultiPolygon, type Polygon as PCPoly } from "polygon-clipping";
import { obstaclePolygon, rectCorners, roundedRect, type Obstacle, type Polygon, type Pose } from "@artfit/geometry";

const toPC = (p: Polygon): PCPoly => [[...p.map((v) => [v.x, v.z] as [number, number]), [p[0].x, p[0].z]]];
const fromPC = (mp: MultiPolygon): Polygon[] => mp.map((poly) => poly[0].slice(0, -1).map(([x, z]) => ({ x, z })));

export interface Overlay { red: Polygon[]; green: Polygon[]; buffer: Polygon; artwork: Polygon }

export function computeOverlay(floor: Polygon, obstacles: Obstacle[], pose: Pose, w: number, d: number, clearance: number, passes: boolean): Overlay {
  const buffer = roundedRect(pose.x, pose.z, w, d, pose.rotDeg, clearance);
  const artwork = rectCorners(pose.x, pose.z, w, d, pose.rotDeg);
  const B = toPC(buffer);
  const F = toPC(floor);
  const obs = obstacles.map((o) => toPC(obstaclePolygon(o)));
  const SUB_EPS = 1e-6;
  const area = (p: Polygon) => Math.abs(p.reduce((s, v, i) => { const n = p[(i + 1) % p.length]; return s + v.x * n.z - n.x * v.z; }, 0) / 2);
  let red: Polygon[] = [];
  try {
    const outside = polygonClipping.difference(B, F);
    const hits = obs.flatMap((o) => polygonClipping.intersection(B, o));
    red = fromPC(outside).concat(fromPC(hits as MultiPolygon)).filter((p) => p.length >= 3 && area(p) > SUB_EPS);
  } catch { red = []; }
  let green: Polygon[] = [];
  if (passes) {
    try {
      let g = polygonClipping.intersection(B, F);
      for (const o of obs) g = polygonClipping.difference(g, o);
      green = fromPC(g).filter((p) => p.length >= 3);
    } catch { green = []; }
  }
  return { red, green, buffer, artwork };
}
