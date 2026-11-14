// Copyable on-site verification checklist (spec §9.5). Plain text from deterministic state only.
import { fmtM } from "@artfit/geometry";
import type { EvalResult } from "../api";

export function buildChecklist(args: {
  inspect: any; result: EvalResult | null; brief: any; requiredC: number; selectedOption: string | null;
}): string {
  const { inspect, result, brief, requiredC, selectedOption } = args;
  const c = inspect.candidate;
  const a = inspect.annotation;
  const e = result?.evaluation;
  const L: string[] = [];
  const push = (s = "") => L.push(s);
  push(`ArtFit on-site checklist — ${c.displayName}`);
  push(`Preliminary plan, not a compliance certificate. Source: CoStar data kit (Nov 2026 snapshot), not live inventory.`);
  push();
  push("SOURCE");
  push(`- Listing ${c.listingId} · space ${c.sourceSpaceId} · property ${c.sourcePropertyId ?? "unresolved"}`);
  push(`- Address: ${c.address ?? "unknown"} (research market ${c.researchMarketId ?? "unknown"})`);
  push(`- Listing certified fresh: ${c.certifiedFreshDate?.slice(0, 10) ?? "unknown"} · status updated ${c.listingStatusUpdatedDate?.slice(0, 10) ?? "unknown"}`);
  push(`- Scan: Matterport ${inspect.match?.modelId ?? "none"} region ${inspect.match?.regionId ?? "none"} · capture date ${a?.scanCapturedAt ?? "unknown"}${a?.scanProcessedAt ? ` (processed ${a.scanProcessedAt.slice(0, 10)})` : ""}`);
  push(`- Exact suite-region match: ${inspect.matchVerified ? `confirmed by ${inspect.match?.reviewedBy}` : "NOT yet verified"}`);
  push();
  push("PHYSICAL CONDITION (separate claims)");
  push(`- Occupancy: ${inspect.conditions.occupancy.label}. Ask the listing broker/owner who can confirm the suite is physically unoccupied now AND for ${brief.exhibitionStart} → ${brief.exhibitionEnd}.`);
  push(`- Furniture: ${inspect.conditions.scanFurniture?.label ?? inspect.conditions.furnishing.label}. Coverage: ${a?.obstacleCoverage ?? "unknown"}.`);
  const movable = inspect.blockers.movable, uncertain = inspect.blockers.uncertain;
  push(`- Movable items traced: ${movable.length ? movable.map((m: any) => m.label ?? m.id).join(", ") : "none traced"} · uncertain objects: ${uncertain.length ? uncertain.map((m: any) => m.label ?? m.id).join(", ") : "none traced"}.`);
  push(`- Confirm what must stay, what could be moved, who is responsible, and re-check the actual cleared region on site. Permission is not completion.`);
  push(`- Scenario used: ${result?.scenario?.mode ?? "as_scanned"} (no furniture removal assumed).`);
  push();
  push("SPATIAL PLAN");
  push(`- Artwork ${brief.artwork.widthM} × ${brief.artwork.depthM} × ${brief.artwork.heightM} m (W×D×H); requested clearance ${requiredC} m${brief.minimumClearanceM != null ? `; your minimum ${brief.minimumClearanceM} m` : ""}.`);
  if (e?.selectedPose) push(`- Selected pose x=${e.selectedPose.x.toFixed(2)} z=${e.selectedPose.z.toFixed(2)} rot ${e.selectedPose.rotDeg}° · best clearance among tested placements ${fmtM(e.selectedPose.clearanceM)} m (rounded down), limited by ${e.selectedPose.limiterId}.`);
  else push(`- No valid placement found among tested positions.`);
  if (e) push(`- Tested ${e.sampledPositionCount} positions × ${e.rotationsDeg.length} orientations. Floor result: ${e.status}${e.exploratoryStatus ? ` (exploratory: ${e.exploratoryStatus})` : ""}; verification: ${e.geometryVerification}. Geometry v${result?.annotationVersion}, evidence v${result?.evidenceVersion}.`);
  if (selectedOption) push(`- Selected option: ${selectedOption}`);
  if (e?.unknowns.length) push(`- Remaining spatial unknowns: ${e.unknowns.join(", ")}`);
  push();
  push("LOAD-IN AND BUILDING");
  push(`- Local minimum clear height (beams, ducts, lights) over the placement: ${a?.ceilingHeightM != null ? `${a.ceilingHeightM} m measured` : "NOT measured"}. Property ceiling (context only): ${c.ceilingHeightM != null ? `${c.ceilingHeightM.toFixed(2)} m` : "unknown"}.`);
  push(`- Load-in route: actual clear door sizes, turns, lifts. Property drive-in door (context): ${c.driveInDoor?.widthM ? `${c.driveInDoor.widthM.toFixed(2)} × ${c.driveInDoor.heightM?.toFixed(2)} m` : "unknown"}.`);
  push(`- Artwork weight vs local floor load (property value: ${c.floorLoadPsf ?? "unknown"} psf, info only); power if needed; installation/fixing permissions.`);
  push();
  push("LEASE AND USE");
  push(`- Short-term availability for start AND end dates; listed availability: ${c.availableOnDate?.slice(0, 10) ?? c.availabilityType ?? "not reported"}; lease term ${c.leaseTermLow ?? "?"}–${c.leaseTermHigh ?? "?"} ${c.leaseTermType ?? ""}.`);
  push(`- Allowed exhibition use: ${inspect.conditions.shortTermUse.label}.`);
  push(`- Actual temporary-use quote. Asking rate (original units): ${c.rate.low ?? "n/a"}${c.rate.high && c.rate.high !== c.rate.low ? `–${c.rate.high}` : ""} ${c.rate.currency ?? ""} per ${c.rate.perUnit} ${c.rate.basis}, ${c.rate.serviceType ?? ""}. Short-term exhibition cost not confirmed.`);
  return L.join("\n");
}
