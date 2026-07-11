# Bounded search runtime and quotation-ready results

## Context

Production measurements showed a completed-cache payload of about 155 MiB expanding to roughly 1.56 GiB RSS. Four range searches represented about 70% of the stored state. Diagnostics-only updates also rewrote or republished unchanged result arrays, and the delegated web process could restore the same session cache merely by serving autocomplete.

Quotation had a separate round trip that revalidated the selected flight, even though a fresh search already held the itinerary, fare, baggage and provider metadata. Cached SWR results made freshness provenance important: a restored price must not become locally quotable before the provider refresh completes.

## Decision

- Exact searches publish their offers once, after providers settle. Range and matrix workers emit deltas instead of cumulative snapshots; the router publishes full RAM/HTTP snapshots only at geometric work milestones (1, 2, 4...) coalesced for 900 ms, plus the terminal state.
- SQLite follows geometric running checkpoints and every terminal state. Purchase-path rows persist independently between checkpoints so the dedicated redirect service can resolve every link already visible in RAM.
- Provider diagnostics are volatile and do not advance the material result revision. The next real result update carries the latest diagnostics.
- Freshly returned offers receive `quotationPreparedAt` only when all quotation data is present. Domestic USD or international PEN offers resolve and carry a shared USD/PEN rate as part of the search; cached drafts strip the marker.
- The external USD/PEN lookup has a short application timeout. A failed prefetch gets at most one final retry; failure remains fail-closed and never blocks publishing indefinitely.
- The React detail panel renders standard and migratory quotation text locally. Changing the migratory switch changes only the text and never calls a flight provider.
- Completed resident jobs share a 128 MiB serialized budget by default. After a 5-second final-poll grace, LRU excess leaves RAM but remains in SQLite with its purchase paths until the idle TTL. Running jobs are never eligible.
- The budget runs after persistence, again when the 5-second completion grace expires, and during 60-second maintenance. `SEARCH_COMPLETED_SESSION_RESIDENT_BUDGET_BYTES` can override it.
- The delegated web runtime initializes the session store lazily. The runner or combined process still restores sessions at startup; autocomplete and preferences in the web process do not.
- The delegated proxy streams the runner response body under the same timeout instead of buffering it. Matrix redirects read compact request/provider-context columns and fall back to legacy payloads only for old rows.
- Partial-cache cancellation and orderly shutdown flush pending provider state before changing job status. Late timers cannot move a terminal job back to `running`.
- Search-price reuse is aged from `searchMeta.completedAt`. Polling and reads do not renew price freshness.

## Consequences

- Completed disk-only jobs, offers and redirects remain available through one-shot SQLite reads without returning the payload to the resident cache.
- Matrix HTTP/persistence payloads retain only cells with an offer, price or redirect and omit empty placeholders. Cell updates are indexed O(1), while provider aggregation is O(P·N).
- The limit is intentionally soft: a single active search may exceed it while running. Admission control and worker isolation remain the protection for active work.
- SQLite file size is not reduced by resident eviction. WAL checkpoint and conditional offline compaction belong to platform maintenance.
- Startup hydrates only the newest jobs that fit the restore budget and registers the remainder as disk-only; it does not delete valid rows before their TTL.

## Verification

- Session-store tests cover grace, LRU order, running-job protection, disk-only API/redirect reads, TTL cleanup and budgeted reopen without deletion.
- Exchange-rate tests cover bounded abort and the single final retry after a failed prefetch.
- Router tests cover logarithmic snapshot counts, indexed matrix updates, linear provider aggregation, incremental deltas, cached-marker stripping, sibling-rate propagation, Costamar-only domestic conversion and refusal to mark unresolved conversion.
- UI tests cover zero quotation requests, immediate migratory updates, stable card identity and disabled cached quotation until refresh.
- The normal release gate remains install, typecheck, lint, build, core tests and Playwright UI tests.
