import { useEffect, useState } from "react";
import type { ExhibitionBrief } from "@artfit/geometry";
import { api, nextRequestId, type SearchResult } from "./api";
import Brief, { EMPTY_BRIEF } from "./screens/Brief";
import Discover from "./screens/Discover";
import Workspace from "./screens/Workspace";
import AgentPanel from "./agent/AgentPanel";

type Screen = "brief" | "discover" | "workspace";

export default function App() {
  const [screen, setScreen] = useState<Screen>("brief");
  const [brief, setBrief] = useState<ExhibitionBrief>(EMPTY_BRIEF);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [spaceIds, setSpaceIds] = useState<string[]>([]);
  const [health, setHealth] = useState<any>(null);
  const [agentDone, setAgentDone] = useState<any>(null);
  const onAgentResult = (r: any) => {
    setAgentDone(r);
    if (r.brief) setBrief(r.brief);
    if (r.search) setResult({ ...r.search, requestId: "agent" });
    const ids = [r.primarySpaceId, ...(r.otherSpaceIds ?? [])].filter(Boolean);
    if (ids.length) setSpaceIds(ids);
  };
  useEffect(() => { api.health().then(setHealth).catch(() => setHealth({ ok: false, kitError: "API server not reachable" })); }, []);

  useEffect(() => { window.scrollTo({ top: 0, behavior: "instant" }); }, [screen]);

  const search = () => {
    setBusy(true); setError(null);
    api.search(brief, nextRequestId())
      .then((r) => { setResult(r); setScreen("discover"); })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="app">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="topbar">
        <button className="brand" onClick={() => setScreen("brief")} aria-label="ArtFit — exhibition brief"><span className="wordmark">ArtFit.</span><span className="brand-caption">A place for your art.</span></button>
        <nav className="steps" aria-label="Exhibition planning steps">
          <button className={screen === "brief" ? "on" : ""} aria-current={screen === "brief" ? "step" : undefined} onClick={() => setScreen("brief")}><span className="step-number">01</span>Brief</button>
          <button className={screen === "discover" ? "on" : ""} aria-current={screen === "discover" ? "step" : undefined} disabled={!result} onClick={() => setScreen("discover")}><span className="step-number">02</span>Discover</button>
          <button className={screen === "workspace" ? "on" : ""} aria-current={screen === "workspace" ? "step" : undefined} disabled={!spaceIds.length} onClick={() => setScreen("workspace")}><span className="step-number">03</span>Workspace</button>
        </nav>
        <div className="source-block"><span className="source-dot" aria-hidden="true" /><span className="src-label"><strong>Real spaces. Considered placements.</strong>CoStar · November 2026 snapshot{health && !health.ok && <span className="source-error">{health.kitError ?? "Source loading"}</span>}</span></div>
      </header>
      {screen === "brief" && (
        <>
          <div className="page" style={{ maxWidth: 880, paddingBottom: 0 }}>
            <AgentPanel brief={brief} onResult={onAgentResult} />
            {agentDone && (
              <div className="row" style={{ marginBottom: 8 }}>
                {agentDone.search && <button onClick={() => setScreen("discover")}>See all leads the agent found</button>}
                {agentDone.primarySpaceId && <button className="primary" onClick={() => setScreen("workspace")}>Open the agent's spaces in the workspace</button>}
              </div>
            )}
          </div>
          <Brief brief={brief} setBrief={setBrief} onSearch={search} busy={busy} error={error} />
        </>
      )}
      {screen === "discover" && result && <Discover result={result} onBack={() => setScreen("brief")} onOpen={(ids) => { setSpaceIds(ids); setScreen("workspace"); }} />}
      {screen === "workspace" && spaceIds.length > 0 && <Workspace key={spaceIds.join("|")} spaceIds={spaceIds} brief={brief} setBrief={setBrief} onBack={() => setScreen("discover")} />}
      {screen !== "workspace" && <footer className="site-footer"><span className="footer-mark">ArtFit.</span><div className="footer-copy"><span>Art, in the right place.</span><span>CoStar data kit · November 2026 snapshot</span><span>Preliminary spatial planning. Conditions need verification.</span></div></footer>}
    </div>
  );
}
