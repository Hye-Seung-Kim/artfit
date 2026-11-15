// The four agent tools (spec §8.1). Deterministic; the LLM never produces their numbers.
import {
  AS_SCANNED, EPS, FOUR_ROTATIONS, DEFAULT_SCAN, ScanCache, SQM_PER_SQFT, evaluate, hash, passes, proposeClearance,
  requiredAreaM2, type Evaluation, type ExhibitionBrief, type PlacementScenario, type ScanSettings, type SpatialAnnotation,
} from "@artfit/geometry";
import { MARKETS, type Kit } from "../adapters/costarKit.js";
import { assessConditions, conditionEligibility, listLedgers, loadLedger } from "../evidence/ledger.js";
import { loadAnnotation, validateScenario } from "../scenarios/store.js";
import type { SpaceCandidate } from "../types.js";

export class InputError extends Error {}

const SPACE_USES = ["Office", "OfficeMedical", "OfficeRetail", "Medical", "Retail", "Flex", "Industrial"];
const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(Date.parse(s));

/** Brief validation (spec §4 comment block). */
export function validateBrief(b: any): ExhibitionBrief {
  if (!b || typeof b !== "object") throw new InputError("brief missing");
  if (!(b.city in MARKETS)) throw new InputError("research market must be Los Angeles or Houston");
  if (!isDate(b.exhibitionStart) || !isDate(b.exhibitionEnd)) throw new InputError("exhibition dates must be ISO dates");
  if (Date.parse(b.exhibitionStart) > Date.parse(b.exhibitionEnd)) throw new InputError("exhibition start must be on or before end");
  if (b.budget !== null && !(isFiniteNum(b.budget) && b.budget >= 0)) throw new InputError("budget must be null or a finite number >= 0");
  const a = b.artwork ?? {};
  for (const k of ["widthM", "depthM", "heightM"]) if (!(isFiniteNum(a[k]) && a[k] > 0 && a[k] < 100)) throw new InputError(`artwork.${k} must be finite and > 0`);
  if (!(isFiniteNum(b.preferredClearanceM) && b.preferredClearanceM >= 0 && b.preferredClearanceM < 20)) throw new InputError("preferred clearance must be finite and >= 0");
  if (b.minimumClearanceM !== null && !(isFiniteNum(b.minimumClearanceM) && b.minimumClearanceM >= 0)) throw new InputError("minimum clearance must be null or finite >= 0");
  if (b.minimumClearanceM !== null && b.minimumClearanceM > b.preferredClearanceM + EPS) throw new InputError("minimum clearance must be <= preferred clearance");
  const prefs = Array.isArray(b.spaceUsePreferences) ? b.spaceUsePreferences.filter((u: unknown) => typeof u === "string" && SPACE_USES.includes(u as string)) : [];
  const c = b.conditions ?? {};
  let works: ExhibitionBrief["works"];
  if (b.works != null) {
    if (!Array.isArray(b.works) || b.works.length < 1 || b.works.length > 12) throw new InputError("works must list 1–12 artworks");
    works = b.works.map((w: any, i: number) => {
      for (const k of ["widthM", "depthM", "heightM"]) if (!(isFiniteNum(w?.[k]) && w[k] > 0 && w[k] < 100)) throw new InputError(`works[${i}].${k} must be finite and > 0`);
      if (w.clearanceM != null && !(isFiniteNum(w.clearanceM) && w.clearanceM >= 0 && w.clearanceM < 20)) throw new InputError(`works[${i}].clearanceM must be null or finite >= 0`);
      return { id: String(w.id ?? `w${i + 1}`).slice(0, 80), title: String(w.title ?? "").slice(0, 120), artist: String(w.artist ?? "").slice(0, 80),
        widthM: w.widthM, depthM: w.depthM, heightM: w.heightM, clearanceM: w.clearanceM ?? null, required: w.required !== false };
    });
  }
  return {
    city: b.city, exhibitionStart: b.exhibitionStart.slice(0, 10), exhibitionEnd: b.exhibitionEnd.slice(0, 10),
    budget: b.budget, budgetCurrency: typeof b.budgetCurrency === "string" ? b.budgetCurrency : "USD",
    artwork: { widthM: a.widthM, depthM: a.depthM, heightM: a.heightM },
    ...(works ? { works } : {}),
    preferredClearanceM: b.preferredClearanceM, minimumClearanceM: b.minimumClearanceM, spaceUsePreferences: prefs,
    conditions: {
      // MVP: strict modes are not built (spec §0.0). They are accepted only as false.
      requireVerifiedVacant: false, requireVerifiedUnfurnished: false, requireVerifiedClearedRegion: false,
      evidenceAsOf: isDate(c.evidenceAsOf) ? c.evidenceAsOf.slice(0, 10) : b.exhibitionStart.slice(0, 10),
      clearedRegionScope: "matched_candidate_region",
    },
  };
}

export interface ToolCtx { kit: Kit; cache: ScanCache; requestId: string }

function spatialStatus(spaceId: string) {
  const ledger = loadLedger(spaceId);
  const annotation = loadAnnotation(spaceId);
  const matchVerified = !!ledger.match?.verified;
  const v = matchVerified && !!annotation?.annotationVerified && !!annotation?.scaleCheck?.passed && annotation?.obstacleCoverage === "reviewed_complete_for_region";
  return { ledger, annotation, matchVerified, spatiallyVerified: v };
}

function areaScreen(c: SpaceCandidate, brief: ExhibitionBrief) {
  if (c.listedAreaSqFt == null) return { status: "area_unknown" as const, listedAreaM2: null, requiredM2: requiredAreaM2(brief.artwork.widthM, brief.artwork.depthM, brief.preferredClearanceM) };
  const listed = c.listedAreaSqFt * SQM_PER_SQFT;
  const req = requiredAreaM2(brief.artwork.widthM, brief.artwork.depthM, brief.preferredClearanceM);
  if (listed >= req) return { status: "passes_reported_area_screen" as const, listedAreaM2: listed, requiredM2: req };
  const reqMin = requiredAreaM2(brief.artwork.widthM, brief.artwork.depthM, brief.minimumClearanceM ?? 0);
  return { status: listed >= reqMin ? "adjustment_pool" as const : "below_requested_footprint" as const, listedAreaM2: listed, requiredM2: req };
}

const IDLE_ORDER = { strong: 0, moderate: 1, weak: 2, unknown: 3 } as const;

/**
 * Listed (property-level) clear height vs the tallest work. Context for ranking only: the ceiling right above a
 * placement can be lower (beams, ducts, lights), so "clears" never becomes a height pass.
 */
function heightContext(c: SpaceCandidate, tallestM: number) {
  const h = c.ceilingHeightM;
  if (h == null) return "unknown" as const;
  if (h < tallestM) return "listed_below_tallest" as const;
  if (h < tallestM + 0.5) return "listed_tight" as const;
  return "listed_clears" as const;
}

/** search_spaces (spec §5.1) — all counts computed from loaded records. */
export function search_spaces(ctx: ToolCtx, briefIn: unknown) {
  const brief = validateBrief(briefIn);
  const market = MARKETS[brief.city];
  const all = ctx.kit.spaces;
  const reasonCounts: Record<string, number> = {};
  for (const s of all) for (const r of s.exclusions) reasonCounts[r] = (reasonCounts[r] ?? 0) + 1;
  const unresolved = all.filter((s) => s.candidate.propertyJoinStatus === "unresolved");
  const N = all.filter((s) => s.exclusions.length === 0 && s.candidate.researchMarketId === market).map((s) => s.candidate);
  const prefs = brief.spaceUsePreferences;
  const mReasons: Record<string, number> = {};
  const bump = (k: string) => (mReasons[k] = (mReasons[k] ?? 0) + 1);
  const useUnknown: string[] = [];
  const M: { c: SpaceCandidate; dateStatus: string }[] = [];
  for (const c of N) {
    if (c.spaceUse == null || c.spaceUse === "Unknown") { useUnknown.push(c.id); bump("space_use_unknown_review"); continue; }
    if (prefs.length && !prefs.includes(c.spaceUse)) { bump("space_use_not_selected"); continue; }
    if (c.isLeasePending === true) { bump("lease_pending"); continue; }
    if (c.availableOnDate && Date.parse(c.availableOnDate.slice(0, 10)) > Date.parse(brief.exhibitionStart)) { bump("available_date_after_exhibition_start"); continue; }
    M.push({ c, dateStatus: c.availableOnDate ? "reported_available_on_or_before_start" : c.availabilityType ? `relative_${c.availabilityType}` : "date_not_confirmed" });
  }
  const ledgers = new Map(listLedgers().map((l) => [l.spaceId, l]));
  const tallestM = Math.max(brief.artwork.heightM, ...(brief.works ?? []).map((w) => w.heightM));
  const heightCounts: Record<string, number> = {};
  const areaCounts: Record<string, number> = {};
  const rows = M.map(({ c, dateStatus }) => {
    const area = areaScreen(c, brief);
    areaCounts[area.status] = (areaCounts[area.status] ?? 0) + 1;
    const height = heightContext(c, tallestM);
    heightCounts[height] = (heightCounts[height] ?? 0) + 1;
    const ledger = ledgers.get(c.id) ?? { spaceId: c.id, evidenceVersion: 0, match: null, entries: [] };
    const conditions = assessConditions(c, ledger);
    const hasModel = c.matterportModelIds.length > 0;
    const sp = hasModel ? spatialStatus(c.id) : null;
    return { c, dateStatus, area, height, conditions, hasModel, hasAnnotation: !!sp?.annotation, matchVerified: !!sp?.matchVerified, spatiallyVerified: !!sp?.spatiallyVerified, matchProposed: !!ledger.match };
  });
  const K = rows.filter((r) => r.hasModel);
  const V = rows.filter((r) => r.spatiallyVerified);
  const bucket = (rs: typeof rows, f: (r: (typeof rows)[number]) => "q" | "n" | "m") => {
    const out = { qualifying: 0, needsVerification: 0, mismatch: 0 };
    for (const r of rs) { const k = f(r); if (k === "q") out.qualifying++; else if (k === "m") out.mismatch++; else out.needsVerification++; }
    return out;
  };
  const vac = (r: (typeof rows)[number]) => (r.conditions.occupancy.state === "verified" ? (r.conditions.occupancy.value === "vacant" ? "q" : "m") : "n");
  const fur = (r: (typeof rows)[number]) => (r.conditions.furnishing.state === "verified" ? (r.conditions.furnishing.value === "unfurnished" ? "q" : "m") : "n");
  const areaRank = (s: string) => (s === "below_requested_footprint" ? 1 : 0);
  const heightRank = (s: string) => (s === "listed_below_tallest" ? 1 : 0);
  // Fits on paper first, then listed ceiling not below the tallest work, then the long-idle signal. Nothing is removed.
  rows.sort((a, b) =>
    areaRank(a.area.status) - areaRank(b.area.status)
    || heightRank(a.height) - heightRank(b.height)
    || IDLE_ORDER[a.c.idleSignal] - IDLE_ORDER[b.c.idleSignal]
    || (b.c.monthsOnMarket ?? -1) - (a.c.monthsOnMarket ?? -1)
    || a.c.id.localeCompare(b.c.id));
  return {
    requestId: ctx.requestId,
    brief,
    dataMode: "kit_snapshot", sourceLabel: "CoStar data kit (Nov 2026 snapshot)",
    snapshotRefDate: ctx.kit.audit.snapshotRefDate,
    countUnit: "marketed space records (not confirmed unique vacant premises)",
    inputAudit: {
      activeLeaseListings: ctx.kit.audit.activeLeaseListings, nestedSpaces: ctx.kit.audit.nestedSpaces,
      exclusionReasons: reasonCounts, unresolvedPropertyBucket: unresolved.length, parseErrors: ctx.kit.audit.parseErrors.length,
      duplicateKeysRemoved: ctx.kit.audit.duplicateKeys,
    },
    funnel: {
      N: { count: N.length, label: `Marketed lease-space records in research market ${market} (${brief.city})` },
      M: { count: M.length, label: "Selected space use · not lease-pending · date not after exhibition start", reasons: mReasons, useUnknownBucket: useUnknown.length },
      M1: { count: rows.length, label: "Area-prioritized (no records removed; rounded advertised area is not proof of fit or misfit)", areaScreen: areaCounts, heightScreen: heightCounts, tallestM },
      K: { count: K.length, label: "With ≥1 Matterport association to the resolved property (building-level link)" },
      V: { count: V.length, label: "Exact suite-region match + reviewed annotation + passed scale/coverage checks" },
    },
    conditionBuckets: {
      vacancyEvidence: { N: bucket(rows, vac), K: bucket(K, vac), V: bucket(V, vac) },
      furnitureEvidence: { N: bucket(rows, fur), K: bucket(K, fur), V: bucket(V, fur) },
      note: "No commercial-space vacancy, furniture or cleared-state fields exist in the kit; these stay unknown unless reviewed evidence is recorded.",
    },
    candidates: rows.map((r) => ({
      id: r.c.id, displayName: r.c.displayName, address: r.c.address, city: r.c.city, researchMarketId: r.c.researchMarketId,
      suite: r.c.suite, spaceUse: r.c.spaceUse, listedAreaSqFt: r.c.listedAreaSqFt, availableOnDate: r.c.availableOnDate,
      availabilityType: r.c.availabilityType, dateStatus: r.dateStatus, rate: r.c.rate, isExecutiveSuite: r.c.isExecutiveSuite,
      monthsOnMarket: r.c.monthsOnMarket, idleSignal: r.c.idleSignal, idleNote: r.c.idleNote, lastRecordedTenantLeftAt: r.c.lastRecordedTenantLeftAt,
      tenancyMatch: r.c.tenancyMatch, areaScreen: r.area.status,
      listedAreaM2: r.area.listedAreaM2, requiredAreaM2: r.area.requiredM2, ceilingHeightM: r.c.ceilingHeightM, heightContext: r.height, matterportModelCount: r.c.matterportModelIds.length,
      matterportLinkLevel: r.c.matterportLinkLevel, hasAnnotation: r.hasAnnotation, matchProposed: r.matchProposed,
      matchVerified: r.matchVerified, spatiallyVerified: r.spatiallyVerified,
      conditionLabels: {
        listing: "Marketed in snapshot", occupancy: r.conditions.occupancy.label, furniture: r.conditions.scanFurniture?.label ?? r.conditions.furnishing.label,
        cleared: r.conditions.clearedRegion.label, shortTerm: r.conditions.shortTermUse.label,
      },
      certifiedFreshDate: r.c.certifiedFreshDate,
    })),
  };
}

/** inspect_space (spec §8.1). */
export function inspect_space(ctx: ToolCtx, spaceId: string) {
  const ks = ctx.kit.byId.get(spaceId);
  if (!ks) throw new InputError(`unknown space id ${spaceId}`);
  const { ledger, annotation, matchVerified, spatiallyVerified } = spatialStatus(spaceId);
  const conditions = assessConditions(ks.candidate, ledger);
  const missing: string[] = [];
  if (!ledger.match) missing.push("No exact suite-region match review recorded");
  else if (!matchVerified) missing.push("Exact suite-region match proposed but not yet confirmed by a reviewer");
  if (!annotation) missing.push("No traced annotation for this space");
  else {
    if (!annotation.annotationVerified) missing.push("Annotation not reviewed/verified");
    if (!annotation.scaleCheck?.passed) missing.push("No known exact-region scale reference verified");
    if (annotation.obstacleCoverage !== "reviewed_complete_for_region") missing.push(`Obstacle coverage: ${annotation.obstacleCoverage}`);
    if (annotation.ceilingHeightM == null) missing.push("Local minimum clear height not measured");
    if (!annotation.scanCapturedAt) missing.push("Scan capture date unknown");
  }
  missing.push("Current physical occupancy not verified", "Short-term exhibition permission not confirmed", "Short-term exhibition cost not confirmed");
  const obstacles = annotation?.obstacles ?? [];
  return {
    requestId: ctx.requestId,
    candidate: ks.candidate,
    kitExclusions: ks.exclusions,
    match: ledger.match, matchVerified, spatiallyVerified,
    annotation,
    conditions,
    evidence: ledger.entries,
    evidenceVersion: ledger.evidenceVersion,
    blockers: {
      permanent: obstacles.filter((o) => o.mobility === "permanent").map((o) => ({ id: o.id, label: o.label, category: o.category })),
      movable: obstacles.filter((o) => o.mobility === "reviewed_movable").map((o) => ({ id: o.id, label: o.label, category: o.category, removalPermissionEvidenceIds: o.removalPermissionEvidenceIds, removalCompletionEvidenceIds: o.removalCompletionEvidenceIds })),
      uncertain: obstacles.filter((o) => o.mobility === "unknown").map((o) => ({ id: o.id, label: o.label, category: o.category })),
    },
    supportedScenarios: ["as_scanned"], // hypothetical removal is P3 and disabled in this MVP (spec §0.0)
    propertyContext: {
      ceilingHeightM: ks.candidate.ceilingHeightM, columnSpacingM: ks.candidate.columnSpacingM, hasBuildingColumns: ks.candidate.hasBuildingColumns,
      driveInDoor: ks.candidate.driveInDoor, floorLoadPsf: ks.candidate.floorLoadPsf,
      note: "Property-level maximum/range context from CoStar; not a local exact-suite measurement.",
    },
    missing,
  };
}

function settingsFor(input: any): ScanSettings {
  if (input?.rotations === "four") return { ...DEFAULT_SCAN, rotationsDeg: FOUR_ROTATIONS };
  return DEFAULT_SCAN;
}

function doorComparison(c: SpaceCandidate, art: { widthM: number; depthM: number; heightM: number }) {
  const d = c.driveInDoor;
  if (!d || d.widthM == null || d.heightM == null) return { result: "unknown" as const, note: "No property drive-in door dimensions in kit" };
  const ok = Math.min(art.widthM, art.depthM) <= d.widthM - EPS && art.heightM <= d.heightM - EPS;
  return { result: ok ? "compatible" as const : "incompatible" as const, doorWidthM: d.widthM, doorHeightM: d.heightM, note: "Nominal upright, uncrated property-door comparison only; route to suite unverified" };
}

export interface EvalResult {
  requestId: string; spaceId: string; available: boolean; reason?: string;
  evaluation: Evaluation | null;
  scan: { scanKey: string; testedCount: number; sampledPositionCount: number; rotationsDeg: number[]; gridStepM: number; gridOrigin: { x: number; z: number }; validCount: number; scanDurationMs: number; bestSampledClearanceM: number | null; attemptReason: string | null } | null;
  scenario: PlacementScenario;
  annotationVersion: number | null; evidenceVersion: number;
  context: { propertyCeilingM: number | null; door: ReturnType<typeof doorComparison>; localCeilingM: number | null };
  conditionLabels: Record<string, string>;
  fingerprint: string;
}

/** evaluate_placement (spec §8.1). */
export function evaluate_placement(ctx: ToolCtx, input: { spaceId: string; artwork: unknown; requiredClearanceM: unknown; scenario?: unknown; settings?: unknown }): EvalResult {
  const ks = ctx.kit.byId.get(input.spaceId);
  if (!ks) throw new InputError(`unknown space id ${input.spaceId}`);
  const art = input.artwork as any;
  for (const k of ["widthM", "depthM", "heightM"]) if (!(isFiniteNum(art?.[k]) && art[k] > 0)) throw new InputError(`artwork.${k} invalid`);
  if (!(isFiniteNum(input.requiredClearanceM) && input.requiredClearanceM >= 0)) throw new InputError("required clearance invalid");
  const C = input.requiredClearanceM as number;
  const { ledger, annotation, matchVerified } = spatialStatus(input.spaceId);
  const conditions = assessConditions(ks.candidate, ledger);
  const labels = { occupancy: conditions.occupancy.label, furniture: conditions.scanFurniture?.label ?? conditions.furnishing.label, cleared: conditions.clearedRegion.label, shortTerm: conditions.shortTermUse.label };
  const door = doorComparison(ks.candidate, art);
  const base = { requestId: ctx.requestId, spaceId: input.spaceId, evidenceVersion: ledger.evidenceVersion, conditionLabels: labels };
  if (!annotation) {
    return { ...base, available: false, reason: "no_traced_geometry", evaluation: null, scan: null, scenario: AS_SCANNED, annotationVersion: null,
      context: { propertyCeilingM: ks.candidate.ceilingHeightM, door, localCeilingM: null },
      fingerprint: hash({ s: input.spaceId, art, C, ev: ledger.evidenceVersion, g: null }) };
  }
  const scenario = validateScenario(annotation, input.scenario as any);
  const settings = settingsFor(input.settings);
  const s = ctx.cache.get({ annotation, scenario, artwork: { widthM: art.widthM, depthM: art.depthM }, settings });
  const elig = conditionEligibility(conditions, { requireVerifiedVacant: false, requireVerifiedUnfurnished: false, requireVerifiedClearedRegion: false });
  const evaluation = evaluate(s, C, {
    matchVerified, annotation, scenario, artworkHeightM: art.heightM, evidenceVersion: ledger.evidenceVersion,
    conditionEligibility: elig, evidenceIds: [...(ledger.match?.evidenceIds ?? []), ...annotation.ceilingEvidenceIds],
  });
  return {
    ...base, available: true, evaluation,
    scan: { scanKey: s.scanKey, testedCount: s.testedCount, sampledPositionCount: s.sampledPositionCount, rotationsDeg: s.rotationsDeg, gridStepM: s.gridStepM, gridOrigin: s.gridOrigin, validCount: s.validCount, scanDurationMs: s.scanDurationMs, bestSampledClearanceM: s.bestSampledClearanceM, attemptReason: s.attemptReason },
    scenario, annotationVersion: annotation.version,
    context: { propertyCeilingM: ks.candidate.ceilingHeightM, door, localCeilingM: annotation.ceilingHeightM },
    fingerprint: hash({ s: input.spaceId, art, C, scan: s.scanKey, ev: ledger.evidenceVersion, sc: scenario.id, scv: scenario.version, g: annotation.version }),
  };
}

export type BranchStatus = "supported" | "unavailable" | "needs_user_minimum" | "verify_next";

/** plan_alternatives (spec §8.2) — both branches computed before the user chooses. */
export function plan_alternatives(ctx: ToolCtx, input: { brief: unknown; failedSpaceId: string; otherSpaceIds: string[]; scenarios?: Record<string, unknown>; expected?: Record<string, { annotationVersion: number | null; evidenceVersion: number }> }) {
  const brief = validateBrief(input.brief);
  if (!ctx.kit.byId.has(input.failedSpaceId)) throw new InputError("unknown failed space");
  for (const id of input.otherSpaceIds) if (!ctx.kit.byId.has(id)) throw new InputError(`unknown space ${id}`);
  const art = brief.artwork;
  const scen = (id: string) => (input.scenarios?.[id] ?? { mode: "as_scanned" });
  // Version expectations: refuse to compute on stale inputs.
  for (const [id, exp] of Object.entries(input.expected ?? {})) {
    const a = loadAnnotation(id), l = loadLedger(id);
    if ((a?.version ?? null) !== exp.annotationVersion || l.evidenceVersion !== exp.evidenceVersion) throw new InputError(`stale versions for ${id}; re-run evaluation`);
  }
  const failed = evaluate_placement(ctx, { spaceId: input.failedSpaceId, artwork: art, requiredClearanceM: brief.preferredClearanceM, scenario: scen(input.failedSpaceId) });

  // Branch 1 — keepRequirements: other matched candidates, unchanged brief, as-scanned unless the user chose otherwise.
  const others = input.otherSpaceIds.filter((id) => id !== input.failedSpaceId).map((id) =>
    evaluate_placement(ctx, { spaceId: id, artwork: art, requiredClearanceM: brief.preferredClearanceM, scenario: scen(id) }));
  const keepOptions = others.map((r) => {
    const e = r.evaluation;
    let status: BranchStatus = "unavailable";
    let reason = "";
    if (!r.available || !e) reason = r.reason ?? "no_geometry";
    else if (e.status === "unknown") reason = "exact_space_match_not_verified";
    else if (e.status === "conflict") reason = "no_passing_placement_among_tested_samples";
    else if (e.heightCheck === "fail") reason = "local_height_fails";
    else { status = e.geometryVerification === "Verified" && e.heightCheck === "pass" ? "supported" : "verify_next"; reason = e.geometryVerification === "Verified" ? "floor_fit" : "floor_fit_pending_spatial_verification"; }
    return { spaceId: r.spaceId, status, reason, evaluation: e, scenario: r.scenario, fingerprint: r.fingerprint, conditionLabels: r.conditionLabels };
  });
  const keepBest = keepOptions.find((o) => o.status === "supported") ?? keepOptions.find((o) => o.status === "verify_next") ?? keepOptions[0] ?? null;

  // Branch 2 — adjustInPlace: same space, same scenario, ONLY preferred clearance and pose may change.
  let adjust: { status: BranchStatus; reason: string; proposedClearanceM: number | null; measuredBestM: number | null; evaluation: Evaluation | null; scenario: PlacementScenario; fingerprint: string | null };
  const fe = failed.evaluation;
  if (!failed.available || !fe) adjust = { status: "unavailable", reason: failed.reason ?? "no_geometry", proposedClearanceM: null, measuredBestM: null, evaluation: null, scenario: failed.scenario, fingerprint: null };
  else if (fe.status === "unknown") adjust = { status: "unavailable", reason: "exact_space_match_not_verified", proposedClearanceM: null, measuredBestM: fe.bestSampledClearanceM, evaluation: null, scenario: failed.scenario, fingerprint: null };
  else if (fe.heightCheck === "fail") adjust = { status: "unavailable", reason: "clearance_cannot_fix_local_height_failure", proposedClearanceM: null, measuredBestM: fe.bestSampledClearanceM, evaluation: null, scenario: failed.scenario, fingerprint: null };
  else {
    const p = proposeClearance(fe.bestSampledClearanceM, brief.preferredClearanceM, brief.minimumClearanceM);
    if (p.kind === "needs_user_minimum") adjust = { status: "needs_user_minimum", reason: "set_an_explicit_minimum_clearance", proposedClearanceM: null, measuredBestM: fe.bestSampledClearanceM, evaluation: null, scenario: failed.scenario, fingerprint: null };
    else if (p.kind === "unavailable") adjust = { status: "unavailable", reason: p.reason, proposedClearanceM: null, measuredBestM: fe.bestSampledClearanceM, evaluation: null, scenario: failed.scenario, fingerprint: null };
    else {
      const re = evaluate_placement(ctx, { spaceId: input.failedSpaceId, artwork: art, requiredClearanceM: p.proposedC, scenario: scen(input.failedSpaceId) });
      const ok = re.evaluation && re.evaluation.status === "fit" && passes(re.evaluation.bestSampledClearanceM, p.proposedC);
      adjust = ok
        ? { status: re.evaluation!.geometryVerification === "Verified" && re.evaluation!.heightCheck === "pass" ? "supported" : "verify_next", reason: "preferred_clearance_reduced_within_user_minimum", proposedClearanceM: p.proposedC, measuredBestM: fe.bestSampledClearanceM, evaluation: re.evaluation, scenario: re.scenario, fingerprint: re.fingerprint }
        : { status: "unavailable", reason: "proposal_failed_reevaluation", proposedClearanceM: null, measuredBestM: fe.bestSampledClearanceM, evaluation: null, scenario: failed.scenario, fingerprint: null };
    }
  }

  const keepOk = keepBest && (keepBest.status === "supported" || keepBest.status === "verify_next");
  const adjOk = adjust.status === "supported" || adjust.status === "verify_next";
  const recommendation: "keep" | "adjust" | "none" = keepOk ? "keep" : adjOk ? "adjust" : "none";
  const scenarioMismatch = keepBest && keepBest.scenario.id !== failed.scenario.id;
  const fingerprint = hash({ brief, failed: failed.fingerprint, others: others.map((o) => o.fingerprint), adjust: adjust.fingerprint });
  return {
    requestId: ctx.requestId, fingerprint, brief,
    failedSpace: { spaceId: input.failedSpaceId, evaluation: fe, scenario: failed.scenario, fingerprint: failed.fingerprint },
    keepRequirements: { best: keepBest, options: keepOptions },
    adjustInPlace: { spaceId: input.failedSpaceId, ...adjust, preferredClearanceM: brief.preferredClearanceM, minimumClearanceM: brief.minimumClearanceM },
    recommendation,
    scenarioMismatch: !!scenarioMismatch,
    invariants: ["Artwork dimensions unchanged", "Entrances, obstacles and evidence unchanged", "No furniture removal assumed", "Condition requirements unchanged"],
  };
}
