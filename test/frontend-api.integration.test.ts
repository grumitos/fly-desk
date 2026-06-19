import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { startMatrix, startMigrationSearch, startSearch, type BackendSearchPayload } from "../frontend/src/lib/api";
import type { SearchRequest } from "../frontend/src/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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
  } as SearchRequest & {
    maxResults: number;
    compactAllOffers: boolean;
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

test("migration month fan-out keeps provider scans exhaustive", async () => {
  const payloads: BackendSearchPayload[] = [];
  const request = {
    ...buildMonthViewRequest(),
    nonStop: true,
    maxStopsFilter: "1",
    carryOnRequired: true,
    checkedBaggageRequired: true,
    maxLayoverMinutes: "180",
    includedAirlineCodes: ["LA"],
  };

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

  await startMigrationSearch(request, "cheapest");

  assert.equal(payloads.length, 8);
  for (const payload of payloads) {
    assert.equal(payload.request.tripType, "one-way");
    assert.equal(payload.request.searchMode, "stay-range");
    assert.equal(payload.request.filters?.nonStop, false);
    assert.equal(payload.request.filters?.maxStops, undefined);
    assert.equal(payload.request.filters?.carryOnRequired, false);
    assert.equal(payload.request.filters?.checkedBaggageRequired, false);
    assert.equal(payload.request.filters?.baggageRequired, false);
    assert.equal(payload.request.filters?.maxLayoverMinutes, undefined);
    assert.equal(payload.request.filters?.includedAirlineCodes, undefined);
    assert.equal(Object.hasOwn(payload.request.filters ?? {}, "maxResults"), false);
    assert.equal(Object.hasOwn(payload.request.filters ?? {}, "compactAllOffers"), false);
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

test("migration month fan-out runs generous bounded batches", async () => {
  const releases: Array<() => void> = [];
  let activeRequests = 0;
  let peakActiveRequests = 0;
  const request = {
    ...buildMonthViewRequest(),
    migrationMonths: ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12"],
  };

  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as BackendSearchPayload;
    activeRequests += 1;
    peakActiveRequests = Math.max(peakActiveRequests, activeRequests);

    return new Promise<Response>((resolve) => {
      releases.push(() => {
        activeRequests -= 1;
        resolve(new Response(JSON.stringify({
          searchJobId: `job-${releases.length}`,
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
            providersUsed: ["agil-local", "costamar"],
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
      });
    });
  }) as typeof fetch;

  const pending = startMigrationSearch(request, "cheapest");
  await waitFor(() => releases.length === 2);
  assert.equal(peakActiveRequests, 2);

  releases.slice(0, 2).forEach((release) => release());
  await waitFor(() => releases.length === 4);
  assert.equal(peakActiveRequests, 2);

  releases.slice(2, 4).forEach((release) => release());
  await waitFor(() => releases.length === 6);
  assert.equal(peakActiveRequests, 2);

  releases.slice(4, 6).forEach((release) => release());
  await waitFor(() => releases.length === 7);

  releases.slice(6).forEach((release) => release());
  await pending;
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

test("migration month keeps the last available result when polling fails after progress", async () => {
  const request = {
    ...buildMonthViewRequest(),
    migrationMonths: ["2026-07"],
  };
  const offer = {
    id: "month-offer-1",
    providerSource: "agil-local",
    airline: "LATAM",
    origin: "LIM",
    destination: "MIA",
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
  let callCount = 0;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    callCount += 1;

    if (callCount === 1) {
      assert.equal(String(input), "/api/search");
      return Promise.resolve(new Response(JSON.stringify({
        searchJobId: "month-progress-job",
        searchComplete: false,
        searchStatus: "running",
        revision: 1,
        sortMode: "cheapest",
        request: JSON.parse(String(init?.body)).request,
        offers: [offer],
        allOffers: [offer],
        searchMeta: {
          requestedAt: "2026-06-01T00:00:00.000Z",
          completedAt: "",
          providersUsed: ["agil-local"],
          warnings: [],
          partial: true,
          searchState: "search_partial",
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
    }

    if (callCount === 2) {
      return Promise.reject(new Error("Temporary outage while polling the month scan."));
    }

    throw new Error(`Unexpected fetch call ${callCount}`);
  }) as typeof fetch;

  const result = await startMigrationSearch(request, "cheapest");

  assert.equal(callCount, 2);
  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0]?.sourceOfferId, "month-offer-1");
  assert.equal(result.migrationMonths?.[0]?.offer?.sourceOfferId, "month-offer-1");
  assert.equal(result.migrationMonths?.[0]?.status, "error");
  assert.match(result.warnings.join("\n"), /No se pudo conectar con Fly Desk|Temporary outage while polling/);
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

test("matrix offer normalization suppresses provider status warnings in selected offers", async () => {
  const request: SearchRequest = {
    origin: "LIM",
    destination: "MAD",
    departureStart: "2026-07-01",
    departureEnd: "2026-07-02",
    returnStart: "2026-07-08",
    returnEnd: "2026-07-09",
    tripType: "round-trip",
    adults: 1,
    children: 0,
    infants: 0,
    searchMode: "roundtrip-grid",
    flexibleMode: "fixed-ranges",
  };

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "/api/matrix");
    const payload = JSON.parse(String(init?.body)) as BackendSearchPayload;

    return Promise.resolve(new Response(JSON.stringify({
      matrixJobId: "matrix-provider-status-warnings",
      matrixComplete: true,
      matrixStatus: "completed",
      revision: 1,
      request: payload.request,
      searchMeta: {
        requestedAt: "2026-06-01T00:00:00.000Z",
        completedAt: "2026-06-01T00:00:00.000Z",
        providersUsed: ["agil-local", "costamar"],
        warnings: [],
        partial: false,
        searchState: "search_live",
      },
      providerMeta: {
        exactProvider: "agil-local",
        coverageMode: "core",
      },
      warnings: [],
      recommendations: [],
      cells: [
        {
          key: "agil-status",
          departureDate: "2026-07-01",
          returnDate: "2026-07-08",
          stayNights: 7,
          price: { amount: 650, currencyCode: "USD" },
          confidence: "live",
          providerSource: "agil-local",
          selectable: true,
          requiresRequery: false,
          stateCode: "live",
          tooltip: "Agil exact search. Cheapest validating carrier: LA.",
        },
        {
          key: "costamar-status",
          departureDate: "2026-07-02",
          returnDate: "2026-07-09",
          stayNights: 7,
          price: { amount: 700, currencyCode: "USD" },
          confidence: "live",
          providerSource: "costamar",
          selectable: true,
          requiresRequery: false,
          stateCode: "live",
          tooltip: "Costamar live search.",
        },
        {
          key: "costamar-real-warning",
          departureDate: "2026-07-02",
          returnDate: "2026-07-09",
          stayNights: 7,
          price: { amount: 710, currencyCode: "USD" },
          confidence: "live",
          providerSource: "costamar",
          selectable: true,
          requiresRequery: false,
          stateCode: "live",
          tooltip: "Costamar live search.",
          offer: {
            id: "costamar-offer-real-warning",
            providerSource: "costamar",
            airline: "LATAM",
            departureDate: "2026-07-02",
            returnDate: "2026-07-09",
            duration: "11h",
            stops: 0,
            price: { total: { amount: 710, currencyCode: "USD" } },
            warnings: ["Costamar live search.", "Costamar returned no offers for this search."],
          },
        },
      ],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  }) as typeof fetch;

  const result = await startMatrix(request, "cheapest");

  assert.equal(result.offers.length, 3);
  assert.deepEqual(result.offers[0]?.warnings ?? [], []);
  assert.equal(result.offers[0]?.baggageLabel, undefined);
  assert.deepEqual(result.offers[1]?.warnings ?? [], []);
  assert.equal(result.offers[1]?.baggageLabel, undefined);
  assert.deepEqual(result.offers[2]?.warnings ?? [], ["Click and Book Plus no devolvió vuelos para esta búsqueda."]);
});
