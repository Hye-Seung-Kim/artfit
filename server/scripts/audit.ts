import { loadKit } from "../src/adapters/costarKit.js";
const kit = await loadKit(process.env.COSTAR_KIT_DIR!, process.env.SNAPSHOT_REF_DATE ?? "2026-11-10");
const a = kit.audit;
const onMarket = kit.spaces.filter((s) => !s.candidate.dateOffMarket);
const c = (f: (s: (typeof kit.spaces)[number]) => boolean) => onMarket.filter(f).length;
console.log({ ...a, parseErrors: a.parseErrors.length, schemaAnomalies: a.schemaAnomalies.length });
console.log("on-market nested spaces", onMarket.length, "pending", c((s) => s.candidate.isLeasePending === true));
console.log("floor plan", c((s) => !!s.candidate.floorPlanUri), "exec", c((s) => s.candidate.isExecutiveSuite === true), "noAvailDate", c((s) => !s.candidate.availableOnDate));
console.log("unresolved property", c((s) => s.candidate.propertyJoinStatus === "unresolved"));
const nonPending = onMarket.filter((s) => s.candidate.isLeasePending !== true && s.candidate.dateOnMarket);
console.log("non-pending w/ dateOnMarket", nonPending.length, ">=12", nonPending.filter((s) => s.candidate.monthsOnMarket! >= 12).length, ">=36", nonPending.filter((s) => s.candidate.monthsOnMarket! >= 36).length);
const strong = nonPending.filter((s) => s.candidate.idleSignal === "strong");
console.log("strong", strong.length, "strong RFIO", strong.filter((s) => ["Retail", "Flex", "Industrial", "OfficeRetail"].includes(s.candidate.spaceUse!)).length);
const uses: Record<string, number> = {}; for (const s of onMarket) uses[s.candidate.spaceUse ?? "null"] = (uses[s.candidate.spaceUse ?? "null"] ?? 0) + 1; console.log(uses);
for (const id of ["20031202:18036295", "37287981:19233219"]) { const k = kit.byId.get(id)!; console.log(JSON.stringify({ ...k.candidate, sourceRefs: undefined }, null, 0), k.exclusions); }
