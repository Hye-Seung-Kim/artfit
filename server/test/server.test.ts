import { describe, expect, it } from "vitest";
import { ceilingMeters, idleSignalOf, normalizeSuite } from "../src/adapters/costarKit.js";
import { assessConditions, conditionEligibility } from "../src/evidence/ledger.js";
import { TEMPLATES, TOOL_NAMES, deterministicNarration, validateNarration, type Facts } from "../src/agent/narration.js";
import { InputError, validateBrief } from "../src/agent/tools.js";
import { validateScenario } from "../src/scenarios/store.js";
import type { SpatialAnnotation } from "@artfit/geometry";
import type { EvidenceLedger, SpaceCandidate } from "../src/types.js";

const enums = { LocationOccupancyExpirationReason: { "0": "Unknown", "10": "MovingOutNewAddressUnknown" } };
const REF = "2026-11-10";

describe("§11.2 idle signal & suite normalization", () => {
  it('"Suite 120" / "120" / "Ste. 120" normalize equal', () => {
    expect(normalizeSuite("Suite 120")).toBe("120");
    expect(normalizeSuite("Ste. 120")).toBe("120");
    expect(normalizeSuite(" 120 ")).toBe("120");
    expect(normalizeSuite("#120")).toBe("120");
  });
  it("30 months + ended tenancy → strong; never 'vacant'", () => {
    const r = idleSignalOf({ dateOnMarket: "2024-05-10", propertyId: 1, propertyFloorId: 9, suite: "Ste. 120" },
      [{ id: 5, fromDate: "2019-01-01", toDate: "2024-03-31", expirationReason: 10, spaces: [{ propertyFloorId: 9, suite: "Suite 120" }] }], REF, enums);
    expect(r.idleSignal).toBe("strong");
    expect(r.lastRecordedTenantLeftAt).toBe("2024-03-31");
    expect(Math.round(r.monthsOnMarket!)).toBe(30);
  });
  it("matching current tenancy → weak + note", () => {
    const r = idleSignalOf({ dateOnMarket: "2023-01-01", propertyId: 1, propertyFloorId: 9, suite: "120" },
      [{ id: 5, fromDate: "2019-01-01", toDate: null, expirationReason: 0, spaces: [{ propertyFloorId: 9, suite: "120" }] }], REF, enums);
    expect(r.hasCurrentRecordedTenant).toBe(true);
    expect(r.idleSignal).toBe("weak");
    expect(r.idleNote).toMatch(/recorded tenant still listed/);
  });
  it("no match → moderate when ≥12 mo; empty suite never matches", () => {
    const r = idleSignalOf({ dateOnMarket: "2024-01-01", propertyId: 1, propertyFloorId: 9, suite: "" },
      [{ id: 5, fromDate: null, toDate: "2024-01-01", expirationReason: 0, spaces: [{ propertyFloorId: 9, suite: "" }] }], REF, enums);
    expect(r.tenancyMatch).toBe("none");
    expect(r.hasCurrentRecordedTenant).toBeNull();
    expect(r.idleSignal).toBe("moderate");
  });
  it("missing dateOnMarket → unknown; months use SNAPSHOT_REF_DATE not the clock", () => {
    expect(idleSignalOf({ dateOnMarket: null, propertyId: 1, propertyFloorId: 1, suite: "1" }, [], REF, enums).idleSignal).toBe("unknown");
    const a = idleSignalOf({ dateOnMarket: "2025-11-10", propertyId: 1, propertyFloorId: 1, suite: "1" }, [], "2026-11-10", enums).monthsOnMarket!;
    expect(a).toBeCloseTo(365 / 30.44, 6);
  });
});

describe("§11.3 conversions", () => {
  it("12 ft 6 in → 3.81 m; whole feet with null inches; both null → null", () => {
    expect(ceilingMeters(12, 6)).toBeCloseTo(3.81, 9);
    expect(ceilingMeters(14, null)).toBeCloseTo(4.2672, 9);
    expect(ceilingMeters(null, null)).toBeNull();
  });
});

const cand = { id: "1:2" } as SpaceCandidate;
const ledger = (entries: EvidenceLedger["entries"]): EvidenceLedger => ({ spaceId: "1:2", evidenceVersion: 1, match: null, entries });
const E = (claim: any, value: string, reviewedBy: string | null = "reviewer", observedAt: string | null = "2026-11-01") =>
  ({ id: `${claim}-${value}-${Math.random()}`, claim, value, sourceType: "site_observation" as const, sourceRef: "x", observedAt, scope: "region", note: "", reviewedBy, reviewedAt: "2026-11-02" });

describe("§11.2 evidence", () => {
  it("no evidence → all condition claims unknown, labeled", () => {
    const c = assessConditions(cand, ledger([]));
    expect(c.occupancy).toMatchObject({ value: null, state: "unknown", label: "Vacancy not verified" });
    expect(c.furnishing.state).toBe("unknown");
    expect(c.clearedRegion.label).toBe("Cleared plan region not verified");
    expect(c.shortTermUse.label).toBe("Short-term use not confirmed");
  });
  it("unreviewed evidence does not count", () => expect(assessConditions(cand, ledger([E("occupancy", "vacant", null)])).occupancy.state).toBe("unknown"));
  it("contradictory exact-space evidence → conflicting", () => expect(assessConditions(cand, ledger([E("occupancy", "vacant"), E("occupancy", "occupied")])).occupancy.state).toBe("conflicting"));
  it("dated observation stays historical, never auto-verified for the future", () => expect(assessConditions(cand, ledger([E("occupancy", "vacant")])).occupancy.state).toBe("historical_only"));
  it("removal permission does not create a cleared claim", () => expect(assessConditions(cand, ledger([E("removal_permission", "granted")])).clearedRegion.state).toBe("unknown"));
  it("strict requirements with all-unknown evidence → needs_verification (no relaxation)", () => {
    const c = assessConditions(cand, ledger([]));
    expect(conditionEligibility(c, { requireVerifiedVacant: true, requireVerifiedUnfurnished: false, requireVerifiedClearedRegion: false })).toBe("needs_verification");
  });
});

describe("brief validation", () => {
  const ok = { city: "Houston", exhibitionStart: "2027-03-01", exhibitionEnd: "2027-03-10", budget: null, artwork: { widthM: 4, depthM: 3, heightM: 2 }, preferredClearanceM: 1.2, minimumClearanceM: null, spaceUsePreferences: [] };
  it("missing minimum stays null (never auto-zero)", () => expect(validateBrief(ok).minimumClearanceM).toBeNull());
  it("rejects minimum > preferred, reversed dates, non-positive dims", () => {
    expect(() => validateBrief({ ...ok, minimumClearanceM: 2 })).toThrow(InputError);
    expect(() => validateBrief({ ...ok, exhibitionEnd: "2027-02-01" })).toThrow(InputError);
    expect(() => validateBrief({ ...ok, artwork: { widthM: 0, depthM: 3, heightM: 2 } })).toThrow(InputError);
  });
  it("strict condition flags cannot be enabled in the MVP", () => expect(validateBrief({ ...ok, conditions: { requireVerifiedVacant: true } }).conditions.requireVerifiedVacant).toBe(false));
});

describe("§11.3 server scenario validation", () => {
  const ann = {
    annotationId: "a", obstacles: [
      { id: "col", category: "column", mobility: "permanent", shape: { kind: "circle", c: { x: 0, z: 0 }, r: 0.3 } },
      { id: "desk", category: "movable_furniture", mobility: "reviewed_movable", shape: { kind: "polygon", poly: [] } },
    ],
  } as unknown as SpatialAnnotation;
  it("crafted removal of a column or foreign ID is rejected", () => {
    expect(() => validateScenario(ann, { mode: "hypothetical_furniture_removal", removedObstacleIds: ["col"] })).toThrow();
    expect(() => validateScenario(ann, { mode: "hypothetical_furniture_removal", removedObstacleIds: ["other-space-desk"] })).toThrow();
    expect(() => validateScenario(ann, { mode: "as_scanned", removedObstacleIds: ["desk"] })).toThrow();
    expect(validateScenario(ann, { mode: "hypothetical_furniture_removal", removedObstacleIds: ["desk"] }).removedObstacleIds).toEqual(["desk"]);
  });
});

describe("§11.4 agent & narration", () => {
  it("exactly four tools", () => expect([...TOOL_NAMES].sort()).toEqual(["evaluate_placement", "inspect_space", "plan_alternatives", "search_spaces"]));
  const facts: Facts = { "A.name": "A", "A.scenario": "as scanned", "A.remainingChecks": "x", "req.clearance": "c", "req.minimum": "m", "B.name": "B", "B.passCount": "3", "B.scenario": "s", "B.remainingChecks": "r", "B.reason": "r", "adj.proposed": null, "adj.measured": null, "adj.reason": "n" };
  const t = TEMPLATES[0];
  it("accepts an approved template with matching recommendation", () => expect(validateNarration({ recommendation: "keep", templateId: t.id, text: t.text }, facts, "keep")).toEqual([]));
  it("rejects wrong recommendation, unknown placeholder, bare digits, banned claims, free prose", () => {
    expect(validateNarration({ recommendation: "adjust", templateId: t.id, text: t.text }, facts, "keep").length).toBeGreaterThan(0);
    expect(validateNarration({ recommendation: "keep", templateId: t.id, text: t.text + " {Z.unknown}" }, facts, "keep").join()).toMatch(/placeholder/);
    expect(validateNarration({ recommendation: "keep", templateId: t.id, text: "B has 12 layouts" }, facts, "keep").join()).toMatch(/digits/);
    expect(validateNarration({ recommendation: "keep", templateId: t.id, text: "B is empty and ready" }, facts, "keep").join()).toMatch(/banned/);
    expect(validateNarration({ recommendation: "keep", templateId: "made_up", text: "fine" }, facts, "keep").join()).toMatch(/allowlist/);
  });
  it("null fact → template not applicable; deterministic fallback picks a valid one", () => {
    const n = deterministicNarration({ ...facts, "B.passCount": null }, "none");
    expect(n.templateId).toBe("floor_conflict_no_supported_option");
  });
});
