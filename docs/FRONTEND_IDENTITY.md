# Fly Desk Frontend Identity

What the frontend looks like and the rules it keeps. The values live in the
stylesheets and this document names them: colour tokens in
`frontend/src/index.css`, every other catalogue in
`frontend/src/design-system.css`. A value outside those catalogues is a bug.
Where the code departs from the external design manual, the rule and its
reason are in [`REDESIGN_CONTRACT.md`](./REDESIGN_CONTRACT.md).

## Direction

Fly Desk is an operational workspace for travel agents. The interface must feel premium, compact, fast to scan, and built for repeated searches, comparison, quotation, and follow-up tasks. Avoid marketing layouts, decorative gradients, and generic dashboard card grids.

- Dense but legible controls.
- Warm neutral surfaces, with one orange accent used sparingly.
- Quiet borders, minimal shadows, and strong alignment.
- Spanish product copy throughout.
- No boxes inside boxes: flat sections, dividers, and grouped rows. A list of fares on a desk is a table, not a stack of cards.

## Colour

Components use tokens, never raw colours. The light values are the `@theme`
block of `index.css`; `.dark` redefines the ones that change. The neutral scale
comes from Claude's light and dark palettes.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `background` | `#f8f8f6` | `#1f1f1e` | App canvas |
| `foreground` | `#121212` | `#f8f8f6` | Main text |
| `card` | `#ffffff` | `#1f1f1e` | The ground of fields, chips, keys, checkboxes, month cards and the phone's result card |
| `popover` / `popover-foreground` | `#ffffff` / `#121212` | `#2c2c2a` / `#f8f8f6` | Popovers and every sheet |
| `secondary` / `secondary-foreground` | `#efeeeb` / `#373734` | `#2c2c2a` / `#e2e1da` | Secondary buttons, segmented tracks, status pills, steppers, the field clears |
| `muted` | `#efeeeb` | `#2c2c2a` | Skeleton blocks |
| `muted-foreground` | `#6e6c67` | `#97958c` | Secondary text and labels |
| `accent` | `#e9e8e3` | `#121212` | The top bar's ground |
| `primary` / `primary-foreground` | `#d97757` / `#ffffff` | same | The primary action, checked controls, the selection edge |
| `primary-hover` | `#c36b4e` | same | A primary button under the pointer |
| `primary-badge` | `#ffffff33` | same | A count on a primary fill |
| `warning` / `destructive` (+ `-foreground`) | `#d97757` / `#ffffff` | same | The accent in its warning and error roles: an invalid field's edge and message, the stop button under the pointer, a warning glyph |
| `warning-soft` / `warning-soft-foreground` | `#d977571a` / `#6f321f` | `#d9775726` / `#f2c3b3` | The notice line's ground and text, and the capacity meter's while a search waits |
| `warning-border` / `destructive-border` | `#d9775761` / `#d9775780` | same | The notice's edge for a warning (and the waiting capacity meter's), and the heavier one for an error |
| `border` / `input` | `#1f1f1e26` | `#e2e1da26` | Dividers and control edges |
| `rule` | `#1f1f1e40` | `#e2e1da40` | The heavier line under the column headings |
| `focus` | `#d977578c` | same | The keyboard focus ring |
| `glow` | `#d977572e` | same | The glow around a focused or open field |
| `ring` | `#d97757` | same | Declared with the palette; no component reads it |
| `hover` | `#12121212` | `#f8f8f612` | Laid over a control's own fill under the pointer |
| `pressed` | `#0000001f` | same | Laid over a pressed button |
| `selected` | `#d9775714` | same | The selected row's and chip's wash |
| `border-hover` / `border-active` | `#b7674d7d` / `#c56d519d` | `#db8a6f7d` / `#da82659d` | An edge under the pointer, and the edge of a focused field or a chosen card or chip |
| `placeholder` | `#6e6c67b3` | `#97958cb3` | Placeholders and quiet glyphs |
| `faint` | `#6e6c6773` | `#97958c73` | Past days, missing baggage, disabled steps |
| `surface-sunken` | `#efeeeb99` | `#2c2c2a99` | Recessed bands inside a surface |
| `range` / `range-foreground` | `#d977571f` / `#ad6148` | same / `#e0937a` | A confirmed range of days or months |
| `scrim` | `#1f1f1e59` | same | The veil behind a sheet |

A state colour is written out per theme rather than mixed at build time,
because the build cannot keep a derived colour theme-aware.

- **One accent.** The orange marks the primary action, a checked control, the
  selection, a range of dates, and warnings and errors. Neutrals carry
  everything else, including a direct flight or a provider that answered:
  there is no green.
- **A warning and an error share the hue.** They differ in the notice's edge
  (`warning-border` against `destructive-border`) and in how they are
  announced: a warning politely, an error at once.
- **Solid orange carries white.** Text and icons on `primary` use
  `primary-foreground`.
- **Selection is a wash and an edge, never a fill.** A selected desk row wears
  `selected` and a 2px primary edge at its left; a selected phone card wears
  the `border-active` border. Full orange fills are for actions and chosen
  values — the primary button, a checked control, the ends of a chosen range,
  «Filtros» while filters are on, the cheapest month's bar — and never for a
  passive highlight or a hover.
- **Hover is laid over, never instead.** `hover` sits over a control's own
  fill (`--fd-hover-layer`), so it reads on any surface in both themes, and it
  exists only under `(hover: hover)`.

## Typography

- One family: `Inter`, the variable face (100–900), self-hosted in its Latin
  and Latin Extended subsets, the Latin one preloaded. Its fallback, `Inter
  Fallback`, is Arial sized to Inter's metrics so the swap barely moves text.
  No monospace face ships; only the hidden diagnostic log (Ctrl+Shift+L) sets
  its raw lines in the system's.
- Figures are Inter with tabular figures wherever they line up or change in
  place: prices, times, dates, durations, calendar days and counters. A date
  and a duration are figures. Station codes are Inter too.
- One job per size: 22 display (the migratory hero price), 17 sheet (sheet
  titles, the detail price), 16 card (card titles, the list price, phone
  inputs), 15 action (primary actions, station codes), 14 body (form values,
  names, long copy), 13 base (buttons, chips, rows), 12 meta (metadata,
  subtitles, counters), 11 figure meta (schedules, durations, specs), 11 label, 10 micro
  (secondary figures and footnotes).
- Three weights: 400 for values, 600 for labels, 700 for titles and figures.
- Labels are sentence case, normal tracking, muted, 11/600 (`.fd-type-micro`):
  field labels, column heads, pills and badges share them.
- No viewport-scaled font sizes.

## Geometry

- Control heights on a desk: 26 chip, 32 standard, 36 bar, 52 primary field
  and button. On a phone the catalogue is 34 / 40 / 46.
- Target size: no pointer target is smaller than 24px (WCAG 2.2, 2.5.8). A
  control drawn smaller keeps its drawing and takes `--fd-target-min` as its
  hit area; the 20px clears of the fields, «Borrar las fechas» and the quote
  notice's dismiss do so on a desk and a tablet. On a phone those controls are
  40px.
- Radii: 4 checkboxes and skeleton blocks, 6 badges and keys, 8 chips and
  calendar cells, 10 the 32 and 36px controls, 12 inputs, cards and panels,
  14 window frames and sheets.
- Icons take their size from the control they sit in: 18 in touch controls, 16
  in desk controls, 14 in dense rows, 12 in keys and badges. `AppIconSize` is
  that union, so `bun run typecheck` refuses any other size.
- One stacking ladder: 10 raised (sticky heads), 80 sheets, 120 modals, 130
  popovers (above the sheets and modals that open them), 140 tooltips.
- Shadows are for popovers and sheets, the key caps of shortcuts, and the
  phone's result card; the dark theme redefines them in black.
- The desk workspace has 16px gutters and 10px between its columns; a phone at
  rest has 14px sides and uses the whole width once a search exists.

## Surfaces and Components

- `topbar`: the product mark, the capacity meter, the copy and paste capsule and the theme switch.
  While a search exists on a desk it also holds the mode and trip segments. On
  a phone it is drawn at rest only; once a search exists its copy action moves
  to the right end of the filter row.
- `search-shell`: one cohesive shell for trip type, origin, destination, dates, passengers, and the search action. The policy line — the search window, the stay and passenger ceilings — sits at the foot of the idle screen.
- `field`: the 52px field, label and value, with one height and one focus treatment.
- `segmented`: the search mode, the trip type and the filter groups.
- Filters: a 248px column on a desk and tablet, a sheet on a phone, with visible selected states and «Limpiar».
- The result row: a table row on a desk — the carrier's mark, «who flies», the legs, baggage, price and provider — under a column header whose four sortable columns (Horario, Duración, Escalas, Precio) are the order control. Below 787px of list the row becomes the stacked phone card.
- The detail: the selected offer and its quotation, in flat data groups under a hero and an action bar; the third column of a wide desk, a side sheet on a narrower desk or tablet, a bottom sheet on a phone. With nothing selected it says so in one quiet line, `<p class="fd-detail-empty">` «Selecciona una oferta para ver su detalle.»
- The capacity meter: the capacity the two agents share, left of the capsules, read like the rest of the title bar: a gauge glyph and a tabular «3/7», the cupos the searches in progress hold out of the most that can run, in a cell of the capsules' height and radius (on a phone, the loose buttons' bordered box). It is `muted-foreground` while nothing runs and `foreground` while a search runs; while a search waits for a cupo it takes the clock glyph and the «En espera» line's colours (`warning-soft`, `warning-soft-foreground`, `warning-border`). It is a `meter` named «Capacidad de búsqueda» whose value says the cupos and the searches in words («4 de 7 cupos en uso · 2 búsquedas en curso · 1 en espera»), which its tooltip repeats. It never says which search holds how many cupos. It is blank, its box kept, while the capacity cannot be read.
- The provider rail: «Buscando en» and the providers this deployment searches, at the foot of the idle screen, with no health state. A provider that fails a search is reported in the notice line, never with its own words.
- The notice line: one line, dismissible, above the results (see Copy).
- Primitives: `.fd-btn` (primary, secondary and ghost; chip, small, medium, extra-large and icon sizes), `.fd-segmented`, `.fd-popover`, `.fd-checkbox`, `.fd-switch`, `.fd-tooltip`, `.fd-key`, and the `Sheet` component in bottom, side and modal placements.

Do not render placeholder sections for workflows that are not connected in the React app. Flexible search is connected through `stay-range` and `/api/matrix`; monthly migratory search is connected through client-side monthly `stay-range` fan-out for selected months. Each migratory month scans every day against Agil and Click and Book Plus without fare filters; the client asks for the months in calendar order and the runner searches one at a time. Multi-city search, the dedicated calendar/matrix view, and visible `reprice` stay hidden.

The results grid is fixed; there is no layout editor, and adding one needs a product decision and a real consumer.

## Interaction States

Every interactive control defines:

- Default.
- Hover: `hover` laid over the fill, under `(hover: hover)` only.
- Focus-visible: a 2px `focus` ring outside the border, so nothing reflows.
- Pressed: `pressed` laid over the fill.
- Active/selected.
- Disabled: one rule for every control, opacity 0.45 and a not-allowed cursor.
- Busy, when it waits for something: the button keeps its word and turns its
  icon into a spinner, as «Reintentar» does; «Cotizar» stays «Cotizar» while it
  confirms the fare. A longer word would not fit the column.
- Empty and error, when it depends on data.

Keyboard focus must be visible, and visible controls must be reachable by tab unless intentionally hidden.

## Motion

- Entering is opacity plus 6–8px along the axis it comes from; leaving is
  opacity alone, in about half the time. Durations and curves are tokens
  (`--fd-dur-*`, `--fd-ease-*`), and the cues of the idle-to-active
  choreography (`--fd-cue-*`) are read by the stylesheets and by the FLIPs in
  `lib/search-choreography.ts` alike.
- Every staggered entrance reads its position from one variable, `--i`: the
  filter chips, the migratory months and the skeleton rows set it inline, the
  first rows of the list take it from their position, and each reader uses
  `var(--i, 0)`.
- Reduced motion is one list, at the end of `design-system.css`: every
  movement duration and cue drops to 0ms, entrances become a 90ms fade, and
  the loops stop — the spinner, the skeleton blocks and rows, and the calendar
  sweep. That is why a partial search also says «Parcial» in words.
  JavaScript reads the same tokens (`lib/reduced-motion.ts`), so the FLIPs stop
  with them.
- A theme change never animates.

## Responsive Rules

The shell has three layouts, decided by `useShellSize`:

- **A**, 1100px and wider: the form in one row, filters and results in
  columns. The detail becomes a third column only while the list beside it
  keeps 824px, which a shell reaches at 1440px; below that it is a side sheet.
- **B**, 720 to 1099px: the form on two rows, filters and results in columns,
  the detail in a side sheet.
- **C**, below 720px or on a handheld device in either orientation: the phone
  layout, with filters, calendar, suggestions, passengers, month picker and
  offer as bottom sheets.

On every layout: no horizontal overflow; action groups wrap instead of shrinking text below readability; overlays stay inside the viewport and remain keyboard usable.

## Copy Rules

- Spanish labels and statuses, sentence case.
- Search states in words: «Buscando vuelos» is announced while a search runs,
  «Parcial» shows while a list is still growing, «N buscando» while a sweep has months out,
  «Actualizando» on a month still loading, «Detenida» after a stop, «En espera»
  while a search waits for capacity. An idle
  desk shows no status.
- The notice line names a provider in its display name and never quotes it:
  «Resultados incompletos · Agilsmart respondió en parte» for a provider that
  answered part of a search, «Resultados incompletos · Agilsmart no respondió»
  (or «no disponible», «sin respuesta a tiempo», «sin sesión activa») for one
  that answered nothing, and «No se pudo consultar a ningún proveedor» when
  none answered. A migratory sweep uses the same line. A search waiting for
  capacity has one, «En espera · Tu búsqueda empezará en cuanto haya un cupo
  libre», with a clock, until it starts. There is no notice for
  a search that is merely slow.
- CTA labels are direct: «Buscar», «Cotizar», «Copiar», «Limpiar».

## Checks

The gates are listed once, in [`AGENTS.md`](../AGENTS.md), "Verification". The
end-to-end suite ([`TESTING.md`](./TESTING.md)) drives the desk at 1440×900 and
checks the 1024×768 desk, phones at 390×844 and 360×740, and a phone held
sideways for horizontal overflow and reachable actions; every test fails on a
page error. It does not compare pixels: check a visual change by eye in both
themes at those sizes.
