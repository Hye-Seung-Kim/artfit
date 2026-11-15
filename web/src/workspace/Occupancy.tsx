// "How many people" — a planning estimate from the traced floor and doorways, never a legal capacity.
import { useMemo } from "react";
import { estimateOccupancy, TWO_EXIT_THRESHOLD, type OccupancyEstimate, type OccupancyWork, type SpatialAnnotation } from "@artfit/geometry";

export function useOccupancy(ann: SpatialAnnotation | null, works: OccupancyWork[]): OccupancyEstimate | null {
  const key = JSON.stringify(works.map((w) => [w.id, w.widthM, w.depthM, w.clearanceM, w.pose]));
  return useMemo(() => (ann ? estimateOccupancy(ann, works) : null), [ann, key]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function OccupancyCard({ est, spaceUse }: { est: OccupancyEstimate | null; spaceUse?: string | null }) {
  if (!est) return null;
  const m2 = (n: number) => `${n.toFixed(0)} m²`;
  return (
    <div className="card occupancy">
      <h3>How many people</h3>
      <p className="faint">A planning estimate from the traced floor, not a legal capacity.</p>
      <div className="occ-figures">
        <p><strong>~{est.estimate.gallery}</strong><span>viewing the show<small>{est.estimate.limitedBy.gallery === "doors" ? "limited by doorways" : "30 sq ft each (gallery use)"}</small></span></p>
        <p><strong>~{est.estimate.standing}</strong><span>at a standing event<small>{est.estimate.limitedBy.standing === "doors" ? "limited by doorways" : "5 sq ft each (e.g. an opening)"}</small></span></p>
      </div>
      <table className="kv"><tbody>
        <tr><td>Open floor</td><td>{m2(est.netM2)} <span className="faint">= traced {m2(est.floorM2)} − works {m2(est.worksM2)}{est.fixedM2 > 0.5 ? ` − fixed objects ${m2(est.fixedM2)}` : ""}</span></td></tr>
        <tr><td>Doorways</td><td>{est.doors.length ? <>{est.doors.map((d) => `${d.widthM.toFixed(2)} m`).join(", ")} → about {est.byDoors} people if every one is an exit <span className="faint">(0.2 in of width each)</span></> : "No doorway traced; door capacity not estimated."}</td></tr>
        {est.perWork.length > 0 && <tr><td>At each work at once</td><td>{est.perWork.map((w) => `${w.title}: ~${w.atOnce}`).join(" · ")} <span className="faint">(about 1 m² each in its open viewing room)</span></td></tr>}
      </tbody></table>
      {(est.twoExits.gallery || est.twoExits.standing) && (
        <p className="warn">Above {TWO_EXIT_THRESHOLD} people{est.twoExits.gallery ? "" : " (the standing event)"}, an assembly space usually needs at least two exits. {est.twoExits.tracedDoorways} doorway{est.twoExits.tracedDoorways === 1 ? " is" : "s are"} traced, but whether they are exits isn’t known.</p>
      )}
      <p className="faint">The fire marshal or building official sets the legal capacity under the local code. {spaceUse ? `This is listed as ${spaceUse} space, and an` : "An"} exhibition is usually an assembly use, so a change of use or a temporary event permit may be needed. Sprinklers, exit routes and the draft floor plan can all change these numbers.</p>
    </div>
  );
}

export function occupancyChecklistLine(est: OccupancyEstimate | null): string | null {
  if (!est) return null;
  return `- People: planning estimate about ${est.estimate.gallery} viewing / ${est.estimate.standing} at a standing event (open floor ${est.netM2.toFixed(0)} m²; ${est.doors.length} traced doorway${est.doors.length === 1 ? "" : "s"}). Ask the fire marshal / building official for the legal occupant load, which doorways are exits, and whether an exhibition needs a change of use or event permit.`;
}
