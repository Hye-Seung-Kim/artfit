// Scoped evidence assessment (spec §1.6, §4.2). Physical-condition claims default to unknown.
// Vacancy / unfurnished / cleared are NEVER inferred from listings, tenancy rows, executive-suite flags or scan looks.
import fs from "node:fs";
import path from "node:path";
import type { ClaimView, EvidenceEntry, EvidenceLedger, SpaceCandidate, SpaceConditions } from "../types.js";

export const DATA_DIR = path.resolve(import.meta.dirname, "../../data");
export const fileKey = (spaceId: string) => spaceId.replace(/[^0-9A-Za-z_-]/g, "_");

export function loadLedger(spaceId: string): EvidenceLedger {
  const f = path.join(DATA_DIR, "evidence", fileKey(spaceId) + ".json");
  if (!fs.existsSync(f)) return { spaceId, evidenceVersion: 0, match: null, entries: [] };
  const l = JSON.parse(fs.readFileSync(f, "utf8")) as EvidenceLedger;
  if (l.spaceId !== spaceId) throw new Error(`evidence file ${f} belongs to ${l.spaceId}, not ${spaceId}`);
  return l;
}

export function saveLedger(l: EvidenceLedger) {
  const f = path.join(DATA_DIR, "evidence", fileKey(l.spaceId) + ".json");
  fs.writeFileSync(f, JSON.stringify(l, null, 2) + "\n");
}

export function listLedgers(): EvidenceLedger[] {
  const dir = path.join(DATA_DIR, "evidence");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}

function claimFrom<T extends string>(entries: EvidenceEntry[], claim: EvidenceEntry["claim"], allowed: T[], labels: { unknown: string; byValue: Record<T, (asOf: string | null) => string> }): ClaimView<T> {
  // Only reviewed entries count. Reviewed-but-dated observations are historical unless a project policy accepts them;
  // MVP policy (docs/DECISIONS.md): no entry is accepted for a future exhibition date → state "historical_only".
  const rel = entries.filter((e) => e.claim === claim && e.reviewedBy && (allowed as string[]).includes(e.value));
  if (!rel.length) return { value: null, state: "unknown", evidenceIds: [], asOf: null, label: labels.unknown };
  const values = new Set(rel.map((e) => e.value));
  const ids = rel.map((e) => e.id);
  if (values.size > 1) return { value: null, state: "conflicting", evidenceIds: ids, asOf: null, label: `Conflicting ${claim} evidence — needs review` };
  const latest = rel.map((e) => e.observedAt).filter(Boolean).sort().at(-1) ?? null;
  const v = rel[0].value as T;
  return { value: v, state: "historical_only", evidenceIds: ids, asOf: latest, label: labels.byValue[v](latest) + " (historical observation)" };
}

const d = (s: string | null) => (s ? s.slice(0, 10) : "unknown date");

export function assessConditions(c: SpaceCandidate, l: EvidenceLedger): SpaceConditions {
  const E = l.entries;
  const scanObs = E.filter((e) => e.claim === "scan_furniture_observation");
  const latestObs = scanObs.at(-1);
  const observation = (latestObs?.value as "furniture_visible" | "none_observed" | "unknown" | undefined) ?? "unknown";
  const coverage = (latestObs?.scope?.includes("complete_for_scope") ? "complete_for_scope" : latestObs ? "partial" : "unknown") as "complete_for_scope" | "partial" | "unknown";
  const scanLabel = observation === "furniture_visible" ? "Furniture visible in scan"
    : observation === "none_observed" && coverage === "complete_for_scope" ? "No movable furniture observed in reviewed scan region"
    : observation === "none_observed" ? "No furniture seen in reviewed views (partial coverage)"
    : "Scan furniture review pending";
  return {
    occupancy: claimFrom(E, "occupancy", ["vacant", "occupied"], {
      unknown: "Vacancy not verified",
      byValue: { vacant: (a) => `Observed unoccupied as of ${d(a)}`, occupied: (a) => `Observed occupied as of ${d(a)}` },
    }),
    furnishing: claimFrom(E, "furnishing", ["unfurnished", "partially_furnished", "furnished"], {
      unknown: "Furniture condition not verified",
      byValue: { unfurnished: (a) => `No furniture observed as of ${d(a)}`, partially_furnished: (a) => `Partially furnished as of ${d(a)}`, furnished: (a) => `Furnished as of ${d(a)}` },
    }),
    clearedRegion: claimFrom(E, "cleared_region", ["cleared", "not_cleared"], {
      unknown: "Cleared plan region not verified",
      byValue: { cleared: (a) => `Cleared region verified as of ${d(a)}`, not_cleared: (a) => `Region obstructed as of ${d(a)}` },
    }),
    shortTermUse: claimFrom(E, "short_term_use", ["permitted", "not_permitted"], {
      unknown: "Short-term use not confirmed",
      byValue: { permitted: (a) => `Short-term use confirmed ${d(a)}`, not_permitted: (a) => `Short-term use declined ${d(a)}` },
    }),
    scanFurniture: l.match ? {
      modelId: l.match.modelId, regionId: l.match.regionId, capturedAt: null, observation, coverage,
      evidenceIds: scanObs.map((e) => e.id), label: scanLabel,
    } : null,
    evidenceVersion: l.evidenceVersion,
  };
}

/** MVP default mode only: every candidate is "needs_verification" unless all enabled strict requirements are met. */
export function conditionEligibility(cond: SpaceConditions, req: { requireVerifiedVacant: boolean; requireVerifiedUnfurnished: boolean; requireVerifiedClearedRegion: boolean }): "satisfies_requested_evidence" | "needs_verification" | "fails" {
  const checks: [boolean, ClaimView<string>, string][] = [
    [req.requireVerifiedVacant, cond.occupancy, "vacant"],
    [req.requireVerifiedUnfurnished, cond.furnishing, "unfurnished"],
    [req.requireVerifiedClearedRegion, cond.clearedRegion, "cleared"],
  ];
  let ok = true;
  for (const [on, claim, want] of checks) {
    if (!on) continue;
    if (claim.state === "verified" && claim.value !== null && claim.value !== want) return "fails";
    if (!(claim.state === "verified" && claim.value === want)) ok = false;
  }
  const anyOn = checks.some(([on]) => on);
  return anyOn && ok ? "satisfies_requested_evidence" : "needs_verification";
}
