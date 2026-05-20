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
