// ArtFit internal contracts (spec §4). None of these are CoStar or Matterport API fields.
// All lengths are meters. Coordinate system: Showcase SDK floor plane (x, z), y up.

export type LinkLevel = "space" | "building" | "unknown";
export type Verification = "Verified" | "PotentialFit" | "Unknown";
export type Check = "pass" | "fail" | "unknown";
export type Vec2 = { x: number; z: number };
export type Polygon = Vec2[]; // simple, implicitly closed, CCW after normalization
export interface Artwork { widthM: number; depthM: number; heightM: number }

/** One work in the exhibition (group show). Real size; clearanceM null = use the brief's preferred clearance. */
export interface BriefWork { id: string; title: string; artist: string; widthM: number; depthM: number; heightM: number; clearanceM: number | null; required: boolean }

export interface ExhibitionBrief {
  city: "Los Angeles" | "Houston"; // legacy key; UI says research market
  exhibitionStart: string;
  exhibitionEnd: string;
  budget: number | null;
  budgetCurrency: string;
  /** The work used for search screening and the single-work studio: the largest footprint among `works`. */
  artwork: Artwork;
  /** All works in the exhibition (1 = solo). Search never treats their combined area as a fit result. */
  works?: BriefWork[];
  preferredClearanceM: number;
  minimumClearanceM: number | null; // null = NOT specified, never auto-zero
  spaceUsePreferences: string[];
  conditions: {
    requireVerifiedVacant: boolean;
    requireVerifiedUnfurnished: boolean;
    requireVerifiedClearedRegion: boolean;
    evidenceAsOf: string;
    clearedRegionScope: "matched_candidate_region";
  };
}

export type ObstacleCategory =
  | "column" | "fixed_fixture" | "entrance_zone" | "restricted"
  | "movable_furniture" | "uncertain_object";

export type ObstacleShape =
  | { kind: "polygon"; poly: Polygon }
  | { kind: "circle"; c: Vec2; r: number };

export interface Obstacle {
  id: string;
  label?: string;
  category: ObstacleCategory;
  shape: ObstacleShape;
  mobility: "permanent" | "reviewed_movable" | "unknown";
  evidenceIds: string[];
  removalPermissionEvidenceIds: string[];
  removalCompletionEvidenceIds: string[];
  reviewNote: string;
  heightM?: number | null; // display only (planning view extrusion)
}

export interface ScaleCheck {
  referenceLabel: string;
  measuredM: number;
  expectedM: number;
  evidenceIds: string[];
  acceptedToleranceM: number;
  passed: boolean;
}

export interface SpatialAnnotation {
  annotationId: string;
  spaceId: string;
  modelId: string;
  floorId: string;
  regionId: string;
  coordinateSystem: "showcase_sdk_xz_m";
  floorElevationY: number;
  floor: Polygon;
  obstacles: Obstacle[];
  walls?: { a: Vec2; b: Vec2; thicknessM: number }[]; // display only
  ceilingHeightM: number | null;
  ceilingEvidenceIds: string[];
  scaleCheck: ScaleCheck | null;
  obstacleCoverage: "reviewed_complete_for_region" | "partial" | "unknown";
  coverageNotes: string[];
  annotationVerified: boolean;
  annotationMethod: "manual_sdk_pointer_trace" | "model_api_assisted_draft";
  annotatedBy: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  version: number;
  annotatedAt: string;
  scanCapturedAt: string | null;
  scanProcessedAt?: string | null; // Matterport processing time; NOT capture time
}

export interface PlacementScenario {
  id: string;
  version: number;
  mode: "as_scanned" | "hypothetical_furniture_removal";
  removedObstacleIds: string[];
  selectedBy: "user" | "default";
  assumptions: string[];
}

export interface Pose { x: number; z: number; rotDeg: number }
export interface PoseResult extends Pose {
  clearanceM: number;
  limiterId: string;
  limiterPoint: Vec2; // nearest point on the limiter
  artworkPoint: Vec2; // nearest point on the artwork
}

export interface ScanSettings {
  gridStepM: number;
  rotationsDeg: number[];
}

export interface ScanResult {
  spaceId: string;
  annotationId: string;
  modelId: string;
  regionId: string;
  geometryVersion: number;
  scenarioId: string;
  scenarioVersion: number;
  activeObstacleHash: string;
  artwork: { widthM: number; depthM: number };
  gridOrigin: Vec2;
  gridStepM: number;
  rotationsDeg: number[];
  sampledPositionCount: number;
  testedCount: number;
  validCount: number;
  poses: PoseResult[];
  bestPose: PoseResult | null;
  bestSampledClearanceM: number | null;
  attemptPose: Pose | null; // a real tested invalid pose closest to the floor centroid (display only)
  attemptReason: string | null;
  scanDurationMs: number;
  rulesVersion: string;
  scanKey: string;
}

export interface Evaluation {
  spaceId: string;
  scenarioId: string;
  scenarioVersion: number;
  geometryVersion: number;
  evidenceVersion: number;
  requiredClearanceM: number;
  passCount: number;
  status: "fit" | "conflict" | "unknown";
  exploratoryStatus: "fit" | "conflict" | null; // calculation outside the unit verdict when identity unverified
  selectedPose: PoseResult | null;
  displayAttemptPose: Pose | null;
  heightCheck: Check;
  accessCheck: Check;
  geometryVerification: Verification;
  conditional: boolean;
  conditionEligibility: "satisfies_requested_evidence" | "needs_verification" | "fails";
  failedConstraints: string[];
  unknowns: string[];
  evidenceIds: string[];
  scanKey: string;
  testedCount: number;
  sampledPositionCount: number;
  rotationsDeg: number[];
  bestSampledClearanceM: number | null;
}
