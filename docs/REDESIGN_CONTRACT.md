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
| 02 §2 puts the card's stacking threshold at a list width of 660 | 750 | The manual's own sum omits the card's `padding: 0 13` and its border. Measured against this card the legs track is exactly `list - 436`, so at 660 the stops lane is 224 against a stated minimum of 264: the column collapses to zero and the airport codes disappear, which §5 forbids and §4 says must be answered by stacking. 264 plus a 50px floor — the width the duration lane already uses — gives 750. |
| The plate sets the stacked schedule sub-grid gap at 6 | 4 | The plate never loaded Plex Mono 700, so its bold times were synthesised from 600 and kept the narrower advance. With the real face each time measures 42px and the row needs 126 inside a 124px lane. The next gap down keeps every width the plate pins (56/124/46, the 11px arrow lane, the 13px day lane). |
| The plate sets the stacked leg lane gap at 8 | 6 | Same correction, same cause, one level up. The stacked leg row has 301px; 56+124+46 and three gaps of 8 leave 51 for the elastic stops lane, and «1 esc · BOG» measures 54 — so the airport code that the whole 750 threshold exists to protect was the first thing the ellipsis ate. Three gaps at 6 return exactly the 6px that buys it and keep 56/124/46 intact. It also puts the row on the same 6 the stacked skeleton was already drawing its lanes with. |
| 8c abbreviates the stops lane but keeps the airports at every count | The stacked short form names the airports for one stop and shows the bare count from two | 57px holds «1 esc · BOG» (54) and nothing near «2 esc · PTY, MIA» (82) or «3 esc · PTY, MIA +1» (95). Cutting those to «2 esc…» hides the codes the abbreviation exists to preserve and adds a dangling ellipsis; the count alone says all of what it says. The desk long form is unchanged, the `title` still carries every layover, and the detail sheet names each stop. |
| 03 §5 reads "the plinth lists the available providers", and "listed = available" | The plinth lists the providers this deployment searches, always, with no state | Health was tried and it backfired: filtering by a live `ready` observation dropped Click and Book Plus from the idle screen entirely, because it cannot reach `ready` until a real search has answered. The rail is coverage — «Buscando en» — and a provider that fails a search is said in one line above the results (04 §8). `GET /api/provider-status` stays as an authenticated diagnostic surface with no UI consumer. |
| 02 §12 sets a 44px touch minimum for every square icon control on a phone | The two title-bar buttons stay at 36 | 02 §4 and the mockup both draw them at 36, and the mockup is the delivered source. Flagged rather than silently unified. |
| 11 §2.4 makes editing «`active` with the form back in its resting anatomy», which the mockup draws with the mode and trip segments back above the fields | The segments have two positions and no third: above the form at rest, centred in the title bar for as long as a search exists | Editing is reached by clicking a field, so the inverse FLIP fired on the most ordinary gesture there is and the segments jumped out of the bar and back into the form each time. Nothing about the *mode* of the search is being edited when a date is retyped. On a desk the form is already whole in the active state, so this leaves editing with nothing to move — which is the point. |
| 03 §8 puts the policy lines «al pie del reposo» | They were the last child of the form; they are now a slot the stage owns, below the lower spacer and above the provider rail, at the form's 1180px measure | Inside the form they were not at the foot of anything: they sat between the fields and the notice those fields produce, so a paragraph naming the allowed window was read *above* the error about the date just typed. The rail drops its own `border-top` when they are present, so the foot opens with one rule instead of framing the line in a box no plate draws. |

Only the result card asks the list container (`fdlist`); the pager, the
migratory grid and the card cascade answer the shell (`fdshell`) at 719.98,
because the master table describes them as desk-versus-phone shapes.

## Decisions that bind the backend

**One quotation composer.** `src/core/quotation.ts::buildCommercialQuotation()`
is the only place the commercial text exists. The UI and `POST /api/quotation`
pass `migrationPlan` to that same function; there is no second template in the
router or the component. The migratory switch regenerates the text locally from
that core over the already-revalidated offer, without a second provider call.

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
month, `fareMeta.seatsRemaining` (a real `0` shows as «0 asientos»; Click and
Book Plus does not publish the field and it stays absent rather than invented),
the operating carrier for codeshares, and per-leg duration and stops — the old
`comparisonMetrics.totalDurationMinutes` and `stopsCountForOffer` summed both
legs, which is why the pre-redesign card said «21h 05m · 2 escalas» for a flight
with one stop each way.

**`/api/results-layout` is gone.** The column-width editor existed to tune the
card grid; plate 1b closes that grid at `32 / 186 / 1fr / 116 / 26`, so there is
nothing to tune. Routes, types, persistence, helpers and the HTTP client were
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
publishes groups backed by native Agil or Click and Book Plus identity, and the
UI treats `combinations[].offerId` as the only source of membership. Choosing an
outbound and an inbound independently requires the provider to have quoted that
exact combination; no fixture shows either provider able to recombine freely, so
the backend neither promises nor simulates it. Without a native reference there
is no group, and a lone alternative stays an independent offer.

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
regression that produced the 750 threshold above.

Set `FLY_DESK_UI_CAPTURE_DIR` to have that gate write screenshots for a review
next to the plates.
