// Workspace artwork editing — ArtFit INTERNAL state (not a CoStar or Matterport field).
// One state drives the manual controls, the Claude edit path and both renderers. Pure functions only;
// Claude never edits this directly: it returns EditOps, and applyOps() is the only code that changes state.
import type { Pose, Vec2 } from "./types.js";

export type LengthUnit = "m" | "cm" | "mm" | "ft" | "in";
export interface Length { value: number; unit: LengthUnit }
const UNIT_TO_M: Record<LengthUnit, number> = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, in: 0.0254 };

export function toMeters(l: Length): number {
  if (!l || !(l.unit in UNIT_TO_M)) throw new EditError(`unsupported unit ${l?.unit}`);
  if (!Number.isFinite(l.value)) throw new EditError("length must be a finite number");
  return l.value * UNIT_TO_M[l.unit];
}

export const FINISH_COLORS = {
  default: { label: "ArtFit study (default)", hex: "#171717" },
  white: { label: "White", hex: "#F2F1EC" },
  black: { label: "Black", hex: "#141414" },
  gray: { label: "Gray", hex: "#8C8F8A" },
  red: { label: "Red", hex: "#B3261E" },
  blue: { label: "Blue", hex: "#2B4C9B" },
  yellow: { label: "Yellow", hex: "#E3B505" },
  green: { label: "Green", hex: "#2E6B4F" },
  wood: { label: "Natural wood", hex: "#B08355" },
  steel: { label: "Brushed steel", hex: "#A7ADB2" },
} as const;
export type FinishColor = keyof typeof FINISH_COLORS;
export type FinishMaterial = "matte" | "satin" | "gloss";

export interface ArtworkEditState {
  artworkId: string;
  spaceId: string;
  /** auto_best: pose comes from the sampled best-placement search. user_pose: the user fixed this pose. */
  mode: "auto_best" | "user_pose";
  pose: Pose | null;            // set only in user_pose mode
  widthM: number;
  depthM: number;
  heightM: number;
  /** Bottom of the artwork above the traced floor. The floor, obstacles and overlays never move with it. */
  baseElevationM: number;
  color: FinishColor;
  material: FinishMaterial;
  version: number;
}

export class EditError extends Error {
  constructor(message: string, public needsInfo = false) { super(message); }
}

export type EditOp =
  | { op: "move"; direction: "left" | "right" | "forward" | "back"; distance: Length }
  | { op: "rotate"; degrees: number; rotation: "clockwise" | "counterclockwise" }
  | { op: "set_dimension"; dimension: "width" | "depth" | "height"; value: Length }
  | { op: "scale_dimension"; dimension: "width" | "depth" | "height" | "all"; percent: number }
  | { op: "set_elevation"; value: Length }
  | { op: "set_ceiling_gap"; value: Length }
  | { op: "set_finish"; color: FinishColor | null; material: FinishMaterial | null }
  | { op: "find_best_placement" }
  | { op: "undo" } | { op: "redo" } | { op: "reset" };

export const EDIT_OP_NAMES = ["move", "rotate", "set_dimension", "scale_dimension", "set_elevation", "set_ceiling_gap", "set_finish", "find_best_placement", "undo", "redo", "reset"] as const;

export interface ApplyContext {
  /** Pose currently displayed (the best sampled pose in auto mode). Required for the first move/rotate. */
  displayedPose: Pose | null;
  /** Unit vector on the floor (x, z) pointing to the viewer's RIGHT in the active view; null = unknown. */
  viewRight: Vec2 | null;
  viewLabel: string;
  /** Reviewed local minimum clear height for this region, or null. Property-level maxima are NOT accepted. */
  localCeilingM: number | null;
}

export type Reevaluate = "none" | "pose" | "search";
export interface ApplyResult { state: ArtworkEditState; changes: string[]; reevaluate: Reevaluate }

const LIMITS = { minDim: 0.05, maxDim: 50, maxElevation: 30, maxMove: 100 };
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const fmt = (v: number) => `${r3(v)} m`;
const normDeg = (d: number) => ((d % 360) + 360) % 360;

function checkDim(name: string, v: number) {
  if (!Number.isFinite(v) || v <= 0) throw new EditError(`${name} must be a positive number`);
  if (v < LIMITS.minDim) throw new EditError(`${name} below ${LIMITS.minDim} m is not supported`);
  if (v > LIMITS.maxDim) throw new EditError(`${name} above ${LIMITS.maxDim} m is not supported`);
}

/** View-relative directions: right = viewRight; forward = away from the viewer along the floor. */
export function directionVector(direction: "left" | "right" | "forward" | "back", viewRight: Vec2): Vec2 {
  const L = Math.hypot(viewRight.x, viewRight.z);
  if (!(L > 1e-9)) throw new EditError("the view direction is unknown");
  const r = { x: viewRight.x / L, z: viewRight.z / L };
  // Camera looks along forward f and right r = f × up. With yaw ψ: f = (−sin ψ, −cos ψ), r = (cos ψ, −sin ψ) ⇒ f = (r.z, −r.x).
  const fwd = { x: r.z, z: -r.x };
  switch (direction) {
    case "right": return r;
    case "left": return { x: -r.x, z: -r.z };
    case "forward": return fwd;
    case "back": return { x: -fwd.x, z: -fwd.z };
  }
}

/** Camera yaw (three.js convention: camera looks down −Z, yaw about +Y) → viewer-right floor vector. */
export const viewRightFromYaw = (yawRad: number): Vec2 => ({ x: Math.cos(yawRad), z: -Math.sin(yawRad) });

/**
 * Apply one validated change set. Throws EditError (with needsInfo when the user must supply a value).
 * undo / redo / reset are history operations and are handled by the history, not here.
 */
export function applyOps(state: ArtworkEditState, ops: EditOp[], ctx: ApplyContext): ApplyResult {
  if (!ops.length) throw new EditError("no change requested");
  let s: ArtworkEditState = { ...state, pose: state.pose ? { ...state.pose } : null };
  const changes: string[] = [];
  let reevaluate: Reevaluate = "none";
  const bump = (r: Reevaluate) => { const order = { none: 0, pose: 1, search: 2 }; if (order[r] > order[reevaluate]) reevaluate = r; };
  const ensurePose = () => {
    if (s.mode === "user_pose" && s.pose) return s.pose;
    if (!ctx.displayedPose) throw new EditError("there is no placed artwork to move yet");
    s.mode = "user_pose";
    s.pose = { ...ctx.displayedPose };
    return s.pose;
  };
  for (const op of ops) {
    switch (op.op) {
      case "move": {
        const d = toMeters(op.distance);
        if (!(d > 0)) throw new EditError("move distance must be positive");
        if (d > LIMITS.maxMove) throw new EditError("move distance is too large");
        if (!ctx.viewRight) throw new EditError("the current view direction is unknown; rotate or click the view once and retry");
        const v = directionVector(op.direction, ctx.viewRight);
        const p = ensurePose();
        p.x = r3(p.x + v.x * d); p.z = r3(p.z + v.z * d);
        changes.push(`Moved ${fmt(d)} ${op.direction === "back" ? "back (toward you)" : op.direction === "forward" ? "forward (away from you)" : `to the ${op.direction}`} as seen in the ${ctx.viewLabel}`);
        bump("pose");
        break;
      }
      case "rotate": {
        if (!Number.isFinite(op.degrees) || op.degrees <= 0 || op.degrees > 360) throw new EditError("rotation must be between 0 and 360 degrees");
        const p = ensurePose();
        // Seen from above (x to the right, z down the page), rectCorners() turns +rotDeg clockwise.
        const delta = op.rotation === "clockwise" ? op.degrees : -op.degrees;
        p.rotDeg = r3(normDeg(p.rotDeg + delta));
        changes.push(`Rotated ${r3(op.degrees)}° ${op.rotation} (seen from above)`);
        bump("pose");
        break;
      }
      case "set_dimension": {
        const v = toMeters(op.value);
        checkDim(op.dimension, v);
        const key = (op.dimension + "M") as "widthM" | "depthM" | "heightM";
        changes.push(`${cap(op.dimension)} ${fmt(s[key])} → ${fmt(v)}`);
        s[key] = r3(v);
        bump(op.dimension === "height" ? "none" : s.mode === "user_pose" ? "pose" : "search");
        break;
      }
      case "scale_dimension": {
        if (!Number.isFinite(op.percent) || op.percent <= -100 || op.percent > 1000) throw new EditError("percent change must be greater than -100%");
        const f = 1 + op.percent / 100;
        const dims = op.dimension === "all" ? ["width", "depth", "height"] as const : [op.dimension] as const;
        for (const dim of dims) {
          const key = (dim + "M") as "widthM" | "depthM" | "heightM";
          const v = r3(s[key] * f);
          checkDim(dim, v);
          changes.push(`${cap(dim)} ${fmt(s[key])} → ${fmt(v)} (${op.percent > 0 ? "+" : ""}${op.percent}%)`);
          s[key] = v;
        }
        bump(dims.every((d) => d === "height") ? "none" : s.mode === "user_pose" ? "pose" : "search");
        break;
      }
      case "set_elevation": {
        const v = toMeters(op.value);
        if (!Number.isFinite(v) || v < 0) throw new EditError("the artwork bottom cannot go below the floor");
        if (v > LIMITS.maxElevation) throw new EditError("elevation is too large");
        changes.push(`Bottom above floor ${fmt(s.baseElevationM)} → ${fmt(v)}`);
        s.baseElevationM = r3(v);
        break; // floor-projection checks are unchanged; no re-search
      }
      case "set_ceiling_gap": {
        const gap = toMeters(op.value);
        if (!Number.isFinite(gap) || gap < 0) throw new EditError("ceiling gap must be zero or positive");
        if (ctx.localCeilingM == null)
          throw new EditError("No reviewed local ceiling height is recorded for this space, so a ceiling-referenced position cannot be calculated. How high above the floor should the bottom of the artwork be?", true);
        const base = ctx.localCeilingM - gap - s.heightM;
        if (base < -1e-9) throw new EditError(`with a ${fmt(gap)} gap the artwork bottom would be below the floor (local ceiling ${fmt(ctx.localCeilingM)}, artwork height ${fmt(s.heightM)})`);
        changes.push(`Hung ${fmt(gap)} below the reviewed local ceiling (${fmt(ctx.localCeilingM)}): bottom ${fmt(s.baseElevationM)} → ${fmt(Math.max(0, base))}`);
        s.baseElevationM = r3(Math.max(0, base));
        break;
      }
      case "set_finish": {
        if (op.color == null && op.material == null) throw new EditError("no finish change given");
        if (op.color != null) {
          if (!(op.color in FINISH_COLORS)) throw new EditError(`unsupported color ${op.color}`);
          if (op.color !== s.color) changes.push(`Color ${FINISH_COLORS[s.color].label} → ${FINISH_COLORS[op.color].label}`);
          s.color = op.color;
        }
        if (op.material != null) {
          if (!["matte", "satin", "gloss"].includes(op.material)) throw new EditError(`unsupported material ${op.material}`);
          if (op.material !== s.material) changes.push(`Surface ${s.material} → ${op.material}`);
          s.material = op.material;
        }
        if (op.color === state.color && (op.material == null || op.material === state.material) && changes.length === 0) changes.push("Finish already as requested (no change)");
        break; // appearance only: no placement check or search
      }
      case "find_best_placement": {
        s.mode = "auto_best"; s.pose = null;
        changes.push("Returned to the best placement among tested samples (new search)");
        bump("search");
        break;
      }
      case "undo": case "redo": case "reset":
        throw new EditError(`${op.op} is a history action and cannot be combined with other changes`);
      default:
        throw new EditError(`unsupported operation ${(op as { op: string }).op}`);
    }
  }
  s.version = state.version + 1;
  return { state: s, changes, reevaluate };
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

// ---------------------------------------------------------------------------------------------------------
// History: one entry per change set (a compound request undoes as one unit). "Initial" = session start.
export interface EditEntry { state: ArtworkEditState; label: string; source: "manual" | "claude" | "history" }
export interface EditHistory { initial: ArtworkEditState; past: EditEntry[]; present: EditEntry; future: EditEntry[]; versionCounter: number }

export function createHistory(initial: ArtworkEditState): EditHistory {
  return { initial, past: [], present: { state: initial, label: "Session start", source: "history" }, future: [], versionCounter: initial.version };
}

/** Each committed/undone/redone/reset state gets a NEW version, so late responses based on an old version never apply. */
function stamp(h: EditHistory, s: ArtworkEditState): [ArtworkEditState, number] {
  const v = h.versionCounter + 1;
  return [{ ...s, version: v }, v];
}

export function commit(h: EditHistory, next: ArtworkEditState, label: string, source: EditEntry["source"], coalesceKey?: string): EditHistory {
  const [s, v] = stamp(h, next);
  // Coalesce rapid slider drags of the same control into one entry.
  if (coalesceKey && (h.present as EditEntry & { key?: string }).key === coalesceKey) {
    return { ...h, present: { state: s, label, source, key: coalesceKey } as EditEntry, future: [], versionCounter: v };
  }
  return { ...h, past: [...h.past, h.present], present: { state: s, label, source, key: coalesceKey } as EditEntry, future: [], versionCounter: v };
}

export function undo(h: EditHistory): EditHistory {
  if (!h.past.length) return h;
  const prev = h.past[h.past.length - 1];
  const [s, v] = stamp(h, prev.state);
  return { ...h, past: h.past.slice(0, -1), present: { ...prev, state: s }, future: [h.present, ...h.future], versionCounter: v };
}

export function redo(h: EditHistory): EditHistory {
  if (!h.future.length) return h;
  const next = h.future[0];
  const [s, v] = stamp(h, next.state);
  return { ...h, past: [...h.past, h.present], present: { ...next, state: s }, future: h.future.slice(1), versionCounter: v };
}

/** Reset is itself undoable. */
export function resetToInitial(h: EditHistory): EditHistory {
  return commit(h, { ...h.initial }, "Reset to session start", "history");
}

// ---------------------------------------------------------------------------------------------------------
/** Vertical relationship of an artwork to a REVIEWED local ceiling (property maxima are never used). */
export function verticalCheck(s: Pick<ArtworkEditState, "baseElevationM" | "heightM">, localCeilingM: number | null) {
  const topM = s.baseElevationM + s.heightM;
  if (localCeilingM == null) return { topM, ceilingM: null, gapM: null, result: "unknown" as const };
  const gapM = localCeilingM - topM;
  return { topM, ceilingM: localCeilingM, gapM, result: gapM >= -1e-6 ? "pass" as const : "fail" as const };
}

/**
 * An elevated artwork never inherits the floor-standing verdict. The floor-projection result becomes a
 * conservative plan check; 3D clearance against obstacles of unknown height stays unconfirmed.
 */
export function placementScope(baseElevationM: number) {
  return baseElevationM > 1e-6
    ? { kind: "elevated_preview" as const, label: "Elevated preview — floor-projection plan check only", note: "Obstacle heights are unknown, so 3D clearance is not confirmed. Suspension, fixing and load are not checked." }
    : { kind: "floor_standing" as const, label: "Floor-standing placement", note: null };
}
