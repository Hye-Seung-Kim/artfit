# ArtFit

**Find a space that fits your art, not just your budget.** HackPrinceton Fall 2026 · Business & Enterprise · CoStar · Amazon Practical AI

ArtFit finds commercial spaces that are marketed for lease in a CoStar data-kit snapshot. It keeps three things separate: listing availability, physical vacancy, and furniture condition. It checks one floor-standing artwork and its walk-around clearance against geometry traced from Matterport scans. It also precomputes alternatives and produces a checklist of what still has to be verified.

## Run

```bash
cp /path/to/artfit.env .env          # never commit; see .env.example for names
npm install                          # also copies Matterport bundle assets to web/public/bundle
npm test                             # geometry + server checks (synthetic data)
npm run dev                          # API :8787 + web :5173
```

- App: <http://localhost:5173>. Screens: Brief → Discover → Workspace.
- Internal tracing/review tool: `http://localhost:5173/annotate/<spaceId>`.
- Draft geometry from the Matterport Model API (server key only): `npm run draft-annotations -w server -- <spaceId> <modelId> [--force]`.
- Kit audit: `npm run audit -w server`.

Requires `COSTAR_KIT_DIR` to point at the local `costar-hackathon-kit/`. Kit contents are never committed.

## Architecture

```
geometry/   pure TS: polygon ops, analytic circle distance, sampled scan, evaluate, scenario resolver,
            clearance proposal (vitest, shared by server and browser worker)
server/     Express. adapters/costarKit.ts (streamed JSONL + CSV, enum decoding, joins, idle signal),
            evidence/ (scoped ledger → condition labels), scenarios/ (authoritative annotation + scenario
            validation), agent/ (exactly 4 tools + bound-template narration), data/annotations, data/evidence
web/        Vite + React. Brief / Discover / Workspace, R3F planning view (Plan B), Matterport embed,
            scan Web Worker, annotation tool (Showcase SDK Pointer.intersection)
docs/DECISIONS.md   gate outcomes, spike results, policies, remaining human steps
```

Routes: `POST /api/spaces/search` · `GET /api/spaces/:id` · `GET /api/spaces/:id/geometry` · `POST /api/placement/evaluate` · `POST /api/agent/plan`

Agent: `POST /api/agent/run`. Claude (`claude-opus-5-5`, tool use) reads the artist's free-text request, plans calls to the four tools and streams each step to the UI. Set `LLM_PROVIDER=anthropic` and `LLM_API_KEY` in `.env`; without them the tools run in a fixed order, labeled as such. Agent tools: `search_spaces`, `inspect_space`, `evaluate_placement`, `plan_alternatives`. All numbers, counts and verdicts come from deterministic code. If an LLM is configured, it may only *select* an approved template. Each selection must pass four checks: placeholders resolve, the recommendation matches, there are no bare digits, and no banned claims appear. If a check fails, ArtFit falls back to a deterministic template.

## Data layers that affect decisions

- **CoStar kit:** identity, research market, listing status, availability date/label, advertised area, asking rate in original units, property structural context, and the long-idle signal (listing × tenancy match on property + floor + normalized suite).
- **Matterport:** the traced floor region, entrance zones and (once reviewed) obstacles, in Showcase SDK coordinates (x, z; meters). The Model API → Showcase transform was verified against sweep positions.
- **Reviewed evidence:** only what is recorded in `server/data/evidence/`. No vacancy, furnishing or cleared-state evidence has been obtained so far, and the UI says so.

## Placement method

A pose is valid when the artwork rectangle lies inside the floor polygon (concave floors handled) and has no interior overlap with an active obstacle. Clearance is the minimum distance to the floor boundary and to every blocker. Circle columns use an analytic distance. The search covers a 0.10 m grid at 0°/90° (optionally 0/45/90/135°). Decisions use raw values. Displayed values are rounded down to 0.05 m. "Best clearance among tested placements" never means maximum possible clearance.

## Current status (honest)

- Candidates A/B (Houston Flex: 6003 Bellaire Blvd Suite I, 7001 Mullins Dr Suite E) have **draft** geometry and a **proposed** exact-suite match. A human must review both in `/annotate`. Until then, V = 0 and verdicts are "Spatial result unknown" with a labeled exploratory calculation. See `docs/DECISIONS.md`.
- The Matterport scan view uses the Bundle SDK (`@matterport/webcomponent`, Scene API). The planned artwork, clearance buffer and conflict regions are placed inside the real scan and update live. The reconstructed R3F planning view stays available, side by side.
- Not built (per spec §0.0): strict verified-condition filters, hypothetical furniture removal, Vexcel.

## Limitations

ArtFit uses a November 2026 CoStar data-kit snapshot, not live inventory. A marketed lease listing does not establish physical vacancy, unfurnished condition, a cleared installation region or short-term exhibition permission. Physical-condition claims require their own scoped, dated evidence, and unknowns and conflicts remain visible. Geometry is manually traced from Matterport scans, with reviewed furniture and uncertain objects included by default. A user-selected furniture-removal scenario is conditional: it does not establish removal permission or completion, and it does not edit furniture baked into the original scan. Traced geometry and calibration can have measurement and coverage limitations, and circular columns omit unmodeled capitals or flares. Search samples a grid and fixed orientations, so "best clearance" means best among tested placements, and a search failure is not proof of impossibility. Floor fit is distinct from local height, load-in, structural capacity, lease, code, safety and accessibility review. Property-level maxima and nominal door comparisons are context, not exact-suite certification. Asking rents keep their original units and are not short-term quotes. The long-idle signal combines time on market with matched tenancy records. Time on market comes from a possibly estimated `dateOnMarket` and is measured to the snapshot date. The signal ranks leads and does not establish vacancy. Confirm actual conditions, use permission, dates and cost before committing to a space.
