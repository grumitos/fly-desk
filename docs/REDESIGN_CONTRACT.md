# Redesign Contract

What the flight-search redesign committed the code to, where it deliberately
departs from the design manual, and what is still missing. This replaces the two
Spanish progress reports the redesign branch carried; their narrative is in the
Git history, the decisions that still bind the code are here.

## The normative source is not in this repository

The redesign is specified by a twelve-file manual (`00-LEEME.md` …
`11-acciones.md`) that ships with `Fly Desk Rediseño.dc.html` in the Claude
Design project «Rediseño web · búsqueda de vuelos». It is not committed here, so
any audit of the frontend has to re-extract it first. Reading order that
matters: `01-fundamentos` (the closed catalogues) and `02-armazon-y-responsive`
(the three shells at 720 and 1100, and the master stacking table) before
touching anything, then the sheet for the surface, then `11-acciones` for what
each gesture does.

Comments in the frontend cite that manual by section (`02 §6`, `11 §2.2`). When
a comment and this file disagree, this file wins: it records the decisions the
repository made on top of the manual.

## Where the code departs from the manual, and why

| Manual says | Code does | Why |
|---|---|---|
| 05 §7 offers «copiar sin tarifa confirmada» as an exit from a failed quotation | The draft is never shown and never copied | A fare that turns out not to exist reaches a customer as a price the agency has to honour. The failure stays in the panel with a retry (11 §4) and the local draft does not survive it. Covered by a Playwright case. |
| 02 §2 puts the row's stacking threshold at a list width of 660 | 787 | The manual's own sum omits the row's padding. This row read 750 while the legs track was `list - 436`, then 819 while the baggage lane was charged to the result cell, then 775 once the lane was paid for out of «who flies» (row below). The floor in the 750 was 50, borrowed from the duration lane rather than measured: the one-stop long form «1 escala · BOG» measures **75** at 11px, so between 750 and 775 the desk anatomy was in force over a row that rendered «1 escala…» and lost the airport code §5 protects. The row is a table row now, and the sum is the same sum with its numbers: 284 of fixed leg lanes (56 + 126 + 66 and three 12px gaps) + 75 = 359 of legs track, and `359 + 428` = **787**. It went *up* by 12 while the frame came off, and the two halves say why: the row gave back 8 when it stopped being a card (436 → 428) and the duration lane took 20 when it stopped being `max-content` and became the fixed 66 the column header requires (264 → 284). |
| — (the side-by-side leg row is not in the plates) | Retired. The legs stack at every desk width | It shipped at 980, a width read off where the empty space looked bad rather than derived, and was re-derived twice: to 1073 as two plates that split the elastic track. What it existed for was a row too wide and too empty — the legs track had 700px on a 1920 desk and used 260 of them, twice. A table row does not have that problem: the elastic stops lane simply takes the slack (432px at 1920), which is where the long wording lives anyway. And it could not survive the column header: a header names one set of lanes, so a second disposition past a threshold would need a second header. ~87 lines and `__leg-wait` are gone with it — the layover the wide single-leg plate had room to name is in the `title` and in the detail sheet, as it is for every other disposition. |
| 02 §1 gives the detail a third column «from 1100» and a side sheet below | The form still reflows at 1100; the detail column waits until 1440 | 1100 is the width the *form* stops fitting its six mínimos in one row, and the results region inherited the number. Measured, the detail column costs the list 326px, so from 1100 to 1436 the list was 482–818 — under the card's own threshold — and every result on a 1366 laptop wore the phone anatomy inside a three-column desk. The list was in fact **wider one pixel below 1100 (807) than one pixel above it (482)**: widening the window collapsed the cards, which is «cada resultado colapsa el ancho» as reported. So armazón B's two mechanical changes to A are separated, each on the threshold that constrains it, and the detail leaves the grid as soon as keeping it would take the list under **824** — the row's 428 of fixed measure, the leg's 284, and 112 for «2 escalas · BOG, PTY», the widest stops label the row draws while still naming its airports — the same sheet, the same scrim, 340px earlier. That margin over the 787 stacking floor is 37 and it is measured: the budget is taken with the result cell at the width it is meant to have rather than at the width the stacking rule will merely tolerate, because admitting the column costs 326px in one step. It replaces `RESULT_CELL_RESTORED_PX = 44`, which was the gap between charging the baggage lane to the cell and charging it to «who flies» — an accounting that has been settled for two changes. `LIST_BORDER_PX` went with it rather than being kept as slack: it was the list card's own border, the list has not been a card since #45, and the two pixels decide something — kept, a 1440 desk measures 822 against 824 and loses its third column to a border that is not drawn. The filter column never yields; that is what still separates this from mobile. |
| 8c gives «who flies» a 186px lane, and the baggage its own track beside the legs | The lane is 142; the result cell keeps `list - 428` | **Owner-decided, against the plates.** «No solucionaste el cambio erróneo de ancho de celda de resultado, compara con commits viejos y arréglalo … el correcto es el que tenía en el commit de rediseño.» Measured against built revisions rather than read off the CSS: only one track of the card is elastic, so every fixed lane the row gains is taken out of the result cell and out of nothing else. The redesign (`5172ea6`) drew 32/186/1fr/116/26 with four 12px gaps — a fixed measure of `list - 436`, and a cell of **708** on a 1920 desk, **484** on a 1536 one. `1a85c4f` gave the baggage its own `auto` track: 32px of track plus a fifth 12px gap, all 44 charged to the cell, which fell to **662** and **438**. (That track is a fixed 36 now, sized so the header above it can carry «Eq.», and the three lanes after the legs are placed by number: `auto` made the row's geometry a function of the fare — a fare the provider said nothing about drew no pair, the lane collapsed, auto-placement walked the price into it and the provider into the price's, and this very invariant broke for exactly those fares. See the row below.) Every threshold in `result-card.css` rose by that same 44 (750→819, and the side-by-side row to 1117), which is why the desk anatomy stopped fitting lists it used to fit. The 44 is paid back out of the lane that had measured slack instead: «who flies» holds one line of carrier name, and the widest name the catalogue draws is «Aerolíneas Argentinas» at **141px** against a 186px lane, so 142 still holds it unbroken. Restored, measured on the same four viewports: cell **706 / 706 / 482 / 638** at 1920×1080, 1920×911, 1536×864 and 1366×768, against **662 / 662 / 438 / 594** before — the redesign's numbers less the 2px the list card's own border correctly takes. The measure is **428** since the recipient stopped being a card (row below): the five fixed lanes still sum to 348 — the logo gave four pixels to the baggage, which needs 36 to carry «Eq.» in the header above it — and the five 12px gaps are unchanged, so the whole difference is 13px of padding and a 1px border on each side becoming 10px of padding and none. The cell is eight pixels *wider* at every width. The maqueta drops «who flies» to 132; it is left at 142, because «Aerolíneas Argentinas» measures 141 against the loaded face and 132 clips it — the maqueta's fixture for that airline was in the filter column, not in a row — and the ten pixels come out of the fixed measure rather than out of the name. Pinned by a Playwright case that asserts `list − legs === 428` at all four viewports and that the name lane still fits its longest label. |
| The plate sets the stacked schedule sub-grid gap at 6 | 4 | The plate never loaded Plex Mono 700, so its bold times were synthesised from 600 and kept the narrower advance. With the real face each time measures 42px and the block needs 126 where the lane can afford 120. The next gap down brings it to exactly 120, which is what the horario lane is: `MovilCompacta` fixes that lane at 116 and states 113 measured, and the block measures **120** in the row — two 42px times, the 11px arrow lane, the 13px day lane and three 4px gaps. Measured, not copied. |
| The plate sets the stacked leg lane gap at 8 | 4 | Same correction, same cause, one level up, and this is the third time the same arithmetic has moved this number. At 8 the stacked leg row's elastic stops lane was 51 against the 54 «1 esc · BOG» measures, so the airport code the whole threshold exists to protect was the first thing the ellipsis ate; 6 returned exactly the 6px that bought it while 56/124/46 stood. The lanes have moved since — 22 for the rótulo (which loses its date in Exacto), 120 for the horario, a fixed 60 for the duration and a 32 for the baggage pair, which comes down off the carrier line into the legs block — so the sum is 234, and a 360px Android gives the block 310. Four gaps at 6 leave 52 against the same 54; four at 4 leave **60**, which also clears «1 esc · MMM» at 59.9. The phone keeps the code, which is the rule. In Flexible and Migratorio the rótulo keeps its date and the lane is 56, so there the block needs 388px of viewport rather than 354 — 16 worse than before, and the price of the pair coming down; the alternative was a second anatomy chosen by mode. |
| 8c abbreviates the stops lane but keeps the airports at every count | The stacked short form names the airports for one stop and shows the bare count from two | The narrowest phone lane is 60 and it holds «1 esc · BOG» (54) and nothing near «2 esc · PTY, MIA» (82) or «3 esc · PTY, MIA +1» (95). Cutting those to «2 esc…» hides the codes the abbreviation exists to preserve and adds a dangling ellipsis; the count alone says all of what it says. The desk long form is unchanged, the `title` still carries every layover, and the detail sheet names each stop. |
| 04 §7's skeleton was read as a claim that expires, and 11 §3 gives a «tarda» notice for a search that is late | Neither exists. The skeleton stands, silent, for as long as the search is alive | **Owner-decided, against the plates.** «Esos avisos de demora no deben existir, solo el absoluto de no funcionar.» Two surfaces went: the status line the skeleton grew at eight seconds, and the empty state that took the whole column from a reader who had asked for no movement. The reasoning behind the 8s was already that a real search takes 15–40s and more — the production smoke's *fastest* case lands around 15 — which makes «está tardando más de lo habitual» an announcement of the ordinary case, at the moment the agent can do least about it. What still speaks is failure, and it has its own states: a provider that fell reaches the one-line notice (04 §8) and a search that reached nobody takes the column with «No se pudo consultar a los proveedores». `stillSearchingBody`, the 8s timer and the reduced-motion branch are deleted rather than disabled; a Playwright case asserts the absence at nine seconds in both motion preferences. |
| 03 §5 reads "the plinth lists the available providers", and "listed = available" | The plinth lists the providers this deployment searches, always, with no state | Health was tried and it backfired: filtering by a live `ready` observation dropped Click and Book Plus from the idle screen entirely, because it cannot reach `ready` until a real search has answered. The rail is coverage — «Buscando en» — and a provider that fails a search is said in one line above the results (04 §8). `GET /api/provider-status` stays as an authenticated diagnostic surface with no UI consumer. |
| 02 §12 sets a 44px touch minimum for every square icon control on a phone | The mobile catalogue is 34 / 40 / 46, and the two title-bar buttons stay one step below it | **Owner-decided, against the plates.** «Muchos botones se ven muy sobredimensionados espacialmente en tamaño de altura, la idea inicial era reducir el clic incorrecto pero se exageró.» Read as a floor for *every* square control, 44 stopped being a defence against a mis-tap and became the height of the screen: a 44px row per airline, a 44px cell per date, a 44px square per glyph, stacked. 40 is still comfortably clear of the 24px floor of WCAG 2.5.8 and within a finger of Apple's 44pt, and it returns 4px per control and 6 per counter — most of a card per screen. The three sizes keep their relationship, so nothing built on them is re-thought; only `--fd-control-touch{,-sm,-lg}` move, which is why the QA cases now read the token instead of restating the number. |
| 02 §4 and plate 1c give the phone a title bar at every moment | It is drawn at rest and gone once a search exists; its copy action moves to the end of the filter row | **Owner-decided, against the plates.** «Puedes quitar la barra de marca (conservando solo el botón de copiar y moverlo) cuando se hace una búsqueda … puedes aprovechar el espacio derecho de filtros.» At rest the bar has the top of the screen to itself and belongs there. Once the results exist the same 48px is the most expensive strip on the display — a wordmark, a link to the page already open and a theme switch, above a list that already spends a summary row, a filter row and a status row before its first card. 02 §5 protects controls, not furniture, and the one control in the bar that was not furniture is not hidden: `.fd-filter-strip-copy` rehouses it in the free right of the filter row, pinned with `position: sticky` so the chips scroll under it instead of carrying it away. The bar is hidden rather than unmounted because the theme preference lives in it. |
| 11 §2.4 makes editing «`active` with the form back in its resting anatomy», which the mockup draws with the mode and trip segments back above the fields | The segments have two positions and no third: above the form at rest, centred in the title bar for as long as a search exists | Editing is reached by clicking a field, so the inverse FLIP fired on the most ordinary gesture there is and the segments jumped out of the bar and back into the form each time. Nothing about the *mode* of the search is being edited when a date is retyped. On a desk the form is already whole in the active state, so this leaves editing with nothing to move — which is the point. |
| 03 §8 puts the policy lines «al pie del reposo» | They were the last child of the form; they are now a slot the stage owns, below the lower spacer and above the provider rail, at the form's 1180px measure | Inside the form they were not at the foot of anything: they sat between the fields and the notice those fields produce, so a paragraph naming the allowed window was read *above* the error about the date just typed. The rail drops its own `border-top` when they are present, so the foot opens with one rule instead of framing the line in a box no plate draws. |
| 1b and 8c draw the schedule as loose values on the card's own surface, in fixed lanes | They stay loose values in fixed lanes, and a column header names the lanes | **Owner-decided, from the redesign canvas** («se ve tosco … distribuir bien todo el espacio disponible, tanto para ida y vuelta como solo ida»). What read as crude was not the paint but the nine fixed lanes: with two legs each elastic stops lane held ~94 for a label of 60, two twin holes at mid-row; with one leg the row kept all nine tracks, so a one-way card carried **half an empty row and a divider down the middle of it**. The first answer was a `--secondary` ground behind «cuándo» — painted as an absolutely positioned `::before` so the content box, the lanes and every threshold stayed pixel-identical, because the #61 pin reads `getBoundingClientRect()` and a `padding` + negative-`margin` version failed it while looking the same. That ground is now gone, **from the desk and from the phone in the same change**, and so is `--fd-card-plate` with its dark-mode correction. What the grey was doing — bounding the block, saying which value is which — a column header does once for the whole list instead of once per fare; on a phone, where 360px has nowhere to put a header, a rule inside the card says it. Neither surface is left with a fill the other does not have, which is the point: it is the only part of this change that touches the phone, and it touches it to close a difference rather than open one. The elastic stops lane never moved through any of it. |
| 8c hangs the baggage pair on what the fare includes, in an `auto` lane | The pair is drawn whenever the provider said anything, included or not, and the lane is a fixed 36 | «A veces pierde su distribución», reported with a screenshot of one row whose price and provider sat a lane left of every other row's. Two faults, one cause. The card gated the pair on `baggage.label`, which names only what is *included*, so a fare that includes neither — or that no provider described — rendered nothing, even though 04 §4's dimmed icons are exactly how «no lleva bodega» is drawn and the model had kept that evidence all along. And with the pair gone the `auto` lane collapsed, so auto-placement moved the price into the baggage lane and the provider into the price's. `list − legs === 436` broke for those fares too, silently — it is 428 now, and the lane a fixed 36: every fixture in the case that pins it had baggage. The skeleton had the same shape all along — it draws no pair — so it had been standing in the wrong lanes since the baggage got its track, which is the value jump 04 §7 forbids. Fixed lane, explicit `grid-column` for baggage, price and provider, and `shown` on the model instead of the label; a Playwright case now draws the three answers a provider can give and asserts one geometry. |
| Plate 1b draws the list column as one bordered card holding the header, the chips and every result | The list has no box of its own: the header floats above the rows, which stand on the stage, exactly as the redesign commit (`5172ea6`) rendered it | **Owner-decided, against the plates.** #45 gave the column the card the plate draws, and on a desk the outcome was the result cards' own borders running flush against the wrapper's border — a frame touching a frame («el borde llega hasta el borde de la tarjeta de resultados; eso no era así en el commit de rediseño»). The paint (border, radius, fill, shadow, header band) is removed; the column keeps only its structure (container query, flex, overflow). Armazón C was never boxed, so the phone is untouched. |
| 1b draws each fare as a card: border, radius 12, shadow, 58 tall, 6px of air between one and the next | A table row: 52 tall, `padding: 0 10`, one `border-bottom` and nothing else, no gap | **Owner-decided, against the plates.** A list of fares is not a collection of objects, it is a series compared lane by lane — the card was already a table row inside (32/142/1fr/32/116/26) and paid for a frame without collecting what a table gives: forty rounded borders separating exactly what the agent came to compare, and no header, so «8h 05m» and «Directo» were deciphered by pattern rather than read. Nothing inside moved: same lanes, same type, same order. Selection and hover move from the border to the surface, because there is no border left to carry them — a 7% primary wash and a 2px primary edge at the left, which is the one mark a row can wear without closing. `.fd-card__hit` takes 1px of inset: with radius 0 an edge-to-edge hit put its focus ring under `.fd-list`'s `overflow: hidden`. Measured: twelve fares on a 1440×900 desk where ten fitted. The phone keeps the card — deciding the list is a table is a statement about a desk — and loses only the plinth (row above). |
| — (there is no column header in the plates) | `.fd-card--head`: the row's own class plus a modifier, 26 tall, on the same six lanes | It carries `.fd-card`, so the tracks come from the row's stylesheet rather than from a copy that goes stale on the first edit — and that is what forced the duration lane to stop being `minmax(50px, max-content)`. `max-content` resolves per row, so a list where one fare says «1d 11h 10m» and the next «9h 30m» had two geometries, and a header living in its own grid would have resolved a third. Fixed at **66**: `formatJourneyDuration` emits `Nd Hh Mm` with no ceiling on the days, «2d 11h 45m» is ten characters, Plex Mono advances 0.6em, and 11 × 0.6 × 10 = 66.0 exactly — measured in the browser with the 600 weight loaded by name, because `document.fonts.check` answers false for a weight the page has not painted and `getComputedStyle` returns the declared stack rather than the painted face (the same string in the generic fallback measures 60.48). The phone's lane is the same measurement at 10px: 60.0. It mounts as a sibling of `.fd-list-viewport`, inside `.fd-list-body` and outside the scroller — inside `.fd-results-list` it would become that list's first child and push the entrance cascade of `index.css` one position down — and both the list and the skeleton carry it, or the column would gain 27px of header the moment the data landed. Hidden below the stacking threshold, which is also the answer for armazón C. |
| — | The order is the column header | «Ordenar · Precio ｜ Duración» was a control of its own for something a column header already does, in the place everybody looks for it. `.fd-card--head` is the `radiogroup` now and «Duración» and «Precio» are its two radios, with the same accessible names the segmented had, so what changed is the shape and not the semantics — the two arrive in column order rather than in the segmented's, which is the only thing the cases had to renegotiate. The phone keeps `.fd-result-sort-compact`: it has no column header to put the order in. |
| 1b puts a strip of active filter chips above the list | Only in armazón C | On a desk the filter column is on screen the whole time, and the strip repeated it 250px away — the component already dropped its «Filtros» button on a desk for that reason and kept the chips. `chipsPlacement` gains `"none"` for A and B, which returns 35px of list height, and the one sentence the strip said that the rail does not — «N ocultos por filtros» — moves to the count line. On a phone the panel is a sheet and the chips are the only voice the filters have, so nothing there changes. |
| 1b and 8a draw the filter rail and the detail column as `.fd-panel` cards | Neither is a box. Both are a 28px line with a rule, and a 12px inset against a hairline where the column ends | **Owner-decided, against the plates.** Three surfaces wore the same card and none of them meant the same thing by it. Filters is not an object: it is the control of the list beside it, and a card with its own header band presented it as a thing apart from the results it governs — while putting segmented controls, which are already boxes, inside another box, which is what `docs/FRONTEND_IDENTITY.md` asks not to do in as many words. The detail *is* an object, but leaving it framed while the two columns beside it flatten does not make it important, it makes it foreign; what says «this is where you act» is the action bar anchored at the foot. So «Filtros», «Resultados» and «Oferta» fall on one 28px line at one height with one rule, and a single line crosses the screen. The detail's header splits in two: that line, and a hero on no band — airline 17/700, the figure at 17 in mono, «N adultos · total», the carrier mark at 32. `.fd-panel` had exactly those two callers and is deleted with its header, title and subtitle; the class on the detail root is `.fd-detail-panel`, because the choreography case reads the entrance animation by class name and `.fd-panel` matching nothing would have lost that row in silence. The 25% rule those lines are drawn with is a token — `--color-rule`, beside `--color-border` — and not six raw `#1f1f1e40`s, because it also has to flip in dark. |
| — | `RESULT_GROUP_CARD_WEIGHT` is 1.62 | It was 1.67, which was 107 over 64: a 101px group card over a 58px card plus the list's 6px gap. Measured in the running app the two grid rows of a group row are 38 and 45 — 38 is the legs block, the tallest thing on a fare row and what the row measures once the 52px `min-height` stops binding; 45 is the strip's 8px of margin plus its own 37 (a 1px rule, 8 above the chips, the 26px chip, 2 below it) — so with the row's hairline it is 84 against 52, and with no gap a slot is 52. `84 / 52 = 1.62`. Left alone, the column would have been measured with a group counted 3% heavier than it is, and a list that opens on a measured number opens short. |

Only the result card asks the list container (`fdlist`); the migratory grid and
the card cascade answer the shell (`fdshell`) at 719.98, because the master
table describes them as desk-versus-phone shapes.

**One rule sets both row thresholds:** the disposition in force must fit its own
one-stop stops label. Measured against the loaded face, that label is 75 on the
desk (`1 escala · BOG`, 11px) and 54 for the stacked row's short form (10px).
There were three dispositions and there are two: the side-by-side pair is
retired. Every number in the rows above is that rule applied to a different row
geometry; when a lane, a gap or a track changes, the thresholds are re-derived
rather than nudged. `test/ui/results.playwright.ts` pins the whole sweep — at
every width the lane holds the label it is showing, the legs track never
overflows, and the disposition answers the list width and nothing else.

The detail threshold's arithmetic is duplicated in `useShellSize.ts`, because
the answer decides whether the column is *built* and measuring the list to
decide whether to shrink it is a loop that oscillates. It is 616px of chrome —
32 of screen padding, 248 of filters, 316 of detail and two 10px gaps —
subtracted from `min(shell, --fd-app-max-width)`. It was 618 while it also took
the list card's two borders off; those went with the card, and they had to, or a
1440 desk would measure 822 against the 824 the row asks for and lose its third
column to a border that is not drawn. The default UI-test viewport of 1440 now
sits **on** the boundary at exactly 824, which is where `Juicio.dc.html` draws
it; a column that changes width moves that, and it moves loudly rather than
silently, because the whole suite runs in armazón A.

## Decisions that bind the idle search form

**A notice never moves the block it belongs to.** The idle stage centres the
form between a `1fr` and a `1.3fr` spacer, so any row the form gains is paid for
by the *whole* block travelling: an eighteen-pixel notice lifts it eight pixels,
which is 07 §0 rule 1 breached by the control's own error message. The stage's
own `.fd-alert-line` already answers this by leaving the flow; the per-field
notices answer it by being reserved. Each idle field reserves the rows it can
end up holding, and the reserve is *derived from the notice's own declarations*
(`0.25rem` of margin over a `1.2` line box of `--fd-text-meta`) rather than
rounded to a nice number: `.fd-search-field-shell` is the control plus that lane,
and `.fd-location-field-shell-reserve-suggestions` is the control plus the chip
row (`5px` over `--fd-control-standard`) plus that lane. Reserving only the chips
is what let «Ingresa un destino válido» re-centre the screen on every deployment
that had a ranking to show — the empty-strip case passed because there was
nothing under the field to push. Measured in `test/ui/autocomplete.playwright.ts`
with the strip up, which is the state a working desk is in.

**The chips answer to the screen, not to the focus.** The frequent-station row
is furniture of the idle form (03 §8, 11 §2.1), so it stays for as long as that
screen does — including while a field is being edited. Hiding it whenever a
field had focus assumed the panel below the field replaces it, but the panel
opens only on an empty field or on two letters of real match: going back to
correct a *finished* route (11 §2.4) therefore emptied the strip and left a
blank band, held open by the very reserve above. When a panel does open it
covers the row, which is the one case where hiding the chips changed nothing
anybody could see. What still does not come back is the row in the active
screen: once a search exists the chips compete with the results for the same
eye.

## Decisions that bind the results column

**The list and its skeleton are one measurement.** 4a asks for «never more rows
than the real list», and what the list opens on is whatever the column fits. The
list had been measured against its column for some time; the skeleton had not —
it drew a constant seven, capped to six when stacked by a CSS `nth-child`, into a
column that holds eleven or more, so every load painted half the space its own
results were about to fill. The count is now taken once, above the branch that
chooses between them, by the hook that opens the list; the CSS cap is gone and
the skeleton has no default. A partial search is unchanged: there the count still
comes from the rows actually missing.

**The column is measured before the first paint.** The first answer used to be
scheduled on `requestAnimationFrame`, so the skeleton's first mount — and again
the arrival, which re-keys the panel on the incoming `searchJobId` — painted one
frame at the fallback: four bones in a column of eleven, and four cards in a
column that had already been measured for twelve. Inside a layout effect the DOM
is laid out, so the first measurement is taken synchronously and the frame is
kept only to coalesce the observer's later ones. The two columns are the same
box now that neither the skeleton nor the list reserves a strip beneath itself
— the pager that made them differ by 41px is gone (below).

**The results are one list that grows, not a run of pages.** **Owner-decided,
against the plates.** 04 §6 draws a pager in two forms and 1b gives it a strip
at the foot of the column; both are removed. A page is a promise about a fixed
amount of screen, and this column no longer makes one: it opens on what the
column fits, adds two columns' worth whenever the end of the window comes within
900px of the viewport, and never takes anything back. What that buys is the
strip itself — 41px on every armazón, which is most of a card on a phone — and
the gesture: reaching offer 40 of 520 is a scroll rather than four taps on a
26px cell. The weights survive the pager that motivated them, because the
question they answer survives it: `resultItemsFillingCapacity` still measures
the opening window in plain-card slots, since five items that happen to be
groups are eight slots and five that are flights are five.

The window is grown by an `IntersectionObserver` on a zero-height sentinel
rather than by the scroll handler already on the viewport: a handler fires on
every frame of every flick and each crossing is a state change, while the
observer fires once per crossing and the batch it renders pushes the sentinel
out of range until the reader keeps going. The prefetch margin is a column, not
a screenful, because a batch is a render and not a fetch — every offer is
already in memory when the job answers. On a desk the growth stays inside the
list's own scroller (`.fd-list-viewport`), which is what keeps the plates'
three-column workspace intact; the shell itself never scrolls.

11 §3's «cada filtro y cada orden devuelve la lista al principio» used to happen
as a side effect of landing on page 1. It is now said outright, keyed on the
view rather than on the offers, so the progressive batches that re-render this
list all the way through a search leave the reader where they were.

**These are frame-level facts, so the tests read frames.** The first version of
these cases fulfilled the search route instantly and asserted settled state,
which never observes the skeleton phase or the handover — the two moments that
were broken — and passed against a build that painted four bones every time.
The cases in `test/ui/results.playwright.ts` now delay the response and record
every distinct `bones/cards` pair the list paints, asserting on the sequence
rather than its last entry.

**The column ceiling is a guard, not a window size.** `RESULTS_COLUMN_ROWS_MAX`
was 12 because 12 was the fit of a 1440-tall desk when it was written; screens
grew and it became a cap. A 1920×1080 column fits 13 plain rows and a 1440-tall
one fits 19, so the ceiling left a row empty on the reporter's screen and seven
on a taller one. It is 20 — that 19 plus a row of slack. It bounds the bones and
the opening window; past it the list grows by scrolling like everywhere else.

**An offer is inside a group when its itinerary is, not only when its id is.**
`combinations[].offerId` trusts the provider to have listed every offer its own
group covers, and two things break that trust: a `truncated` group, where the
provider stopped enumerating combinations while the family kept its offers, and
one physical schedule quoted under two offer ids. Either way the list drew a card
whose legs the agent had just read inside the strip above it. Membership is now
also the canonical flight signature — every leg, its flight numbers, airports and
times, the identity `offer-signature.ts::buildOfferSignature` demands when a
quotation is revalidated.

**The fold stops at the fare.** Two offers on one schedule at two prices are two
things to sell, and folding the second away would take a price off the screen —
so the signature carries the currency, the amount and the baggage as well, and a
differently-priced twin stays an independent card even though its times repeat.
This is not a new opinion: `offer-schedule-groups.ts::groupKeyForOffer` already
refuses to put two offers in one group unless those same terms match. The browser
folds on exactly the bar the provider grouped on and never on a looser one. The
fold reads the already-filtered offers and is applied after the «a partially
filtered or stale group is not a group» rule, so a member the filters removed
cannot come back through it and an absorbed twin cannot revive an emptied group.

## Decisions that bind the backend

**One quotation composer.** `src/core/quotation.ts::buildCommercialQuotation()`
is the only place the commercial text exists. The UI and `POST /api/quotation`
pass `migrationPlan` to that same function; there is no second template in the
router or the component. The migratory switch regenerates the text locally from
that core over the already-revalidated offer, without a second provider call.

**The frequent-station ranking is one global row, written where it is read.**
The chips are the agency's ranking, not the browser's: `location_usage` is keyed
by `(role, code)` with no session in it, and the per-session strip is a separate
table that only ever feeds the panel's «Recientes». Two things make that true in
the split-service topology rather than by coincidence. First, the unit that
answers `GET /api/location-usage-suggestions` is the unit that counts the
search: the web unit records the route as it delegates `/api/search` and
`/api/matrix` to `fly-desk-search.service`, and the runner skips anything
stamped `x-flydesk-search-proxy: 1`, so an executed search is counted exactly
once and always in the store that serves it. Before this the counting happened
wherever the search *ran*, which is a process that never answers the ranking —
the row was global only for as long as two environment variables happened to
name the same file. A search the runner refuses (a 503 from a runner that is
down) is not counted; it is not a route the desk searched.

**A use counts for a month and then stops counting.** «La idea de mantener una
media es que el conteo expire en un mes, es decir si se buscó 30 veces el mes
pasado y este 10, y hay otro con 20 en el mes actual, entonces pasaría a segundo
puesto.» A running total cannot do that — an individual use cannot be taken back
out of one — so the count lives in `location_usage_daily (role, code, day,
uses)`, one row per station per day, and the ranking is `SUM(uses)` over the
last thirty-one UTC day numbers. A use recorded on day D counts for the whole of
day D and the thirty days after it, and stops counting when the day rolls past
that; rounding to the day is deliberate, so no card moves because a use turned
thirty days old mid-afternoon. Pruning deletes the days that left the window and
happens on the write path, which keeps the table bounded — the stations seen in
the window, times the days in it — and keeps the read every idle screen makes
read-only.

`location_usage` stays as it was: it owns `last_used_at_ms`, which is what the
reserved newest card reads, and `total_uses`, which is now the lifetime figure
and orders nothing. Nothing was seeded into the daily table from it, because a
total says how often and never when — dating MAD's 1425 uses to its
`last_used_at_ms` would drop the whole backlog onto one day and hand it the very
window it is meant to lose. The count therefore starts empty and refills from
live searches within hours.

**The last card of each role answers to recency.** Even a count that falls
admits nobody quickly: a station searched twenty times this month is a month of
searching away from a station searched once. That is the reported «una búsqueda
bastaría para agregar otro comodín, y probándolo no aparece». So the first slots
of each role are the live count (uses in the window, then last use, then code)
and the last slot is the station used most recently, unless it already holds one
of the slots above. One executed search — from any browser, any process —
therefore puts a new station on everybody's row at once, while the two stations
the desk really lives on keep the slots above it. At `limit < 2` there is no
reserved slot and the row is pure frequency. `getDiagnostics()` reports the
ranking as `rolling-window-uses-with-newest-card` alongside its
`rankingWindowDays`.

**Quoting always revalidates.** The first «Cotizar» calls `POST /api/quotation`
with the source search and offer ids. The endpoint only accepts a complete
stored offer — a matrix cell with a price but no real itinerary is not
quotable. A `validated`/`verified` fare is reused only within 15 minutes of
`priceVerifiedAt`; past that the endpoint asks the provider again and demands
the same canonical flight signature (legs, numbers, airports, times), so a
cheaper alternative on the same day and route cannot silently replace the chosen
one. The client accepts the answer only if it keeps the requested session and
carries a complete transport offer, a positive price, a currency,
`validated`/`verified`, a valid timestamp and non-empty text.

**`quotationPreparedAt` is local, `priceVerifiedAt` is the provider's.** The
first means the first local materialisation with everything needed to quote; it
is set once and preserved across re-materialisations. Only the second changes
when the quotation call succeeds. One shared constant fixes both the visible
15-minute warning and the reuse window. Cached SWR drafts drop
`quotationPreparedAt` so the UI never publishes a false age.

**Search ceilings come from the runtime.** `src/core/search-limits.ts` holds the
stay, passenger and lap-infant maxima; the HTTP contract validates against those
constants and `getPublicRuntimeConfig()` injects them into the page, which is
where the plinth's «hasta 90 noches · hasta 9 pasajeros» comes from. The backend
rejects stays over 90 nights and matrices over 5,000 combinations before any
provider work starts.

**Provider status is a closed surface.** `GET /api/provider-status` is
authenticated and `no-store`, and returns only canonical ids, a closed state, a
closed reason code and timestamps — never messages, URLs, tokens or provider
payloads. The tracker distinguishes `unknown`, `checking`, `ready` and
`degraded` with a five-minute TTL, and a fresh search observation outranks the
periodic prewarm. Prewarm can prove availability for Agil; for Click and Book
Plus it only proves local context, so only a real search marks it `ready`. A
logical 401/403/429/5xx inside an HTTP 200 propagates as a partial result and
leaves the tracker `degraded`, never `ready`.

The tracker is what the router consults while a search runs. Nothing in the UI
reads the endpoint any more: the last consumer was the idle plinth, and that
asymmetry — Agil provable by prewarm, Click and Book Plus only by a completed
search — is precisely why filtering the plinth by readiness was wrong.

**Data the cards need.** `faredDays`/`queriedDays` per month (absent on partial
results, so an under-sampled month never looks verified), the two next fares per
month, `fareMeta.seatsRemaining` (kept in the payload and never rendered: a
live Agil LATAM fare came back with a real `0` for a flight that was on sale,
and Click and Book Plus does not publish the field at all, so the one number the
card used to state was the one neither provider could stand behind —
`test/result-card-model.unit.test.ts` pins that the card names no seat count,
and the price-per-person line has the slot it used to take),
the operating carrier for codeshares, and per-leg duration and stops — the old
`comparisonMetrics.totalDurationMinutes` and `stopsCountForOffer` summed both
legs, which is why the pre-redesign card said «21h 05m · 2 escalas» for a flight
with one stop each way.

**`/api/results-layout` is gone.** The column-width editor existed to tune the
card grid; plate 1b closes that grid — `28 / 142 / 1fr / 36 / 116 / 26`, with the
duration lane fixed so the column header above can name it (rows above) — so
there is nothing to tune. Routes, types, persistence, helpers and the HTTP client were
removed and a negative test pins both methods at 404.

**A refused session write is owed, not retried.** The 180ms debounce in
`src/session-store.ts` is the only thing that schedules a write. When one fails,
nothing arms a retry of its own: the `persisted*` maps that decide what a write
owes are updated only after the transaction commits, so the whole diff — changed
rows and deleted ids alike — is still owed and the next mutation's debounce
carries it, with `close()` carrying whatever is left at shutdown. A retry timer
would spin every 180ms against a disk that is full or read-only without writing
a byte. What it costs is the stretch between a refused write and the next
mutation on an idle desk, during which the results are memory-only, so the
failure is now logged instead of swallowed.

**`SEARCH_COMPLETED_SESSION_TTL_MS` is a sweep threshold, not a storage
switch.** It is the age a finished job may reach before a sweep takes it. `0` is
therefore the shortest lifetime the sweep can express and not a `no-store`: the
job is stored the instant it is created, survives a sweep run at its own
timestamp, and is taken by the first sweep that sees a positive age — on a
running desk the 60s maintenance interval of `src/index.ts`, not the moment the
search ended. Reuse uses the same threshold, so at `0` a completed search is
never handed to a second request; only retention outlives the number. A
deployment that must not keep finished searches on disk says so by giving the
store no database.

## What is still missing

**Arbitrary leg recombination (plate 3b).** `SearchResponse.scheduleGroups`
publishes groups backed by native Agil or Click and Book Plus identity. Choosing
an outbound and an inbound independently requires the provider to have quoted
that exact combination; no fixture shows either provider able to recombine
freely, so the backend neither promises nor simulates it. Without a native
reference there is still no group.

What has changed is what counts as being *in* one. Membership was
`combinations[].offerId` alone; it is now that plus the canonical flight
signature, so an offer the provider did not list — or listed twice — is folded
into the group whose schedules it repeats rather than drawn beside it (see
«Decisions that bind the results column»). A lone alternative is still an
independent offer: what is no longer independent is an alternative that is not
lone.

**The gate transcribes the catalogues; it does not share them.**
`renderLoginPage()` in `src/web-auth.ts` is served before any bundle is
reachable, so it cannot import `frontend/src` and its values are copied by hand:
the tokens keep the names they have in `design-system.css`, so a value that
drifts shows up as a difference in a name and not only in a number. The gate
wears the title bar, the 52px field of 5b with its micro label, the "xl" button,
3d's focus ring and 11 §3's notice — plus the theme switch, which the old gate
lacked, so choosing the dark palette no longer requires already being past it.
`test/web-auth.unit.test.ts` pins the transcription; nothing keeps the two files
in step automatically.

**Shared Fly environment.** The three Fly units share one environment file and
the `fly-desk` identity. Splitting privileges or variables is platform work and
was not needed to wire these contracts.

## Verification

```powershell
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run build
bun run test
```

The responsive gate lives in `test/ui/responsive-smoke.playwright.ts` and covers
the desk, tablet and phone viewports end to end: idle and active, console
errors, global and inner overflow, results, filters, detail, both themes, and
visible initial focus. It reads the card's disposition off the list container
rather than the shell, and asserts the stops lane always has a box, which is the
regression that produced the stacking threshold above.

It samples three viewports, which is why the side-by-side leg row could starve
its lanes to zero from 980 to 1064 without the gate noticing: none of the three
lands there. The width sweep that would have caught it lives in
`test/ui/results.playwright.ts` («the card keeps a lane for the airport codes at
every width a desk can be») and walks thirteen widths across both sides of all
three thresholds.

Set `FLY_DESK_UI_CAPTURE_DIR` to have that gate write screenshots for a review
next to the plates.
