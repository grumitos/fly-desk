# Fly Desk Frontend Identity

## Direction

Fly Desk is an operational workspace for travel agents. The interface must feel premium, compact, fast to scan, and built for repeated searches, comparison, quotation, and follow-up tasks. Avoid marketing layouts, decorative gradients, and generic dashboard card grids.

The target style is Claude-like operational premium:

- Dense but legible controls.
- Warm neutral surfaces with restrained clay/orange primary actions.
- Clear semantic color for success, warning, and blocking states.
- Quiet borders, minimal shadows, and strong alignment.
- Spanish product copy throughout.
- Avoid boxes inside boxes; prefer flat sections, dividers, and grouped rows.

## Tokens

Use semantic tokens in CSS and components. Do not hardcode ad hoc colors in component markup unless the color is mapped to an existing token.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `background` | `#faf8f5` | `#191714` | App canvas |
| `foreground` | `#2d2a26` | `#f4efe7` | Main text |
| `card` / `surface` | `#ffffff` | `#211f1b` | Panels and controls |
| `popover` / `surface-raised` | `#ffffff` | `#27231e` | Overlays |
| `secondary` | `#f3eee7` | `#2b2823` | Secondary controls |
| `muted` | `#eee8df` | `#312d27` | Subtle fills and skeletons |
| `muted-foreground` | `#7a7067` | `#a79c90` | Secondary text |
| `border` / `input` | `#e3dbd0` | `#403a33` | Dividers and control edges |
| `primary` | `#c15f3c` | `#d97757` | Main action and selection |
| `success` | `#3f7d63` | `#7bb89a` | Ready, direct, complete |
| `warning` | `#b8792f` | `#dda45c` | Pending, one stop, attention |
| `destructive` / `danger` | `#b4533f` | `#df6a58` | Error or blocked state |
| `ring` / `focus` | `#c15f3c` | `#d97757` | Visible keyboard focus |

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

- `topbar`: sticky operational status, product identity, section tabs, theme, counters.
- `search-rail`: one cohesive shell for mode, trip, origin, destination, dates, passenger selector, and search CTA.
- `field`: label + value with consistent height and focus treatment.
- `segmented`: mode, trip type, sorting, and view controls.
- `filter-panel`: compact filter groups with visible selected states and clear action.
- `result-row`: dense comparison row prioritizing airline, schedule, route, baggage, provider, and price.
- `detail-panel`: selected offer and quotation workflow, with flat data groups instead of inner cards.
- `placeholder-panel`: product-ready empty states for future sections such as migratorio or calendar, using rows/dividers instead of card grids.

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
- `1024px`: preserve the search rail and stack secondary panels if needed.
- `< 768px`: single-column layout; no horizontal overflow; action groups wrap instead of shrinking text below readability.
- Overlays must stay inside viewport and remain keyboard usable.

## Copy Rules

- Use Spanish labels and statuses.
- Replace technical states with product copy:
  - `IDLE` -> `Listo`
  - `running` -> `En busqueda`
  - `search_live` -> `Consultando`
  - `partial` -> `Actualizando`
- Keep CTA labels direct: `Buscar`, `Cotizar`, `Copiar`, `Limpiar`.

## QA Gate

Before finishing frontend work, run:

- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm test`
- Playwright smoke against the built app at desktop `1440x900`, tablet `1024x768`, and mobile `390x844`.

The smoke must check:

- Page loads without console errors.
- No horizontal overflow.
- Topbar, search rail, filters, results, detail panel, and future-section placeholders remain coherent.
- Light and dark mode both render.
- Focus order reaches visible controls.
