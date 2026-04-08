import test from "node:test";
import assert from "node:assert/strict";
import { SearchSessionStore } from "../src/session-store";
import type {
  CanonicalOffer,
  MatrixCell,
  ProviderMeta,
  SearchMeta,
  SearchRequest,
} from "../src/core/types";

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
    valueScore: 1,
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

test("search job refresh replaces stale purchase path ids instead of leaking them", () => {
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
  assert.notEqual(refreshedPathId, firstPathId);
  assert.equal(store.resolvePurchasePath(firstPathId), undefined);
  assert.ok(store.resolvePurchasePath(refreshedPathId));
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

