// The exhibition planning agent, visible: every decision, tool call and result streams in as it happens, then a
// fact-checked recommendation the user can act on (open the agent's layout in the studio, copy the owner inquiry).
import { useRef, useState } from "react";
import type { ExhibitionBrief, Pose } from "@artfit/geometry";

type Ev = { type: string; [k: string]: any };
export type AgentLayouts = Record<string, Record<string, Pose | null>>; // spaceId → workId → pose

const TOOL_LABEL: Record<string, string> = {
  search_spaces: "Searched the CoStar snapshot",
  inspect_space: "Inspected a space",
  plan_group_layout: "Laid out the show",
  draft_inquiry: "Drafted questions for the owner",
};
const TOPIC_LABEL: Record<string, string> = {
  short_term_quote: "short-term quote", local_ceiling: "ceiling height", fixing_permission: "fixing on walls/ceiling", vacancy_now_and_dates: "vacancy for the dates",
  load_in_route: "load-in doors", exits_and_capacity: "exits & capacity", floor_and_light: "floor & light", other_works_sharing: "shared use",
};

function resultLine(name: string, s: any): string {
  if (!s) return "";
  if (s.error) return `Not possible: ${s.error}`;
  switch (name) {
    case "search_spaces": return `${s.funnel.marketedRecords.toLocaleString()} listings → ${s.funnel.matchBrief} match the brief → ${s.spacesWithFloorPlan.length} with a traced floor plan to lay out`;
    case "inspect_space": return `${s.name} · listed ceiling ${s.listedCeilingM != null ? `${s.listedCeilingM.toFixed(2)} m` : "unknown"} · ${s.floorPlan.traced ? "draft floor plan" : "no floor plan"} · on market ${s.monthsOnMarket} mo`;
    case "plan_group_layout": return `${s.space} · ${s.strategy.toLowerCase()} · ${s.requiredWorksPlaced} required works placed · ${s.leastSpareViewingRoomM != null ? `${s.leastSpareViewingRoomM} m spare` : "—"} · ${s.walkingRouteM != null ? `${s.walkingRouteM} m walk` : "no route"} · ~${s.peopleEstimate.viewing} visitors${s.issues.length ? ` · ${s.issues.length} issue(s)` : ""}`;
    case "draft_inquiry": return `Asks about ${s.topics.map((t: string) => TOPIC_LABEL[t] ?? t).join(", ")}`;
  }
  return "";
}

async function* ndjson(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) yield JSON.parse(line) as Ev; }
  }
}

export type AgentFinal = { recommendedSpaceId: string | null; ranking: { spaceId: string; name: string; verdict: string; reasons: string[]; layoutKey: string | null }[]; layouts: Record<string, { spaceId: string; poses: Record<string, Pose | null>; label: string }>; inquiries: { spaceId: string; name: string; text: string }[]; rejected: string[]; usage?: { inputTokens: number; outputTokens: number; turns: number } };

/** The agent's chosen layout for each ranked space. */
export const agentLayoutsOf = (f: AgentFinal): AgentLayouts =>
  Object.fromEntries(f.ranking.filter((r) => r.layoutKey && f.layouts[r.layoutKey]).map((r) => [r.spaceId, f.layouts[r.layoutKey!].poses]));

export default function ShowAgent({ brief, onFinal, onSkip, done }: { brief: ExhibitionBrief; onFinal: (f: AgentFinal | null) => void; onSkip: () => void; done: boolean }) {
  const [events, setEvents] = useState<Ev[]>([]);
  const [running, setRunning] = useState(false);
  const [openLog, setOpenLog] = useState(true);
  const abort = useRef<AbortController | null>(null);
  const works = brief.works?.length ?? 1;

  const run = async () => {
    abort.current?.abort();
    const ac = new AbortController(); abort.current = ac;
    setEvents([]); setRunning(true); onFinal(null); setOpenLog(true);
    try {
      const res = await fetch("/api/agent/show", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ brief }), signal: ac.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      for await (const ev of ndjson(res)) {
        setEvents((e) => [...e, ev]);
        if (ev.type === "final") { onFinal(ev.result); setOpenLog(false); setTimeout(() => document.getElementById("traced-heading")?.scrollIntoView({ behavior: "smooth", block: "start" }), 250); }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setEvents((x) => [...x, { type: "error", message: (e as Error).message }]);
    } finally { setRunning(false); }
  };

  const start = events.find((e) => e.type === "start");
  const final = events.find((e) => e.type === "final")?.result;
  const results = new Map(events.filter((e) => e.type === "tool_result").map((e) => [e.id, e]));
  const steps = events.filter((e) => e.type === "tool_call" || e.type === "thinking" || e.type === "error");
  return (
    <section className="show-agent" aria-labelledby="agent-heading">
      <div className="sa-head">
        <div>
          <div className="eyebrow">AI agent</div>
          <h2 id="agent-heading">Find the best space for your show.</h2>
          <p className="faint">The agent lays out all {works} work{works > 1 ? "s" : ""} in every listing with a floor plan, retries when something doesn’t fit, ranks the spaces and drafts questions for the owners. Every number comes from ArtFit’s tools, and its claims are fact-checked.</p>
        </div>
        <div className="sa-actions">
          <button type="button" className="primary" onClick={run} disabled={running}>{running ? "Finding…" : events.length ? "Run again" : "Find the best space"}<span aria-hidden="true">→</span></button>
          {!done && !running && <button type="button" className="text-button" onClick={onSkip}>Skip, show the spaces</button>}
        </div>
      </div>

      {final && (
        <p className="sa-done">
          <strong>{final.recommendedSpaceId ? `Recommended: ${final.ranking.find((r: any) => r.spaceId === final.recommendedSpaceId)?.name}.` : "No space can be recommended yet."}</strong>{" "}
          {final.usage ? `${final.usage.turns} reasoning turns · ${steps.filter((x) => x.type === "tool_call").length} tool calls.` : ""}{final.rejected?.length ? ` Fact check removed ${final.rejected.length} unsupported claim${final.rejected.length > 1 ? "s" : ""}.` : ""}
          {" "}<button type="button" className="text-button" aria-expanded={openLog} onClick={() => setOpenLog((v) => !v)}>{openLog ? "Hide the agent’s steps" : "Show the agent’s steps"}</button>
        </p>
      )}
      {events.length > 0 && openLog && (
        <div className="sa-body">
          <ol className="sa-steps" aria-live="polite">
            {start && <li className="sa-meta">{start.mode === "llm" ? `Claude (${start.model}) is planning` : start.note}</li>}
            {steps.map((e, i) => {
              if (e.type === "thinking") return <li key={i} className="sa-think"><span className="sa-k">Thinking</span><p>{e.text}</p></li>;
              if (e.type === "error") return <li key={i} className="sa-err"><span className="sa-k">Error</span><p>{e.message}</p></li>;
              const r = results.get(e.id);
              return (
                <li key={i} className={"sa-tool" + (r ? (r.ok ? " ok" : " bad") : " pending")}>
                  <span className="sa-k">{r ? (r.ok ? "✓" : "✕") : <span className="spinner" />}</span>
                  <div><strong>{TOOL_LABEL[e.name] ?? e.name}</strong>{e.name === "plan_group_layout" && <span className="faint"> · {e.input.priority === "route" ? "trying a route-first arrangement" : "most room first"}</span>}
                    {r && <p>{resultLine(e.name, r.summary)}</p>}{r && <span className="sa-ms">{r.ms} ms</span>}</div>
                </li>
              );
            })}
            {running && !final && <li className="sa-meta"><span className="spinner" /> Working…</li>}
          </ol>

        </div>
      )}
    </section>
  );
}
