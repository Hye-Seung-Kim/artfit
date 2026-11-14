import { describe, expect, it } from "vitest";
import {
  AS_SCANNED, EPS, ScanCache, ScenarioError, circleFrom3, displayM, evaluate, passes, polygonsOverlap, proposeClearance,
  rectCorners, rectInsidePolygon, rectToCircleDistance, requiredAreaM2, resolveActiveObstacles, scan, minDistance,
  type Obstacle, type PlacementScenario, type Polygon, type SpatialAnnotation,
} from "../src/index.js";

const rect = (w: number, d: number, cx = 0, cz = 0): Polygon => [
  { x: cx - w / 2, z: cz - d / 2 }, { x: cx + w / 2, z: cz - d / 2 }, { x: cx + w / 2, z: cz + d / 2 }, { x: cx - w / 2, z: cz + d / 2 },
];
const art = { x: 0, z: 0, w: 4, d: 3 };
const circ = (x: number, z: number, r = 0.3) => ({ c: { x, z }, r });

function ann(floor: Polygon, obstacles: Obstacle[] = []): SpatialAnnotation {
  return {
    annotationId: "t", spaceId: "s", modelId: "m", floorId: "f", regionId: "r", coordinateSystem: "showcase_sdk_xz_m",
    floorElevationY: 0, floor, obstacles, ceilingHeightM: null, ceilingEvidenceIds: [], scaleCheck: null,
    obstacleCoverage: "partial", coverageNotes: [], annotationVerified: false, annotationMethod: "manual_sdk_pointer_trace",
    annotatedBy: "test", reviewedBy: null, reviewedAt: null, version: 1, annotatedAt: "2026-11-13", scanCapturedAt: null,
  };
}
const obs = (id: string, category: Obstacle["category"], shape: Obstacle["shape"], mobility: Obstacle["mobility"] = "permanent"): Obstacle => ({
  id, category, shape, mobility, evidenceIds: [], removalPermissionEvidenceIds: [], removalCompletionEvidenceIds: [], reviewNote: "",
});
const ctx = (a: SpatialAnnotation, H = 2) => ({
  matchVerified: true, annotation: a, scenario: AS_SCANNED, artworkHeightM: H, evidenceVersion: 1,
  conditionEligibility: "needs_verification" as const, evidenceIds: [],
});

describe("§11.1 circle column (analytic)", () => {
  it("c=(3.5,0) rot 0 → 1.2, passes 1.2 within EPS", () => {
    const d = rectToCircleDistance({ ...art, rotRad: 0 }, circ(3.5, 0));
    expect(d).toBeCloseTo(1.2, 9);
    expect(passes(d, 1.2)).toBe(true);
  });
  it("rot 90 → 1.7", () => expect(rectToCircleDistance({ ...art, rotRad: Math.PI / 2 }, circ(3.5, 0))).toBeCloseTo(1.7, 9));
  it("rot 45 → ≈0.78438179", () => expect(rectToCircleDistance({ ...art, rotRad: Math.PI / 4 }, circ(3.5, 0))).toBeCloseTo(0.78438179, 7));
  it("c=(1,0) overlaps", () => expect(rectToCircleDistance({ ...art, rotRad: 0 }, circ(1, 0))).toBeLessThan(-EPS));
  it("tangent c=(2.3,0): clearance 0, passes C=0 only", () => {
    const d = rectToCircleDistance({ ...art, rotRad: 0 }, circ(2.3, 0));
    expect(Math.abs(d)).toBeLessThan(1e-12);
    expect(passes(Math.max(0, d), 0)).toBe(true);
    expect(passes(Math.max(0, d), 1.2)).toBe(false);
  });
  it("tangent circle in a scan is a valid pose with zero clearance", () => {
    const a = ann(rect(20, 20), [obs("c1", "column", { kind: "circle", ...circ(2.3, 0) })]);
    const R = rectCorners(0, 0, 4, 3, 0);
    const m = minDistance(R, a.floor, a.obstacles, { ...art, rotRad: 0 });
    expect(m.d).toBeLessThan(1e-9);
    expect(m.id).toBe("c1");
  });
});

describe("§11.1 room clearance", () => {
  it("6 × 4.2 room centered → 0.6", () => {
    const R = rectCorners(0, 0, 4, 3, 0);
    expect(minDistance(R, rect(6, 4.2), [], { ...art, rotRad: 0 }).d).toBeCloseTo(0.6, 9);
  });
  it("8 × 6 room centered → 1.5", () => {
    const R = rectCorners(0, 0, 4, 3, 0);
    expect(minDistance(R, rect(8, 6), [], { ...art, rotRad: 0 }).d).toBeCloseTo(1.5, 9);
  });
  it("8 × 6 room scan best clearance 1.5 at center", () => {
    const s = scan({ annotation: ann(rect(8, 6)), scenario: AS_SCANNED, artwork: { widthM: 4, depthM: 3 } });
    expect(s.bestSampledClearanceM).toBeCloseTo(1.5, 9);
    expect(s.bestPose!.x).toBeCloseTo(0, 9);
    expect(s.bestPose!.z).toBeCloseTo(0, 9);
  });
});

describe("§11.1 polygon collisions", () => {
  const R = rect(4, 3);
  it("square column fully inside artwork → overlap", () => expect(polygonsOverlap(R, rect(0.4, 0.4))).toBe(true));
  it("identical/coincident polygon → overlap", () => expect(polygonsOverlap(R, rect(4, 3))).toBe(true));
  it("boundary-only touch → no overlap, zero clearance, positive C fails", () => {
    const touching = rect(1, 1, 2.5, 0); // shares edge x=2
    expect(polygonsOverlap(R, touching)).toBe(false);
    const a = ann(rect(20, 20), [obs("box", "fixed_fixture", { kind: "polygon", poly: touching })]);
    const m = minDistance(R, a.floor, a.obstacles, { ...art, rotRad: 0 });
    expect(m.d).toBeLessThan(1e-9);
    expect(passes(m.d, 0)).toBe(true);
    expect(passes(m.d, 0.1)).toBe(false);
  });
  it("proper edge crossing → overlap", () => expect(polygonsOverlap(R, rect(1, 1, 2, 0))).toBe(true));
  it("vertex touch only → no overlap", () => expect(polygonsOverlap(R, [{ x: 2, z: 1.5 }, { x: 3, z: 1.5 }, { x: 3, z: 2.5 }])).toBe(false));
});

describe("§11.1 containment", () => {
  it("artwork outside room is invalid", () => expect(rectInsidePolygon(rectCorners(20, 0, 4, 3, 0), rect(8, 6))).toBe(false));
  const L: Polygon = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 4 }, { x: 4, z: 4 }, { x: 4, z: 10 }, { x: 0, z: 10 }];
  it("rectangle inside the L arm is valid", () => expect(rectInsidePolygon(rectCorners(2, 5, 3, 3, 0), L)).toBe(true));
  it("rectangle whose corners are inside but an edge crosses the notch is invalid", () => {
    // corners (1,3),(7,3),(7,... ) — choose rectangle with corners in both arms but spanning notch
    const R: Polygon = [{ x: 3, z: 3 }, { x: 5, z: 3 }, { x: 5, z: 5 }, { x: 3, z: 5 }];
    expect(rectInsidePolygon(R, L)).toBe(false);
  });
  it("notch degeneracy: edge collinear with notch boundary then leaving", () => {
    const R: Polygon = [{ x: 2, z: 2 }, { x: 4, z: 2 }, { x: 4, z: 6 }, { x: 2, z: 6 }]; // right edge on x=4 from z=2..6 (inside at z<4 is interior)
    expect(rectInsidePolygon(R, L)).toBe(true);
    const R2: Polygon = [{ x: 3, z: 3.5 }, { x: 6, z: 3.5 }, { x: 6, z: 4 }, { x: 3, z: 4 }]; // top edge on z=4 crossing reflex vertex (4,4)
    expect(rectInsidePolygon(R2, L)).toBe(true);
    const R3: Polygon = [{ x: 3, z: 3.5 }, { x: 6, z: 3.5 }, { x: 6, z: 4.5 }, { x: 3, z: 4.5 }]; // pokes into notch
    expect(rectInsidePolygon(R3, L)).toBe(false);
  });
  it("concave floor where only a reflex vertex enters the rectangle → invalid", () => {
    const notch: Polygon = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 5, z: 5 }, { x: 0, z: 10 }];
    expect(rectInsidePolygon(rectCorners(5, 6, 2, 2, 0), notch)).toBe(false);
  });
});

describe("§11.1 scenario & entrance", () => {
  const entrance = obs("door", "entrance_zone", { kind: "polygon", poly: rect(1, 1, 0, 0) });
  const desk = obs("desk", "movable_furniture", { kind: "polygon", poly: rect(1, 1, 0, 0) }, "reviewed_movable");
  it("entrance zone overlap invalid in every scenario; cannot be removed", () => {
    const a = ann(rect(8, 6), [entrance]);
    const s = scan({ annotation: a, scenario: AS_SCANNED, artwork: { widthM: 4, depthM: 3 } });
    expect(s.poses.some((p) => Math.abs(p.x) < 1e-9 && Math.abs(p.z) < 1e-9)).toBe(false);
    const bad: PlacementScenario = { id: "h", version: 1, mode: "hypothetical_furniture_removal", removedObstacleIds: ["door"], selectedBy: "user", assumptions: [] };
    expect(() => resolveActiveObstacles(a, bad)).toThrow(ScenarioError);
  });
  it("desk invalidates as-scanned; removed only in explicit hypothetical", () => {
    const a = ann(rect(8, 6), [desk]);
    expect(resolveActiveObstacles(a, AS_SCANNED)).toHaveLength(1);
    const h: PlacementScenario = { id: "h", version: 1, mode: "hypothetical_furniture_removal", removedObstacleIds: ["desk"], selectedBy: "user", assumptions: [] };
    expect(resolveActiveObstacles(a, h)).toHaveLength(0);
    expect(a.obstacles).toHaveLength(1); // source annotation unchanged
    const other: PlacementScenario = { ...h, removedObstacleIds: ["desk-from-B"] };
    expect(() => resolveActiveObstacles(a, other)).toThrow(ScenarioError);
  });
  it("uncertain objects cannot be removed", () => {
    const u = obs("u", "uncertain_object", { kind: "polygon", poly: rect(1, 1) }, "unknown");
    const h: PlacementScenario = { id: "h", version: 1, mode: "hypothetical_furniture_removal", removedObstacleIds: ["u"], selectedBy: "user", assumptions: [] };
    expect(() => resolveActiveObstacles(ann(rect(8, 6), [u]), h)).toThrow(ScenarioError);
  });
});

describe("§11.1 cache, monotonicity, display", () => {
  it("clearance-only change reuses scan; pass count recomputed", () => {
    const cache = new ScanCache();
    const a = ann(rect(8, 6));
    const s1 = cache.get({ annotation: a, scenario: AS_SCANNED, artwork: { widthM: 4, depthM: 3 } });
    const e1 = evaluate(s1, 1.0, ctx(a));
    const s2 = cache.get({ annotation: a, scenario: AS_SCANNED, artwork: { widthM: 4, depthM: 3 } });
    const e2 = evaluate(s2, 1.5, ctx(a));
    expect(s2).toBe(s1);
    expect(cache.hits).toBe(1);
    expect(e2.passCount).toBeLessThan(e1.passCount);
    expect(e2.passCount).toBeGreaterThan(0);
  });
  it("W increase rescans; validCount non-increasing", () => {
    const cache = new ScanCache();
    const a = ann(rect(8, 6), [obs("c", "column", { kind: "circle", ...circ(3, 2) })]);
    let prev = Infinity;
    for (const w of [2, 3, 4, 5]) {
      const s = cache.get({ annotation: a, scenario: AS_SCANNED, artwork: { widthM: w, depthM: 2 } });
      expect(s.validCount).toBeLessThanOrEqual(prev);
      prev = s.validCount;
    }
    expect(cache.misses).toBe(4);
  });
  it("raw 1.1999999 vs 1.2 passes, display 1.20; raw 0.96 vs 1.0 fails, display 0.95", () => {
    expect(passes(1.1999999999, 1.2)).toBe(true);
    expect(displayM(1.1999999999).toFixed(2)).toBe("1.20");
    expect(passes(0.96, 1.0)).toBe(false);
    expect(displayM(0.96).toFixed(2)).toBe("0.95");
  });
  it("no valid poses → bestPose null; attempt pose is separate", () => {
    const a = ann(rect(3, 3));
    const s = scan({ annotation: a, scenario: AS_SCANNED, artwork: { widthM: 4, depthM: 3 } });
    expect(s.bestPose).toBeNull();
    expect(s.attemptPose).not.toBeNull();
    const e = evaluate(s, 0, ctx(a));
    expect(e.status).toBe("conflict");
    expect(e.selectedPose).toBeNull();
    expect(e.displayAttemptPose).toEqual(s.attemptPose);
    expect(proposeClearance(s.bestSampledClearanceM, 1, 0.5).kind).toBe("unavailable");
  });
  it("area screen W=4 D=3 C=1.2 → 33.32389342", () => expect(requiredAreaM2(4, 3, 1.2)).toBeCloseTo(33.32389342, 7));
  it("four orientations: testedCount = positions × orientations", () => {
    const s = scan({ annotation: ann(rect(8, 6)), scenario: AS_SCANNED, artwork: { widthM: 2, depthM: 1 }, settings: { gridStepM: 0.5, rotationsDeg: [0, 45, 90, 135] } });
    expect(s.testedCount).toBe(s.sampledPositionCount * 4);
  });
  it("nearly collinear three circle points rejected", () => {
    const r = circleFrom3({ x: 0, z: 0 }, { x: 1, z: 0.001 }, { x: 2, z: 0 });
    expect("error" in r).toBe(true);
    const ok = circleFrom3({ x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 });
    expect("r" in ok && Math.abs(ok.r - 1) < 1e-9).toBe(true);
  });
});

describe("§11.4 clearance proposal", () => {
  it("missing minimum → needs_user_minimum", () => expect(proposeClearance(1.19, 1.2, null).kind).toBe("needs_user_minimum"));
  it("min 1.18, best 1.19, preferred 1.20 → 1.18 (not floored 1.15)", () => {
    const p = proposeClearance(1.19, 1.2, 1.18);
    expect(p).toEqual({ kind: "proposal", proposedC: 1.18 });
  });
  it("best below minimum → unavailable", () => expect(proposeClearance(0.9, 1.2, 1.0).kind).toBe("unavailable"));
  it("best 1.07, min 0.8, pref 1.5 → 1.05", () => expect(proposeClearance(1.07, 1.5, 0.8)).toEqual({ kind: "proposal", proposedC: 1.05 }));
});

describe("§11.3 height", () => {
  it("no local height → unknown; 3.81 local with H=4 fails", () => {
    const a = ann(rect(10, 10));
    const s = scan({ annotation: a, scenario: AS_SCANNED, artwork: { widthM: 4, depthM: 3 } });
    expect(evaluate(s, 1, ctx(a, 4)).heightCheck).toBe("unknown");
    const a2 = { ...a, ceilingHeightM: 3.81 };
    expect(evaluate(s, 1, ctx(a2, 4)).heightCheck).toBe("fail");
    expect(evaluate(s, 1, ctx(a2, 2.4)).heightCheck).toBe("pass");
  });
  it("unverified match → status unknown with exploratory result", () => {
    const a = ann(rect(10, 10));
    const s = scan({ annotation: a, scenario: AS_SCANNED, artwork: { widthM: 4, depthM: 3 } });
    const e = evaluate(s, 1, { ...ctx(a), matchVerified: false });
    expect(e.status).toBe("unknown");
    expect(e.exploratoryStatus).toBe("fit");
    expect(e.geometryVerification).toBe("Unknown");
  });
});
