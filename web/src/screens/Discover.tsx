import { useEffect, useMemo, useState } from "react";
import { bbox, type SpatialAnnotation } from "@artfit/geometry";
import { api, monYear, type CandidateCard, type SearchResult } from "../api";

const IDLE_LABEL: Record<string, string> = { strong: "Strong long-idle signal", moderate: "Moderate long-idle signal", weak: "Weak long-idle signal", unknown: "Idle signal unknown" };
const AREA_LABEL: Record<string, string> = {
  passes_reported_area_screen: "Passes reported-area screen; geometry still needs evaluation", below_requested_footprint: "Below requested footprint on reported area",
  adjustment_pool: "Below preferred footprint; kept for clearance adjustment", area_unknown: "Reported area unknown",
};
const USE_LABELS: Record<string, string> = { OfficeRetail: "Office / retail", OfficeMedical: "Medical office" };
const STAGE_LABELS = { N: "Marketed records", M: "Matches brief", M1: "Area reviewed", K: "3D associated", V: "Spatially verified" };
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
  </svg> : <span className="faint">Loading traced floor plan…</span>}<span className="plan-preview-label">Traced geometry · match review shown below</span></div>;
}

export function SpaceCard({ c, onOpen, slot, featured = false }: { c: CandidateCard; onOpen?: () => void; slot?: string; featured?: boolean }) {
  return <article className="card space-card">
    <div className="space-title-row"><div><span className="space-type">{USE_LABELS[c.spaceUse ?? ""] ?? c.spaceUse ?? "Use not reported"}</span><h3>{c.displayName}</h3></div>{slot && <span className="catalogue-slot" aria-label={`Candidate ${slot}`}>{slot}</span>}</div>
    <p className="space-meta">{c.address ?? "Address not reported"}</p>
    {featured && c.hasAnnotation && <PlanPreview c={c} />}
    <div className="space-facts"><div><span className="fact-label">Advertised area</span><span className="space-area">{c.listedAreaSqFt != null ? c.listedAreaSqFt.toLocaleString() : "—"}<small>{c.listedAreaSqFt != null ? "SF" : "Not reported"}</small></span></div><div><span className="fact-label">Reported availability</span><span className="fact-value">{c.availableOnDate ? c.availableOnDate.slice(0, 10) : c.availabilityType ? `${c.availabilityType} · relative` : "Date not confirmed"}</span></div></div>
    <div className="space-evidence"><div><i className="evidence-dot" aria-hidden="true" /><span>{c.conditionLabels.occupancy}</span></div><div><i className="evidence-dot" aria-hidden="true" /><span>{c.conditionLabels.furniture}</span></div><div><i className="evidence-dot" aria-hidden="true" /><span>{c.matchVerified ? "Exact-space match reviewed" : c.matchProposed ? "Space match proposed; review needed" : "Exact-space match not reviewed"}</span></div></div>
    <details><summary>Listing &amp; condition evidence</summary><dl className="lines">
      <dt>Listing</dt><dd>{c.conditionLabels.listing}{c.certifiedFreshDate ? ` · certified ${c.certifiedFreshDate.slice(0, 10)}` : ""}</dd>
      <dt>Asking rent</dt><dd>{rateText(c.rate)}</dd><dt>Physical occupancy</dt><dd>{c.conditionLabels.occupancy}</dd><dt>Furniture</dt><dd>{c.conditionLabels.furniture}{c.isExecutiveSuite ? " · executive-suite cue only" : ""}</dd><dt>Cleared region</dt><dd>{c.conditionLabels.cleared}</dd><dt>Short-term use</dt><dd>{c.conditionLabels.shortTerm}</dd>
      <dt>Scan association</dt><dd>{c.matterportModelCount ? `${c.matterportModelCount} Matterport model(s) · ${c.matterportLinkLevel}-level link` : "No scan association"}</dd><dt>Area screen</dt><dd>{AREA_LABEL[c.areaScreen]}</dd>
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
  const vb = result.conditionBuckets.vacancyEvidence.N;
  const open = (id: string) => onOpen([id, ...traced.filter((t) => t.id !== id).map((t) => t.id)]);
  return <main className="page discover-page" id="main-content">
    <div className="discover-hero"><div><div className="eyebrow">02 / The space catalogue</div><h1>Room for<br />possibility.</h1></div><div className="discover-summary"><p>Places to imagine your exhibition. Explore the listing, examine the evidence, and look beyond square footage.</p><button className="text-button" onClick={onBack}>← Edit your brief</button></div></div>
    <div className="funnel" aria-label="Search filter counts">{(["N", "M", "M1", "K", "V"] as const).map((k) => <div className="stage" key={k}><div className="k">{k}</div><div className="n">{f[k].count.toLocaleString()}</div><div className="faint">{STAGE_LABELS[k]}</div></div>)}</div>
    <details className="data-audit"><summary>How these spaces were selected</summary><p className="faint">Counts are {result.countUnit}, computed for this brief. Snapshot reference date {result.snapshotRefDate}.</p><dl className="faint">{(["N", "M", "M1", "K", "V"] as const).map((k) => <div key={k}><dt><strong>{k}</strong></dt><dd>{f[k].label}</dd></div>)}</dl><div className="mono" style={{ whiteSpace: "pre-wrap" }}>{`Active lease listings: ${result.inputAudit.activeLeaseListings} · nested spaces: ${result.inputAudit.nestedSpaces}
Unresolved properties (outside N, never re-assigned): ${result.inputAudit.unresolvedPropertyBucket}
Excluded before N: ${JSON.stringify(result.inputAudit.exclusionReasons)}
N→M exclusions: ${JSON.stringify(f.M.reasons)} · unknown space use: ${f.M.useUnknownBucket}
M1 area screen: ${JSON.stringify(f.M1.areaScreen)}`}</div></details>
    <div className="condition-strip"><strong>Physical vacancy evidence</strong><span>{vb.qualifying} qualifying</span><span>{vb.needsVerification} need verification</span><span>{vb.mismatch} mismatch</span><span className="faint">{result.conditionBuckets.note}</span></div>
    {traced.length > 0 && <section className="catalogue-section" aria-labelledby="traced-heading"><div className="catalogue-heading"><div><div className="eyebrow">A closer look</div><h2 id="traced-heading">Spaces in the studio.</h2><p className="faint">Prepared geometry for a placement study. An exact-space match and annotation review are still required for a verified result.</p></div><button className="primary" onClick={() => onOpen(traced.map((c) => c.id))}>{traced.length > 1 ? `Compare ${traced.length} spaces` : "Open workspace"}<span aria-hidden="true">↗</span></button></div><div className="cards">{traced.map((c, i) => <SpaceCard key={c.id} c={c} featured slot={String.fromCharCode(65 + i)} onOpen={() => open(c.id)} />)}</div></section>}
    <section className="catalogue-section" aria-labelledby="all-leads-heading"><div className="catalogue-heading"><div><div className="eyebrow">The wider search</div><h2 id="all-leads-heading">All marketed spaces.</h2></div><div className="filter-tabs" role="group" aria-label="Filter spaces">{(["all", "scan", "traced"] as const).map((k) => <button key={k} aria-pressed={filter === k} className={filter === k ? "on" : ""} onClick={() => { setFilter(k); setLimit(12); }}>{k === "all" ? "All spaces" : k === "scan" ? "With a scan" : "Traced geometry"}</button>)}</div></div><p className="faint catalogue-help">Ranked by long-idle signal, then time on market. This is not evidence of current vacancy. Below-area leads remain available for review. Showing {shown.length} of {filtered.length} {filter === "all" ? "marketed records" : "matching records"}.</p>
      {shown.length ? <div className="cards">{shown.map((c) => <SpaceCard key={c.id} c={c} onOpen={c.hasAnnotation ? () => open(c.id) : undefined} />)}</div> : <div className="empty-state"><h3>No spaces in this selection.</h3><p className="muted">Try another view or edit your brief. Missing evidence never becomes a verified match.</p><button className="text-button" onClick={onBack}>Edit brief →</button></div>}
      {filtered.length > shown.length && <div className="load-more"><button onClick={() => setLimit((n) => n + 12)}>Show more spaces <span aria-hidden="true">↓</span></button></div>}
    </section>
  </main>;
}
