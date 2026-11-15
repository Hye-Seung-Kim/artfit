import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { BriefWork, ExhibitionBrief } from "@artfit/geometry";
import ArtworkStudy, { type StudyFocus } from "../components/ArtworkStudy";
import { api } from "../api";

export const USES = ["Retail", "Flex", "Industrial", "OfficeRetail", "Office", "OfficeMedical", "Medical"];
const USE_LABELS: Record<string, string> = { OfficeRetail: "Office / retail", OfficeMedical: "Medical office" };
/** Works in the brief (a solo brief from before works existed becomes a one-work list). */
export const worksOf = (b: ExhibitionBrief): BriefWork[] =>
  b.works?.length ? b.works : [{ id: "w1", title: "", artist: "", ...b.artwork, clearanceM: null, required: true }];
/** Search screening and the single-work studio use the largest footprint: any space must at least hold that one. */
export const largestWork = (ws: BriefWork[]) => ws.reduce((a, w) => (w.widthM * w.depthM > a.widthM * a.depthM ? w : a), ws[0]);
export const withWorks = (b: ExhibitionBrief, works: BriefWork[]): ExhibitionBrief => {
  const L = largestWork(works);
  return { ...b, works, artwork: { widthM: L.widthM, depthM: L.depthM, heightM: L.heightM } };
};
let workSeq = 0;
const newWorkId = () => `w-${Date.now().toString(36)}-${++workSeq}`;
const workName = (w: BriefWork, i: number) => w.title.trim() || `Work ${i + 1}`;

export const EXAMPLE_BRIEF: ExhibitionBrief = {
  city: "Houston", exhibitionStart: "2027-03-05", exhibitionEnd: "2027-03-21", budget: 6000, budgetCurrency: "USD",
  artwork: { widthM: 4, depthM: 3, heightM: 2.4 },
  works: [
    { id: "w-1", title: "Work 1", artist: "Artist 1", widthM: 4, depthM: 3, heightM: 2.4, clearanceM: null, required: true },
    { id: "w-2", title: "Work 2", artist: "Artist 2", widthM: 2, depthM: 1.5, heightM: 1.8, clearanceM: 1.2, required: true },
    { id: "w-3", title: "Work 3", artist: "Artist 3", widthM: 0.8, depthM: 0.8, heightM: 2.6, clearanceM: 1, required: true },
  ],
  preferredClearanceM: 1.5, minimumClearanceM: 1.0,
  spaceUsePreferences: ["Retail", "Flex", "Industrial", "OfficeRetail"],
  conditions: { requireVerifiedVacant: false, requireVerifiedUnfurnished: false, requireVerifiedClearedRegion: false, evidenceAsOf: "2027-03-05", clearedRegionScope: "matched_candidate_region" },
};
export const EMPTY_BRIEF: ExhibitionBrief = {
  ...EXAMPLE_BRIEF, exhibitionStart: "", exhibitionEnd: "", budget: null, minimumClearanceM: null,
  artwork: { widthM: 3, depthM: 2, heightM: 2 }, preferredClearanceM: 1.2, spaceUsePreferences: [],
  works: [{ id: "w1", title: "", artist: "", widthM: 3, depthM: 2, heightM: 2, clearanceM: null, required: true }],
};

const STEPS = [
  { key: "market", label: "Place" },
  { key: "dates", label: "Dates" },
  { key: "artwork", label: "Artworks" },
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
const addDays = (d: string, n: number) => { const t = new Date(d + "T00:00:00"); t.setDate(t.getDate() + n); return t.toISOString().slice(0, 10); };
const weekday = (d: string) => new Date(d + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const weekends = (a: string, b: string) => { let n = 0; for (let d = a; d <= b; d = addDays(d, 1)) if (new Date(d + "T00:00:00").getDay() === 6) n++; return n; };
const monthsBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / (30.44 * 86400000));
const DURATIONS = [2, 3, 4, 6];
const reduceMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const fmtDate = (d: string) => (d ? new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");

function stepError(key: StepKey, b: ExhibitionBrief): string | null {
  switch (key) {
    case "dates":
      if (!b.exhibitionStart || !b.exhibitionEnd) return "Add an opening and a closing date.";
      if (b.exhibitionStart > b.exhibitionEnd) return "The closing date comes before the opening.";
      return null;
    case "artwork":
      return worksOf(b).every((w) => w.widthM > 0 && w.depthM > 0 && w.heightM > 0) ? null : "Every work needs a positive width, depth and height.";
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
  // Real snapshot figures per research market, shown on the first question.
  const [markets, setMarkets] = useState<Record<string, { listings: number; withTour: number; traced: number; snapshotRefDate: string }>>({});
  useEffect(() => { api.markets().then((m) => setMarkets(Object.fromEntries(m.map((x) => [x.city, x])))).catch(() => {}); }, []);
  const [choosing, setChoosing] = useState<string | null>(null);
  const set = (patch: Partial<ExhibitionBrief>) => setBrief({ ...brief, ...patch });
  const works = worksOf(brief);
  const [editing, setEditing] = useState<string | null>(works.length === 1 ? works[0].id : null);
  const setWorks = (ws: BriefWork[]) => setBrief(withWorks(brief, ws));
  const patchWork = (id: string, patch: Partial<BriefWork>) => setWorks(works.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  const addWork = () => { const id = newWorkId(); setWorks([...works, { id, title: "", artist: works[works.length - 1]?.artist ?? "", widthM: 1, depthM: 1, heightM: 1.5, clearanceM: null, required: true }]); setEditing(id); };
  const studyWork = works.find((w) => w.id === editing) ?? largestWork(works);
  const artists = new Set(works.map((w) => w.artist.trim()).filter(Boolean));

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
          <p className="hero-description">Extraordinary work needs the right space.<br className="desktop-break" /> Six short questions about your exhibition: one work or a group show. Then we look for where it belongs.</p>
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
          {(["Houston", "Los Angeles"] as const).map((c) => {
            const m = markets[c];
            const picked = choosing ? choosing === c : brief.city === c;
            return <button key={c} type="button" className={"ob-choice" + (choosing === c ? " choosing" : "")} aria-pressed={picked} disabled={!!choosing}
              onClick={() => { set({ city: c }); setChoosing(c); setTimeout(() => { setChoosing(null); go(1); }, reduceMotion() ? 120 : 420); }}>
              <span className="ob-choice-title">{c}</span>
              <span className="ob-choice-meta">{c === "Houston" ? "Texas" : "California"} · research market, surrounding cities included</span>
              <span className="ob-choice-stats">{m ? <><span><b>{m.listings.toLocaleString()}</b> lease listings</span><span><b>{m.withTour.toLocaleString()}</b> with a 3D tour</span><span><b>{m.traced}</b> with a traced floor plan</span></> : <span className="faint">Loading the snapshot…</span>}</span>
              <span className="ob-choice-mark" aria-hidden="true">{picked && choosing ? "✓" : "→"}</span>
              <span className="ob-choice-sweep" aria-hidden="true" />
            </button>;
          })}
        </div>,
        markets["Los Angeles"] && markets["Los Angeles"].traced === 0 ? <p className="field-hint">Counts are listing records in the {new Date((markets.Houston?.snapshotRefDate ?? "2026-11-10") + "T00:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" })} CoStar snapshot. Placement checks need a traced floor plan; Los Angeles doesn’t have one yet, so you can browse listings and 3D tours there.</p> : null,
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
        <div className="ob-durations" role="group" aria-label="Quick length">
          {DURATIONS.map((w) => {
            const end = brief.exhibitionStart ? addDays(brief.exhibitionStart, w * 7 - 1) : "";
            return <button key={w} type="button" disabled={!brief.exhibitionStart} aria-pressed={!!end && brief.exhibitionEnd === end} onClick={() => set({ exhibitionEnd: end })}>{w} weeks</button>;
          })}
          {!brief.exhibitionStart && <span className="faint">Pick an opening date first.</span>}
        </div>,
        <div className="ob-timeline" aria-live="polite">
          <div className="ob-track-line" aria-hidden="true">
            <div className="ob-span" style={{ transform: `scaleX(${ok ? Math.min(1, days(brief.exhibitionStart, brief.exhibitionEnd) / 56) : 0})` }} />
            {Array.from({ length: 9 }, (_, i) => <i key={i} style={{ left: `${(i / 8) * 100}%` }} />)}
          </div>
          <div className="ob-scale" aria-hidden="true"><span>Opening</span><span>4 weeks</span><span>8 weeks</span></div>
          {ok
            ? <p className="ob-readout"><strong>{days(brief.exhibitionStart, brief.exhibitionEnd)} days</strong> on view · {weekday(brief.exhibitionStart)} → {weekday(brief.exhibitionEnd)} · {weekends(brief.exhibitionStart, brief.exhibitionEnd)} weekend{weekends(brief.exhibitionStart, brief.exhibitionEnd) === 1 ? "" : "s"}</p>
            : <p className="ob-readout"><span className="faint">The length of the show appears here.</span></p>}
          {brief.exhibitionStart && markets.Houston && <p className="field-hint">Opens about {Math.max(0, monthsBetween(markets.Houston.snapshotRefDate, brief.exhibitionStart))} months after the listing snapshot ({fmtDate(markets.Houston.snapshotRefDate)}); availability may have changed since. Leave time for install and de-install around these dates.</p>}
        </div>,
      ]} />;
      break;
    }
    case "artwork": {
      const footprint = works.reduce((t, w) => t + w.widthM * w.depthM, 0);
      body = <Stagger items={[
        H("03", "What’s in the show?", "Add every floor-standing work, yours and other artists’. Measure each outer footprint and full height, in meters. One work is fine too."),
        <ol className="ob-works" aria-label="Works in this exhibition">
          {works.map((w, i) => (
            <li key={w.id} className={editing === w.id ? "on" : ""}>
              <div className="ob-work-row">
                <span className="mono">{String(i + 1).padStart(2, "0")}</span>
                <span className="ob-work-name"><strong>{workName(w, i)}</strong><span>{w.artist.trim() || "Artist not set"}</span></span>
                <span className="ob-work-size">{w.widthM} × {w.depthM} × {w.heightM} m</span>
                <button type="button" className="text-button" aria-expanded={editing === w.id} onClick={() => setEditing(editing === w.id ? null : w.id)}>{editing === w.id ? "Done" : "Edit"}</button>
                {works.length > 1 && <button type="button" className="text-button" aria-label={`Remove ${workName(w, i)}`} onClick={() => { setWorks(works.filter((x) => x.id !== w.id)); if (editing === w.id) setEditing(null); }}>Remove</button>}
              </div>
              {editing === w.id && (
                <div className="ob-work-edit">
                  <div className="field-grid">
                    <div className="field"><label htmlFor={`t-${w.id}`}>Title</label><input id={`t-${w.id}`} value={w.title} placeholder={`Work ${i + 1}`} onChange={(e) => patchWork(w.id, { title: e.target.value })} autoFocus /></div>
                    <div className="field"><label htmlFor={`a-${w.id}`}>Artist</label><input id={`a-${w.id}`} value={w.artist} placeholder="Name" onChange={(e) => patchWork(w.id, { artist: e.target.value })} /></div>
                  </div>
                  <div className="dimension-grid">
                    <Num label="Width" value={w.widthM} onChange={(v) => patchWork(w.id, { widthM: v ?? 0 })} min={0.1} />
                    <Num label="Depth" value={w.depthM} onChange={(v) => patchWork(w.id, { depthM: v ?? 0 })} min={0.1} />
                    <Num label="Height" value={w.heightM} onChange={(v) => patchWork(w.id, { heightM: v ?? 0 })} min={0.1} />
                  </div>
                  <p className="field-hint">A photo or a 3D model can be added later in the studio; the box starts at this size.</p>
                </div>
              )}
            </li>
          ))}
        </ol>,
        <button type="button" className="ob-add" onClick={addWork}><span aria-hidden="true">+</span> Add artwork</button>,
        <p className="ob-readout"><strong>{works.length} work{works.length > 1 ? "s" : ""}</strong>{artists.size ? ` by ${artists.size} artist${artists.size > 1 ? "s" : ""}` : ""} · {footprint.toFixed(1)} m² of footprints together. {works.length > 1 ? "That’s a starting reference only; whether they fit together, with viewing room and a route, is checked in the studio." : "The study on the right follows your numbers."}</p>,
      ]} />;
      break;
    }
    case "clearance":
      body = <Stagger items={[
        H("04", works.length > 1 ? "How much room around each work?" : "How much room around it?", works.length > 1 ? "The default walking space on every side of each work (the aqua band in the study). Set exceptions for single works later in the studio." : "The walking space you want on every side. It shows as the aqua band in the study."),
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
        <div className="ob-budget"><Num label="Total exhibition budget" value={brief.budget} onChange={(v) => set({ budget: v })} step={100} allowNull unit="USD" /><p className="field-hint">All costs together: venue, transport, installation. Short-term venue prices aren’t in the listings, so they still need quotes.</p></div>,
      ]} />;
      break;
    case "review": {
      const rows: [string, string, number][] = [
        ["Place", `${brief.city} research market`, 0],
        ["Dates", brief.exhibitionStart && brief.exhibitionEnd ? `${fmtDate(brief.exhibitionStart)} → ${fmtDate(brief.exhibitionEnd)}` : "Not set", 1],
        ["Artworks", `${works.length} work${works.length > 1 ? "s" : ""}${artists.size ? ` by ${artists.size} artist${artists.size > 1 ? "s" : ""}` : ""}`, 2],
        ...works.map((w, i): [string, string, number] => [`Work ${i + 1}`, [w.title.trim(), w.artist.trim() || "Artist not set", `W ${w.widthM} × D ${w.depthM} × H ${w.heightM} m`].filter(Boolean).join(" · "), 2]),
        ["Room to walk", `${brief.preferredClearanceM} m preferred${brief.minimumClearanceM != null ? ` · ${brief.minimumClearanceM} m minimum` : ""}`, 3],
        ["Setting", brief.spaceUsePreferences.length ? brief.spaceUsePreferences.map((u) => USE_LABELS[u] ?? u).join(", ") : "All commercial uses", 4],
        ["Total budget", brief.budget != null ? `${brief.budget.toLocaleString("en-US")} ${brief.budgetCurrency} for all costs (venue price not yet quoted)` : "Not set", 4],
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
      <div className="ob-aside" aria-hidden={!showStudy}><ArtworkStudy width={studyWork.widthM} depth={studyWork.depthM} height={studyWork.heightM} clearance={brief.preferredClearanceM} focus={focus} /></div>
    </div>
  </main>;
}
