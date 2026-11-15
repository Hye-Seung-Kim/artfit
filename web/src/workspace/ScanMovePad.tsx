// Move pad over the Matterport scan, where works can't be dragged: pick a work in the middle (‹ ›), move it with
// the arrows around it (relative to the current scan view), turn it, lock it, or click the floor to place it.
import { useEffect, useRef, useState } from "react";

export interface PadWork { id: string; title: string; locked: boolean; placed: boolean }

export function ScanMovePad({ works, selected, onSelect, onMove, onRotate, onLock, placing, onPlacing, note, canPlace = true }: {
  works: PadWork[]; selected: string | null; onSelect: (id: string) => void;
  onMove: (dir: "forward" | "right" | "back" | "left", meters: number) => void;
  onRotate: (deg: number) => void; onLock?: () => void;
  placing: boolean; onPlacing: (on: boolean) => void; note?: string | null;
  /** Click-to-place needs the scan; in the 3D plan, works are dragged instead. */
  canPlace?: boolean;
}) {
  const [step, setStep] = useState(0.1);
  // Phones start with the pad folded so it doesn't cover the plan; one tap opens it.
  const [open, setOpen] = useState(() => !(typeof window !== "undefined" && window.matchMedia?.("(max-width: 760px)").matches));
  const i = Math.max(0, works.findIndex((w) => w.id === selected));
  const w = works[i];
  const cycle = (d: number) => works.length && onSelect(works[(i + d + works.length) % works.length].id);
  const off = !w || !w.placed || w.locked;
  // Keyboard inside the pad (focus on a pad button).
  const onKey = (e: React.KeyboardEvent) => {
    const k: Record<string, "forward" | "right" | "back" | "left"> = { ArrowUp: "forward", ArrowRight: "right", ArrowDown: "back", ArrowLeft: "left" };
    if (k[e.key] && !off) { e.preventDefault(); onMove(k[e.key], e.shiftKey ? 0.5 : step); }
    else if (e.key === "[" && !off) onRotate(-15);
    else if (e.key === "]" && !off) onRotate(15);
  };
  useEffect(() => { if (off && placing) onPlacing(false); }, [off]); // eslint-disable-line react-hooks/exhaustive-deps
  // Arrow keys anywhere on the page move the selected work while the pad is open (Shift = 50 cm step, [ ] turn).
  // Typing in a field, a modifier shortcut or an open dialog keeps the keys for themselves.
  const latest = { off, step, onMove, onRotate };
  const ref = useRef(latest); ref.current = latest;
  useEffect(() => {
    if (!open) return;
    const onWinKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true'], dialog[open], .movepad")) return;
      if (document.querySelector("dialog[open]")) return;
      const { off, step, onMove, onRotate } = ref.current;
      const k: Record<string, "forward" | "right" | "back" | "left"> = { ArrowUp: "forward", ArrowRight: "right", ArrowDown: "back", ArrowLeft: "left" };
      if (k[e.key]) { e.preventDefault(); if (!off) onMove(k[e.key], e.shiftKey ? 0.5 : step); }
      else if (e.key === "[" && !off) onRotate(-15);
      else if (e.key === "]" && !off) onRotate(15);
    };
    window.addEventListener("keydown", onWinKey);
    return () => window.removeEventListener("keydown", onWinKey);
  }, [open]);
  if (!works.length) return null;
  if (!open) return <button type="button" className="movepad-tab" onClick={() => setOpen(true)}>Move a work</button>;
  return (
    <section className="movepad" aria-label="Move a work in the scan" onKeyDown={onKey}>
      <div className="movepad-head"><strong>Move</strong><span className="faint">relative to this view</span><button type="button" className="movepad-close" aria-label="Hide move pad" onClick={() => setOpen(false)}>×</button></div>
      <div className="movepad-dial" role="group" aria-label={`Move ${w?.title ?? "work"}`}>
        <button type="button" className="mp-up" aria-label="Move away" disabled={off} onClick={() => onMove("forward", step)}>↑</button>
        <button type="button" className="mp-right" aria-label="Move right" disabled={off} onClick={() => onMove("right", step)}>→</button>
        <button type="button" className="mp-down" aria-label="Move toward you" disabled={off} onClick={() => onMove("back", step)}>↓</button>
        <button type="button" className="mp-left" aria-label="Move left" disabled={off} onClick={() => onMove("left", step)}>←</button>
        <div className="mp-center">
          {works.length > 1 && <button type="button" className="mp-cycle" aria-label="Previous work" onClick={() => cycle(-1)}>‹</button>}
          <span className="mp-name" aria-live="polite">{w?.title}<small>{!w?.placed ? "not placed" : w.locked ? "locked" : `${works.length > 1 ? `${i + 1} of ${works.length}` : "selected"}`}</small></span>
          {works.length > 1 && <button type="button" className="mp-cycle" aria-label="Next work" onClick={() => cycle(1)}>›</button>}
        </div>
      </div>
      <div className="movepad-row">
        <button type="button" disabled={off} onClick={() => onRotate(-15)} aria-label="Turn left 15 degrees">⟲ 15°</button>
        <button type="button" disabled={off} onClick={() => onRotate(15)} aria-label="Turn right 15 degrees">⟳ 15°</button>
        <span className="mp-steps" role="group" aria-label="Step">
          {[0.1, 0.5].map((v) => <button key={v} type="button" aria-pressed={step === v} onClick={() => setStep(v)}>{v === 0.1 ? "10 cm" : "50 cm"}</button>)}
        </span>
      </div>
      <div className="movepad-row">
        {canPlace ? <button type="button" className={placing ? "primary" : ""} aria-pressed={placing} disabled={off} onClick={() => onPlacing(!placing)}>{placing ? "Click the floor…" : "Click to place"}</button>
          : <span className="faint mp-hint">or drag it in the plan</span>}
        {onLock && w?.placed && <button type="button" aria-pressed={!!w.locked} onClick={onLock}>{w.locked ? "Unlock" : "Lock"}</button>}
      </div>
      {note && <p className="faint movepad-note">{note}</p>}
    </section>
  );
}
