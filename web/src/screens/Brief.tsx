import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ExhibitionBrief } from "@artfit/geometry";
import ArtworkStudy, { type StudyFocus } from "../components/ArtworkStudy";

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

const STEPS = [
  { key: "market", label: "Place" },
  { key: "dates", label: "Dates" },
  { key: "artwork", label: "Artwork" },
  { key: "clearance", label: "Room to walk" },
  { key: "setting", label: "Setting" },
  { key: "review", label: "Review" },
] as const;
type StepKey = (typeof STEPS)[number]["key"];
const CLEARANCE_PRESETS = [0.9, 1.2, 1.5, 2];

function Num({ label, value, onChange, step = 0.1, min = 0, allowNull = false, unit = "m", autoFocus = false }: { label: string; value: number | null; onChange: (v: number | null) => void; step?: number; min?: number; allowNull?: boolean; unit?: string; autoFocus?: boolean }) {
  const id = useId();
  return <div className="field"><label htmlFor={id}>{label}</label><div className="input-unit"><input id={id} type="number" inputMode="decimal" step={step} min={min} value={value ?? ""} placeholder={allowNull ? "Optional" : ""} autoFocus={autoFocus}
    onChange={(e) => onChange(e.target.value === "" ? (allowNull ? null : 0) : Number(e.target.value))} /><span aria-hidden="true">{unit}</span></div></div>;
}

/** Children enter one after another (40 ms apart) when a step mounts. */
function Stagger({ items }: { items: ReactNode[] }) {
  return <>{items.filter(Boolean).map((c, i) => <div key={i} className="ob-item" style={{ "--i": i } as CSSProperties}>{c}</div>)}</>;
}

const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
const fmtDate = (d: string) => (d ? new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");

function stepError(key: StepKey, b: ExhibitionBrief): string | null {
  switch (key) {
    case "dates":
      if (!b.exhibitionStart || !b.exhibitionEnd) return "Add an opening and a closing date.";
      if (b.exhibitionStart > b.exhibitionEnd) return "The closing date comes before the opening.";
      return null;
    case "artwork":
      return b.artwork.widthM > 0 && b.artwork.depthM > 0 && b.artwork.heightM > 0 ? null : "Every dimension needs a positive value.";
    case "clearance":
      if (!(b.preferredClearanceM > 0)) return "Set a preferred clearance above zero.";
      if (b.minimumClearanceM != null && b.minimumClearanceM > b.preferredClearanceM) return "The minimum can’t be larger than the preferred clearance.";
      return null;
    default:
      return null;
  }
}

export default function Brief({ brief, setBrief, onSearch, busy, error }: { brief: ExhibitionBrief; setBrief: (b: ExhibitionBrief) => void; onSearch: () => void; busy: boolean; error: string | null }) {
  const [step, setStep] = useState<number | null>(null); // null = introduction
  const [dir, setDir] = useState<"fwd" | "back">("fwd");
  const [reached, setReached] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const set = (patch: Partial<ExhibitionBrief>) => setBrief({ ...brief, ...patch });
  const art = (k: keyof ExhibitionBrief["artwork"], v: number | null) => set({ artwork: { ...brief.artwork, [k]: v ?? 0 } });

  const go = (to: number) => {
    setDir(step === null || to > step ? "fwd" : "back");
    setStep(to);
    setReached((r) => Math.max(r, to));
  };
  useEffect(() => {
    if (step === null) return;
    window.scrollTo({ top: 0, behavior: "instant" });
    // Move focus to the new question unless a field already took it (autoFocus).
    if (!document.activeElement || document.activeElement === document.body || !headingRef.current?.closest(".ob")?.contains(document.activeElement)) headingRef.current?.focus({ preventScroll: true });
  }, [step]);

  if (step === null) {
    return <main className="page brief-page" id="main-content">
      <div className="brief-hero">
        <div className="hero-copy">
          <div className="eyebrow">01 / The exhibition brief</div>
          <h1>Make room<br />for your art.</h1>
          <p className="hero-description">Extraordinary work needs the right space.<br className="desktop-break" /> Six short questions about your work, then we look for where it belongs.</p>
          <div className="hero-actions">
            <button type="button" className="primary" onClick={() => go(0)}>Begin your brief<span aria-hidden="true">→</span></button>
            <button type="button" className="text-button" onClick={() => { setBrief(EXAMPLE_BRIEF); setReached(STEPS.length - 1); go(STEPS.length - 1); }}>Use example exhibition</button>
          </div>
        </div>
        <ArtworkStudy width={brief.artwork.widthM} depth={brief.artwork.depthM} height={brief.artwork.heightM} clearance={brief.preferredClearanceM} />
      </div>
    </main>;
  }

  const key = STEPS[step].key;
  const err = stepError(key, brief);
  const isLast = step === STEPS.length - 1;
  const focus: StudyFocus = key === "artwork" ? "size" : key === "clearance" ? "clearance" : null;
  const showStudy = focus !== null; // the study only helps where the user is sizing the work or its clearance
  const next = () => { if (err) return; if (isLast) { if (!busy) onSearch(); } else go(step + 1); };
  const allValid = STEPS.every((s) => !stepError(s.key, brief));

  const H = (n: string, title: string, lede: string) => <header className="ob-question">
    <span className="section-number">{n} / 06</span>
    <h2 ref={headingRef} tabIndex={-1}>{title}</h2>
    <p>{lede}</p>
  </header>;

  let body: ReactNode;
  switch (key) {
    case "market":
      body = <Stagger items={[
        H("01", "Where will it be shown?", "Pick a research market. It includes the surrounding cities, not only the city itself."),
        <div className="ob-choices" role="group" aria-label="Research market">
          {(["Houston", "Los Angeles"] as const).map((c) => <button key={c} type="button" className="ob-choice" aria-pressed={brief.city === c} onClick={() => { set({ city: c }); go(step + 1); }}>
            <span className="ob-choice-title">{c}</span><span className="ob-choice-meta">{c === "Houston" ? "Texas" : "California"} · research market</span><span className="ob-choice-mark" aria-hidden="true">→</span>
          </button>)}
        </div>,
      ]} />;
      break;
    case "dates": {
      const ok = brief.exhibitionStart && brief.exhibitionEnd && brief.exhibitionStart <= brief.exhibitionEnd;
      body = <Stagger items={[
        H("02", "When does it open and close?", "We compare these dates with what each listing says about availability."),
        <div className="field-grid">
          <div className="field"><label htmlFor="exhibition-start">Opening</label><input id="exhibition-start" type="date" required value={brief.exhibitionStart} onChange={(e) => set({ exhibitionStart: e.target.value, conditions: { ...brief.conditions, evidenceAsOf: e.target.value } })} /></div>
          <div className="field"><label htmlFor="exhibition-end">Closing</label><input id="exhibition-end" type="date" required min={brief.exhibitionStart || undefined} value={brief.exhibitionEnd} onChange={(e) => set({ exhibitionEnd: e.target.value })} /></div>
        </div>,
        <p className="ob-readout" aria-live="polite">{ok ? <><strong>{days(brief.exhibitionStart, brief.exhibitionEnd)} days</strong> on view</> : <span className="faint">Duration appears here.</span>}</p>,
      ]} />;
      break;
    }
    case "artwork":
      body = <Stagger items={[
        H("03", "How big is the work?", "One floor-standing piece. Measure its outer footprint and full height, in meters."),
        <div className="dimension-grid">
          <Num label="Width" value={brief.artwork.widthM} onChange={(v) => art("widthM", v)} min={0.1} autoFocus />
          <Num label="Depth" value={brief.artwork.depthM} onChange={(v) => art("depthM", v)} min={0.1} />
          <Num label="Height" value={brief.artwork.heightM} onChange={(v) => art("heightM", v)} min={0.1} />
        </div>,
        <p className="ob-readout"><strong>{(brief.artwork.widthM * brief.artwork.depthM || 0).toFixed(1)} m²</strong> footprint · the study on the right follows your numbers</p>,
      ]} />;
      break;
    case "clearance":
      body = <Stagger items={[
        H("04", "How much room around it?", "The walking space you want on every side. It shows as the aqua band in the study."),
        <div className="ob-presets" role="group" aria-label="Preferred clearance presets">
          {CLEARANCE_PRESETS.map((v) => <button key={v} type="button" aria-pressed={brief.preferredClearanceM === v} onClick={() => set({ preferredClearanceM: v })}>{v} m</button>)}
        </div>,
        <div className="field-grid">
          <Num label="Preferred clearance" value={brief.preferredClearanceM} onChange={(v) => set({ preferredClearanceM: v ?? 0 })} step={0.05} />
          <Num label="Minimum clearance" value={brief.minimumClearanceM} onChange={(v) => set({ minimumClearanceM: v })} step={0.05} allowNull />
        </div>,
        <p className="field-hint">Leave the minimum empty to keep your preferred clearance. Set one only if you’d accept a tighter fit; no safety minimum is assumed.</p>,
      ]} />;
      break;
    case "setting":
      body = <Stagger items={[
        H("05", "What kind of place feels right?", "A storefront, a studio, a space between uses. Choose any that fit, or none for all commercial uses."),
        <fieldset className="use-options"><legend className="sr-only">Space use</legend>{USES.map((u) => <label key={u} className="use-option"><input type="checkbox" checked={brief.spaceUsePreferences.includes(u)} onChange={(e) => set({ spaceUsePreferences: e.target.checked ? [...brief.spaceUsePreferences, u] : brief.spaceUsePreferences.filter((x) => x !== u) })} /><span>{USE_LABELS[u] ?? u}</span><span className="selection-mark" aria-hidden="true">{brief.spaceUsePreferences.includes(u) ? "−" : "+"}</span></label>)}</fieldset>,
        <div className="ob-budget"><Num label="Budget preference" value={brief.budget} onChange={(v) => set({ budget: v })} step={100} allowNull unit="USD" /><p className="field-hint">A search preference. Short-term exhibition costs still need confirmation.</p></div>,
      ]} />;
      break;
    case "review": {
      const rows: [string, string, number][] = [
        ["Place", `${brief.city} research market`, 0],
        ["Dates", brief.exhibitionStart && brief.exhibitionEnd ? `${fmtDate(brief.exhibitionStart)} → ${fmtDate(brief.exhibitionEnd)}` : "Not set", 1],
        ["Artwork", `W ${brief.artwork.widthM} × D ${brief.artwork.depthM} × H ${brief.artwork.heightM} m`, 2],
        ["Room to walk", `${brief.preferredClearanceM} m preferred${brief.minimumClearanceM != null ? ` · ${brief.minimumClearanceM} m minimum` : ""}`, 3],
        ["Setting", brief.spaceUsePreferences.length ? brief.spaceUsePreferences.map((u) => USE_LABELS[u] ?? u).join(", ") : "All commercial uses", 4],
        ["Budget", brief.budget != null ? `${brief.budget.toLocaleString("en-US")} ${brief.budgetCurrency} (preference)` : "No preference", 4],
      ];
      body = <Stagger items={[
        H("06", "Your brief.", "Check the details, then we search the November 2026 CoStar snapshot."),
        <dl className="ob-review">{rows.map(([k, v, s]) => <div key={k} className="ob-review-row"><dt>{k}</dt><dd>{v}</dd><button type="button" className="text-button" onClick={() => go(s)} aria-label={`Edit ${k.toLowerCase()}`}>Edit</button></div>)}</dl>,
        <div className="availability-note"><span className="note-index" aria-hidden="true">i</span><div><h3>A note on availability</h3><p>We explore marketed listings. A listing doesn’t confirm that a space is vacant, unfurnished, or ready for an exhibition. You’ll see what’s known and what needs a closer look.</p></div></div>,
        error ? <div className="warn" role="alert">{error} — your answers are kept. Please try again.</div> : null,
      ]} />;
      break;
    }
  }

  return <main className="page brief-page ob" id="main-content">
    <nav className="ob-progress" aria-label="Brief progress">
      <div className="ob-track" aria-hidden="true"><div className="ob-fill" style={{ transform: `scaleX(${(step + 1) / STEPS.length})` }} /></div>
      <ol>
        {STEPS.map((s, i) => <li key={s.key}><button type="button" className={i === step ? "on" : i < step ? "done" : ""} aria-current={i === step ? "step" : undefined} disabled={i > reached} onClick={() => go(i)}><span className="mono">{String(i + 1).padStart(2, "0")}</span>{s.label}</button></li>)}
      </ol>
    </nav>
    <div className={"ob-body" + (showStudy ? " has-study" : "")}>
      <form className="ob-form" noValidate onSubmit={(e) => { e.preventDefault(); next(); }}>
        <div key={step} className={`ob-step ob-${dir}`}>{body}</div>
        <div className="ob-actions">
          <button type="button" className="text-button" onClick={() => (step === 0 ? setStep(null) : go(step - 1))}>← Back</button>
          {key !== "market" && <button type="submit" className="primary" disabled={!!err || (isLast && (busy || !allValid))}>{isLast ? (busy ? "Searching…" : "Find spaces") : "Continue"}<span aria-hidden="true">{isLast ? "↗" : "→"}</span></button>}
        </div>
        {err && key !== "market" && <p className="validation-hint" aria-live="polite">{err}</p>}
      </form>
      <div className="ob-aside" aria-hidden={!showStudy}><ArtworkStudy width={brief.artwork.widthM} depth={brief.artwork.depthM} height={brief.artwork.heightM} clearance={brief.preferredClearanceM} focus={focus} /></div>
    </div>
  </main>;
}
