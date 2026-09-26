# Redesign Contract

What binds the frontend to the design manual: where the manual is, how the
code cites it, and each rule by which the code departs from it, with its
reason and, where the owner decided it, the owner's own words. The identity
the code draws — tokens, catalogues, layouts — is in
[`FRONTEND_IDENTITY.md`](./FRONTEND_IDENTITY.md).

## The design manual

**The manual lives outside this repository.** It is twelve files,
`00-LEEME.md` to `11-acciones.md`, that ship with `Fly Desk Rediseño.dc.html`
in the Claude Design project «Rediseño web · búsqueda de vuelos». An audit of
the frontend re-extracts it first. Reading order that matters:
`01-fundamentos` (the closed catalogues) and `02-armazon-y-responsive` (the
three shells at 720 and 1100, and the master stacking table) before touching
anything, then the sheet for the surface, then `11-acciones` for what each
gesture does.

How code comments and this file cite it:

- `NN §N` is section `N` of manual file `NN`: `02 §6` is section 6 of
  `02-armazon-y-responsive`, `11 §2.2` is section 2.2 of `11-acciones`.
  `07 §4` numbers its movements, cited as «Movement 5 (07 §4)».
- A plate is a numbered drawing of the canvas, such as `1b`, the desk's
  results. A plate that draws a sequence numbers its moments, cited as
  «moment 3 of plate 9a».
- Other canvases of the project are cited by name — `Main`, `Actual`,
  `Reposo`, `Movil`, `MovilCompacta`, `MovilDetalle`, `Deriva`, `Juicio` — and
  the system sheets by theirs, `Cifras` and `Controles`.
- An *armazón* is one of the manual's three shells: A from 1100px, B from
  720px, C the phone. `useShellSize` decides which one is in force.

**Precedence.** The drawing wins by default, and a difference from it is a
defect until it is shown not to be. The rules below are the exceptions. When a
comment and this file disagree, this file wins.

## The geometry the rules derive from

**One rule sets both row thresholds: the disposition in force must fit its
own one-stop stops label.** Measured against the loaded face, that label is
75px on the desk («1 escala · BOG» at 11px) and 54px in the stacked card's
short form («1 esc · BOG» at 10px). The row has two dispositions, the desk
row and the stacked card. When a lane, a gap or a track changes, the
thresholds are re-derived from this rule, not nudged.

- **The row stacks below 787px of list.** Its lanes at their floors are the
  carrier's mark 28, «who flies» 142, the legs 359, baggage 36, price 116 and
  provider 26, with five 12px gaps, 10px of padding at the left and the
  10px right gutter of `.fd-list-body`, so the header and the rows end on one
  pixel. The fixed measure is 428 (`RESULT_ROW_FIXED_PX`); a leg's fixed lanes
  are 284 (56 + 126 + 66 and three 12px gaps, `RESULT_LEG_FIXED_PX`); and
  284 + 75 = 359 is the legs track. 428 + 359 = **787**
  (`@container fdlist (max-width: 786.98px)`).
- **The detail column needs 824px of list.** 428 + 284 + 112, where 112 is
  «2 escalas · BOG, PTY», the widest stops label the row draws while it still
  names its airports. `useShellSize.ts` computes it from the shell, not the
  list, because measuring the list to decide whether to shrink it would
  oscillate: `min(shell, 1760)` minus 616px of chrome (32 of screen padding,
  248 of filters, 316 of detail, two 10px gaps). A 1440 desk sits on the
  boundary at exactly 824, where `Juicio.dc.html` draws it. The 37px over the
  787 floor is deliberate: admitting the column takes 326px from the list at
  once, so the budget is the result cell at the width it is meant to have,
  not the width the stacking rule merely tolerates.
- **The slack goes to the lanes whose data can use it.** Past 787, three lanes
  grow, in the order their own data is being cut: the stops lane first, by up
  to 68 (to 143, the width of «9 escalas · MMM, MMM +7», the widest string the
  model emits), because it is the only lane that starts below what its data
  needs; then «who flies», by up to 28 (to 170, «Operado por Aerolíneas
  Argentinas» at the 10/600 it is painted in); then the price, by up to 19
  (to 135, «USD 123,456.78», the widest total nine passengers can be quoted),
  last because its figure does not wrap and bleeds into the gap rather than
  losing digits. What none of them can use is split in four equal shares, one
  per boundary between two named columns, carried by the lane whose content
  aligns away from it. The mark's lane is not named by the header, so the gap
  between a mark and its carrier does not grow. On a 1440 desk the whole 37px
  of slack goes to the stops lane, which draws 112: the row the plate draws.
- **The stacked card keeps the airport code in every mode at 360px.** Its legs
  block is a label lane, 120 of schedule, 60 of duration and the stops lane,
  with three 4px gaps. On a 360 phone that leaves the stops lane 96px in
  Exacto, where the label drops its date to 22px because the search bar
  states it, and 62 in Flexible and Migratorio, where the label keeps its date
  at 56 because varying the date is what those modes are for. Both clear «1 esc · BOG» (54)
  and the widest three-letter code (59.9). Pinned by «at 360 wide every mode
  fits, keeps its search action in reach, and names the stopover airport»
  (`test/e2e/mobile.e2e.ts`).

Only the result row asks the list's width (`fdlist`); the migratory grid and
the cards' entrance cascade answer the shell size, as the manual's master
table draws them as desk-versus-phone shapes.

## Where the code departs from the manual

| Manual says | Code does | Why |
|---|---|---|
| 05 §7 offers «copiar sin tarifa confirmada» as an exit from a failed quotation | A fare the provider does not confirm is never shown or copied; the failure stays in the panel with «Reintentar» (11 §4) | A fare that turns out not to exist reaches a customer as a price the agency has to honour. |
| 02 §2 stacks the row at a list width of 660 | 787 | The manual's sum omits the row's padding; 787 is the same sum with this row's numbers (above). |
| 02 §1 gives the detail a third column from 1100 and a side sheet below | The form reflows at 1100; the detail becomes a column only at 824px of list (a 1440 shell) and is the same side sheet, with the same scrim, until then | 1100 is where the form stops fitting its six minimums in one row. A detail column from 1100 to 1436 would leave the list 482–818, under the row's own threshold, so every result on a 1366 laptop would wear the phone anatomy inside a three-column desk («cada resultado colapsa el ancho», as reported). The filter column never yields. |
| 8c gives «who flies» a 186px lane, and the baggage a track of its own beside the legs | The «who flies» lane is 142 at its floor; baggage is a fixed 36 lane | **Owner-decided, against the plates.** «No solucionaste el cambio erróneo de ancho de celda de resultado, compara con commits viejos y arréglalo … el correcto es el que tenía en el commit de rediseño.» Every pixel a fixed lane gains comes out of the legs track, the row's result cell. The «who flies» lane holds one line of carrier name, and the widest the catalogue draws, «Aerolíneas Argentinas», measures 141 against the loaded face: 142 holds it unbroken, where the maqueta's 132 clips it. The baggage lane is 36 so the header above it can carry «Eq.». |
| The plates draw the row once, at 1440, with one elastic lane | Three lanes grow with the desk and the rest of the slack is spacing (above) | The plate is under-specified beyond 1440: with one elastic lane, a 1920 desk would draw 418px of content, then 357px of nothing inside the stops lane, then the baggage, the price and the provider. |
| The plate sets the stacked schedule sub-grid gap at 6 | 4 | With Plex Mono 700 loaded, each time measures 42px. Two times, the 11px arrow lane, the 13px day lane and three 4px gaps are exactly the 120 the schedule lane has; at 6 the block needs 126. |
| The plate sets the stacked leg lanes' gap at 8 | 4 | At 8 the stops lane falls under the 54 «1 esc · BOG» needs, and the airport code is the first thing the ellipsis eats. |
| `MovilCompacta` puts the baggage pair in the legs block, as a fifth lane | The pair stays on the carrier line, in a fixed 32 lane | In the legs block the pair and its gap take Flexible's stops lane to 26, so the mode that varies its dates would lose the code on every phone under 388px (the iPhone SE, 6, 7 and 8). `MovilCompacta` affords the move only because it also drops the code («1 escala», not «1 escala · GRU»), which the geometry rule forbids. `Deriva.dc.html` and 8c keep the pair on the carrier line. |
| 8c abbreviates the stops lane but keeps the airports at every count | The stacked card writes the long form in Exacto for one stop, the short form elsewhere, and the bare count («2 esc») from two stops | The wording in force must fit the lane the mode gives it. Exacto's 96 holds «1 escala · MMM» (74); 62 holds only «1 esc · BOG» (54). From two stops no lane holds the long form («2 escalas · BOG, PTY» is 101) or the short one with codes («2 esc · PTY, MIA» is 82), and the ellipsis would eat exactly the codes the label exists to carry. The choice is made in the stylesheet against `data-stops`, so a lane that changes re-decides it; the `title` carries every layover and the detail names each stop. |
| 04 §7's skeleton reads as a claim that expires, and 11 §3 gives a «tarda» notice for a late search | Neither exists: the skeleton stands, silent, for as long as the search is alive | **Owner-decided, against the plates.** «Esos avisos de demora no deben existir, solo el absoluto de no funcionar.» A real search takes 15 to 40 seconds and more, so «está tardando más de lo habitual» would announce the ordinary case at the moment the agent can do least about it. What speaks is failure: the one-line notice (04 §8) for a provider that fell, and «No se pudo consultar a los proveedores» in the column when nobody answered. A search waiting for capacity is not a slow one; see the next row. |
| — (the manual has no queue: a search either runs or fails) | A search that waits for capacity says so in the notice line, «En espera · Tu búsqueda empezará en cuanto haya un cupo libre», with a clock instead of the warning glyph, polite, until it starts; a sweep says it only while none of its months has started. It is never refused for capacity | **Owner-decided.** «Que su búsqueda no se rechace con un aviso de error genérico, sino un texto breve que le indique que la búsqueda se realizará tan pronto haya disponible un cupo.» The one exception to the row above: waiting is not slowness, since no provider has been asked yet, and the agent can still stop it. A search that has started and is merely slow still says nothing. |
| — (the manual has no capacity indicator) | The title bar carries the capacity the two agents share: a 24×6 bar in the month cards' geometry, left of the copy and paste capsule, with no text of its own | **Owner-requested**, minimal and in the design's own terms: the fill is the searches in progress against the most that can run, never what a search costs; the accent marks it only while a search waits, which is a warning role. It is named «Capacidad de búsqueda», says its value in words, follows the runner by long polling, stops reading while the tab is hidden, and goes blank when it cannot be read. On a phone it lives in the title bar, which is drawn at rest. |
| 03 §5 reads "the plinth lists the available providers", and "listed = available" | The plinth lists the providers this deployment searches, always, with no state | Readiness cannot fill it: Click and Book Plus reaches `ready` only once a real search has answered, so filtering by it would drop the provider from the idle screen. The rail is coverage, «Buscando en»; a provider that fails a search is named in the notice (04 §8). `GET /api/provider-status` stays an authenticated diagnostic surface with no UI consumer. |
| 02 §12 sets a 44px touch minimum for every square icon control on a phone | The phone's catalogue is 34 / 40 / 46, and the two title-bar buttons are 34 | **Owner-decided, against the plates.** «Muchos botones se ven muy sobredimensionados espacialmente en tamaño de altura, la idea inicial era reducir el clic incorrecto pero se exageró.» As a floor for every square control, 44 stops being a defence against a mis-tap and becomes the height of the screen: a 44px row per airline, a 44px cell per date, a 44px square per glyph. 40 stays clear of WCAG 2.5.8's 24 and within a finger of Apple's 44pt, and returns 4px per control. Only `--fd-control-touch{,-sm,-lg}` carry the sizes. |
| 02 §4 and plate 1c give the phone a title bar at every moment | The bar is drawn at rest and hidden once a search exists; its copy action moves to the right end of the filter row | **Owner-decided, against the plates.** «Puedes quitar la barra de marca (conservando solo el botón de copiar y moverlo) cuando se hace una búsqueda … puedes aprovechar el espacio derecho de filtros.» Once results exist, those 48px are the most expensive strip of the display, above a list that already spends a summary row, a filter row and a status row. `.fd-filter-strip-copy` is pinned with `position: sticky`, so the chips scroll under it. The bar is hidden rather than unmounted because the theme preference lives in it. |
| 11 §2.4 makes editing «`active` with the form back in its resting anatomy», drawn with the mode and trip segments back above the fields | The segments have two positions: above the form at rest, centred in the title bar for as long as a search exists | Editing is reached by clicking a field, so moving the segments on it would make them jump on the most ordinary gesture there is, and nothing about the mode is edited when a date is retyped. On a desk the form is already whole in the active state, so editing has nothing to move. |
| 03 §8 puts the policy lines «al pie del reposo» | The policy line is a slot the stage owns, below the lower spacer and above the provider rail, at the form's 1180px measure; the rail drops its own top rule while it is there | Inside the form the line would sit between the fields and the notices those fields produce, so the allowed window would read above the error about the date just typed. |
| 1b and 8c draw the schedule as loose values on the card's surface, in fixed lanes | Loose values in fixed lanes, named once by a column header on a desk and by a rule inside the card on a phone; no fill behind «cuándo» on either | **Owner-decided, from the redesign canvas** («se ve tosco … distribuir bien todo el espacio disponible, tanto para ida y vuelta como solo ida»). What reads as crude is empty fixed lanes, not the paint: a header says which value is which once for the whole list instead of once per fare, and the desk and the phone share one treatment. |
| 8c hangs the baggage pair on what the fare includes, in an `auto` lane | The pair is drawn whenever the provider said anything, included or not, in a fixed lane; baggage, price and provider are placed by column number | «A veces pierde su distribución», as reported. In an `auto` lane, a fare that includes neither bag, or that no provider described, would draw no pair, the lane would collapse, and auto-placement would walk the price and the provider one lane left. 04 §4's dimmed icons are how «no lleva bodega» is drawn, so `shown` on the model decides, not the label. |
| Plate 1b draws the list column as one bordered card holding the header, the chips and every result | The list has no box: the header floats above the rows, which stand on the stage | **Owner-decided, against the plates.** «el borde llega hasta el borde de la tarjeta de resultados; eso no era así en el commit de rediseño». A frame around rows that carry their own edge is a frame touching a frame. The column keeps its structure — container query, flex, overflow — and none of the paint. |
| 1b draws each fare as a card: border, radius 12, shadow, 58 tall, 6px apart | A table row: 52 tall, `padding: 0 0 0 10`, one `border-bottom`, no gap. Selection and hover are on the surface: the `selected` wash and a 2px primary edge at the left | **Owner-decided, against the plates.** A list of fares is a series compared lane by lane, not a collection of objects: the card is a table row inside, and would pay for a frame without the header a table gives. `.fd-card__hit` is inset 1px so its focus ring stays inside the list's clip. The phone keeps the card: deciding the list is a table is a statement about a desk. |
| — (the plates draw no column header) | `.fd-card--head`: the row's own class plus a modifier, 26 tall, on the same lanes; hidden below the stacking threshold | It carries `.fd-card`, so its tracks are the row's and cannot go stale. That is why the duration lane is a fixed 66 and not `max-content`, which resolves per row: `formatJourneyDuration` emits `Nd Hh Mm` with no ceiling on the days, «2d 11h 45m» is ten characters, and Plex Mono advances 0.6em, so 11 × 0.6 × 10 = 66 (60 at the phone's 10px). It mounts beside `.fd-list-viewport`, inside `.fd-list-body` and outside the scroller, so it neither scrolls nor takes a place in the rows' entrance cascade; the list and the skeleton both carry it. |
| — | The order is the column header: its four sortable columns, Horario, Duración, Escalas and Precio, are the radios of one group | **Owner-decided.** The backend orders by four criteria, and making a column sort is what the header of a table is for: the columns that already name that data sort, and the lanes that cannot be ordered by (Aerolínea, Tramo, Eq., Prov.) stay labels. The active arrow hangs «Duración» (56.89 in a lane of 66) 5.89px into the gap beside it rather than widening the lane, which would move 787 and 824. The phone, with no header, keeps `.fd-result-sort-compact`, which cycles the four. |
| 1b puts a strip of active filter chips above the list | Only on a phone; on a desk and a tablet the count line says «N vuelos ocultos por filtros» | The desk's filter column is on screen the whole time, and the strip would repeat it 250px away; leaving it out returns 35px of list height. On a phone the filters are a sheet and the chips are their only voice. |
| 1b and 8a draw the filter rail and the detail column as `.fd-panel` cards | Neither is a box. «Filtros», «Resultados» and «Oferta» fall on one 28px line with one `--color-rule` rule, and the detail column is a 12px inset against a hairline | **Owner-decided, against the plates.** Filters is the control of the list beside it, not an object apart, and a card around segmented controls is a box inside a box. The detail is an object, but framing it while the columns beside it are flat makes it foreign; what tells the agent where to act is its action bar at the foot. Its header is that line plus a hero on no band: the airline at 17/700, the price at 17 in mono, «N adultos · total», the carrier mark at 32. |
| `Main`: the results counter at 12/**600** | 12/700 | `Cifras` §03 puts a counter in the 700 rung with the hour and the code, and the counters of the results surface share one alphabet, one weight and one column. A surface plate does not outrank the system sheet that closes the weights. |
| `Main` and `MovilCompacta`: the baggage pair at **15px** and the leg arrow at **11px**; `MovilDetalle`: a 20px back chevron | 14, 12 and 18 | The pictogram catalogue is 12 / 14 / 16 / 18 and `AppIconSize` is that union, checked by `bun run typecheck`. The pair's pitch is 18 either way. |
| `Main`: the rail's flight and layover lines at **11px** sans | 12px sans at 600 | 11 is the body the catalogue reserves for the monospace, so the sans lines of the product are 12. |
| `Main`: the leg summary «28 may · 15h 15m · 1 escala» in **sans** | Mono | `Cifras` §01 decides the alphabet by what a value *is*: a date and a duration are figures. |
| `Main`, `Actual`: the airline row at **28** tall | 32, with no gap between rows | 28 is not in the closed table of control heights, `Controles` puts this row at «32 → 40» between its two densities, and the 16px checkbox inside it is derived from the 32. |
| `Reposo` §1: «Buscar» at 15/700 | 14/600 | **Owner-decided.** The 700 rung governs the results surface — hour, counter, code — not the form's values and controls, where every value is 600. |
| `Movil`: a 14px chevron lane on the card, and «1 escala» without the code | No chevron; the code is kept | The chevron is decorative and `aria-hidden` over a card that is the whole target, and its 24px is part of what buys the airport code back. |
| `Main`: the brand mark as a stroked outline; the provider and carrier marks as two-letter tiles | The filled brand asset; real carrier and provider artwork | The plate draws placeholders for artwork the application ships. Only the sizes are the plate's: the brand mark is 20. |
| `MovilCompacta`: the grouped row as one quiet line, «3 horarios más · desde + USD 42.00», in place of the chip strip | The chips stay | The price in that line cannot exist: `offer-schedule-groups.ts::groupKeyForOffer` groups only offers whose currency, amount and baggage match, so every schedule in a strip carries the price the card already states and the delta is always zero (`buildAlternateScheduleModel` computes none). Without it the line is a count, and the times are the only thing that differs between the members of a group. |
| `MovilDetalle`: the sheet's ground at `#f8f8f6`, the airline on a 20px line over a 22px price | `--color-popover`, and both lines at 1.2 | The ground belongs to the sheet primitive every phone overlay shares; the plate draws the page the sheet sits on. The hero is shared leaf for leaf by the desk column and the phone sheet, and moving its lines would fork one component's type between two surfaces for less than three pixels. |

## Rules for the idle form

**A notice never moves the block it belongs to** (07 §0, rule 1). The idle
stage centres the form between a `1fr` and a `1.3fr` spacer, so any row the
form gained would move the whole block. The stage's own `.fd-alert-line`
leaves the flow; each idle field reserves the rows it can end up holding, and
the reserve is derived from the notice's own declarations (`0.25rem` of margin
over a `1.2` line box of `--fd-text-meta`): `.fd-search-field-shell` is the
control plus that lane, and `.fd-location-field-shell-reserve-suggestions` is
the control plus the chip row (`5px` over `--fd-control-standard`) plus that
lane.

**The chips answer to the screen, not to the focus.** The frequent-station
row is furniture of the idle form (03 §8, 11 §2.1), so it stays for as long as
that screen does, including while a field is being edited to correct a
finished route (11 §2.4); a suggestion panel that opens covers it. It does not
come back in the active screen, where it would compete with the results.

## Rules for the results column

**The list and its skeleton are one measurement.** Plate 4a asks for «never more
rows than the real list». The count of rows the column holds is taken once, by
the hook that opens the list (`useResultsColumnCapacity`), and the skeleton
draws that count; it has no default. In a partial search the skeleton fills
only the rows still missing.

**The column is measured before the first paint.** The first measurement is
taken synchronously in a layout effect, and the animation frame only
coalesces the observer's later ones, so neither the skeleton nor the arriving
list paints a frame at a fallback count.

**The results are one list that grows, not a run of pages.**
**Owner-decided, against the plates**: 04 §6 draws a pager in two forms and
1b gives it a strip at the foot of the column; neither exists. The column
opens on what it fits, adds two columns' worth whenever the end of the window
comes within 900px of the viewport, and never takes anything back. That
returns the pager's 41px on every armazón and makes offer 40 of 520 a scroll.
The opening window is measured in plain-row slots
(`resultItemsFillingCapacity`): a group row counts
`RESULT_GROUP_CARD_WEIGHT`, 1.77 — its 52px fare band, the 39px strip of
alternatives and the hairline, 92 over 52.

The window grows on an `IntersectionObserver` over a zero-height sentinel, not
on the scroll handler: the observer fires once per crossing. The prefetch
margin is a column, because a batch is a render and not a fetch. The growth
stays inside the list's own scroller (`.fd-list-viewport`); the shell never
scrolls. 11 §3's «cada filtro y cada orden devuelve la lista al principio» is
keyed on the view — the order and the filters — and not on the offers, so the
progressive batches of a search leave the reader where they are.

**The results viewport draws no scrollbar**, on a desk or a phone. An overlay
bar would cover fare hit area and repeat the browser's own affordance, and a
native one would take width from a 1440 desk that has none to spare.
`.fd-list-viewport` stays the scroll owner, with its bar at zero width.

**The column ceiling is a guard, not a window size.** `RESULTS_COLUMN_ROWS_MAX`
is 20, the 19 plain rows of a 1440-tall column plus one; past it the list
grows by scrolling like everywhere else.

**An offer is inside a group when its itinerary is, not only when its id
is.** `combinations[].offerId` trusts the provider to list every offer its
group covers, and a `truncated` group, or one schedule quoted under two offer
ids, breaks that trust: the list would draw a card whose legs the agent has
just read in the strip above it. Membership is also the canonical flight
signature — every leg, its flight numbers, airports and times — the identity
`offer-signature.ts::buildOfferSignature` demands when a quotation is
revalidated.

**The fold stops at the fare.** Two offers on one schedule at two prices are
two things to sell, so the signature carries the currency, the amount and the
baggage, and a differently priced twin stays its own card. That is the bar
`offer-schedule-groups.ts::groupKeyForOffer` groups on, never a looser one.
The fold reads the already-filtered offers after the «a partially filtered or
stale group is not a group» rule, so a member the filters removed cannot come
back through it.

## Backend rules the frontend relies on

**One quotation composer.** `src/core/quotation.ts::buildCommercialQuotation()`
is the only place the commercial text exists. The UI and `POST /api/quotation`
pass `migrationPlan` to that same function, and the migratory switch
regenerates the text locally over the already-revalidated offer, without a
second provider call.

**The frequent-station ranking is one global row, written where it is read.**
The chips are the agency's ranking, not the browser's: `location_usage` is
keyed by `(role, code)` with no session in it, and the per-session strip is a
separate table that feeds only the panel's «Recientes». The unit that answers
`GET /api/location-usage-suggestions` is the unit that counts the search: the
web unit records the route as it delegates `/api/search` and `/api/matrix`,
and the runner skips anything stamped `x-flydesk-search-proxy: 1`. A search
the runner refuses is not counted; it is not a route the desk searched.

**A use counts for a month and then stops counting.** «La idea de mantener una
media es que el conteo expire en un mes, es decir si se buscó 30 veces el mes
pasado y este 10, y hay otro con 20 en el mes actual, entonces pasaría a
segundo puesto.» The count lives in `location_usage_daily (role, code, day,
uses)`, one row per station per day, and the ranking is `SUM(uses)` over the
last thirty-one UTC day numbers: a use recorded on day D counts through day
D + 30. Rounding to the day is deliberate, so no card moves mid-afternoon.
Pruning happens on the write path, which keeps the table bounded and the read
every idle screen makes read-only. `location_usage.total_uses` is the lifetime
figure and orders nothing, and the daily table is not seeded from it: a total
says how often, never when.

**The last card of each role answers to recency.** Even a count that falls
admits nobody quickly, which is the reported «una búsqueda bastaría para
agregar otro comodín, y probándolo no aparece». The first slots of each role
are the live count (uses in the window, then last use, then code) and the last
slot is the station used most recently, unless it already holds a slot above.
One executed search, from any browser, puts a new station on everybody's row,
while the stations the desk lives on keep the slots above it. At `limit < 2`
there is no reserved slot. `getDiagnostics()` reports the ranking as
`rolling-window-uses-with-newest-card` with its `rankingWindowDays`.

**Quoting always revalidates.** The first «Cotizar» calls
`POST /api/quotation` with the source search and offer ids. The endpoint
accepts only a complete stored offer — a matrix cell with a price but no real
itinerary is not quotable. A `validated`/`verified` fare is reused only within
15 minutes of `priceVerifiedAt`; past that the endpoint asks the provider
again and demands the same canonical flight signature, so a cheaper
alternative on the same day and route cannot silently replace the chosen one.
The client accepts the answer only if it keeps the requested session and
carries a complete transport offer, a positive price, a currency,
`validated`/`verified`, a valid timestamp and non-empty text.

**`quotationPreparedAt` is local, `priceVerifiedAt` is the provider's.** The
first marks the first local materialisation with everything needed to quote;
it is set once and preserved across re-materialisations. Only the second
changes when the quotation call succeeds. One shared constant fixes both the
visible 15-minute warning and the reuse window. Cached SWR drafts drop
`quotationPreparedAt`, so the UI never publishes a false age.

**Search ceilings come from the runtime.** `src/core/search-limits.ts` holds
the stay, passenger and lap-infant maxima; the HTTP contract validates against
those constants and `getPublicRuntimeConfig()` injects them into the page,
which is where the policy line's «hasta 90 noches en ida y vuelta · hasta 9
pasajeros» comes from. The backend rejects stays over 90 nights and matrices
over 5,000 combinations before any provider work starts.

**Provider status is a closed surface.** `GET /api/provider-status` is
authenticated and `no-store`, and returns only canonical ids, a closed state,
a closed reason code and timestamps — never messages, URLs, tokens or provider
payloads. The tracker distinguishes `unknown`, `checking`, `ready` and
`degraded`; an observation stays fresh for two prewarm intervals plus a
minute, or five minutes with prewarm off, and a search observation outranks
the prewarm's. Prewarm proves availability for Agil; for Click and Book Plus
it proves only local context, so only a real search marks it `ready`. A
payload status of 400 or more inside an HTTP 200 fails the provider like an
HTTP error and leaves the tracker `degraded`.

**The data the cards need.** `faredDays`/`queriedDays` per month (absent on
partial results, so an under-sampled month never looks verified); the two next
fares per month; the operating carrier for codeshares; and per-leg duration
and stops, because a sum over both legs describes no flight the agent sells.
`fareMeta.seatsRemaining` stays in the payload and is never drawn: Agil can
answer a real `0` for a flight that is on sale, and Click and Book Plus does
not publish the field at all.

**The result grid is closed.** The row's lanes are
`28 / 142 / 1fr / 36 / 116 / 26`, the duration lane is fixed so the column
header can name it, and there is nothing to tune: no layout editor and no
layout endpoint.

**A refused session write is owed, not retried.** The 180ms debounce in
`src/session-store.ts` is the only thing that schedules a write. When one
fails, nothing arms a retry of its own: the maps that decide what a write owes
are updated only after the transaction commits, so the whole diff, changed
rows and deleted ids alike, is still owed; the next mutation's debounce carries
it, and `close()` carries whatever is left at shutdown. A retry timer would
spin every 180ms against a full or read-only disk without writing a byte. The
cost is the stretch between a refused write and the next mutation on an idle
desk, during which the results are memory-only, so the failure is logged.

**`SEARCH_COMPLETED_SESSION_TTL_MS` is a sweep threshold, not a storage
switch.** It is the age a finished job may reach before a sweep takes it. `0`
is therefore the shortest lifetime the sweep can express and not a `no-store`:
the job is stored the instant it is created, survives a sweep run at its own
timestamp, and is taken by the first sweep that sees a positive age — on a
running desk, the 60s maintenance interval of `src/index.ts`. Reuse uses the
same threshold, so at `0` a completed search is never handed to a second
request. A deployment that must not keep finished searches on disk says so by
giving the store no database.

## What the code does not do

**Arbitrary leg recombination (plate 3b).** `SearchResponse.scheduleGroups`
publishes groups backed by native Agil or Click and Book Plus identity.
Choosing an outbound and an inbound independently requires the provider to
have quoted that exact combination; no fixture shows either provider able to
recombine freely, so the backend neither promises nor simulates it. Without a
native reference there is no group, and a lone alternative is an independent
offer.

**The sign-in gate transcribes the catalogues; it does not share them.**
`renderLoginPage()` in `src/web-auth.ts` is served before any bundle is
reachable, so it cannot import `frontend/src` and its values are copied by
hand. The tokens keep the names they have in the stylesheets, so a value that
drifts shows up as a difference in a name and not only in a number. The gate
wears the title bar, the 52px field of 5b with its micro label, the "xl"
button, 3d's focus ring and 11 §3's notice, plus the theme switch. Nothing
keeps the two in step automatically.
