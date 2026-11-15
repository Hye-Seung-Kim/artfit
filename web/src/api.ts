import type { Evaluation, ExhibitionBrief, PlacementScenario, SpatialAnnotation } from "@artfit/geometry";

let seq = 0;
/** Monotonic request IDs (spec §9.4). */
export const nextRequestId = () => `r${++seq}`;

export class ApiError extends Error { constructor(msg: string, public status: number) { super(msg); } }

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new ApiError(j.error ?? `HTTP ${res.status}`, res.status);
  return j as T;
}

export type SpaceContact = { name: string | null; company: string | null; role: string; email: string | null; phone: string | null };
export type CandidateCard = {
  id: string; displayName: string; address: string | null; city: string | null; suite: string | null; spaceUse: string | null;
  listedAreaSqFt: number | null; availableOnDate: string | null; availabilityType: string | null; dateStatus: string;
  rate: { low: number | null; high: number | null; basis: string; serviceType: string | null; perUnit: string; currency: string | null };
  isExecutiveSuite: boolean | null; monthsOnMarket: number | null; idleSignal: string; idleNote: string | null;
  lastRecordedTenantLeftAt: string | null; tenancyMatch: string; areaScreen: string; matterportModelCount: number;
  matterportLinkLevel: string; hasAnnotation: boolean; matchProposed: boolean; matchVerified: boolean; spatiallyVerified: boolean;
  listedAreaM2: number | null; requiredAreaM2: number; ceilingHeightM: number | null;
  heightContext: "listed_clears" | "listed_tight" | "listed_below_tallest" | "unknown";
  contacts: SpaceContact[]; brokerageCompany: string | null;
  conditionLabels: Record<string, string>; certifiedFreshDate: string | null;
};
export type SearchResult = {
  requestId: string; brief: ExhibitionBrief; sourceLabel: string; snapshotRefDate: string; countUnit: string;
  inputAudit: { activeLeaseListings: number; nestedSpaces: number; exclusionReasons: Record<string, number>; unresolvedPropertyBucket: number; parseErrors: number; duplicateKeysRemoved: number };
  funnel: Record<"N" | "M" | "M1" | "K" | "V", { count: number; label: string; reasons?: Record<string, number>; areaScreen?: Record<string, number>; heightScreen?: Record<string, number>; tallestM?: number; useUnknownBucket?: number }>;
  conditionBuckets: { vacancyEvidence: Record<string, { qualifying: number; needsVerification: number; mismatch: number }>; furnitureEvidence: Record<string, { qualifying: number; needsVerification: number; mismatch: number }>; note: string };
  candidates: CandidateCard[];
};
export type EvalResult = {
  requestId: string; spaceId: string; available: boolean; reason?: string; evaluation: Evaluation | null;
  scan: { scanKey: string; testedCount: number; sampledPositionCount: number; rotationsDeg: number[]; gridStepM: number; validCount: number; scanDurationMs: number; bestSampledClearanceM: number | null; attemptReason: string | null } | null;
  scenario: PlacementScenario; annotationVersion: number | null; evidenceVersion: number;
  context: { propertyCeilingM: number | null; door: { result: string; note: string; doorWidthM?: number; doorHeightM?: number }; localCeilingM: number | null };
  conditionLabels: Record<string, string>; fingerprint: string;
};
export type Inspect = any;
export type Plan = any;

export const api = {
  health: () => call<any>("GET", "/api/health"),
  markets: () => call<{ city: string; listings: number; withTour: number; traced: number; snapshotRefDate: string }[]>("GET", "/api/markets"),
  search: (brief: unknown, requestId: string) => call<SearchResult>("POST", "/api/spaces/search", { brief, requestId }),
  inspect: (id: string) => call<Inspect>("GET", `/api/spaces/${encodeURIComponent(id)}`),
  geometry: (id: string) => call<{ annotation: SpatialAnnotation; ledger: any }>("GET", `/api/spaces/${encodeURIComponent(id)}/geometry`),
  evaluate: (body: unknown) => call<EvalResult>("POST", "/api/placement/evaluate", body),
  plan: (body: unknown) => call<Plan>("POST", "/api/agent/plan", body),
  annotateGet: (id: string) => call<any>("GET", `/api/annotate/${encodeURIComponent(id)}`),
  annotatePut: (id: string, annotation: SpatialAnnotation) => call<any>("PUT", `/api/annotate/${encodeURIComponent(id)}`, { annotation }),
  matchReview: (id: string, body: { verified: boolean; reviewedBy: string; note: string }) => call<any>("POST", `/api/annotate/${encodeURIComponent(id)}/match-review`, body),
};

export const fmtDate = (s: string | null | undefined) => (s ? s.slice(0, 10) : "unknown");
export const monYear = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) : "unknown");
export const ft = (m: number) => `${(m / 0.3048).toFixed(1)} ft`;
