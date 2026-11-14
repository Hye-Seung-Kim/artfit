import { useId, type ReactNode } from "react";
import type { ExhibitionBrief } from "@artfit/geometry";
import ArtworkStudy from "../components/ArtworkStudy";

export const USES = ["Retail", "Flex", "Industrial", "OfficeRetail", "Office", "OfficeMedical", "Medical"];
const USE_LABELS: Record<string, string> = { OfficeRetail: "Office / retail", OfficeMedical: "Medical office" };
export const EXAMPLE_BRIEF: ExhibitionBrief = {
  city: "Houston", exhibitionStart: "2027-03-05", exhibitionEnd: "2027-03-21", budget: 6000, budgetCurrency: "USD",
  artwork: { widthM: 4, depthM: 3, heightM: 2.4 }, preferredClearanceM: 1.5, minimumClearanceM: 1.0,
  spaceUsePreferences: ["Retail", "Flex", "Industrial", "OfficeRetail"],
  conditions: { requireVerifiedVacant: false, requireVerifiedUnfurnished: false, requireVerifiedClearedRegion: false, evidenceAsOf: "2027-03-05", clearedRegionScope: "matched_candidate_region" },
};
export const EMPTY_BRIEF: ExhibitionBrief = {
  ...EXAMPLE_BRIEF, exhibitionStart: "", exhibitionEnd: "", budget: null, minimumClearanceM: null,
  artwork: { widthM: 3, depthM: 2, heightM: 2 }, preferredClearanceM: 1.2, spaceUsePreferences: [],
};

function Num({ label, value, onChange, step = 0.1, min = 0, allowNull = false, unit = "m" }: { label: string; value: number | null; onChange: (v: number | null) => void; step?: number; min?: number; allowNull?: boolean; unit?: string }) {
  const id = useId();
  return <div className="field"><label htmlFor={id}>{label}</label><div className="input-unit"><input id={id} type="number" inputMode="decimal" step={step} min={min} value={value ?? ""} placeholder={allowNull ? "Optional" : ""}
    onChange={(e) => onChange(e.target.value === "" ? (allowNull ? null : 0) : Number(e.target.value))} /><span aria-hidden="true">{unit}</span></div></div>;
}
function BriefSection({ number, title, description, children }: { number: string; title: string; description: string; children: ReactNode }) {
  return <section className="brief-section" aria-labelledby={`section-${number}`}><div className="section-intro"><span className="section-number">{number}</span><h2 id={`section-${number}`}>{title}</h2><p>{description}</p></div><div className="section-fields">{children}</div></section>;
}

export default function Brief({ brief, setBrief, onSearch, busy, error }: { brief: ExhibitionBrief; setBrief: (b: ExhibitionBrief) => void; onSearch: () => void; busy: boolean; error: string | null }) {
  const set = (patch: Partial<ExhibitionBrief>) => setBrief({ ...brief, ...patch });
  const art = (k: keyof ExhibitionBrief["artwork"], v: number | null) => set({ artwork: { ...brief.artwork, [k]: v ?? 0 } });
  const invalid = !brief.exhibitionStart || !brief.exhibitionEnd || brief.exhibitionStart > brief.exhibitionEnd
    || !(brief.artwork.widthM > 0 && brief.artwork.depthM > 0 && brief.artwork.heightM > 0)
    || (brief.minimumClearanceM != null && brief.minimumClearanceM > brief.preferredClearanceM);
  return <main className="page brief-page" id="main-content">
    <div className="brief-hero"><div className="hero-copy"><div className="eyebrow">01 / The exhibition brief</div><h1>Make room<br />for your art.</h1><p className="hero-description">Extraordinary work needs the right space.<br className="desktop-break" /> Start with your artwork. Discover where it belongs.</p><a className="text-link hero-link" href="#exhibition-details">Build your brief <span aria-hidden="true">↓</span></a></div><ArtworkStudy width={brief.artwork.widthM} depth={brief.artwork.depthM} height={brief.artwork.heightM} clearance={brief.preferredClearanceM} /></div>
    <form className="brief-form" onSubmit={(event) => { event.preventDefault(); if (!invalid && !busy) onSearch(); }}>
      <div id="exhibition-details" className="form-start"><span>An exhibition starts with an idea.</span><span>Tell us about yours.</span></div>
      <BriefSection number="01" title="The exhibition" description="Choose your market, set the dates, and give your search a starting point.">
        <div className="field-grid"><div className="field field-wide"><label htmlFor="market">Research market</label><select id="market" value={brief.city} onChange={(e) => set({ city: e.target.value as ExhibitionBrief["city"] })}><option value="Houston">Houston</option><option value="Los Angeles">Los Angeles</option></select><p className="field-hint">Includes the surrounding research market.</p></div><div className="field"><label htmlFor="exhibition-start">Exhibition start</label><input id="exhibition-start" type="date" required value={brief.exhibitionStart} onChange={(e) => set({ exhibitionStart: e.target.value, conditions: { ...brief.conditions, evidenceAsOf: e.target.value } })} /></div><div className="field"><label htmlFor="exhibition-end">Exhibition end</label><input id="exhibition-end" type="date" required min={brief.exhibitionStart || undefined} value={brief.exhibitionEnd} onChange={(e) => set({ exhibitionEnd: e.target.value })} /></div><div className="field-wide"><Num label="Budget preference" value={brief.budget} onChange={(v) => set({ budget: v })} step={100} allowNull unit="USD" /><p className="field-hint">A search preference. Short-term exhibition costs still need confirmation.</p></div></div>
      </BriefSection>
      <BriefSection number="02" title="The artwork" description="One floor-standing work. Its dimensions, and the room you want around it. All measurements in meters.">
        <div className="dimension-grid"><Num label="Width" value={brief.artwork.widthM} onChange={(v) => art("widthM", v)} min={0.1} /><Num label="Depth" value={brief.artwork.depthM} onChange={(v) => art("depthM", v)} min={0.1} /><Num label="Height" value={brief.artwork.heightM} onChange={(v) => art("heightM", v)} min={0.1} /></div><div className="field-grid clearance-fields"><Num label="Preferred viewing clearance" value={brief.preferredClearanceM} onChange={(v) => set({ preferredClearanceM: v ?? 0 })} step={0.05} /><Num label="Minimum clearance" value={brief.minimumClearanceM} onChange={(v) => set({ minimumClearanceM: v })} step={0.05} allowNull /></div><p className="field-hint">Leave the minimum open to keep your preferred clearance unchanged. Set it explicitly to explore a smaller clearance; no safety minimum is assumed.</p>
      </BriefSection>
      <BriefSection number="03" title="The setting" description="A storefront, a studio, a space between uses. Choose the kinds of places you’re open to.">
        <fieldset className="use-options"><legend className="sr-only">Space use</legend>{USES.map((u) => <label key={u} className="use-option"><input type="checkbox" checked={brief.spaceUsePreferences.includes(u)} onChange={(e) => set({ spaceUsePreferences: e.target.checked ? [...brief.spaceUsePreferences, u] : brief.spaceUsePreferences.filter((x) => x !== u) })} /><span>{USE_LABELS[u] ?? u}</span><span className="selection-mark" aria-hidden="true">{brief.spaceUsePreferences.includes(u) ? "−" : "+"}</span></label>)}</fieldset><p className="field-hint">No selection means all commercial uses.</p><div className="availability-note"><span className="note-index" aria-hidden="true">i</span><div><h3>A note on availability</h3><p>We explore marketed listings. A listing doesn’t confirm that a space is vacant, unfurnished, or ready for an exhibition. You’ll see what’s known and what needs a closer look.</p><p className="field-hint">Verified-condition filters are not available in this version.</p></div></div>
      </BriefSection>
      {error && <div className="warn" role="alert">{error} — your inputs are preserved. Please try again.</div>}
      <div className="brief-actions"><div><p className="action-heading">Let’s find your space.</p><p className="field-hint">Real listings. Traced geometry. A clearer next step.</p></div><div className="action-controls"><button type="button" className="text-button" onClick={() => setBrief(EXAMPLE_BRIEF)}>Use example exhibition</button><button type="submit" className="primary" disabled={invalid || busy}>{busy ? "Searching…" : "Find spaces"}<span aria-hidden="true">↗</span></button></div>{invalid && <p className="validation-hint">Add exhibition dates and positive dimensions. Your minimum clearance must not exceed your preferred clearance.</p>}</div>
    </form>
  </main>;
}
