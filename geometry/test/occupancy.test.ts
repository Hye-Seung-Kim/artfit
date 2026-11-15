import { describe, expect, it } from "vitest";
import { estimateOccupancy, type Obstacle, type Polygon, type SpatialAnnotation } from "../src/index.js";

const rect = (w: number, d: number, cx = 0, cz = 0): Polygon => [
  { x: cx - w / 2, z: cz - d / 2 }, { x: cx + w / 2, z: cz - d / 2 }, { x: cx + w / 2, z: cz + d / 2 }, { x: cx - w / 2, z: cz + d / 2 },
];
const obs = (id: string, category: Obstacle["category"], poly: Polygon, label?: string): Obstacle => ({
  id, label, category, shape: { kind: "polygon", poly }, mobility: "permanent", evidenceIds: [], removalPermissionEvidenceIds: [], removalCompletionEvidenceIds: [], reviewNote: "",
});
const ann = (obstacles: Obstacle[]): SpatialAnnotation => ({
  annotationId: "t", spaceId: "s", modelId: "m", floorId: "f", regionId: "r", coordinateSystem: "showcase_sdk_xz_m", floorElevationY: 0,
  floor: rect(10, 10), obstacles, ceilingHeightM: null, ceilingEvidenceIds: [], scaleCheck: null, obstacleCoverage: "partial", coverageNotes: [],
  annotationVerified: false, annotationMethod: "manual_sdk_pointer_trace", annotatedBy: "t", reviewedBy: null, reviewedAt: null, version: 1, annotatedAt: "2026-11-14", scanCapturedAt: null,
} as SpatialAnnotation);

describe("occupancy planning estimate", () => {
  const room = ann([obs("door", "entrance_zone", rect(1, 0.5, 0, 4.8), "Doorway 0.9 m wide"), obs("col", "column", rect(1, 1, 3, 3))]);
  const works = [{ id: "a", title: "A", widthM: 4, depthM: 3, clearanceM: 1.5, pose: { x: -2, z: -2, rotDeg: 0 } }];

  it("net area excludes fixed objects and works; gallery and standing factors differ", () => {
    const e = estimateOccupancy(room, works);
    expect(e.floorM2).toBeCloseTo(100);
    expect(e.netM2).toBeCloseTo(100 - 1 - 12);
    expect(e.byArea.gallery).toBe(Math.floor(87 / (30 * 0.09290304)));   // 31
    expect(e.byArea.standing).toBe(Math.floor(87 / (5 * 0.09290304)));   // 187
  });

  it("door width limits the estimate (0.2 in per person) and reads the traced label", () => {
    const e = estimateOccupancy(room, works);
    expect(e.doors[0].widthM).toBe(0.9);
    expect(e.byDoors).toBe(Math.floor(0.9 / (0.2 * 0.0254)));             // 177
    expect(e.estimate.standing).toBe(177);
    expect(e.estimate.limitedBy.standing).toBe("doors");
    expect(e.estimate.limitedBy.gallery).toBe("area");
  });

  it("flags two exits above 49 and counts viewers in each work's open viewing room", () => {
    const e = estimateOccupancy(room, works);
    expect(e.twoExits.standing).toBe(true);
    expect(e.twoExits.gallery).toBe(false);
    expect(e.perWork[0].atOnce).toBeGreaterThan(10);
    expect(e.perWork[0].atOnce).toBeLessThan(40);
  });

  it("no traced doorway → no door-based number is invented", () => {
    const e = estimateOccupancy(ann([]), works);
    expect(e.byDoors).toBeNull();
    expect(e.estimate.limitedBy.gallery).toBe("area");
  });
});
