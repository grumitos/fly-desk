import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { COMPLETED_SEARCH_SESSION_TTL_MS, SearchSessionStore } from "../src/session-store";
import { SEARCH_CACHE_VERSION } from "../src/core/types";
import type {
  CanonicalOffer,
  MatrixCell,
  ProviderMeta,
  SearchMeta,
  SearchRequest,
} from "../src/core/types";

test("completed search result cache ttl is four hours", () => {
  assert.equal(COMPLETED_SEARCH_SESSION_TTL_MS, 4 * 60 * 60 * 1000);
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

function readSqlitePayloadText(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = [
      ...allSql<{ payload: string }>(db, "SELECT payload FROM search_jobs ORDER BY id"),
      ...allSql<{ payload: string }>(db, "SELECT payload FROM matrix_jobs ORDER BY id"),
      ...allSql<{ payload: string }>(db, "SELECT payload FROM purchase_paths ORDER BY id"),
    ];
    return rows.map((row) => row.payload).join("\n");
  } finally {
    db.close();
  }
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

test("findRecentCompletedSearchJob ignores legacy result-cap flags in the cache key", () => {
  const store = new SearchSessionStore();
  const request = buildRequest();
  const offer = buildOffer("offer-compact-default", "https://cached.example/default");
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

  const requestWithDefaultFlag: SearchRequest = {
    ...buildRequest(),
    filters: {
      ...buildRequest().filters,
      compactAllOffers: false,
    },
  };
  const reused = store.findRecentCompletedSearchJob({
    request: requestWithDefaultFlag,
    providerIds: ["agil-local"],
    sortMode: "cheapest",
    maxAgeMs: 10 * 60 * 1000,
  });
  assert.equal(reused?.id, completedJob.id);

  const compactRequest: SearchRequest = {
    ...buildRequest(),
    filters: {
      ...buildRequest().filters,
      maxResults: 25,
      compactAllOffers: true,
    },
  };
  const reusedCompact = store.findRecentCompletedSearchJob({
    request: compactRequest,
    providerIds: ["agil-local"],
    sortMode: "cheapest",
    maxAgeMs: 10 * 60 * 1000,
  });
  assert.equal(reusedCompact?.id, completedJob.id);
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

test("search session store migrates legacy json to sqlite and redacts Costamar tokens", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-session-store-migrate-"));
  const dbPath = join(tempRoot, "fly-desk-cache.sqlite");
  const legacyPersistPath = join(tempRoot, "search-session-store.json");
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
  const secretToken = "legacy-secret-token";
  const costamarUrl = `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${secretToken}`;
  const baseOffer = buildOffer("offer-costamar", costamarUrl);
  const costamarOffer: CanonicalOffer = {
    ...baseOffer,
    providerSource: "costamar",
    purchasePaths: baseOffer.purchasePaths.map((path) => ({
      ...path,
      provider: "costamar",
      label: "Buscar en Costamar",
    })),
  };
  const transientStore = new SearchSessionStore();
  const completedJob = transientStore.createSearchJob({
    request,
    providerContext: {
      costamar: {
        apiBaseUrl: "https://costamar.com.pe/vuelos/api",
        brandBaseUrl: "https://booking.clickandbook.com/vuelos",
        terminalId: "0721808110",
        token: secretToken,
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
  const purchasePathId = completedJob.allOffers[0]?.purchasePaths[0]?.id;
  assert.ok(purchasePathId);
  const storedPath = transientStore.resolvePurchasePath(purchasePathId);
  assert.ok(storedPath);

  writeFileSync(legacyPersistPath, JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    searchJobs: [completedJob],
    matrixJobs: [],
    purchasePaths: [storedPath],
  }), "utf8");

  const migratedStore = new SearchSessionStore({ dbPath, legacyPersistPath });
  const restoredJob = migratedStore.getSearchJob(completedJob.id);
  const restoredPath = migratedStore.resolvePurchasePath(purchasePathId);
  const persistedPayloads = readSqlitePayloadText(dbPath);

  assert.equal(existsSync(legacyPersistPath), false);
  assert.ok(restoredJob);
  assert.notEqual(restoredJob.providerContext?.costamar?.token, secretToken);
  assert.ok(restoredPath?.path.url);
  assert.equal(restoredPath.path.url.includes(secretToken), false);
  assert.equal(restoredPath.path.url.includes("token="), false);
  assert.equal(persistedPayloads.includes(secretToken), false);
  assert.equal(persistedPayloads.includes("token="), false);
  migratedStore.close();

  rmSync(tempRoot, { recursive: true, force: true });
});

