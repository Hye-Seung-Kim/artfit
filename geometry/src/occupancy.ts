// Occupancy PLANNING ESTIMATE for a traced space with the works placed. Not a legal occupant load: that is set by
// the fire marshal / building official under the locally adopted code (Houston: amended IBC; Los Angeles: CBC).
// Factors follow the IBC model code as a reference:
//   - Exhibit gallery and museum: 30 sq ft net per occupant (IBC Table 1004.5)
//   - Assembly, standing space (e.g. an opening night): 5 sq ft net per occupant
//   - Egress width, other egress components: 0.2 in per occupant without sprinklers (IBC 1005.3.2)
//   - Assembly spaces above 49 occupants generally need at least two exits (IBC Table 1006.2.1)
import { area, ensureCCW, pointInPolygon, rectCorners, roundedRect, edges } from "./poly.js";
import { obstaclePolygon } from "./engine.js";
import type { Polygon, Pose, SpatialAnnotation } from "./types.js";

export const SQM_PER_PERSON_GALLERY = 30 * 0.09290304;   // 2.787 m²
export const SQM_PER_PERSON_STANDING = 5 * 0.09290304;   // 0.465 m²
export const EGRESS_M_PER_PERSON = 0.2 * 0.0254;         // 5.08 mm of door width
export const SQM_PER_VIEWER = 1.0;                       // comfortable spacing in front of a work
export const TWO_EXIT_THRESHOLD = 49;

export interface OccupancyWork { id: string; title: string; widthM: number; depthM: number; clearanceM: number; pose: Pose }

export interface OccupancyEstimate {
  floorM2: number; fixedM2: number; worksM2: number; netM2: number;
  byArea: { gallery: number; standing: number };
  doors: { id: string; label: string; widthM: number; people: number }[];
  byDoors: number | null;             // if every traced doorway were an exit
  estimate: { gallery: number; standing: number; limitedBy: { gallery: "area" | "doors"; standing: "area" | "doors" } };
  twoExits: { gallery: boolean; standing: boolean; tracedDoorways: number };
  perWork: { id: string; title: string; viewingM2: number; atOnce: number }[];
}

/** Door width: "… 0.88 m wide" in the traced label, else the longest edge of the traced zone. */
export function doorWidth(label: string | undefined, poly: Polygon): number {
  const m = label?.match(/([\d.]+)\s*m\s*wide/i);
  if (m && Number(m[1]) > 0) return Number(m[1]);
  return Math.max(...edges(poly).map(([a, b]) => Math.hypot(b.x - a.x, b.z - a.z)));
}

export function estimateOccupancy(ann: SpatialAnnotation, works: OccupancyWork[]): OccupancyEstimate {
  const floor = ensureCCW(ann.floor);
  const floorM2 = area(floor);
  const fixed = ann.obstacles.filter((o) => o.category !== "entrance_zone").map(obstaclePolygon);
  const fixedM2 = fixed.reduce((t, p) => t + area(p), 0);
  const bodies = works.map((w) => rectCorners(w.pose.x, w.pose.z, w.widthM, w.depthM, w.pose.rotDeg));
  const worksM2 = works.reduce((t, w) => t + w.widthM * w.depthM, 0);
  const netM2 = Math.max(0, floorM2 - fixedM2 - worksM2);
  const byArea = { gallery: Math.floor(netM2 / SQM_PER_PERSON_GALLERY), standing: Math.floor(netM2 / SQM_PER_PERSON_STANDING) };

  const doors = ann.obstacles.filter((o) => o.category === "entrance_zone").map((o) => {
    const widthM = doorWidth(o.label, obstaclePolygon(o));
    return { id: o.id, label: o.label ?? o.id, widthM, people: Math.floor(widthM / EGRESS_M_PER_PERSON) };
  });
  const byDoors = doors.length ? doors.reduce((t, d) => t + d.people, 0) : null;
  const lim = (n: number) => (byDoors != null && byDoors < n ? { n: byDoors, by: "doors" as const } : { n, by: "area" as const });
  const g = lim(byArea.gallery), s = lim(byArea.standing);

  // Viewers at once: open floor inside each work's viewing room (0.25 m samples), outside every body and fixed object.
  const step = 0.25, cell = step * step;
  const perWork = works.map((w) => {
    const room = roundedRect(w.pose.x, w.pose.z, w.widthM, w.depthM, w.pose.rotDeg, w.clearanceM, 6);
    const xs = room.map((p) => p.x), zs = room.map((p) => p.z);
    let n = 0;
    for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step) for (let z = Math.min(...zs) + step / 2; z < Math.max(...zs); z += step) {
      const p = { x, z };
      if (pointInPolygon(p, room) < 0 || pointInPolygon(p, floor) <= 0) continue;
      if (bodies.some((b) => pointInPolygon(p, b) >= 0)) continue;
      if (fixed.some((f) => pointInPolygon(p, f) >= 0)) continue;
      n++;
    }
    const viewingM2 = n * cell;
    return { id: w.id, title: w.title, viewingM2, atOnce: Math.floor(viewingM2 / SQM_PER_VIEWER) };
  });

  return {
    floorM2, fixedM2, worksM2, netM2, byArea, doors, byDoors,
    estimate: { gallery: g.n, standing: s.n, limitedBy: { gallery: g.by, standing: s.by } },
    twoExits: { gallery: g.n > TWO_EXIT_THRESHOLD, standing: s.n > TWO_EXIT_THRESHOLD, tracedDoorways: doors.length },
    perWork,
  };
}
