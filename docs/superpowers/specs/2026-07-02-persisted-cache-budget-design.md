# Bounded persisted search cache

## Context

The 2026-07-02 outage was triggered when the daily maintenance restart loaded 20 still-valid completed searches from SQLite. Their search payloads totaled 400,952,566 bytes and referenced 126,799 purchase paths. Deserializing that cache raised the search runner to about 2.6 GiB RSS and prevented it from reaching its health endpoint.

The existing startup cleanup removes expired and non-restorable rows before loading payloads, but it does not bound valid cache volume. All incident rows were within the four-hour TTL when maintenance restarted the service.

## Decision

Limit persisted search and matrix payloads restored at startup to 128 MiB total.

Before reading any payload JSON, query only row IDs, kind, idle timestamp, and payload byte length. Keep the newest rows while their cumulative size remains within the budget. Delete over-budget jobs and their purchase paths in the same SQLite transaction, then load the retained payloads normally.

The budget is strict: a single row larger than 128 MiB is not restored. Completed-result cache is best-effort, so eviction may reduce cache reuse after a restart but must not affect new searches.

## Scope

- Keep the existing four-hour TTL and status cleanup.
- Apply one combined budget across search and matrix jobs.
- Order retention by most recent `idle_at_ms`, with deterministic kind/ID tie-breaking.
- Delete purchase paths owned by evicted jobs.
- Emit a non-sensitive startup summary only when budget eviction occurs.
- Add no dependency and no new production environment variable.

## Non-goals

- Lazy-loading completed jobs from SQLite.
- Changing search concurrency or provider behavior.
- Automatic `VACUUM`; physical SQLite compaction remains separate maintenance.
- Lowering systemd memory limits in this change.

## Verification

1. Regression integration test: several valid persisted jobs exceed a small injected test budget; only the newest fitting jobs and their paths survive startup.
2. Existing session-store integration suite.
3. Fly Desk documented gate: install, typecheck, lint, build, and full tests.
4. Deploy the exact pushed SHA.
5. Production smoke must complete a search with Agil and Click and Book Plus, resolve both provider links, cancel a second search, and leave web/search/redirect healthy.
6. Restart `fly-desk-search.service` once more after the smoke and confirm health plus bounded memory, proving the startup path rather than only the live-search path.
