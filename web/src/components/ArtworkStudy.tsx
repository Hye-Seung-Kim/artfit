import { useId, useRef, useState } from "react";

/** Which part of the study the current brief question is about (the rest recedes). */
export type StudyFocus = "size" | "clearance" | null;

/** An abstract artwork study, never presented as a property scan. */
/** Hands-on version for the landing page: drag the top to change height, the mint edge to change viewing room. */
export interface StudyHandles { onHeight: (m: number) => void; onClearance: (m: number) => void }
const HANDLE_SCALE = 36; // px per metre while interactive, so the box grows instead of the drawing re-fitting

export default function ArtworkStudy({ width, depth, height, clearance, focus = null, handles }: { width: number; depth: number; height: number; clearance: number; focus?: StudyFocus; handles?: StudyHandles }) {
  const titleId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [touched, setTouched] = useState(false);
  const [dragging, setDragging] = useState<"height" | "clearance" | null>(null);
  const w = Math.max(0.1, width || 0.1), d = Math.max(0.1, depth || 0.1), h = Math.max(0.1, height || 0.1);
  const scale = handles ? HANDLE_SCALE : Math.min(142 / w, 100 / d, 172 / h);
  const W = w * scale, D = d * scale, H = h * scale, C = Math.min(Math.max(clearance || 0, 0) * scale, handles ? 2.5 * scale : 58);
  const project = (x: number, z: number, y = 0) => `${245 + (x - z) * 0.82},${291 + (x + z) * 0.45 - y}`;
  const a = project(-W / 2, -D / 2), b = project(W / 2, -D / 2), c = project(W / 2, D / 2), e = project(-W / 2, D / 2);
  const A = project(-W / 2, -D / 2, H), B = project(W / 2, -D / 2, H), T = project(W / 2, D / 2, H), E = project(-W / 2, D / 2, H);
  // Pointer drag in SVG units: height follows vertical movement; clearance follows the box's x axis on screen.
  const round = (v: number) => Math.round(v * 10) / 10;
  const startDrag = (kind: "height" | "clearance") => (e: React.PointerEvent<SVGGElement>) => {
    if (!handles || !svgRef.current) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setTouched(true); setDragging(kind);
    const k = 1 / (svgRef.current.getScreenCTM()?.a || 1);
    const x0 = e.clientX, y0 = e.clientY, h0 = h, c0 = Math.max(0, clearance || 0);
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) * k, dy = (ev.clientY - y0) * k;
      if (kind === "height") handles.onHeight(Math.min(5, Math.max(0.3, round(h0 - dy / scale))));
      else handles.onClearance(Math.min(2.5, Math.max(0, round(c0 + (dx * 0.82 + dy * 0.45) / ((0.82 ** 2 + 0.45 ** 2) * scale)))));
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); setDragging(null); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
  };
  const keyAdjust = (kind: "height" | "clearance") => (e: React.KeyboardEvent) => {
    if (!handles) return;
    const step = { ArrowUp: 0.1, ArrowRight: 0.1, ArrowDown: -0.1, ArrowLeft: -0.1 }[e.key];
    if (step === undefined) return;
    e.preventDefault(); setTouched(true);
    if (kind === "height") handles.onHeight(Math.min(5, Math.max(0.3, round(h + step))));
    else handles.onClearance(Math.min(2.5, Math.max(0, round((clearance || 0) + step))));
  };
  const [hx, hy] = project(0, 0, H).split(",").map(Number);
  const [cx, cy] = project(W / 2 + C, 0).split(",").map(Number);
  const handle = (kind: "height" | "clearance", x: number, y: number, label: string, value: string) => (
    <g className={`study-handle ${kind}` + (dragging === kind ? " dragging" : "")} transform={`translate(${x} ${y})`} tabIndex={0} role="slider"
      aria-label={label} aria-valuetext={value} onPointerDown={startDrag(kind)} onKeyDown={keyAdjust(kind)} onFocus={() => setTouched(true)}>
      {!touched && <circle className="study-pulse" r="10" />}
      <circle className="study-hit" r="20" />
      <circle className="study-knob" r="8" />
      {kind === "height" && <path d="M0 -3.5 -2.5 -0.5H2.5ZM0 3.5 -2.5 0.5H2.5Z" className="study-arrow" />}
      {dragging === kind && <text y={-16} textAnchor="middle" className="study-readout">{value}</text>}
    </g>
  );

  return <figure className={"artwork-study" + (handles ? " interactive" : "")} data-focus={focus ?? undefined}>
    <div className="study-heading"><span>Artwork study</span><span aria-hidden="true">Fig. 01</span></div>
    <svg ref={svgRef} viewBox="0 0 490 420" role="img" aria-labelledby={titleId}>
      <title id={titleId}>Isometric artwork study, {width} meters wide, {depth} meters deep and {height} meters high</title>
      <polygon points="40,288 245,174 450,288 245,402" fill="#eaecea" />
      <g stroke="#b9bfba" strokeWidth="0.7" fill="none"><path d="M40 288 245 402 450 288M91 259 296 374M143 231 348 345M194 202 399 316M91 317 296 202M143 345 348 231M194 374 399 259" /></g>
      <polygon points={[project(-W / 2 - C, -D / 2 - C), project(W / 2 + C, -D / 2 - C), project(W / 2 + C, D / 2 + C), project(-W / 2 - C, D / 2 + C)].join(" ")} className="study-clearance" fill="#6bdcc5" fillOpacity="0.7" stroke="#111" strokeWidth="0.8" strokeDasharray="3 4" />
      <g className="study-box"><polygon points={`${a} ${b} ${c} ${e}`} fill="#111" /><polygon points={`${e} ${c} ${T} ${E}`} fill="#171717" /><polygon points={`${c} ${b} ${B} ${T}`} fill="#393b39" /><polygon points={`${A} ${B} ${T} ${E}`} fill="#050505" />
      <path d={`M${E} ${T} ${B}M${T} ${c}`} fill="none" stroke="#747674" strokeWidth="0.6" /></g>
      <g className="study-dims" fill="none" stroke="#111" strokeWidth="0.8"><path d={`M${project(-W / 2, D / 2 + 25)} ${project(W / 2, D / 2 + 25)}`} /><path d={`M${project(-W / 2, D / 2 + 20)} ${project(-W / 2, D / 2 + 30)}M${project(W / 2, D / 2 + 20)} ${project(W / 2, D / 2 + 30)}`} /></g>
      <text className="study-dims" x="42" y="55" fill="#111" fontSize="12">W {width} / D {depth} / H {height} m</text><path d="M40 72H94M40 72V126" fill="none" stroke="#111" /><text x="450" y="55" textAnchor="end" fill="#6a6d69" fontSize="11">{handles ? "Drag to try" : "Not to scale"}</text>
      {handles && handle("clearance", cx, cy, "Viewing room around the work", `${clearance} m viewing room`)}
      {handles && handle("height", hx, hy, "Artwork height", `${height} m high`)}
    </svg>
    <figcaption><span>{handles ? "Drag the top for height, the mint edge for viewing room." : "One work. A world of possibilities."}</span><span className="study-key"><i />Viewing clearance</span></figcaption>
  </figure>;
}
