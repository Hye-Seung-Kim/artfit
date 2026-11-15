import { useEffect, useState } from "react";
import type { ExhibitionBrief } from "@artfit/geometry";
import { api, nextRequestId, type SearchResult } from "./api";
import Brief, { EMPTY_BRIEF } from "./screens/Brief";
import Discover from "./screens/Discover";
import Workspace from "./screens/Workspace";

type Screen = "brief" | "discover" | "workspace";

export default function App() {
  const [screen, setScreen] = useState<Screen>("brief");
  const [brief, setBrief] = useState<ExhibitionBrief>(EMPTY_BRIEF);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [spaceIds, setSpaceIds] = useState<string[]>([]);
  const [health, setHealth] = useState<any>(null);
  // Re-check every 3 s until the API answers, so a server restart doesn't leave a stale error on screen.
  useEffect(() => {
    let stop = false, t: ReturnType<typeof setTimeout> | undefined;
    const check = () => api.health()
      .then((h) => { if (stop) return; setHealth(h); if (!h.ok) t = setTimeout(check, 3000); })
      .catch(() => { if (stop) return; setHealth({ ok: false, kitError: "API server not reachable" }); t = setTimeout(check, 3000); });
    void check();
    return () => { stop = true; clearTimeout(t); };
  }, []);

  useEffect(() => { window.scrollTo({ top: 0, behavior: "instant" }); }, [screen]);

  // What the search depends on; if it changes after a search, Discover says the results need a new search.
  const searchKey = (b: ExhibitionBrief) => JSON.stringify([b.city, b.exhibitionStart, b.exhibitionEnd, b.spaceUsePreferences, b.artwork, b.preferredClearanceM, b.minimumClearanceM, (b.works ?? []).map((w) => [w.widthM, w.depthM, w.heightM])]);
  const [searchedKey, setSearchedKey] = useState<string | null>(null);
  const search = () => {
    setBusy(true); setError(null);
    api.search(brief, nextRequestId())
      .then((r) => { setResult(r); setSearchedKey(searchKey(brief)); setScreen("discover"); })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="app">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="topbar">
        <button className="brand" onClick={() => setScreen("brief")} aria-label="ArtFit — exhibition brief"><img className="brand-symbol" src="/brand/artfit-symbol.svg" alt="" /><span className="brand-text"><img className="wordmark" src="/brand/artfit-wordmark.svg" alt="ArtFit" /></span></button>
        <nav className="steps" aria-label="Exhibition planning steps">
          <button className={screen === "brief" ? "on" : ""} aria-current={screen === "brief" ? "step" : undefined} onClick={() => setScreen("brief")}><span className="step-number">01</span>Brief</button>
          <button className={screen === "discover" ? "on" : ""} aria-current={screen === "discover" ? "step" : undefined} disabled={!result} onClick={() => setScreen("discover")}><span className="step-number">02</span>Discover</button>
          <button className={screen === "workspace" ? "on" : ""} aria-current={screen === "workspace" ? "step" : undefined} disabled={!spaceIds.length} onClick={() => setScreen("workspace")}><span className="step-number">03</span>Workspace</button>
        </nav>
        <div className="source-block">{health && !health.ok && <span className="source-error" role="alert">{health.kitError ?? "Source loading"}</span>}</div>
      </header>
      {screen === "brief" && <Brief brief={brief} setBrief={setBrief} onSearch={search} busy={busy} error={error} />}
      {screen === "discover" && result && <Discover result={result} brief={brief} briefChanged={searchedKey !== searchKey(brief)} onSearchAgain={search} searching={busy} onBack={() => setScreen("brief")} onOpen={(ids) => { setSpaceIds(ids); setScreen("workspace"); }} />}
      {screen === "workspace" && spaceIds.length > 0 && <Workspace key={spaceIds.join("|")} spaceIds={spaceIds} brief={brief} setBrief={setBrief} onBack={() => setScreen("discover")} />}
      {screen !== "workspace" && <footer className="site-footer"><span className="footer-mark"><img className="footer-symbol" src="/brand/artfit-symbol.svg" alt="" /><img className="footer-wordmark" src="/brand/artfit-wordmark.svg" alt="ArtFit" /></span><div className="footer-copy"><span>Art, in the right place.</span><span>CoStar data kit · November 2026 snapshot</span><span>Preliminary spatial planning. Conditions need verification.</span></div></footer>}
    </div>
  );
}
