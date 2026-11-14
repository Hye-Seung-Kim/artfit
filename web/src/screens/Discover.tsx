import { useEffect, useMemo, useState } from "react";
import { bbox, type SpatialAnnotation } from "@artfit/geometry";
import { api, monYear, type CandidateCard, type SearchResult } from "../api";

const IDLE_LABEL: Record<string, string> = { strong: "Strong long-idle signal", moderate: "Moderate long-idle signal", weak: "Weak long-idle signal", unknown: "Idle signal unknown" };
const AREA_LABEL: Record<string, string> = {
  passes_reported_area_screen: "Passes reported-area screen; geometry still needs evaluation", below_requested_footprint: "Below requested footprint on reported area",
  adjustment_pool: "Below preferred footprint; kept for clearance adjustment", area_unknown: "Reported area unknown",
};
const USE_LABELS: Record<string, string> = { OfficeRetail: "Office / retail", OfficeMedical: "Medical office" };
const REASON_LABELS: Record<string, string> = {
  space_use_not_selected: "space use not in your selection", available_date_after_exhibition_start: "available only after your opening date",
  lease_pending: "lease pending", property_join_unresolved: "property record could not be resolved",
};
const reasonText = (r: Record<string, number> | undefined) => Object.entries(r ?? {}).filter(([, n]) => n > 0).map(([k, n]) => `${n.toLocaleString()} ${REASON_LABELS[k] ?? k.replace(/_/g, " ")}`).join(" · ");
const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
type Bucket = { qualifying: number; needsVerification: number; mismatch: number };
/** One sentence that respects what the evidence actually says across the matching listings. */
function conditionNote(v?: Bucket, f?: Bucket): string | null {
  if (!v || !f) return null;
  const total = v.qualifying + v.needsVerification + v.mismatch;
  if (total === 0) return null;
  if (v.qualifying + v.mismatch + f.qualifying + f.mismatch === 0) return "Current vacancy and furniture condition need confirmation.";
  return "Check vacancy and furniture details for each listing.";
}
const bucketText = (b: Bucket) => `${b.qualifying.toLocaleString()} with reviewed evidence · ${b.needsVerification.toLocaleString()} unconfirmed · ${b.mismatch.toLocaleString()} conflicting`;
function rateText(r: CandidateCard["rate"]) {
  if (r.low == null && r.high == null) return "Asking rate not given";
  const values = [r.low, r.high].filter((n): n is number => n != null);
  const value = values.length === 2 && values[0] !== values[1] ? values.join("–") : String(values[0]);
  return `${value} ${r.currency === "UnitedStatesDollar" ? "USD" : r.currency ?? "(currency unknown)"} / ${r.perUnit} / ${r.basis === "Yearly" ? "yr" : r.basis === "Monthly" ? "mo" : "period unknown"} · ${r.serviceType ?? "service type unknown"}`;
}

function PlanPreview({ c }: { c: CandidateCard }) {
  const [annotation, setAnnotation] = useState<SpatialAnnotation | null>(null);
  useEffect(() => {
    let current = true;
    api.geometry(c.id).then((g) => { if (current) setAnnotation(g.annotation); }).catch(() => {});
    return () => { current = false; };
  }, [c.id]);
  const bb = annotation?.floor.length ? bbox(annotation.floor) : null;
  const points = (p: { x: number; z: number }[]) => p.map((v) => `${v.x},${v.z}`).join(" ");
  const pad = bb ? Math.max(bb.maxX - bb.minX, bb.maxZ - bb.minZ) * .13 : 1;
  return <div className="plan-preview">{annotation && bb ? <svg viewBox={`${bb.minX - pad} ${bb.minZ - pad} ${bb.maxX - bb.minX + pad * 2} ${bb.maxZ - bb.minZ + pad * 2}`} role="img" aria-label={`Traced floor plan of ${c.displayName}`}>
    <polygon points={points(annotation.floor)} fill="#fff" stroke="#1b1e1b" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    {annotation.obstacles.map((o) => {
      const color = o.category === "entrance_zone" ? "#6bdcc5" : o.category === "uncertain_object" ? "#a9afa5" : "#4b5149";
      return o.shape.kind === "polygon" ? <polygon key={o.id} points={points(o.shape.poly)} fill={color} /> : <circle key={o.id} cx={o.shape.c.x} cy={o.shape.c.z} r={o.shape.r} fill={color} />;
    })}
  </svg> : <span className="faint">Loading traced floor plan…</span>}<span className="plan-preview-label">{c.spatiallyVerified ? "Reviewed geometry" : "Draft geometry · review required"}</span></div>;
}

export function SpaceCard({ c, onOpen, slot, featured = false }: { c: CandidateCard; onOpen?: () => void; slot?: string; featured?: boolean }) {
  return <article className="card space-card">
    <div className="space-title-row"><div><span className="space-type">{USE_LABELS[c.spaceUse ?? ""] ?? c.spaceUse ?? "Use not reported"}</span><h3>{c.displayName}</h3></div>{slot && <span className="catalogue-slot" aria-label={`Candidate ${slot}`}>{slot}</span>}</div>
    <p className="space-meta">{c.address ?? "Address not reported"}</p>
    {featured && c.hasAnnotation && <PlanPreview c={c} />}
    {featured && c.hasAnnotation && <p className={"geometry-status" + (c.spatiallyVerified ? " verified" : "")}>{c.spatiallyVerified ? "Spatially verified: exact unit match, reviewed tracing and scale check." : "Draft geometry · review required. Placement results here are exploratory until the unit match and tracing are reviewed."}</p>}
    <div className="space-facts"><div><span className="fact-label">Advertised area</span><span className="space-area">{c.listedAreaSqFt != null ? c.listedAreaSqFt.toLocaleString() : "—"}<small>{c.listedAreaSqFt != null ? "SF" : "Not reported"}</small></span></div><div><span className="fact-label">Reported availability</span><span className="fact-value">{c.availableOnDate ? c.availableOnDate.slice(0, 10) : c.availabilityType ? `${c.availabilityType} · relative` : "Date not confirmed"}</span></div></div>
    <div className="space-evidence"><div><i className="evidence-dot" aria-hidden="true" /><span>{c.conditionLabels.occupancy}</span></div><div><i className="evidence-dot" aria-hidden="true" /><span>{c.conditionLabels.furniture}</span></div><div><i className="evidence-dot" aria-hidden="true" /><span>{c.matchVerified ? "Exact-space match reviewed" : c.matchProposed ? "Space match proposed; review needed" : "Exact-space match not reviewed"}</span></div></div>
    <details><summary>Listing &amp; condition evidence</summary><dl className="lines">
      <dt>Listing</dt><dd>{c.conditionLabels.listing}{c.certifiedFreshDate ? ` · certified ${c.certifiedFreshDate.slice(0, 10)}` : ""}</dd>
      <dt>Asking rent</dt><dd>{rateText(c.rate)}</dd><dt>Physical occupancy</dt><dd>{c.conditionLabels.occupancy}</dd><dt>Furniture</dt><dd>{c.conditionLabels.furniture}{c.isExecutiveSuite ? " · executive-suite cue only" : ""}</dd><dt>Cleared region</dt><dd>{c.conditionLabels.cleared}</dd><dt>Short-term use</dt><dd>{c.conditionLabels.shortTerm}</dd>
      <dt>3D tour</dt><dd>{c.matterportModelCount ? `${plural(c.matterportModelCount, "linked Matterport tour", "linked Matterport tours")} · ${c.matterportLinkLevel === "building" ? "linked to the building, may not show this unit" : `${c.matterportLinkLevel}-level link`}` : "No linked 3D tour"}</dd><dt>Area screen</dt><dd>{AREA_LABEL[c.areaScreen]}</dd>
      <dt>Time on market</dt><dd>{c.monthsOnMarket != null ? `${Math.floor(c.monthsOnMarket)} months` : "Unknown"}{c.lastRecordedTenantLeftAt ? ` · last recorded tenant left ${monYear(c.lastRecordedTenantLeftAt)}` : c.tenancyMatch === "none" ? " · no matching tenancy record" : ""}<br />{IDLE_LABEL[c.idleSignal]} · ranking signal only.{c.idleNote ? ` ${c.idleNote}` : ""} Current vacancy is not verified.</dd>
    </dl></details>
    {onOpen && <button className={c.hasAnnotation ? "primary" : ""} onClick={onOpen}>{c.hasAnnotation ? "Open in workspace" : "Inspect space"}<span aria-hidden="true">↗</span></button>}
  </article>;
}

export default function Discover({ result, onOpen, onBack }: { result: SearchResult; onOpen: (ids: string[]) => void; onBack: () => void }) {
  const [filter, setFilter] = useState<"all" | "scan" | "traced">("all");
  const [limit, setLimit] = useState(12);
  const f = result.funnel;
  const traced = result.candidates.filter((c) => c.hasAnnotation);
  const filtered = useMemo(() => result.candidates.filter((c) => filter === "all" || (filter === "scan" ? c.matterportModelCount > 0 : c.hasAnnotation)), [result, filter]);
  const shown = filtered.slice(0, limit);
  const cond = conditionNote(result.conditionBuckets.vacancyEvidence.N, result.conditionBuckets.furnitureEvidence.N);
  const anyDraft = traced.some((c) => !c.spatiallyVerified);
  const allDraft = traced.length > 0 && traced.every((c) => !c.spatiallyVerified);
  const open = (id: string) => onOpen([id, ...traced.filter((t) => t.id !== id).map((t) => t.id)]);
  return <main className="page discover-page" id="main-content">
    <div className="discover-hero"><div><div className="eyebrow">02 / The space catalogue</div><h1>Room for<br />possibility.</h1></div><div className="discover-summary"><p>Places to imagine your exhibition. Explore the listing, examine the evidence, and look beyond square footage.</p><button className="text-button" onClick={onBack}>← Edit your brief</button></div></div>
    <section className="results-summary" aria-label="Search summary">
      <div className="summary-figures">
        <p><strong>{f.M.count.toLocaleString()}</strong><span>{f.M.count === 1 ? "listing matches your search" : "listings match your search"}</span></p>
        <p><strong>{f.K.count.toLocaleString()}</strong><span>{f.K.count === 1 ? "with a linked 3D tour" : "with linked 3D tours"}</span></p>
      </div>
      {cond && <p className="summary-note">{cond}</p>}
      <details className="data-audit"><summary>How these spaces were selected</summary>
        <ol className="selection-steps">
          <li><span className="step-n">{f.N.count.toLocaleString()}</span><div><strong>Lease listings in the {result.brief.city} research market</strong><p>Records marketed in the snapshot. {result.inputAudit.unresolvedPropertyBucket > 0 ? `${plural(result.inputAudit.unresolvedPropertyBucket, "listing was", "listings were")} left out because the property record could not be resolved.` : ""}</p></div></li>
          <li><span className="step-n">{f.M.count.toLocaleString()}</span><div><strong>Meet your basic search</strong><p>Your space uses and dates, excluding lease-pending listings.{reasonText(f.M.reasons) ? ` Left out: ${reasonText(f.M.reasons)}.` : ""}{f.M.useUnknownBucket ? ` ${plural(f.M.useUnknownBucket, "listing has", "listings have")} no reported space use.` : ""}</p></div></li>
          <li><span className="step-n">—</span><div><strong>Ordered by advertised area — nothing removed</strong><p>{f.M1.areaScreen ? `${(f.M1.areaScreen.passes_reported_area_screen ?? 0).toLocaleString()} at or above your footprint on paper · ${(f.M1.areaScreen.below_requested_footprint ?? 0).toLocaleString()} below it · ${(f.M1.areaScreen.adjustment_pool ?? 0).toLocaleString()} kept in case you reduce clearance. ` : ""}Advertised area is rounded and is not proof that the work fits.</p></div></li>
          <li><span className="step-n">{f.K.count.toLocaleString()}</span><div><strong>Have a linked 3D tour</strong><p>Linked tours may show the building rather than the listed unit.</p></div></li>
          <li><span className="step-n">{f.V.count.toLocaleString()}</span><div><strong>Spatial verification completed</strong><p>{f.V.count === 0 ? "No candidates have completed spatial verification yet." : `${plural(f.V.count, "candidate has", "candidates have")} completed spatial verification.`} Verification means the exact unit is matched to its scan and the traced floor, obstacles and scale are reviewed. It is not a count of layouts that fit.</p></div></li>
        </ol>
        <dl className="selection-gaps">
          <dt>Vacancy evidence</dt><dd>{bucketText(result.conditionBuckets.vacancyEvidence.N)}</dd>
          <dt>Furniture evidence</dt><dd>{bucketText(result.conditionBuckets.furnitureEvidence.N)}</dd>
          <dt>Why it’s unconfirmed</dt><dd>The listing data has no vacancy, furniture or cleared-floor fields. These stay unknown until reviewed evidence is recorded.</dd>
          <dt>About the counts</dt><dd>Counts are listing records, not confirmed unique or vacant spaces. Snapshot dated {result.snapshotRefDate}.</dd>
        </dl>
      </details>
    </section>
    {traced.length > 0 && <section className="catalogue-section" aria-labelledby="traced-heading"><div className="catalogue-heading"><div><div className="eyebrow">A closer look</div><h2 id="traced-heading">Spaces in the studio.</h2><p className="faint">{allDraft ? "Traced floor plans are ready for a placement study. Comparing them is exploratory; it doesn’t mean either space fits or has been verified." : anyDraft ? "Traced floor plans are ready for a placement study. Their review status differs, so check each space below; comparing them doesn’t mean they fit." : "Traced floor plans with completed spatial verification. A fit still depends on the placement study."}</p></div><button className="primary" onClick={() => onOpen(traced.map((c) => c.id))}>{traced.length > 1 ? `Compare ${traced.length} spaces` : "Open workspace"}<span aria-hidden="true">↗</span></button></div><div className="cards">{traced.map((c, i) => <SpaceCard key={c.id} c={c} featured slot={String.fromCharCode(65 + i)} onOpen={() => open(c.id)} />)}</div></section>}
    <section className="catalogue-section" aria-labelledby="all-leads-heading"><div className="catalogue-heading"><div><div className="eyebrow">The wider search</div><h2 id="all-leads-heading">All marketed spaces.</h2></div><div className="filter-tabs" role="group" aria-label="Filter spaces">{(["all", "scan", "traced"] as const).map((k) => <button key={k} aria-pressed={filter === k} className={filter === k ? "on" : ""} onClick={() => { setFilter(k); setLimit(12); }}>{k === "all" ? "All spaces" : k === "scan" ? "With a 3D tour" : "Traced geometry"}</button>)}</div></div><p className="faint catalogue-help">Ranked by long-idle signal, then time on market. This is not evidence of current vacancy. Below-area leads remain available for review. Showing {shown.length} of {filtered.length} {filter === "all" ? "marketed records" : "matching records"}.</p>
      {shown.length ? <div className="cards">{shown.map((c) => <SpaceCard key={c.id} c={c} onOpen={c.hasAnnotation ? () => open(c.id) : undefined} />)}</div> : <div className="empty-state"><h3>No spaces in this selection.</h3><p className="muted">Try another view or edit your brief. Missing evidence never becomes a verified match.</p><button className="text-button" onClick={onBack}>Edit brief →</button></div>}
      {filtered.length > shown.length && <div className="load-more"><button onClick={() => setLimit((n) => n + 12)}>Show more spaces <span aria-hidden="true">↓</span></button></div>}
    </section>
  </main>;
}
