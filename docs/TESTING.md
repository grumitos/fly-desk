# Testing Strategy

Fly Desk is tested end to end. The real web unit, search runner (with its
pooled worker children) and redirect service run on loopback against fake
provider upstreams, and a real browser drives the Spanish desk the way an agent
does. Each test asserts through the UI and through backend evidence: the fake
upstream's request log, the API, and process ids.

## Commands

- `bun run test`: `test:unit`, then `test:e2e`. `deploy-vps.yml` runs it before
  it builds a release.
- `bun run test:unit`: `bun test test/unit`, for what an end-to-end run cannot
  reach deterministically: pure logic, the session cache on a temporary SQLite
  file, and one search worker against a fake Chrome. The worker test sends a
  real SIGTERM, so it is skipped on Windows, where a signal cannot be caught.
  It passes while the folder is empty.
- `bun run test:e2e`: `bun run build`, then `scripts/run-e2e.ts`.
- `bun scripts/run-e2e.ts [spec files…] [-- node --test options…]`: runs the
  suite, or some of its files, on an existing build. For example:
  `bun scripts/run-e2e.ts test/e2e/capacity.e2e.ts -- --test-name-pattern="queue"`.
- `bun run typecheck` also checks `test/**/*.ts` and `scripts/run-e2e.ts`
  through `tsconfig.test.json`.

The suite needs Bun 1.4, Node 22.6 or later, and a Chromium for Playwright.
Node strips TypeScript types on its own from 22.18; before that, the runner
passes `--experimental-strip-types`. CI uses Node 26.

| Variable | Effect |
| --- | --- |
| `FLY_DESK_E2E_CONCURRENCY` | Spec files run at once. Default: one less than the available cores, at most three. |
| `FLY_DESK_TEST_BROWSER_CHANNEL` | Playwright browser channel. CI uses `chrome`, which the runner image already has; unset, Playwright uses its installed Chromium. |

## How the suite runs

`scripts/run-e2e.ts` runs every `test/e2e/*.e2e.ts` file in its own
`node --test` process, several files at once, and prints each file's report
whole, followed by a summary with the wall time of every file. A spec file
starts one fake upstream, one stack and one browser in `before` and stops them
in `after`. Its tests run one after another, each with fresh browser contexts
and a reset fake. A test has three minutes. The harness lives in
`test/e2e/support/`:

- `support/stack.ts`: the topology of the `fly-desk*.service` units on
  loopback. It runs the search runner, the web unit delegating to it, the
  redirect service and one shared app-data directory. In front of them,
  `support/front-proxy.ts` does what Caddy does: it routes `/r/*`, strips the
  headers Caddy strips, refuses bodies over 1 MB, and retries a refused
  connection for five seconds, so a restarting unit stays invisible.
- `support/egress-preload.ts`: a Bun preload in every process of the stack,
  worker children included, delivered through `BUN_OPTIONS`. It rewrites the
  provider origins in `support/provider-origins.ts` to the fake upstream, lets
  loopback through, and blocks and records everything else. No test reaches
  the internet.
- `support/fake-upstream.ts` and `support/fixtures.ts`: Agil, Click and Book
  Plus, the brand host and the exchange rate, answered from per-route
  fixtures. A test can make an operation fail, slow down, or wait at a gate
  (`hold`) until the test releases it. The request log records every call with
  its calling process, status, and whether the caller aborted it.
- `support/harness.ts`: suites, tests and browser contexts. A context aborts
  every non-loopback request, captures `/r/*` answers without following their
  redirects, and records `/api` traffic, console output and page errors. After
  every test it asserts that nothing tried to leave the machine, that no
  provider fallback path ran, that the fake built every answer it was asked
  for, and that no page threw.
- `support/ui.ts`: every selector the specs use. Selectors are roles,
  accessible names and visible text; never CSS classes or pixel positions.
- `support/api-client.ts`, `support/flows.ts`, `support/scenario.ts` and
  `support/sessions.ts`: the API, common desk flows, dates and request-log
  helpers, and session cookies minted with the stack's secret.
- `support/prove-stack.ts`: a standalone check of the foundation over HTTP.

Every stack uses the same "today" (`SEARCH_TODAY_OVERRIDE`): the next
20 November on or after Lima's date. Calendars and migratory sweeps look the
same on every run, and a year boundary is always six weeks away.

## Spec files

| File | Covers |
| --- | --- |
| `desk-search.e2e.ts` | A shared link through the sign-in gate, each of its stations looked up once; merged results, filters and sorting, and the list's outcome read out; quotation revalidation and a confirmed fare quoted again; both providers' purchase redirects, and a blocked provider window named; the flexible matrix filled cell by cell; a range of three hundred fares in a stable order that matches the backend's, back at its top after any change of filter; the list, its column head, the passenger popover and both calendars from the keyboard, with «hoy» on the desk's day |
| `migration.e2e.ts` | A migratory sweep across the year boundary: priced, failed and empty months, a month opened without a new search, and the route counted once; each month followed from the moment its search starts |
| `resilience.e2e.ts` | A failed provider named in one line with nothing it said reaching the page or the logs, and named again by the next search after the line is dismissed; a token refused inside a 200 named the same way in an exact search, a range and a matrix, the last two stopping at the first refusal; both providers down, never read out as an empty route; stopping a search; closing the tab mid-search |
| `capacity.e2e.ts` | Admission order, the queue limit and its timeout, each named in the desk's notice, the Agil in-flight ceiling, a restart of every unit, and a renewed Click and Book Plus token file |
| `mobile.e2e.ts` | Phone sheets and the system back at 390×844, a phone's form built once and a calendar a tap does not scroll; every mode at 360×740; the 1024×768 desk; dates and months asked for only once their calendar is left; a desk resized under a search |
| `session-security.e2e.ts` | Session renewal and its cap, sign-out, login lockout, hostile return paths, security headers, spoofed trust headers, oversized bodies and forged quotations |
| `suggestions-quotes.e2e.ts` | Suggestions from both providers, recent and frequent stations, a quote in soles pasted back, its fare's age moving while it is open, a search copied to share, and an exchange rate that never answers |

## Writing a test

- Assert what the agent sees and what the backend did. Assert every fake
  interaction a test relies on from the request log.
- Wait for conditions: `eventually`, Playwright's waits, or a fake gate.
  Never wait for time, except to let a documented propagation window pass
  before asserting that something did not happen, such as the pooled worker's
  cancellation poll.
- Move the page's own clock instead of waiting for it: a context's `clock`
  runs a fare's age forward, holds a poll until the test lets it leave, or
  sets the hour at which Lima and UTC disagree about the date.
- Keep state from crossing tests. The fake is reset before each test; where the
  stack keeps state (location usage, login lockout, cached searches), each test
  uses its own routes, dates or client addresses.
- Add selectors to `support/ui.ts` only.
- Never follow a provider redirect in the browser. Assert the 302 and its
  `Location`.
- A known product gap is a test marked `todo` with its cause and the file and
  line behind it. It still runs, and the runner counts it as a known gap
  instead of a failure. Remove the mark with the fix.

## Failures

A failing test leaves its artifacts under `test-results/e2e/<spec>/<test>/`:

- `stack.log`: what the runner, the web unit and the redirect service wrote to
  stdout and stderr while the test ran, the pooled workers' stderr among the
  runner's. Each line carries its UTC time, and the stack runs with
  `FLY_DESK_PERF_LOG=1`, so every request and every provider's outcome (offers,
  partial) is in it.
- `fake-requests.txt`: the fake's request log, each request with the time it
  arrived, its answer, how long that took and the process that asked.
- `browser.txt` and `page-<n>.png`: the browser's record and a screenshot of
  each open page.
- `error.txt`: the failure itself.

The runner clears `test-results/e2e` when it starts.

## CI

`.github/workflows/ci.yml` runs two jobs in parallel on pull requests, pushes
to `main` and manual dispatch. `quality` installs, typechecks, lints, builds and
runs the unit tests. `e2e` installs, builds and runs the end-to-end suite on
the runner image's Chrome, and uploads `test-results/e2e/` as
`fly-desk-e2e-failures` when it fails.
