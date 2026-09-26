# Current Repository State

## Summary

Fly Desk is a private web application for travel agents. The active runtime is Bun-only: Bun installs dependencies, runs the backend, builds the React UI, serves the HTTP BFF, and uses `bun:sqlite` for local or VPS caches.

The repository does not version generated artifacts:

- `dist/` is ignored
- `frontend/dist/` is ignored
- `output/` is ignored

## Current Product

### React UI

- exact search
- flexible one-way search through the `stay-range` range
- flexible round-trip search through `/api/matrix`, normalized into a results list
- monthly migratory search: selection of up to twelve months from the minimum date, including across year boundaries, with fan-out only for selected months
- origin and destination autocomplete with an explicit `CITY`/`AIRPORT` discriminator when the provider supplies it
- up to three recent origin/destination suggestions per opaque browser session (30-day TTL), plus three frequent suggestions from one global ranking: uses within a rolling 30-day window, with the last card kept for the station used most recently; the backend records a route when it accepts a search
- month cards with complete-only queried/fared-day coverage and retained real alternatives
- a search writes its own parameters onto the address bar, so the URL of a workspace is the link that describes it. Opening such a link runs the search it carries, once — but only an `exact` one whose route and dates the form would itself accept: a sweep costs many searches and is not started from a pasted URL, and a flexible search, or an incomplete, impossible or already-past date, arrives in the form with the sentence that explains it. `?job=` wins over both, having results to read rather than a search to pay for. The tab that wrote a URL remembers it (`sessionStorage`, `frontend/src/lib/search-share.ts`), so reloading is not opening a link: the form comes back filled and waits. The page exit already cancels the running search with `cachePartial=1` rather than let it be paid for twice, and re-running it on the way back in would undo that
- an idle provider rail that names the providers this deployment searches, always and without health copy; readiness stays on the authenticated `/api/provider-status` surface, which the router uses internally and no UI consumes
- filters for stops, maximum layover time, baggage, and airlines
- four orders — price, duration, departure and stops — closed in one catalogue, `SORT_MODES` in `src/core/types.ts`, which is what the request is validated against (`resolveSortMode`), what `sortOffers` applies, what discriminates the search-job cache, and what the UI and the shared link both read their union from. The criterion travels in the `POST /api/search` body and the backend is what orders. Departure is the departure of the **first** leg, which on a round trip is the outbound and never the return; stops is the count across every itinerary. Both break their ties by price and then by date and the offer id, so two runs of one search give one list — an order that stopped at the primary key would come back in whatever sequence the two providers answered in
- the order the agent chose is a way of reading the list, not a property of one search: it persists across searches and price is the default only until something has been chosen, it rides the workspace link and the session's workspace preferences, and it is applied a second time on the client because what the list draws is the backend's answer filtered by the rail, with revalidated offers swapped in and a sweep's months folded to one row each. That second pass calls the backend's own comparator, `compareOffers` from `src/core/ranking.ts`, so the two surfaces cannot disagree about one list
- one continuous list of results, with backend warnings: it opens on what the column measures and grows by two columns whenever the end of the window comes within 900 px of the list viewport, inside that viewport's own scroller on every layout. There is no pager and no page state; a filter or a sort returns the list to its first row, a provider answering does not
- the results viewport (`.fd-list-viewport`) owns the list's scroll and holds the zero-height sentinel the window grows from; it draws no scrollbar on desk or phone
- on a phone the title bar is drawn at rest only: once a search exists it is hidden and its copy action is rehoused at the right end of the filter row, which is 48 px of screen returned to the list
- per-person price only for all-adult groups; mixed adult/child/infant searches
  keep the provider total until a real passenger-type breakdown exists
- side panel with price, known baggage/conditions, purchase paths, and exact-flight provider-revalidated quotation through the shared quotation core; verified prices are reusable for at most 15 minutes
- a station on the itinerary is named by its IATA code and not by the provider that sent it: the shared catalogue in `src/core/location-display.ts` decides, and a code it does not know keeps the provider's own name with the facility words («Aeropuerto», «International») removed, so two providers describing one runway read alike. The catalogue names the city rather than the airport — `EZE` and `AEP` are both «Buenos Aires» — and covers what a Lima desk sells and connects through: Peru's network, Latin America, and the North American and European gateways. It is read by the commercial quotation too, so only certain codes go in and a missing one falls back to the letters
- carrier marks: `AIRLINE_LOGO_CODES` in `src/core/airline-assets.ts` is what the release *bundles* (one PNG each under `frontend/public/assets/airline-icons`, added with `bun run airline-icons:extract <codes>`), not what can be drawn. A code with no bundled file is fetched once from the provider CDN by `src/airline-mark-store.ts`, checked as a square PNG within bounds, written under `FLY_DESK_AIRLINE_MARK_DIR` (the app data directory) and served from there for ever after; a code with no artwork anywhere answers `404` and the card draws its two letters. The harvest happens when the image is requested, never during a search, once per code, with a day-long negative window and one fetch shared by every card asking at once

The React UI must not display simulated controls. The following remain outside the visible interface:

- multi-city search
- dedicated calendar/matrix view
- `reprice`

### Loading Feedback

- every search mode publishes its partial results as they resolve, on a trailing schedule: at most one flush per 900 ms, and only on geometric milestones (1, 2, 4, 8…), so the seven GDS replies of an Agil exact search are three publications, not seven
- polling: `GET /api/search/:id` and `GET /api/matrix/:id` accept `wait=<ms>` (clamped to 20 s) with `sinceRevision` and hold the response until the job moves, so the UI long-polls with `wait=15000` and re-polls 50 ms after each answer, falling back to 900 ms only against a server that answers `unchanged` immediately
- a list that is still growing wears the «Parcial» pill, a sweep counts its months still «buscando», and a month card still loading wears «Actualizando»; the final state is published at once, and cards keep a stable DOM identity
- a provider that answered part of a search is named in the desk's one line, «Resultados incompletos · Agilsmart respondió en parte», with the rest of the list kept; one that answered no part of it is named as a provider that is down, «Agilsmart no respondió». With every provider failed the line reads «No se pudo consultar a ningún proveedor» and the column says «No se pudo consultar a los proveedores»
- quotation: the first action calls `/api/quotation`, accepts only a validated/verified offer with `priceVerifiedAt`, and uses the returned commercial text; the immediate migratory toggle then runs the same shared compositor over that verified offer
- a search waiting for capacity says so in the desk's one line, «En espera · Tu búsqueda empezará en cuanto haya un cupo libre», until it starts (a sweep, while none of its months has started); it is never refused for capacity
- the title bar carries a capacity meter (`frontend/src/hooks/useSearchCapacity.ts`): a gauge and «3/7», the cupos the searches in progress hold out of the most that can run, in ink while a search runs and in the «En espera» line's colours, with a clock, while one waits, and a Spanish name and value («4 de 7 cupos en uso · 2 búsquedas en curso · 1 en espera») that never say which search holds how many. It long-polls `GET /api/search-capacity` (held up to 25 s, answered at once when the version moved), stops while the tab is hidden and reads at once when it is shown, goes blank when the capacity cannot be read, and does not slide the session
- the idle search frame reserves the ranking-card geometry before the global response arrives; search notices render below without recentering the form in idle or active layouts, while the intentional idle-to-active transition remains animated

## Runtime, Security, and Dependencies

### Private Web Application

- the server listens on `127.0.0.1` by default
- in production it remains behind Caddy with `HOST=127.0.0.1`
- `FLY_DESK_WEB_AUTH=1` enables web login with a signed httpOnly cookie
- the session cookie slides: an authenticated request more than halfway through
  `FLY_DESK_WEB_SESSION_TTL_SECONDS` (default 12 h) re-issues it, so the window
  measures inactivity rather than time since the sign-in, and earlier requests
  write no `Set-Cookie`. `FLY_DESK_WEB_SESSION_MAX_LIFETIME_SECONDS` (default
  7 days) caps it from the sign-in itself and the sliding never passes it
- the payload is `v2.<issuedAtMs>.<expiresAtMs>.<nonce>.<signature>`, all of it
  signed; a cookie in any other shape is refused
- an unauthenticated `GET /` redirects to `/login?next=<path+query>` and a `401`
  from `/api/*` sends the browser to the same place, so a shared search link
  survives the gate; `next` is accepted only as a path on this origin
- login admission retains at most five failures per validated client in a
  15-minute window, returns `429` with `Retry-After` before scrypt on further
  attempts, expires old failures, and resets only the successful client
- Pages overwrites the login client IP from Cloudflare's initial request; Bun
  accepts that value only through a loopback peer after IP validation, ignores
  ordinary forwarded headers for admission, and caps the map at 1,024 clients
- `FLY_DESK_TRUST_LOOPBACK_CLIENT=0` is mandatory when a local reverse proxy is present
- `FLY_DESK_TRUST_REVERSE_PROXY_LOOPBACK=1` must be used only if the local proxy also blocks or authenticates local-only routes; by default, requests with `x-forwarded-for`, `forwarded`, or `x-real-ip` do not inherit loopback trust
- operational endpoints, `/api/diagnostics` included, accept a valid web cookie, `FLY_DESK_API_TOKEN`, or a loopback client trusted as above
- public geofencing belongs to `grumitos/vps-platform`: requests from outside Peru are refused before they reach Fly Desk
- the date policy moves with `minSearchDate = today` and `maxSearchDate = today + SEARCH_MAX_FUTURE_DAYS`
- round-trip stays are limited to 90 nights, searches to nine passengers, lap infants to one per adult, and fixed-range fan-out to 5,000 combinations; the public runtime exposes the same limits

### Supply Chain

- supported package manager: Bun (`packageManager: "bun@1.4.2"`)
- lockfile: `bun.lock`
- `bunfig.toml` disables lifecycle scripts during installation, filters versions published less than three days ago, and disables install-on-import
- a release installs no packages: the runtime imports only Bun and Node built-ins, every dependency is a development one, and `deploy/prepare-release.sh` refuses runtime `dependencies`. Playwright serves the end-to-end suite and the Click and Book Plus browser fallback on a workstation; the Agil session is read from Chrome over the runtime's own DevTools client
- `patches/bun-plugin-tailwind@0.1.2.patch` removes the plugin's `bun >= 1.0.0` peer, which would pull the npm `bun` package, about 350 MB of platform binaries, into every install; the runtime is the system Bun and the lockfile does not resolve that package
- TypeScript 7 (`@typescript/native`) runs the typecheck; `typescript-eslint` uses TypeScript 6 as a development API, because TypeScript 7 publishes its programmatic API only under `./unstable/` and `typescript-eslint` does not support TypeScript 7 ([#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)). The split ends when both of those change, and not before. The native compiler runs the three-step `typecheck` in about 2.5 s against about 16 s for the TypeScript 6 JavaScript build. The one cost of the split: the editor's `tsserver` resolves the frontend's TypeScript 6 while the gate runs 7, so an error can in principle appear in one and not the other
- `.npmrc` sets `ignore-scripts=true` as protection against accidental npm/pnpm installations
- pnpm is not a normal workflow: the repository is Bun-only and has no `pnpm-lock.yaml`
- any dependency that requires installation scripts must be approved through `trustedDependencies` with a note in the change

### Providers

- Agil mints its bearer over plain HTTP from a persisted identity (`agil-identity.json` under the state directory, path override `AGIL_IDENTITY_PATH`); the Chrome profile is consulted only to bootstrap that file when it is absent or the identity is refused. The subscription key comes from the environment or is recovered from the Agil bundle; Linux/VPS defaults to the loopback CDP endpoint on port 9222, explicit browser endpoints win, and Windows keeps discovery explicit
- Click and Book Plus uses environment-controlled context, a host allowlist, and optional B2B warm-up; B2B automation accepts only HTTPS on the exact `b2b.clickandbook.com` origin and rechecks same-origin navigation before entering credentials or OTP
- Click and Book Plus does not accept hosts, base URLs or tokens per request; a search job keeps no token, so every search it runs, a quote's revalidation included, reads the one configured at that moment, and a cached list seeds a new search whatever token it was found with
- a Click and Book Plus payload status of 400 or more inside an HTTP 200 fails
  the provider like an HTTP error: the job marks it `failed`, the desk names it,
  and the tracker leaves it `degraded` rather than `ready`. A refused token or
  agency (401, 402, 403) is refused for every date, so a range or a matrix
  stops asking at the first refusal and fails the provider; other statuses
  fail only their day or cell there
- a provider request that fails before any answer arrives (Bun's connection
  pool can hand out a connection the far end has just closed) is sent once
  more, on a connection of its own and within the deadline it already had
  (`AGIL_HTTP_TIMEOUT_MS`, `CBPLUS_HTTP_TIMEOUT_MS`, and
  `CBPLUS_REDIRECT_VERIFY_TIMEOUT_MS` for the redirect validation): every Agil
  request, and the Click and Book Plus flight search (a quote's revalidation
  included), engine metadata, station lookup and redirect validation, none of
  which changes anything at the provider (`src/provider-fetch.ts`). The Click
  and Book Plus B2B sign-in is never sent twice. An answer, an error status
  included, and the deadline are final. A GDS or a matrix cell still left out
  is logged with the request and the error behind it
- a provider that completes without part of what it was asked (an Agil GDS, a
  day of a range, a matrix cell) completes `partial`: its diagnostics in the
  job say so, and the desk's one line names it as a warning, «Resultados
  incompletos · Agilsmart respondió en parte», with the rest of the list kept.
  A migratory sweep's line reads its months the same way: a provider that
  failed a month or answered one in part, and answered another, answered the
  sweep in part
- a provider none of whose parts answered (no GDS of an exact search, no day
  of a range, no matrix cell) has failed: the job marks it `failed` with its
  public reason, and the desk names it as it names a provider that is down,
  «Agilsmart no respondió». An error status from an Agil GDS is a GDS that
  failed, in a matrix cell as in an exact search
- silent provider prewarm is enabled by default and can be disabled with `FLY_DESK_PROVIDER_PREWARM=0`
- provider searches must run in the dedicated runner when `FLY_DESK_SEARCH_SERVICE_URL` is configured; within the runner, `FLY_DESK_SEARCH_WORKER_PROCESSES=1` keeps providers in child processes
- with `FLY_DESK_SEARCH_WORKER_POOL=1` (default) those child processes are a pool of one long-lived worker per provider, started with the runner, run with Bun's small heap (`--smol`, which gives back what a month of fares took), multiplexing jobs by id over stdin/stdout, cancelled per job, recycled once idle after `FLY_DESK_SEARCH_WORKER_MAX_JOBS` (default 500) jobs, and respawned on death; the prewarm loop warms the pooled workers, not the runner, so the Agil bearer, the Click and Book Plus engine metadata, and provider TLS connections survive between searches. `FLY_DESK_SEARCH_WORKER_POOL=0` starts one cold worker per provider per search instead
- an Agil exact search fans out over its seven GDS ids in one wave (`SEARCH_PROVIDER_SUBREQUEST_CONCURRENCY` and `AGIL_GDS_SEARCH_CONCURRENCY` default to 7; `AGIL_GDS_SEARCH_CONCURRENCY=4` asks them in two waves), and the progressive mapping only maps newly resolved groups; `/mv/search` calls share a process-wide in-flight ceiling (`AGIL_MAX_INFLIGHT_SEARCH_REQUESTS`, default 32, never below 7); Click and Book Plus requests its engine metadata in parallel with `searchFlights`
- production keeps `FLY_DESK_SEARCH_WORKER_PROCESSES=1` with the pooled workers; `0` is a temporary QA exception only. Repeat external QA — exact, stay-range, roundtrip grid, a week-long range and a mid-flight cancel, after a runner restart and after the pooled prewarm — before changing worker counts, the runner, or warm-up
- every public search waits for Agil and Click and Book Plus and retains all offers returned by both; visible filters are materialized without trimming `allOffers`, and concurrency limits regulate only batch requests
- a fresh offer receives `quotationPreparedAt` once, when it first contains the data required for local quotation; cached SWR drafts remove that marker until fresh data is ready. It is distinct from provider revalidation in `priceVerifiedAt`
- Agil exposes list-seat availability when the provider returns a valid integer; Click and Book Plus exposes no equivalent quantity, so Fly Desk leaves it absent
- both normalizers preserve explicit operating-carrier metadata for codeshares
- both normalizers leave carrier and flight number empty when the provider omits them; the UI also hides baggage without explicit inclusion/exclusion evidence
- `scheduleGroups` contains only provider-native, response-scoped alternatives and references existing offer IDs; the UI uses those IDs as its only group membership and arbitrary per-leg recombination is not synthesized
- provider readiness uses closed states and reasons; search evidence outranks fresh prewarm evidence, and Click and Book Plus context-only warm-up cannot claim readiness. An observation stays fresh for two prewarm intervals plus a minute (21 minutes by default), or five minutes with prewarm off
- the USD/PEN rate available from Agil propagates to sibling offers; if a domestic Costamar route remains alone, daily rate resolution occurs within the search and does not query flights again
- external rate lookup has a short timeout and allows one final retry after a failed prefetch; if unresolved, the search finishes without marking the offer quotable
- search admission shares 7 capacity units in the runner (`src/search-admission.ts`, measured values with no settings): an exact search costs 1, a flexible round-trip matrix or a range of up to ten days 2, a range of up to a month 3, and a longer range everything heavy work may hold. Heavy work (anything but an exact search) holds at most 5 units, so two units always start an exact search at once — one for each agent — and two month-long ranges, a sweep's months included, never run together. A search that does not fit waits and is never refused for capacity; its job says `queued` until it starts. Exact searches start first-come, first-served, and past their reserve only while no heavy search waits; heavy searches start fairest session first (the signed-in browser holding the fewest heavy units, then the one served longest ago), each session's own in order, and a heavy search that does not fit yet is not overtaken by another heavy one. Where the unit's cgroup (v2) can be read (`src/unit-memory.ts`), memory has the last word: a heavy search starts beside other heavy work only while the anonymous memory of the runner and its workers, or what the running heavy searches are expected to reach (20 MiB a day of a range, 60 MiB for a matrix), leaves room under 90% of `MemoryHigh` for what it is expected to add; alone, a heavy search always starts. `GET /api/search-capacity` answers the occupancy
- the web proxy streams the runner response without buffering the complete body and keeps its timeout during the stream: `FLY_DESK_SEARCH_SERVICE_TIMEOUT_MS`, 15 s by default and never less, at most 60 s. Every request to the runner goes out on a connection of its own, so none is sent on a connection the runner is closing. A read the runner refuses while it restarts is asked once more 500 ms later; a write is never sent twice
- capacity is released once, when a job's provider work settles; a stopped job leaves the queue at once, or has its provider requests aborted in the workers (the job's abort signal reaches `fetchProvider` and the Agil in-flight queue) and sends none again. Session and purchase-path caches remain in `src/session-store.ts` until their operational TTL
- the price-reuse TTL is anchored to `searchMeta.completedAt`, not polling; session idle retention remains separate to preserve redirects
- completed resident jobs share 32 MiB by default, counted in their persisted bytes: a month of a sweep persists as 32 MiB and holds about 119 MiB of heap, so about one month stays resident, and an eviction that large is followed by a garbage collection; a timer reevaluates LRU when the five-second grace expires, in addition to 60-second maintenance, leaves excess jobs disk-only with compatible APIs and `/r/<id>`, and deletes them at TTL expiry. Running jobs are not eligible
- a list of 2,000 offers or more is written to its poll's answer a batch at a time instead of serialized whole, and a job that long is followed by a garbage collection once its final list is built: a month of a sweep is 28 MiB of JSON, and building it whole took the runner about 150 MiB at once
- range/matrix deltas travel from worker to router without resending accumulated state; RAM, polling, and SQLite publish snapshots at geometric milestones coalesced for 900 ms, plus durable completion. Purchase paths persist independently to keep redirects visible between milestones
- matrix HTTP and SQLite payloads retain only cells with an offer, price, or redirect and omit empty placeholders; cell updates use an O(1) index and aggregation across providers is O(P·N)
- the frontend never turns a price-only matrix cell into a synthetic flight offer
- the quotation endpoint also refuses price-only matrix cells, and HTTP/frontend transport normalizers require positive price, currency, and complete real itineraries (including outbound plus inbound for round-trip) instead of filling them from the request
- matrices persist compact request/context data for redirects; older rows retain a compatible fallback to the complete payload
- with `FLY_DESK_SEARCH_SERVICE_URL`, the web process does not open the session SQLite database for autocomplete or preferences; the lazy getter reserves that restoration for the runner, `/r`, quotation, provider status, or diagnostics that actually need it
- cancellation from the UI («Detener», or a new search replacing the one in the same tab) or `pagehide`/`beforeunload` changes the remote job to cancelled, and a running job nobody long-polls for `FLY_DESK_SEARCH_JOB_LEASE_MS` (90 s by default, above the minute a background tab's timers may wait plus a poll's 20 s) is stopped the way a closed page stops it, its results kept: that frees the search of a page that went silent — a lost network, a laptop asleep, an expired session — and a queued search nobody waits for. Every stop aborts the job's provider requests in its workers and releases its capacity once; orderly process shutdown stops new admission and lets active work finish for up to three seconds while the HTTP side keeps serving, then cancels unfinished jobs, first forcing the last pending delta and requesting a partial cache, so a page following a job reads what it found and why it stopped. The pooled workers, signalled with the unit, keep running their jobs until the runner stops them (six seconds at most), so a restart is never recorded as a provider failure
- external links continue through `/r/<id>` as a local purchase-path cache; Agil redirects without an intermediate page, while Click and Book Plus first verifies HTTPS, an allowed origin, and the exact search pathname, then validates or refreshes the query-string token before `302` without persisting or logging the resolved URL
- `/r/<id>` has one resolver, `routeRedirectRequest` in `src/redirect-service.ts`. In production the platform routes `/r/*` to `fly-desk-redirect.service`, a separate Bun process that reads the same session SQLite database, and a single-process run answers it from `src/server.ts` with the same function; browsers authenticate with a distinct HttpOnly cookie scoped to `/r`, while the main web cookie and bearer credentials stay outside the redirect service

## Functional Structure

### Frontend

- `frontend/index.html`: HTML/React shell used by the Bun build
- `frontend/public/`: favicon and static assets copied to `frontend/dist`
- `frontend/src/main.tsx`: React entry point
- `frontend/src/App.tsx`: main composition, filters, selection, and responsive layout
- `frontend/src/components/`: `TopBar`, `SearchShell`, `ResultsPanel`, `DetailPanel`, and UI components
- `frontend/src/components/results/`: `ResultCard`, card model, CSS, migration coverage, and schedule alternatives
- `frontend/src/hooks/`: `useSearch`, `useAutocomplete`, `useShellSize` and `useOverlayHistory`
- `frontend/src/lib/api.ts`: HTTP client, search/polling, matrix, migratory search, autocomplete, and quotation
- `frontend/src/lib/location-usage-suggestions.ts`: HTTP client for per-session recent and global frequent locations
- `frontend/src/lib/browser-client-session.ts`: opaque `sessionStorage` identifier used only for recent-location isolation
- `frontend/src/lib/providers.ts`: canonical provider metadata and strict public-status normalization
- `frontend/src/index.css`: colour tokens, light/dark themes, and layout; `frontend/src/design-system.css` holds the type, geometry, icon, stacking and motion catalogues, and `frontend/src/components.css` the component styles
- `scripts/build-frontend.ts`: build with `Bun.build` and `bun-plugin-tailwind`, the self-hosted fonts, and a copy of `frontend/public`

### Backend

- `src/server.ts`: `Bun.serve`, `frontend/dist` serving, headers, body limit, and runtime configuration injection
- `src/redirect-service.ts` and `src/redirect-index.ts`: dedicated `/r/<id>` resolver from the SQLite cache, independent of the main runtime for provider clicks
- `src/http-router.ts`: HTTP routes, web/loopback/token authentication, jobs, matrix, quotation, provider status, and diagnostics
- `src/login-admission.ts`: bounded per-client failed-login admission before password derivation
- `src/web-auth.ts`: web password, signed cookie, session validation and sliding renewal, and the same-origin check on the post-login return path
- `src/core/quotation.ts`: shared quotation rendering; by default it preserves the local time encoded by each segment
- `src/core/quotation-parser.ts`: bounded pasted-quotation contract with field/line trace and no inherited price/default filters; the clipboard paste flow in `frontend/src/App.tsx` opens its reconstruction in `QuotationPastePreview`, from which the agent reviews or launches the search
- `src/core/offer-schedule-groups.ts`: provider-native schedule group contract without synthetic combinations
- `src/core/search-limits.ts`: canonical stay, passenger, and lap-infant limits shared by validation and public runtime
- `src/search-date-policy.ts`: moving date window and embedded public configuration
- `src/provider-context.ts`: Click and Book Plus context, host allowlist, the token file, and token candidates read from Chrome
- `src/provider-fetch.ts`: one deadline per provider request, and the one resend of a request that got no answer
- `src/local-agil.ts`: identity, session read over DevTools, token refresh, exact/range/matrix search, pricing, and deep links
- `src/local-costamar.ts`: autocomplete, exact/range/matrix search, branded links, and Click and Book Plus B2B warm-up
- `src/providers/costamar/search-payloads.ts`: Click and Book Plus payloads; `costamar` remains as a legacy internal alias
- `src/core/`: normalization, matrix, grouping, ranking, quotation/parser, and shared types
- `src/search-service-client.ts`: loopback proxy for search/matrix/polling/cancellation, quotation, and provider status to `fly-desk-search.service`
- `src/search-worker-client.ts` and `src/search-worker.ts`: Bun child processes for heavy provider searches within the runner
- `src/session-store.ts`: live jobs, cache freshness, resident budget, local SQLite, redirects, and purchase paths
- `src/location-suggestion-cache.ts`: SQLite autocomplete cache with TTL plus query/session/global bounds, which also names the stations of the recent and frequent history without calling a provider
- `src/location-usage-store.ts`: one global station ranking (uses within a rolling 30-day window for the leading cards, newest station for the last one) plus bounded, expiring recent locations per browser session; the web unit counts the searches it delegates, so the ranking is written in the store that serves it
- `src/provider-status.ts`: in-memory closed/sanitized provider readiness tracker
- `src/runtime-paths.ts`: persistent fallback based on `FLY_DESK_APP_DATA_DIR` for SQLite caches when no specific `*_DB_PATH` is set

### Operations

- `scripts/build-frontend.ts`: frontend build
- `scripts/extract-airline-icons.ts`: adds bundled carrier marks (`bun run airline-icons:extract <codes>`)
- `scripts/generate-web-password-hash.ts`: generates the scrypt hash from a
  hidden terminal prompt or controlled standard input and rejects plaintext
  arguments and environment input
- `scripts/run-e2e.ts`: runs the end-to-end spec files in parallel
- `scripts/pack-release.sh`: the deterministic release artifact of a revision
- `scripts/release-smoke.ts`: unpacks an artifact, prepares it as the platform does, and boots web, search and redirect from it
- `deploy/prepare-release.sh`: the prepare hook the platform runs in a release, which checks that it installs nothing
- `deploy/release-capabilities`: what the release declares to the platform, one capability a line; today `cbplus-token-file`, the token file re-read without a restart ([`DEPLOY_APP.md`](./DEPLOY_APP.md), "Release Capabilities")
- `.github/workflows/ci.yml`: CI for typecheck, lint, build, and the release smoke, with the end-to-end suite in a parallel job
- `.github/workflows/deploy-vps.yml`: manual deployment and rollback by exact SHA through the fixed platform release wrapper; a deployment builds, packs and smokes the artifact

Shared VPS infrastructure lives in `grumitos/vps-platform` (`D:\Dev\VPS\vps-platform`): Caddy, systemd, Caddy rollback, and the platform plan. This repository owns the application, CI, revision deployment, and release rollback ([`DEPLOY_APP.md`](./DEPLOY_APP.md)).

After an application deployment that affects search, cancellation, or redirects, finish verification with `Fly Desk Production Smoke` in `vps-platform`. That workflow checks local web/search/redirect health, a completed search, `/r/*` for Agil and Click and Book Plus, cancellation of a second search, and active services.

## Tests

The gates a change must pass are listed once, in [`AGENTS.md`](../AGENTS.md), "Verification".

The suite is end to end: `test/e2e/*.e2e.ts` runs the web unit, the search runner with its pooled workers, and the redirect service on loopback behind a Caddy-like proxy, against fake provider upstreams, and drives the desk in Chromium. A Bun preload in every process of the stack sends provider traffic to the fakes and blocks anything else. There is no unit suite; the release artifact itself is smoked by `scripts/release-smoke.ts`. What each spec file covers, how the suite runs and how to write a test are in [`TESTING.md`](./TESTING.md).

## Documentation

The index of this repository's documents is in [`README.md`](../README.md), "Current Documentation".

## Deployment State

`main` is the product and deployment line. The workflow accepts only an exact SHA reachable from `main`, publishes an artifact with a digest, and delegates activation/rollback to `/usr/local/bin/vps-release-fly-desk`. The platform keeps immutable releases, switches `/opt/fly-desk` atomically, restarts web/search/redirect, validates their health checks, and restores the previous current release if activation fails.

Deployed revisions and the live service inventory are maintained in `D:\Dev\VPS\vps-platform\docs\INVENTORY.md`. This repository does not keep production SHAs as live state, avoiding documentation drift.

## Current Technical Debt

- `SEARCH_RANGE_SEARCH_CONCURRENCY` defaults to 3 days of a range at a time.
  Admission runs one month-long range at a time, and against the fakes a
  two-month sweep took 48.9 s at 2 days, 33.4 s at 3 and 28.6 s at 4; 4 raised
  the search unit's peak by about 100 MiB, and 3 keeps 21 of the 32 Agil
  requests in flight, leaving room for the other agent's exact search. Real
  providers have not been measured at it; after the deployment, watch a
  sweep's months and the Agil answers. The intermediate milestone coalescing
  is 900 ms in `src/http-router.ts` and could drop to about 400 ms if the UI
  benefits. Change one at a time and keep the measurement
- `frontend/src/App.tsx` concentrates substantial composition, filtering, and selection
- `src/local-agil.ts` concentrates session handling, client behavior, pricing, and mapping
- `src/local-costamar.ts` concentrates B2B automation, client behavior, mapping, and Click and Book Plus redirects
- persistence is local SQLite; there is no external store for multiple instances
- session SQLite uses WAL, `synchronous=NORMAL`, and a five-second busy timeout; a refused write is owed to the next mutation's debounce (with `close()` carrying the remainder) rather than retried on a timer, and is logged. This is explicit policy, recorded in [`REDESIGN_CONTRACT.md`](./REDESIGN_CONTRACT.md)
- `SEARCH_COMPLETED_SESSION_TTL_MS` is a sweep threshold, not a storage switch: `0` is the shortest expressible lifetime, taken by the first positive-age maintenance pass, never a synchronous `no-store`. Recorded in [`REDESIGN_CONTRACT.md`](./REDESIGN_CONTRACT.md)
- a provider failure's reason — for the readiness tracker and for the desk's
  short form — is read from the error's message by pattern, not carried as a
  typed cause across every provider/worker transport; throttling has no reason
  of its own. A typed cause would be a separate contract decision
- persistent Chrome CDP is covered by `fly-desk-chrome.service`; Agil needs the session in that VPS profile only to bootstrap `agil-identity.json` — once the file exists, cold starts mint their own token without the browser, and the file can also be seeded from a logged-in maintainer browser (see [`AGIL_SESSION_RECOVERY.md`](./AGIL_SESSION_RECOVERY.md))
- all three Fly application units share `/etc/fly-desk.env` and the `fly-desk` identity; separating least privilege would be a platform change, and this product's wiring does not justify it
- disk-only legacy session rows outside the restore budget may retain historical raw provider URLs until they are restored or expire; current writes and restored paths are sanitized, and no bulk migration exists without an operational requirement
- Click and Book Plus fixtures do not expose seat quantity, and neither provider contract proves arbitrary per-leg repricing; the UI must continue omitting those claims
- Click and Book Plus fixtures do not prove that a Cartesian product of journey
  options is sellable, nor whether native recommendation IDs may contain `:`;
  keep publishing only native quoted combinations until authorized evidence
  closes those assumptions
- there is not enough provider evidence to classify Agil
  `rawRefs.webSessionId` as a reusable secret; it remains inside the existing
  backend boundary and must not be exposed to the UI
- the mobile plates are built: one shell with three layouts at the 720 and 1100 frontiers, the merged origin/destination card, the retractable toolbar, and filters, calendar, suggestions, passengers, month picker and offer as bottom sheets. Arbitrary per-leg recombination is the one design promise still unmet, because no provider fixture supports it — see [`REDESIGN_CONTRACT.md`](./REDESIGN_CONTRACT.md)
- migratory search queries every day in every selected month against Agil and Click and Book Plus without fare filters. The desk asks for `FLY_DESK_MIGRATION_CONCURRENT_MONTHS` months at once (default `2`, at most `12`), each once the one before it has its job, and the runner starts one month-long range at a time: the second month waits ready, and a larger value only adds waiting jobs
