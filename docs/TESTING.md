# Testing Strategy

Fly Desk is tested end to end. The real web unit, search runner (with its
pooled worker children) and redirect service run on loopback against fake
provider upstreams, and a real browser drives the Spanish desk the way an agent
does. Each test asserts through the UI and through backend evidence: the fake
upstream's request log, the API, the stack's SQLite files, and process ids.
There is no unit suite. What a release is before it runs, the artifact booted
the way the platform boots it, is the release smoke's
(`scripts/release-smoke.ts`, described in [`DEPLOY_APP.md`](./DEPLOY_APP.md)).
The gates a change must pass are listed once, in [`AGENTS.md`](../AGENTS.md),
"Verification".

## Commands

- `bun run test` (or `bun run test:e2e`): `bun run build`, then
  `scripts/run-e2e.ts`.
- `bun scripts/run-e2e.ts [spec files…] [-- bun test options…]`: runs the
  suite, or some of its files, on an existing build. For example:
  `bun scripts/run-e2e.ts test/e2e/capacity.e2e.ts -- --test-name-pattern="queue"`.
- `bun run typecheck` also checks `test/**/*.ts`, `scripts/run-e2e.ts` and
  `scripts/release-smoke.ts` through `tsconfig.test.json`.

The suite needs Bun 1.4 and a Chromium for Playwright.

| Variable | Effect |
| --- | --- |
| `FLY_DESK_E2E_CONCURRENCY` | Spec files run at once. Default: one less than the available cores, at most three. |
| `FLY_DESK_TEST_BROWSER_CHANNEL` | Playwright browser channel. CI uses `chrome`, which the runner image already has; unset, Playwright uses its installed Chromium. |

## How the suite runs

`scripts/run-e2e.ts` runs every `test/e2e/*.e2e.ts` file in its own
`bun test` process, several files at once, and prints each file's report
whole, followed by a summary with the wall time of every file. A spec file
starts one fake upstream, one stack and one browser in `beforeAll` and stops
them in `afterAll`. Its tests run one after another, each with fresh browser
contexts and a reset fake. A test has three minutes. The harness lives in
`test/e2e/support/`:

- `support/stack.ts`: the topology of the `fly-desk*.service` units on
  loopback. It runs the search runner, the web unit delegating to it, the
  redirect service and one shared app-data directory. In front of them,
  `support/front-proxy.ts` does what Caddy does: it routes `/r/*`, strips the
  headers Caddy strips, refuses bodies over 1 MB, and retries a refused
  connection for five seconds, so a restarting unit stays invisible. A spec
  can also put `support/hop-relay.ts` on the web unit's hop to the runner: it
  passes every byte through, or drops a connection the moment the web unit
  sends a second request on it.
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
- `support/fake-chrome.ts`: the platform Chrome behind `AGIL_BROWSER_URL`,
  served by the fake upstream. Closed unless a test opens it; open, it speaks
  the DevTools calls the runtime makes, holds per-origin localStorage, answers
  a navigation only once its page has responded (a delay, or never), and
  records every tab and whether it was closed.
- `support/harness.ts`: suites, tests and browser contexts. A context aborts
  every non-loopback request, captures `/r/*` answers without following their
  redirects, and records `/api` traffic, console output and page errors. It
  says when a page's `/api` traffic has settled (`apiSettled`), the capacity
  the title bar always follows apart, which `networkidle` cannot say for a
  page that always has that reading out. After
  every test it asserts that nothing tried to leave the machine, that no
  provider fallback path ran unless the test names it (`allowedFallbacks`),
  that the fake built every answer it was asked for, that no page threw, and
  that no `/api` answer a page read carried an offer's `rawRefs` or
  `signature`.
- `support/ui.ts`: every selector the specs use. Selectors are roles,
  accessible names and visible text; never CSS classes or pixel positions.
- `support/api-client.ts`, `support/flows.ts`, `support/scenario.ts` and
  `support/sessions.ts`: the API, common desk flows, dates, request-log and
  SQLite helpers (reading and writing a stack's files the way an earlier
  release or an operator would), session cookies minted with the stack's
  secret, and the browser id a page's «Recientes» are recorded under.
- `support/prove-stack.ts`: a standalone check of the foundation over HTTP.

Every stack uses the same "today" (`SEARCH_TODAY_OVERRIDE`): the next
20 November on or after Lima's date. Calendars and migratory sweeps look the
same on every run, and a year boundary is always six weeks away.

## Spec files

| File | Covers |
| --- | --- |
| `agil-session.e2e.ts` | With no stored identity, the Agil session read from the platform Chrome in one tab, behind a page slower than one DevTools command, the tab closed and the identity kept for the next start; a worker stopped mid-read closing its tab (not on Windows, where a stop cannot be intercepted) |
| `desk-search.e2e.ts` | A shared link through the sign-in gate, each of its stations looked up once; merged results, filters and sorting, and the list's outcome read out; the list, the offer and the quotation set in one family, figures included; quotation revalidation, «Cotizar» busy and announced while the provider confirms, and a confirmed fare quoted again; both providers' purchase redirects, and a blocked provider window named; the flexible matrix filled cell by cell; a range of three hundred fares in a stable order that matches the backend's, back at its top after any change of filter; the list, its column head, the passenger popover and both calendars from the keyboard, with «hoy» on the desk's day |
| `migration.e2e.ts` | A migratory sweep across the year boundary: priced, failed and empty months, a month opened without a new search, its fares measured on the airports' own clocks over a connection longer than a day, and the route counted once; a provider that failed a month, or answered one in part, named «respondió en parte» in the sweep's one line; a month still loading that keeps its whole name beside «Más bajo» on the narrowest desk cards; each month followed from the moment its search starts |
| `resilience.e2e.ts` | A failed provider named in one line with nothing it said reaching the page or the logs, and named again by the next search after the line is dismissed; a token refused inside a 200 named the same way in an exact search, a range and a matrix, the last two stopping at the first refusal; both providers down, never read out as an empty route; a connection the runner drops as the web unit reuses it never reaching the desk (the spec's stack has a relay on that hop); stopping a search, before or after its first answer, and closing the tab mid-search, each hanging up on the providers, asking nothing more and giving the capacity back |
| `lifecycle.e2e.ts` | Every other way a search ends giving its capacity back and stopping its work: completing, its providers both failing, a new search in the same tab replacing it (a pasted quotation), its page going silent (offline) or signing out, a queued search whose page goes silent leaving the queue unstarted, a provider hanging until its deadline, and the runner restarting mid-search; and the runner stopped the way a deployment stops it (not on Windows, where a stop cannot be intercepted), the page following a search told what it found and why it stopped, with no provider blamed. Its runner stops a job nobody follows after 3 s instead of 90 |
| `partial-answers.e2e.ts` | An Agil GDS whose connection drops asked once more on a connection of its own, every fare kept, and a Click and Book Plus search and a quote's revalidation the same way; a GDS that drops every connection for a day, one that stalls past Agil's deadline (not asked again), one that never answers a flexible round-trip cell (the cell keeping what another GDS answered) and a range day no GDS answers (not asked again), each named «respondió en parte» in the desk's one line with the rest of the list kept; a provider that answered no part of a search (no GDS of an exact search, no day of a range, no cell of a flexible round trip, an error status included), Agil or Click and Book Plus, named as not answering, with the other provider's list kept. Its stack runs with Agil's shortest deadline, five seconds |
| `capacity.e2e.ts` | Searches past the budget waiting instead of refused, one stopped while it waits leaving the queue at once; an exact search starting at once for each agent while heavy work waits, the agent holding less capacity going first, and an exact search past its reserve not overtaking waiting heavy work; two month-long ranges never running together, the waiting one not overtaken by a shorter one; a heavy search waiting beside other heavy work while the unit's memory is short (a cgroup the test writes) and one alone starting anyway; the capacity back to idle after each; the title bar's meter following the capacity without being asked (its cupos, shown as «4/7», and its words) and reading full once every cupo is taken, a search that has to wait saying so in one line until it starts, a hidden tab not reading and a shown one reading at once, and an unreadable capacity leaving the meter blank and nothing said; the Agil in-flight ceiling, a restart of every unit on rows a rollback can read and a row an earlier release rewrote, a cache file left mostly free compacted before the runner opens, and the Click and Book Plus token installed in both the file and the environment: a renewed file, and a platform rollback's newer environment token |
| `mobile.e2e.ts` | Phone sheets and the system back at 390×844, the idle phone set in the one family, a phone's form built once and a calendar a tap does not scroll; the station sheet's history drawn in the rows its matches use, with no keys in either state, and a row taken with `Enter` closing the sheet as a tap does; every mode at 360×740; the 1024×768 desk; dates and months asked for only once their calendar is left; a desk resized under a search |
| `session-security.e2e.ts` | Session renewal and its cap, sign-out, login lockout, hostile return paths and one holding markup, cookies forged, altered, expired or in the old format, security headers, spoofed trust headers, purchase paths altered in the cache, oversized bodies and forged quotations |
| `suggestions-quotes.e2e.ts` | Suggestions from both providers, their keys whole under the idle desk's narrow field; recent and frequent stations, drawn row for row as the matches are — named from the suggestion cache or the desk's list of certain codes without asking a provider, a code nothing names drawn alone — over the same keys, walked with the arrows (each row brought into view below its head) and taken with `Enter`, and drawn as codes alone from a server that sends no names; a quote in soles pasted back, its fare's age moving while it is open and read whole at its foot, a search copied to share, and an exchange rate that never answers |

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
  partial) is in it. A provider request sent again, an Agil GDS or matrix cell
  left out, each has its own line with the error behind it.
- `fake-requests.txt`: the fake's request log, each request with the time it
  arrived, its answer, how long that took and the process that asked.
- `browser.txt` and `page-<n>.png`: the browser's record and a screenshot of
  each open page.
- `error.txt`: the failure itself.

The runner clears `test-results/e2e` when it starts.

## CI

`.github/workflows/ci.yml` runs two jobs in parallel on every pull request to
`main`, and on manual dispatch. `Core quality gate` installs, typechecks,
lints, builds and smokes the release artifact (`scripts/release-smoke.ts`,
described in [`DEPLOY_APP.md`](./DEPLOY_APP.md)). `Browser UI gate` installs,
builds and runs the end-to-end suite on the runner image's Chrome, and uploads
`test-results/e2e/` as `fly-desk-e2e-failures` when it fails. Branch
protection requires both, on a branch up to date with `main`, so the tree a
squash merge lands is the tree they passed: nothing runs again on `main`, and
a deployment builds, packs and smokes the revision without testing it again.
