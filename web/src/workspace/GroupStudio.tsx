// Group show planning in the Workspace: several artists' floor-standing works in one space.
// One document (works, viewing order, costs, per-space poses and locks) with undo/redo; every change, including an
// AI request or "use this layout", is one undoable step. Real artwork sizes are only edited by the user here.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  directionVector, evaluateGroup, type BriefWork, suggestGroupPlans, summarizeBudget, toMeters, workBody,
  type CostItem, type CostStatus, type GroupEvaluation, type GroupPlan, type GroupWork, type Length, type PlanPriority, type Pose, type SpatialAnnotation, type Vec2,
} from "@artfit/geometry";
import type { ArtworkModel, ArtworkPhoto } from "../viewer/artworkModel";
import { OccupancyCard, useOccupancy } from "./Occupancy";

export type WorkSpec = Omit<GroupWork, "pose" | "locked">;
export interface GroupDoc {
  works: WorkSpec[];
  order: string[];
  /** true once the user (or an AI request) set the viewing order; otherwise the shortest-walk order is suggested. */
  orderSet?: boolean;
  costs: CostItem[];
  budget: number | null;
  currency: string;
  bySpace: Record<string, { poses: Record<string, Pose | null>; locked: string[] }>;
}
interface Hist { past: { doc: GroupDoc; label: string }[]; present: { doc: GroupDoc; label: string }; future: { doc: GroupDoc; label: string }[]; version: number }

const ARTIST_COLORS = ["#171717", "#2f5d8a", "#9a4a24", "#4f6b3a", "#6b4f8a", "#7a6a1f"];
let idSeq = 0;
const newId = (p: string) => `${p}-${Date.now().toString(36)}-${++idSeq}`;

export function colorOfArtist(doc: GroupDoc, artist: string) {
  const artists = [...new Set(doc.works.map((w) => w.artist))];
  return ARTIST_COLORS[Math.max(0, artists.indexOf(artist)) % ARTIST_COLORS.length];
}

export function worksFor(doc: GroupDoc, spaceId: string): GroupWork[] {
  const s = doc.bySpace[spaceId] ?? { poses: {}, locked: [] };
  return doc.works.map((w) => ({ ...w, pose: s.poses[w.id] ?? null, locked: s.locked.includes(w.id) && !!s.poses[w.id] }));
}

const venueItem = (): CostItem => ({ id: "venue", label: "Venue: short-term rental for the exhibition dates", workId: null, amount: null, currency: "USD", status: "unknown" });

export function exampleGroup(first: { widthM: number; depthM: number; heightM: number; clearanceM: number }): Pick<GroupDoc, "works" | "costs" | "order"> {
  const works: WorkSpec[] = [
    { id: "w-1", artist: "Artist 1", title: "Work 1", ...first, required: true },
    { id: "w-2", artist: "Artist 2", title: "Work 2", widthM: 2, depthM: 1.5, heightM: 1.8, clearanceM: 1.2, required: true },
    { id: "w-3", artist: "Artist 2", title: "Work 3", widthM: 1.2, depthM: 1.2, heightM: 0.9, clearanceM: 1, required: false },
    { id: "w-4", artist: "Artist 3", title: "Work 4", widthM: 0.8, depthM: 0.8, heightM: 2.6, clearanceM: 1, required: true },
  ];
  return {
    works,
    order: works.map((w) => w.id),
    costs: [
      venueItem(),
      { id: newId("c"), label: "Transport: Work 2", workId: "w-2", amount: 650, currency: "USD", status: "quoted" },
      { id: newId("c"), label: "Install crew: Work 4", workId: "w-4", amount: 400, currency: "USD", status: "estimate" },
      { id: newId("c"), label: "Plinth and lighting rental", workId: null, amount: null, currency: "USD", status: "unknown" },
    ],
  };
}

export function useGroupPlanner(opts: { spaceIds: string[]; active: string; seed: { widthM: number; depthM: number; heightM: number; clearanceM: number }; budget: number | null; currency: string; works?: BriefWork[]; initialLayouts?: Record<string, Record<string, Pose | null>> | null }) {
  const [hist, setHist] = useState<Hist>(() => {
    // Works come from the brief (onboarding); a solo brief starts with the one work.
    const works: WorkSpec[] = opts.works?.length
      ? opts.works.map((w, i) => ({ id: w.id, artist: w.artist.trim() || "Artist not set", title: w.title.trim() || `Work ${i + 1}`, widthM: w.widthM, depthM: w.depthM, heightM: w.heightM, clearanceM: w.clearanceM ?? opts.seed.clearanceM, required: w.required }))
      : [{ id: "w-1", artist: "Artist 1", title: "Work 1", ...opts.seed, required: true }];
    const doc: GroupDoc = {
      works, order: works.map((w) => w.id), costs: [venueItem()], budget: opts.budget, currency: opts.currency,
      // The planning agent's chosen layout per space (only for works that exist), shown as the starting point.
      bySpace: Object.fromEntries(Object.entries(opts.initialLayouts ?? {}).map(([sid, poses]) => [sid, { poses: Object.fromEntries(Object.entries(poses).filter(([wid]) => works.some((w) => w.id === wid))), locked: [] }])),
    };
    return { past: [], present: { doc, label: opts.initialLayouts ? "Layout from the planning agent" : "Group started" }, future: [], version: 1 };
  });
  const doc = hist.present.doc;
  const commit = (next: GroupDoc, label: string) => setHist((h) => ({ past: [...h.past, h.present].slice(-60), present: { doc: next, label }, future: [], version: h.version + 1 }));
  const undo = () => setHist((h) => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future], version: h.version + 1 } : h));
  const redo = () => setHist((h) => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), version: h.version + 1 } : h));
  const space = (d: GroupDoc, id = opts.active) => d.bySpace[id] ?? { poses: {}, locked: [] };
  const withSpace = (d: GroupDoc, s: GroupDoc["bySpace"][string], id = opts.active): GroupDoc => ({ ...d, bySpace: { ...d.bySpace, [id]: s } });
  return {
    doc, version: hist.version, label: hist.present.label, canUndo: hist.past.length > 0, canRedo: hist.future.length > 0, undo, redo, commit,
    works: worksFor(doc, opts.active),
    setPoses(poses: Record<string, Pose | null>, label: string) {
      const s = space(doc);
      commit(withSpace(doc, { ...s, poses: { ...s.poses, ...poses } }), label);
    },
    setLocked(ids: string[], lock: boolean, label?: string) {
      const s = space(doc);
      const locked = lock ? [...new Set([...s.locked, ...ids.filter((id) => s.poses[id])])] : s.locked.filter((x) => !ids.includes(x));
      commit(withSpace(doc, { ...s, locked }), label ?? `${lock ? "Locked" : "Unlocked"} ${ids.length} work${ids.length > 1 ? "s" : ""}`);
    },
    updateWork(id: string, patch: Partial<WorkSpec>, label: string) { commit({ ...doc, works: doc.works.map((w) => (w.id === id ? { ...w, ...patch } : w)) }, label); },
    addWork(w: Omit<WorkSpec, "id">) {
      const id = newId("w");
      commit({ ...doc, works: [...doc.works, { ...w, id }], order: [...doc.order, id] }, `Added ${w.title} (${w.artist})`);
      return id;
    },
    removeWork(id: string) {
      const w = doc.works.find((x) => x.id === id);
      const bySpace = Object.fromEntries(Object.entries(doc.bySpace).map(([k, s]) => [k, { poses: Object.fromEntries(Object.entries(s.poses).filter(([wid]) => wid !== id)), locked: s.locked.filter((x) => x !== id) }]));
      commit({ ...doc, works: doc.works.filter((x) => x.id !== id), order: doc.order.filter((x) => x !== id), costs: doc.costs.filter((c) => c.workId !== id), bySpace }, `Removed ${w?.title ?? "work"} (by you)`);
    },
    setOrder(order: string[], label = "Viewing order changed") { commit({ ...doc, order: [...order, ...doc.order.filter((x) => !order.includes(x))], orderSet: true }, label); },
    useSuggestedOrder() { commit({ ...doc, orderSet: false }, "Using the suggested viewing order"); },
    /** The order to give the planner: only what the user actually set. */
    orderForPlanning: doc.orderSet ? doc.order : undefined,
    setCosts(costs: CostItem[]) { commit({ ...doc, costs }, "Costs updated"); },
    setBudget(budget: number | null) { commit({ ...doc, budget }, "Budget updated"); },
    loadExample() {
      const ex = exampleGroup(opts.seed);
      commit({ ...doc, ...ex, orderSet: false, bySpace: {} }, "Loaded the example group");
    },
  };
}
export type GroupPlanner = ReturnType<typeof useGroupPlanner>;

// ---------- left panel ----------

const COST_STATUS: Record<CostStatus, string> = { quoted: "Quoted", estimate: "My estimate", unknown: "Unknown" };

export function GroupWorksPanel({ g, selected, onSelect, viewRight, viewLabel, looks = {}, onLookFile, onLookRemove, lookMsg }: {
  g: GroupPlanner; selected: string | null; onSelect: (id: string | null) => void; viewRight: () => Vec2 | null; viewLabel: string;
  looks?: Record<string, WorkLook>; onLookFile?: (workId: string, file: File) => void; onLookRemove?: (workId: string) => void; lookMsg?: string | null;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ artist: "", title: "", widthM: 1, depthM: 1, heightM: 1.5, clearanceM: 1, required: true });
  const sel = g.works.find((w) => w.id === selected) ?? null;
  return (
    <>
      <div className="card">

        <ol className="work-list">
          {g.works.map((w) => (
            <li key={w.id}>
              <button type="button" className={"work-item" + (w.id === selected ? " on" : "")} aria-pressed={w.id === selected} onClick={() => onSelect(w.id === selected ? null : w.id)}>
                <i style={{ background: colorOfArtist(g.doc, w.artist) }} aria-hidden="true" />
                <span className="wi-main"><strong>{w.title}</strong><span>{w.artist}</span></span>
                <span className="wi-meta">{w.widthM}×{w.depthM}×{w.heightM} m{w.locked ? " · locked" : ""}{!w.pose ? " · not placed" : ""}{!w.required ? " · optional" : ""}</span>
              </button>
            </li>
          ))}
        </ol>
        {!adding
          ? <button type="button" onClick={() => setAdding(true)}>+ Add artwork</button>
          : <form className="add-work" onSubmit={(e) => { e.preventDefault(); if (!draft.artist.trim() || !draft.title.trim()) return; const id = g.addWork({ ...draft, artist: draft.artist.trim(), title: draft.title.trim() }); setAdding(false); onSelect(id); }}>
              <label>Artist<input value={draft.artist} onChange={(e) => setDraft({ ...draft, artist: e.target.value })} required /></label>
              <label>Title<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} required /></label>
              <div className="dims3">
                {(["widthM", "depthM", "heightM"] as const).map((k) => <label key={k}>{k === "widthM" ? "W" : k === "depthM" ? "D" : "H"} (m)<input type="number" min={0.1} step={0.1} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })} /></label>)}
              </div>
              <label>Viewing room (m)<input type="number" min={0} step={0.1} value={draft.clearanceM} onChange={(e) => setDraft({ ...draft, clearanceM: Number(e.target.value) })} /></label>
              <label className="check"><input type="checkbox" checked={draft.required} onChange={(e) => setDraft({ ...draft, required: e.target.checked })} /> Must be in the show</label>
              <div className="row"><button type="submit" className="primary">Add</button><button type="button" className="text-button" onClick={() => setAdding(false)}>Cancel</button></div>
            </form>}

      </div>
      {sel && (
        <div className="card">
          <h3>{sel.title} <span className="faint">· {sel.artist}</span></h3>
          <p className="faint">Real size. Only you change it; planning and the AI never resize or drop a work.</p>
          <div className="dims3">
            {(["widthM", "depthM", "heightM"] as const).map((k) => <label key={k}>{k === "widthM" ? "W" : k === "depthM" ? "D" : "H"} (m)<input type="number" min={0.1} step={0.05} value={sel[k]} onChange={(e) => Number(e.target.value) > 0 && g.updateWork(sel.id, { [k]: Number(e.target.value) }, `${sel.title}: ${k[0].toUpperCase()} ${e.target.value} m`)} /></label>)}
          </div>
          <div className="work-look">
            <h4>How it looks</h4>
            {looks[sel.id]?.model ? <p className="faint"><strong>{looks[sel.id].model!.title}</strong>{looks[sel.id].model!.credit ? ` · ${[looks[sel.id].model!.credit!.author?.replace(/\s*\(https?:[^)]*\)/, ""), looks[sel.id].model!.credit!.license?.replace(/\s*\(https?:[^)]*\)/, "")].filter(Boolean).join(" · ")}` : ""}. Stretched to the real size above; checks use the box.</p>
              : looks[sel.id]?.photo ? <><img className="photo-thumb" src={looks[sel.id].photo!.thumbUrl} alt={`Front photo of ${sel.title}`} /><p className="faint">On the box’s front face, cropped to fit.</p></>
              : <p className="faint">A plain box. Add a front photo or a .glb model, or drop one onto the view.</p>}
            <div className="row">
              <label className="file-button">Photo<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => { const f = e.target.files?.[0]; if (f) onLookFile?.(sel.id, f); e.target.value = ""; }} /></label>
              <label className="file-button">3D model (.glb)<input type="file" accept=".glb,model/gltf-binary" onChange={(e) => { const f = e.target.files?.[0]; if (f) onLookFile?.(sel.id, f); e.target.value = ""; }} /></label>
              {(looks[sel.id]?.model || looks[sel.id]?.photo) && <button type="button" className="text-button" onClick={() => onLookRemove?.(sel.id)}>Back to box</button>}
            </div>
            {lookMsg && <p className="faint">{lookMsg}</p>}
          </div>
          <label>Viewing room (m)<input type="number" min={0} step={0.05} value={sel.clearanceM} onChange={(e) => g.updateWork(sel.id, { clearanceM: Math.max(0, Number(e.target.value)) }, `${sel.title}: viewing room ${e.target.value} m`)} /></label>
          <label className="check"><input type="checkbox" checked={sel.required} onChange={(e) => g.updateWork(sel.id, { required: e.target.checked }, `${sel.title}: ${e.target.checked ? "must be in the show" : "optional"}`)} /> Must be in the show</label>
          <p className="faint">{!sel.pose ? "Not placed in this space yet. Use the layout options on the right." : sel.locked ? "Locked in place. Unlock it in the Move pad to move it." : "Move, turn or lock it with the Move pad on the view, or drag it in the 3D plan."}</p>
          <button type="button" className="text-button danger" onClick={() => { if (window.confirm(`Remove ${sel.title} by ${sel.artist} from the show?`)) { g.removeWork(sel.id); onSelect(null); } }}>Remove from the show</button>
        </div>
      )}
    </>
  );
}

/**
 * Place works that have no position in this space yet, like the single-work studio does on open: everything on a
 * first visit, later only the newly added works (placed works stay put). Works that don't fit stay "not placed"
 * and are reported — never shrunk or dropped. Each attempt runs once per space and set of unplaced works, so undoing
 * an automatic placement doesn't trigger it again.
 */
export function useAutoPlace(g: GroupPlanner, ann: SpatialAnnotation | null, spaceId: string, enabled: boolean) {
  const tried = useRef(new Set<string>());
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || !ann) return;
    const unplaced = g.works.filter((w) => !w.pose);
    if (!unplaced.length) return;
    const key = `${spaceId}|${unplaced.map((w) => `${w.id}:${w.widthM}x${w.depthM}:${w.clearanceM}`).join(",")}`;
    if (tried.current.has(key)) return;
    tried.current.add(key);
    const first = unplaced.length === g.works.length;
    // Placed works are treated as locked for this run so nothing the user arranged moves.
    const works = g.works.map((w) => (w.pose ? { ...w, locked: true } : w));
    const [plan] = suggestGroupPlans(ann, works, { order: g.orderForPlanning, priorities: ["room"], restarts: first ? 14 : 8 });
    if (!plan) return;
    const placed = Object.fromEntries(unplaced.filter((w) => plan.poses[w.id]).map((w) => [w.id, plan.poses[w.id]]));
    const missing = unplaced.filter((w) => !plan.poses[w.id]).map((w) => w.title);
    if (Object.keys(placed).length) g.setPoses(placed, first ? "Placed the works automatically (most room)" : `Placed ${Object.keys(placed).map((id) => g.works.find((w) => w.id === id)?.title).join(", ")} automatically`);
    setNote(missing.length ? `No room found for ${missing.join(", ")} with ${missing.length > 1 ? "their" : "its"} viewing room; ${missing.length > 1 ? "they stay" : "it stays"} unplaced.` : first ? "Works placed automatically with the most room around each. Adjust, lock or ask for other layouts." : null);
  }, [enabled, ann, spaceId, g.works]); // eslint-disable-line react-hooks/exhaustive-deps
  return note;
}

// ---------- right panel ----------

export function useGroupEvaluation(ann: SpatialAnnotation | null, g: GroupPlanner) {
  return useMemo(() => {
    if (!ann) return null;
    const poses = Object.fromEntries(g.works.map((w) => [w.id, w.pose]));
    return evaluateGroup(ann, g.works, poses, g.doc.orderSet ? g.doc.order : undefined);
  }, [ann, g.works, g.doc.order, g.doc.orderSet]);
}

export function GroupReviewPanel({ g, ev, ann, otherSpaces, onSelect, onHide, autoNote, onWalk, spaceUse }: {
  g: GroupPlanner; ev: GroupEvaluation | null; ann: SpatialAnnotation | null; onHide: () => void; autoNote?: string | null; onWalk?: () => void; spaceUse?: string | null;
  otherSpaces: { id: string; name: string; ann: SpatialAnnotation | null }[]; onSelect: (id: string) => void;
}) {
  const [plans, setPlans] = useState<{ version: number; list: GroupPlan[] } | null>(null);
  const [inUse, setInUse] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [elsewhere, setElsewhere] = useState<Record<string, string>>({});
  const name = (id: string) => { const w = g.doc.works.find((x) => x.id === id); return w ? w.title : id; };
  const suggest = () => {
    if (!ann) return;
    setBusy(true);
    setTimeout(() => { // let the busy state paint before the search
      try { setPlans({ version: g.version, list: suggestGroupPlans(ann, g.works, { order: g.orderForPlanning }) }); setInUse(null); } finally { setBusy(false); }
    }, 30);
  };
  const stale = plans && plans.version !== g.version;
  const budget = summarizeBudget(g.doc.costs, { amount: g.doc.budget, currency: g.doc.currency });
  const checkOther = (o: { id: string; name: string; ann: SpatialAnnotation | null }) => {
    if (!o.ann) { setElsewhere((m) => ({ ...m, [o.id]: "No traced floor plan" })); return; }
    setElsewhere((m) => ({ ...m, [o.id]: "Checking…" }));
    setTimeout(() => {
      const fresh = g.doc.works.map((w) => ({ ...w, pose: null, locked: false }));
      const [p] = suggestGroupPlans(o.ann!, fresh, { order: g.orderForPlanning, priorities: ["room"], restarts: 10 });
      setElsewhere((m) => ({ ...m, [o.id]: p ? `${p.metrics.requiredPlaced}/${p.metrics.requiredTotal} required works fit${p.metrics.placed > p.metrics.requiredPlaced ? `, ${p.metrics.placed - p.metrics.requiredPlaced} optional` : ""}${p.evaluation.ok ? "" : " · has issues"} (draft floor plan)` : "No layout found" }));
    }, 30);
  };
  const artists = [...new Set(g.doc.works.map((w) => w.artist))];
  const occ = useOccupancy(ann, g.works.filter((w) => w.pose).map((w) => ({ id: w.id, title: w.title, widthM: w.widthM, depthM: w.depthM, clearanceM: w.clearanceM, pose: w.pose! })));
  // What visitors follow: the user's order, or the route's suggested order (then any unplaced works).
  const shownOrder = g.doc.orderSet ? g.doc.order : [...(ev?.route.order ?? []), ...g.doc.order.filter((id) => !(ev?.route.order ?? []).includes(id))];
  const cls = !ev ? "unknown" : ev.ok ? "unknown" : "conflict";
  return (
    <>
      <div className="panel-head">
        <div>
          <h2>Layout</h2>
          <div className={`verdict ${cls}`} role="status">{!ev ? "Geometry unavailable" : ev.ok ? "No placement conflicts" : `${ev.conflicts.length} issue${ev.conflicts.length > 1 ? "s" : ""} to resolve`}</div>
          <div className="faint">{g.works.filter((w) => w.pose).length}/{g.works.length} placed · Review pending</div>
        </div>
        <button type="button" className="panel-hide" aria-label="Hide result panel" onClick={onHide}>→</button>
      </div>
      <div className="panel-body">
        <div className="card">
          {autoNote?.startsWith("No room found") && <p className="faint auto-note" role="status">{autoNote}</p>}
          {ev && ev.conflicts.length > 0 && <ul className="issue-list">{ev.conflicts.map((c) => <li key={c}>{c}</li>)}</ul>}
          <p className="faint review-note">Draft plan · unit match and geometry need review.</p>
          <details className="quiet-options"><summary>By artist</summary>
          <table className="kv"><tbody>
            {artists.map((a) => {
              const mine = g.works.filter((w) => w.artist === a);
              const okCount = mine.filter((w) => { const c = ev?.works.find((x) => x.workId === w.id); return c?.placed && c.valid && c.meetsClearance && c.reachable !== false; }).length;
              return <tr key={a}><td>{a}</td><td>{okCount}/{mine.length} works placed with their viewing room{mine.some((w) => w.required && !w.pose) ? " · a required work is not placed" : ""}</td></tr>;
            })}
          </tbody></table></details>
        </div>
        <div className="card">
          <div className="row route-head"><h3>Route</h3>{ev?.route.lengthM != null && onWalk && <button type="button" className="route-preview" onClick={onWalk}>Walk route<span aria-hidden="true">→</span></button>}</div>
          {ev?.route.note ? <p className="faint" role="status">{ev.route.note}</p> : ev?.route.lengthM != null ? <p className="faint">{Math.round(ev.route.lengthM)} m · {g.doc.orderSet ? "Custom order" : "Suggested order"}{ev.route.unreachable.length ? ` · Can’t reach ${ev.route.unreachable.map(name).join(", ")}` : ""}</p> : <p className="faint">Place artworks to preview a route.</p>}
          <p className="faint route-caveat">Preview only · safety and accessibility not checked.</p>
          {g.doc.orderSet && <button type="button" className="text-button order-reset" onClick={g.useSuggestedOrder}>Reset order</button>}
          <ol className="order-list">
            {shownOrder.map((id, i) => (
              <li key={id}>
                <button type="button" className="text-button" onClick={() => onSelect(id)}>{i + 1}. {name(id)}</button>
                <span>
                  <button type="button" aria-label={`Earlier: ${name(id)}`} disabled={i === 0} onClick={() => { const o = [...shownOrder]; [o[i - 1], o[i]] = [o[i], o[i - 1]]; g.setOrder(o); }}>↑</button>
                  <button type="button" aria-label={`Later: ${name(id)}`} disabled={i === shownOrder.length - 1} onClick={() => { const o = [...shownOrder]; [o[i + 1], o[i]] = [o[i], o[i + 1]]; g.setOrder(o); }}>↓</button>
                </span>
              </li>
            ))}
          </ol>
        </div>
        <details className="panel-disclosure"><summary>Layout options</summary><div className="card">
          <div className="row"><button type="button" className="primary" disabled={!ann || busy} onClick={suggest}>{busy ? "Searching…" : plans ? "Suggest again" : "Suggest layouts"}</button></div>
          <p className="faint">Tested suggestions. Locked artworks stay put; real sizes are preserved.</p>
          {inUse && !plans && <p className="faint">Using “{inUse}”. Undo returns to the previous layout; suggest again to compare.</p>}
          {stale && <p className="warn">The show changed since these were suggested. Suggest again before choosing.</p>}
          {plans?.list.length === 0 && <p className="warn">No layout found.</p>}
          {plans && plans.list.map((p) => (
            <div key={p.priority} className="alt">
              <strong>{p.label}</strong>
              <div>{p.metrics.requiredPlaced}/{p.metrics.requiredTotal} required works · {p.metrics.placed}/{g.works.length} placed · least spare room {p.metrics.minSlackM != null ? `${p.metrics.minSlackM.toFixed(2)} m` : "–"} · route {p.metrics.routeM != null ? `${Math.round(p.metrics.routeM)} m` : "unknown"}</div>
              <div className="faint">{p.metrics.kept.length ? `Keeps ${p.metrics.kept.map(name).join(", ")} where you locked ${p.metrics.kept.length > 1 ? "them" : "it"}. ` : ""}{p.metrics.moved.length ? `Moves ${p.metrics.moved.map(name).join(", ")}. ` : ""}{p.metrics.notPlaced.length ? `Couldn’t place ${p.metrics.notPlaced.map(name).join(", ")}. ` : ""}{p.evaluation.conflicts.length ? `${p.evaluation.conflicts.length} issue(s).` : "No issues found."}</div>
              <button type="button" disabled={!!stale} onClick={() => { g.setPoses(p.poses, `Used layout: ${p.label}`); setInUse(p.label); setPlans(null); }}>Use this layout</button>
            </div>
          ))}
          {otherSpaces.length > 0 && <>
            <h3 style={{ marginTop: 10 }}>Other spaces</h3>
            {otherSpaces.map((o) => <div key={o.id} className="row other-space"><span>{o.name}</span>{elsewhere[o.id] ? <span className="faint">{elsewhere[o.id]}</span> : <button type="button" className="text-button" onClick={() => checkOther(o)}>Check fit</button>}</div>)}
          </>}
        </div></details>
        <details className="panel-disclosure"><summary>Budget<span className="disclosure-status">{budget.status === "over_quoted" ? "Over budget" : budget.status === "unknown" ? "Needs review" : budget.status === "no_budget" ? "Not set" : "Quoted costs within budget"}</span></summary><div className="card">
          <label>Total budget ({g.doc.currency})<input type="number" min={0} step={100} value={g.doc.budget ?? ""} placeholder="Not set" onChange={(e) => g.setBudget(e.target.value === "" ? null : Number(e.target.value))} /></label>
          <div className={`budget-line ${budget.status}`}><strong>{budget.quoted.toLocaleString()} {budget.currency}</strong> quoted{budget.estimated ? <> · {budget.estimated.toLocaleString()} estimated</> : null}{budget.unknown.length ? <> · {budget.unknown.length} unknown</> : null}</div>
          <p className="faint">{budget.note} Unknown costs are not counted as zero. Moving works doesn’t change these costs; the listing’s asking rent is not a short-term price.</p>
          <ul className="cost-list">
            {g.doc.costs.map((c, i) => (
              <li key={c.id}>
                <span>{c.label}</span>
                <input type="number" min={0} step={50} aria-label={`${c.label} amount`} value={c.amount ?? ""} placeholder="?" onChange={(e) => { const costs = [...g.doc.costs]; const amount = e.target.value === "" ? null : Number(e.target.value); costs[i] = { ...c, amount, status: amount == null ? "unknown" : c.status === "unknown" ? "estimate" : c.status }; g.setCosts(costs); }} />
                <select aria-label={`${c.label} status`} value={c.status} onChange={(e) => { const costs = [...g.doc.costs]; costs[i] = { ...c, status: e.target.value as CostStatus, amount: e.target.value === "unknown" ? null : c.amount }; g.setCosts(costs); }}>
                  {(["quoted", "estimate", "unknown"] as const).map((s) => <option key={s} value={s}>{COST_STATUS[s]}</option>)}
                </select>
              </li>
            ))}
          </ul>
          <button type="button" className="text-button" onClick={() => { const label = window.prompt("Cost item (e.g. Transport: Work 2, wall rental)"); if (label?.trim()) g.setCosts([...g.doc.costs, { id: newId("c"), label: label.trim(), workId: null, amount: null, currency: g.doc.currency, status: "unknown" }]); }}>Add a cost</button>
        </div></details>
        {occ && <details className="panel-disclosure visitor-details"><summary>Visitor estimate<span className="disclosure-status">Unverified</span></summary><OccupancyCard est={occ} spaceUse={spaceUse} /></details>}
      </div>
    </>
  );
}

// ---------- AI ----------

export type GroupOp =
  | { op: "lock" | "unlock"; workIds: string[] }
  | { op: "set_order"; workIds: string[] }
  | { op: "rearrange"; priority: PlanPriority }
  | { op: "move"; workId: string; direction: "left" | "right" | "forward" | "back"; distance: Length }
  | { op: "rotate"; workId: string; degrees: number; rotation: "clockwise" | "counterclockwise" }
  | { op: "set_clearance"; workId: string; value: Length }
  | { op: "select"; workId: string }
  | { op: "undo" } | { op: "redo" };

/** Apply allowlisted group ops to the doc as ONE step. Returns the new doc, a summary, or an error. */
export function applyGroupOps(doc: GroupDoc, ops: GroupOp[], ctx: { spaceId: string; ann: SpatialAnnotation; viewRight: Vec2 | null }): { doc: GroupDoc; changes: string[]; select?: string } | { error: string } {
  let d = doc;
  const changes: string[] = [];
  let select: string | undefined;
  const sp = () => d.bySpace[ctx.spaceId] ?? { poses: {}, locked: [] };
  const setSp = (s: { poses: Record<string, Pose | null>; locked: string[] }) => { d = { ...d, bySpace: { ...d.bySpace, [ctx.spaceId]: s } }; };
  const title = (id: string) => d.works.find((w) => w.id === id)?.title ?? id;
  for (const o of ops) {
    if (o.op === "undo" || o.op === "redo") return { error: "undo/redo are handled separately" };
    const ids = "workIds" in o ? o.workIds : "workId" in o ? [o.workId] : [];
    for (const id of ids) if (!d.works.some((w) => w.id === id)) return { error: `unknown work ${id}` };
    switch (o.op) {
      case "lock": case "unlock": {
        const s = sp();
        const placed = o.workIds.filter((id) => s.poses[id]);
        if (o.op === "lock" && placed.length < o.workIds.length) return { error: `${o.workIds.filter((id) => !s.poses[id]).map(title).join(", ")} is not placed yet, so it can't be locked.` };
        setSp({ ...s, locked: o.op === "lock" ? [...new Set([...s.locked, ...placed])] : s.locked.filter((x) => !o.workIds.includes(x)) });
        changes.push(`${o.op === "lock" ? "Locked" : "Unlocked"} ${o.workIds.map(title).join(", ")}`);
        break;
      }
      case "set_order":
        d = { ...d, order: [...o.workIds, ...d.order.filter((x) => !o.workIds.includes(x))], orderSet: true };
        changes.push(`Viewing order: ${d.order.map(title).join(" → ")}`);
        break;
      case "rearrange": {
        const works = worksFor(d, ctx.spaceId);
        const [plan] = suggestGroupPlans(ctx.ann, works, { order: d.orderSet ? d.order : undefined, priorities: [o.priority], restarts: 14 });
        if (!plan) return { error: "No layout was found." };
        if (plan.metrics.requiredPlaced < plan.metrics.requiredTotal) return { error: `No layout fits every required work (couldn't place ${plan.metrics.notPlaced.map(title).join(", ")}). Nothing was changed.` };
        const s = sp();
        setSp({ ...s, poses: { ...s.poses, ...plan.poses } });
        changes.push(`Rearranged (${plan.label.toLowerCase()})${plan.metrics.kept.length ? `; kept ${plan.metrics.kept.map(title).join(", ")} in place` : ""}`);
        break;
      }
      case "move": case "rotate": {
        const s = sp();
        const p = s.poses[o.workId];
        if (!p) return { error: `${title(o.workId)} is not placed yet.` };
        if (s.locked.includes(o.workId)) return { error: `${title(o.workId)} is locked. Unlock it first.` };
        if (o.op === "move") {
          if (!ctx.viewRight) return { error: "The view direction is not known yet." };
          const m = toMeters(o.distance);
          if (!(Number.isFinite(m) && m >= 0 && m <= 50)) return { error: "invalid distance" };
          const v = directionVector(o.direction, ctx.viewRight);
          setSp({ ...s, poses: { ...s.poses, [o.workId]: { ...p, x: p.x + v.x * m, z: p.z + v.z * m } } });
          changes.push(`Moved ${title(o.workId)} ${o.direction} ${Math.round(m * 100)} cm`);
        } else {
          if (!(Number.isFinite(o.degrees) && o.degrees > 0 && o.degrees <= 360)) return { error: "invalid angle" };
          const delta = o.rotation === "clockwise" ? o.degrees : -o.degrees;
          setSp({ ...s, poses: { ...s.poses, [o.workId]: { ...p, rotDeg: ((p.rotDeg + delta) % 360 + 360) % 360 } } });
          changes.push(`Turned ${title(o.workId)} ${o.degrees}° ${o.rotation}`);
        }
        break;
      }
      case "set_clearance": {
        const m = toMeters(o.value);
        if (!(Number.isFinite(m) && m >= 0 && m <= 10)) return { error: "invalid viewing room" };
        d = { ...d, works: d.works.map((w) => (w.id === o.workId ? { ...w, clearanceM: Math.round(m * 100) / 100 } : w)) };
        changes.push(`${title(o.workId)}: viewing room ${Math.round(m * 100) / 100} m`);
        break;
      }
      case "select": select = o.workId; changes.push(`Selected ${title(o.workId)}`); break;
    }
  }
  return { doc: d, changes, select };
}

export function GroupAiBar({ g, spaceId, ann, aiReady, viewRight, onSelect }: { g: GroupPlanner; spaceId: string; ann: SpatialAnnotation | null; aiReady: boolean | null; viewRight: () => Vec2 | null; onSelect: (id: string) => void }) {
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(true);
  const [log, setLog] = useState<{ request: string; result: string }[]>([]);
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "ask" | "bad"; text: string }>({ kind: "idle", text: "" });
  const live = useRef({ spaceId, version: g.version });
  live.current = { spaceId, version: g.version };
  const logRef = useRef<HTMLOListElement>(null);
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [log.length, status.kind]);
  const send = async (message: string) => {
    const m = message.trim();
    if (!m || status.kind === "busy" || !ann) return;
    setExpanded(true);
    setText("");
    setStatus({ kind: "busy", text: m });
    const base = { spaceId, version: g.version };
    try {
      const res = await fetch("/api/workspace/group-edit", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ spaceId, baseVersion: g.version, message: m, recent: log.slice(-3),
          works: g.works.map((w) => ({ id: w.id, artist: w.artist, title: w.title, widthM: w.widthM, depthM: w.depthM, heightM: w.heightM, clearanceM: w.clearanceM, required: w.required, locked: w.locked, placed: !!w.pose })),
          order: g.doc.order }),
      });
      const out = await res.json();
      if (live.current.spaceId !== base.spaceId || live.current.version !== base.version) { setStatus({ kind: "bad", text: "The show changed while the AI was working, so this answer was skipped." }); return; }
      if (!res.ok || out.kind === "error" || out.kind === "unavailable") { setStatus({ kind: "bad", text: out.reason ?? out.error ?? `HTTP ${res.status}` }); return; }
      if (out.kind === "clarify" || out.kind === "unsupported") { setStatus({ kind: "ask", text: out.question }); setLog((l) => [...l, { request: m, result: "Not applied." }]); return; }
      const ops = out.ops as GroupOp[];
      if (ops.length === 1 && (ops[0].op === "undo" || ops[0].op === "redo")) { (ops[0].op === "undo" ? g.undo : g.redo)(); setLog((l) => [...l, { request: m, result: ops[0].op === "undo" ? "Undid the last change." : "Redid the change." }]); setStatus({ kind: "idle", text: "" }); return; }
      const r = applyGroupOps(g.doc, ops, { spaceId, ann, viewRight: viewRight() });
      if ("error" in r) { setStatus({ kind: "bad", text: r.error }); setLog((l) => [...l, { request: m, result: "Not applied." }]); return; }
      g.commit(r.doc, `AI: ${r.changes.join("; ")}`);
      if (r.select) onSelect(r.select);
      setLog((l) => [...l, { request: m, result: r.changes.join(" · ") + "." }]);
      setStatus({ kind: "idle", text: "" });
    } catch (e) {
      setStatus({ kind: "bad", text: (e as Error).message });
    }
  };
  const examples = ["Lock Work 1 and rearrange the rest", "Show Work 2 first, then Work 1", "Give every work more room"];
  return (
    <section className="dock" aria-label="Plan the group show with AI">
      <div className="dock-head">
        <strong>Edit with AI</strong>
        {aiReady === false ? <span className="dock-conn off">AI unavailable</span> : <span className={"dock-dot" + (aiReady ? " on" : "")} role="img" aria-label={aiReady ? "AI connected" : "Checking AI connection"} />}
        <div className="edit-history-buttons">
          <button type="button" onClick={g.undo} disabled={!g.canUndo || status.kind === "busy"}>Undo</button>
          <button type="button" onClick={g.redo} disabled={!g.canRedo || status.kind === "busy"}>Redo</button>
          <button type="button" aria-expanded={expanded} aria-controls="group-compose" aria-label={expanded ? "Collapse AI editor" : "Expand AI editor"} onClick={() => setExpanded((v) => !v)}>{expanded ? "Hide" : "Open"}</button>
        </div>
      </div>
      {(status.kind === "ask" || status.kind === "bad") && <div className={"dock-status" + (status.kind === "bad" ? " bad" : "")} role="status"><strong>{status.kind === "ask" ? "Needs your input" : "Not applied"}</strong> — {status.text}</div>}
      {status.kind === "busy" && <p className="dock-status" role="status">Working…</p>}
      {status.kind === "idle" && log.length > 0 && <p className="dock-feedback" role="status">{log[log.length - 1].result}</p>}
      <div id="group-compose" className="dock-compose" hidden={!expanded}>
      <form className="edit-bar-input" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <label htmlFor="group-request" className="sr-only">Describe the change</label>
        <input id="group-request" value={text} onChange={(e) => setText(e.target.value)} disabled={!aiReady || !ann} autoComplete="off"
          placeholder={aiReady === false ? "AI is not available — use the panels" : "Describe a change to your artworks…"} />
        {status.kind === "busy" ? <button type="button" disabled>Working…</button> : <button type="submit" className="primary" disabled={!aiReady || !text.trim()}>Apply<span aria-hidden="true">↵</span></button>}
      </form>
      <details className="dock-options"><summary>Examples &amp; history</summary>
      <div className="edit-examples">{examples.map((ex) => <button key={ex} type="button" className="text-button" disabled={!aiReady || status.kind === "busy"} onClick={() => void send(ex)}>{ex}</button>)}</div>
      {(log.length > 0 || status.kind === "busy") && (
        <ol className="dock-log" ref={logRef} aria-live="polite">
          {log.map((x, i) => <li key={i}><span className="req">{x.request}</span><span className="res">{x.result}</span></li>)}
          {status.kind === "busy" && <li><span className="req">{status.text}</span><span className="res"><span className="spinner" /> Working…</span></li>}
        </ol>
      )}
      </details></div>
    </section>
  );
}

/** Shapes for the renderers. */
export type WorkLook = { model?: ArtworkModel; photo?: ArtworkPhoto };
export function groupScene(g: GroupPlanner, ev: GroupEvaluation | null, selected: string | null, looks: Record<string, WorkLook> = {}) {
  const orderIdx = (id: string) => (ev?.route.order.indexOf(id) ?? -1);
  return {
    works: g.works.filter((w) => w.pose).map((w) => {
      const c = ev?.works.find((x) => x.workId === w.id);
      return {
        id: w.id, corners: workBody(w, w.pose!), heightM: w.heightM, color: colorOfArtist(g.doc, w.artist), selected: w.id === selected,
        issue: !!c && (!c.valid || !c.meetsClearance || c.reachable === false), locked: w.locked,
        label: `${orderIdx(w.id) >= 0 ? `${orderIdx(w.id) + 1}. ` : ""}${w.title}`, clearanceM: w.clearanceM, viewPoint: c?.viewPoint ?? null, pose: w.pose!, widthM: w.widthM, depthM: w.depthM,
        look: looks[w.id]?.model ? { model: { id: looks[w.id].model!.id, parts: looks[w.id].model!.parts } } : looks[w.id]?.photo ? { photo: looks[w.id].photo! } : null,
      };
    }),
    route: ev?.route.path ?? [],
    entrance: ev?.route.entrance ?? null,
  };
}
export type GroupSceneData = ReturnType<typeof groupScene>;
