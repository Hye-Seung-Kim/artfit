// ArtFit agent panel: natural-language request → Claude plans calls to the four deterministic tools.
// Shows every tool call and result as it happens, so it is clear what the AI did and where numbers came from.
import { useEffect, useRef, useState } from "react";
import { fmtM, type ExhibitionBrief } from "@artfit/geometry";

type Ev = { type: string; [k: string]: any };

const TOOL_LABEL: Record<string, string> = {
  search_spaces: "Search CoStar snapshot",
  inspect_space: "Inspect space evidence",
  evaluate_placement: "Run placement search",
  plan_alternatives: "Precompute alternatives",
};

function summaryLine(name: string, s: any): string {
  if (!s) return "";
  if (s.error) return `Rejected: ${s.error}`;
  switch (name) {
    case "search_spaces": return `N ${s.funnel.N} → M ${s.funnel.M} → K ${s.funnel.K} → V ${s.funnel.V} · ${s.spacesWithTracedGeometry.length} with traced geometry`;
    case "inspect_space": return `${s.name} · match ${s.matchVerified ? "reviewed" : "not verified"} · ${s.conditions.occupancy}`;
    case "evaluate_placement": return s.available === false ? `No traced geometry (${s.reason})` : `${s.status === "unknown" ? `exploratory ${s.exploratoryStatus}` : s.status} · ${s.passCount} passing layouts · best ${s.bestSampledClearanceM != null ? fmtM(s.bestSampledClearanceM) + " m (rounded down)" : "none"} · ${s.tested}`;
    case "plan_alternatives": return `recommendation: ${s.recommendation} · other space: ${s.keepRequirements?.status ?? "none"} · same space: ${s.adjustInPlace.status}${s.adjustInPlace.proposedClearanceM != null ? ` (${s.adjustInPlace.proposedClearanceM} m)` : ""}`;
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
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield JSON.parse(line) as Ev;
    }
  }
}

export default function AgentPanel({ brief, onResult }: { brief: ExhibitionBrief; onResult: (r: any) => void }) {
  const [status, setStatus] = useState<{ configured: boolean; model: string } | null>(null);
  const [message, setMessage] = useState("I have a 4 m × 3 m sculpture, 2.4 m tall. I want 1.5 m of walking room around it, at least 1 m. Houston, March 5–21 2027, flex or industrial space.");
  const [events, setEvents] = useState<Ev[]>([]);
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => { fetch("/api/agent/status").then((r) => r.json()).then(setStatus).catch(() => setStatus(null)); }, []);

  const run = async (useForm: boolean) => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setEvents([]);
    setRunning(true);
    try {
      const res = await fetch("/api/agent/run", {
        method: "POST", headers: { "content-type": "application/json" }, signal: ac.signal,
        body: JSON.stringify(useForm ? { message: message || "", brief } : { message }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      for await (const ev of ndjson(res)) {
        setEvents((e) => [...e, ev]);
        if (ev.type === "final") onResult(ev.result);
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setEvents((ev) => [...ev, { type: "error", message: (e as Error).message }]);
    } finally {
      setRunning(false);
    }
  };

  const start = events.find((e) => e.type === "start");
  const final = events.find((e) => e.type === "final")?.result;
  const results = new Map(events.filter((e) => e.type === "tool_result").map((e) => [e.id, e]));
  const aiOn = status?.configured;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Ask the ArtFit agent</h2>
        {status && (aiOn
          ? <span className="badge fit">AI: {status.model} plans the tool calls</span>
          : <span className="badge unknown">AI not configured — tools run in a fixed order</span>)}
      </div>
      <p className="faint" style={{ marginTop: 6 }}>
        The agent decides which of four tools to call (search, inspect, placement search, alternatives) and picks an approved explanation.
        Every number comes from those deterministic tools. It cannot change your requirements.
      </p>
      <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3}
        style={{ width: "100%", font: "inherit", padding: 8, borderRadius: 8, border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)" }}
        placeholder="Describe your artwork, the clearance you want, the city and dates…" aria-label="Request to the agent" />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" disabled={running || !aiOn || !message.trim()} onClick={() => run(false)} title={aiOn ? "" : "Needs LLM credentials"}>
          {running ? "Agent working…" : "Run agent on this request"}
        </button>
        <button disabled={running || !brief.exhibitionStart} onClick={() => run(true)}>Run agent with the form below</button>
        {running && <button className="ghost" onClick={() => abort.current?.abort()}>Stop</button>}
      </div>
      {events.length > 0 && (
        <ol style={{ margin: "12px 0 0", paddingLeft: 18, display: "grid", gap: 6 }}>
          {start && <li className="faint">{start.mode === "llm" ? `Agent started (${start.model})` : start.note}</li>}
          {events.filter((e) => e.type === "brief_locked").map((e, i) => (
            <li key={"b" + i}>
              <strong>{e.source === "agent_parsed_request" ? "Agent read your request as" : "Your brief (locked)"}:</strong>{" "}
              <span className="mono">{e.brief.city} · {e.brief.exhibitionStart}→{e.brief.exhibitionEnd} · artwork {e.brief.artwork.widthM}×{e.brief.artwork.depthM}×{e.brief.artwork.heightM} m · clearance {e.brief.preferredClearanceM} m (min {e.brief.minimumClearanceM ?? "not set"}) · {e.brief.spaceUsePreferences.join("/") || "all uses"}</span>
            </li>
          ))}
          {events.filter((e) => e.type === "thinking").slice(-1).map((e, i) => <li key={"t" + i} className="faint">Agent reasoning (summary): {String(e.text).slice(0, 400)}</li>)}
          {events.filter((e) => e.type === "tool_call").map((c) => {
            const r = results.get(c.id);
            return (
              <li key={c.id}>
                <span className="badge info">{TOOL_LABEL[c.name] ?? c.name}</span>{" "}
                <span className="mono faint">{c.name}({c.input.spaceId ?? (c.input.failedSpaceId ? `${c.input.failedSpaceId} → ${c.input.otherSpaceIds?.length ?? 0} other` : "brief")}{c.input.requiredClearanceM != null ? `, ${c.input.requiredClearanceM} m` : ""})</span>
                <div className={r && !r.ok ? "warn" : "faint"} style={{ marginTop: 2 }}>{r ? `${summaryLine(c.name, r.summary)} · ${r.ms} ms` : <><span className="spinner" /> running…</>}</div>
              </li>
            );
          })}
          {events.filter((e) => e.type === "error").map((e, i) => <li key={"e" + i} className="warn">{e.message}</li>)}
        </ol>
      )}
      {final && (
        <div className="note" style={{ marginTop: 10 }}>
          <div>{final.narration.text}</div>
          <div className="faint" style={{ marginTop: 4 }}>
            {final.narration.source === "llm_selected_template" ? "Explanation: template chosen by the agent, validated against this run's tool results." : "Explanation: deterministic template."}
            {final.narration.note ? ` (${final.narration.note})` : ""}
            {final.usage ? ` · ${final.usage.turns} model turns · ${final.usage.inputTokens + final.usage.outputTokens} tokens` : ""}
          </div>
        </div>
      )}
    </div>
  );
}
