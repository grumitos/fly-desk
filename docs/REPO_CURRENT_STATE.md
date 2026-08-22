# Current Repository State

Snapshot date: 2026-08-09

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
- monthly migratory search: selection of up to eight months from the minimum date, including across year boundaries, with fan-out only for selected months
- origin and destination autocomplete with an explicit `CITY`/`AIRPORT` discriminator when the provider supplies it
- up to three recent origin/destination suggestions per opaque browser session (24-hour TTL), plus three frequent suggestions ranked by permanent global counters; the backend records a route when it accepts a search
- month cards with complete-only queried/fared-day coverage and retained real alternatives
- an idle provider rail that names the providers this deployment searches, always and without health copy; readiness stays on the authenticated `/api/provider-status` surface, which the router uses internally and no UI consumes
- filters for stops, maximum layover time, baggage, and airlines
- paginated results with backend warnings
- per-person price only for all-adult groups; mixed adult/child/infant searches
  keep the provider total until a real passenger-type breakdown exists
- side panel with price, known baggage/conditions, purchase paths, and exact-flight provider-revalidated quotation through the shared quotation core; verified prices are reusable for at most 15 minutes

The React UI must not display simulated controls. The following remain outside the visible interface:

- multi-city search
- dedicated calendar/matrix view
- `reprice`

### Loading Feedback

- exact search: inline placeholder and one stable publication of offers after providers finish
- polling and revalidation: `Actualizando` badge
- partial range/matrix results: `Parcial` badge, geometric milestones coalesced for 900 ms, immediate final state, and cards with stable DOM identity
- quotation: the first action calls `/api/quotation`, accepts only a validated/verified offer with `priceVerifiedAt`, and uses the returned commercial text; the immediate migratory toggle then runs the same shared compositor over that verified offer
- the idle search frame reserves the ranking-card geometry before the global response arrives; search notices render below without recentering the form in idle or active layouts, while the intentional idle-to-active transition remains animated

## Runtime, Security, and Dependencies

### Private Web Application

- the server listens on `127.0.0.1` by default
- in production it remains behind Caddy with `HOST=127.0.0.1`
- `FLY_DESK_WEB_AUTH=1` enables web login with a signed httpOnly cookie
- login admission retains at most five failures per validated client in a
  15-minute window, returns `429` with `Retry-After` before scrypt on further
  attempts, expires old failures, and resets only the successful client
- Pages overwrites the login client IP from Cloudflare's initial request; Bun
  accepts that value only through a loopback peer after IP validation, ignores
  ordinary forwarded headers for admission, and caps the map at 1,024 clients
- `FLY_DESK_TRUST_LOOPBACK_CLIENT=0` is mandatory when a local reverse proxy is present
- `FLY_DESK_TRUST_REVERSE_PROXY_LOOPBACK=1` must be used only if the local proxy also blocks or authenticates local-only routes; by default, requests with `x-forwarded-for`, `forwarded`, or `x-real-ip` do not inherit loopback trust
- operational endpoints accept a valid web cookie or `FLY_DESK_API_TOKEN`
- diagnostics, Click and Book Plus token status, and local browser launch are loopback-only
- public country restriction belongs to `grumitos/vps-platform`: Caddy blocks `/login` and the rest of the application outside Peru before the request reaches Fly Desk
- the date policy moves with `minSearchDate = today` and `maxSearchDate = today + SEARCH_MAX_FUTURE_DAYS`
- round-trip stays are limited to 90 nights, searches to nine passengers, lap infants to one per adult, and fixed-range fan-out to 5,000 combinations; the public runtime exposes the same limits

### Supply Chain

- supported package manager: Bun (`packageManager: "bun@1.4.0"`)
- current lockfile: `bun.lock`
- `bunfig.toml` disables lifecycle scripts during installation and filters versions published less than three days ago
- `bunfig.toml` also disables peer auto-install (`peer = false`): every real peer is declared explicitly, and `bun-plugin-tailwind`'s `bun >= 1.0.0` peer used to pull the npm `bun` package with ~350 MB of platform binaries into every release; the runtime is the system Bun
- TypeScript 7 performs typechecking and builds through `@typescript/native`; `typescript-eslint` uses TypeScript 6 only as a development API because TypeScript 7 does not yet expose a stable programmatic API
- `.npmrc` sets `ignore-scripts=true` as protection against accidental npm/pnpm installations
- pnpm is not adopted as a normal workflow because the repository is Bun-only and has no `pnpm-lock.yaml`
- any dependency that requires installation scripts must be approved through `trustedDependencies` with a note in the change
- this web branch has no Windows launchers or local auto-update scripts

### Providers

- Agil mints its bearer over plain HTTP from a persisted identity (`agil-identity.json` under the state directory, path override `AGIL_IDENTITY_PATH`); the Chrome profile is consulted only to bootstrap that file when it is absent or the identity is refused. The subscription key comes from the environment or is recovered from the Agil bundle; Linux/VPS defaults to the loopback CDP endpoint on port 9222, explicit browser endpoints win, and Windows keeps discovery explicit
- Click and Book Plus uses environment-controlled context, a host allowlist, and optional B2B warm-up; B2B automation accepts only HTTPS on the exact `b2b.clickandbook.com` origin and rechecks same-origin navigation before entering credentials or OTP
- Click and Book Plus does not accept hosts or base URLs per request
- Click and Book Plus payload statuses 401/403/429/5xx propagate as partial
  failures across exact, range, progressive, and matrix searches, leaving the
  provider `degraded` rather than `ready`
- silent provider prewarm is enabled by default and can be disabled with `FLY_DESK_PROVIDER_PREWARM=0`
- provider searches must run in the dedicated runner when `FLY_DESK_SEARCH_SERVICE_URL` is configured; within the runner, `FLY_DESK_SEARCH_WORKER_PROCESSES=1` keeps providers in child processes
- `FLY_DESK_SEARCH_WORKER_PROCESSES=0` remains a temporary QA exception, and external QA must be repeated before changing worker counts, the runner, or warm-up
- every public search waits for Agil and Click and Book Plus and retains all offers returned by both; visible filters are materialized without trimming `allOffers`, and concurrency limits regulate only batch requests
- a fresh offer receives `quotationPreparedAt` once, when it first contains the data required for local quotation; cached SWR drafts remove that marker until fresh data is ready. It is distinct from provider revalidation in `priceVerifiedAt`
- Agil exposes list-seat availability when the provider returns a valid integer; Click and Book Plus currently exposes no equivalent quantity, so Fly Desk leaves it absent
- both normalizers preserve explicit operating-carrier metadata for codeshares
- both normalizers leave carrier and flight number empty when the provider omits them; the UI also hides baggage without explicit inclusion/exclusion evidence
- `scheduleGroups` contains only provider-native, response-scoped alternatives and references existing offer IDs; the UI uses those IDs as its only group membership and arbitrary per-leg recombination is not synthesized
- provider readiness uses closed states/reasons with a five-minute TTL; search evidence outranks fresh prewarm evidence, and Click and Book Plus context-only warm-up cannot claim readiness
- the USD/PEN rate available from Agil propagates to sibling offers; if a domestic Costamar route remains alone, daily rate resolution occurs within the search and does not query flights again
- external rate lookup has a short timeout and allows one final retry after a failed prefetch; if unresolved, the search finishes without marking the offer quotable
- global search admission uses capacity units: default budget `4`, exact `1`, range `2`, matrix `2`, default queue `8`, and default timeout `120000ms`
- the web proxy streams the runner response without buffering the complete body and retains the timeout during the stream; do not use values below the operational default
- capacity is released only when provider work finishes; session and purchase-path caches remain in `src/session-store.ts` until their operational TTL
- the price-reuse TTL is anchored to `searchMeta.completedAt`, not polling; session idle retention remains separate to preserve redirects
- completed resident jobs share 128 MiB by default; a timer reevaluates LRU when the five-second grace expires, in addition to 60-second maintenance, leaves excess jobs disk-only with compatible APIs and `/r/<id>`, and deletes them at TTL expiry. Running jobs are not eligible
- range/matrix deltas travel from worker to router without resending accumulated state; RAM, polling, and SQLite publish snapshots at geometric milestones coalesced for 900 ms, plus durable completion. Purchase paths persist independently to keep redirects visible between milestones
- matrix HTTP and SQLite payloads retain only cells with an offer, price, or redirect and omit empty placeholders; cell updates use an O(1) index and aggregation across providers is O(P·N)
- the frontend never turns a price-only matrix cell into a synthetic flight offer
- the quotation endpoint also refuses price-only matrix cells, and HTTP/frontend transport normalizers require positive price, currency, and complete real itineraries (including outbound plus inbound for round-trip) instead of filling them from the request
- matrices persist compact request/context data for redirects; older rows retain a compatible fallback to the complete payload
- with `FLY_DESK_SEARCH_SERVICE_URL`, the web process does not open the session SQLite database for autocomplete or preferences; the lazy getter reserves that restoration for the runner, `/r`, quotation, provider status, or diagnostics that actually need it
- cancellation from the UI, tab close, or orderly process shutdown changes the remote job to cancelled; `pagehide`/`beforeunload` and shutdown first force the last pending delta and request a partial cache
- external links continue through `/r/<id>` as a local purchase-path cache; Agil redirects without an intermediate page, while Click and Book Plus first verifies HTTPS, an allowed origin, and the exact search pathname, then validates or refreshes the query-string token before `302` without persisting or logging the resolved URL
- in production, `/r/*` may be resolved by `fly-desk-redirect.service`, a separate Bun process that reads the same session SQLite database; browsers authenticate with a distinct HttpOnly cookie scoped to `/r`, while the main web cookie and bearer credentials stay outside the redirect service

## Functional Structure

### Frontend

- `frontend/index.html`: HTML/React shell used by the Bun build
- `frontend/public/`: favicon and static assets copied to `frontend/dist`
- `frontend/src/main.tsx`: React entry point
- `frontend/src/App.tsx`: main composition, filters, selection, and responsive layout
- `frontend/src/components/`: `TopBar`, `SearchShell`, `ResultsPanel`, `DetailPanel`, and UI components
- `frontend/src/components/results/`: `ResultCard`, card model, CSS, migration coverage, and schedule alternatives
- `frontend/src/hooks/`: `useSearch` and `useAutocomplete`
- `frontend/src/lib/api.ts`: HTTP client, search/polling, matrix, migratory search, autocomplete, and quotation
- `frontend/src/lib/location-usage-suggestions.ts`: compatible HTTP client for per-session recent and global frequent locations
- `frontend/src/lib/browser-client-session.ts`: opaque `sessionStorage` identifier used only for recent-location isolation
- `frontend/src/lib/providers.ts`: canonical provider metadata and strict public-status normalization
- `frontend/src/index.css`: tokens, layout, light/dark themes, and visual states
- `scripts/build-frontend.ts`: build with `Bun.build`, `bun-plugin-tailwind`, and copying of `frontend/public`

### Backend

- `src/server.ts`: `Bun.serve`, `frontend/dist` serving, headers, body limit, and runtime configuration injection
- `src/redirect-service.ts` and `src/redirect-index.ts`: dedicated `/r/<id>` resolver from the SQLite cache, independent of the main runtime for provider clicks
- `src/http-router.ts`: HTTP routes, web/loopback/token authentication, jobs, matrix, quotation, provider status, redirects, and diagnostics
- `src/login-admission.ts`: bounded per-client failed-login admission before password derivation
- `src/web-auth.ts`: web password, signed cookie, and session validation
- `src/core/quotation.ts`: shared quotation rendering; by default it preserves the local time encoded by each segment
- `src/core/quotation-parser.ts`: bounded, tested pasted-quotation contract with field/line trace and no inherited price/default filters; the clipboard paste flow in `frontend/src/App.tsx` opens its reconstruction in `QuotationPastePreview`, from which the agent reviews or launches the search
- `src/core/offer-schedule-groups.ts`: provider-native schedule group contract without synthetic combinations
- `src/core/search-limits.ts`: canonical stay, passenger, and lap-infant limits shared by validation and public runtime
- `src/search-date-policy.ts`: moving date window and embedded public configuration
- `src/provider-context.ts`: Click and Book Plus context, allowlist, Chrome/CDP recovery, and live token status
- `src/local-agil.ts`: local session, token refresh, exact/range/matrix search, pricing, and deep links
- `src/local-costamar.ts`: autocomplete, exact/range/matrix search, branded links, and Click and Book Plus B2B warm-up
- `src/providers/costamar/search-payloads.ts`: Click and Book Plus payloads; `costamar` remains as a legacy internal alias
- `src/core/`: normalization, matrix, grouping, ranking, quotation/parser, and shared types
- `src/search-service-client.ts`: loopback proxy for search/matrix/polling/cancellation, quotation, and provider status to `fly-desk-search.service`
- `src/search-worker-client.ts` and `src/search-worker.ts`: Bun child processes for heavy provider searches within the runner
- `src/session-store.ts`: live jobs, cache freshness, resident budget, local SQLite, redirects, and purchase paths
- `src/location-suggestion-cache.ts`: SQLite autocomplete cache with TTL plus query/session/global bounds
- `src/location-usage-store.ts`: one global station ranking (frequency for the leading cards, newest station for the last one) plus bounded, expiring recent locations per browser session; the web unit counts the searches it delegates, so the ranking is written in the store that serves it
- `src/provider-status.ts`: in-memory closed/sanitized provider readiness tracker
- `src/runtime-paths.ts`: persistent fallback based on `FLY_DESK_APP_DATA_DIR` for SQLite caches when no specific `*_DB_PATH` is set

### Operations

- `scripts/build-frontend.ts`: frontend build
- `scripts/generate-web-password-hash.ts`: generates the scrypt hash from a
  hidden terminal prompt or controlled standard input and rejects plaintext
  arguments and environment input
- `docs/DEPLOY_APP.md`: application deployment and rollback
- `.github/workflows/ci.yml`: Bun CI for typecheck, lint, test, and build
- `.github/workflows/deploy-vps.yml`: manual deployment and rollback by exact SHA through the fixed platform release wrapper

Shared VPS infrastructure no longer lives in this repository. Caddy, systemd, Caddy rollback, and the platform plan are maintained in `grumitos/vps-platform` (`D:\Dev\VPS\vps-platform`). This repository retains the application, CI, revision deployment, and release rollback.

After an application deployment that affects search, cancellation, or redirects, finish verification with `Fly Desk Production Smoke` in `vps-platform`. That workflow checks local web/search/redirect health, a completed search, `/r/*` for Agil and Click and Book Plus, cancellation of a second search, and active services.

## Tests

Main commands:

- `bun install --frozen-lockfile`
- `bun run typecheck`
- `bun run lint`
- `bun run build`
- `bun run test`
- `bun run test:unit`
- `bun run test:integration`
- `bun run test:ui`
- `bun run test:coverage`

Bun suites use `.unit.test.ts` and `.integration.test.ts` suffixes. The modular UI suite lives in `test/ui/` and is registered from `test/ui.playwright.ts`. Shared helpers are in `test/helpers/`. The UI suite reuses the server and Chromium but creates an isolated context for each case. Its permanent responsive smoke exercises the active workspace at `1440x900`, `1024x768`, and `390x844`. See `docs/TESTING.md`.

Current important coverage:

- loopback binding by default and override through `HOST`
- web authentication with a signed cookie and optional loopback disabling
- API token for non-loopback clients
- loopback-only endpoints
- shared validation of the moving date window
- hardened Click and Book Plus context
- required or recoverable key for live Agil
- Bun workers enabled by default to isolate heavy provider searches
- SQLite persistence for sessions/autocomplete
- resident budget with disk-only fallback and lazy web runtime when search is delegated
- server-side all-time ranking of frequent suggestions plus 24-hour per-session recents, both capped at three cards per role, recorded from `/api/search` and `/api/matrix`, and shared coherently by the web and search processes
- authenticated/no-store provider status with runner proxying, closed reason codes, prewarm/search precedence, and no provider diagnostic payloads
- removed `/api/results-layout` returns 404 for GET and POST
- search rail, stable ranking/notice geometry, filters, theme, autocomplete, provider links, and quotation
- exact desktop/tablet/mobile smoke from idle through the active workspace, with no browser errors or global/internal horizontal overflow, visible keyboard focus, light/dark rendering, and reachable results, filters, and detail panels
- shared standard/migratory quotation composition, freshness-bounded exact-flight provider revalidation through `/api/quotation`, preservation of offset-bearing times, and hiding of fully disabled monthly rows

QA note: `test/helpers/server.ts` sets `FLY_DESK_DISABLE_BACKGROUND_SEARCH_JOBS=1` during HTTP tests to validate immediate contracts without leaving progressive jobs alive. The normal runtime does not define that variable.

The redesign gate on 2026-08-09 completed with 503/503 core tests and 71/71
Playwright tests, on top of the Click and Book Plus baseline restored in #39 and
fixed in #40. The responsive smoke reads the result card's disposition off the
list container rather than the shell, and asserts the stops lane always has a
box: that is the regression behind the corrected stacking threshold recorded in
`docs/REDESIGN_CONTRACT.md`.

## Current Documentation

- `README.md`
- `frontend/README.md`
- `docs/REPO_CURRENT_STATE.md`
- `docs/DEPLOY_APP.md`
- `docs/AGIL_SESSION_RECOVERY.md`
- `docs/CBPLUS_SESSION_RECOVERY.md`
- `docs/FRONTEND_IDENTITY.md`

## Deployment State

`main` is the product and deployment line. The workflow accepts only an exact SHA reachable from `main`, publishes an artifact with a digest, and delegates activation/rollback to `/usr/local/bin/vps-release-fly-desk`. The platform keeps immutable releases, switches `/opt/fly-desk` atomically, restarts web/search/redirect, validates their health checks, and restores the previous current release if activation fails.

Deployed revisions and the live service inventory are maintained in `D:\Dev\VPS\vps-platform\docs\INVENTORY.md`. This repository does not keep production SHAs as live state, avoiding documentation drift.


## Current Technical Debt

- `frontend/src/App.tsx` still concentrates substantial composition, filtering, and selection
- `src/local-agil.ts` concentrates session handling, client behavior, pricing, and mapping
- `src/local-costamar.ts` concentrates B2B automation, client behavior, mapping, and Click and Book Plus redirects
- persistence is local SQLite; there is no external store for multiple instances
- session SQLite uses WAL, `synchronous=NORMAL`, and a five-second busy timeout; a refused write is owed to the next mutation's debounce (with `close()` carrying the remainder) rather than retried on a timer, and is logged. This is explicit policy, registered in `REDESIGN_CONTRACT.md` and pinned by an integration test
- `SEARCH_COMPLETED_SESSION_TTL_MS` is a sweep threshold, not a storage switch: `0` is the shortest expressible lifetime, taken by the first positive-age maintenance pass, never a synchronous `no-store`. Registered in `REDESIGN_CONTRACT.md` and pinned by a subprocess test
- provider search failures expose the truthful closed state
  `degraded/partial_results`; distinguishing authentication, throttling, and
  upstream availability in the public rail would require a typed cause across
  every provider/worker transport and remains a separate contract decision
- persistent Chrome CDP is covered by `fly-desk-chrome.service`; Agil needs the session in that VPS profile only to bootstrap `agil-identity.json` — once the file exists, cold starts mint their own token without the browser, and the file can also be seeded from a logged-in maintainer browser (see `AGIL_SESSION_RECOVERY.md`)
- all three Fly application units currently share `/etc/fly-desk.env` and the `fly-desk` identity; separating least privilege would be a platform change and is not justified by this product-only cableado
- disk-only legacy session rows outside the restore budget may retain historical raw provider URLs until they are restored or expire; current writes and restored paths are sanitized, so a bulk migration was not added without an operational requirement
- the main router and dedicated redirect service retain parallel `/r/<id>` orchestration around a shared resolver; consolidating them would cross authentication and process boundaries, so it remains an explicit refactor rather than a speculative layer
- Click and Book Plus fixtures do not expose seat quantity, and neither provider contract proves arbitrary per-leg repricing; the UI must continue omitting those claims
- Click and Book Plus fixtures do not prove that a Cartesian product of journey
  options is sellable, nor whether native recommendation IDs may contain `:`;
  keep publishing only native quoted combinations until authorized evidence
  closes those assumptions
- there is not enough provider evidence to classify Agil
  `rawRefs.webSessionId` as a reusable secret; it remains inside the existing
  backend boundary and must not be exposed to the UI
- the mobile plates are built: one shell with three layouts at the 720 and 1100 frontiers, the merged origin/destination card, the retractable toolbar, and filters, calendar, suggestions, passengers, month picker and offer as bottom sheets. Arbitrary per-leg recombination is the one design promise still unmet, because no provider fixture supports it — see `docs/REDESIGN_CONTRACT.md`
- repeat external QA before changing `FLY_DESK_SEARCH_WORKER_PROCESSES` or provider warm-up on the VPS
- migratory search queries every day in every selected month against Agil and Click and Book Plus without fare filters; it processes months in configurable batches through `FLY_DESK_MIGRATION_CONCURRENT_MONTHS` (default `2`), which must be monitored if usage volume increases
