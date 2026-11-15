// "Who do I contact?" — listing and property contacts from the CoStar kit, plus the listing facts that matter for
// an exhibition inquiry. Opens from a property name (Discover cards, Workspace title).
import { useEffect, useRef } from "react";
import type { SpaceContact } from "../api";

export interface SpaceInfoData {
  name: string; address: string | null; use: string | null; listedSqFt: number | null; availability: string | null;
  rate: string | null; ceilingM: number | null; monthsOnMarket: number | null; brokerageCompany: string | null;
  contacts: SpaceContact[]; inquiry?: string | null;
}

/** One entry per person or company, with all of their roles. */
function people(cs: SpaceContact[]) {
  const m = new Map<string, SpaceContact & { roles: string[] }>();
  for (const c of cs) {
    const k = c.name ? `p:${c.name}|${c.email}` : `c:${c.company}`;
    const e = m.get(k);
    if (e) e.roles.push(c.role); else m.set(k, { ...c, roles: [c.role] });
  }
  return [...m.values()];
}

export function SpaceInfo({ data, onClose }: { data: SpaceInfoData; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  // No close() on cleanup: in dev StrictMode that would fire onClose right after opening. Unmounting removes it.
  useEffect(() => { const d = ref.current; if (d && !d.open) d.showModal(); }, []);
  const ps = people(data.contacts);
  const primary = ps.find((p) => p.email || p.phone);
  const mail = (to: string) => `mailto:${to}?subject=${encodeURIComponent(`Short-term exhibition inquiry: ${data.name}`)}${data.inquiry ? `&body=${encodeURIComponent(data.inquiry)}` : ""}`;
  return (
    <dialog ref={ref} className="space-info" onClose={onClose} onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }} aria-labelledby="si-title">
      <div className="si-head">
        <div><div className="eyebrow">Space info</div><h2 id="si-title">{data.name}</h2><p className="faint">{data.address ?? "Address not reported"}</p></div>
        <button type="button" className="panel-hide" aria-label="Close" onClick={() => ref.current?.close()}>×</button>
      </div>
      <section>
        <h3>Who to contact</h3>
        {ps.length ? <ul className="si-contacts">
          {ps.map((p, i) => (
            <li key={i} className={p === primary ? "primary-contact" : ""}>
              <div><strong>{p.name ?? p.company}</strong>{p.name && p.company ? <span className="faint"> · {p.company}</span> : null}</div>
              <div className="si-roles">{p.roles.join(" · ")}</div>
              {(p.email || p.phone) && <div className="si-links">
                {p.email && <a href={mail(p.email)}>{p.email}</a>}
                {p.phone && <a href={`tel:${p.phone.replace(/[^\d+]/g, "")}`}>{p.phone}</a>}
              </div>}
            </li>
          ))}
        </ul> : <p className="faint">No contacts in the listing record. {data.brokerageCompany ? `Brokerage: ${data.brokerageCompany}.` : ""}</p>}
        {primary?.email && <a className="si-cta" href={mail(primary.email)}>{data.inquiry ? "Email the agent’s inquiry" : "Email about a short-term exhibition"}<span aria-hidden="true">↗</span></a>}
        <p className="faint si-note">From the CoStar data kit (Nov 2026 snapshot). In this hackathon kit, names, emails and phone numbers are anonymized placeholders.</p>
      </section>
      <section>
        <h3>The listing</h3>
        <dl className="si-facts">
          <dt>Use</dt><dd>{data.use ?? "Not reported"}</dd>
          <dt>Advertised area</dt><dd>{data.listedSqFt != null ? `${data.listedSqFt.toLocaleString()} SF` : "Not reported"}</dd>
          <dt>Availability</dt><dd>{data.availability ?? "Not confirmed"}</dd>
          <dt>Asking rent</dt><dd>{data.rate ?? "Not given"} <span className="faint">(long-term lease; not a short-term price)</span></dd>
          <dt>Listed ceiling</dt><dd>{data.ceilingM != null ? `${data.ceilingM.toFixed(2)} m (building figure)` : "Not listed"}</dd>
          <dt>On the market</dt><dd>{data.monthsOnMarket != null ? `${Math.floor(data.monthsOnMarket)} months` : "Unknown"}</dd>
        </dl>
      </section>
      {data.inquiry && <section><h3>Questions to ask</h3><pre className="si-inquiry">{data.inquiry}</pre></section>}
    </dialog>
  );
}
