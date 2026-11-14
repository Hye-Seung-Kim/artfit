# ArtFit — Museum Editorial Design System

Direction: a contemporary exhibition catalogue that opens into a practical spatial-planning studio. The supplied “MoMA Modern Institutional” reference informs the typography, contrast, spacing and restraint. ArtFit retains its own name, copy and artwork; no MoMA logo, proprietary font or artwork is reproduced.

## Foundation

| Token | Value | Use |
|---|---|---|
| Paper / surface | `#FFFFFF` | Page, forms, editorial content |
| Ink | `#090A09` | Wordmark, headings, text, primary buttons |
| Aqua | `#6BDCC5` | Primary-button text and artwork-clearance study |
| Quiet surface | `#F3F4F2` | Conceptual drawing, selected options, secondary information |
| Secondary text | `#50544F` | Descriptions and evidence summaries |
| Supporting text | `#686D67` | Metadata, captions, helper text |
| Rule | `#DCE0DA` | Structural separators and field groups |
| Strong rule | `#111111` | Section beginnings and active navigation |
| Fit / conflict | `#23644E` / `#B42318` | Actual geometric results only; always paired with text |

Keep a white museum-paper theme regardless of OS appearance. The header and browser theme color agree. Unknown evidence uses a neutral treatment rather than an alarm-colored pill; a layout conflict has its own red result.

## Typography

Use the system stack `Helvetica Neue, Helvetica, Arial, sans-serif`. “MoMA Sans” in the reference is not bundled or licensed for this app. Remove the previous external Inter/Fraunces request and mixed serif identity. No new font download is required.

| Role | Size / line-height | Weight and tracking |
|---|---|---|
| Wordmark | 43 px / 1 desktop; 36 px small screens | Heavy, −0.075 em |
| Display heading | Fluid 48–80 px / 0.99 | Heavy, −0.055 em |
| Discovery display | Fluid 48–68 px | Same display voice |
| Section heading | 30 px / 1.1 | Bold, −0.035 em |
| Workspace title | 29 px / 1.2 | Bold, −0.035 em |
| Introduction | 18 px / 1.5 | Regular |
| Body and form inputs | 16 px / 1.5 | Regular |
| Supporting copy | 12–14 px / 1.6 | Regular; adequate contrast |
| Figure captions / step numbers | 10–12 px | Utility only; never primary instructions |

Write sentence-case labels. Use scale and weight for hierarchy rather than uppercase badges, decorative serifs or widely tracked headings. Use tabular numbers for funnel statistics. Preserve selectable source/evidence text.

## Layout and spacing

- Content width: 1440 px including gutters, with fluid 20–64 px side gutters.
- Rhythm: 8 / 12 / 16 / 20 / 24 / 28 / 32 / 48 / 64 px. Large space belongs between sections, not inside repeated floating cards.
- Brief: two-column introduction with an original SVG artwork study; numbered sections pair concise context with full-width fields. A continuous form replaces the single rounded container.
- Discover: one continuous ruled funnel, followed by two-column catalogue entries. Featured previews use actual prepared annotation geometry, never a fabricated property photo or invented floor plan.
- Workspace: artwork controls / large planning view / result and evidence. At tablet sizes, the result panels flow below; on narrow screens the planning view comes first.
- Annotation tool: source scan and clearly separated editing sections in the same visual language. Editing, publication and evidence behavior stay intact.
- Avoid shadows, ornamental gradients, glass panels and floating containers. A rule, a clear heading or whitespace establishes a section.

## Components

- Primary action: black fill, aqua text, 48 px minimum height, 4 px corner radius; one clear main action per context. A small arrow signals moving to the next step.
- Secondary action: white surface and neutral rule. Text actions use an underline or directional label.
- Navigation: plain bold text, small step number and black underline for the current step. Future steps stay disabled until actual state makes them available.
- Inputs: 48 px height, 16 px text, 3 px radius, visible label. Unit suffixes are supplementary; the label and surrounding copy state measurement units.
- Multi-select uses: flat rectangular labels with keyboard-accessible checkboxes, a black selected rule and a plus/minus cue. Do not style core controls as pills.
- Catalogue entries: large property name, actual area/date facts, visible occupancy/furniture/match status, and an expandable evidence definition list. Load more records explicitly instead of silently cutting the list at 120.
- Result: text and icon with a strong colored baseline. Keep the floor verdict separate from height/access and physical-condition evidence.
- Supporting badges: small, nearly square, low contrast. Do not make every missing value a warning panel.
- Artwork study: original vector illustration driven by artwork dimensions. Label it “not to scale”; it is not listing media and is never used for a fit verdict.

## Interaction and accessibility

- Use semantic buttons for candidate selection, `aria-pressed` for toggles, `aria-current` for the active step, associated input labels, a main landmark and a skip link.
- Visible keyboard focus uses a 2 px black outline with a 4 px offset. Checkbox-label focus remains visible even when the checkbox is visually hidden.
- Buttons provide small press feedback, with 140 ms transitions; there is no automatic hero motion, counter animation or staged delay before controls become usable.
- Hover styling is restricted to `(hover: hover) and (pointer: fine)`. Reduced-motion preference removes press movement and spinner rotation.
- Use `100dvh` for studio regions and adaptive layouts for small screens. Keep zoom enabled; coarse-pointer form controls remain at least 16 px. Honor viewport safe-area insets.
- Mobile browser viewport checks verify layout, not physical-phone behavior. iOS keyboard, safe-area and tap behavior still need device testing.

## Product truth must survive the redesign

“Marketed in snapshot,” actual physical occupancy, furniture observation, cleared-region condition, model match and geometric fit remain independent. Unknowns remain readable. Do not replace them with an unlabeled green “ready” state.

Keep existing search, deterministic placement, original scan, four-tool agent alternatives and evidence/checklist actions. Do not enable unavailable strict verification filters or furniture-removal scenarios as part of a visual redesign. Source annotations and prepared data are not modified by these screen changes.

## Before / After design decisions

| Before | After | Why |
|---|---|---|
| Warm beige canvas and serif headings | White paper, black grotesque headings | A coherent contemporary museum identity |
| All content enclosed in rounded cards | Numbered sections and continuous rules | A deliberate exhibition-planning document |
| Repeated colored warning pills | Neutral evidence rows and scoped result colors | Keep meaningful results legible without visual noise |
| Dense property records with identical weight | Catalogue name, facts, evidence disclosure | Let artists scan spaces before reading research details |
| Narrow small form controls | Full-width labeled inputs and aligned units | Better readability and easier interaction |
| Tiny three-column workspace at every size | Large central stage and responsive panels | Keep the artwork and placement study central |
| Click-only candidate containers | Keyboard-accessible selection buttons | Equal operation by keyboard and pointer |

Implementation: shared tokens and component styles in `web/src/styles.css`; screen composition in `web/src/screens/`; drawing in `web/src/components/ArtworkStudy.tsx`.
