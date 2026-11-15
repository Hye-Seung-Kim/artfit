// Group exhibition planning: several floor-standing works by several artists in ONE space.
// Pure functions shared by browser and tests. Calculation rules:
//  - Bodies never overlap each other, the floor boundary or any active blocker (entrance zones included).
//  - Viewing space may be shared: each work only needs its own clearance to the nearest wall, blocker or OTHER
//    work's body. Two clearance zones may overlap; a clearance zone may not contain another work.
//  - Real artwork dimensions are never changed here; required works are never dropped silently.
//  - Locked works keep their exact pose.
//  - The route is a walkable path on a 0.2 m grid from the entrance to a standing spot in front of each work
//    (in the chosen order) and back. It is a connectivity preview, not a crowd or code/safety check.
//  - Budget: unknown costs are never counted as zero; quoted and estimated amounts are kept apart.
import { checkPose, AS_SCANNED, EPS } from "./engine.js";
import { centroid, closestOnSegment, dist, edges, ensureCCW, pointInPolygon, polyPolyDist, polygonsOverlap, rectCorners, rectInsidePolygon } from "./poly.js";
import type { Obstacle, PlacementScenario, Polygon, Pose, SpatialAnnotation, Vec2 } from "./types.js";

export interface GroupWork {
  id: string;
  artist: string;
  title: string;
  widthM: number; depthM: number; heightM: number; // real dimensions, never changed by planning
  clearanceM: number;   // viewing room this work needs on every side
  required: boolean;    // must be in the show
  locked: boolean;      // pose is fixed by the user
  pose: Pose | null;    // null = not placed yet
}

export type CostStatus = "quoted" | "estimate" | "unknown";
export interface CostItem { id: string; label: string; workId: string | null; amount: number | null; currency: string; status: CostStatus }

export interface WorkCheck {
  workId: string;
  placed: boolean;
  valid: boolean;               // inside the floor and not overlapping anything
  outsideFloor: boolean;
  overlaps: string[];           // blocker ids and "work:<id>" for other works
  clearanceM: number | null;
  limiterId: string | null;
  meetsClearance: boolean;
  viewPoint: Vec2 | null;       // where a visitor stands to see it
  reachable: boolean | null;    // null when no route could be computed (e.g. no entrance traced)
}

export interface GroupRoute {
  entrance: Vec2 | null;
  order: string[];              // work ids in visiting order (placed + reachable)
  path: Vec2[];
  lengthM: number | null;
  unreachable: string[];
  note: string | null;
}

export interface GroupEvaluation {
  works: WorkCheck[];
  route: GroupRoute;
  requiredMissing: string[];    // required works without a pose
  conflicts: string[];          // human-readable problems
  ok: boolean;                  // every required work placed, valid, with its clearance, and reachable
}

export type PlanPriority = "room" | "route" | "moves";
export interface GroupPlan {
  priority: PlanPriority;
  label: string;
  poses: Record<string, Pose | null>;
  evaluation: GroupEvaluation;
  metrics: { placed: number; requiredPlaced: number; requiredTotal: number; minSlackM: number | null; routeM: number | null; moved: string[]; kept: string[]; notPlaced: string[] };
}

const PERSON_R = 0.25; // half shoulder width + margin for the walkable grid
const GRID = 0.2;

export const workId = (id: string) => `work:${id}`;

export function workBody(w: Pick<GroupWork, "widthM" | "depthM">, pose: Pose): Polygon {
  return rectCorners(pose.x, pose.z, w.widthM, w.depthM, pose.rotDeg);
}

function asObstacle(w: GroupWork, pose: Pose): Obstacle {
  return {
    id: workId(w.id), label: `${w.title} (${w.artist})`, category: "fixed_fixture",
    shape: { kind: "polygon", poly: workBody(w, pose) }, mobility: "permanent",
    evidenceIds: [], removalPermissionEvidenceIds: [], removalCompletionEvidenceIds: [], reviewNote: "another work in this group plan",
  };
}

/** Check one work where it is, with the other placed works treated as blockers. */
export function checkWorkInGroup(ann: SpatialAnnotation, works: GroupWork[], poses: Record<string, Pose | null>, id: string, scenario: PlacementScenario = AS_SCANNED) {
  const w = works.find((x) => x.id === id)!;
  const pose = poses[id];
  if (!pose) return null;
  const others = works.filter((o) => o.id !== id && poses[o.id]).map((o) => asObstacle(o, poses[o.id]!));
  return checkPose({ ...ann, obstacles: [...ann.obstacles, ...others] }, scenario, w, pose);
}

// ---------- walkable grid and route ----------

interface Grid { x0: number; z0: number; nx: number; nz: number; ok: Uint8Array }

function pointPolyDist(p: Vec2, poly: Polygon): number {
  if (pointInPolygon(p, poly) >= 0) return 0;
  let best = Infinity;
  for (const [a, b] of edges(poly)) best = Math.min(best, dist(p, closestOnSegment(p, a, b)));
  return best;
}

function blockerPolys(ann: SpatialAnnotation, bodies: Polygon[]): Polygon[] {
  const out: Polygon[] = [...bodies];
  for (const o of ann.obstacles) {
    if (o.category === "entrance_zone") continue; // visitors walk through entrances
    out.push(o.shape.kind === "polygon" ? o.shape.poly
      : Array.from({ length: 24 }, (_, i) => ({ x: o.shape.kind === "circle" ? o.shape.c.x + o.shape.r * Math.cos((i / 24) * 2 * Math.PI) : 0, z: o.shape.kind === "circle" ? o.shape.c.z + o.shape.r * Math.sin((i / 24) * 2 * Math.PI) : 0 })));
  }
  return out;
}

function buildGrid(ann: SpatialAnnotation, bodies: Polygon[]): Grid {
  const floor = ensureCCW(ann.floor);
  const xs = floor.map((p) => p.x), zs = floor.map((p) => p.z);
  const x0 = Math.min(...xs), z0 = Math.min(...zs);
  const nx = Math.max(1, Math.ceil((Math.max(...xs) - x0) / GRID)), nz = Math.max(1, Math.ceil((Math.max(...zs) - z0) / GRID));
  const ok = new Uint8Array(nx * nz);
  const blocks = blockerPolys(ann, bodies);
  const fEdges = edges(floor);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const p = { x: x0 + (i + 0.5) * GRID, z: z0 + (j + 0.5) * GRID };
    if (pointInPolygon(p, floor) <= 0) continue;
    let near = false;
    for (const [a, b] of fEdges) if (dist(p, closestOnSegment(p, a, b)) < PERSON_R) { near = true; break; }
    if (near) continue;
    for (const poly of blocks) if (pointPolyDist(p, poly) < PERSON_R) { near = true; break; }
    if (!near) ok[j * nx + i] = 1;
  }
  return { x0, z0, nx, nz, ok };
}

const cellOf = (g: Grid, p: Vec2) => ({ i: Math.floor((p.x - g.x0) / GRID), j: Math.floor((p.z - g.z0) / GRID) });
const centerOf = (g: Grid, i: number, j: number): Vec2 => ({ x: g.x0 + (i + 0.5) * GRID, z: g.z0 + (j + 0.5) * GRID });

/** Nearest walkable cell within maxM of p (breadth-first over rings). */
function snap(g: Grid, p: Vec2, maxM: number): number | null {
  const { i, j } = cellOf(g, p);
  const R = Math.ceil(maxM / GRID);
  let best: number | null = null, bestD = Infinity;
  for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
    const ii = i + di, jj = j + dj;
    if (ii < 0 || jj < 0 || ii >= g.nx || jj >= g.nz || !g.ok[jj * g.nx + ii]) continue;
    const d = dist(p, centerOf(g, ii, jj));
    if (d < bestD && d <= maxM) { bestD = d; best = jj * g.nx + ii; }
  }
  return best;
}

/** A* on the 8-connected grid; returns cell indices or null. */
function astar(g: Grid, s: number, t: number): number[] | null {
  if (s === t) return [s];
  const n = g.nx * g.nz;
  const gScore = new Float64Array(n).fill(Infinity), came = new Int32Array(n).fill(-1), closed = new Uint8Array(n);
  const h = (k: number) => Math.hypot((k % g.nx) - (t % g.nx), Math.floor(k / g.nx) - Math.floor(t / g.nx));
  const open: [number, number][] = [[h(s), s]];
  gScore[s] = 0;
  while (open.length) {
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (open[k][0] < open[bi][0]) bi = k;
    const [, cur] = open[bi];
    open[bi] = open[open.length - 1]; open.pop();
    if (closed[cur]) continue;
    if (cur === t) { const out = [cur]; let c = cur; while (came[c] >= 0) { c = came[c]; out.push(c); } return out.reverse(); }
    closed[cur] = 1;
    const ci = cur % g.nx, cj = Math.floor(cur / g.nx);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ii = ci + di, jj = cj + dj;
      if (ii < 0 || jj < 0 || ii >= g.nx || jj >= g.nz) continue;
      const k = jj * g.nx + ii;
      if (!g.ok[k] || closed[k]) continue;
      if (di && dj && (!g.ok[cj * g.nx + ii] || !g.ok[jj * g.nx + ci])) continue; // no corner cutting
      const ng = gScore[cur] + (di && dj ? Math.SQRT2 : 1);
      if (ng < gScore[k]) { gScore[k] = ng; came[k] = cur; open.push([ng + h(k), k]); }
    }
  }
  return null;
}

function simplify(points: Vec2[]): Vec2[] {
  if (points.length < 3) return points;
  const out = [points[0]];
  for (let k = 1; k < points.length - 1; k++) {
    const a = out[out.length - 1], b = points[k], c = points[k + 1];
    const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
    if (Math.abs(cross) > 1e-9) out.push(b);
  }
  out.push(points[points.length - 1]);
  return out;
}

/** String-pulling: drop grid corners wherever a straight line between kept points stays on walkable cells. */
function straighten(g: Grid, pts: Vec2[]): Vec2[] {
  if (pts.length < 3) return pts;
  const clear = (a: Vec2, b: Vec2) => {
    const n = Math.ceil(dist(a, b) / (GRID / 3));
    for (let k = 1; k < n; k++) {
      const p = { x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n };
      const { i, j } = cellOf(g, p);
      if (i < 0 || j < 0 || i >= g.nx || j >= g.nz || !g.ok[j * g.nx + i]) return false;
    }
    return true;
  };
  const out = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !clear(pts[i], pts[j])) j--;
    out.push(pts[j]);
    i = j;
  }
  return out;
}

/** Entrance used for the route: centre of the first traced entrance zone. */
export function entrancePoint(ann: SpatialAnnotation): Vec2 | null {
  const e = ann.obstacles.find((o) => o.category === "entrance_zone");
  if (!e) return null;
  return e.shape.kind === "polygon" ? centroid(e.shape.poly) : e.shape.c;
}

/** A spot to stand and look at the work: in front (local +z) first, then back, sides. */
function viewCandidates(w: GroupWork, pose: Pose): Vec2[] {
  const t = (pose.rotDeg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const v = Math.min(1.0, Math.max(0.6, w.clearanceM * 0.7));
  const local = [{ x: 0, z: w.depthM / 2 + v }, { x: 0, z: -(w.depthM / 2 + v) }, { x: w.widthM / 2 + v, z: 0 }, { x: -(w.widthM / 2 + v), z: 0 }];
  return local.map((p) => ({ x: pose.x + p.x * c - p.z * s, z: pose.z + p.x * s + p.z * c }));
}

export function computeRoute(ann: SpatialAnnotation, works: GroupWork[], poses: Record<string, Pose | null>, order?: string[]): { route: GroupRoute; viewPoints: Record<string, Vec2 | null> } {
  const placed = works.filter((w) => poses[w.id]);
  const bodies = placed.map((w) => workBody(w, poses[w.id]!));
  const g = buildGrid(ann, bodies);
  const viewPoints: Record<string, Vec2 | null> = {};
  const viewCells: Record<string, number | null> = {};
  for (const w of placed) {
    let cell: number | null = null, at: Vec2 | null = null;
    for (const p of viewCandidates(w, poses[w.id]!)) { const k = snap(g, p, 0.45); if (k != null) { cell = k; at = centerOf(g, k % g.nx, Math.floor(k / g.nx)); break; } }
    viewCells[w.id] = cell; viewPoints[w.id] = at;
  }
  const ent = entrancePoint(ann);
  const entCell = ent ? snap(g, ent, 1.5) : null;
  const ids = placed.map((w) => w.id);
  if (!ids.length) return { route: { entrance: ent, order: [], path: [], lengthM: null, unreachable: [], note: "Place works to see a route." }, viewPoints };
  if (entCell == null) {
    return { route: { entrance: ent, order: ids, path: [], lengthM: null, unreachable: [], note: ent ? "The entrance is not connected to open floor." : "No entrance is traced in this space, so a route can't start." }, viewPoints };
  }
  // Visiting order: the user's order first (if they set one); the rest in the order with the shortest WALK
  // (grid paths around walls and works, back to the entrance), exact for up to 7 open works.
  const seq = (order ?? []).filter((id) => ids.includes(id));
  const rest = ids.filter((id) => !seq.includes(id) && viewCells[id] != null);
  const legCache = new Map<string, { len: number; path: number[] | null }>();
  const leg = (a: number, b: number) => {
    const k = a < b ? `${a}-${b}` : `${b}-${a}`;
    let v = legCache.get(k);
    if (!v) {
      const p = astar(g, a, b);
      let L = 0;
      if (p) for (let i = 1; i < p.length; i++) L += dist(centerOf(g, p[i - 1] % g.nx, Math.floor(p[i - 1] / g.nx)), centerOf(g, p[i] % g.nx, Math.floor(p[i] / g.nx)));
      v = { len: p ? L : Infinity, path: p };
      legCache.set(k, v);
    }
    return v.len;
  };
  if (rest.length) {
    const start = seq.length && viewCells[seq[seq.length - 1]] != null ? viewCells[seq[seq.length - 1]]! : entCell;
    const cost = (perm: string[]) => {
      let c = 0, cur = start;
      for (const id of perm) { c += leg(cur, viewCells[id]!); cur = viewCells[id]!; }
      return c + leg(cur, entCell);
    };
    let best = [...rest];
    if (rest.length <= 7) {
      let bestC = Infinity;
      const permute = (arr: string[], k: number) => {
        if (k === arr.length) { const c = cost(arr); if (c < bestC) { bestC = c; best = [...arr]; } return; }
        for (let i = k; i < arr.length; i++) { [arr[k], arr[i]] = [arr[i], arr[k]]; permute(arr, k + 1); [arr[k], arr[i]] = [arr[i], arr[k]]; }
      };
      permute([...rest], 0);
    } else {
      best = []; const left = [...rest]; let cur = start;
      while (left.length) { left.sort((a, b) => leg(cur, viewCells[a]!) - leg(cur, viewCells[b]!)); const n = left.shift()!; best.push(n); cur = viewCells[n]!; }
    }
    seq.push(...best);
  }
  seq.push(...ids.filter((id) => !seq.includes(id))); // works without a standing spot (reported unreachable)
  const unreachable: string[] = [];
  const visit: string[] = [];
  // Each leg (entrance → work, work → work, last work → exit) is straightened on its own.
  const pts: Vec2[] = [];
  const addLeg = (leg: number[]) => {
    const p = straighten(g, leg.map((k) => centerOf(g, k % g.nx, Math.floor(k / g.nx))));
    pts.push(...(pts.length ? p.slice(1) : p));
  };
  let cur = entCell;
  for (const id of seq) {
    const t = viewCells[id];
    const leg = t == null ? null : astar(g, cur, t);
    if (!leg) { unreachable.push(id); continue; }
    addLeg(leg);
    visit.push(id);
    cur = t!;
  }
  const back = astar(g, cur, entCell);
  if (back) addLeg(back);
  let len = 0;
  for (let k = 1; k < pts.length; k++) len += dist(pts[k - 1], pts[k]);
  return { route: { entrance: ent, order: visit, path: simplify(pts), lengthM: pts.length ? len : null, unreachable, note: null }, viewPoints };
}

// ---------- evaluation ----------

export function evaluateGroup(ann: SpatialAnnotation, works: GroupWork[], poses: Record<string, Pose | null>, order?: string[], scenario: PlacementScenario = AS_SCANNED): GroupEvaluation {
  const { route, viewPoints } = computeRoute(ann, works, poses, order);
  const checks: WorkCheck[] = works.map((w) => {
    const pc = checkWorkInGroup(ann, works, poses, w.id, scenario);
    if (!pc) return { workId: w.id, placed: false, valid: false, outsideFloor: false, overlaps: [], clearanceM: null, limiterId: null, meetsClearance: false, viewPoint: null, reachable: null };
    return {
      workId: w.id, placed: true, valid: pc.valid, outsideFloor: pc.outsideFloor, overlaps: pc.overlappingObstacleIds,
      clearanceM: pc.clearanceM, limiterId: pc.limiterId, meetsClearance: pc.valid && pc.clearanceM != null && pc.clearanceM >= w.clearanceM - EPS,
      viewPoint: viewPoints[w.id] ?? null,
      reachable: route.lengthM == null ? null : !route.unreachable.includes(w.id) && viewPoints[w.id] != null,
    };
  });
  const name = (id: string) => { const w = works.find((x) => x.id === id); return w ? `${w.title} (${w.artist})` : id; };
  const conflicts: string[] = [];
  const requiredMissing = works.filter((w) => w.required && !poses[w.id]).map((w) => w.id);
  for (const id of requiredMissing) conflicts.push(`${name(id)} is required but has no place yet.`);
  for (const c of checks) {
    if (!c.placed) continue;
    if (c.outsideFloor) conflicts.push(`${name(c.workId)} goes past the floor edge.`);
    for (const o of c.overlaps) conflicts.push(`${name(c.workId)} overlaps ${o.startsWith("work:") ? name(o.slice(5)) : (ann.obstacles.find((x) => x.id === o)?.label ?? o)}.`);
    if (c.valid && !c.meetsClearance) conflicts.push(`${name(c.workId)} has ${c.clearanceM!.toFixed(2)} m of room; it needs ${works.find((w) => w.id === c.workId)!.clearanceM} m.`);
    if (c.reachable === false) conflicts.push(`Visitors can't reach a spot to see ${name(c.workId)}.`);
  }
  const ok = requiredMissing.length === 0 && checks.every((c) => !c.placed || (c.valid && c.meetsClearance && c.reachable !== false));
  return { works: checks, route, requiredMissing, conflicts, ok };
}

// ---------- plan search ----------

/** Small deterministic PRNG so plans are reproducible. */
function rng(seed: number) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

interface Cand { pose: Pose; body: Polygon; staticClear: number }

function staticCandidates(ann: SpatialAnnotation, w: GroupWork, scenario: PlacementScenario, step: number): Cand[] {
  const floor = ensureCCW(ann.floor);
  const xs = floor.map((p) => p.x), zs = floor.map((p) => p.z);
  const out: Cand[] = [];
  for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step) for (let z = Math.min(...zs) + step / 2; z < Math.max(...zs); z += step) for (const rot of [0, 90]) {
    const body = rectCorners(x, z, w.widthM, w.depthM, rot);
    if (!rectInsidePolygon(body, floor)) continue;
    const pc = checkPose(ann, scenario, w, { x, z, rotDeg: rot });
    if (pc.valid && pc.clearanceM != null && pc.clearanceM >= w.clearanceM - EPS) out.push({ pose: { x, z, rotDeg: rot }, body, staticClear: pc.clearanceM });
  }
  return out;
}

const PRIORITY_LABEL: Record<PlanPriority, string> = {
  room: "Most room around each work",
  route: "Follows your viewing order",
  moves: "Fewest changes to the current layout",
};

/**
 * Suggested layouts for the selected conditions (not "optimal"): randomized greedy restarts per priority.
 * Locked works stay put; required works are placed first; works are never resized.
 */
export function suggestGroupPlans(ann: SpatialAnnotation, works: GroupWork[], opts: { order?: string[]; priorities?: PlanPriority[]; restarts?: number; seed?: number; stepM?: number; scenario?: PlacementScenario } = {}): GroupPlan[] {
  const scenario = opts.scenario ?? AS_SCANNED;
  const step = opts.stepM ?? 0.3;
  const restarts = opts.restarts ?? 18;
  const current: Record<string, Pose | null> = Object.fromEntries(works.map((w) => [w.id, w.pose]));
  const priorities = opts.priorities ?? (works.some((w) => w.pose && !w.locked) ? ["room", "route", "moves"] : ["room", "route"]);
  const cache = new Map<string, Cand[]>();
  const cands = (w: GroupWork) => {
    const k = `${w.widthM}|${w.depthM}|${w.clearanceM}`;
    if (!cache.has(k)) cache.set(k, staticCandidates(ann, w, scenario, step));
    return cache.get(k)!;
  };
  const ent = entrancePoint(ann);
  const viewOrder = [...(opts.order ?? []).filter((id) => works.some((w) => w.id === id)), ...works.map((w) => w.id).filter((id) => !(opts.order ?? []).includes(id))];
  const plans: GroupPlan[] = [];

  for (const priority of priorities) {
    const rand = rng((opts.seed ?? 7) + priority.length * 101);
    let best: { poses: Record<string, Pose | null>; key: number[] } | null = null;
    for (let r = 0; r < restarts; r++) {
      const poses: Record<string, Pose | null> = Object.fromEntries(works.map((w) => [w.id, w.locked ? w.pose : null]));
      const placedBodies: { w: GroupWork; body: Polygon }[] = works.filter((w) => w.locked && w.pose).map((w) => ({ w, body: workBody(w, w.pose!) }));
      // Placement sequence: route priority follows the viewing order; otherwise required and larger works first.
      const free = works.filter((w) => !w.locked);
      const seqWorks = priority === "route"
        ? [...free].sort((a, b) => viewOrder.indexOf(a.id) - viewOrder.indexOf(b.id))
        : [...free].sort((a, b) => Number(b.required) - Number(a.required) || b.widthM * b.depthM - a.widthM * a.depthM || (rand() - 0.5));
      for (const w of seqWorks) {
        const ok: { c: Cand; slack: number }[] = [];
        for (const c of cands(w)) {
          let slack = c.staticClear - w.clearanceM, fine = true;
          for (const pb of placedBodies) {
            if (polygonsOverlap(c.body, pb.body)) { fine = false; break; }
            const d = polyPolyDist(c.body, pb.body).d;
            if (d < Math.max(w.clearanceM, pb.w.clearanceM) - EPS) { fine = false; break; }
            slack = Math.min(slack, d - w.clearanceM);
          }
          if (fine) ok.push({ c, slack });
        }
        if (!ok.length) continue; // reported as not placed / required missing
        let anchor: Vec2 | null = null;
        if (priority === "route") {
          const idx = viewOrder.indexOf(w.id);
          for (let k = idx - 1; k >= 0 && !anchor; k--) { const p = poses[viewOrder[k]]; if (p) anchor = { x: p.x, z: p.z }; }
          anchor = anchor ?? ent;
        }
        const score = (o: { c: Cand; slack: number }) =>
          priority === "room" ? o.slack
          : priority === "route" ? -(anchor ? dist(anchor, o.c.pose) : 0) + 0.3 * o.slack
          : current[w.id] ? -dist(current[w.id]!, o.c.pose) - (o.c.pose.rotDeg !== current[w.id]!.rotDeg ? 0.2 : 0) + 0.05 * o.slack : o.slack;
        ok.sort((a, b) => score(b) - score(a));
        const pick = ok[Math.min(ok.length - 1, Math.floor(rand() * Math.min(4, ok.length)))];
        poses[w.id] = pick.c.pose;
        placedBodies.push({ w, body: pick.c.body });
      }
      const reqPlaced = works.filter((w) => w.required && poses[w.id]).length;
      const allPlaced = works.filter((w) => poses[w.id]).length;
      let objective = 0;
      if (priority === "room") {
        let min = Infinity;
        for (const w of works) if (poses[w.id] && !w.locked) { const pc = checkWorkInGroup(ann, works, poses, w.id, scenario); if (pc?.clearanceM != null) min = Math.min(min, pc.clearanceM - w.clearanceM); }
        objective = Number.isFinite(min) ? min : 0;
      } else if (priority === "route") {
        objective = -(computeRoute(ann, works, poses, viewOrder).route.lengthM ?? 1e6);
      } else {
        objective = -works.reduce((t, w) => t + (poses[w.id] && current[w.id] ? dist(poses[w.id]!, current[w.id]!) : 0), 0);
      }
      const key = [reqPlaced, allPlaced, objective];
      if (!best || key[0] > best.key[0] || (key[0] === best.key[0] && (key[1] > best.key[1] || (key[1] === best.key[1] && key[2] > best.key[2])))) best = { poses, key };
    }
    if (!best) continue;
    const evaluation = evaluateGroup(ann, works, best.poses, viewOrder, scenario);
    const moved = works.filter((w) => current[w.id] && best!.poses[w.id] && (dist(current[w.id]!, best!.poses[w.id]!) > 0.05 || current[w.id]!.rotDeg !== best!.poses[w.id]!.rotDeg)).map((w) => w.id);
    const slacks = evaluation.works.filter((c) => c.placed && c.clearanceM != null).map((c) => c.clearanceM! - works.find((w) => w.id === c.workId)!.clearanceM);
    plans.push({
      priority, label: PRIORITY_LABEL[priority], poses: best.poses, evaluation,
      metrics: {
        placed: works.filter((w) => best!.poses[w.id]).length,
        requiredPlaced: works.filter((w) => w.required && best!.poses[w.id]).length,
        requiredTotal: works.filter((w) => w.required).length,
        minSlackM: slacks.length ? Math.min(...slacks) : null,
        routeM: evaluation.route.lengthM,
        moved, kept: works.filter((w) => w.locked).map((w) => w.id),
        notPlaced: works.filter((w) => !best!.poses[w.id]).map((w) => w.id),
      },
    });
  }
  // Drop plans identical to an earlier one.
  const seen = new Set<string>();
  return plans.filter((p) => { const k = JSON.stringify(p.poses); if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---------- budget ----------

export interface BudgetSummary {
  currency: string | null;
  quoted: number;          // sum of quoted amounts
  estimated: number;       // sum of user estimates
  unknown: string[];       // labels of items with no amount
  mixedCurrency: boolean;
  status: "within_quoted" | "over_quoted" | "unknown" | "no_budget";
  note: string;
}

/** Quoted vs estimated vs unknown; unknown is never zero, and the CoStar asking rent is never a short-term quote. */
export function summarizeBudget(items: CostItem[], budget: { amount: number | null; currency: string }): BudgetSummary {
  const currencies = new Set(items.filter((i) => i.amount != null).map((i) => i.currency));
  const mixed = currencies.size > 1 || (currencies.size === 1 && !currencies.has(budget.currency));
  let quoted = 0, estimated = 0;
  const unknown: string[] = [];
  for (const i of items) {
    if (i.amount == null || i.status === "unknown") { unknown.push(i.label); continue; }
    if (!(Number.isFinite(i.amount) && i.amount >= 0)) { unknown.push(i.label); continue; }
    if (i.status === "quoted") quoted += i.amount; else estimated += i.amount;
  }
  let status: BudgetSummary["status"];
  let note: string;
  if (budget.amount == null) { status = "no_budget"; note = "No total budget set."; }
  else if (mixed) { status = "unknown"; note = "Costs are in more than one currency; they are not added together."; }
  else if (quoted > budget.amount + EPS) { status = "over_quoted"; note = "Quoted costs alone are over the budget."; }
  else if (unknown.length || estimated > 0) { status = "unknown"; note = `Quoted costs are within the budget, but ${unknown.length ? `${unknown.length} cost${unknown.length > 1 ? "s are" : " is"} unknown` : "some costs are only estimates"}.`; }
  else { status = "within_quoted"; note = "All costs are quoted and within the budget."; }
  return { currency: currencies.size === 1 ? [...currencies][0] : budget.currency, quoted, estimated, unknown, mixedCurrency: mixed, status, note };
}
