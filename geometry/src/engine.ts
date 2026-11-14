import {
  EPS, bbox, centroid, dist, edges, ensureCCW, polyPolyDist, polygonsOverlap, rectCorners, rectInsidePolygon,
} from "./poly.js";
import type {
  Check, Evaluation, Obstacle, PlacementScenario, Polygon, Pose, PoseResult, ScanResult, ScanSettings,
  SpatialAnnotation, Vec2,
} from "./types.js";

export { EPS };
export const RULES_VERSION = "artfit-rules-1.0.0";
export const DEFAULT_SCAN: ScanSettings = { gridStepM: 0.1, rotationsDeg: [0, 90] };
export const FOUR_ROTATIONS = [0, 45, 90, 135];

/** Judge on raw values (spec §7.8). */
export const passes = (c: number | null, req: number) => c !== null && c >= req - EPS;
/** Conservative display: floor to 0.05 m. */
export const displayM = (c: number) => Math.floor((c + EPS) / 0.05) * 0.05;
export const fmtM = (c: number) => displayM(c).toFixed(2);
export const M_PER_FT = 0.3048;
export const SQM_PER_SQFT = 0.09290304;

/** Round-buffered footprint area (spec §5.2) — a necessary condition only. */
export const requiredAreaM2 = (w: number, d: number, c: number) => w * d + 2 * c * (w + d) + Math.PI * c * c;

/** Analytic rectangle–circle signed distance (spec §7.6). <= 0 means overlap/touch. */
export function rectToCircleDistance(
  f: { x: number; z: number; w: number; d: number; rotRad: number },
  c: { c: Vec2; r: number },
): number {
  const dx = c.c.x - f.x, dz = c.c.z - f.z;
  const cos = Math.cos(-f.rotRad), sin = Math.sin(-f.rotRad);
  const lx = dx * cos - dz * sin;
  const lz = dx * sin + dz * cos;
  const hx = f.w / 2, hz = f.d / 2;
  const qx = Math.max(-hx, Math.min(hx, lx));
  const qz = Math.max(-hz, Math.min(hz, lz));
  return Math.hypot(lx - qx, lz - qz) - c.r;
}

function rectCircleClosest(f: { x: number; z: number; w: number; d: number; rotRad: number }, c: { c: Vec2; r: number }) {
  const dx = c.c.x - f.x, dz = c.c.z - f.z;
  const cos = Math.cos(-f.rotRad), sin = Math.sin(-f.rotRad);
  const lx = dx * cos - dz * sin, lz = dx * sin + dz * cos;
  const qx = Math.max(-f.w / 2, Math.min(f.w / 2, lx));
  const qz = Math.max(-f.d / 2, Math.min(f.d / 2, lz));
  // back to world
  const c2 = Math.cos(f.rotRad), s2 = Math.sin(f.rotRad);
  const artworkPoint = { x: f.x + qx * c2 - qz * s2, z: f.z + qx * s2 + qz * c2 };
  const len = Math.hypot(c.c.x - artworkPoint.x, c.c.z - artworkPoint.z) || 1;
  const limiterPoint = { x: c.c.x - ((c.c.x - artworkPoint.x) / len) * c.r, z: c.c.z - ((c.c.z - artworkPoint.z) / len) * c.r };
  return { artworkPoint, limiterPoint };
}

/** Error thrown when a scenario asks to remove something that is not a reviewed movable obstacle. */
export class ScenarioError extends Error {}

export const AS_SCANNED: PlacementScenario = {
  id: "as_scanned", version: 1, mode: "as_scanned", removedObstacleIds: [], selectedBy: "default",
  assumptions: ["All traced furniture and uncertain objects remain in place, as captured in the scan."],
};

/** Canonical pure scenario resolver shared by server and browser (spec §6.4, §10.5). */
export function resolveActiveObstacles(annotation: SpatialAnnotation, scenario: PlacementScenario): Obstacle[] {
  if (scenario.mode === "as_scanned") {
    if (scenario.removedObstacleIds.length) throw new ScenarioError("as_scanned scenario cannot remove obstacles");
    return annotation.obstacles;
  }
  const byId = new Map(annotation.obstacles.map((o) => [o.id, o]));
  for (const id of scenario.removedObstacleIds) {
    const o = byId.get(id);
    if (!o) throw new ScenarioError(`obstacle ${id} does not belong to annotation ${annotation.annotationId}`);
    if (o.category !== "movable_furniture" || o.mobility !== "reviewed_movable")
      throw new ScenarioError(`obstacle ${id} (${o.category}/${o.mobility}) cannot be removed in any scenario`);
  }
  const removed = new Set(scenario.removedObstacleIds);
  return annotation.obstacles.filter((o) => !removed.has(o.id));
}

/** Deterministic canonical JSON + FNV-1a 64-ish hash (pure, no crypto dependency). */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
}
export function hash(v: unknown): string {
  const s = typeof v === "string" ? v : canonical(v);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

export interface ScanInput {
  annotation: SpatialAnnotation;
  scenario: PlacementScenario;
  artwork: { widthM: number; depthM: number };
  settings?: ScanSettings;
}

export function scanKeyOf(input: ScanInput, activeObstacleHash: string, gridOrigin: Vec2): string {
  const s = input.settings ?? DEFAULT_SCAN;
  const a = input.annotation;
  return hash({
    spaceId: a.spaceId, annotationId: a.annotationId, modelId: a.modelId, regionId: a.regionId,
    geometryVersion: a.version, scenarioId: input.scenario.id, scenarioVersion: input.scenario.version,
    activeObstacleHash, W: input.artwork.widthM, D: input.artwork.depthM, gridOrigin,
    gridStep: s.gridStepM, rotations: s.rotationsDeg, rulesVersion: RULES_VERSION,
  });
}

type Classified = "outside" | { obstacleId: string } | null;

function testPose(R: Polygon, floor: Polygon, obstacles: Obstacle[], x: number, z: number, w: number, d: number, rotDeg: number): Classified {
  if (!rectInsidePolygon(R, floor)) return "outside";
  const rotRad = (rotDeg * Math.PI) / 180;
  for (const o of obstacles) {
    if (o.shape.kind === "circle") {
      if (rectToCircleDistance({ x, z, w, d, rotRad }, o.shape) < -EPS) return { obstacleId: o.id };
    } else if (polygonsOverlap(R, o.shape.poly)) return { obstacleId: o.id };
  }
  return null;
}

/** Minimum distance from artwork rect to floor boundary and every active blocker (spec §7.5). */
export function minDistance(R: Polygon, floor: Polygon, obstacles: Obstacle[], f: { x: number; z: number; w: number; d: number; rotRad: number }) {
  let best = { d: Infinity, id: "floor_boundary", limiterPoint: floor[0], artworkPoint: R[0] };
  const fb = polyPolyDist(R, floor);
  best = { d: fb.d, id: "floor_boundary", limiterPoint: fb.q, artworkPoint: fb.p };
  for (const o of obstacles) {
    if (o.shape.kind === "circle") {
      const dd = Math.max(0, rectToCircleDistance(f, o.shape));
      if (dd < best.d) {
        const cp = rectCircleClosest(f, o.shape);
        best = { d: dd, id: o.id, limiterPoint: cp.limiterPoint, artworkPoint: cp.artworkPoint };
      }
    } else {
      const r = polyPolyDist(R, o.shape.poly);
      if (r.d < best.d) best = { d: r.d, id: o.id, limiterPoint: r.q, artworkPoint: r.p };
    }
  }
  return best;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Sampled placement search (spec §7.2). */
export function scan(input: ScanInput): ScanResult {
  const t0 = now();
  const s = input.settings ?? DEFAULT_SCAN;
  const { annotation, scenario, artwork } = input;
  const W = artwork.widthM, D = artwork.depthM;
  if (!(W > 0 && D > 0 && Number.isFinite(W) && Number.isFinite(D))) throw new Error("artwork dimensions must be finite and > 0");
  if (!(s.gridStepM > 0)) throw new Error("grid step must be > 0");
  const floor = ensureCCW(annotation.floor);
  const obstacles = resolveActiveObstacles(annotation, scenario);
  const activeObstacleHash = hash(obstacles.map((o) => ({ id: o.id, shape: o.shape, category: o.category })).sort((a, b) => (a.id < b.id ? -1 : 1)));
  const bb = bbox(floor);
  const gridOrigin = { x: bb.minX, z: bb.minZ };
  const nx = Math.floor((bb.maxX - bb.minX) / s.gridStepM + EPS) + 1;
  const nz = Math.floor((bb.maxZ - bb.minZ) / s.gridStepM + EPS) + 1;
  const cen = centroid(floor);
  const valid: PoseResult[] = [];
  let tested = 0;
  let attempt: { pose: Pose; reason: string; dc: number } | null = null;
  for (const rot of s.rotationsDeg) {
    const rotRad = (rot * Math.PI) / 180;
    for (let i = 0; i < nx; i++) {
      const x = gridOrigin.x + i * s.gridStepM;
      for (let j = 0; j < nz; j++) {
        const z = gridOrigin.z + j * s.gridStepM;
        tested++;
        const R = rectCorners(x, z, W, D, rot);
        const res = testPose(R, floor, obstacles, x, z, W, D, rot);
        if (res !== null) {
          const dc = Math.hypot(x - cen.x, z - cen.z);
          if (!attempt || dc < attempt.dc - 1e-12)
            attempt = { pose: { x, z, rotDeg: rot }, reason: res === "outside" ? "floor_boundary" : res.obstacleId, dc };
          continue;
        }
        const m = minDistance(R, floor, obstacles, { x, z, w: W, d: D, rotRad });
        valid.push({ x, z, rotDeg: rot, clearanceM: m.d, limiterId: m.id, limiterPoint: m.limiterPoint, artworkPoint: m.artworkPoint });
      }
    }
  }
  valid.sort((a, b) => {
    if (Math.abs(b.clearanceM - a.clearanceM) > 1e-12) return b.clearanceM - a.clearanceM;
    const da = Math.hypot(a.x - cen.x, a.z - cen.z), db = Math.hypot(b.x - cen.x, b.z - cen.z);
    if (Math.abs(da - db) > 1e-12) return da - db;
    return a.rotDeg - b.rotDeg || a.x - b.x || a.z - b.z;
  });
  const sampledPositionCount = nx * nz;
  const result: ScanResult = {
    spaceId: annotation.spaceId, annotationId: annotation.annotationId, modelId: annotation.modelId,
    regionId: annotation.regionId, geometryVersion: annotation.version, scenarioId: scenario.id,
    scenarioVersion: scenario.version, activeObstacleHash, artwork: { widthM: W, depthM: D }, gridOrigin,
    gridStepM: s.gridStepM, rotationsDeg: [...s.rotationsDeg], sampledPositionCount,
    testedCount: tested, validCount: valid.length, poses: valid, bestPose: valid[0] ?? null,
    bestSampledClearanceM: valid[0]?.clearanceM ?? null,
    attemptPose: attempt?.pose ?? null, attemptReason: attempt?.reason ?? null,
    scanDurationMs: 0, rulesVersion: RULES_VERSION, scanKey: scanKeyOf(input, activeObstacleHash, gridOrigin),
  };
  if (tested !== sampledPositionCount * s.rotationsDeg.length) throw new Error("tested count invariant violated");
  result.scanDurationMs = now() - t0;
  return result;
}

/** Simple keyed scan cache: clearance-only changes reuse the scan (spec §7.9). */
export class ScanCache {
  private m = new Map<string, ScanResult>();
  hits = 0; misses = 0;
  constructor(private max = 64) {}
  get(input: ScanInput): ScanResult {
    const s = input.settings ?? DEFAULT_SCAN;
    const floor = ensureCCW(input.annotation.floor);
    const bb = bbox(floor);
    const obstacles = resolveActiveObstacles(input.annotation, input.scenario);
    const aoh = hash(obstacles.map((o) => ({ id: o.id, shape: o.shape, category: o.category })).sort((a, b) => (a.id < b.id ? -1 : 1)));
    const key = scanKeyOf({ ...input, settings: s }, aoh, { x: bb.minX, z: bb.minZ });
    const hit = this.m.get(key);
    if (hit) { this.hits++; return hit; }
    this.misses++;
    const r = scan({ ...input, settings: s });
    this.m.set(key, r);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string);
    return r;
  }
}

export interface EvaluateContext {
  matchVerified: boolean;
  annotation: SpatialAnnotation;
  scenario: PlacementScenario;
  artworkHeightM: number;
  evidenceVersion: number;
  conditionEligibility: Evaluation["conditionEligibility"];
  evidenceIds: string[];
}

/** Local height check (spec §7.7): only reviewed local minimum clear height decides. */
export function heightCheck(heightM: number, localHeightM: number | null): Check {
  if (localHeightM === null || !Number.isFinite(localHeightM)) return "unknown";
  return heightM <= localHeightM - EPS ? "pass" : "fail";
}

export function geometryVerificationOf(matchVerified: boolean, a: SpatialAnnotation): Evaluation["geometryVerification"] {
  if (!matchVerified) return "Unknown";
  if (a.annotationVerified && a.scaleCheck?.passed && a.obstacleCoverage === "reviewed_complete_for_region") return "Verified";
  return "PotentialFit";
}

/** evaluate(scan, requiredC) → Evaluation (spec §7.9). */
export function evaluate(scanRes: ScanResult, requiredC: number, ctx: EvaluateContext): Evaluation {
  if (!(requiredC >= 0 && Number.isFinite(requiredC))) throw new Error("required clearance must be finite and >= 0");
  const passing = scanRes.poses.filter((p) => passes(p.clearanceM, requiredC));
  const selectedPose = passing[0] ?? scanRes.bestPose;
  const geometryVerification = geometryVerificationOf(ctx.matchVerified, ctx.annotation);
  const floorResult: "fit" | "conflict" = passing.length > 0 ? "fit" : "conflict";
  const status = geometryVerification === "Unknown" ? "unknown" : floorResult;
  const h = heightCheck(ctx.artworkHeightM, ctx.annotation.ceilingHeightM);
  const unknowns: string[] = [];
  const failed: string[] = [];
  if (!ctx.matchVerified) unknowns.push("exact_space_match_not_verified");
  if (!ctx.annotation.annotationVerified) unknowns.push("annotation_not_reviewed");
  if (!ctx.annotation.scaleCheck?.passed) unknowns.push("scale_not_verified");
  if (ctx.annotation.obstacleCoverage !== "reviewed_complete_for_region") unknowns.push("obstacle_coverage_" + ctx.annotation.obstacleCoverage);
  if (h === "unknown") unknowns.push("local_height_unknown");
  if (h === "fail") failed.push("local_height");
  unknowns.push("access_route_unknown");
  if (floorResult === "conflict") failed.push(scanRes.bestPose ? "clearance_below_requirement" : "no_valid_placement_found");
  return {
    spaceId: scanRes.spaceId, scenarioId: scanRes.scenarioId, scenarioVersion: scanRes.scenarioVersion,
    geometryVersion: scanRes.geometryVersion, evidenceVersion: ctx.evidenceVersion,
    requiredClearanceM: requiredC, passCount: passing.length, status,
    exploratoryStatus: geometryVerification === "Unknown" ? floorResult : null,
    selectedPose,
    displayAttemptPose: scanRes.bestPose ? null : scanRes.attemptPose,
    heightCheck: h, accessCheck: "unknown", geometryVerification,
    conditional: ctx.scenario.mode === "hypothetical_furniture_removal",
    conditionEligibility: ctx.conditionEligibility,
    failedConstraints: failed, unknowns, evidenceIds: ctx.evidenceIds, scanKey: scanRes.scanKey,
    testedCount: scanRes.testedCount, sampledPositionCount: scanRes.sampledPositionCount,
    rotationsDeg: scanRes.rotationsDeg, bestSampledClearanceM: scanRes.bestSampledClearanceM,
  };
}

/**
 * Same-space preference-only clearance proposal (spec §8.2 step 2).
 * Returns the exact proposed requirement, or a reason it is unavailable.
 */
export function proposeClearance(best: number | null, preferred: number, minimum: number | null):
  | { kind: "proposal"; proposedC: number }
  | { kind: "needs_user_minimum" }
  | { kind: "unavailable"; reason: string } {
  if (minimum === null) return { kind: "needs_user_minimum" };
  if (best === null) return { kind: "unavailable", reason: "no_valid_placement_among_samples" };
  if (passes(best, preferred)) return { kind: "unavailable", reason: "preferred_clearance_already_met" };
  if (best < minimum - EPS) return { kind: "unavailable", reason: "best_sampled_clearance_below_user_minimum" };
  const C = Math.min(preferred, Math.max(minimum, displayM(best)));
  if (!(C >= minimum - EPS && C < preferred && passes(best, C))) return { kind: "unavailable", reason: "proposal_failed_validation" };
  return { kind: "proposal", proposedC: Math.round(C * 1e9) / 1e9 };
}

/** Polygon of an obstacle, for display (circles as 64-gons). */
export function obstaclePolygon(o: Obstacle): Polygon {
  if (o.shape.kind === "polygon") return o.shape.poly;
  const { c, r } = o.shape;
  return Array.from({ length: 64 }, (_, i) => ({ x: c.x + r * Math.cos((2 * Math.PI * i) / 64), z: c.z + r * Math.sin((2 * Math.PI * i) / 64) }));
}

export function floorEdges(a: SpatialAnnotation) { return edges(a.floor); }
export { dist };

/** Result of checking ONE user-specified pose (no search, no substitution). */
export interface PoseCheck {
  pose: Pose;
  valid: boolean;                 // inside floor and no interior overlap with an active blocker
  outsideFloor: boolean;
  overlappingObstacleIds: string[];
  clearanceM: number | null;      // only for valid poses
  limiterId: string | null;
  limiterPoint: Vec2 | null;
  artworkPoint: Vec2 | null;
}

/**
 * Evaluate exactly the pose the user placed (spec: a user-placed artwork is checked where it is, never
 * silently replaced by the best sampled pose). Same containment/collision/distance rules as scan().
 */
export function checkPose(annotation: SpatialAnnotation, scenario: PlacementScenario, artwork: { widthM: number; depthM: number }, pose: Pose): PoseCheck {
  const W = artwork.widthM, D = artwork.depthM;
  if (!(W > 0 && D > 0 && Number.isFinite(W) && Number.isFinite(D))) throw new Error("artwork dimensions must be finite and > 0");
  if (![pose.x, pose.z, pose.rotDeg].every(Number.isFinite)) throw new Error("pose must be finite");
  const floor = ensureCCW(annotation.floor);
  const obstacles = resolveActiveObstacles(annotation, scenario);
  const R = rectCorners(pose.x, pose.z, W, D, pose.rotDeg);
  const rotRad = (pose.rotDeg * Math.PI) / 180;
  const outsideFloor = !rectInsidePolygon(R, floor);
  const overlapping: string[] = [];
  for (const o of obstacles) {
    const hit = o.shape.kind === "circle"
      ? rectToCircleDistance({ x: pose.x, z: pose.z, w: W, d: D, rotRad }, o.shape) < -EPS
      : polygonsOverlap(R, o.shape.poly);
    if (hit) overlapping.push(o.id);
  }
  const valid = !outsideFloor && overlapping.length === 0;
  if (!valid) return { pose, valid, outsideFloor, overlappingObstacleIds: overlapping, clearanceM: null, limiterId: null, limiterPoint: null, artworkPoint: null };
  const m = minDistance(R, floor, obstacles, { x: pose.x, z: pose.z, w: W, d: D, rotRad });
  return { pose, valid, outsideFloor, overlappingObstacleIds: [], clearanceM: m.d, limiterId: m.id, limiterPoint: m.limiterPoint, artworkPoint: m.artworkPoint };
}
