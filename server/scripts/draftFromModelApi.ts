// Builds a DRAFT annotation + evidence ledger from Matterport Model API room/wall data (server-only key).
// Output is explicitly unverified: annotationVerified=false, match.verified=false, scale unverified.
// Coordinate transform (spec §10.2.1): Model API (x, y) floor plane → Showcase (x, z = -y). Must be spot-checked
// against Pointer.intersection in the annotation tool before review.
// Usage: npm run draft-annotations -- <spaceId> <modelId> [--force]
import fs from "node:fs";
import path from "node:path";
import { ensureCCW, validatePolygon, type Obstacle, type SpatialAnnotation, type Vec2 } from "@artfit/geometry";
import { DATA_DIR, fileKey, loadLedger, saveLedger } from "../src/evidence/ledger.js";

const [spaceId, modelId] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const force = process.argv.includes("--force");
if (!spaceId || !modelId) { console.error("usage: draftFromModelApi <spaceId> <modelId>"); process.exit(1); }

const Q = `{ model(id: "${modelId}") { id name created processing { processingCompletedAt }
  floors { id label vertices { id position { x y } } edges { id thickness vertices { id } openings { id type width height relativeCenter } } }
  rooms { id label classifications { label } dimensions { areaFloor units } ceiling { minHeight maxHeight } floor { id }
    boundary { edges { id vertices { id position { x y } } } } } } }`;

const auth = Buffer.from(`${process.env.MATTERPORT_API_KEY}:${process.env.MATTERPORT_API_TOKEN}`).toString("base64");
const res = await fetch("https://api.matterport.com/api/models/graph", { method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: Q }) });
const body: any = await res.json();
if (body.errors) { console.error(body.errors); process.exit(1); }
const m = body.data.model;
const floor = m.floors[0];
const toSdk = (p: { x: number; y: number }): Vec2 => ({ x: p.x, z: -p.y });

// Main region = largest room by floor area (the open flex area). Other rooms (office/bath) are outside the region.
const main = [...m.rooms].sort((a: any, b: any) => (b.dimensions?.areaFloor ?? 0) - (a.dimensions?.areaFloor ?? 0))[0];
const edgeThickness = new Map<string, number>(floor.edges.map((e: any) => [e.id, e.thickness ?? 0.15]));
// Chain boundary edges into a polygon of wall centerline vertices.
const segs: { a: any; b: any; t: number; id: string }[] = main.boundary.edges.map((e: any) => ({ a: e.vertices[0], b: e.vertices[1], t: edgeThickness.get(e.id) ?? 0.15, id: e.id }));
const ring: { v: any; t: number }[] = [];
let cur = segs.shift()!;
ring.push({ v: cur.a, t: cur.t });
let tip = cur.b;
while (segs.length) {
  const i = segs.findIndex((s) => s.a.id === tip.id || s.b.id === tip.id);
  if (i < 0) throw new Error("room boundary is not a single closed ring");
  const s = segs.splice(i, 1)[0];
  ring.push({ v: tip, t: s.t });
  tip = s.a.id === tip.id ? s.b : s.a;
}
// Inset each wall line by half its thickness (interior face), intersect consecutive lines.
// ring[i].t is the thickness of the wall from ring[i] to ring[i+1].
let center = ring.map((r) => toSdk(r.v.position));
const n = center.length;
let edgeTs = ring.map((r) => r.t);
if (ensureCCW(center) !== center) {
  center = [...center].reverse();
  edgeTs = center.map((_, j) => ring[(2 * n - 2 - j) % n].t); // reversed edge j = original edge n-2-j
}
const edgeT = (i: number) => edgeTs[i];
const lines = center.map((a, i) => {
  const b = center[(i + 1) % n];
  const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
  const nx = -dz / L, nz = dx / L; // left normal = interior for CCW
  const off = edgeT(i) / 2;
  return { p: { x: a.x + nx * off, z: a.z + nz * off }, d: { x: dx / L, z: dz / L } };
});
const inset: Vec2[] = lines.map((l2, i) => {
  const l1 = lines[(i + n - 1) % n];
  const den = l1.d.x * l2.d.z - l1.d.z * l2.d.x;
  if (Math.abs(den) < 1e-9) return l2.p;
  const t = ((l2.p.x - l1.p.x) * l2.d.z - (l2.p.z - l1.p.z) * l2.d.x) / den;
  return { x: l1.p.x + l1.d.x * t, z: l1.p.z + l1.d.z * t };
});
const r6 = (v: number) => Math.round(v * 1e4) / 1e4;
const floorPoly = inset.map((p) => ({ x: r6(p.x), z: r6(p.z) }));
const errs = validatePolygon(floorPoly);
if (errs.length) throw new Error("draft floor invalid: " + errs.join("; "));

// Entrance zones: every doorway on a wall bounding the main region → 1.2 m deep zone (design-review assumption).
const vpos = new Map<string, Vec2>(floor.vertices.map((v: any) => [v.id, toSdk(v.position)]));
const boundaryVertexIds = new Set(main.boundary.edges.flatMap((e: any) => e.vertices.map((v: any) => v.id)));
const obstacles: Obstacle[] = [];
const inside = (p: Vec2) => {
  let c = false;
  for (let i = 0, j = floorPoly.length - 1; i < floorPoly.length; j = i++) {
    const a = floorPoly[i], b = floorPoly[j];
    if ((a.z > p.z) !== (b.z > p.z) && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) c = !c;
  }
  return c;
};
for (const e of floor.edges) {
  const [va, vb] = e.vertices.map((v: any) => v.id);
  if (!boundaryVertexIds.has(va) || !boundaryVertexIds.has(vb)) continue;
  for (const o of e.openings ?? []) {
    if (o.type !== "doorway") continue;
    const A = vpos.get(va)!, B = vpos.get(vb)!;
    const dx = B.x - A.x, dz = B.z - A.z, L = Math.hypot(dx, dz);
    const ux = dx / L, uz = dz / L;
    const c = { x: A.x + dx * o.relativeCenter, z: A.z + dz * o.relativeCenter };
    let nx = -uz, nz = ux;
    if (!inside({ x: c.x + nx * 0.5, z: c.z + nz * 0.5 })) { nx = -nx; nz = -nz; }
    if (!inside({ x: c.x + nx * 0.5, z: c.z + nz * 0.5 })) continue; // door not opening into the main region
    const hw = o.width / 2 + 0.1, depth = 1.2 + (e.thickness ?? 0.15) / 2;
    const poly = [
      { x: c.x - ux * hw, z: c.z - uz * hw }, { x: c.x + ux * hw, z: c.z + uz * hw },
      { x: c.x + ux * hw + nx * depth, z: c.z + uz * hw + nz * depth }, { x: c.x - ux * hw + nx * depth, z: c.z - uz * hw + nz * depth },
    ].map((p) => ({ x: r6(p.x), z: r6(p.z) }));
    obstacles.push({
      id: `entrance-${obstacles.length + 1}`, label: `Doorway ${o.width.toFixed(2)} m wide`, category: "entrance_zone", shape: { kind: "polygon", poly: ensureCCW(poly) },
      mobility: "permanent", evidenceIds: ["ev-model-api-geometry"], removalPermissionEvidenceIds: [], removalCompletionEvidenceIds: [],
      reviewNote: "Design-review assumption: doorway width + 0.1 m each side, 1.2 m deep path zone. Not a code/accessibility determination.", heightM: o.height ?? 2.03,
    });
  }
}

const walls = floor.edges.map((e: any) => ({ a: vpos.get(e.vertices[0].id)!, b: vpos.get(e.vertices[1].id)!, thicknessM: e.thickness ?? 0.15 }));
const ann: SpatialAnnotation = {
  annotationId: `ann-${fileKey(spaceId)}`, spaceId, modelId, floorId: floor.id, regionId: main.id,
  coordinateSystem: "showcase_sdk_xz_m", floorElevationY: 0, floor: ensureCCW(floorPoly), obstacles, walls,
  ceilingHeightM: null, ceilingEvidenceIds: [], scaleCheck: null,
  obstacleCoverage: "partial",
  coverageNotes: [
    "Draft built from Matterport Model API room boundary (wall centerlines inset by half wall thickness).",
    "No columns, fixtures or furniture traced yet; reviewer must inspect the scan and add any blockers.",
    "Model API (x,y) → Showcase (x,-y) transform: verify Sweep positions match Model API pano positions (done for the A/B models on 2026-11-14).",
  ],
  annotationVerified: false, annotationMethod: "model_api_assisted_draft", annotatedBy: "artfit draft script", reviewedBy: null, reviewedAt: null,
  version: 1, annotatedAt: new Date().toISOString(), scanCapturedAt: null, scanProcessedAt: m.processing?.processingCompletedAt ?? null,
};
const annFile = path.join(DATA_DIR, "annotations", fileKey(spaceId) + ".json");
if (fs.existsSync(annFile) && !force) { console.error(`${annFile} exists; pass --force to overwrite`); process.exit(1); }
fs.writeFileSync(annFile, JSON.stringify(ann, null, 2) + "\n");

const l = loadLedger(spaceId);
const now = new Date().toISOString();
const has = (id: string) => l.entries.some((e) => e.id === id);
if (!has("ev-model-name")) l.entries.push({
  id: "ev-model-name", claim: "model_match", value: "proposed", sourceType: "model_api_metadata", sourceRef: `matterport model ${modelId} name "${m.name}"`,
  observedAt: null, scope: `model ${modelId}, floor ${floor.id}, room ${main.id}`,
  note: `Model name identifies the suite; model is listed for this property in commercial-properties.csv. Main room ${Math.round(main.dimensions?.areaFloor ?? 0)} sq ft (Matterport estimate). Proposed only — a reviewer must confirm the exact suite region in the scan.`,
  reviewedBy: null, reviewedAt: null, limitations: ["Model name is provider metadata, not a dimensioned plan", "Region boundary not yet confirmed by a reviewer"],
});
if (!has("ev-model-api-geometry")) l.entries.push({
  id: "ev-model-api-geometry", claim: "measurement", value: "room_boundary_draft", sourceType: "model_api_metadata", sourceRef: `Model API rooms[${main.id}].boundary`,
  observedAt: null, scope: `room ${main.id}`, note: `Processed by Matterport ${m.processing?.processingCompletedAt ?? "unknown"} (processing time, not capture time).`, reviewedBy: null, reviewedAt: null,
});
l.match = l.match ?? { modelId, floorId: floor.id, regionId: main.id, verified: false, evidenceIds: ["ev-model-name"], reviewedBy: null, reviewedAt: null, notes: [`Proposed from model name "${m.name}"`] };
l.evidenceVersion = (l.evidenceVersion ?? 0) + 1;
saveLedger(l);
console.log(JSON.stringify({ spaceId, modelId, name: m.name, floorPoints: ann.floor.length, entrances: obstacles.length, file: annFile }, null, 1));
void now;
