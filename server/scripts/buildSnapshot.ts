// Builds the slim kit snapshot the public deployment ships with (server/kit-snapshot/), from the local CoStar kit.
// Same file layout as the kit so loadKit() reads it unchanged, but only active lease listings, the properties and
// tenancy records they reference, and only the fields ArtFit uses. People and companies are removed: no listing or
// property contacts, no brokerage name, no tenant names.
//   npm run snapshot -w server        (reads COSTAR_KIT_DIR from ../.env)
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const SRC = process.env.COSTAR_KIT_DIR ?? "";
const OUT = path.resolve(import.meta.dirname, "../kit-snapshot");
if (!SRC || !fs.existsSync(SRC)) { console.error(`COSTAR_KIT_DIR not found: ${SRC || "(unset)"}`); process.exit(2); }

async function* lines(file: string) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) yield JSON.parse(line);
}
const pick = (o: any, keys: string[]) => (o ? Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) : o);
const MATTERPORT_REF_TYPES = new Set([36, 234]);
const mpAttachments = (a: any[] | undefined) =>
  (a ?? []).filter((x) => MATTERPORT_REF_TYPES.has(x.videoExternalReferenceType)).map((x) => pick(x, ["videoExternalReferenceType", "videoKey"]));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "data"), { recursive: true });
fs.mkdirSync(path.join(OUT, "schemas"), { recursive: true });
fs.copyFileSync(path.join(SRC, "schemas", "enums.json"), path.join(OUT, "schemas", "enums.json"));

// Listings: active lease listings only, contacts and brokerage removed.
const SPACE_KEYS = ["id", "propertyId", "suite", "floorName", "propertyFloorId", "isFullFloor", "isExecutiveSuite", "spaceUse", "spaceType",
  "squareFeetMax", "squareFeetMin", "availableOnDate", "availabilityType", "dateOnMarket", "dateOffMarket", "isInventoryOffMarket",
  "isLeasePending", "leaseTermType", "leaseTermLow", "leaseTermHigh", "leaseTermThru", "rateLow", "rateHigh", "rateBasis", "serviceType",
  "monetaryUnit", "floorPlan"];
const needed = new Set<number>();
const listingOut: string[] = [];
for await (const l of lines(path.join(SRC, "data", "commercial-listing-summary.jsonl"))) {
  if (l.listingStatus !== 1 || !l.forLeaseSummary) continue;
  const spaces = (l.forLeaseSummary.spaces ?? []).map((s: any) => ({ ...pick(s, SPACE_KEYS), floorPlan: s.floorPlan?.attachmentUri ? { attachmentUri: s.floorPlan.attachmentUri } : undefined }));
  for (const s of spaces) { const pid = s.propertyId ?? l.propertyId; if (pid != null) needed.add(pid); }
  listingOut.push(JSON.stringify({
    ...pick(l, ["id", "listingStatus", "listingType", "propertyId", "buildingName", "certifiedFreshDate", "listingStatusUpdatedDate"]),
    attachments: mpAttachments(l.attachments),
    forLeaseSummary: { askingRateMeasurementType: l.forLeaseSummary.askingRateMeasurementType, spaces },
  }));
}
fs.writeFileSync(path.join(OUT, "data", "commercial-listing-summary.jsonl"), listingOut.join("\n") + "\n");

// Properties referenced by those listings: address and structural facts only.
const STRUCT = (b: any) => b && pick(b, ["structural", "driveInBays"]);
const propOut: string[] = [];
for await (const p of lines(path.join(SRC, "data", "commercial-property.jsonl"))) {
  if (!needed.has(p.id)) continue;
  propOut.push(JSON.stringify({
    id: p.id, propertyType: p.propertyType,
    primaryAddress: pick(p.primaryAddress, ["streetNumber", "streetNumberLow", "streetNumberHigh", "streetName", "streetType", "streetDirection", "streetPreDirection", "streetPostDirection",
      "addressLine1", "address", "city", "state", "postalCode", "researchMarketId", "latitude", "longitude", "buildingName"]),
    propertyOffice: STRUCT(p.propertyOffice), propertyRetail: STRUCT(p.propertyRetail), propertyIndustrial: STRUCT(p.propertyIndustrial), propertyFlex: STRUCT(p.propertyFlex),
    attachments: mpAttachments(p.attachments),
  }));
}
fs.writeFileSync(path.join(OUT, "data", "commercial-property.jsonl"), propOut.join("\n") + "\n");

// Tenancy records for those properties: dates and suite only (no tenant names).
const occOut: string[] = [];
for await (const t of lines(path.join(SRC, "data", "location-occupancy.jsonl"))) {
  if (!needed.has(t.propertyId)) continue;
  occOut.push(JSON.stringify({ id: t.id, propertyId: t.propertyId, fromDate: t.fromDate, toDate: t.toDate, expirationReason: t.expirationReason,
    spaces: (t.spaces ?? []).map((s: any) => ({ propertyFloorId: s.propertyFloorId, suite: s.suite })) }));
}
fs.writeFileSync(path.join(OUT, "data", "location-occupancy.jsonl"), occOut.join("\n") + "\n");

// Matterport model ids per referenced property.
const csv = fs.readFileSync(path.join(SRC, "commercial-properties.csv"), "utf8").split(/\r?\n/);
const head = csv[0].split(","), iP = head.indexOf("PropertyId"), iM = head.indexOf("MatterportModelId");
const rows = csv.slice(1).map((r) => r.split(",")).filter((r) => needed.has(Number(r[iP]))).map((r) => `${r[iP]},${r[iM] ?? ""}`);
fs.writeFileSync(path.join(OUT, "commercial-properties.csv"), ["PropertyId,MatterportModelId", ...rows].join("\n") + "\n");

console.log(`snapshot → ${OUT}\n  listings ${listingOut.length} · properties ${propOut.length} · tenancies ${occOut.length} · model rows ${rows.length}`);
