import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { startMigrationSearch, startSearch, type BackendSearchPayload } from "../frontend/src/lib/api";
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

function buildExactRequest(): SearchRequest {
  return {
    origin: "LIM",
    destination: "MIA",
    departureDate: "2026-06-15",
    tripType: "one-way",
    adults: 1,
    children: 0,
    infants: 0,
    searchMode: "exact",
    currencyCode: "USD",
    locale: "es-PE",
    market: "PE",
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

test("frontend diagnostic logs redact raw provider secrets before UI exposure", async () => {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    assert.equal(String(input), "/api/search");

    return Promise.resolve(new Response(JSON.stringify({
      searchJobId: "job-redaction",
      searchComplete: true,
      searchStatus: "completed",
      revision: 1,
      sortMode: "cheapest",
      request: {
        tripType: "one-way",
        searchMode: "exact",
        legs: [{ origin: "LIM", destination: "MIA", departureDate: "2026-06-15" }],
        passengers: { adults: 1, children: 0, infants: 0 },
        filters: {},
        coverageMode: "core",
        redirectMode: "none",
        currencyCode: "USD",
        locale: "es-PE",
        market: "PE",
      },
      offers: [],
      allOffers: [],
      searchMeta: {
        requestedAt: "2026-06-01T00:00:00.000Z",
        completedAt: "2026-06-01T00:00:00.000Z",
        providersUsed: ["agil-local"],
        warnings: [
          "AGIL_APIM_SUBSCRIPTION_KEY=sk_raw_SECRET_123 localStorage.jwt=jwt_SECRET_456",
        ],
        partial: false,
        searchState: "search_live",
      },
      providerMeta: {
        exactProvider: "agil-local",
        coverageMode: "core",
      },
      providerDiagnostics: [{
        providerId: "agil-local",
        kind: "exact",
        status: "failed",
        startedAt: "2026-06-01T00:00:00.000Z",
        completedAt: "2026-06-01T00:00:01.000Z",
        durationMs: 1000,
        warningCount: 1,
        error: "Bearer bearer_SECRET_789 Cookie=session_SECRET_abc",
        events: [{
          name: "browser_storage",
          elapsedMs: 10,
          detail: "C:\\Users\\agent\\AppData\\Local\\Google\\Chrome\\User Data\\Profile 7 token=token_SECRET_def",
        }],
      }],
      warnings: [
        "Authorization: Bearer auth_SECRET_ghi COSTAMAR_B2B_PASSWORD=pass_SECRET_jkl",
      ],
      diagnosticLog: [],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  }) as typeof fetch;

  const result = await startSearch(buildExactRequest(), "cheapest");
  const logText = (result.diagnosticLog ?? []).join("\n");

  assert.doesNotMatch(logText, /sk_raw_SECRET|jwt_SECRET|bearer_SECRET|session_SECRET|token_SECRET|auth_SECRET|pass_SECRET|Profile 7/);
  assert.match(logText, /redactado/i);
});
