import { describe, expect, it } from "vitest";
import {
  AS_SCANNED, EditError, applyOps, checkPose, commit, createHistory, directionVector, placementScope, rectCorners, redo,
  resetToInitial, scan, undo, verticalCheck, viewRightFromYaw,
  type ArtworkEditState, type Obstacle, type Polygon, type SpatialAnnotation,
} from "../src/index.js";

const rect = (w: number, d: number, cx = 0, cz = 0): Polygon => [
  { x: cx - w / 2, z: cz - d / 2 }, { x: cx + w / 2, z: cz - d / 2 }, { x: cx + w / 2, z: cz + d / 2 }, { x: cx - w / 2, z: cz + d / 2 },
];
const base: ArtworkEditState = {
  artworkId: "art-1", spaceId: "s1", mode: "auto_best", pose: null, widthM: 4, depthM: 3, heightM: 2.4,
  baseElevationM: 0, color: "default", material: "matte", version: 1,
};
const ctx = { displayedPose: { x: 1, z: 2, rotDeg: 0 }, viewRight: { x: 1, z: 0 }, viewLabel: "3D planning view", localCeilingM: null as number | null };
const m = (value: number, unit: "m" | "cm" | "ft" = "m") => ({ value, unit });

describe("view-relative directions", () => {
  it("yaw 0 (looking down −Z): right = +X, forward = −Z", () => {
    const r = viewRightFromYaw(0);
    expect(r.x).toBeCloseTo(1); expect(r.z).toBeCloseTo(0);
    const f = directionVector("forward", r);
    expect(f.x).toBeCloseTo(0); expect(f.z).toBeCloseTo(-1);
  });
  it("camera turned 90° left (yaw +90°): screen-left is world +Z, not a fixed world axis", () => {
    const l = directionVector("left", viewRightFromYaw(Math.PI / 2));
    expect(l.x).toBeCloseTo(0); expect(l.z).toBeCloseTo(1);
  });
});

describe("applyOps", () => {
  it("'left 30 cm' moves the displayed pose 0.30 m along the view's left and switches to a user pose", () => {
    const r = applyOps(base, [{ op: "move", direction: "left", distance: m(30, "cm") }], ctx);
    expect(r.state.mode).toBe("user_pose");
    expect(r.state.pose).toEqual({ x: 0.7, z: 2, rotDeg: 0 });
    expect(r.reevaluate).toBe("pose");
  });
  it("'width −10%' changes width only", () => {
    const r = applyOps(base, [{ op: "scale_dimension", dimension: "width", percent: -10 }], ctx);
    expect(r.state.widthM).toBeCloseTo(3.6);
    expect(r.state.depthM).toBe(3); expect(r.state.heightM).toBe(2.4);
  });
  it("'height only 2.5 m' keeps width/depth and needs no re-search", () => {
    const r = applyOps(base, [{ op: "set_dimension", dimension: "height", value: m(2.5) }], ctx);
    expect([r.state.widthM, r.state.depthM, r.state.heightM]).toEqual([4, 3, 2.5]);
    expect(r.reevaluate).toBe("none");
  });
  it("'1 m off the floor' raises only the artwork bottom; pose/footprint unchanged, no re-search", () => {
    const placed = applyOps(base, [{ op: "move", direction: "right", distance: m(0.1) }], ctx).state;
    const r = applyOps(placed, [{ op: "set_elevation", value: m(1) }], ctx);
    expect(r.state.baseElevationM).toBe(1);
    expect(r.state.pose).toEqual(placed.pose);
    expect(r.reevaluate).toBe("none");
  });
  it("ceiling gap with a reviewed local ceiling: top gap equals request", () => {
    const r = applyOps(base, [{ op: "set_ceiling_gap", value: m(50, "cm") }], { ...ctx, localCeilingM: 4 });
    const v = verticalCheck(r.state, 4);
    expect(r.state.baseElevationM).toBeCloseTo(1.1);
    expect(v.gapM).toBeCloseTo(0.5);
    expect(v.result).toBe("pass");
  });
  it("ceiling gap without a reviewed local ceiling is not calculated (asks for a floor height)", () => {
    try { applyOps(base, [{ op: "set_ceiling_gap", value: m(0.5) }], ctx); throw new Error("should throw"); }
    catch (e) { expect(e).toBeInstanceOf(EditError); expect((e as EditError).needsInfo).toBe(true); }
  });
  it("bottom below the floor is rejected (elevation or ceiling gap)", () => {
    expect(() => applyOps(base, [{ op: "set_elevation", value: m(-0.2) }], ctx)).toThrow(EditError);
    expect(() => applyOps(base, [{ op: "set_ceiling_gap", value: m(2) }], { ...ctx, localCeilingM: 4 })).toThrow(/below the floor/);
  });
  it("rejects negative, zero, NaN and infinite dimensions", () => {
    for (const v of [-1, 0, NaN, Infinity]) expect(() => applyOps(base, [{ op: "set_dimension", dimension: "width", value: m(v) }], ctx)).toThrow(EditError);
    expect(() => applyOps(base, [{ op: "scale_dimension", dimension: "depth", percent: -100 }], ctx)).toThrow(EditError);
  });
  it("color-only change needs no placement check or search", () => {
    const r = applyOps(base, [{ op: "set_finish", color: "white", material: "matte" }], ctx);
    expect(r.reevaluate).toBe("none");
    expect(r.state.color).toBe("white");
    expect([r.state.widthM, r.state.depthM, r.state.pose]).toEqual([4, 3, null]);
  });
  it("'turn right 15°' = clockwise seen from above = +15° rotDeg (rectCorners convention)", () => {
    const r = applyOps(base, [{ op: "rotate", degrees: 15, rotation: "clockwise" }], ctx);
    expect(r.state.pose!.rotDeg).toBe(15);
    const c = rectCorners(0, 0, 2, 0.0001, 90); // +90 sends local +x to +z (down the page) = clockwise from above
    expect(c[1].z).toBeGreaterThan(0.99);
  });
  it("feet convert in code", () => {
    const r = applyOps(base, [{ op: "set_dimension", dimension: "width", value: m(10, "ft") }], ctx);
    expect(r.state.widthM).toBeCloseTo(3.048);
  });
  it("move without a known view direction fails instead of guessing a world axis", () => {
    expect(() => applyOps(base, [{ op: "move", direction: "left", distance: m(1) }], { ...ctx, viewRight: null })).toThrow(/view direction/);
  });
});

describe("history", () => {
  it("compound request undoes as one unit; undo/redo/reset restore states and always issue new versions", () => {
    let h = createHistory(base);
    const r = applyOps(h.present.state, [{ op: "move", direction: "left", distance: m(0.3) }, { op: "rotate", degrees: 15, rotation: "clockwise" }], ctx);
    h = commit(h, r.state, r.changes.join("; "), "claude");
    const v1 = h.present.state.version;
    h = undo(h);
    expect(h.present.state.mode).toBe("auto_best");
    expect(h.present.state.version).toBeGreaterThan(v1); // a late response based on v1 can no longer apply
    h = redo(h);
    expect(h.present.state.pose).toEqual({ x: 0.7, z: 2, rotDeg: 15 });
    h = resetToInitial(h);
    expect(h.present.state.pose).toBeNull();
    h = undo(h); // reset is undoable
    expect(h.present.state.pose).toEqual({ x: 0.7, z: 2, rotDeg: 15 });
  });
  it("slider drags with the same coalesce key form one entry", () => {
    let h = createHistory(base);
    h = commit(h, { ...h.present.state, widthM: 4.1 }, "w", "manual", "slider:width");
    h = commit(h, { ...h.present.state, widthM: 4.2 }, "w", "manual", "slider:width");
    expect(h.past.length).toBe(1);
    expect(undo(h).present.state.widthM).toBe(4);
  });
});

function ann(floor: Polygon, obstacles: Obstacle[] = []): SpatialAnnotation {
  return {
    annotationId: "t", spaceId: "s1", modelId: "m", floorId: "f", regionId: "r", coordinateSystem: "showcase_sdk_xz_m",
    floorElevationY: 0, floor, obstacles, ceilingHeightM: null, ceilingEvidenceIds: [], scaleCheck: null,
    obstacleCoverage: "partial", coverageNotes: [], annotationVerified: false, annotationMethod: "manual_sdk_pointer_trace",
    annotatedBy: "t", reviewedBy: null, reviewedAt: null, version: 1, annotatedAt: "2026-11-14", scanCapturedAt: null,
  };
}

describe("checkPose (user-placed artwork)", () => {
  const desk: Obstacle = { id: "desk", category: "movable_furniture", shape: { kind: "polygon", poly: rect(1, 1, 3, 0) }, mobility: "reviewed_movable", evidenceIds: [], removalPermissionEvidenceIds: [], removalCompletionEvidenceIds: [], reviewNote: "" };
  const a = ann(rect(10, 8), [desk]);
  it("evaluates exactly the given pose, never substitutes the best sampled pose", () => {
    const best = scan({ annotation: a, scenario: AS_SCANNED, artwork: { widthM: 2, depthM: 1 } }).bestPose!;
    const user = { x: -3, z: -2, rotDeg: 0 };
    const c = checkPose(a, AS_SCANNED, { widthM: 2, depthM: 1 }, user);
    expect(c.pose).toEqual(user);
    expect(c.valid).toBe(true);
    expect(c.clearanceM).toBeCloseTo(1.0, 6); // limited by the floor edge at x = −5
    expect(best.x === user.x && best.z === user.z).toBe(false);
  });
  it("a colliding position is reported as a conflict with the obstacle id", () => {
    const c = checkPose(a, AS_SCANNED, { widthM: 2, depthM: 1 }, { x: 3, z: 0, rotDeg: 0 });
    expect(c.valid).toBe(false);
    expect(c.overlappingObstacleIds).toEqual(["desk"]);
    expect(c.clearanceM).toBeNull();
  });
  it("outside the floor is reported, not clamped", () => {
    expect(checkPose(a, AS_SCANNED, { widthM: 2, depthM: 1 }, { x: 4.8, z: 0, rotDeg: 0 }).outsideFloor).toBe(true);
  });
  it("elevated artwork does not inherit the floor-standing scope; lifting does not clear the projection conflict", () => {
    expect(placementScope(1).kind).toBe("elevated_preview");
    expect(placementScope(0).kind).toBe("floor_standing");
    // the plan check ignores elevation: same conflict whether or not the artwork is lifted
    expect(checkPose(a, AS_SCANNED, { widthM: 2, depthM: 1 }, { x: 3, z: 0, rotDeg: 0 }).valid).toBe(false);
  });
});
