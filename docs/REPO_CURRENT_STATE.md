# Current Repository State

Snapshot date: 2026-07-27

## Summary

Fly Desk is a private web application for travel agents. The active runtime is Bun-only: Bun installs dependencies, runs the backend, builds the React UI, serves the HTTP BFF, and uses `bun:sqlite` for local or VPS caches.

The repository does not version generated artifacts:

- `dist/` is ignored
- `frontend/dist/` is ignored
- `output/` is ignored
- `config/results-layout.json` may be generated locally by the layout editor and must not be treated as source state

## Current Product

### React UI

- exact search
- flexible one-way search through the `stay-range` range
- flexible round-trip search through `/api/matrix`, normalized into a results list
- monthly migratory search: selection of up to eight months from the minimum date, including across year boundaries, with fan-out only for selected months
- origin and destination autocomplete
- frequent origin/destination suggestions with global ranking persisted on the VPS; the backend records a route when it accepts a search
- filters for stops, maximum layover time, baggage, and airlines
- paginated results with backend warnings
- side panel with price, baggage, conditions, purchase paths, and local quotation from fresh search data
- persistent column adjustment behind `?layoutEditor=1` or `?layout=editor`

The React UI must not display simulated controls. The following remain outside the visible interface:

- multi-city search
- dedicated calendar/matrix view
- `reprice`

### Loading Feedback

- exact search: inline placeholder and one stable publication of offers after providers finish
- polling and revalidation: `Actualizando` badge
- partial range/matrix results: `Parcial` badge, geometric milestones coalesced for 900 ms, immediate final state, and cards with stable DOM identity
- quotation: generated and copied locally without `/api/quotation`; the migratory switch injects its differences without hiding or reloading the text

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
- results layout accepts web authentication because it is an application preference
- public country restriction belongs to `grumitos/vps-platform`: Caddy blocks `/login` and the rest of the application outside Peru before the request reaches Fly Desk
- the date policy moves with `minSearchDate = today` and `maxSearchDate = today + SEARCH_MAX_FUTURE_DAYS`
- round-trip stays are limited to 90 nights

### Supply Chain

- supported package manager: Bun (`packageManager: "bun@1.3.14"`)
- current lockfile: `bun.lock`
- `bunfig.toml` disables lifecycle scripts during installation and filters versions published less than three days ago
- TypeScript 7 performs typechecking and builds through `@typescript/native`; `typescript-eslint` uses TypeScript 6 only as a development API because TypeScript 7 does not yet expose a stable programmatic API
- `.npmrc` sets `ignore-scripts=true` as protection against accidental npm/pnpm installations
- pnpm is not adopted as a normal workflow because the repository is Bun-only and has no `pnpm-lock.yaml`
- any dependency that requires installation scripts must be approved through `trustedDependencies` with a note in the change
- this web branch has no Windows launchers or local auto-update scripts

### Providers

- Agil uses a persistent Chrome session and a subscription key from the environment or recovered from the Agil bundle
- Click and Book Plus uses environment-controlled context, a host allowlist, and optional B2B warm-up
- Click and Book Plus does not accept hosts or base URLs per request
- silent provider prewarm is enabled by default and can be disabled with `FLY_DESK_PROVIDER_PREWARM=0`
- provider searches must run in the dedicated runner when `FLY_DESK_SEARCH_SERVICE_URL` is configured; within the runner, `FLY_DESK_SEARCH_WORKER_PROCESSES=1` keeps providers in child processes
- `FLY_DESK_SEARCH_WORKER_PROCESSES=0` remains a temporary QA exception, and external QA must be repeated before changing worker counts, the runner, or warm-up
- every public search waits for Agil and Click and Book Plus and retains all offers returned by both; visible filters are materialized without trimming `allOffers`, and concurrency limits regulate only batch requests
- a fresh offer receives `quotationPreparedAt` only when it contains the data required for quotation; cached SWR drafts remove that marker until revalidation finishes
- the USD/PEN rate available from Agil propagates to sibling offers; if a domestic Costamar route remains alone, daily rate resolution occurs within the search and does not query flights again
- external rate lookup has a short timeout and allows one final retry after a failed prefetch; if unresolved, the search finishes without marking the offer quotable
- global search admission uses capacity units: default budget `4`, exact `1`, range `2`, matrix `2`, default queue `8`, and default timeout `120000ms`
- the web proxy streams the runner response without buffering the complete body and retains the timeout during the stream; do not use values below the operational default
- capacity is released only when provider work finishes; session and purchase-path caches remain in `src/session-store.ts` until their operational TTL
- the price-reuse TTL is anchored to `searchMeta.completedAt`, not polling; session idle retention remains separate to preserve redirects
- completed resident jobs share 128 MiB by default; a timer reevaluates LRU when the five-second grace expires, in addition to 60-second maintenance, leaves excess jobs disk-only with compatible APIs and `/r/<id>`, and deletes them at TTL expiry. Running jobs are not eligible
- range/matrix deltas travel from worker to router without resending accumulated state; RAM, polling, and SQLite publish snapshots at geometric milestones coalesced for 900 ms, plus durable completion. Purchase paths persist independently to keep redirects visible between milestones
- matrix HTTP and SQLite payloads retain only cells with an offer, price, or redirect and omit empty placeholders; cell updates use an O(1) index and aggregation across providers is O(P·N)
- matrices persist compact request/context data for redirects; older rows retain a compatible fallback to the complete payload
- with `FLY_DESK_SEARCH_SERVICE_URL`, the web process does not open the session SQLite database for autocomplete or preferences; the lazy getter reserves that restoration for the runner, `/r`, quotation, or diagnostics that actually need it
- cancellation from the UI, tab close, or orderly process shutdown changes the remote job to cancelled; `pagehide`/`beforeunload` and shutdown first force the last pending delta and request a partial cache
- external links continue through `/r/<id>` as a local purchase-path cache; Agil redirects without an intermediate page, while Click and Book Plus validates or refreshes its token before `302`
- in production, `/r/*` may be resolved by `fly-desk-redirect.service`, a separate Bun process that reads the same session SQLite database; browsers authenticate with a distinct HttpOnly cookie scoped to `/r`, while the main web cookie and bearer credentials stay outside the redirect service

## Functional Structure

### Frontend

- `frontend/index.html`: HTML/React shell used by the Bun build
- `frontend/public/`: favicon and static assets copied to `frontend/dist`
- `frontend/src/main.tsx`: React entry point
- `frontend/src/App.tsx`: main composition, filters, selection, and responsive layout
- `frontend/src/components/`: `TopBar`, `SearchShell`, `ResultsPanel`, `DetailPanel`, and UI components
- `frontend/src/components/results/`: `ResultCard`, card model, CSS, and layout editor
- `frontend/src/hooks/`: `useSearch` and `useAutocomplete`
- `frontend/src/lib/api.ts`: HTTP client, search/polling, matrix, migratory search, autocomplete, and layout
- `frontend/src/lib/location-usage-suggestions.ts`: HTTP client for the global frequent origin/destination ranking
- `frontend/src/index.css`: tokens, layout, light/dark themes, and visual states
- `scripts/build-frontend.ts`: build with `Bun.build`, `bun-plugin-tailwind`, and copying of `frontend/public`

### Backend

- `src/server.ts`: `Bun.serve`, `frontend/dist` serving, headers, body limit, and runtime configuration injection
- `src/redirect-service.ts` and `src/redirect-index.ts`: dedicated `/r/<id>` resolver from the SQLite cache, independent of the main runtime for provider clicks
- `src/http-router.ts`: HTTP routes, web/loopback/token authentication, jobs, matrix, quotation, redirects, diagnostics, and layout
- `src/login-admission.ts`: bounded per-client failed-login admission before password derivation
- `src/web-auth.ts`: web password, signed cookie, and session validation
- `src/core/quotation.ts`: shared quotation rendering; by default it preserves the local time encoded by each segment
- `src/search-date-policy.ts`: moving date window and embedded public configuration
- `src/provider-context.ts`: Click and Book Plus context, allowlist, Chrome/CDP recovery, and live token status
- `src/local-agil.ts`: local session, token refresh, exact/range/matrix search, pricing, and deep links
- `src/local-costamar.ts`: autocomplete, exact/range/matrix search, branded links, and Click and Book Plus B2B warm-up
- `src/providers/costamar/search-payloads.ts`: Click and Book Plus payloads; `costamar` remains as a legacy internal alias
- `src/core/`: normalization, matrix, grouping, ranking, quotation, and shared types
- `src/search-service-client.ts`: loopback proxy for search/matrix/polling/cancellation to `fly-desk-search.service`
- `src/search-worker-client.ts` and `src/search-worker.ts`: Bun child processes for heavy provider searches within the runner
- `src/session-store.ts`: live jobs, cache freshness, resident budget, local SQLite, redirects, and purchase paths
- `src/location-suggestion-cache.ts`: SQLite autocomplete cache with TTL
- `src/location-usage-store.ts`: global SQLite ranking of frequent origins/destinations
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

Bun suites use `.unit.test.ts` and `.integration.test.ts` suffixes. The modular UI suite lives in `test/ui/` and is registered from `test/ui.playwright.ts`. Shared helpers are in `test/helpers/`. The UI suite reuses the server and Chromium but creates an isolated context for each case. See `docs/TESTING.md`.

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
- server-side global ranking of frequent suggestions rather than per-browser `localStorage`, recorded from `/api/search` and `/api/matrix`
- persistent results layout
- search rail, filters, theme, autocomplete, provider links, and quotation
- standard/migratory local quotation without another request, preservation of offset-bearing times, and hiding of fully disabled monthly rows

QA note: `test/helpers/server.ts` sets `FLY_DESK_DISABLE_BACKGROUND_SEARCH_JOBS=1` during HTTP tests to validate immediate contracts without leaving progressive jobs alive. The normal runtime does not define that variable.

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
- persistent Chrome CDP is covered by `fly-desk-chrome.service`; Agil still needs a valid real session in that VPS profile
- repeat external QA before changing `FLY_DESK_SEARCH_WORKER_PROCESSES` or provider warm-up on the VPS
- migratory search queries every day in every selected month against Agil and Click and Book Plus without fare filters; it processes months in configurable batches through `FLY_DESK_MIGRATION_CONCURRENT_MONTHS` (default `2`), which must be monitored if usage volume increases
