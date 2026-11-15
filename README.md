# ArtFit

**Find a space that fits your art, not just your budget.** HackPrinceton Fall 2026 · Business & Enterprise · CoStar · Amazon Practical AI

ArtFit finds commercial spaces that are marketed for lease in a CoStar data-kit snapshot. It keeps three things separate: listing availability, physical vacancy, and furniture condition. It plans floor-standing artworks against geometry traced from Matterport scans, in solo or group-show mode. A visible exhibition agent compares candidate layouts and drafts venue questions; the Workspace supports constrained editing, route previews, and PDF/PNG plan export. Results retain their draft and unconfirmed-condition status.

> Current user journey: [Exhibition Planning User Flow](docs/USER_FLOW.md) — multi-work onboarding, CoStar candidate search, group Workspace, and implementation limits.

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
            validation), agent/ (group exhibition planning, separate single-work agent, allowlisted editing, report narration), data/annotations, data/evidence
web/        Vite + React. Brief / Discover / Workspace, R3F planning view (Plan B), Matterport embed,
            scan Web Worker, annotation tool (Showcase SDK Pointer.intersection)
docs/DECISIONS.md   gate outcomes, spike results, policies, remaining human steps
```

Routes: `POST /api/spaces/search` · `GET /api/spaces/:id` · `GET /api/spaces/:id/geometry` · `POST /api/placement/evaluate` · `POST /api/agent/plan`

AI in the app: Workspace artwork editing (`POST /api/workspace/edit`). Claude (`claude-opus-5-5`) turns the artist's request ("move it left 30 cm", "lift it 1 m", "matte white") into an allowlisted set of edit ops. ArtFit converts units, validates, applies and re-checks the placement in code; Claude cannot edit boundaries, obstacles or evidence. Undo, redo and reset are deterministic. Set `LLM_PROVIDER=anthropic` and `LLM_API_KEY` in `.env`; without them the edit bar says Claude is not connected and the manual controls still work.

Separate single-work search service: `POST /api/agent/run` lets Claude plan calls to the four search tools (`search_spaces`, `inspect_space`, `evaluate_placement`, `plan_alternatives`). All numbers, counts and verdicts come from deterministic code.

Visible exhibition agent: `POST /api/agent/show` streams its work in Discover using `search_spaces`, `inspect_space`, `plan_group_layout`, and `draft_inquiry`. It tests the whole exhibition with the shared group planner and passes selected poses to Workspace. Owner inquiries are drafts; PDF/PNG export is not hosted sharing, project persistence, or automatic email delivery. See [the source-reviewed user flow](docs/USER_FLOW.md) for exact handoffs and remaining limits.

## Data layers that affect decisions

- **CoStar kit:** identity, research market, listing status, availability date/label, advertised area, asking rate in original units, property structural context, and the long-idle signal (listing × tenancy match on property + floor + normalized suite).
- **Matterport:** the traced floor region, entrance zones and (once reviewed) obstacles, in Showcase SDK coordinates (x, z; meters). The Model API → Showcase transform was verified against sweep positions.
- **Reviewed evidence:** only what is recorded in `server/data/evidence/`. No vacancy, furnishing or cleared-state evidence has been obtained so far, and the UI says so.

## Placement method

A pose is valid when the artwork rectangle lies inside the floor polygon (concave floors handled) and has no interior overlap with an active obstacle. Clearance is the minimum distance to the floor boundary and to every blocker. Circle columns use an analytic distance. The search covers a 0.10 m grid at 0°/90° (optionally 0/45/90/135°). Decisions use raw values. Displayed values are rounded down to 0.05 m. "Best clearance among tested placements" never means maximum possible clearance.

Basis of the numbers: clearance is the user's viewing-room preference (presets 0.915 m and 1.525 m are the ADA 2010 §403.5 accessible-route widths of 36 in and 60 in). Group routes are drawn only through 0.915 m (36 in) of clear width. Visitor estimates use IBC Table 1004.5 load factors (exhibit gallery 30 sq ft net, standing 5 sq ft net), IBC §1005.3.2 egress width (0.2 in per occupant) and the 49-occupant two-exit threshold of IBC Table 1006.2.1, as planning estimates rather than a legal occupant load. People at each work at once (about 1 m² each) and the standing spot used for route checks are ArtFit assumptions. Suggested group layouts come from randomized greedy restarts and are not proven optimal.

## Current status (honest)

- Candidates A/B (Houston Flex: 6003 Bellaire Blvd Suite I, 7001 Mullins Dr Suite E) have **draft** geometry and a **proposed** exact-suite match. A human must review both in `/annotate`. Until then, V = 0 and verdicts are "Spatial result unknown" with a labeled exploratory calculation. See `docs/DECISIONS.md`.
- The Matterport scan view uses the Bundle SDK (`@matterport/webcomponent`, Scene API). The planned artwork, clearance buffer and conflict regions are placed inside the real scan and update live. The reconstructed R3F planning view stays available, side by side.
- Not built (per spec §0.0): strict verified-condition filters, hypothetical furniture removal, Vexcel.

## Limitations

ArtFit uses a November 2026 CoStar data-kit snapshot, not live inventory. A marketed lease listing does not establish physical vacancy, unfurnished condition, a cleared installation region or short-term exhibition permission. Physical-condition claims require their own scoped, dated evidence, and unknowns and conflicts remain visible. Geometry is manually traced from Matterport scans, with reviewed furniture and uncertain objects included by default. A user-selected furniture-removal scenario is conditional: it does not establish removal permission or completion, and it does not edit furniture baked into the original scan. Traced geometry and calibration can have measurement and coverage limitations, and circular columns omit unmodeled capitals or flares. Search samples a grid and fixed orientations, so "best clearance" means best among tested placements, and a search failure is not proof of impossibility. Floor fit is distinct from local height, load-in, structural capacity, lease, code, safety and accessibility review. Property-level maxima and nominal door comparisons are context, not exact-suite certification. Asking rents keep their original units and are not short-term quotes. The long-idle signal combines time on market with matched tenancy records. Time on market comes from a possibly estimated `dateOnMarket` and is measured to the snapshot date. The signal ranks leads and does not establish vacancy. ArtFit models floor-standing artworks in solo and group-show modes; hanging, window-mounted and rooftop installations are not modeled. A front photo or a .glb model changes only how the work looks; checks still use its outer box. Confirm actual conditions, use permission, dates and cost before committing to a space.

## From the artist interview

- **Scale:** a 1.7 m figure stands next to the work in both 3D views.
- **"My work in the space":** add a front photo, which is applied to the box face, or drop a .glb model of the work.
- **Height:** ceiling height was the interviewed artist's real failure point. The result panel shows a separate height check. Only a measured local ceiling can pass or fail it; the building's listed ceiling is drawn as context.
- **Checklist:** the first line is the actual short-term quote. It also asks about fixing on walls, ceiling or roof, light color and daylight, floor material and color, and other works sharing the space.

## Group show (planning several artists' works together)

The Workspace has a **Single work | Group show** switch. Group show plans one space with several artists' floor-standing works. The first version is meant for 2–3 artists and 3–5 works.

- **Works:** each has an artist, title, real size, viewing room, required/optional, and a lock that keeps its position in this space. Sizes are only changed by the user; planning and the AI never resize or drop a work.
- **Checks** (`geometry/src/group.ts`):
  - Bodies never overlap each other, the floor edge or blockers.
  - Viewing space can be shared, but no work may sit inside another work's viewing room.
  - Required works without a place are reported.
- **Route:** a walkable path on a 0.2 m grid, from the traced entrance to a standing spot at each work in the viewing order and back. It is a connectivity preview, not a crowding or safety check. With no traced entrance, no route is drawn.
- **Suggested layouts:** randomized greedy search per priority (most room, follows the viewing order, fewest changes). These are suggestions for the chosen conditions, not an optimum. Locked works stay put. "The same show elsewhere" checks the other candidate space.
- **Budget:** costs are split into quoted, estimated and unknown. Unknown costs are never counted as zero, currencies are not mixed, and the listing's asking rent is never treated as a short-term price. Moving works does not change cost.
- **AI** (`POST /api/workspace/group-edit`): allowlisted operations only (lock, unlock, set order, rearrange, move, rotate, set viewing room, select, undo, redo). There is no resize or remove operation. Each request is one undoable step.

## Plan report and contacts

- **Share plan** (Workspace) opens a report that can be saved as a PDF or downloaded as a PNG plan. It includes:
  - the layout drawn to scale, with the route, standing spots, doorways and a scale bar;
  - a 3D-plan picture and a Matterport scan picture;
  - an AI walk-through (`POST /api/report/narrate`) covering the route, crowd, atmosphere, each work and what to check, where any sentence with a number not in the layout facts is removed;
  - the works table, space facts and contacts.
- **Space info**: click a property name in Discover or the Workspace. It shows the listing broker, leasing company, manager and owner from the CoStar listing and property records, with mailto/tel links and an email prefilled with the agent's drafted inquiry. The hackathon kit anonymizes contact details.

## AI evaluation

`npm run eval -w server` sends 19 prompts to Claude through the same code paths the app uses and checks each answer: the demo script (★), multi-step requests, Korean, vague requests (must ask), and requests the AI must refuse (resize or drop a work, edit walls or columns, vacancy claims, prompt injection). `-- --only demo --repeat 3` checks consistency. It needs `LLM_*` and `COSTAR_KIT_DIR` in `.env` and exits non-zero on any failure.

## What's next

1. Collect and show short-term pricing from owners for the exhibition dates.
2. Installations beyond floor-standing: hanging from ceilings or windows, and rooftop placement.

## Deploy (Render)

`render.yaml` is a Render blueprint: one always-on Node service. Express serves the API and the built web app from one origin.

- **Data:** the service reads `server/kit-snapshot/`, a 12 MB extract of the CoStar kit built by `npm run snapshot -w server`. It holds only active lease listings, the properties and tenancy dates they reference, and the fields ArtFit uses. Listing contacts and brokerage are kept (anonymized placeholders in the hackathon kit); tenant names are left out. Re-run the script if the kit changes.
- **Public mode** (`ARTFIT_PUBLIC=1`): scan annotation, match review and kit reload return 403. AI routes are limited to `AI_RATE_LIMIT` (default 60) requests per visitor per hour.
- **Secrets** are set in the Render dashboard: `LLM_API_KEY`, `VITE_MATTERPORT_SDK_KEY` (read at build time). Add the production domain to the Matterport SDK key's allowed domains.
- **Domain (GoDaddy):** add `artfitspace.us` and `www.artfitspace.us` in Render → Settings → Custom Domains. At GoDaddy, set the `@` A record to the IP Render shows (currently `216.24.57.1`) and the `www` CNAME to `<service>.onrender.com`.
