# Technical Debt

## High Priority

- Split large files:
  - `src/http-router.ts`
  - `src/local-agil.ts`
  - `src/local-costamar.ts`
- Consolidate duplicated provider helpers into shared modules (`http`, `concurrency`, `profile-copy`, dedupe/signature helpers).
- Introduce structured logger with request/job correlation IDs.
- Standardize API error envelopes across all endpoints.

## Medium Priority

- Add schema-based runtime validation for incoming payloads.
- Tighten concurrency controls for long-running progressive flows and single-flight caches.
- Expand deterministic time control in tests (fake clock injection where TTL/date assertions exist).
- Move launcher scripts in root (`*.vbs`) to `tools/` or `scripts/windows/`.

## Low Priority

- Enable additional TypeScript strictness flags in a staged rollout:
  - `noUncheckedIndexedAccess`
  - `exactOptionalPropertyTypes`
- Replace remaining magic-number timeouts with named constants/config.
- Continue reducing broad `catch {}` usage in favor of centralized, scoped error reporting.

## Frontend and CSS Tracks

Frontend and redesign tracks are intentionally excluded from this backend implementation wave and should be executed in their dedicated roadmap.
