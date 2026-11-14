// Server-side ArtFit internal contracts (spec §4). Not CoStar API fields.
import type { LinkLevel } from "@artfit/geometry";

export type EvidenceState = "verified" | "historical_only" | "unknown" | "conflicting";

/** Minimal MVP evidence entry (spec §4.2). */
export interface EvidenceEntry {
  id: string;
  claim: "occupancy" | "furnishing" | "cleared_region" | "removal_permission" | "removal_completion"
    | "short_term_use" | "model_match" | "measurement" | "scan_furniture_observation";
  value: string;
  sourceType: "costar_kit" | "scan_review" | "floor_plan_review" | "provider_confirmation"
    | "owner_confirmation" | "site_observation" | "model_api_metadata";
  sourceRef: string;
  observedAt: string | null;
  scope: string;
  note: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  limitations?: string[];
}

export interface ClaimView<T extends string> {
  value: T | null;
  state: EvidenceState;
  evidenceIds: string[];
  asOf: string | null;
  label: string; // UI label, e.g. "Vacancy not verified"
}

export interface ModelRegionMatch {
  modelId: string;
  floorId: string;
  regionId: string;
  verified: boolean;
  evidenceIds: string[];
  reviewedBy: string | null;
  reviewedAt: string | null;
  notes: string[];
}

export interface EvidenceLedger {
  spaceId: string;
  evidenceVersion: number;
  match: ModelRegionMatch | null;
  entries: EvidenceEntry[];
}

export interface SpaceConditions {
  occupancy: ClaimView<"vacant" | "occupied">;
  furnishing: ClaimView<"unfurnished" | "partially_furnished" | "furnished">;
  clearedRegion: ClaimView<"cleared" | "not_cleared">;
  shortTermUse: ClaimView<"permitted" | "not_permitted">;
  scanFurniture: {
    modelId: string; regionId: string; capturedAt: string | null;
    observation: "furniture_visible" | "none_observed" | "unknown";
    coverage: "complete_for_scope" | "partial" | "unknown";
    evidenceIds: string[]; label: string;
  } | null;
  evidenceVersion: number;
}

export interface TenancyRef {
  id: number;
  fromDate: string | null;
  toDate: string | null;
  expirationReason: string | null;
}

export interface SpaceCandidate {
  id: string; // `${listingId}:${sourceSpaceId}` = marketed record, not unique premises
  listingId: number;
  sourceSpaceId: number;
  sourcePropertyId: number | null;
  propertyJoinStatus: "resolved" | "unresolved";
  listingType: string | null;
  displayName: string;
  address: string | null;
  city: string | null;
  researchMarketId: number | null;
  lat: number | null;
  lon: number | null;
  suite: string | null;
  floorName: string | null;
  propertyFloorId: number | null;
  isFullFloor: boolean | null;
  isExecutiveSuite: boolean | null;
  spaceUse: string | null;
  spaceType: string | null;
  listedAreaSqFt: number | null;
  listedAreaMinSqFt: number | null;
  availableOnDate: string | null;
  availabilityType: string | null;
  listingStatus: string | null;
  dateOnMarket: string | null;
  dateOffMarket: string | null;
  isInventoryOffMarket: boolean | null;
  isLeasePending: boolean | null;
  leaseTermType: string | null;
  leaseTermLow: number | null;
  leaseTermHigh: number | null;
  leaseTermThru: string | null;
  rate: {
    low: number | null; high: number | null;
    basis: "Monthly" | "Yearly" | "Unknown";
    serviceType: string | null;
    perUnit: "SF" | "Acre" | "SquareMeter" | "Unknown";
    currency: string | null;
  };
  floorPlanUri: string | null;
  ceilingHeightM: number | null; // property-level context only
  columnSpacingM: { width: number | null; depth: number | null } | null;
  hasBuildingColumns: boolean | null;
  driveInDoor: { widthM: number | null; heightM: number | null; count: number | null } | null;
  floorLoadPsf: number | null;
  monthsOnMarket: number | null;
  tenancyMatch: "suite" | "none";
  hasCurrentRecordedTenant: boolean | null;
  lastRecordedTenantLeftAt: string | null;
  lastTenancyExpirationReason: string | null;
  matchedTenancies: TenancyRef[];
  idleSignal: "strong" | "moderate" | "weak" | "unknown";
  idleNote: string | null;
  certifiedFreshDate: string | null;
  listingStatusUpdatedDate: string | null;
  matterportModelIds: string[];
  matterportLinkLevel: LinkLevel;
  source: "CoStar data kit";
  dataMode: "kit_snapshot";
  snapshotLabel: "Nov 2026";
  loadedAt: string;
  sourceRefs: Record<string, string>;
}
