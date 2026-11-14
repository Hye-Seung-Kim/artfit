// Local CoStar data-kit adapter (spec §5.0, §4.3). Raw kit records are read-only and never redistributed.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { M_PER_FT } from "@artfit/geometry";
import type { SpaceCandidate, TenancyRef } from "../types.js";

export const ALLOWED_LEASE_TYPES = new Set([14, 16, 17, 19, 20, 21, 28]);
export const MARKETS: Record<string, number> = { Houston: 14, "Los Angeles": 20 };
const MATTERPORT_REF_TYPES = new Set([36, 234]);

export class KitError extends Error {
  constructor(message: string, public file?: string) { super(message); }
}

type Enums = Record<string, Record<string, string>>;

export interface KitAudit {
  listingsRead: number;
  activeLeaseListings: number;
  nestedSpaces: number;
  onMarketSpaces: number;
  pendingSpaces: number;
  disallowedListingType: number;
  unresolvedPropertySpaces: number;
  duplicateKeys: number;
  parseErrors: { file: string; line: number; message: string }[];
  schemaAnomalies: string[];
  propertiesLoaded: number;
  tenanciesIndexed: number;
  modelRows: number;
  snapshotRefDate: string;
  loadedAt: string;
  loadMs: number;
}

/** Raw-ish space record kept with its exclusion reasons; funnel stages are computed per request. */
export interface KitSpace {
  candidate: SpaceCandidate;
  exclusions: string[]; // N-stage reason codes (independent)
}

export interface Kit {
  dir: string;
  enums: Enums;
  spaces: KitSpace[];
  byId: Map<string, KitSpace>;
  audit: KitAudit;
}

async function* jsonl(file: string): AsyncGenerator<{ rec: any; line: number } | { error: string; line: number }> {
  if (!fs.existsSync(file)) throw new KitError(`Kit file not found: ${file}`, file);
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    n++;
    if (!line.trim()) continue;
    try { yield { rec: JSON.parse(line), line: n }; } catch (e) { yield { error: (e as Error).message, line: n }; }
  }
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); rows.push(row); row = []; cur = "";
    } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

/** Suite normalization for the tenancy join (spec §5.5). */
export function normalizeSuite(s: string | null | undefined): string {
  if (!s) return "";
  return s.toLowerCase().trim()
    .replace(/#/g, " ")
    .replace(/\b(suite|ste\.?|unit)(?=\s|\d|$)/g, " ")
    .replace(/\bste\./g, " ")
    .replace(/\s+/g, " ").trim();
}

export const monthsBetween = (fromIso: string, refIso: string) =>
  (Date.parse(refIso) - Date.parse(fromIso)) / 86400000 / 30.44;

/** Ceiling conversion (spec §4.3): whole feet + remainder inches; missing inches = exact feet. */
export function ceilingMeters(feet: number | null | undefined, inches: number | null | undefined): number | null {
  if (feet == null && inches == null) return null;
  return (feet ?? 0) * M_PER_FT + (inches ?? 0) * 0.0254;
}

export function decode(enums: Enums, name: string, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const t = enums[name];
  if (!t) return `Unrecognized(${name}:${String(v)})`;
  return t[String(v)] ?? `Unrecognized(${String(v)})`;
}

function addrLine(a: any): string | null {
  if (!a) return null;
  const parts = [a.streetNumber, a.streetName, a.streetType].filter(Boolean).join(" ");
  return parts || null;
}

export interface IdleInput { dateOnMarket: string | null; propertyId: number | null; propertyFloorId: number | null; suite: string | null }
export interface TenancyIndexRec { id: number; fromDate: string | null; toDate: string | null; expirationReason: number | null; spaces: { propertyFloorId: number | null; suite: string | null }[] }

/** Long-idle signal (spec §5.5) — ranking only, never vacancy. Uses fixed SNAPSHOT_REF_DATE, never the clock. */
export function idleSignalOf(sp: IdleInput, tenancies: TenancyIndexRec[] | undefined, refDate: string, enums: Enums) {
  const months = sp.dateOnMarket ? monthsBetween(sp.dateOnMarket, refDate) : null;
  const ns = normalizeSuite(sp.suite);
  const matched = ns && sp.propertyFloorId != null
    ? (tenancies ?? []).filter((t) => t.spaces.some((s) => s.propertyFloorId === sp.propertyFloorId && normalizeSuite(s.suite) !== "" && normalizeSuite(s.suite) === ns))
    : [];
  const tenancyMatch: "suite" | "none" = matched.length ? "suite" : "none";
  const hasCurrent = matched.length ? matched.some((t) => t.toDate == null) : null;
  const ended = matched.filter((t) => t.toDate != null).sort((a, b) => Date.parse(b.toDate!) - Date.parse(a.toDate!));
  const lastLeft = ended[0]?.toDate ?? null;
  let idleSignal: SpaceCandidate["idleSignal"];
  let idleNote: string | null = null;
  if (months === null) idleSignal = "unknown";
  else if (months >= 12 && tenancyMatch === "suite" && !hasCurrent && lastLeft) idleSignal = "strong";
  else if (months >= 12 && tenancyMatch === "none") idleSignal = "moderate";
  else {
    idleSignal = "weak";
    if (hasCurrent) idleNote = "recorded tenant still listed";
  }
  const refs: TenancyRef[] = matched.map((t) => ({ id: t.id, fromDate: t.fromDate, toDate: t.toDate, expirationReason: decode(enums, "LocationOccupancyExpirationReason", t.expirationReason) }));
  return {
    monthsOnMarket: months, tenancyMatch, hasCurrentRecordedTenant: hasCurrent, lastRecordedTenantLeftAt: lastLeft,
    lastTenancyExpirationReason: ended[0] ? decode(enums, "LocationOccupancyExpirationReason", ended[0].expirationReason) : null,
    matchedTenancies: refs, idleSignal, idleNote,
  };
}

export async function loadKit(dir: string, refDate: string): Promise<Kit> {
  const t0 = Date.now();
  if (!dir || !fs.existsSync(dir)) throw new KitError(`COSTAR_KIT_DIR does not exist: ${dir || "(unset)"}`);
  const enumsFile = path.join(dir, "schemas", "enums.json");
  if (!fs.existsSync(enumsFile)) throw new KitError("schemas/enums.json missing from kit", enumsFile);
  const enums: Enums = JSON.parse(fs.readFileSync(enumsFile, "utf8"));
  const loadedAt = new Date().toISOString();
  const audit: KitAudit = {
    listingsRead: 0, activeLeaseListings: 0, nestedSpaces: 0, onMarketSpaces: 0, pendingSpaces: 0,
    disallowedListingType: 0, unresolvedPropertySpaces: 0, duplicateKeys: 0, parseErrors: [], schemaAnomalies: [],
    propertiesLoaded: 0, tenanciesIndexed: 0, modelRows: 0, snapshotRefDate: refDate, loadedAt, loadMs: 0,
  };

  // 1. Matterport model set per property (not a single overwritten model).
  const csvFile = path.join(dir, "commercial-properties.csv");
  if (!fs.existsSync(csvFile)) throw new KitError("commercial-properties.csv missing", csvFile);
  const rows = parseCsv(fs.readFileSync(csvFile, "utf8"));
  const header = rows[0];
  const iP = header.indexOf("PropertyId"), iM = header.indexOf("MatterportModelId");
  const modelsByProperty = new Map<number, Set<string>>();
  for (const r of rows.slice(1)) {
    if (r.length < 2) continue;
    const pid = Number(r[iP]);
    if (!Number.isFinite(pid)) continue;
    if (!modelsByProperty.has(pid)) modelsByProperty.set(pid, new Set());
    if (r[iM]) { modelsByProperty.get(pid)!.add(r[iM]); audit.modelRows++; }
  }

  // 2. Listings → raw spaces.
  type Raw = { l: any; s: any; propertyId: number | null; listingModelKeys: Set<string> };
  const raws: Raw[] = [];
  const listingFile = path.join(dir, "data", "commercial-listing-summary.jsonl");
  for await (const r of jsonl(listingFile)) {
    if ("error" in r) { audit.parseErrors.push({ file: "commercial-listing-summary.jsonl", line: r.line, message: r.error }); continue; }
    const l = r.rec;
    audit.listingsRead++;
    const fl = l.forLeaseSummary;
    if (l.listingStatus !== 1 || !fl) continue;
    audit.activeLeaseListings++;
    const listingModelKeys = new Set<string>(
      (l.attachments ?? []).filter((a: any) => MATTERPORT_REF_TYPES.has(a.videoExternalReferenceType) && a.videoKey).map((a: any) => a.videoKey as string),
    );
    for (const s of fl.spaces ?? []) {
      audit.nestedSpaces++;
      // Property identity (spec §4.3): space propertyId first; listing propertyId only when the space has none.
      const propertyId: number | null = s.propertyId ?? l.propertyId ?? null;
      raws.push({ l, s, propertyId, listingModelKeys });
    }
  }

  // 3. Properties: retain only referenced IDs.
  const needed = new Set(raws.map((r) => r.propertyId).filter((x): x is number => x != null));
  const props = new Map<number, any>();
  for await (const r of jsonl(path.join(dir, "data", "commercial-property.jsonl"))) {
    if ("error" in r) { audit.parseErrors.push({ file: "commercial-property.jsonl", line: r.line, message: r.error }); continue; }
    if (needed.has(r.rec.id)) {
      const p = r.rec;
      props.set(p.id, {
        id: p.id, primaryAddress: p.primaryAddress, propertyType: p.propertyType,
        propertyOffice: p.propertyOffice, propertyRetail: p.propertyRetail, propertyIndustrial: p.propertyIndustrial, propertyFlex: p.propertyFlex,
        attachments: (p.attachments ?? []).filter((a: any) => MATTERPORT_REF_TYPES.has(a.videoExternalReferenceType)).map((a: any) => a.videoKey),
        buildingName: p.primaryAddress?.buildingName ?? null,
      });
    }
  }
  audit.propertiesLoaded = props.size;

  // 4. Tenancy index for referenced properties.
  const tenancies = new Map<number, TenancyIndexRec[]>();
  for await (const r of jsonl(path.join(dir, "data", "location-occupancy.jsonl"))) {
    if ("error" in r) { audit.parseErrors.push({ file: "location-occupancy.jsonl", line: r.line, message: r.error }); continue; }
    const t = r.rec;
    if (!needed.has(t.propertyId)) continue;
    if (!tenancies.has(t.propertyId)) tenancies.set(t.propertyId, []);
    tenancies.get(t.propertyId)!.push({
      id: t.id, fromDate: t.fromDate ?? null, toDate: t.toDate ?? null, expirationReason: t.expirationReason ?? null,
      spaces: (t.spaces ?? []).map((s: any) => ({ propertyFloorId: s.propertyFloorId ?? null, suite: s.suite ?? null })),
    });
    audit.tenanciesIndexed++;
  }

  // 5. Normalize candidates.
  const spaces: KitSpace[] = [];
  const byId = new Map<string, KitSpace>();
  for (const { l, s, propertyId, listingModelKeys } of raws) {
    const id = `${l.id}:${s.id}`;
    if (byId.has(id)) { audit.duplicateKeys++; continue; }
    const p = propertyId != null ? props.get(propertyId) : undefined;
    const exclusions: string[] = [];
    if (!ALLOWED_LEASE_TYPES.has(l.listingType)) { exclusions.push("listing_type_not_indoor_commercial_lease"); audit.disallowedListingType++; }
    if (s.dateOffMarket) exclusions.push("space_off_market");
    if (s.isInventoryOffMarket === true) exclusions.push("inventory_off_market");
    if (!p) { exclusions.push("property_join_unresolved"); audit.unresolvedPropertySpaces++; }
    if (!s.dateOffMarket) audit.onMarketSpaces++;
    if (s.isLeasePending === true && !s.dateOffMarket) audit.pendingSpaces++;

    const struct = p ? (p.propertyIndustrial?.structural ?? p.propertyFlex?.structural ?? p.propertyRetail?.structural ?? p.propertyOffice?.structural ?? null) : null;
    const driveBlk = p ? (p.propertyIndustrial?.driveInBays ?? p.propertyFlex?.driveInBays ?? null) : null;
    // Models: property set from CSV, plus listing attachments joined on (propertyId, modelId) together.
    const propModels = propertyId != null ? modelsByProperty.get(propertyId) ?? new Set<string>() : new Set<string>();
    const models = new Set<string>(propModels);
    if (propertyId != null && l.propertyId === propertyId) for (const k of listingModelKeys) if (propModels.has(k)) models.add(k);

    const idle = idleSignalOf({ dateOnMarket: s.dateOnMarket ?? null, propertyId, propertyFloorId: s.propertyFloorId ?? null, suite: s.suite ?? null },
      propertyId != null ? tenancies.get(propertyId) : undefined, refDate, enums);
    const rateLow = s.rateLow && s.rateLow > 0 ? s.rateLow : null; // 0 = no rate given (kit doc)
    const rateHigh = s.rateHigh && s.rateHigh > 0 ? s.rateHigh : null;
    const measure = decode(enums, "MeasurementUnit2", l.forLeaseSummary?.askingRateMeasurementType);
    const perUnit = measure === "SquareFeet" ? "SF" : measure === "Acres" ? "Acre" : measure === "SquareMeters" ? "SquareMeter" : "Unknown";
    const basis = decode(enums, "RateBasis", s.rateBasis);
    const currency = s.monetaryUnit ? decode(enums, "MonetaryUnit", s.monetaryUnit) : null; // space's own unit; 0/missing stays null
    const addr = p?.primaryAddress;
    const cand: SpaceCandidate = {
      id, listingId: l.id, sourceSpaceId: s.id, sourcePropertyId: propertyId,
      propertyJoinStatus: p ? "resolved" : "unresolved",
      listingType: decode(enums, "ListingType", l.listingType),
      displayName: [addrLine(addr) ?? l.buildingName ?? `Property ${propertyId}`, s.suite ? `Suite ${s.suite}` : null].filter(Boolean).join(" · "),
      address: addr ? [addrLine(addr), addr.city, addr.state].filter(Boolean).join(", ") : null,
      city: addr?.city ?? null, researchMarketId: addr?.researchMarketId ?? null,
      lat: addr?.latitude ?? null, lon: addr?.longitude ?? null,
      suite: s.suite ?? null, floorName: decode(enums, "FloorName", s.floorName), propertyFloorId: s.propertyFloorId ?? null,
      isFullFloor: s.isFullFloor ?? null, isExecutiveSuite: s.isExecutiveSuite ?? null,
      spaceUse: decode(enums, "SpaceUse", s.spaceUse), spaceType: decode(enums, "SpaceType", s.spaceType),
      listedAreaSqFt: typeof s.squareFeetMax === "number" && s.squareFeetMax > 0 ? s.squareFeetMax : null,
      listedAreaMinSqFt: typeof s.squareFeetMin === "number" && s.squareFeetMin > 0 ? s.squareFeetMin : null,
      availableOnDate: s.availableOnDate ?? null,
      availabilityType: s.availableOnDate ? null : (s.availabilityType ? decode(enums, "AvailabilityType", s.availabilityType) : null),
      listingStatus: decode(enums, "ListingStatus", l.listingStatus),
      dateOnMarket: s.dateOnMarket ?? null, dateOffMarket: s.dateOffMarket ?? null,
      isInventoryOffMarket: s.isInventoryOffMarket ?? null, isLeasePending: s.isLeasePending ?? null,
      leaseTermType: decode(enums, "LeaseTermType", s.leaseTermType),
      leaseTermLow: s.leaseTermLow ?? null, leaseTermHigh: s.leaseTermHigh ?? null, leaseTermThru: s.leaseTermThru ?? null,
      rate: {
        low: rateLow, high: rateHigh,
        basis: rateLow == null && rateHigh == null ? "Unknown" : basis === "Monthly" || basis === "Yearly" ? basis : "Unknown",
        serviceType: decode(enums, "ServiceType", s.serviceType),
        perUnit, currency,
      },
      floorPlanUri: s.floorPlan?.attachmentUri ?? null,
      ceilingHeightM: struct ? ceilingMeters(struct.ceilingHeightFeet, struct.ceilingHeightInches) : null,
      columnSpacingM: struct && (struct.columnWidthFeet != null || struct.columnDepthFeet != null)
        ? { width: struct.columnWidthFeet != null ? struct.columnWidthFeet * M_PER_FT : null, depth: struct.columnDepthFeet != null ? struct.columnDepthFeet * M_PER_FT : null }
        : null,
      hasBuildingColumns: struct?.hasBuildingColumns ?? null,
      driveInDoor: driveBlk ? {
        widthM: driveBlk.numFeetWide != null ? driveBlk.numFeetWide * M_PER_FT : null,
        heightM: driveBlk.numFeetHigh != null ? driveBlk.numFeetHigh * M_PER_FT : null,
        count: driveBlk.numDriveInBays ?? null,
      } : null,
      floorLoadPsf: struct?.floorLoadPoundsPerSquareFoot ?? null,
      ...idle,
      certifiedFreshDate: l.certifiedFreshDate ?? null, listingStatusUpdatedDate: l.listingStatusUpdatedDate ?? null,
      matterportModelIds: [...models].sort(),
      matterportLinkLevel: models.size ? "building" : "unknown", // provider association is property/listing level, never suite
      source: "CoStar data kit", dataMode: "kit_snapshot", snapshotLabel: "Nov 2026", loadedAt,
      sourceRefs: {
        listing: `data/commercial-listing-summary.jsonl#id=${l.id}`,
        space: `data/commercial-listing-summary.jsonl#id=${l.id} forLeaseSummary.spaces[id=${s.id}]`,
        property: propertyId != null ? `data/commercial-property.jsonl#id=${propertyId}` : "unresolved",
        models: `commercial-properties.csv PropertyId=${propertyId}`,
        rateAreaBasis: "forLeaseSummary.askingRateMeasurementType (listing level)",
        tenancies: `data/location-occupancy.jsonl propertyId=${propertyId}`,
      },
    };
    if (s.availableOnDate && s.availabilityType) audit.schemaAnomalies.push(`${id}: both availableOnDate and availabilityType set`);
    const ks: KitSpace = { candidate: cand, exclusions };
    spaces.push(ks);
    byId.set(id, ks);
  }
  audit.loadMs = Date.now() - t0;
  return { dir, enums, spaces, byId, audit };
}
