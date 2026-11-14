import type { Polygon, Vec2 } from "./types.js";

/** Floating-point tolerance only. NOT measurement accuracy (spec §7.8). */
export const EPS = 1e-6;
const AREA_EPS = 1e-9;

export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, z: a.z - b.z });
export const cross = (a: Vec2, b: Vec2) => a.x * b.z - a.z * b.x;
export const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.z * b.z;
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
function orient(a: Vec2, b: Vec2, c: Vec2) { return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x); }
function sgn(v: number) { return Math.abs(v) <= EPS * EPS ? 0 : v > 0 ? 1 : -1; }

export function signedArea(p: Polygon): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    s += a.x * b.z - b.x * a.z;
  }
  return s / 2;
}
export const area = (p: Polygon) => Math.abs(signedArea(p));
export const ensureCCW = (p: Polygon): Polygon => (signedArea(p) < 0 ? [...p].reverse() : p);

export function centroid(p: Polygon): Vec2 {
  const A = signedArea(p);
  if (Math.abs(A) < AREA_EPS) {
    const n = p.length || 1;
    return { x: p.reduce((s, v) => s + v.x, 0) / n, z: p.reduce((s, v) => s + v.z, 0) / n };
  }
  let cx = 0, cz = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    const f = a.x * b.z - b.x * a.z;
    cx += (a.x + b.x) * f;
    cz += (a.z + b.z) * f;
  }
  return { x: cx / (6 * A), z: cz / (6 * A) };
}

export function bbox(p: Polygon) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const v of p) {
    minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
    minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
  }
  return { minX, minZ, maxX, maxZ };
}

export function edges(p: Polygon): [Vec2, Vec2][] {
  return p.map((a, i) => [a, p[(i + 1) % p.length]] as [Vec2, Vec2]);
}

/** Closest point on segment ab to p. */
export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const ab = sub(b, a);
  const L = dot(ab, ab);
  if (L === 0) return a;
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / L));
  return { x: a.x + ab.x * t, z: a.z + ab.z * t };
}

export function pointSegDist(p: Vec2, a: Vec2, b: Vec2) {
  return ptSeg(p.x, p.z, a.x, a.z, b.x, b.z);
}

/** Allocation-free point–segment distance. */
function ptSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax, abz = bz - az;
  const L = abx * abx + abz * abz;
  let t = L === 0 ? 0 : ((px - ax) * abx + (pz - az) * abz) / L;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + abx * t), dz = pz - (az + abz * t);
  return Math.sqrt(dx * dx + dz * dz);
}

/** Allocation-free segment–segment distance (0 when they cross). */
function segSegNum(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  if (properCross(a, b, c, d)) return 0;
  return Math.min(ptSeg(a.x, a.z, c.x, c.z, d.x, d.z), ptSeg(b.x, b.z, c.x, c.z, d.x, d.z), ptSeg(c.x, c.z, a.x, a.z, b.x, b.z), ptSeg(d.x, d.z, a.x, a.z, b.x, b.z));
}

/** Proper crossing: segments intersect at a single interior point of both. */
export function properCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = sgn(orient(a, b, c)), o2 = sgn(orient(a, b, d));
  if (o1 * o2 >= 0) return false;
  return sgn(orient(c, d, a)) * sgn(orient(c, d, b)) < 0;
}

/** Segment-segment minimum distance and the pair of closest points. */
export function segSegDist(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { d: number; p: Vec2; q: Vec2 } {
  if (properCross(a, b, c, d)) {
    // intersection point
    const r = sub(b, a), s = sub(d, c);
    const t = cross(sub(c, a), s) / cross(r, s);
    const p = { x: a.x + r.x * t, z: a.z + r.z * t };
    return { d: 0, p, q: p };
  }
  const cands: { d: number; p: Vec2; q: Vec2 }[] = [];
  const q1 = closestOnSegment(a, c, d); cands.push({ d: dist(a, q1), p: a, q: q1 });
  const q2 = closestOnSegment(b, c, d); cands.push({ d: dist(b, q2), p: b, q: q2 });
  const p3 = closestOnSegment(c, a, b); cands.push({ d: dist(c, p3), p: p3, q: c });
  const p4 = closestOnSegment(d, a, b); cands.push({ d: dist(d, p4), p: p4, q: d });
  let best = cands[0];
  for (const k of cands) if (k.d < best.d) best = k;
  return best;
}

/** Boundary-aware point-in-polygon: 1 inside, 0 on boundary (within EPS), -1 outside. */
export function pointInPolygon(p: Vec2, poly: Polygon): 1 | 0 | -1 {
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if (ptSeg(p.x, p.z, poly[j].x, poly[j].z, poly[i].x, poly[i].z) <= EPS) return 0;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > p.z) !== (b.z > p.z)) {
      const x = ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x;
      if (p.x < x) inside = !inside;
    }
  }
  return inside ? 1 : -1;
}

/** Parameters t in (0,1) along segment ab where it meets polygon edges (touches or crossings). */
function splitParams(a: Vec2, b: Vec2, poly: Polygon): number[] {
  const ts: number[] = [0, 1];
  const r = sub(b, a);
  const L2 = dot(r, r);
  for (const [c, d] of edges(poly)) {
    const s = sub(d, c);
    const den = cross(r, s);
    if (Math.abs(den) > 1e-12) {
      const t = cross(sub(c, a), s) / den;
      const u = cross(sub(c, a), r) / den;
      if (t > -EPS && t < 1 + EPS && u > -EPS && u < 1 + EPS) ts.push(Math.min(1, Math.max(0, t)));
    } else if (L2 > 0) {
      // parallel/collinear: add projections of c and d
      for (const v of [c, d]) {
        if (pointSegDist(v, a, b) <= EPS) ts.push(Math.min(1, Math.max(0, dot(sub(v, a), r) / L2)));
      }
    }
  }
  // polygon vertices lying on the segment
  for (const v of poly) if (L2 > 0 && pointSegDist(v, a, b) <= EPS) ts.push(Math.min(1, Math.max(0, dot(sub(v, a), r) / L2)));
  return [...new Set(ts.map((t) => Math.round(t * 1e9) / 1e9))].sort((x, y) => x - y);
}

/**
 * Containment of a convex quad R (artwork rectangle) in a simple, possibly concave polygon (spec §7.3).
 * Corners inside/on, no proper crossings, every sub-interval midpoint inside/on, and no polygon vertex strictly
 * inside R (a reflex notch poking into the rectangle).
 */
export function rectInsidePolygon(R: Polygon, floor: Polygon): boolean {
  let touching = false;
  for (const c of R) {
    const s = pointInPolygon(c, floor);
    if (s < 0) return false;
    if (s === 0) touching = true;
  }
  // Fast path: corners strictly inside and no floor edge within EPS of the rectangle boundary.
  if (!touching) {
    let near = false;
    outer: for (let i = 0; i < R.length; i++) {
      const a = R[i], b = R[(i + 1) % R.length];
      for (let k = 0, j = floor.length - 1; k < floor.length; j = k++) {
        if (segSegNum(a, b, floor[j], floor[k]) <= EPS) { near = true; break outer; }
      }
    }
    if (!near) {
      for (const v of floor) if (pointInPolygon(v, R) === 1) return false;
      return true;
    }
  }
  const fe = edges(floor);
  for (const [a, b] of edges(R)) {
    for (const [c, d] of fe) if (properCross(a, b, c, d)) return false;
    const ts = splitParams(a, b, floor);
    for (let i = 0; i + 1 < ts.length; i++) {
      const tm = (ts[i] + ts[i + 1]) / 2;
      const m = { x: a.x + (b.x - a.x) * tm, z: a.z + (b.z - a.z) * tm };
      if (pointInPolygon(m, floor) < 0) return false;
    }
  }
  for (const v of floor) if (pointInPolygon(v, R) === 1) return false;
  return true;
}

/** Clip a (possibly concave) subject polygon by a convex CCW clip polygon (Sutherland–Hodgman). */
export function clipConvex(subject: Polygon, clip: Polygon): Polygon {
  let out = subject;
  const C = ensureCCW(clip);
  for (let i = 0; i < C.length && out.length; i++) {
    const a = C[i], b = C[(i + 1) % C.length];
    const inp = out;
    out = [];
    const inside = (p: Vec2) => orient(a, b, p) >= 0;
    const inter = (p: Vec2, q: Vec2): Vec2 => {
      const r = sub(q, p), s = sub(b, a);
      const t = cross(sub(a, p), s) / cross(r, s);
      return { x: p.x + r.x * t, z: p.z + r.z * t };
    };
    for (let j = 0; j < inp.length; j++) {
      const p = inp[j], q = inp[(j + 1) % inp.length];
      const pin = inside(p), qin = inside(q);
      if (pin && qin) out.push(q);
      else if (pin && !qin) out.push(inter(p, q));
      else if (!pin && qin) { out.push(inter(p, q)); out.push(q); }
    }
  }
  return out;
}

/** Interior overlap of convex rect R and polygon P (spec §7.4): positive intersection area. Boundary contact is not overlap. */
export function polygonsOverlap(R: Polygon, P: Polygon): boolean {
  // Fast reject on axis-aligned bounds.
  const a = bbox(R), b = bbox(P);
  if (a.maxX <= b.minX + EPS || b.maxX <= a.minX + EPS || a.maxZ <= b.minZ + EPS || b.maxZ <= a.minZ + EPS) return false;
  const clipped = clipConvex(ensureCCW(P), R);
  if (clipped.length >= 3 && area(clipped) > AREA_EPS) return true;
  return false;
}

/** Minimum distance between the boundaries of two polygons (assumes no interior overlap). */
export function polyPolyDist(A: Polygon, B: Polygon): { d: number; p: Vec2; q: Vec2 } {
  // numeric pass to find the closest edge pair, then compute points once
  let bd = Infinity, bi = 0, bj = 0;
  for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) {
    const d = segSegNum(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length]);
    if (d < bd) { bd = d; bi = i; bj = j; }
  }
  return segSegDist(A[bi], A[(bi + 1) % A.length], B[bj], B[(bj + 1) % B.length]);
}

export function rectCorners(x: number, z: number, w: number, d: number, rotDeg: number): Polygon {
  const t = (rotDeg * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  const hx = w / 2, hz = d / 2;
  const local = [{ x: -hx, z: -hz }, { x: hx, z: -hz }, { x: hx, z: hz }, { x: -hx, z: hz }];
  return local.map((p) => ({ x: x + p.x * c - p.z * s, z: z + p.x * s + p.z * c }));
}

/** Simple-polygon validation for annotation review (spec §6.2). */
export function validatePolygon(p: Polygon): string[] {
  const errs: string[] = [];
  if (p.length < 3) errs.push("fewer than 3 points");
  if (p.some((v) => !Number.isFinite(v.x) || !Number.isFinite(v.z))) errs.push("non-finite coordinate");
  if (area(p) < 1e-6) errs.push("collinear or zero-area polygon");
  const E = edges(p);
  for (let i = 0; i < E.length; i++) for (let j = i + 1; j < E.length; j++) {
    if (j === i + 1 || (i === 0 && j === E.length - 1)) continue; // adjacent
    const r = segSegDist(E[i][0], E[i][1], E[j][0], E[j][1]);
    if (r.d <= EPS) { errs.push(`self-intersection between edges ${i} and ${j}`); return errs; }
  }
  return errs;
}

/** Round buffer outline of a rectangle (display only, spec §7.10). */
export function roundedRect(x: number, z: number, w: number, d: number, rotDeg: number, r: number, seg = 8): Polygon {
  if (r <= 0) return rectCorners(x, z, w, d, rotDeg);
  const t = (rotDeg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const hx = w / 2, hz = d / 2;
  const corners = [{ x: hx, z: -hz, a0: -Math.PI / 2 }, { x: hx, z: hz, a0: 0 }, { x: -hx, z: hz, a0: Math.PI / 2 }, { x: -hx, z: -hz, a0: Math.PI }];
  const out: Polygon = [];
  for (const k of corners) for (let i = 0; i <= seg; i++) {
    const a = k.a0 + (i / seg) * (Math.PI / 2);
    // circumscribed-ish: scale radius so chords stay outside the true arc
    const rr = r / Math.cos(Math.PI / 4 / seg);
    const lx = k.x + rr * Math.cos(a), lz = k.z + rr * Math.sin(a);
    out.push({ x: x + lx * c - lz * s, z: z + lx * s + lz * c });
  }
  return out;
}

export function circleToPolygon(c: Vec2, r: number, n = 64, circumscribed = false): Polygon {
  const rr = circumscribed ? r / Math.cos(Math.PI / n) : r;
  return Array.from({ length: n }, (_, i) => ({ x: c.x + rr * Math.cos((2 * Math.PI * i) / n), z: c.z + rr * Math.sin((2 * Math.PI * i) / n) }));
}

/** Circle through three points; rejects near-collinear / ill-conditioned input (spec §6.2). */
export function circleFrom3(a: Vec2, b: Vec2, c: Vec2): { c: Vec2; r: number } | { error: string } {
  const d = 2 * (a.x * (b.z - c.z) + b.x * (c.z - a.z) + c.x * (a.z - b.z));
  const span = Math.max(dist(a, b), dist(b, c), dist(a, c));
  if (span < 0.02) return { error: "points too close together" };
  // normalized collinearity: twice triangle area / span^2
  if (Math.abs(d) / 2 / (span * span) < 0.02) return { error: "points are nearly collinear; circle is ill-conditioned" };
  const A = a.x * a.x + a.z * a.z, B = b.x * b.x + b.z * b.z, C = c.x * c.x + c.z * c.z;
  const ux = (A * (b.z - c.z) + B * (c.z - a.z) + C * (a.z - b.z)) / d;
  const uz = (A * (c.x - b.x) + B * (a.x - c.x) + C * (b.x - a.x)) / d;
  const r = dist({ x: ux, z: uz }, a);
  if (!Number.isFinite(r) || r > 5 * span) return { error: "fitted radius is unstable relative to point spread" };
  return { c: { x: ux, z: uz }, r };
}
