import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { startMigrationSearch, type BackendSearchPayload } from "../frontend/src/lib/api";
import type { SearchRequest } from "../frontend/src/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function buildMonthViewRequest(): SearchRequest {
  return {
    origin: "LIM",
    destination: "MIA",
    departureDate: "2026-06-15",
    tripType: "one-way",
    adults: 1,
    children: 0,
    infants: 0,
    searchMode: "month-view",
    currencyCode: "USD",
    locale: "es-PE",
    market: "PE",
    maxResults: 25,
    compactAllOffers: true,
  };
}

test("migration month fan-out keeps each provider request lightweight", async () => {
  const payloads: BackendSearchPayload[] = [];

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    assert.equal(url, "/api/search");
    assert.equal(init?.method, "POST");
    const payload = JSON.parse(String(init?.body)) as BackendSearchPayload;
    payloads.push(payload);

    return Promise.resolve(new Response(JSON.stringify({
      searchJobId: `job-${payloads.length}`,
      searchComplete: true,
      searchStatus: "completed",
      revision: 1,
      sortMode: payload.sortMode,
      request: payload.request,
      offers: [],
      allOffers: [],
      searchMeta: {
        requestedAt: "2026-06-01T00:00:00.000Z",
        completedAt: "2026-06-01T00:00:00.000Z",
        providersUsed: ["agil-local"],
        warnings: [],
        partial: false,
        searchState: "search_live",
      },
      providerMeta: {
        exactProvider: "agil-local",
        coverageMode: "core",
      },
      warnings: [],
      diagnosticLog: [],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  }) as typeof fetch;

  await startMigrationSearch(buildMonthViewRequest(), "cheapest");

  assert.equal(payloads.length, 8);
  for (const payload of payloads) {
    assert.equal(payload.request.tripType, "one-way");
    assert.equal(payload.request.searchMode, "stay-range");
    assert.equal(payload.request.filters?.maxResults, 25);
    assert.equal(payload.request.filters?.compactAllOffers, true);
  }
});

test("migration month fan-out uses explicitly selected months", async () => {
  const payloads: BackendSearchPayload[] = [];
  const request = {
    ...buildMonthViewRequest(),
    migrationMonths: ["2026-07", "2026-09"],
  };

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    assert.equal(url, "/api/search");
    const payload = JSON.parse(String(init?.body)) as BackendSearchPayload;
    payloads.push(payload);

    return Promise.resolve(new Response(JSON.stringify({
      searchJobId: `job-${payloads.length}`,
      searchComplete: true,
      searchStatus: "completed",
      revision: 1,
      sortMode: payload.sortMode,
      request: payload.request,
      offers: [],
      allOffers: [],
      searchMeta: {
        requestedAt: "2026-06-01T00:00:00.000Z",
        completedAt: "2026-06-01T00:00:00.000Z",
        providersUsed: ["agil-local"],
        warnings: [],
        partial: false,
        searchState: "search_live",
      },
      providerMeta: {
        exactProvider: "agil-local",
        coverageMode: "core",
      },
      warnings: [],
      diagnosticLog: [],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  }) as typeof fetch;

  await startMigrationSearch(request, "cheapest");

  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads.map((payload) => payload.request.legs?.[0]?.departureStart), [
    "2026-07-01",
    "2026-09-01",
  ]);
  assert.deepEqual(payloads.map((payload) => payload.request.legs?.[0]?.departureEnd), [
    "2026-07-31",
    "2026-09-30",
  ]);
});

test("migration month with Agil offers suppresses child no-flight warnings", async () => {
  const request = {
    ...buildMonthViewRequest(),
    migrationMonths: ["2026-07"],
  };

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    assert.equal(url, "/api/search");
    const payload = JSON.parse(String(init?.body)) as BackendSearchPayload;
    const offer = {
      id: "agil-offer-1",
      providerSource: "agil-local",
      airline: "LATAM",
      origin: "LIM",
      destination: "MAD",
      departureDate: "2026-07-14",
      duration: "11h",
      stops: 0,
      price: {
        total: {
          amount: 512,
          currencyCode: "USD",
        },
      },
    };

    return Promise.resolve(new Response(JSON.stringify({
      searchJobId: "job-with-offers",
      searchComplete: true,
      searchStatus: "completed",
      revision: 1,
      sortMode: payload.sortMode,
      request: payload.request,
      offers: [offer],
      allOffers: [offer],
      searchMeta: {
        requestedAt: "2026-06-01T00:00:00.000Z",
        completedAt: "2026-06-01T00:00:00.000Z",
        providersUsed: ["agil-local"],
        warnings: ["Agil returned no offers for this search."],
        partial: false,
        searchState: "search_live",
      },
      providerMeta: {
        exactProvider: "agil-local",
        coverageMode: "core",
      },
      warnings: ["Agil returned no offers for this search."],
      diagnosticLog: [],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  }) as typeof fetch;

  const result = await startMigrationSearch(request, "cheapest");

  assert.equal(result.offers.length, 1);
  assert.equal(result.warnings.some((warning) => /Agil.*vuelos/i.test(warning)), false);
  assert.equal(result.migrationMonths?.[0]?.warnings?.some((warning) => /Agil.*vuelos/i.test(warning)), false);
});
