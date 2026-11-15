// Shareable plan report: the layout drawn to scale, a 3D view and a scan view, the AI's walk-through of the
// visit (route, crowd, atmosphere) with every number checked, the computed figures, contacts and open questions.
// "Save as PDF" prints only the report; "Download plan" saves the floor plan as a PNG.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { bbox, estimateOccupancy, evaluateGroup, obstaclePolygon, roundedRect, workBody, type ExhibitionBrief, type GroupWork, type SpatialAnnotation } from "@artfit/geometry";
import type { SpaceContact } from "../api";

export interface ReportInput {
  ann: SpatialAnnotation;
  works: GroupWork[];               // with poses (unplaced works are listed as such)
  order?: string[];                 // user-set viewing order, if any
  colorOf: (w: GroupWork) => string;
  space: { name: string; address: string | null; use: string | null; listedSqFt: number | null; listedCeilingM: number | null; contacts: SpaceContact[] };
  brief: ExhibitionBrief;
  shots: { plan3d: string | null; scan: string | null };
}

type Narrative = { headline: string; sections: { key: string; heading: string; text: string }[]; droppedSentences: string[] };

function PlanSvg({ input, ev, svgRef, spare }: { input: ReportInput; ev: ReturnType<typeof evaluateGroup>; svgRef: React.RefObject<SVGSVGElement>; spare: (id: string) => number | null }) {
  const { ann, works } = input;
  const b = bbox(ann.floor);
  const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
  const pad = span * 0.1;
  const W = b.maxX - b.minX + pad * 2, H = b.maxZ - b.minZ + pad * 2 + span * 0.06;
  const k = W / 900; // 1 px of a 900 px-wide drawing, in metres
  const pts = (p: { x: number; z: number }[]) => p.map((v) => `${v.x},${v.z}`).join(" ");
  const route = ev.route.path;
  const n = (id: string) => ev.route.order.indexOf(id) + 1 || works.findIndex((w) => w.id === id) + 1;
  const scaleM = W > 24 ? 5 : W > 10 ? 2 : 1;
  const font = "Helvetica Neue, Arial, sans-serif";
  // Label boxes: placed above the work's viewing room, nudged down/right to stay inside the drawing and off each other.
  const placedWorks = works.filter((w) => w.pose);
  const labels: { x: number; y: number; w: number; h: number; id: string }[] = [];
  for (const w of placedWorks) {
    const room = roundedRect(w.pose!.x, w.pose!.z, w.widthM, w.depthM, w.pose!.rotDeg, w.clearanceM, 6);
    const top = Math.min(...room.map((p) => p.z)), bottom = Math.max(...room.map((p) => p.z));
    const lw = k * 236, lh = k * 64;
    let x = Math.min(Math.max(w.pose!.x - lw / 2, b.minX - pad + k * 6), b.maxX + pad - lw - k * 6);
    let y = top - lh - k * 6;
    if (y < b.minZ - pad + k * 4) y = bottom + k * 6;
    for (let tries = 0; tries < 8 && labels.some((l) => x < l.x + l.w && x + lw > l.x && y < l.y + l.h && y + lh > l.y); tries++) y += lh + k * 6;
    labels.push({ x, y, w: lw, h: lh, id: w.id });
  }
  return (
    <svg ref={svgRef} xmlns="http://www.w3.org/2000/svg" viewBox={`${b.minX - pad} ${b.minZ - pad} ${W} ${H}`} className="rp-plan" role="img" aria-label="Floor plan with the works, their viewing room, and the visitor route">
      <defs><marker id="rp-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="3" markerHeight="3" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#1f7a68" /></marker></defs>
      <rect x={b.minX - pad} y={b.minZ - pad} width={W} height={H} fill="#f3f4f2" />
      <polygon points={pts(ann.floor)} fill="#fff" stroke="#090a09" strokeWidth={k * 2.4} strokeLinejoin="round" />
      {ann.obstacles.map((o) => <polygon key={o.id} points={pts(obstaclePolygon(o))} fill={o.category === "entrance_zone" ? "#6bdcc5" : o.category === "uncertain_object" ? "#c9cdc6" : "#7a8077"} opacity={o.category === "entrance_zone" ? 0.9 : 1} />)}
      {/* viewing room around each work */}
      {placedWorks.map((w) => <polygon key={`room-${w.id}`} points={pts(roundedRect(w.pose!.x, w.pose!.z, w.widthM, w.depthM, w.pose!.rotDeg, w.clearanceM, 8))} fill={input.colorOf(w)} fillOpacity={0.07} stroke={input.colorOf(w)} strokeOpacity={0.55} strokeWidth={k * 1.2} strokeDasharray={`${k * 5} ${k * 4}`} />)}
      {route.length > 1 && <polyline points={pts(route)} fill="none" stroke="#1f7a68" strokeWidth={k * 2.4} strokeDasharray={`${k * 7} ${k * 5}`} markerMid="url(#rp-arrow)" markerEnd="url(#rp-arrow)" strokeLinejoin="round" />}
      {placedWorks.map((w) => <polygon key={w.id} points={pts(workBody(w, w.pose!))} fill={input.colorOf(w)} stroke="#fff" strokeWidth={k} />)}
      {ev.works.filter((c) => c.viewPoint).map((c) => <circle key={c.workId} cx={c.viewPoint!.x} cy={c.viewPoint!.z} r={k * 4.5} fill="#1f7a68" />)}
      {/* callouts: number, title, size, viewing room and what is spare */}
      {labels.map((l) => {
        const w = works.find((x) => x.id === l.id)!;
        const sp = spare(w.id);
        const ax = w.pose!.x, az = w.pose!.z;
        const lx = Math.min(Math.max(ax, l.x), l.x + l.w), ly = l.y + l.h / 2 < az ? l.y + l.h : l.y;
        return <g key={`lab-${l.id}`} fontFamily={font}>
          <line x1={ax} y1={az} x2={lx} y2={ly} stroke="#090a09" strokeWidth={k * 0.8} />
          <circle cx={ax} cy={az} r={k * 2.6} fill="#090a09" />
          <rect x={l.x} y={l.y} width={l.w} height={l.h} fill="#fff" stroke="#090a09" strokeWidth={k * 1} />
          <rect x={l.x} y={l.y} width={k * 32} height={l.h} fill={input.colorOf(w)} />
          <text x={l.x + k * 16} y={l.y + l.h / 2} fontSize={k * 20} fontWeight={800} fill="#fff" textAnchor="middle" dominantBaseline="central">{n(w.id)}</text>
          <text x={l.x + k * 41} y={l.y + k * 21} fontSize={k * 17} fontWeight={700} fill="#090a09">{w.title}</text>
          <text x={l.x + k * 41} y={l.y + k * 41} fontSize={k * 14} fill="#50544f">{w.widthM} × {w.depthM} × {w.heightM} m</text>
          <text x={l.x + k * 41} y={l.y + k * 57} fontSize={k * 13.5} fill={sp != null && sp < 0 ? "#b42318" : "#23644e"}>room {w.clearanceM} m{sp != null ? ` · ${sp >= 0 ? "+" : ""}${sp.toFixed(2)} spare` : ""}</text>
        </g>;
      })}
      {ev.route.entrance && <g fontFamily={font}><rect x={ev.route.entrance.x - k * 46} y={ev.route.entrance.z - k * 32} width={k * 92} height={k * 20} fill="#090a09" /><text x={ev.route.entrance.x} y={ev.route.entrance.z - k * 22} fontSize={k * 13} fontWeight={700} textAnchor="middle" dominantBaseline="central" fill="#fff">ENTRANCE</text></g>}
      <g transform={`translate(${b.minX - pad + k * 20}, ${b.minZ - pad + H - k * 22})`} fontFamily={font}>
        <rect width={scaleM} height={k * 4} fill="#090a09" />
        <rect width={scaleM / 2} height={k * 4} fill="#fff" stroke="#090a09" strokeWidth={k * 0.6} />
        <text x={0} y={-k * 5} fontSize={k * 13} fill="#50544f">0</text>
        <text x={scaleM} y={-k * 5} fontSize={k * 13} fill="#50544f" textAnchor="middle">{scaleM} m</text>
      </g>
    </svg>
  );
}

function people(cs: SpaceContact[]) {
  const m = new Map<string, SpaceContact & { roles: string[] }>();
  for (const c of cs) { const key = c.name ? `p:${c.name}` : `c:${c.company}`; const e = m.get(key); if (e) e.roles.push(c.role); else m.set(key, { ...c, roles: [c.role] }); }
  return [...m.values()];
}

export function PlanReport({ input, onClose }: { input: ReportInput; onClose: () => void }) {
  const { ann, works, brief, space } = input;
  const svgRef = useRef<SVGSVGElement>(null);
  const ev = useMemo(() => evaluateGroup(ann, works, Object.fromEntries(works.map((w) => [w.id, w.pose])), input.order), [ann, works, input.order]);
  const placed = works.filter((w) => w.pose);
  const occ = useMemo(() => estimateOccupancy(ann, placed.map((w) => ({ id: w.id, title: w.title, widthM: w.widthM, depthM: w.depthM, clearanceM: w.clearanceM, pose: w.pose! }))), [ann, placed]);
  const tallest = Math.max(...works.map((w) => w.heightM));
  const spare = (id: string) => { const c = ev.works.find((x) => x.workId === id); const w = works.find((x) => x.id === id)!; return c?.clearanceM != null ? c.clearanceM - w.clearanceM : null; };
  const title = works.length > 1 ? `A group show of ${works.length} works by ${new Set(works.map((w) => w.artist)).size} artists` : works[0]?.title || "A solo show";
  const facts = useMemo(() => ({
    space: { name: space.name, use: space.use, listedAreaSqFt: space.listedSqFt, listedCeilingM: space.listedCeilingM != null ? Number(space.listedCeilingM.toFixed(2)) : null, measuredLocalCeilingM: ann.ceilingHeightM != null ? Number(ann.ceilingHeightM.toFixed(2)) : null, floorPlan: "draft, unit match and tracing not yet reviewed" },
    dates: { opening: brief.exhibitionStart, closing: brief.exhibitionEnd },
    works: works.map((w) => ({ title: w.title, artist: w.artist, sizeM: { width: w.widthM, depth: w.depthM, height: w.heightM }, viewingRoomM: w.clearanceM, placed: !!w.pose, spareViewingRoomM: spare(w.id) != null ? Number(spare(w.id)!.toFixed(2)) : null, visitOrder: ev.route.order.indexOf(w.id) + 1 || null })),
    route: { visitingOrder: ev.route.order.map((id) => works.find((w) => w.id === id)?.title), walkM: ev.route.lengthM != null ? Math.round(ev.route.lengthM) : null, startsAt: "the traced entrance", note: ev.route.note },
    visitors: { viewingAtOnce: occ.estimate.gallery, standingEvent: occ.estimate.standing, perWorkAtOnce: occ.perWork.map((p) => ({ title: p.title, people: p.atOnce })), openFloorM2: Math.round(occ.netM2), doorways: occ.doors.length, twoExitsAdvisedAbove: 49 },
    tallestWorkM: tallest, issues: ev.conflicts,
  }), [ev, occ]); // eslint-disable-line react-hooks/exhaustive-deps

  const [nar, setNar] = useState<Narrative | null>(null);
  const [narState, setNarState] = useState<"loading" | "ok" | "unavailable" | "error">("loading");
  const [narMsg, setNarMsg] = useState("");
  useEffect(() => {
    let live = true;
    fetch("/api/report/narrate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ facts }) })
      .then((r) => r.json()).then((o) => {
        if (!live) return;
        if (o.kind === "ok") { setNar(o); setNarState("ok"); } else { setNarState(o.kind === "unavailable" ? "unavailable" : "error"); setNarMsg(o.reason ?? o.error ?? ""); }
      }).catch((e) => live && (setNarState("error"), setNarMsg(e.message)));
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    document.body.classList.add("printing-report");
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => { document.body.classList.remove("printing-report"); window.removeEventListener("keydown", k); };
  }, [onClose]);

  const downloadPlan = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas"); c.width = 1800; c.height = Math.round(1800 * (img.height / img.width || 0.6));
      const ctx = c.getContext("2d")!; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
      const a = document.createElement("a"); a.href = c.toDataURL("image/png"); a.download = `artfit-plan-${space.name.replace(/[^\w]+/g, "-").toLowerCase()}.png`; a.click();
    };
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
  };

  const contacts = people(space.contacts);
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  return createPortal(
    <div className="report-root" role="dialog" aria-modal="true" aria-label="Plan report">
      <div className="rp-toolbar">
        <strong>Plan report</strong>
        <span className="faint">{narState === "loading" ? "The AI is writing the walk-through…" : "Ready to share"}</span>
        <button type="button" onClick={downloadPlan}>Download plan (PNG)</button>
        <button type="button" className="primary" onClick={() => window.print()}>Save as PDF<span aria-hidden="true">↓</span></button>
        <button type="button" onClick={onClose} aria-label="Close report">Close</button>
      </div>
      <article className="report">
        <header className="rp-head">
          <div className="rp-brand"><img src="/brand/artfit-symbol.svg" alt="" /><img src="/brand/artfit-wordmark.svg" alt="ArtFit" /></div>
          <div className="eyebrow">Exhibition plan · {today}</div>
          <h1>{title}<br /><span>at {space.name}</span></h1>
          <p className="rp-sub">{space.address ?? ""}{space.address ? " · " : ""}{brief.exhibitionStart} → {brief.exhibitionEnd}</p>
          {narState === "ok" && nar?.headline && <p className="rp-lede">{nar.headline}</p>}
        </header>

        <section className="rp-figures">
          <p><strong>{placed.length}/{works.length}</strong><span>works placed</span></p>
          <p><strong>{ev.route.lengthM != null ? `${Math.round(ev.route.lengthM)} m` : "—"}</strong><span>walk, entrance and back</span></p>
          <p><strong>~{occ.estimate.gallery}</strong><span>visitors viewing at once</span></p>
          <p><strong>~{occ.estimate.standing}</strong><span>at a standing opening</span></p>
        </section>

        <section className="rp-plan-wrap">
          <h2>The layout</h2>
          <PlanSvg input={input} ev={ev} svgRef={svgRef} spare={spare} />
          <p className="rp-legend"><span><i className="lg-room" />Viewing room</span><span><i className="lg-route" />Visitor route</span><span><i className="lg-spot" />Where to stand</span><span><i className="lg-door" />Doorway</span>{works.map((w) => <span key={w.id}><i style={{ background: input.colorOf(w) }} />{ev.route.order.indexOf(w.id) + 1 || "–"}. {w.title}</span>)}</p>
        </section>

        {(input.shots.plan3d || input.shots.scan) && (
          <section className="rp-shots">
            {input.shots.plan3d && <figure><img src={input.shots.plan3d} alt="3D planning view" /><figcaption>3D planning view (reconstructed from the traced floor plan)</figcaption></figure>}
            {input.shots.scan && <figure><img src={input.shots.scan} alt="Inside the Matterport scan" /><figcaption>Inside the Matterport scan (conditions at capture time)</figcaption></figure>}
          </section>
        )}

        <section className="rp-story">
          <h2>The visit, in words <span className="rp-ai">AI · numbers checked</span></h2>
          {narState === "loading" && <p className="faint"><span className="spinner" /> Writing…</p>}
          {narState !== "loading" && narState !== "ok" && <p className="faint">AI walk-through unavailable ({narMsg}). The figures below are complete.</p>}
          {nar?.sections.map((s) => <div key={s.key} className="rp-par"><h3>{s.heading}</h3><p>{s.text}</p></div>)}
          {nar && nar.droppedSentences.length > 0 && <p className="rp-check">Fact check removed {nar.droppedSentences.length} sentence{nar.droppedSentences.length > 1 ? "s" : ""} with numbers not in the layout facts.</p>}
        </section>

        <section className="rp-table">
          <h2>The works</h2>
          <table><thead><tr><th>#</th><th>Work</th><th>Artist</th><th>Size (W × D × H)</th><th>Viewing room</th><th>Spare</th><th>At once</th></tr></thead><tbody>
            {works.map((w) => { const sp = spare(w.id); const at = occ.perWork.find((p) => p.id === w.id); return <tr key={w.id}><td>{ev.route.order.indexOf(w.id) + 1 || "–"}</td><td>{w.title}</td><td>{w.artist}</td><td>{w.widthM} × {w.depthM} × {w.heightM} m</td><td>{w.clearanceM} m</td><td>{w.pose ? (sp != null ? `${sp.toFixed(2)} m` : "—") : "not placed"}</td><td>{at ? `~${at.atOnce}` : "—"}</td></tr>; })}
          </tbody></table>
          {ev.conflicts.length > 0 && <ul className="rp-issues">{ev.conflicts.map((c) => <li key={c}>{c}</li>)}</ul>}
        </section>

        <section className="rp-two">
          <div>
            <h2>The space</h2>
            <dl>
              <dt>Use</dt><dd>{space.use ?? "—"}</dd>
              <dt>Advertised area</dt><dd>{space.listedSqFt != null ? `${space.listedSqFt.toLocaleString()} SF` : "—"} · open floor after works ~{Math.round(occ.netM2)} m²</dd>
              <dt>Ceiling</dt><dd>{ann.ceilingHeightM != null ? `${ann.ceilingHeightM.toFixed(2)} m measured` : space.listedCeilingM != null ? `${space.listedCeilingM.toFixed(2)} m listed (building) · not measured here` : "not listed"} · tallest work {tallest} m</dd>
              <dt>Doorways traced</dt><dd>{occ.doors.length}{occ.estimate.gallery > 49 || occ.estimate.standing > 49 ? " · over 49 people usually needs two exits" : ""}</dd>
            </dl>
          </div>
          <div>
            <h2>Who to contact</h2>
            {contacts.length ? <ul className="rp-contacts">{contacts.slice(0, 3).map((c, i) => <li key={i}><strong>{c.name ?? c.company}</strong>{c.name && c.company ? ` · ${c.company}` : ""}<br /><span className="faint">{c.roles.join(" · ")}</span>{c.email || c.phone ? <><br />{[c.email, c.phone].filter(Boolean).join(" · ")}</> : null}</li>)}</ul> : <p className="faint">No contacts in the listing.</p>}
          </div>
        </section>

        <footer className="rp-foot">
          Planning estimate, not a booking or a compliance certificate. CoStar data-kit snapshot (Nov 2026); listings don’t confirm vacancy, furniture or short-term use. The floor plan is a draft traced from a Matterport scan and still needs review; route and visitor numbers are previews — the fire marshal sets the legal capacity. Contacts are anonymized in the hackathon kit. Made with ArtFit.
        </footer>
      </article>
    </div>,
    document.body,
  );
}
