# Testing Strategy

Fly Desk separates tests by the resources they consume and the type of contract they protect.

## Commands

- `bun run test:unit`: pure logic and small contracts, without external processes.
- `bun run test:integration`: HTTP, SQLite, filesystem, workers, and controlled providers.
- `bun run test:core`: unit and integration tests in a single Bun run.
- `bun run test:ui`: React flows in Chromium against the local build.
- `bun run test:coverage`: coverage for the Bun suites. Browser coverage is not included in this report.
- `bun run test`: complete core and UI gate.

Bun test files must end in `.unit.test.ts` or `.integration.test.ts`; the scripts pass those suffixes directly to `bun test`.

## UI Suite

`test/ui.playwright.ts` registers the shared lifecycle and loads capability-based modules from `test/ui/`. The suite starts one server instance and one Chromium instance. Each test receives a fresh `BrowserContext` to isolate cookies, storage, routes, and pages.

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
