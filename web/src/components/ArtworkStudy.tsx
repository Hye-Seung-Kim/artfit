import { useId } from "react";

/** An abstract artwork study, never presented as a property scan. */
export default function ArtworkStudy({ width, depth, height, clearance }: { width: number; depth: number; height: number; clearance: number }) {
  const titleId = useId();
  const w = Math.max(0.1, width || 0.1), d = Math.max(0.1, depth || 0.1), h = Math.max(0.1, height || 0.1);
  const scale = Math.min(142 / w, 100 / d, 172 / h);
  const W = w * scale, D = d * scale, H = h * scale, C = Math.min(Math.max(clearance || 0, 0) * scale, 58);
  const project = (x: number, z: number, y = 0) => `${245 + (x - z) * 0.82},${291 + (x + z) * 0.45 - y}`;
  const a = project(-W / 2, -D / 2), b = project(W / 2, -D / 2), c = project(W / 2, D / 2), e = project(-W / 2, D / 2);
  const A = project(-W / 2, -D / 2, H), B = project(W / 2, -D / 2, H), T = project(W / 2, D / 2, H), E = project(-W / 2, D / 2, H);
  return <figure className="artwork-study">
    <div className="study-heading"><span>Artwork study</span><span aria-hidden="true">Fig. 01</span></div>
    <svg viewBox="0 0 490 420" role="img" aria-labelledby={titleId}>
      <title id={titleId}>Isometric artwork study, {width} meters wide, {depth} meters deep and {height} meters high</title>
      <polygon points="40,288 245,174 450,288 245,402" fill="#eaecea" />
      <g stroke="#b9bfba" strokeWidth="0.7" fill="none"><path d="M40 288 245 402 450 288M91 259 296 374M143 231 348 345M194 202 399 316M91 317 296 202M143 345 348 231M194 374 399 259" /></g>
      <polygon points={[project(-W / 2 - C, -D / 2 - C), project(W / 2 + C, -D / 2 - C), project(W / 2 + C, D / 2 + C), project(-W / 2 - C, D / 2 + C)].join(" ")} fill="#6bdcc5" fillOpacity="0.7" stroke="#111" strokeWidth="0.8" strokeDasharray="3 4" />
      <polygon points={`${a} ${b} ${c} ${e}`} fill="#111" /><polygon points={`${e} ${c} ${T} ${E}`} fill="#171717" /><polygon points={`${c} ${b} ${B} ${T}`} fill="#393b39" /><polygon points={`${A} ${B} ${T} ${E}`} fill="#050505" />
      <path d={`M${E} ${T} ${B}M${T} ${c}`} fill="none" stroke="#747674" strokeWidth="0.6" />
      <g fill="none" stroke="#111" strokeWidth="0.8"><path d={`M${project(-W / 2, D / 2 + 25)} ${project(W / 2, D / 2 + 25)}`} /><path d={`M${project(-W / 2, D / 2 + 20)} ${project(-W / 2, D / 2 + 30)}M${project(W / 2, D / 2 + 20)} ${project(W / 2, D / 2 + 30)}`} /></g>
      <text x="42" y="55" fill="#111" fontSize="12">W {width} / D {depth} / H {height} m</text><path d="M40 72H94M40 72V126" fill="none" stroke="#111" /><text x="450" y="55" textAnchor="end" fill="#6a6d69" fontSize="11">Not to scale</text>
    </svg>
    <figcaption><span>One work. A world of possibilities.</span><span className="study-key"><i />Viewing clearance</span></figcaption>
  </figure>;
}
