# Fly Desk Frontend Identity

## Direction

Fly Desk is an operational workspace for travel agents. The interface must feel premium, compact, fast to scan, and built for repeated searches, comparison, quotation, and follow-up tasks. Avoid marketing layouts, decorative gradients, and generic dashboard card grids.

The target style is Claude-like operational premium:

- Dense but legible controls.
- Warm neutral surfaces with Claude/Anthropic orange used sparingly for primary actions and selected states.
- Clear semantic color for success, warning, and blocking states.
- Quiet borders, minimal shadows, and strong alignment.
- Spanish product copy throughout.
- Avoid boxes inside boxes; prefer flat sections, dividers, and grouped rows.

## Tokens

Use semantic tokens in CSS and components. Do not hardcode ad hoc colors in component markup unless the color is mapped to an existing token.

Reference palette source: browser-console extraction from Claude in light and dark modes. Use the extracted neutral scale as the source of truth, not earlier approximations.

Extracted light colors:

- Core text: `#121212`, `#1f1f1e`, `#373734`
- Muted text: `#7b7974`
- Surfaces: `#f8f8f6`, `#efeeeb`, `#ffffff`
- Borders and soft states: `#1f1f1e26`, `#1f1f1e4d`, `#7b797426`, `#7b797466`
- Product accent surface: `#e9e8e3`
- Brand accent: `#d97757`
- Focus ring: `#d97757`

Extracted dark colors:

- Core text: `#f8f8f6`, `#e2e1da`, `#ffffff`
- Muted text: `#c3c2b7`, `#97958c`
- Surfaces: `#1f1f1e`, `#2c2c2a`, `#121212`, `#000000`
- Borders and soft states: `#e2e1da26`, `#e2e1da4d`, `#97958c26`, `#97958c66`
- Product accent surface: `#121212`
- Brand accent: `#d97757`
- Focus ring: `#d97757`

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `background` | `#f8f8f6` | `#1f1f1e` | App canvas |
| `foreground` | `#121212` | `#f8f8f6` | Main text |
| `card` / `surface` | `#ffffff` / `#f8f8f6` | `#1f1f1e` | Panels and controls |
| `popover` / `surface-raised` | `#ffffff` | `#2c2c2a` | Overlays |
| `secondary` | `#efeeeb` | `#2c2c2a` | Secondary controls |
| `muted` | `#efeeeb` | `#2c2c2a` | Subtle fills and skeletons |
| `muted-foreground` | `#7b7974` | `#97958c` | Secondary text |
| `border` / `input` | `#1f1f1e26` | `#e2e1da26` | Dividers and control edges |
| `primary` | `#d97757` | `#d97757` | Main action and selection |
| `primary-foreground` | `#ffffff` | `#ffffff` | Text on primary action |
| `accent` | `#e9e8e3` | `#121212` | Topbar, hover, selected, passive badges, and filled segmented surfaces |
| `success` | `#373734` | `#c3c2b7` | Ready, direct, complete |
| `warning` | `#d97757` | `#d97757` | Pending, one stop, attention |
| `destructive` / `danger` | `#d97757` | `#d97757` | Error or blocked state |
| `ring` / `focus` | `#d97757` | `#d97757` | Visible keyboard focus |

Selection and hover states must use `accent` or neutral translucent mixes unless the control is an intentional CTA. Do not reintroduce full orange fills for passive highlight, table row selection, badges, or hover surfaces.
Solid orange surfaces must use white foreground text/icons for contrast and legibility.

## Typography

- Font stack: `Inter`, `IBM Plex Sans`, system sans-serif.
- Mono stack: `IBM Plex Mono`, UI monospace, only for comparable data such as prices, codes, and counters.
- UI labels use 10-11px uppercase with normal letter spacing.
- Body copy uses 12-14px.
- Panel titles use 13-15px and must stay compact.
- Avoid viewport-scaled font sizes.

## Spacing And Shape

- Base spacing: 4px.
- Dense gaps: 4-8px.
- Panel gaps: 12-16px.
- Page gutters: 16px mobile, 20-24px desktop.
- Radius: 8px for compact controls, 10-12px for panels, avoid oversized rounded cards.
- Shadows should be subtle and used mainly for overlays.

## Component Families

- `topbar`: sticky product identity and theme controls only. Do not show counters, readiness badges, or section tabs unless the underlying React workflow is implemented.
- `search-shell`: one cohesive shell for trip type, origin, destination, dates, passenger selector, and search CTA.
- `field`: label + value with consistent height and focus treatment.
- `segmented`: trip type and sorting controls.
- `filter-panel`: compact filter groups with visible selected states and clear action.
- `result-row`: dense comparison row prioritizing airline, schedule, route, baggage, provider, and price.
- `detail-panel`: selected offer and quotation workflow, with flat data groups instead of inner cards.
- `provider-rail`: canonical provider names plus only backend-observed readiness; unknown must remain explicit and provider errors must never be reproduced verbatim.

Do not render placeholder sections for workflows that are not connected in the React app. Flexible search is connected through `stay-range` and `/api/matrix`; monthly migratory search is connected through client-side monthly `stay-range` fan-out for selected months. Each migratory month scans every day against Agil and Click and Book Plus without fare filters, while the client limits concurrent months to generous batches. Multi-city search, the dedicated calendar/matrix view, and visible `reprice` remain intentionally hidden.

The results grid is fixed by the redesign. Do not reintroduce a persisted layout editor or `/api/results-layout` without a new product decision and a real consumer.

## Interaction States

Every interactive control must define:

- Default
- Hover
- Focus-visible
- Active/selected
- Disabled
- Loading when async
- Empty/error when data-dependent

Keyboard focus must be visible, and visible controls must be reachable by tab unless intentionally hidden.

## Responsive Rules

- `>= 1280px`: three-column workspace is allowed: filters, results, detail.
- `1024px`: preserve the search shell and stack secondary panels if needed.
- `< 768px`: single-column layout; no horizontal overflow; action groups wrap instead of shrinking text below readability.
- Overlays must stay inside viewport and remain keyboard usable.

## Copy Rules

- Use Spanish labels and statuses.
- Replace technical states with clear localized product copy:
  - `IDLE` -> omit the status badge when it adds no operational value.
  - `running` -> the localized equivalent of "Searching"
  - `search_live` -> the localized equivalent of "Querying"
  - `partial` -> the localized equivalent of "Updating"
- Keep CTA labels direct and use localized equivalents of "Search," "Quote," "Copy," and "Clear."

## QA Gate

Before finishing frontend work, run:

- `bun run typecheck`
- `bun run lint`
- `bun run build`
- `bun run test`
- Playwright smoke against the built app at desktop `1440x900`, tablet `1024x768`, and mobile `390x844`.

The smoke must check:

- Page loads without console errors.
- No horizontal overflow.
- Topbar, search shell, filters, results, and detail panel remain coherent.
- Light and dark mode both render.
- Focus order reaches visible controls.
