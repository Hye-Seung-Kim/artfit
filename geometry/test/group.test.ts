import { describe, expect, it } from "vitest";
import { evaluateGroup, polygonsOverlap, suggestGroupPlans, summarizeBudget, workBody, type GroupWork, type Obstacle, type Polygon, type SpatialAnnotation } from "../src/index.js";

const rect = (w: number, d: number, cx = 0, cz = 0): Polygon => [
  { x: cx - w / 2, z: cz - d / 2 }, { x: cx + w / 2, z: cz - d / 2 }, { x: cx + w / 2, z: cz + d / 2 }, { x: cx - w / 2, z: cz + d / 2 },
];
const obs = (id: string, category: Obstacle["category"], poly: Polygon): Obstacle => ({
  id, category, shape: { kind: "polygon", poly }, mobility: "permanent", evidenceIds: [], removalPermissionEvidenceIds: [], removalCompletionEvidenceIds: [], reviewNote: "",
});
function ann(floor: Polygon, obstacles: Obstacle[] = []): SpatialAnnotation {
  return {
    annotationId: "t", spaceId: "s", modelId: "m", floorId: "f", regionId: "r", coordinateSystem: "showcase_sdk_xz_m",
    floorElevationY: 0, floor, obstacles, ceilingHeightM: null, ceilingEvidenceIds: [], scaleCheck: null,
    obstacleCoverage: "partial", coverageNotes: [], annotationVerified: false, annotationMethod: "manual_sdk_pointer_trace",
    annotatedBy: "test", reviewedBy: null, reviewedAt: null, version: 1, annotatedAt: "2026-11-13", scanCapturedAt: null,
  } as SpatialAnnotation;
}
const work = (id: string, artist: string, w: number, d: number, c = 1, extra: Partial<GroupWork> = {}): GroupWork =>
  ({ id, artist, title: id, widthM: w, depthM: d, heightM: 2, clearanceM: c, required: true, locked: false, pose: null, ...extra });

// 14 × 10 m room with the entrance on the south wall.
const room = ann(rect(14, 10), [obs("door", "entrance_zone", rect(1.2, 0.8, 0, 4.6))]);

describe("group evaluation", () => {
  it("flags two works whose bodies overlap", () => {
    const ws = [work("a", "Minji", 2, 2), work("b", "Jun", 2, 2)];
    const e = evaluateGroup(room, ws, { a: { x: -3, z: 0, rotDeg: 0 }, b: { x: -2, z: 0, rotDeg: 0 } });
    expect(e.ok).toBe(false);
    expect(e.works.find((w) => w.workId === "a")!.overlaps).toContain("work:b");
  });

  it("viewing space can be shared, but another work's body may not sit inside a work's clearance", () => {
    const ws = [work("a", "Minji", 2, 2, 1.5), work("b", "Jun", 2, 2, 1.5)];
    const near = evaluateGroup(room, ws, { a: { x: -3, z: 0, rotDeg: 0 }, b: { x: 0, z: 0, rotDeg: 0 } }); // 1.0 m apart
    expect(near.works.find((w) => w.workId === "a")!.meetsClearance).toBe(false);
    const apart = evaluateGroup(room, ws, { a: { x: -3, z: 0, rotDeg: 0 }, b: { x: 0.6, z: 0, rotDeg: 0 } }); // 1.6 m apart
    expect(apart.works.every((w) => w.meetsClearance)).toBe(true);
  });

  it("a required work without a place is reported, never dropped silently", () => {
    const ws = [work("a", "Minji", 2, 2), work("b", "Jun", 2, 2)];
    const e = evaluateGroup(room, ws, { a: { x: -3, z: 0, rotDeg: 0 }, b: null });
    expect(e.requiredMissing).toEqual(["b"]);
    expect(e.ok).toBe(false);
  });

  it("route starts at the entrance and visits works in the requested order", () => {
    const ws = [work("a", "Minji", 1, 1), work("b", "Jun", 1, 1), work("c", "Sora", 1, 1)];
    const poses = { a: { x: -4, z: 0, rotDeg: 0 }, b: { x: 0, z: -2, rotDeg: 0 }, c: { x: 4, z: 0, rotDeg: 0 } };
    const e = evaluateGroup(room, ws, poses, ["c", "a", "b"]);
    expect(e.route.order).toEqual(["c", "a", "b"]);
    expect(e.route.lengthM).toBeGreaterThan(0);
    expect(e.works.every((w) => w.reachable)).toBe(true);
  });

  it("without a set order, visits works in the shortest walk from the entrance (no out-and-back)", () => {
    // Entrance on the south wall at x=0; works far right, near, and middle.
    const ws = [work("far", "A", 1, 1), work("near", "B", 1, 1), work("mid", "C", 1, 1)];
    const poses = { far: { x: 5, z: 0, rotDeg: 0 }, near: { x: -1, z: 1, rotDeg: 0 }, mid: { x: 2, z: 0, rotDeg: 0 } };
    const suggested = evaluateGroup(room, ws, poses);
    const forced = evaluateGroup(room, ws, poses, ["far", "near", "mid"]);
    expect(suggested.route.order).not.toEqual(["far", "near", "mid"]);
    expect(suggested.route.lengthM!).toBeLessThan(forced.route.lengthM!);
    expect(forced.route.order).toEqual(["far", "near", "mid"]); // a user order is followed as given
  });

  it("a work walled in by others is unreachable", () => {
    // A tiny pocket: floor 4 × 4 with work x blocking the only gap to work y's viewing spots.
    const pocket = ann([{ x: -2, z: -2 }, { x: 2, z: -2 }, { x: 2, z: 2 }, { x: -2, z: 2 }], [obs("door", "entrance_zone", rect(0.8, 0.4, 0, 1.8))]);
    const ws = [work("x", "A", 4, 0.6, 0.1), work("y", "B", 0.6, 0.6, 0.1)];
    const e = evaluateGroup(pocket, ws, { x: { x: 0, z: 0, rotDeg: 0 }, y: { x: 0, z: -1.6, rotDeg: 0 } });
    expect(e.works.find((w) => w.workId === "y")!.reachable).toBe(false);
  });

  it("without a traced entrance the route is not invented", () => {
    const e = evaluateGroup(ann(rect(10, 10)), [work("a", "Minji", 1, 1)], { a: { x: 0, z: 0, rotDeg: 0 } });
    expect(e.route.lengthM).toBeNull();
    expect(e.route.note).toMatch(/No entrance/);
    expect(e.works[0].reachable).toBeNull();
  });
});

describe("suggested plans", () => {
  const ws = () => [work("a", "Minji", 2, 1.5, 1.2), work("b", "Jun", 1.5, 1.5, 1), work("c", "Sora", 3, 1, 1.2), work("d", "Sora", 1, 1, 0.8, { required: false })];

  it("places every required work without overlaps, keeps sizes, and respects clearances", () => {
    const plans = suggestGroupPlans(room, ws(), { restarts: 6 });
    expect(plans.length).toBeGreaterThan(0);
    for (const p of plans) {
      expect(p.metrics.requiredPlaced).toBe(p.metrics.requiredTotal);
      const placed = ws().filter((w) => p.poses[w.id]);
      for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
        expect(polygonsOverlap(workBody(placed[i], p.poses[placed[i].id]!), workBody(placed[j], p.poses[placed[j].id]!))).toBe(false);
      }
      expect(p.evaluation.works.filter((c) => c.placed).every((c) => c.meetsClearance)).toBe(true);
    }
  });

  it("locked works keep their exact pose", () => {
    const list = ws();
    list[0] = { ...list[0], locked: true, pose: { x: -4.5, z: -2.5, rotDeg: 90 } };
    for (const p of suggestGroupPlans(room, list, { restarts: 4 })) expect(p.poses.a).toEqual({ x: -4.5, z: -2.5, rotDeg: 90 });
  });

  it("a room too small for a required work says so instead of shrinking it", () => {
    const tiny = ann(rect(4, 4), [obs("door", "entrance_zone", rect(0.8, 0.4, 0, 1.8))]);
    const plans = suggestGroupPlans(tiny, [work("big", "Minji", 5, 1, 0.5)], { restarts: 2 });
    for (const p of plans) {
      expect(p.poses.big).toBeNull();
      expect(p.evaluation.requiredMissing).toEqual(["big"]);
    }
  });
});

describe("budget", () => {
  it("unknown costs are never zero and quoted/estimated stay apart", () => {
    const s = summarizeBudget([
      { id: "v", label: "Venue (short-term)", workId: null, amount: null, currency: "USD", status: "unknown" },
      { id: "t", label: "Transport A", workId: "a", amount: 800, currency: "USD", status: "quoted" },
      { id: "p", label: "Plinth rental", workId: null, amount: 300, currency: "USD", status: "estimate" },
    ], { amount: 5000, currency: "USD" });
    expect(s.quoted).toBe(800);
    expect(s.estimated).toBe(300);
    expect(s.unknown).toEqual(["Venue (short-term)"]);
    expect(s.status).toBe("unknown");
  });

  it("quoted costs over budget are flagged even with unknowns; all-quoted within budget passes", () => {
    expect(summarizeBudget([{ id: "x", label: "Venue", workId: null, amount: 9000, currency: "USD", status: "quoted" }, { id: "y", label: "Lights", workId: null, amount: null, currency: "USD", status: "unknown" }], { amount: 5000, currency: "USD" }).status).toBe("over_quoted");
    expect(summarizeBudget([{ id: "x", label: "Venue", workId: null, amount: 3000, currency: "USD", status: "quoted" }], { amount: 5000, currency: "USD" }).status).toBe("within_quoted");
  });

  it("different currencies are not added together", () => {
    const s = summarizeBudget([{ id: "x", label: "Venue", workId: null, amount: 3000, currency: "EUR", status: "quoted" }], { amount: 5000, currency: "USD" });
    expect(s.status).toBe("unknown");
    expect(s.mixedCurrency).toBe(true);
  });
});
