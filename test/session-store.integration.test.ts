import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  COMPLETED_SEARCH_SESSION_RESIDENT_GRACE_MS,
  COMPLETED_SEARCH_SESSION_TTL_MS,
  SESSION_STORE_PERSIST_DEBOUNCE_MS,
  SearchSessionStore,
  PERSISTED_SWEEP_STATEMENTS,
} from "../src/session-store";
import type { SessionStoreScheduler } from "../src/session-store";
import { SEARCH_CACHE_VERSION } from "../src/core/types";
import type {
  CanonicalOffer,
  MatrixCell,
  ProviderDiagnostics,
  ProviderMeta,
  SearchMeta,
  SearchRequest,
} from "../src/core/types";

const tempRootsForCleanup = new Set<string>();

/*
 * A deterministic stand-in for the store's clock and timers.
 *
 * Most waits in this file sleep past the 180ms persist debounce and are safe as
 * they stand: the store's timer and the test's sleep share one event loop, and
 * the store's is both armed earlier and due sooner, so a stalled loop delays
 * the pair together without reordering them.
 *
 * The resident-budget grace recheck was the exception. It could not be observed
 * by ordering, only by waiting out a five-second grace and polling until an
 * absolute `Date.now()` deadline — and an absolute deadline is precisely what a
 * loaded machine blows through, turning a late sweep into a failed assertion.
 *
 * Time moves here only when a test moves it. `advance` runs every timer that
 * comes due inside the span, in due order, including timers armed by a callback
 * it just ran — the budget sweep re-arms itself while a job is still inside its
 * grace, and that re-arm is exactly the behaviour under test.
 */
function createManualScheduler(startMs: number) {
  interface PendingTimer {
    dueAt: number;
    callback: () => void;
  }

  let nowMs = startMs;
  let nextHandle = 0;
  const pending = new Map<number, PendingTimer>();

  const scheduler: SessionStoreScheduler = {
    now: () => nowMs,
    setTimeout: (callback, delayMs) => {
      const handle = ++nextHandle;
      pending.set(handle, { dueAt: nowMs + Math.max(1, Math.trunc(delayMs)), callback });
      return handle;
    },
    clearTimeout: (handle) => {
      pending.delete(handle as number);
    },
  };

  return {
    scheduler,
    now: (): number => nowMs,
    advance(byMs: number): void {
      const target = nowMs + byMs;
      /* A callback may arm its successor, so this drains rather than iterates a
         snapshot. The cap turns a store that re-arms without ever converging
         into a named failure instead of a hung test. */
      for (let step = 0; ; step += 1) {
        assert.ok(step < 1_000, "manual scheduler kept re-arming timers without settling");
        let dueHandle: number | undefined;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [handle, timer] of pending) {
          if (timer.dueAt <= target && timer.dueAt < dueAt) {
            dueHandle = handle;
            dueAt = timer.dueAt;
          }
        }
        if (dueHandle === undefined) {
          break;
        }
        const timer = pending.get(dueHandle)!;
        pending.delete(dueHandle);
        nowMs = timer.dueAt;
        timer.callback();
      }
      nowMs = target;
    },
  };
}

afterEach(() => {
  for (const tempRoot of tempRootsForCleanup) {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    tempRootsForCleanup.delete(tempRoot);
  }
});

test("completed search result cache ttl is four hours", () => {
  assert.equal(COMPLETED_SEARCH_SESSION_TTL_MS, 4 * 60 * 60 * 1000);
});

test("search session store adds compact redirect columns to the legacy matrix schema", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-session-store-schema-"));
  tempRootsForCleanup.add(tempRoot);
  const dbPath = join(tempRoot, "fly-desk-cache.sqlite");
  const legacyDb = new Database(dbPath);
  legacyDb.exec(`
    CREATE TABLE matrix_jobs (
      id TEXT PRIMARY KEY,
      idle_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL
    );
  `);
  legacyDb.close(true);

  const store = new SearchSessionStore({ dbPath });
  store.close();

  const migratedDb = new Database(dbPath, { readonly: true });
  try {
    const columns = allSql<{ name: string }>(migratedDb, "PRAGMA table_info(matrix_jobs)")
      .map((column) => column.name);
    assert.ok(columns.includes("request_key"));
    assert.ok(columns.includes("provider_context_key"));
  } finally {
    migratedDb.close();
  }
});

function getSql<T>(db: Database, sql: string, ...params: any[]): T | undefined {
  const statement = db.prepare(sql);
  try {
    return statement.get(...params) as T | undefined;
  } finally {
    statement.finalize();
  }
}

function allSql<T>(db: Database, sql: string, ...params: any[]): T[] {
  const statement = db.prepare(sql);
  try {
    return statement.all(...params) as T[];
  } finally {
    statement.finalize();
  }
}

function buildRequest(): SearchRequest {
  return {
    tripType: "one-way",
    searchMode: "exact",
    legs: [
      {
        origin: "LIM",
        destination: "MIA",
        departureDate: "2026-04-15",
      },
    ],
    passengers: {
      adults: 1,
      children: 0,
      infants: 0,
    },
    cabin: "ECONOMY",
    filters: {},
    coverageMode: "core",
    redirectMode: "best-effort",
    currencyCode: "USD",
    locale: "es-PE",
    market: "PE",
  };
}

function buildSearchMeta(): SearchMeta {
  const now = "2026-03-27T00:00:00.000Z";
  return {
    requestedAt: now,
    completedAt: now,
    providersUsed: ["agil-local"],
    warnings: [],
    partial: false,
    searchState: "search_live",
  };
}

function buildProviderMeta(): ProviderMeta {
  return {
    exactProvider: "agil-local",
    coverageMode: "core",
  };
}

function buildOffer(id: string, url: string): CanonicalOffer {
  return {
    id,
    signature: `${id}-sig`,
    providerSource: "agil-local",
    providerOfferRef: `${id}-ref`,
    tripType: "one-way",
    validatingCarrier: "AA",
    mainCarrier: "AA",
    origin: "LIM",
    destination: "MIA",
    itineraries: [
      {
        id: `${id}-itinerary`,
        direction: "outbound",
        durationMinutes: 360,
        stops: 0,
        layoverMinutes: [],
        segments: [
          {
            id: `${id}-segment`,
            marketingCarrier: "AA",
            flightNumber: "100",
            origin: "LIM",
            destination: "MIA",
            departureAt: "2026-04-15T10:00:00Z",
            arrivalAt: "2026-04-15T16:00:00Z",
            durationMinutes: 360,
          },
        ],
      },
    ],
    price: {
      total: {
        amount: 123,
        currencyCode: "USD",
      },
    },
    priceConfidence: "live",
    priceStatus: "unverified",
    purchasePaths: [
      {
        id: `${id}-path`,
        type: "search-redirect",
        provider: "agil-local",
        label: "Buscar en Agil",
        url,
        precision: "exact-search",
        score: 0.9,
        requiresNewTab: true,
        commercialMode: "provider",
        state: "search_redirect",
      },
    ],
    comparisonMetrics: {
      totalDurationMinutes: 360,
      totalStops: 0,
      baggageScore: 0,
      purchasePathScore: 0,
    },
    tags: [],
    warnings: [],
  };
}

function buildMatrixCell(key: string, url: string): MatrixCell {
  return {
    key,
    departureDate: "2026-04-15",
    returnDate: "2026-04-22",
    stayNights: 7,
    price: {
      amount: 123,
      currencyCode: "USD",
    },
    confidence: "live",
    providerSource: "agil-local",
    selectable: true,
    requiresRequery: true,
    stateCode: "live",
    tooltip: "Agil exact search.",
    derivedRequest: {
      ...buildRequest(),
      tripType: "round-trip",
      legs: [
        {
          origin: "LIM",
          destination: "MIA",
          departureDate: "2026-04-15",
          returnDate: "2026-04-22",
        },
      ],
    },
    purchasePaths: [
      {
        id: `${key}-path`,
        type: "search-redirect",
        provider: "agil-local",
        label: "Buscar en Agil",
        url,
        precision: "exact-search",
        score: 0.9,
        requiresNewTab: true,
        commercialMode: "provider",
        state: "search_redirect",
      },
    ],
  };
}

function readSqliteCounts(dbPath: string): { searchJobs: number; matrixJobs: number; purchasePaths: number } {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      searchJobs: Number(getSql<{ count: number }>(db, "SELECT COUNT(*) AS count FROM search_jobs")?.count ?? 0),
      matrixJobs: Number(getSql<{ count: number }>(db, "SELECT COUNT(*) AS count FROM matrix_jobs")?.count ?? 0),
      purchasePaths: Number(getSql<{ count: number }>(db, "SELECT COUNT(*) AS count FROM purchase_paths")?.count ?? 0),
    };
  } finally {
    db.close();
  }
}

function buildProviderDiagnostics(kind: ProviderDiagnostics["kind"]): ProviderDiagnostics[] {
  return [{
    providerId: "agil-local",
    kind,
    status: "running",
    events: [{ name: "first_http_request", at: "2026-03-27T00:00:01.000Z" }],
  }];
}

function readSqliteSavedAt(dbPath: string): string | undefined {
  const db = new Database(dbPath, { readonly: true });
  try {
    return getSql<{ value: string }>(db, "SELECT value FROM cache_meta WHERE key = 'savedAt'")?.value;
  } finally {
    db.close();
  }
}

function installSearchJobWriteAudit(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE search_job_write_audit (
        operation TEXT NOT NULL,
        id TEXT NOT NULL
      );

      CREATE TRIGGER audit_search_job_insert
      AFTER INSERT ON search_jobs
      BEGIN
        INSERT INTO search_job_write_audit (operation, id) VALUES ('insert', NEW.id);
      END;

      CREATE TRIGGER audit_search_job_update
      AFTER UPDATE ON search_jobs
      BEGIN
        INSERT INTO search_job_write_audit (operation, id) VALUES ('update', NEW.id);
      END;

      CREATE TRIGGER audit_search_job_delete
      AFTER DELETE ON search_jobs
      BEGIN
        INSERT INTO search_job_write_audit (operation, id) VALUES ('delete', OLD.id);
      END;
    `);
  } finally {
    db.close();
  }
}

function readSearchJobWriteAudit(dbPath: string): Array<{ operation: string; id: string }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return allSql<{ operation: string; id: string }>(
      db,
      "SELECT operation, id FROM search_job_write_audit ORDER BY rowid",
    );
  } finally {
    db.close();
  }
}

test("cancelRunningJobs preserves partial cacheable results during shutdown", () => {
  const store = new SearchSessionStore();
  const message = "Search stopped because Fly Desk was restarted.";
  const partialOffer = buildOffer("partial-offer", "https://provider.example/partial");
  const partialSearch = store.createSearchJob({
    request: buildRequest(),
    offers: [partialOffer],
    allOffers: [partialOffer],
    searchMeta: {
      ...buildSearchMeta(),
      partial: true,
      searchState: "search_partial",
    },
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "running",
  });
  const emptySearch = store.createSearchJob({
    request: buildRequest(),
    offers: [],
    allOffers: [],
    searchMeta: {
      ...buildSearchMeta(),
      partial: true,
      searchState: "search_partial",
    },
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "running",
  });
  const partialMatrix = store.createMatrixJob({
    request: buildRequest(),
    cells: [buildMatrixCell("2026-04-15_2026-04-22", "https://provider.example/matrix")],
    axes: {
      departureDates: ["2026-04-15"],
      returnDates: ["2026-04-22"],
    },
    confidenceSummary: { live: 1 },
    recommendations: [],
    searchMeta: {
      ...buildSearchMeta(),
      partial: true,
      searchState: "search_partial",
    },
    providerMeta: buildProviderMeta(),
    warnings: [],
    status: "running",
  });
  const summary = store.cancelRunningJobs(message, { cachePartial: true });

  assert.deepEqual(summary, { searchJobs: 2, matrixJobs: 1 });
  const cachedSearch = store.getSearchJob(partialSearch.id);
  assert.equal(cachedSearch?.status, "completed");
  assert.equal(cachedSearch?.searchMeta.searchState, "search_partial");
  assert.equal(cachedSearch?.error, undefined);
  assert.ok(cachedSearch?.warnings.includes(message));
  assert.match(cachedSearch?.offers[0]?.purchasePaths[0]?.url ?? "", /^\/r\//);

  const cancelledSearch = store.getSearchJob(emptySearch.id);
  assert.equal(cancelledSearch?.status, "cancelled");
  assert.equal(cancelledSearch?.searchMeta.searchState, "search_cancelled");
  assert.equal(cancelledSearch?.error, message);

  const cachedMatrix = store.getMatrixJob(partialMatrix.id);
  assert.equal(cachedMatrix?.status, "completed");
  assert.equal(cachedMatrix?.searchMeta.searchState, "search_partial");
  assert.equal(cachedMatrix?.error, undefined);
  assert.ok(cachedMatrix?.warnings.includes(message));
});

test("partial cacheable results survive a shutdown persistence cycle", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-session-store-shutdown-"));
  const dbPath = join(tempRoot, "fly-desk-cache.sqlite");
  const firstStore = new SearchSessionStore({ dbPath });
  const partialOffer = buildOffer("shutdown-partial", "https://provider.example/shutdown-partial");
  const search = firstStore.createSearchJob({
    request: buildRequest(),
    offers: [partialOffer],
    allOffers: [partialOffer],
    searchMeta: {
      ...buildSearchMeta(),
      partial: true,
      searchState: "search_partial",
    },
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "running",
  });

  firstStore.cancelRunningJobs("Search stopped because Fly Desk was restarted.", {
    cachePartial: true,
  });
  firstStore.close();

  const secondStore = new SearchSessionStore({ dbPath });
  const restored = secondStore.getSearchJob(search.id);
  assert.equal(restored?.status, "completed");
  assert.equal(restored?.searchMeta.searchState, "search_partial");
  assert.equal(restored?.offers.length, 1);
  secondStore.close();

  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test("search job refresh preserves stable purchase path ids when the underlying path did not change", () => {
  const store = new SearchSessionStore();
  const request = buildRequest();
  const meta = buildSearchMeta();
  const providerMeta = buildProviderMeta();
  const offer = buildOffer("offer-1", "https://old.example/search");

  const job = store.createSearchJob({
    request,
    offers: [offer],
    allOffers: [offer],
    searchMeta: meta,
    providerMeta,
    warnings: [],
    sortMode: "cheapest",
    status: "running",
  });

  const firstSession = store.getSession(job.id);
  assert.ok(firstSession);
  const firstPathId = firstSession.offers[0]?.purchasePaths[0]?.id;
  assert.ok(firstPathId);
  assert.ok(store.resolvePurchasePath(firstPathId));

  store.updateSearchJob(job.id, (current) => ({
    ...current,
    warnings: ["progress"],
  }));

  const refreshedSession = store.getSession(job.id);
  assert.ok(refreshedSession);
  const refreshedPathId = refreshedSession.offers[0]?.purchasePaths[0]?.id;
  assert.ok(refreshedPathId);
  assert.equal(refreshedPathId, firstPathId);
  assert.ok(store.resolvePurchasePath(firstPathId));
});

test("diagnostics-only updates are volatile and preserve result versions", () => {
  const store = new SearchSessionStore();
  const offer = buildOffer("offer-diagnostics", "https://provider.example/diagnostics");
  const searchJob = store.createSearchJob({
    request: buildRequest(),
    offers: [offer],
    allOffers: [offer],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "running",
  });
  const matrixJob = store.createMatrixJob({
    request: { ...buildRequest(), tripType: "round-trip", searchMode: "roundtrip-grid" },
    cells: [buildMatrixCell("diagnostics-cell", "https://provider.example/matrix-diagnostics")],
    axes: { departureDates: ["2026-04-15"], returnDates: ["2026-04-22"] },
    confidenceSummary: { live: 1 },
    recommendations: [],
    providerMeta: buildProviderMeta(),
    searchMeta: buildSearchMeta(),
    warnings: [],
    status: "running",
  });
  const searchVersion = {
    revision: searchJob.revision,
    updatedAt: searchJob.updatedAt,
    lastAccessedAt: searchJob.lastAccessedAt,
  };
  const matrixVersion = {
    revision: matrixJob.revision,
    updatedAt: matrixJob.updatedAt,
    lastAccessedAt: matrixJob.lastAccessedAt,
  };

  const updatedSearch = store.updateSearchJob(searchJob.id, (current) => ({
    ...current,
    providerDiagnostics: buildProviderDiagnostics("exact"),
  }));
  const updatedMatrix = store.updateMatrixJob(matrixJob.id, (current) => ({
    ...current,
    providerDiagnostics: buildProviderDiagnostics("matrix"),
  }));

  assert.strictEqual(updatedSearch?.offers, searchJob.offers);
  assert.strictEqual(updatedSearch?.allOffers, searchJob.allOffers);
  assert.equal(updatedSearch?.revision, searchVersion.revision);
  assert.equal(updatedSearch?.updatedAt, searchVersion.updatedAt);
  assert.equal(updatedSearch?.lastAccessedAt, searchVersion.lastAccessedAt);
  assert.strictEqual(updatedMatrix?.cells, matrixJob.cells);
  assert.equal(updatedMatrix?.revision, matrixVersion.revision);
  assert.equal(updatedMatrix?.updatedAt, matrixVersion.updatedAt);
  assert.equal(updatedMatrix?.lastAccessedAt, matrixVersion.lastAccessedAt);
  assert.deepEqual(store.getSession(searchJob.id)?.providerDiagnostics, buildProviderDiagnostics("exact"));
  assert.deepEqual(store.getMatrixJob(matrixJob.id)?.providerDiagnostics, buildProviderDiagnostics("matrix"));
});

test("diagnostics-only updates skip sqlite rewrites without hiding pending material changes", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-session-store-diagnostics-"));
  tempRootsForCleanup.add(tempRoot);
  const dbPath = join(tempRoot, "fly-desk-cache.sqlite");
  const firstStore = new SearchSessionStore({ dbPath });
  const offer = buildOffer("offer-persisted-diagnostics", "https://provider.example/persisted-diagnostics");
  const searchJob = firstStore.createSearchJob({
    request: buildRequest(),
    offers: [offer],
    allOffers: [offer],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });
  const matrixJob = firstStore.createMatrixJob({
    request: { ...buildRequest(), tripType: "round-trip", searchMode: "roundtrip-grid" },
    cells: [buildMatrixCell("persisted-diagnostics-cell", "https://provider.example/persisted-matrix")],
    axes: { departureDates: ["2026-04-15"], returnDates: ["2026-04-22"] },
    confidenceSummary: { live: 1 },
    recommendations: [],
    providerMeta: buildProviderMeta(),
    searchMeta: buildSearchMeta(),
    warnings: [],
    status: "completed",
  });
  firstStore.close();

  const savedAt = readSqliteSavedAt(dbPath);
  assert.ok(savedAt);
  await new Promise((resolve) => setTimeout(resolve, 25));

  const secondStore = new SearchSessionStore({ dbPath });
  try {
    const searchDiagnostics = buildProviderDiagnostics("exact");
    const matrixDiagnostics = buildProviderDiagnostics("matrix");
    const updatedSearch = secondStore.updateSearchJob(searchJob.id, (current) => ({
      ...current,
      providerDiagnostics: searchDiagnostics,
    }));
    const updatedMatrix = secondStore.updateMatrixJob(matrixJob.id, (current) => ({
      ...current,
      providerDiagnostics: matrixDiagnostics,
    }));

    assert.equal(updatedSearch?.revision, searchJob.revision);
    assert.equal(updatedMatrix?.revision, matrixJob.revision);
    await new Promise((resolve) => setTimeout(resolve, 260));
    assert.equal(readSqliteSavedAt(dbPath), savedAt);

    const materialSearch = secondStore.updateSearchJob(searchJob.id, (current) => ({
      ...current,
      warnings: ["persist-search"],
    }));
    const materialMatrix = secondStore.updateMatrixJob(matrixJob.id, (current) => ({
      ...current,
      warnings: ["persist-matrix"],
    }));
    assert.equal(materialSearch?.revision, searchJob.revision + 1);
    assert.equal(materialMatrix?.revision, matrixJob.revision + 1);
    assert.deepEqual(materialSearch?.providerDiagnostics, searchDiagnostics);
    assert.deepEqual(materialMatrix?.providerDiagnostics, matrixDiagnostics);
    await new Promise((resolve) => setTimeout(resolve, 260));
  } finally {
    secondStore.close();
  }

  const thirdStore = new SearchSessionStore({ dbPath });
  try {
    assert.deepEqual(thirdStore.getSearchJob(searchJob.id)?.warnings, ["persist-search"]);
    assert.deepEqual(thirdStore.getMatrixJob(matrixJob.id)?.warnings, ["persist-matrix"]);
    assert.deepEqual(thirdStore.getSearchJob(searchJob.id)?.providerDiagnostics, buildProviderDiagnostics("exact"));
    assert.deepEqual(thirdStore.getMatrixJob(matrixJob.id)?.providerDiagnostics, buildProviderDiagnostics("matrix"));
  } finally {
    thirdStore.close();
  }
});

test("material progress stays in memory until a durable final update persists it", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-session-store-memory-progress-"));
  tempRootsForCleanup.add(tempRoot);
  const dbPath = join(tempRoot, "fly-desk-cache.sqlite");
  const store = new SearchSessionStore({ dbPath });
  const offer = buildOffer("memory-progress", "https://provider.example/memory-progress");
  const searchJob = store.createSearchJob({
    request: buildRequest(),
    offers: [offer],
    allOffers: [offer],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "running",
  });
  const matrixJob = store.createMatrixJob({
    request: { ...buildRequest(), tripType: "round-trip", searchMode: "roundtrip-grid" },
    cells: [buildMatrixCell("memory-progress-cell", "https://provider.example/memory-progress-matrix")],
    axes: { departureDates: ["2026-04-15"], returnDates: ["2026-04-22"] },
    confidenceSummary: { live: 1 },
    recommendations: [],
    providerMeta: buildProviderMeta(),
    searchMeta: buildSearchMeta(),
    warnings: [],
    status: "running",
  });
  const nextOffer = buildOffer("memory-progress-new", "https://provider.example/memory-progress-new");
  const nextCell = buildMatrixCell("memory-progress-new-cell", "https://provider.example/memory-progress-matrix-new");
  const readPersisted = () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      const search = getSql<{ payload: string }>(db, "SELECT payload FROM search_jobs WHERE id = ?", searchJob.id);
      const matrix = getSql<{ payload: string }>(db, "SELECT payload FROM matrix_jobs WHERE id = ?", matrixJob.id);
      const persistedSearch = search ? JSON.parse(search.payload) as {
        status: string;
        warnings: string[];
        allOffers: CanonicalOffer[];
      } : undefined;
      const persistedMatrix = matrix ? JSON.parse(matrix.payload) as {
        status: string;
        warnings: string[];
        cells: MatrixCell[];
      } : undefined;
      return {
        search: persistedSearch ? {
          status: persistedSearch.status,
          warnings: persistedSearch.warnings,
          offerIds: persistedSearch.allOffers.map((entry) => entry.id),
        } : undefined,
        matrix: persistedMatrix ? {
          status: persistedMatrix.status,
          warnings: persistedMatrix.warnings,
          cellKeys: persistedMatrix.cells.map((entry) => entry.key),
        } : undefined,
      };
    } finally {
      db.close();
    }
  };

  try {
    await new Promise((resolve) => setTimeout(resolve, 260));
    const savedAt = readSqliteSavedAt(dbPath);
    assert.ok(savedAt);

    const memorySearch = store.updateSearchJob(searchJob.id, (current) => ({
      ...current,
      offers: [nextOffer],
      allOffers: [nextOffer],
      warnings: ["memory-only-search"],
    }), { persist: false });
    const memoryMatrix = store.updateMatrixJob(matrixJob.id, (current) => ({
      ...current,
      cells: [nextCell],
      warnings: ["memory-only-matrix"],
    }), { persist: false });
    assert.deepEqual(memorySearch?.warnings, ["memory-only-search"]);
    assert.deepEqual(memoryMatrix?.warnings, ["memory-only-matrix"]);
    assert.deepEqual(memorySearch?.allOffers.map((entry) => entry.id), [nextOffer.id]);
    assert.deepEqual(memoryMatrix?.cells.map((entry) => entry.key), [nextCell.key]);

    const unrelatedOffer = buildOffer("unrelated-durable", "https://provider.example/unrelated-durable");
    store.createSearchJob({
      request: { ...buildRequest(), currencyCode: "PEN" },
      offers: [unrelatedOffer],
      allOffers: [unrelatedOffer],
      searchMeta: buildSearchMeta(),
      providerMeta: buildProviderMeta(),
      warnings: ["unrelated-durable"],
      sortMode: "cheapest",
      status: "completed",
    });

    await new Promise((resolve) => setTimeout(resolve, 260));
    assert.notEqual(readSqliteSavedAt(dbPath), savedAt);
    assert.deepEqual(readPersisted().search, {
      status: "running",
      warnings: [],
      offerIds: [offer.id],
    });
    assert.deepEqual(readPersisted().matrix, {
      status: "running",
      warnings: [],
      cellKeys: [matrixJob.cells[0]!.key],
    });
    const persistedPaths = new Database(dbPath, { readonly: true });
    try {
      const searchPathId = memorySearch?.offers[0]?.purchasePaths[0]?.id;
      const matrixPathId = memoryMatrix?.cells[0]?.purchasePaths?.[0]?.id;
      assert.ok(searchPathId);
      assert.ok(matrixPathId);
      assert.equal(
        getSql<{ present: number }>(persistedPaths, "SELECT 1 AS present FROM purchase_paths WHERE id = ?", searchPathId!)?.present,
        1,
      );
      assert.equal(
        getSql<{ present: number }>(persistedPaths, "SELECT 1 AS present FROM purchase_paths WHERE id = ?", matrixPathId!)?.present,
        1,
      );
    } finally {
      persistedPaths.close();
    }

    store.updateSearchJob(searchJob.id, (current) => ({
      ...current,
      status: "completed",
      warnings: [...current.warnings, "durable-final-search"],
    }));
    store.updateMatrixJob(matrixJob.id, (current) => ({
      ...current,
      status: "completed",
      warnings: [...current.warnings, "durable-final-matrix"],
    }));

    await new Promise((resolve) => setTimeout(resolve, 260));
    assert.notEqual(readSqliteSavedAt(dbPath), savedAt);
    assert.deepEqual(readPersisted().search, {
      status: "completed",
      warnings: ["memory-only-search", "durable-final-search"],
      offerIds: [nextOffer.id],
    });
    assert.deepEqual(readPersisted().matrix, {
      status: "completed",
      warnings: ["memory-only-matrix", "durable-final-matrix"],
      cellKeys: [nextCell.key],
    });
  } finally {
    store.close();
  }
});

test("memory-only progress is not captured by the job creation timer", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-session-store-deferred-create-"));
  tempRootsForCleanup.add(tempRoot);
  const dbPath = join(tempRoot, "fly-desk-cache.sqlite");
  const store = new SearchSessionStore({ dbPath });
  const initialOffer = buildOffer("deferred-initial", "https://provider.example/deferred-initial");
  const progressOffer = buildOffer("deferred-progress", "https://provider.example/deferred-progress");
  const job = store.createSearchJob({
    request: buildRequest(),
    offers: [initialOffer],
    allOffers: [initialOffer],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "running",
  });

  try {
    store.updateSearchJob(job.id, (current) => ({
      ...current,
      offers: [progressOffer],
      allOffers: [progressOffer],
    }), { persist: false });
    await new Promise((resolve) => setTimeout(resolve, 260));

    const beforeCommit = new Database(dbPath, { readonly: true });
    try {
      assert.equal(getSql<{ present: number }>(beforeCommit, "SELECT 1 AS present FROM search_jobs WHERE id = ?", job.id), null);
    } finally {
      beforeCommit.close();
    }

    store.updateSearchJob(job.id, (current) => current);
    await new Promise((resolve) => setTimeout(resolve, 260));

    const afterCommit = new Database(dbPath, { readonly: true });
    try {
      const row = getSql<{ payload: string }>(afterCommit, "SELECT payload FROM search_jobs WHERE id = ?", job.id);
      assert.deepEqual(
        (JSON.parse(row!.payload) as { allOffers: CanonicalOffer[] }).allOffers.map((offer) => offer.id),
        [progressOffer.id],
      );
    } finally {
      afterCommit.close();
    }
  } finally {
    store.close();
  }
});

test("matrix checkpoints persist result cells without empty placeholders", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-session-store-matrix-checkpoint-"));
  tempRootsForCleanup.add(tempRoot);
  const dbPath = join(tempRoot, "fly-desk-cache.sqlite");
  const store = new SearchSessionStore({ dbPath });
  const resolved = buildMatrixCell("checkpoint-resolved", "https://provider.example/checkpoint-resolved");
  const loading: MatrixCell = {
    ...resolved,
    key: "checkpoint-loading",
    confidence: "loading",
    price: undefined,
    offer: undefined,
    purchasePaths: [],
    selectable: false,
  };
  const unavailable: MatrixCell = {
    ...loading,
    key: "checkpoint-unavailable",
    confidence: "unavailable",
  };
  const job = store.createMatrixJob({
    request: { ...buildRequest(), tripType: "round-trip", searchMode: "roundtrip-grid" },
    cells: [resolved, loading, unavailable],
    axes: { departureDates: [resolved.departureDate], returnDates: [resolved.returnDate!] },
    confidenceSummary: { live: 1, loading: 1, unavailable: 1 },
    recommendations: [],
    providerMeta: buildProviderMeta(),
    searchMeta: buildSearchMeta(),
    warnings: [],
    status: "running",
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 260));
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = getSql<{ payload: string }>(db, "SELECT payload FROM matrix_jobs WHERE id = ?", job.id);
      assert.deepEqual(
        (JSON.parse(row!.payload) as { cells: MatrixCell[] }).cells.map((cell) => cell.key),
        [resolved.key],
      );
    } finally {
      db.close();
    }
  } finally {
    store.close();
  }
});

test("offer updates prune the previous purchase path ids for that offer", () => {
  const store = new SearchSessionStore();
  const request = buildRequest();
  const meta = buildSearchMeta();
  const providerMeta = buildProviderMeta();
  const offer = buildOffer("offer-1", "https://old.example/search");

  const job = store.createSearchJob({
    request,
    offers: [offer],
    allOffers: [offer],
    searchMeta: meta,
    providerMeta,
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });

  const sessionBefore = store.getSession(job.id);
  assert.ok(sessionBefore);
  const oldPathId = sessionBefore.offers[0]?.purchasePaths[0]?.id;
  assert.ok(oldPathId);

  const updated = store.updateOffer(job.id, buildOffer("offer-1", "https://new.example/search"));
  assert.ok(updated);

  const sessionAfter = store.getSession(job.id);
  assert.ok(sessionAfter);
  const newPathId = sessionAfter.offers[0]?.purchasePaths[0]?.id;
  assert.ok(newPathId);
  assert.notEqual(newPathId, oldPathId);
  assert.equal(store.resolvePurchasePath(oldPathId), undefined);

  const resolved = store.resolvePurchasePath(newPathId);
  assert.ok(resolved);
  assert.equal(resolved.path.url, "https://new.example/search");
});

test("matrix jobs rewrite and refresh purchase path ids for flexible cells", () => {
  const store = new SearchSessionStore();
  const request: SearchRequest = {
    ...buildRequest(),
    tripType: "round-trip",
    searchMode: "roundtrip-grid",
    legs: [
      {
        origin: "LIM",
        destination: "MIA",
        departureStart: "2026-04-15",
        departureEnd: "2026-04-19",
        stayNights: 4,
      },
    ],
  };
  const meta = buildSearchMeta();
  const providerMeta = buildProviderMeta();

  const job = store.createMatrixJob({
    request,
    cells: [buildMatrixCell("2026-04-15_2026-04-22", "https://old.example/flexible")],
    axes: {
      departureDates: ["2026-04-15"],
      returnDates: ["2026-04-22"],
    },
    confidenceSummary: {
      live: 1,
    },
    recommendations: [],
    providerMeta,
    searchMeta: meta,
    warnings: [],
    status: "running",
  });

  const firstPathId = job.cells[0]?.purchasePaths?.[0]?.id;
  assert.ok(firstPathId);
  assert.equal(job.cells[0]?.purchasePaths?.[0]?.url, `/r/${firstPathId}`);
  assert.ok(store.resolvePurchasePath(firstPathId));

  const updated = store.updateMatrixJob(job.id, (current) => ({
    ...current,
    cells: [buildMatrixCell("2026-04-15_2026-04-22", "https://new.example/flexible")],
  }));

  const refreshedPathId = updated?.cells[0]?.purchasePaths?.[0]?.id;
  assert.ok(refreshedPathId);
  assert.notEqual(refreshedPathId, firstPathId);
  assert.equal(store.resolvePurchasePath(firstPathId), undefined);
  assert.equal(store.resolvePurchasePath(refreshedPathId)?.path.url, "https://new.example/flexible");
});

test("findRecentCompletedSearchJob does not reuse completed Costamar searches when token changes", () => {
  const store = new SearchSessionStore();
  const request: SearchRequest = {
    ...buildRequest(),
    providerId: "costamar",
    tripType: "round-trip",
    legs: [
      {
        origin: "LIM",
        destination: "MAD",
        departureDate: "2026-06-01",
        returnDate: "2026-06-08",
      },
    ],
  };
  const baseOffer = buildOffer("offer-cache", "https://cached.example/search");
  const costamarOffer: CanonicalOffer = {
    ...baseOffer,
    providerSource: "costamar",
    purchasePaths: baseOffer.purchasePaths.map((path) => ({
      ...path,
      provider: "costamar",
      label: "Buscar en Costamar",
    })),
  };

  const completedJob = store.createSearchJob({
    request,
    providerContext: {
      costamar: {
        apiBaseUrl: "https://costamar.com.pe/vuelos/api",
        brandBaseUrl: "https://booking.clickandbook.com/vuelos",
        terminalId: "0721808110",
        token: "old-token",
        lang: "es",
      },
    },
    offers: [costamarOffer],
    allOffers: [costamarOffer],
    searchMeta: {
      ...buildSearchMeta(),
      providersUsed: ["costamar"],
    },
    providerMeta: {
      exactProvider: "costamar",
      coverageMode: "core",
    },
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });

  const reused = store.findRecentCompletedSearchJob({
    request,
    providerContext: {
      costamar: {
        apiBaseUrl: "https://costamar.com.pe/vuelos/api",
        brandBaseUrl: "https://booking.clickandbook.com/vuelos",
        terminalId: "0721808110",
        token: "fresh-token",
        lang: "es",
      },
    },
    providerIds: ["costamar"],
    sortMode: "cheapest",
    maxAgeMs: 10 * 60 * 1000,
  });

  assert.equal(reused, undefined);
});

test("findRecentCompletedMatrixJob reuses recent compatible flexible results", () => {
  const store = new SearchSessionStore();
  const request: SearchRequest = {
    ...buildRequest(),
    tripType: "round-trip",
    searchMode: "roundtrip-grid",
    flexibleMode: "exact-stay",
    legs: [
      {
        origin: "LIM",
        destination: "MIA",
        departureStart: "2026-04-15",
        departureEnd: "2026-04-19",
        stayNights: 7,
      },
    ],
  };
  const completedJob = store.createMatrixJob({
    request,
    cells: [buildMatrixCell("2026-04-15_2026-04-22", "https://cached.example/flexible")],
    axes: {
      departureDates: ["2026-04-15"],
      returnDates: ["2026-04-22"],
    },
    confidenceSummary: { live: 1 },
    recommendations: [],
    searchMeta: {
      ...buildSearchMeta(),
      completedAt: new Date().toISOString(),
    },
    providerMeta: buildProviderMeta(),
    warnings: [],
    status: "completed",
  });

  const reused = store.findRecentCompletedMatrixJob({
    request,
    providerIds: ["agil-local"],
    maxAgeMs: 10 * 60 * 1000,
  });
  const mismatchedProviders = store.findRecentCompletedMatrixJob({
    request,
    providerIds: ["costamar"],
    maxAgeMs: 10 * 60 * 1000,
  });

  assert.equal(reused?.id, completedJob.id);
  assert.equal(mismatchedProviders, undefined);
});

test("findRecentCompletedSearchJob ignores completed searches from a previous cache version", () => {
  const store = new SearchSessionStore();
  const request = buildRequest();
  const offer = buildOffer("offer-legacy-cache", "https://cached.example/legacy");
  const completedJob = store.createSearchJob({
    request,
    offers: [offer],
    allOffers: [offer],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });

  assert.equal(completedJob.searchMeta.cacheVersion, SEARCH_CACHE_VERSION);
  delete completedJob.searchMeta.cacheVersion;

  const reused = store.findRecentCompletedSearchJob({
    request,
    providerIds: ["agil-local"],
    sortMode: "cheapest",
    maxAgeMs: 10 * 60 * 1000,
  });

  assert.equal(reused, undefined);
});

test("findRecentCompletedSearchJob expires prices from completedAt despite polling", () => {
  const store = new SearchSessionStore();
  const request = buildRequest();
  const completedAtMs = Date.now() - 60_000;
  const offer = buildOffer("offer-polled-cache", "https://cached.example/polled");
  const job = store.createSearchJob({
    request,
    offers: [offer],
    allOffers: [offer],
    searchMeta: {
      ...buildSearchMeta(),
      completedAt: new Date(completedAtMs).toISOString(),
    },
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });

  assert.ok(store.getSearchJob(job.id));
  assert.ok(store.getSession(job.id));
  const reused = store.findRecentCompletedSearchJob({
    request,
    providerIds: ["agil-local"],
    sortMode: "cheapest",
    maxAgeMs: 30_000,
    nowMs: completedAtMs + 60_000,
  });

  assert.equal(reused, undefined);
});

test("findRecentCompletedSearchJob uses updatedAt for legacy jobs without completedAt", () => {
  const store = new SearchSessionStore();
  const request = buildRequest();
  const completedAtMs = Date.now() - 60_000;
  const offer = buildOffer("offer-legacy-timestamp", "https://cached.example/legacy-timestamp");
  const job = store.createSearchJob({
    request,
    offers: [offer],
    allOffers: [offer],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });
  delete (job.searchMeta as Partial<SearchMeta>).completedAt;
  job.createdAt = new Date(completedAtMs - 1_000).toISOString();
  job.updatedAt = new Date(completedAtMs).toISOString();

  assert.ok(store.getSearchJob(job.id));
  const reused = store.findRecentCompletedSearchJob({
    request,
    providerIds: ["agil-local"],
    sortMode: "cheapest",
    maxAgeMs: 30_000,
    nowMs: completedAtMs + 60_000,
  });

  assert.equal(reused, undefined);
});

test("findRecentCompletedSearchJob ignores expired or incompatible completed searches", () => {
  const store = new SearchSessionStore();
  const request = buildRequest();
  const offer = buildOffer("offer-expired", "https://expired.example/search");

  const completedJob = store.createSearchJob({
    request,
    offers: [offer],
    allOffers: [offer],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });

  const expired = store.findRecentCompletedSearchJob({
    request,
    providerIds: ["agil-local"],
    sortMode: "cheapest",
    maxAgeMs: 1,
    nowMs: Date.now() + 60_000,
  });
  assert.equal(expired, undefined);

  const mismatchedProviderIds = store.findRecentCompletedSearchJob({
    request,
    providerIds: ["costamar"],
    sortMode: "cheapest",
    maxAgeMs: 10 * 60 * 1000,
  });
  assert.equal(mismatchedProviderIds, undefined);

  const mismatchedSort = store.findRecentCompletedSearchJob({
    request,
    providerIds: ["agil-local"],
    sortMode: "fastest",
    maxAgeMs: 10 * 60 * 1000,
  });
  assert.equal(mismatchedSort, undefined);

  assert.ok(store.getSearchJob(completedJob.id));
});

test("completed jobs and their purchase paths expire after the idle ttl, while running jobs stay alive", () => {
  const store = new SearchSessionStore();
  const request = buildRequest();
  const meta = buildSearchMeta();
  const providerMeta = buildProviderMeta();
  const completedOffer = buildOffer("offer-completed", "https://completed.example/search");
  const runningOffer = buildOffer("offer-running", "https://running.example/search");

  const completedJob = store.createSearchJob({
    request,
    offers: [completedOffer],
    allOffers: [completedOffer],
    searchMeta: meta,
    providerMeta,
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });
  const runningJob = store.createSearchJob({
    request,
    offers: [runningOffer],
    allOffers: [runningOffer],
    searchMeta: meta,
    providerMeta,
    warnings: [],
    sortMode: "cheapest",
    status: "running",
  });
  const matrixJob = store.createMatrixJob({
    request: {
      ...request,
      tripType: "round-trip",
      searchMode: "roundtrip-grid",
    },
    cells: [buildMatrixCell("2026-04-15_2026-04-22", "https://matrix.example/flexible")],
    axes: {
      departureDates: ["2026-04-15"],
      returnDates: ["2026-04-22"],
    },
    confidenceSummary: { live: 1 },
    recommendations: [],
    providerMeta,
    searchMeta: meta,
    warnings: [],
    status: "completed",
  });

  const completedPathId = store.getSession(completedJob.id)?.offers[0]?.purchasePaths[0]?.id;
  const runningPathId = store.getSession(runningJob.id)?.offers[0]?.purchasePaths[0]?.id;
  const matrixPathId = store.getMatrixJob(matrixJob.id)?.cells[0]?.purchasePaths?.[0]?.id;
  assert.ok(completedPathId);
  assert.ok(runningPathId);
  assert.ok(matrixPathId);

  const purgeSummary = store.purgeExpired(Date.now() + COMPLETED_SEARCH_SESSION_TTL_MS + 1000);

  assert.equal(purgeSummary.searchJobs, 1);
  assert.equal(purgeSummary.matrixJobs, 1);
  assert.equal(store.getSearchJob(completedJob.id), undefined);
  assert.equal(store.getMatrixJob(matrixJob.id), undefined);
  assert.equal(store.resolvePurchasePath(completedPathId!), undefined);
  assert.equal(store.resolvePurchasePath(matrixPathId!), undefined);
  assert.ok(store.getSearchJob(runningJob.id));
  assert.ok(store.resolvePurchasePath(runningPathId!));
});

test("search session store persists completed cache and running redirect snapshots in sqlite", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-session-store-persist-"));
  const dbPath = join(tempRoot, "fly-desk-cache.sqlite");
  const request = buildRequest();
  const meta = buildSearchMeta();
  const providerMeta = buildProviderMeta();

  const firstStore = new SearchSessionStore({ dbPath });
  const completedOffer = buildOffer("offer-persisted", "https://persisted.example/search");
  const completedSearchJob = firstStore.createSearchJob({
    request,
    offers: [completedOffer],
    allOffers: [completedOffer],
    searchMeta: meta,
    providerMeta,
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });
  const runningSearchJob = firstStore.createSearchJob({
    request,
    offers: [buildOffer("offer-running", "https://running.example/search")],
    allOffers: [buildOffer("offer-running", "https://running.example/search")],
    searchMeta: meta,
    providerMeta,
    warnings: [],
    sortMode: "cheapest",
    status: "running",
  });
  const completedMatrixJob = firstStore.createMatrixJob({
    request: {
      ...request,
      tripType: "round-trip",
      searchMode: "roundtrip-grid",
    },
    cells: [buildMatrixCell("2026-04-15_2026-04-22", "https://persisted.example/flexible")],
    axes: {
      departureDates: ["2026-04-15"],
      returnDates: ["2026-04-22"],
    },
    confidenceSummary: { live: 1 },
    recommendations: [],
    providerMeta,
    searchMeta: meta,
    warnings: [],
    status: "completed",
  });

  await new Promise((resolve) => setTimeout(resolve, 260));
  firstStore.close();

  const counts = readSqliteCounts(dbPath);
  assert.equal(counts.searchJobs, 2);
  assert.equal(counts.matrixJobs, 1);
  assert.equal(counts.purchasePaths, 3);

  const secondStore = new SearchSessionStore({ dbPath });
  const restoredSearch = secondStore.getSearchJob(completedSearchJob.id);
  const restoredMatrix = secondStore.getMatrixJob(completedMatrixJob.id);
  const restoredRunning = secondStore.getSearchJob(runningSearchJob.id);
  const restoredPathId = restoredSearch?.allOffers[0]?.purchasePaths[0]?.id;

  assert.ok(restoredSearch);
  assert.ok(restoredMatrix);
  assert.equal(restoredRunning, undefined);
  assert.ok(restoredPathId);
  assert.ok(secondStore.resolvePurchasePath(restoredPathId!));
  secondStore.close();

  rmSync(tempRoot, { recursive: true, force: true });
});

test("the sweep seeks its rows instead of reading the table", () => {
  /*
   * The prune used to say «status != 'completed' OR idle_at_ms < ?», which
   * SQLite cannot seek: it answered by scanning the table, and this table's
   * rows carry the payloads. On the production box that was 16.6 seconds of a
   * 22-second boot — spent deleting nothing, because nothing had expired — and
   * the boot is what the port waits for, so it was also a failed deployment
   * and a rollback that could not recover inside its own health window.
   *
   * Each statement is held against the planner here. A scan is the defect.
   */
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-session-store-sweep-plan-"));
  const dbPath = join(tempRoot, "fly-desk-cache.sqlite");
  const store = new SearchSessionStore({ dbPath });
  const offer = buildOffer("offer-plan", "https://plan.example/search");
  store.createSearchJob({
    request: buildRequest(),
    offers: [offer],
    allOffers: [offer],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });
  store.close();

  const db = new Database(dbPath);
  try {
    assert.ok(PERSISTED_SWEEP_STATEMENTS.length >= 5);
    for (const statement of PERSISTED_SWEEP_STATEMENTS) {
      const plan = db.query<{ detail: string }, [number]>(`EXPLAIN QUERY PLAN ${statement}`)
        .all(0)
        .map((row) => row.detail)
        .join(" | ");
      assert.match(plan, /USING (COVERING )?INDEX/, `${statement} -> ${plan}`);
      assert.doesNotMatch(plan, /SCAN (search_jobs|matrix_jobs)/, `${statement} -> ${plan}`);
    }
  } finally {
    db.close(true);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("search session store prunes expired sqlite rows before loading their payloads", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-session-store-prune-before-load-"));
  const dbPath = join(tempRoot, "fly-desk-cache.sqlite");
  const firstStore = new SearchSessionStore({ dbPath });
  const offer = buildOffer("offer-expired", "https://expired.example/search");
  const job = firstStore.createSearchJob({
    request: buildRequest(),
    offers: [offer],
    allOffers: [offer],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });
  firstStore.close();

  const db = new Database(dbPath);
  db.run(
    "UPDATE search_jobs SET idle_at_ms = ? WHERE id = ?",
    Date.now() - COMPLETED_SEARCH_SESSION_TTL_MS - 1,
    job.id,
  );
  db.close(true);

  const secondStore = new SearchSessionStore({ dbPath });
  assert.equal(secondStore.getSearchJob(job.id), undefined);
  secondStore.close();
  assert.deepEqual(readSqliteCounts(dbPath), {
    searchJobs: 0,
    matrixJobs: 0,
    purchasePaths: 0,
  });

  rmSync(tempRoot, { recursive: true, force: true });
});

test("search session store hydrates only the newest jobs and keeps the rest available from disk", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-session-store-budget-"));
  tempRootsForCleanup.add(tempRoot);
  const dbPath = join(tempRoot, "fly-desk-cache.sqlite");
  const firstStore = new SearchSessionStore({ dbPath });
  const request = buildRequest();
  const meta = buildSearchMeta();
  const providerMeta = buildProviderMeta();

  const jobs = ["oldest", "middle", "newest"].map((label) => {
    const pathPayload = label === "newest" ? `?payload=${"x".repeat(32_768)}` : "";
    const offer = buildOffer(`offer-${label}`, `https://${label}.example/search${pathPayload}`);
    const job = firstStore.createSearchJob({
      request,
      offers: [offer],
      allOffers: [offer],
      searchMeta: meta,
      providerMeta,
      warnings: [`${label}:${"x".repeat(4_096)}`],
      sortMode: "cheapest",
      status: "completed",
    });
    return {
      job,
      pathId: firstStore.getSession(job.id)?.offers[0]?.purchasePaths[0]?.id,
    };
  });
  jobs.forEach(({ pathId }) => assert.ok(pathId));
  firstStore.close();

  const db = new Database(dbPath);
  const nowMs = Date.now();
  jobs.forEach(({ job }, index) => {
    db.run("UPDATE search_jobs SET idle_at_ms = ? WHERE id = ?", nowMs - (jobs.length - index) * 1_000, job.id);
  });
  const payloadSizes = new Map(
    db.query<{ id: string; bytes: number }, []>(
      `
        SELECT
          search_jobs.id,
          length(CAST(search_jobs.payload AS BLOB))
            + COALESCE(SUM(length(CAST(purchase_paths.payload AS BLOB))), 0) AS bytes
        FROM search_jobs
        LEFT JOIN purchase_paths ON purchase_paths.session_id = search_jobs.id
        GROUP BY search_jobs.id
      `,
    ).all().map((row) => [row.id, row.bytes]),
  );
  const restoreBudgetBytes = payloadSizes.get(jobs[1]!.job.id)! + payloadSizes.get(jobs[2]!.job.id)!;
  db.close(true);

  const secondStore = new SearchSessionStore({
    dbPath,
    persistedRestoreBudgetBytes: restoreBudgetBytes,
  });
  try {
    const diskOnlyJob = secondStore.getSearchJob(jobs[0]!.job.id);
    assert.ok(diskOnlyJob);
    assert.ok(secondStore.getSearchJob(jobs[1]!.job.id));
    assert.ok(secondStore.getSearchJob(jobs[2]!.job.id));
    assert.equal(secondStore.getSession(jobs[0]!.job.id)?.offers[0]?.id, "offer-oldest");
    assert.equal(secondStore.getOffer(jobs[0]!.job.id, "offer-oldest")?.id, "offer-oldest");
    assert.equal(
      secondStore.resolvePurchasePath(jobs[0]!.pathId!)?.path.url,
      "https://oldest.example/search",
    );
    assert.ok(secondStore.resolvePurchasePath(jobs[1]!.pathId!));
    assert.ok(secondStore.resolvePurchasePath(jobs[2]!.pathId!));
    const residentCache = secondStore.getDiagnostics().residentCache;
    assert.equal(residentCache.completedJobs, 2);
    assert.equal(residentCache.diskOnlyJobs, 1);
    assert.ok(residentCache.completedBytes > 0);
    assert.ok(residentCache.diskOnlyBytes > 0);
  } finally {
    secondStore.close();
  }

  const counts = readSqliteCounts(dbPath);
  assert.equal(counts.searchJobs, 3);
  assert.equal(counts.purchasePaths, 3);
});

test("persisted cache budget counts matrix purchase paths before restoring", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-session-store-matrix-budget-"));
  tempRootsForCleanup.add(tempRoot);
  const dbPath = join(tempRoot, "fly-desk-cache.sqlite");
  const firstStore = new SearchSessionStore({ dbPath });
  const request = buildRequest();
  const providerMeta = buildProviderMeta();
  const searchJob = firstStore.createSearchJob({
    request,
    offers: [buildOffer("budget-search", "https://search.example/flexible")],
    allOffers: [buildOffer("budget-search", "https://search.example/flexible")],
    searchMeta: buildSearchMeta(),
    providerMeta,
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });
  const matrixJob = firstStore.createMatrixJob({
    request: { ...request, tripType: "round-trip", searchMode: "roundtrip-grid" },
    cells: [buildMatrixCell("budget-matrix", `https://matrix.example/flexible?payload=${"x".repeat(64_000)}`)],
    axes: { departureDates: ["2026-04-15"], returnDates: ["2026-04-22"] },
    confidenceSummary: { live: 1 },
    recommendations: [],
    providerMeta,
    searchMeta: buildSearchMeta(),
    warnings: [],
    status: "completed",
  });
  const matrixPathId = firstStore.getMatrixJob(matrixJob.id)?.cells[0]?.purchasePaths?.[0]?.id;
  assert.ok(matrixPathId);
  firstStore.close();

  const db = new Database(dbPath);
  const nowMs = Date.now();
  db.run("UPDATE search_jobs SET idle_at_ms = ? WHERE id = ?", nowMs - 2_000, searchJob.id);
  db.run("UPDATE matrix_jobs SET idle_at_ms = ? WHERE id = ?", nowMs - 1_000, matrixJob.id);
  const searchBytes = getSql<{ bytes: number }>(db, "SELECT length(CAST(payload AS BLOB)) AS bytes FROM search_jobs WHERE id = ?", searchJob.id)!.bytes;
  const matrixBytes = getSql<{ bytes: number }>(db, `
    SELECT length(CAST(matrix_jobs.payload AS BLOB))
      + COALESCE(SUM(length(CAST(purchase_paths.payload AS BLOB))), 0) AS bytes
    FROM matrix_jobs
    LEFT JOIN purchase_paths ON purchase_paths.session_id = matrix_jobs.id
    WHERE matrix_jobs.id = ?
    GROUP BY matrix_jobs.id
  `, matrixJob.id)!.bytes;
  db.close(true);
  assert.ok(matrixBytes > searchBytes);

  const secondStore = new SearchSessionStore({ dbPath, persistedRestoreBudgetBytes: matrixBytes - 1 });
  try {
    assert.ok(secondStore.getSearchJob(searchJob.id));
    assert.ok(secondStore.getMatrixJob(matrixJob.id));
    assert.equal(secondStore.resolvePurchasePath(matrixPathId!)?.path.url.startsWith("https://matrix.example/flexible"), true);
    const residentCache = secondStore.getDiagnostics().residentCache;
    assert.equal(residentCache.completedJobs, 1);
    assert.equal(residentCache.diskOnlyJobs, 1);
  } finally {
    secondStore.close();
  }

  assert.deepEqual(readSqliteCounts(dbPath), {
    searchJobs: 1,
    matrixJobs: 1,
    purchasePaths: 2,
  });
});

test("resident cache budget rechecks automatically when the completion grace expires", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-session-store-resident-timer-"));
  tempRootsForCleanup.add(tempRoot);
  const dbPath = join(tempRoot, "fly-desk-cache.sqlite");
  /* Seeded from the real clock so the record timestamps the store stamps
     itself stay consistent with the time it is told. */
  const clock = createManualScheduler(Date.now());
  const store = new SearchSessionStore({
    dbPath,
    completedResidentBudgetBytes: 0,
    scheduler: clock.scheduler,
  });
  const offer = buildOffer("resident-timer", "https://resident.example/timer");
  store.createSearchJob({
    request: buildRequest(),
    offers: [offer],
    allOffers: [offer],
    searchMeta: {
      ...buildSearchMeta(),
      completedAt: new Date(clock.now()).toISOString(),
    },
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });

  try {
    /* The debounce fires the first sweep. The job is still inside its grace, so
       the sweep has to keep it and arm the recheck rather than evict. */
    clock.advance(SESSION_STORE_PERSIST_DEBOUNCE_MS);
    assert.equal(store.getDiagnostics().residentCache.completedJobs, 1);

    /* Nothing below touches the store before the assertions: the recheck the
       sweep armed is the only thing that can evict, which is the whole claim. */
    clock.advance(COMPLETED_SEARCH_SESSION_RESIDENT_GRACE_MS);

    assert.equal(store.getDiagnostics().residentCache.completedJobs, 0);
    assert.equal(store.getDiagnostics().residentCache.diskOnlyJobs, 1);
  } finally {
    store.close();
  }
});

test("resident cache budget keeps running and newly completed jobs, then evicts only completed memory", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-session-store-resident-grace-"));
  tempRootsForCleanup.add(tempRoot);
  const dbPath = join(tempRoot, "fly-desk-cache.sqlite");
  const store = new SearchSessionStore({
    dbPath,
    completedResidentBudgetBytes: 0,
  });
  const completedAtMs = Date.now();
  const completedOffer = buildOffer("resident-completed", "https://resident.example/completed");
  const runningOffer = buildOffer("resident-running", "https://resident.example/running");
  const completed = store.createSearchJob({
    request: buildRequest(),
    offers: [completedOffer],
    allOffers: [completedOffer],
    searchMeta: {
      ...buildSearchMeta(),
      completedAt: new Date(completedAtMs).toISOString(),
    },
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });
  const running = store.createSearchJob({
    request: buildRequest(),
    offers: [runningOffer],
    allOffers: [runningOffer],
    searchMeta: {
      ...buildSearchMeta(),
      completedAt: "",
    },
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "running",
  });
  const matrix = store.createMatrixJob({
    request: { ...buildRequest(), tripType: "round-trip", searchMode: "roundtrip-grid" },
    cells: [buildMatrixCell("resident-matrix", "https://resident.example/matrix")],
    axes: { departureDates: ["2026-04-15"], returnDates: ["2026-04-22"] },
    confidenceSummary: { live: 1 },
    recommendations: [],
    providerMeta: buildProviderMeta(),
    searchMeta: {
      ...buildSearchMeta(),
      completedAt: new Date(completedAtMs).toISOString(),
    },
    warnings: [],
    status: "completed",
  });
  const completedPathId = completed.offers[0]?.purchasePaths[0]?.id;
  const matrixPathId = matrix.cells[0]?.purchasePaths?.[0]?.id;
  assert.ok(completedPathId);
  assert.ok(matrixPathId);

  await new Promise((resolve) => setTimeout(resolve, 260));
  store.enforceCompletedResidentBudget(completedAtMs + 4_999);
  const completedBeforeEviction = store.getSearchJob(completed.id);
  assert.ok(completedBeforeEviction);
  assert.ok(store.getSearchJob(running.id));
  const matrixBeforeEviction = store.getMatrixJob(matrix.id);
  assert.ok(matrixBeforeEviction);
  const completedIdleAtMs = Date.parse(completedBeforeEviction.lastAccessedAt);
  const matrixIdleAtMs = Date.parse(matrixBeforeEviction.lastAccessedAt);

  store.enforceCompletedResidentBudget(completedAtMs + 5_001);
  assert.ok(store.getSearchJob(completed.id));
  assert.ok(store.getSearchJob(running.id));
  assert.ok(store.getMatrixJob(matrix.id));
  assert.equal(store.resolvePurchasePath(completedPathId!)?.path.url, "https://resident.example/completed");
  assert.equal(store.resolvePurchasePath(matrixPathId!)?.path.url, "https://resident.example/matrix");
  assert.deepEqual(store.getRedirectContext(completed.id)?.request, buildRequest());
  assert.equal(store.getRedirectContext(matrix.id)?.request.searchMode, "roundtrip-grid");
  const residentDiagnostics = store.getDiagnostics().residentCache;
  assert.equal(residentDiagnostics.budgetBytes, 0);
  assert.equal(residentDiagnostics.completedJobs, 0);
  assert.equal(residentDiagnostics.completedBytes, 0);
  assert.equal(residentDiagnostics.diskOnlyJobs, 2);
  assert.ok(residentDiagnostics.diskOnlyBytes > 0);
  assert.deepEqual(readSqliteCounts(dbPath), {
    searchJobs: 2,
    matrixJobs: 1,
    purchasePaths: 3,
  });
  store.purgeExpired(Math.max(completedIdleAtMs, matrixIdleAtMs) + COMPLETED_SEARCH_SESSION_TTL_MS + 1);
  assert.equal(store.resolvePurchasePath(completedPathId!), undefined);
  assert.equal(store.resolvePurchasePath(matrixPathId!), undefined);
  assert.deepEqual(readSqliteCounts(dbPath), {
    searchJobs: 1,
    matrixJobs: 0,
    purchasePaths: 1,
  });
  store.close();
});

test("resident budget counts running jobs, so a live sweep evicts finished ones sooner", async () => {
  /*
   * The budget used to skip everything that was not `completed`, so the jobs
   * costing the most memory were exactly the ones it could not see. A migratory
   * sweep is one server search job per month, up to twelve at once, each holding
   * its full `allOffers` — and while the later months ran, the finished ones sat
   * resident under a budget that believed it had room.
   *
   * Running jobs are counted but never evicted: cancelling live work to save
   * memory answers the wrong question. What they do is bring the eviction of
   * completed jobs forward.
   */
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-session-store-inflight-budget-"));
  tempRootsForCleanup.add(tempRoot);
  const dbPath = join(tempRoot, "fly-desk-cache.sqlite");
  const completedAtMs = Date.now() - 60_000;

  /* How big one completed job is. The budget has to be expressed in the same
     units the enforcement counts in, so it is measured rather than guessed —
     one store per path, reopened, as the LRU case above does. */
  const measureStore = new SearchSessionStore({ dbPath });
  const sample = buildOffer("budget-sample", "https://resident.example/sample");
  measureStore.createSearchJob({
    request: buildRequest(),
    offers: [sample],
    allOffers: [sample],
    searchMeta: { ...buildSearchMeta(), completedAt: new Date(completedAtMs).toISOString() },
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });
  // The persist is debounced, so the bytes are not in SQLite the instant the
  // job is created — and a budget measured before the write is zero.
  await new Promise((resolve) => setTimeout(resolve, 260));
  const perJobBytes = measureStore.getDiagnostics().residentCache.completedBytes;
  // On its own it fits that budget exactly and survives.
  measureStore.enforceCompletedResidentBudget(Date.now());
  const measuredJobs = measureStore.getDiagnostics().residentCache.completedJobs;
  measureStore.close();
  assert.ok(perJobBytes > 0, "no measurable payload");
  assert.equal(measuredJobs, 1);

  // Same budget, same completed job — but now with a sweep running beside it.
  // A separate file in the same root, so the measured job is not restored into
  // this store and counted twice.
  const store = new SearchSessionStore({
    dbPath: join(tempRoot, "sweep.sqlite"),
    completedResidentBudgetBytes: perJobBytes,
  });
  const finishedOffer = buildOffer("budget-finished", "https://resident.example/finished");
  const finished = store.createSearchJob({
    request: buildRequest(),
    offers: [finishedOffer],
    allOffers: [finishedOffer],
    searchMeta: { ...buildSearchMeta(), completedAt: new Date(completedAtMs).toISOString() },
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });

  // Under the old accounting these two were invisible, so `finished` stayed.
  const runningOffer = buildOffer("budget-running-a", "https://resident.example/running-a");
  store.createSearchJob({
    request: { ...buildRequest(), currencyCode: "PEN" },
    offers: [runningOffer],
    allOffers: [runningOffer],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "running",
  });
  const secondRunningOffer = buildOffer("budget-running-b", "https://resident.example/running-b");
  const secondRunning = store.createSearchJob({
    request: { ...buildRequest(), currencyCode: "USD", adults: 2 },
    offers: [secondRunningOffer],
    allOffers: [secondRunningOffer],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "running",
  });

  await new Promise((resolve) => setTimeout(resolve, 260));
  store.enforceCompletedResidentBudget(Date.now());

  const diagnostics = store.getDiagnostics().residentCache;
  // The live sweep is untouched — counted, never cancelled — and the finished
  // job is still served, from disk.
  const sweepAlive = Boolean(store.getSearchJob(secondRunning.id));
  const finishedStillServed = Boolean(store.getSearchJob(finished.id));
  store.close();

  assert.equal(diagnostics.completedJobs, 0, JSON.stringify(diagnostics));
  assert.equal(diagnostics.diskOnlyJobs, 1, JSON.stringify(diagnostics));
  assert.ok(sweepAlive);
  assert.ok(finishedStillServed);
});

test("resident cache evicts least recently used completed jobs without deleting persisted redirects", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-session-store-resident-lru-"));
  tempRootsForCleanup.add(tempRoot);
  const dbPath = join(tempRoot, "fly-desk-cache.sqlite");
  const firstStore = new SearchSessionStore({ dbPath });
  const oldOffer = buildOffer("resident-old", "https://resident.example/old");
  const recentOffer = buildOffer("resident-recent", "https://resident.example/recent");
  const oldJob = firstStore.createSearchJob({
    request: buildRequest(),
    offers: [oldOffer],
    allOffers: [oldOffer],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const recentJob = firstStore.createSearchJob({
    request: { ...buildRequest(), currencyCode: "PEN" },
    offers: [recentOffer],
    allOffers: [recentOffer],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });
  const oldPathId = oldJob.offers[0]?.purchasePaths[0]?.id;
  assert.ok(oldPathId);
  firstStore.close();

  const db = new Database(dbPath, { readonly: true });
  const residentBudgetBytes = getSql<{ bytes: number }>(db, `
    SELECT length(CAST(search_jobs.payload AS BLOB))
      + COALESCE(SUM(length(CAST(purchase_paths.payload AS BLOB))), 0) AS bytes
    FROM search_jobs
    LEFT JOIN purchase_paths ON purchase_paths.session_id = search_jobs.id
    WHERE search_jobs.id = ?
    GROUP BY search_jobs.id
  `, recentJob.id)!.bytes;
  db.close();

  const budgetedStore = new SearchSessionStore({ dbPath, completedResidentBudgetBytes: residentBudgetBytes });
  budgetedStore.enforceCompletedResidentBudget(Date.now() + 5_001);
  assert.ok(budgetedStore.getSearchJob(oldJob.id));
  assert.ok(budgetedStore.getSearchJob(recentJob.id));
  assert.equal(budgetedStore.getDiagnostics().residentCache.completedJobs, 1);
  assert.equal(budgetedStore.getDiagnostics().residentCache.diskOnlyJobs, 1);
  assert.equal(budgetedStore.resolvePurchasePath(oldPathId!)?.path.url, "https://resident.example/old");
  assert.deepEqual(readSqliteCounts(dbPath), {
    searchJobs: 2,
    matrixJobs: 0,
    purchasePaths: 2,
  });
  budgetedStore.close();

  const reopenedStore = new SearchSessionStore({ dbPath });
  try {
    assert.ok(reopenedStore.getSearchJob(oldJob.id));
    assert.ok(reopenedStore.getSearchJob(recentJob.id));
    assert.equal(reopenedStore.resolvePurchasePath(oldPathId!)?.path.url, "https://resident.example/old");
  } finally {
    reopenedStore.close();
  }
});

test("search session store persists completed search jobs without truncating offers", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-session-store-unbounded-"));
  const dbPath = join(tempRoot, "fly-desk-cache.sqlite");
  const request = buildRequest();
  const offers = Array.from({ length: 390 }, (_, index) =>
    buildOffer(`offer-${index + 1}`, `https://persisted.example/search/${index + 1}`),
  );

  const firstStore = new SearchSessionStore({ dbPath });
  const job = firstStore.createSearchJob({
    request,
    offers,
    allOffers: offers,
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });
  firstStore.close();

  const secondStore = new SearchSessionStore({ dbPath });
  const restored = secondStore.getSearchJob(job.id);

  assert.equal(restored?.offers.length, 390);
  assert.equal(restored?.allOffers.length, 390);
  assert.equal(restored?.allOffers[389]?.id, "offer-390");
  secondStore.close();

  rmSync(tempRoot, { recursive: true, force: true });
});

test("search session store avoids rewriting an unchanged sqlite snapshot after load", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-session-store-no-rewrite-"));
  const dbPath = join(tempRoot, "fly-desk-cache.sqlite");
  const request = buildRequest();
  const meta = buildSearchMeta();
  const providerMeta = buildProviderMeta();

  const firstStore = new SearchSessionStore({ dbPath });
  const offer = buildOffer("offer-stable", "https://stable.example/search");
  firstStore.createSearchJob({
    request,
    offers: [offer],
    allOffers: [offer],
    searchMeta: meta,
    providerMeta,
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });
  await new Promise((resolve) => setTimeout(resolve, 260));
  firstStore.close();

  const firstSavedAt = readSqliteSavedAt(dbPath);
  assert.ok(firstSavedAt);

  await new Promise((resolve) => setTimeout(resolve, 25));
  const secondStore = new SearchSessionStore({ dbPath });
  secondStore.close();

  assert.equal(readSqliteSavedAt(dbPath), firstSavedAt);

  rmSync(tempRoot, { recursive: true, force: true });
});

test("search session store only writes the search job that changed", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-session-store-incremental-"));
  const dbPath = join(tempRoot, "fly-desk-cache.sqlite");
  const firstStore = new SearchSessionStore({ dbPath });
  const changedJob = firstStore.createSearchJob({
    request: buildRequest(),
    offers: [buildOffer("offer-changed", "https://changed.example/search")],
    allOffers: [buildOffer("offer-changed", "https://changed.example/search")],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });
  const untouchedJob = firstStore.createSearchJob({
    request: buildRequest(),
    offers: [buildOffer("offer-untouched", "https://untouched.example/search")],
    allOffers: [buildOffer("offer-untouched", "https://untouched.example/search")],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });
  firstStore.close();
  installSearchJobWriteAudit(dbPath);

  const secondStore = new SearchSessionStore({ dbPath });
  secondStore.updateSearchJob(changedJob.id, (current) => ({
    ...current,
    warnings: ["updated"],
  }));
  await new Promise((resolve) => setTimeout(resolve, 260));
  secondStore.close();

  assert.deepEqual(readSearchJobWriteAudit(dbPath), [
    { operation: "update", id: changedJob.id },
  ]);
  const verificationStore = new SearchSessionStore({ dbPath });
  assert.ok(verificationStore.getSearchJob(untouchedJob.id));
  verificationStore.close();

  rmSync(tempRoot, { recursive: true, force: true });
});


/*
 * The two durability edges the contract used to list as "still missing": what
 * happens to a write the disk refuses, and what `SEARCH_COMPLETED_SESSION_TTL_MS=0`
 * actually means. Both are now policy, and these are what hold them.
 */

test("a refused session write is owed, not dropped: nothing retries on its own and the next mutation carries it", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-session-store-write-refused-"));
  tempRootsForCleanup.add(tempRoot);
  const dbPath = join(tempRoot, "fly-desk-cache.sqlite");
  const store = new SearchSessionStore({ dbPath });
  const connection = (store as unknown as { db?: Database }).db;
  assert.ok(connection);

  let before: ReturnType<SearchSessionStore["createSearchJob"]>;
  let during: ReturnType<SearchSessionStore["createSearchJob"]>;
  let after: ReturnType<SearchSessionStore["createSearchJob"]>;
  try {
    before = store.createSearchJob({
      request: buildRequest(),
      offers: [buildOffer("offer-before-outage", "https://before.example/search")],
      allOffers: [buildOffer("offer-before-outage", "https://before.example/search")],
      searchMeta: buildSearchMeta(),
      providerMeta: buildProviderMeta(),
      warnings: [],
      sortMode: "cheapest",
      status: "completed",
    });
    await new Promise((resolve) => setTimeout(resolve, 260));
    assert.equal(readSqliteCounts(dbPath).searchJobs, 1);

    // The disk refuses everything from here: `query_only` is per connection, so
    // this is the store's own handle failing its transaction, not a fixture.
    connection!.run("PRAGMA query_only = ON");
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      during = store.createSearchJob({
        request: buildRequest(),
        offers: [buildOffer("offer-during-outage", "https://during.example/search")],
        allOffers: [buildOffer("offer-during-outage", "https://during.example/search")],
        searchMeta: buildSearchMeta(),
        providerMeta: buildProviderMeta(),
        warnings: [],
        sortMode: "cheapest",
        status: "completed",
      });
      // Three debounce windows with no mutation in them. A store that armed a
      // retry of its own would have spoken again inside that stretch.
      await new Promise((resolve) => setTimeout(resolve, 560));
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(readSqliteCounts(dbPath).searchJobs, 1);
    // The failure is said out loud exactly once — one refused write, one line.
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.match(warnings[0]!, /session cache write failed/);

    connection!.run("PRAGMA query_only = OFF");
    after = store.createSearchJob({
      request: buildRequest(),
      offers: [buildOffer("offer-after-outage", "https://after.example/search")],
      allOffers: [buildOffer("offer-after-outage", "https://after.example/search")],
      searchMeta: buildSearchMeta(),
      providerMeta: buildProviderMeta(),
      warnings: [],
      sortMode: "cheapest",
      status: "completed",
    });
    await new Promise((resolve) => setTimeout(resolve, 260));

    // The write that was refused rides along with the one that follows it: the
    // diff was still owed, not recomputed and not lost.
    assert.equal(readSqliteCounts(dbPath).searchJobs, 3);
  } finally {
    // Whatever the assertions decide, the handle has to go: a store left open
    // holds the temp directory and turns a failure into a cleanup error.
    store.close();
  }

  const restored = new SearchSessionStore({ dbPath });
  try {
    assert.ok(restored.getSearchJob(before!.id));
    assert.ok(restored.getSearchJob(during!.id));
    assert.ok(restored.getSearchJob(after!.id));
  } finally {
    restored.close();
  }
});

test("SEARCH_COMPLETED_SESSION_TTL_MS=0 is the shortest sweep the store can express, not a no-store", () => {
  const child = spawnSync(process.execPath, ["--no-env-file", "-e", `
    const store = await import("./src/session-store.ts");
    const sessions = new store.SearchSessionStore();
    const job = sessions.createSearchJob({
      request: ${JSON.stringify(buildRequest())},
      offers: [],
      allOffers: [],
      searchMeta: ${JSON.stringify(buildSearchMeta())},
      providerMeta: ${JSON.stringify(buildProviderMeta())},
      warnings: [],
      sortMode: "cheapest",
      status: "completed",
    });
    const idleAtOf = (record) => Math.max(Date.parse(record.updatedAt), Date.parse(record.lastAccessedAt));

    // Stored the instant it is created: a TTL of zero is not a no-store.
    const storedOnCreation = Boolean(sessions.getSearchJob(job.id));

    // A sweep that runs at the job's own instant still keeps it.
    sessions.purgeExpired(idleAtOf(sessions.getSearchJob(job.id)));
    const survivesItsOwnInstant = Boolean(sessions.getSearchJob(job.id));

    // The first sweep that sees any positive age takes it.
    sessions.purgeExpired(idleAtOf(sessions.getSearchJob(job.id)) + 1);
    const goneOnFirstPositiveAge = sessions.getSearchJob(job.id) === undefined;

    sessions.close();
    console.log(JSON.stringify({
      ttlMs: store.COMPLETED_SEARCH_SESSION_TTL_MS,
      storedOnCreation,
      survivesItsOwnInstant,
      goneOnFirstPositiveAge,
    }));
  `], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      SEARCH_COMPLETED_SESSION_TTL_MS: "0",
      FLY_DESK_APP_DATA_DIR: "",
      FLY_DESK_SESSION_DB_PATH: "",
    },
    encoding: "utf8",
  });

  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim()), {
    ttlMs: 0,
    storedOnCreation: true,
    survivesItsOwnInstant: true,
    goneOnFirstPositiveAge: true,
  });
});
