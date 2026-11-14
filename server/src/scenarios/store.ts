// Loads authoritative annotations and validates user scenario state against them (spec §6.4, §10.5).
// The canonical resolver lives in @artfit/geometry; this module never trusts browser obstacle arrays.
import fs from "node:fs";
import path from "node:path";
import { AS_SCANNED, ScenarioError, resolveActiveObstacles, validatePolygon, type PlacementScenario, type SpatialAnnotation } from "@artfit/geometry";
import { DATA_DIR, fileKey } from "../evidence/ledger.js";

export function loadAnnotation(spaceId: string): SpatialAnnotation | null {
  const f = path.join(DATA_DIR, "annotations", fileKey(spaceId) + ".json");
  if (!fs.existsSync(f)) return null;
  const a = JSON.parse(fs.readFileSync(f, "utf8")) as SpatialAnnotation;
  if (a.spaceId !== spaceId) throw new Error(`annotation ${f} belongs to ${a.spaceId}`);
  return a;
}

export function annotationErrors(a: SpatialAnnotation): string[] {
  const errs = validatePolygon(a.floor).map((e) => "floor: " + e);
  const ids = new Set<string>();
  for (const o of a.obstacles) {
    if (ids.has(o.id)) errs.push(`duplicate obstacle id ${o.id}`);
    ids.add(o.id);
    if (o.shape.kind === "polygon") errs.push(...validatePolygon(o.shape.poly).map((e) => `${o.id}: ${e}`));
    else if (!(o.shape.r > 0)) errs.push(`${o.id}: radius must be > 0`);
    if (o.mobility === "reviewed_movable" && o.category !== "movable_furniture") errs.push(`${o.id}: only movable furniture can be reviewed_movable`);
  }
  return errs;
}

export function saveAnnotation(a: SpatialAnnotation, prev: SpatialAnnotation | null): SpatialAnnotation {
  const errs = annotationErrors(a);
  if (errs.length) throw new ScenarioError("annotation invalid: " + errs.join("; "));
  const next = { ...a, version: (prev?.version ?? 0) + 1, annotatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(DATA_DIR, "annotations", fileKey(a.spaceId) + ".json"), JSON.stringify(next, null, 2) + "\n");
  return next;
}

/** Build a validated scenario from user state: only IDs of reviewed movable furniture in THIS annotation. */
export function validateScenario(a: SpatialAnnotation, input: { mode?: string; removedObstacleIds?: unknown; version?: number } | undefined): PlacementScenario {
  if (!input || input.mode === undefined || input.mode === "as_scanned") {
    if (input && Array.isArray(input.removedObstacleIds) && input.removedObstacleIds.length) throw new ScenarioError("as_scanned cannot remove obstacles");
    return AS_SCANNED;
  }
  if (input.mode !== "hypothetical_furniture_removal") throw new ScenarioError("unknown scenario mode");
  if (!Array.isArray(input.removedObstacleIds) || !input.removedObstacleIds.every((x) => typeof x === "string")) throw new ScenarioError("removedObstacleIds must be strings");
  const ids = [...new Set(input.removedObstacleIds as string[])].sort();
  const sc: PlacementScenario = {
    id: `hyp:${ids.join(",")}`, version: Number.isInteger(input.version) ? (input.version as number) : 1,
    mode: "hypothetical_furniture_removal", removedObstacleIds: ids, selectedBy: "user",
    assumptions: ["Selected movable items are assumed absent. Removal permission and completion are NOT verified.", "The original scan still shows the captured furniture."],
  };
  resolveActiveObstacles(a, sc); // throws on any non-movable / foreign id
  return sc;
}
