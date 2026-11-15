import { useEffect, useMemo, useRef, useState } from "react";
import { bbox, type SpatialAnnotation } from "@artfit/geometry";
import type { ExhibitionBrief } from "@artfit/geometry";
import { api, monYear, type CandidateCard, type SearchResult } from "../api";
import { largestWork, worksOf } from "./Brief";

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

function PlanPreview({ c, onOpen }: { c: CandidateCard; onOpen?: () => void }) {
  const [annotation, setAnnotation] = useState<SpatialAnnotation | null>(null);
  useEffect(() => {
    let current = true;
    api.geometry(c.id).then((g) => { if (current) setAnnotation(g.annotation); }).catch(() => {});
    return () => { current = false; };
  }, [c.id]);
  const bb = annotation?.floor.length ? bbox(annotation.floor) : null;
  const points = (p: { x: number; z: number }[]) => p.map((v) => `${v.x},${v.z}`).join(" ");
  const pad = bb ? Math.max(bb.maxX - bb.minX, bb.maxZ - bb.minZ) * .13 : 1;
  const Tag = onOpen ? "button" : "div";
  return <Tag className={"plan-preview" + (onOpen ? " plan-open" : "")} {...(onOpen ? { type: "button" as const, onClick: onOpen, "aria-label": `Open ${c.displayName} in 3D` } : {})}>{annotation && bb ? <svg viewBox={`${bb.minX - pad} ${bb.minZ - pad} ${bb.maxX - bb.minX + pad * 2} ${bb.maxZ - bb.minZ + pad * 2}`} role="img" aria-label={`Traced floor plan of ${c.displayName}`}>
    <polygon className="plan-floor" points={points(annotation.floor)} fill="#fff" stroke="#1b1e1b" strokeWidth={(Math.max(bb.maxX - bb.minX, bb.maxZ - bb.minZ) + pad * 2) / 420} strokeLinejoin="round" pathLength={1} />
    {annotation.obstacles.map((o) => {
      const color = o.category === "entrance_zone" ? "#6bdcc5" : o.category === "uncertain_object" ? "#a9afa5" : "#4b5149";
      return o.shape.kind === "polygon" ? <polygon key={o.id} className="plan-obstacle" points={points(o.shape.poly)} fill={color} /> : <circle key={o.id} className="plan-obstacle" cx={o.shape.c.x} cy={o.shape.c.z} r={o.shape.r} fill={color} />;
    })}
  </svg> : <span className="faint">Loading traced floor plan…</span>}<span className="plan-preview-label">{c.spatiallyVerified ? "Reviewed geometry" : "Draft geometry · review required"}</span>{onOpen && <span className="plan-open-cue" aria-hidden="true">Open in 3D →</span>}</Tag>;
}

/** How the listing compares with the works ON PAPER (listed area and building-level ceiling). Never a fit verdict. */
function paperFit(c: CandidateCard, tallestM: number, group: boolean) {
  const who = group ? "your largest work" : "your work";
  const lines: { text: string; tone: "ok" | "warn" | "unknown" }[] = [];
  const need = Math.round(c.requiredAreaM2), listed = c.listedAreaM2 != null ? Math.round(c.listedAreaM2) : null;
  if (c.areaScreen === "passes_reported_area_screen") lines.push({ tone: "ok", text: `Room on paper for ${who}: needs about ${need} m² with viewing room; ${listed} m² listed.` });
  else if (c.areaScreen === "adjustment_pool") lines.push({ tone: "warn", text: `Fits on paper only with your minimum clearance (${listed} m² listed; about ${need} m² preferred).` });
  else if (c.areaScreen === "below_requested_footprint") lines.push({ tone: "warn", text: `Smaller on paper than ${who} needs: about ${need} m² with viewing room; ${listed} m² listed.` });
  else lines.push({ tone: "unknown", text: "Listed area not reported." });
  const h = c.ceilingHeightM;
  if (c.heightContext === "listed_below_tallest") lines.push({ tone: "warn", text: `Listed ceiling ${h!.toFixed(2)} m is lower than your tallest work (${tallestM} m).` });
  else if (c.heightContext === "listed_tight") lines.push({ tone: "warn", text: `Listed ceiling ${h!.toFixed(2)} m leaves under 0.5 m above your tallest work (${tallestM} m).` });
  else if (c.heightContext === "listed_clears") lines.push({ tone: "ok", text: `Listed ceiling ${h!.toFixed(2)} m clears your tallest work (${tallestM} m) — a building figure; check right above the spot.` });
  else lines.push({ tone: "unknown", text: "Ceiling height not listed." });
  return lines;
}

/** Quick count-up for the summary figures (0.7 s, eases out). Screen readers get the final number only. */
function CountUp({ value, delayMs = 0 }: { value: number; delayMs?: number }) {
  const [shown, setShown] = useState(0);
  const current = useRef(0); // the number on screen right now; a re-run continues from it
  useEffect(() => {
    if (typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches) { current.current = value; setShown(value); return; }
    const start = current.current, t0 = performance.now() + delayMs, dur = 700;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - t0) / dur));
      const n = Math.round(start + (value - start) * (1 - Math.pow(1 - t, 3)));
      current.current = n;
      setShown(n);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return <><span aria-hidden="true">{shown.toLocaleString()}</span><span className="sr-only">{value.toLocaleString()}</span></>;
}

export function SpaceCard({ c, onOpen, onTour, slot, featured = false, tallestM, group = false }: { c: CandidateCard; onOpen?: () => void; onTour?: () => void; slot?: string; featured?: boolean; tallestM: number; group?: boolean }) {
  return <article className={"card space-card reveal" + (featured ? " featured" : "")}>
    <div className="space-title-row"><div><span className="space-type">{USE_LABELS[c.spaceUse ?? ""] ?? c.spaceUse ?? "Use not reported"}</span><h3>{c.displayName}</h3></div>{slot && <span className="catalogue-slot" aria-label={`Candidate ${slot}`}>{slot}</span>}</div>
    <p className="space-meta">{c.address ?? "Address not reported"}</p>
    {featured && c.hasAnnotation && <PlanPreview c={c} onOpen={onOpen} />}
    {featured && c.hasAnnotation && <p className={"geometry-status" + (c.spatiallyVerified ? " verified" : "")}>{c.spatiallyVerified ? "Spatially verified: exact unit match, reviewed tracing and scale check." : "Placement results here are exploratory until the unit match and the tracing are reviewed."}</p>}
    <div className="space-facts"><div><span className="fact-label">Advertised area</span><span className="space-area">{c.listedAreaSqFt != null ? c.listedAreaSqFt.toLocaleString() : "—"}<small>{c.listedAreaSqFt != null ? "SF" : "Not reported"}</small></span></div><div><span className="fact-label">Reported availability</span><span className="fact-value">{c.availableOnDate ? c.availableOnDate.slice(0, 10) : c.availabilityType ? `${c.availabilityType} · relative` : "Date not confirmed"}</span></div></div>
    <ul className="space-fit" aria-label="Compared with your work on paper">{paperFit(c, tallestM, group).map((l) => <li key={l.text} className={l.tone}>{l.text}</li>)}</ul>
    <div className="space-evidence"><div><i className="evidence-dot" aria-hidden="true" /><span>{c.conditionLabels.occupancy}</span></div><div><i className="evidence-dot" aria-hidden="true" /><span>{c.conditionLabels.furniture}</span></div><div><i className="evidence-dot" aria-hidden="true" /><span>{c.matchVerified ? "Exact-space match reviewed" : c.matchProposed ? "Space match proposed; review needed" : "Exact-space match not reviewed"}</span></div></div>
    <details><summary>Listing &amp; condition evidence</summary><dl className="lines">
      <dt>Listing</dt><dd>{c.conditionLabels.listing}{c.certifiedFreshDate ? ` · certified ${c.certifiedFreshDate.slice(0, 10)}` : ""}</dd>
      <dt>Asking rent</dt><dd>{rateText(c.rate)}</dd><dt>Physical occupancy</dt><dd>{c.conditionLabels.occupancy}</dd><dt>Furniture</dt><dd>{c.conditionLabels.furniture}{c.isExecutiveSuite ? " · executive-suite cue only" : ""}</dd><dt>Cleared region</dt><dd>{c.conditionLabels.cleared}</dd><dt>Short-term use</dt><dd>{c.conditionLabels.shortTerm}</dd>
      <dt>3D tour</dt><dd>{c.matterportModelCount ? `${plural(c.matterportModelCount, "linked Matterport tour", "linked Matterport tours")} · ${c.matterportLinkLevel === "building" ? "linked to the building, may not show this unit" : `${c.matterportLinkLevel}-level link`}` : "No linked 3D tour"}</dd><dt>Area screen</dt><dd>{AREA_LABEL[c.areaScreen]}</dd>
      <dt>Time on market</dt><dd>{c.monthsOnMarket != null ? `${Math.floor(c.monthsOnMarket)} months` : "Unknown"}{c.lastRecordedTenantLeftAt ? ` · last recorded tenant left ${monYear(c.lastRecordedTenantLeftAt)}` : c.tenancyMatch === "none" ? " · no matching tenancy record" : ""}<br />{IDLE_LABEL[c.idleSignal]} · ranking signal only.{c.idleNote ? ` ${c.idleNote}` : ""} Current vacancy is not verified.</dd>
    </dl></details>
    {onOpen && <button className={c.hasAnnotation ? "primary" : ""} onClick={onOpen}>{c.hasAnnotation ? "Open in workspace" : "Inspect space"}<span aria-hidden="true">↗</span></button>}
    {!onOpen && onTour && <button onClick={onTour}>View 3D tour<span aria-hidden="true">↗</span></button>}
    {!onOpen && onTour && <p className="faint tour-note">No traced floor plan yet, so the studio can show the tour but can’t check a placement here.</p>}
  </article>;
}

export default function Discover({ result, brief, briefChanged, onSearchAgain, searching, onOpen, onBack }: { result: SearchResult; brief: ExhibitionBrief; briefChanged: boolean; onSearchAgain: () => void; searching: boolean; onOpen: (ids: string[]) => void; onBack: () => void }) {
  const works = worksOf(brief);
  const isGroup = works.length > 1;
  const big = largestWork(works);
  const artistCount = new Set(works.map((w) => w.artist.trim()).filter(Boolean)).size;
  const tallestM = Math.max(...works.map((w) => w.heightM));
  const hs = result.funnel.M1.heightScreen ?? {};
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
  // Scroll reveal: headings and cards rise in as they enter the view (cards in a row are staggered).
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const root = mainRef.current;
    if (!root) return;
    const els = [...root.querySelectorAll<HTMLElement>(".reveal:not(.in)")];
    if (typeof IntersectionObserver === "undefined") { els.forEach((e) => e.classList.add("in")); return; }
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
    }, { rootMargin: "0px 0px -6% 0px", threshold: 0.06 });
    for (const e of els) {
      const parent = e.parentElement;
      if (parent?.classList.contains("cards")) e.style.setProperty("--d", `${([...parent.children].indexOf(e) % 2) * 90}ms`);
      io.observe(e);
    }
    return () => io.disconnect();
  }, [shown.length, filter, traced.length]);
  return <main className="page discover-page" id="main-content" ref={mainRef}>
    <div className="discover-hero"><div><div className="eyebrow">02 / Spaces</div><h1>Spaces for<br />your show.</h1></div><div className="discover-summary"><p>These listings match your brief. See what’s known and what still needs checking for each one, then open a space in 3D to plan the show.</p><button className="text-button" onClick={onBack}>← Edit your brief</button></div></div>
    <section className="results-summary" aria-label="Search summary">
      <div className="summary-figures">
        <p><strong><CountUp value={f.M.count} /></strong><span>{f.M.count === 1 ? "listing matches your search" : "listings match your search"}</span></p>
        <p><strong><CountUp value={f.K.count} delayMs={120} /></strong><span>{f.K.count === 1 ? "with a linked 3D tour" : "with linked 3D tours"}</span></p>
      </div>
      {cond && <p className="summary-note">{cond}</p>}
      {isGroup && <p className="summary-note group-note"><strong>Your exhibition: {works.length} works{artistCount ? ` by ${artistCount} artist${artistCount > 1 ? "s" : ""}` : ""}.</strong> Listings are screened against your largest work ({big.widthM} × {big.depthM} m). Whether all the works fit together, with viewing room and a route, is checked in the studio — not here.</p>}
      {briefChanged && <div className="warn stale-search" role="status">Your brief changed after this search{isGroup ? " (works or sizes)" : ""}. These results may not match it. <button type="button" className="text-button" disabled={searching} onClick={onSearchAgain}>{searching ? "Searching…" : "Search again"}</button></div>}
      <details className="data-audit"><summary>How these spaces were selected</summary>
        <ol className="selection-steps">
          <li><span className="step-n">{f.N.count.toLocaleString()}</span><div><strong>Lease listings in the {result.brief.city} research market</strong><p>Records marketed in the snapshot. {result.inputAudit.unresolvedPropertyBucket > 0 ? `${plural(result.inputAudit.unresolvedPropertyBucket, "listing was", "listings were")} left out because the property record could not be resolved.` : ""}</p></div></li>
          <li><span className="step-n">{f.M.count.toLocaleString()}</span><div><strong>Meet your basic search</strong><p>Your space uses and dates, excluding lease-pending listings.{reasonText(f.M.reasons) ? ` Left out: ${reasonText(f.M.reasons)}.` : ""}{f.M.useUnknownBucket ? ` ${plural(f.M.useUnknownBucket, "listing has", "listings have")} no reported space use.` : ""}</p></div></li>
          <li><span className="step-n">—</span><div><strong>Ordered by advertised area — nothing removed</strong><p>{f.M1.areaScreen ? `${(f.M1.areaScreen.passes_reported_area_screen ?? 0).toLocaleString()} at or above your footprint on paper · ${(f.M1.areaScreen.below_requested_footprint ?? 0).toLocaleString()} below it · ${(f.M1.areaScreen.adjustment_pool ?? 0).toLocaleString()} kept in case you reduce clearance. ` : ""}{isGroup ? `Uses your largest work (${big.widthM} × ${big.depthM} m) with your preferred clearance; the other works are checked together in the studio. ` : ""}Advertised area is rounded and is not proof that the work fits.</p></div></li>
          <li><span className="step-n">—</span><div><strong>Listed ceiling vs your tallest work ({tallestM} m)</strong><p>{(hs.listed_clears ?? 0).toLocaleString()} clear it by 0.5 m or more · {(hs.listed_tight ?? 0).toLocaleString()} tight · {(hs.listed_below_tallest ?? 0).toLocaleString()} lower (ranked after the others) · {(hs.unknown ?? 0).toLocaleString()} not listed. These are building figures; the ceiling right above a spot can be lower.</p></div></li>
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
    {traced.length > 0 && <section className="catalogue-section" aria-labelledby="traced-heading"><div className="catalogue-heading reveal"><div><div className="eyebrow">A closer look</div><h2 id="traced-heading">Spaces in the studio.</h2><p className="faint">{allDraft ? "Traced floor plans are ready for a placement study. Comparing them is exploratory; it doesn’t mean either space fits or has been verified." : anyDraft ? "Traced floor plans are ready for a placement study. Their review status differs, so check each space below; comparing them doesn’t mean they fit." : "Traced floor plans with completed spatial verification. A fit still depends on the placement study."}</p></div><button className="primary" onClick={() => onOpen(traced.map((c) => c.id))}>{isGroup ? (traced.length > 1 ? `Plan the show in ${traced.length} spaces` : "Plan the show") : traced.length > 1 ? `Compare ${traced.length} spaces` : "Open workspace"}<span aria-hidden="true">↗</span></button></div><div className="cards">{traced.map((c, i) => <SpaceCard key={c.id} c={c} featured slot={String.fromCharCode(65 + i)} onOpen={() => open(c.id)} tallestM={tallestM} group={isGroup} />)}</div></section>}
    <section className="catalogue-section" aria-labelledby="all-leads-heading"><div className="catalogue-heading reveal"><div><div className="eyebrow">The wider search</div><h2 id="all-leads-heading">All marketed spaces.</h2></div><div className="filter-tabs" role="group" aria-label="Filter spaces">{(["all", "scan", "traced"] as const).map((k) => <button key={k} aria-pressed={filter === k} className={filter === k ? "on" : ""} onClick={() => { setFilter(k); setLimit(12); }}>{k === "all" ? "All spaces" : k === "scan" ? "With a 3D tour" : "Traced geometry"}</button>)}</div></div><p className="faint catalogue-help">Ranked: room on paper for your work first, then whether the listed ceiling clears your tallest work, then the long-idle signal and time on market. This is not evidence of current vacancy. Below-area leads remain available for review. Showing {shown.length} of {filtered.length} {filter === "all" ? "marketed records" : "matching records"}.</p>
      {shown.length ? <div className="cards">{shown.map((c) => <SpaceCard key={c.id} c={c} onOpen={c.hasAnnotation ? () => open(c.id) : undefined} onTour={c.matterportModelCount > 0 ? () => onOpen([c.id]) : undefined} tallestM={tallestM} group={isGroup} />)}</div> : <div className="empty-state"><h3>No spaces in this selection.</h3><p className="muted">Try another view or edit your brief. Missing evidence never becomes a verified match.</p><button className="text-button" onClick={onBack}>Edit brief →</button></div>}
      {filtered.length > shown.length && <div className="load-more"><button onClick={() => setLimit((n) => n + 12)}>Show more spaces <span aria-hidden="true">↓</span></button></div>}
    </section>
  </main>;
}
