# Testing Strategy

Fly Desk separates tests by the resources they consume and the type of contract they protect.

## Commands

- `bun run test:unit`: pure logic and small contracts, without external processes.
- `bun run test:integration`: HTTP, SQLite, filesystem, workers, and controlled providers.
- `bun run test:core`: unit and integration tests in one `bun test --parallel` run.
- `bun run test:ui`: React flows in Chromium against the local build.
- `bun run test:coverage`: coverage for the Bun suites. Browser coverage is not included in this report.
- `bun run test`: complete core and UI gate.

Bun test files must end in `.unit.test.ts` or `.integration.test.ts`; the scripts pass those suffixes directly to `bun test`.

## Core Suite Parallelism

`test:core` runs `bun test --parallel`: one worker process per core, one test file
at a time inside each. `--parallel` implies `--isolate`, so a file gets a fresh
global and module registry and cannot be reached by another file's leftovers —
which is a stronger guarantee than the single shared process the suite used to
run in, not a weaker one. Nothing in the suite binds a fixed port
(`test/helpers/server.ts` asks for port 0) and every temporary directory comes
from `mkdtempSync`, so files do not compete for names.

Two things it did surface, both now fixed rather than worked around:

- Deleting a temp directory that just held an open `bun:sqlite` database answers
  `EBUSY` on Windows for a few milliseconds. That was an occasional flake in
  `redirect-service.integration`; a busy machine made it a failure on every run.
  `test/helpers/temp.ts` waits it out — use `removeTempRoot()` for any temp root
  with a database in it, never a bare `rmSync`.
- What `--parallel` cannot do is beat its slowest file, and this suite is nearly
  one file long: `http-router.integration.test.ts` is 84 tests and about 120s of
  a ~145s sequential run, because 46 of them stand up a server of their own.
  Splitting that file is what would make the rest of the parallelism visible.

Do **not** add `--concurrent`. It runs the tests inside a file at the same time,
and it ignores the per-test `{ concurrency: false }` option some tests here carry
— Bun 1.4 accepts that option and does nothing with it, so it protects nothing.
Measured on `http-router.integration.test.ts`, `--concurrent` fails 14 of 84.

## UI Suite

`scripts/run-ui-tests.ts` runs every capability-based module in `test/ui/` as an independent `node --test` file, in parallel. Each file calls `registerDesktopHarness()` from `test/helpers/ui.ts` and therefore owns its own server instance and its own Chromium instance; each test receives a fresh `BrowserContext` to isolate cookies, storage, routes, and pages. The number of files running at once is `FLY_DESK_UI_TEST_CONCURRENCY` when set, and otherwise one less than the available parallelism, capped at four.

`test/ui/responsive-smoke.playwright.ts` fixes the frontend QA viewports at
desktop `1440x900`, tablet `1024x768`, and mobile `390x844`. Each case drives the
workspace from idle into an active result, checks global horizontal overflow and
the search grid's own `scrollWidth`, visits the panels available at that
breakpoint, renders light and dark themes, and proves that the first keyboard
focus is visible. The shared harness fails every case on an uncaught browser
error.

GitHub Actions uses the `chrome` channel included in the official runner image through `FLY_DESK_TEST_BROWSER_CHANNEL=chrome`. When that variable is not set locally, Playwright uses its installed Chromium. This avoids downloading a full browser in every job.

UI tests should prioritize:

- roles, accessible names, and keyboard navigation
- submitted payloads and visible states
- overflow, control availability, and panel changes
- critical search, results, filtering, detail, and quotation flows

Avoid assertions against Tailwind class fragments, internal component hierarchy, or subpixel tolerances unless they represent a deliberate visual contract. When a UI test fails, the harness saves a screenshot under `test-results/ui/`; CI publishes that directory as an artifact.

## Coverage

Coverage is a signal, not an isolated global target. New tests should prioritize branches involving:

- security and authentication
- orchestration and provider contracts
- persistence, caching, cancellation, and redirects
- conversion of shared requests between frontend and backend

Do not remove `costamar` compatibility tests solely because they use the legacy name: they still protect the Click and Book Plus integration. Before removing a test, establish that the contract no longer exists or is covered by a more direct test.
