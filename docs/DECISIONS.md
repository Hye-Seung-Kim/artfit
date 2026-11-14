# ArtFit — Decisions and Gate Outcomes

Last updated 2026-11-14. Everything below reflects what was actually checked, not what the spec allows.

## Data gate (spec §3)

**Outcome: Gate B for both candidates, with a proposed path to Gate A pending human review.**

| | Candidate A | Candidate B |
|---|---|---|
| Space ID | `20031202:18036295` | `37287981:19233219` |
| Address | 6003 Bellaire Blvd · Suite I, Houston (market 14) | 7001 Mullins Dr · Suite E, Houston (market 14) |
| Use / advertised area | Flex · 2,201 SF | Flex · 1,500 SF |
| Idle signal | moderate: 25.7 months on market, no suite-matched tenancy | strong: 14.8 months on market, last recorded tenant left Apr 2026, no current recorded tenant |
| Matterport model | `BoqDzrD8JLh`, named "6003 Bellaire Blvd - Suite I" | `yHo2cBkCvXy`, named "7001 Mullins Dr - Suite E" |
| Main region (Model API room) | `613htqkzf66zz7hf7n8kzszed`, about 1,975 SF | `613htqkzf66zz7hf7n8kzszed`, about 1,439 SF |
| Exact-match status | **proposed, not verified** | **proposed, not verified** |

How the candidates were chosen:
1. I took the strong and moderate long-idle pool and limited it to Retail, Flex, Industrial and OfficeRetail.
2. I fetched the names of all 1,205 Matterport models linked to those properties from the Model API.
3. I kept spaces whose model name states the same suite at the same address. Twenty matched across both markets.
4. I chose two Houston Flex spaces with open floors so that both candidates are in one research market.

The model name, the property in the CSV and the scanned area (close to the advertised area) are consistent with each other. Under spec §3.2 they remain *supporting clues*. A reviewer must confirm the region in the scan with `/annotate/:spaceId` → "Confirm match". Until that happens, V = 0 and placement verdicts show as "Spatial result unknown" with an exploratory calculation.

`matterportLinkLevel` stays `building`, which is the provider association. The app-level region mapping is stored separately in `server/data/evidence/*.json`.

## Matterport spike (spec §10.2.1)

| Check | Result |
|---|---|
| Model API (GraphQL, server key) | Works at `https://api.matterport.com/api/models/graph` with Basic auth. Introspection is enabled. Exposed: floors (wall vertices/edges/openings), rooms (boundary, ceiling min/max, dimensions), panoLocations (positions and skyboxes), floorplan images and OBJ meshes (`simple_planes`, `defurnished_50k`). `objectAnnotations` was empty for both models. |
| Showcase SDK on `http://localhost:5173` | Connects through `@matterport/sdk@1.6.2` `setupSdk(..., { domain: "my.matterport.com" })`. `Pointer.intersection` streams positions. |
| Keyed plain iframe | **Do not use.** A Showcase URL that carries `applicationKey` without an SDK connection stays black. Every keyed embed (Workspace scan view and annotation tool) goes through `web/src/viewer/useMatterport.ts` → `setupSdk`. If the SDK cannot connect, the view falls back to a key-less, view-only iframe. The UI shows the Showcase app phase (loading/playing/error). |
| Bundle SDK scene objects | **Works (Plan A).** `@matterport/webcomponent@0.1.47` is used with self-hosted bundle assets (`web/public/bundle`, copied by `postinstall`/`predev`, gitignored). `Scene.registerComponents` + `createObjects` place the artwork box, clearance buffer, conflict regions and a 1.7 m figure in the scan. These use the bundle's own three.js and Showcase coordinates. Each new pose updates the component inputs live, and the scan mesh occludes the objects. Checked 2026-11-14: Suite E, 4×3×2.4 m fits (green); 9×5 m is a conflict (red) without a reload. The package requires three 0.184, so three was upgraded and deduplicated in Vite (`.npmrc legacy-peer-deps`). |
| Coordinate transform | **Verified.** Every Showcase `Sweep.data` position equals the Model API pano position under API (x, y, z) → Showcase (x, z, −y). A: 13/13 sweeps; B: 14/14 sweeps. |
| Capture date | Not exposed. `processing.processingCompletedAt` (A: 2026-07-10, B: 2026-07-10) is processing time and is shown only with that label. `scanCapturedAt` stays null. |
| Model `created` | 2026-11-09/10. This is the tenant copy date, not the capture date. |

Floor height for scene objects is `annotation.floorElevationY`. It is 0 in the drafts, and visually the box sits on the scanned floor. A human trace in `/annotate` records the measured y.

## Annotation status

- `server/data/annotations/*.json` are **drafts built with Model API assistance** (`npm run draft-annotations -w server -- <spaceId> <modelId>`):
  - The floor is the main room boundary, with wall centerlines inset by half the wall thickness.
  - Doorways on that boundary become 1.2 m entrance zones. This is a design-review assumption.
  - `annotationVerified=false`, `obstacleCoverage=partial`, `scaleCheck=null`, `ceilingHeightM=null`.
- No furniture or columns are traced. Two panorama checks of each main room showed open floors with no visible movable furniture. That is a partial look, not a reviewed complete-coverage observation, so the furniture label stays "Scan furniture review pending".
- **Scale reference:** none is available yet. The CoStar floor-plan URI for Suite I returned Access Denied from the CDN, and Suite E has none. Without a dimensioned exact-region reference, geometry cannot reach "Verified"; the best possible state is "PotentialFit".
- **Local ceiling:** not measured. The Model API gives no ceiling for either main room. Use the annotation tool's "Local ceiling" tool, which takes a floor point and the lowest overhead obstruction.

## Policies

- **Evidence time policy:** no evidence is accepted for a future exhibition date. Reviewed dated observations show as `historical_only`. There is no invented freshness TTL.
- **Strict condition filters:** not built (spec §0.0). `validateBrief` forces them to false.
- **Hypothetical furniture removal:** not enabled (P3). The resolver and validation exist and are tested, and the UI shows only "As scanned".
- **Agent / AI use:** `POST /api/agent/run` (`server/src/agent/loop.ts`) runs Claude `claude-opus-5-5` in a manual tool-use loop over exactly the four tools. The tools are strict JSON schemas, the request uses adaptive thinking with effort medium, and it enables server-side refusal fallback. The run streams NDJSON events to the "Ask the ArtFit agent" panel.
  - **What the AI does:** turns the user's free-text request into a brief (shown back as "Agent read your request as"); decides which tools to call and in what order; picks the explanation template.
  - **Server guards:** the first brief is locked for the run, so a later search with a different artwork, clearance or market is rejected. `evaluate_placement` takes only `spaceId` + `requiredClearanceM`; the artwork comes from the locked brief, the scenario is the user's as-scanned one, and the clearance must be the preferred value or one returned by `plan_alternatives`. The final answer is structured output (template id + text). It must match an allowlisted template skeleton and this run's deterministic outcome, every placeholder must resolve, and bare digits and banned claims are rejected. Any failure falls back to the deterministic template, labeled as such.
  - **Without credentials** (`LLM_PROVIDER=anthropic` + `LLM_API_KEY`, or `ANTHROPIC_API_KEY`), the same tools run in a fixed order and the UI says "AI not configured".
- **Audit discrepancy:** at runtime the strong-signal pool is 888. The spec's planning paragraph says 887. Runtime records take precedence (spec §11.2). The difference most likely comes from suite normalization details.

## Performance

`scan` runs in about 18–380 ms under Node with tsx, for 27k–80k tested poses. The browser runs it in one Web Worker. On the demo machine, Suite E with 4×3 m and 2 orientations measured 131 ms on the first run and 27 ms once warm.

## Remaining human steps before the demo

1. Open `/annotate/20031202:18036295` and `/annotate/37287981:19233219`. Walk the scan and confirm or reject the exact suite region using a reviewer name.
2. Add any columns, fixtures, furniture or uncertain objects. Measure the local minimum clear height. Set coverage honestly.
3. If a dimensioned plan or a tape-measured reference becomes available, add a scale check. Then use "Verify & publish".
4. Optionally set `LLM_PROVIDER=anthropic` and `LLM_API_KEY` in `.env`.
