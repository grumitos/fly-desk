import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import {
  requestQuotation,
  startMatrix,
  startMigrationSearch,
  startSearch,
  suggestLocations,
  type BackendSearchPayload,
} from "../frontend/src/lib/api";
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

test("quotation transport revalidates the selected provider offer and normalizes the response", async () => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "/api/quotation");
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      searchSessionId: "search-source-1",
      offerId: "provider-offer-7",
      migrationPlan: true,
    });

    return Promise.resolve(Response.json({
      searchSessionId: "search-source-1",
      commercialText: "PAQUETE MIGRATORIO MADRID 🇪🇸",
      offer: {
        id: "validated-offer-7",
        providerSource: "costamar",
        origin: "LIM",
        destination: "MAD",
        priceConfidence: "validated",
        priceStatus: "verified",
        priceVerifiedAt: "2026-07-29T12:00:00.000Z",
        price: { total: { amount: 725, currencyCode: "USD" } },
        itineraries: [{
          direction: "outbound",
          segments: [{
            marketingCarrier: "UX",
            flightNumber: "75",
            origin: "LIM",
            destination: "MAD",
            departureAt: "2026-08-10T08:00:00-05:00",
            arrivalAt: "2026-08-10T23:00:00+02:00",
          }],
        }],
      },
    }));
  }) as typeof fetch;

  const quotation = await requestQuotation({
    searchSessionId: "search-source-1",
    offerId: "provider-offer-7",
    migrationPlan: true,
  });

  assert.equal(quotation.searchSessionId, "search-source-1");
  assert.equal(quotation.commercialText, "PAQUETE MIGRATORIO MADRID 🇪🇸");
  assert.equal(quotation.offer.id, "validated-offer-7");
  assert.equal(quotation.offer.priceVerifiedAt, "2026-07-29T12:00:00.000Z");
  assert.equal(quotation.offer.airline, "Air Europa");
  assert.equal(quotation.offer.departureDate, "2026-08-10T08:00:00-05:00");
});

test("quotation transport rejects verified flags without a real priced itinerary", async () => {
  globalThis.fetch = (() => Promise.resolve(Response.json({
    searchSessionId: "search-source-1",
    commercialText: "Texto marcado como verificado pero incompleto",
    offer: {
      id: "unverified-offer",
      providerSource: "costamar",
      priceConfidence: "validated",
      priceStatus: "verified",
      priceVerifiedAt: "2026-07-29T12:00:00.000Z",
    },
  }))) as typeof fetch;

  await assert.rejects(
    requestQuotation({ searchSessionId: "search-source-1", offerId: "provider-offer-7" }),
    /cotización no válida/i,
  );
});

test("search transport drops offers without a real positive price and itinerary", async () => {
  const validOffer = {
    id: "real-offer",
    providerSource: "agil-local",
    tripType: "one-way",
    origin: "LIM",
    destination: "MIA",
    price: { total: { amount: 425, currencyCode: "USD" } },
    itineraries: [{
      direction: "outbound",
      segments: [{
        marketingCarrier: "",
        flightNumber: "",
        origin: "LIM",
        destination: "MIA",
        departureAt: "2026-06-15T08:00:00-05:00",
        arrivalAt: "2026-06-15T14:00:00-04:00",
      }],
    }],
  };
  const malformedOffers = [
    {
      ...validOffer,
      id: "missing-price",
      price: undefined,
    },
    {
      ...validOffer,
      id: "zero-price",
      price: { total: { amount: 0, currencyCode: "USD" } },
    },
    {
      ...validOffer,
      id: "missing-itinerary",
      itineraries: undefined,
    },
  ];

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "/api/search");
    const payload = JSON.parse(String(init?.body)) as BackendSearchPayload;
    return Promise.resolve(Response.json({
      searchJobId: "strict-offer-boundary",
      searchComplete: true,
      searchStatus: "completed",
      revision: 1,
      sortMode: payload.sortMode,
      request: payload.request,
      offers: [...malformedOffers, validOffer],
      allOffers: [...malformedOffers, validOffer],
      searchMeta: {
        requestedAt: "2026-06-01T00:00:00.000Z",
        completedAt: "2026-06-01T00:00:00.000Z",
        providersUsed: ["agil-local"],
        warnings: [],
        partial: false,
        searchState: "search_live",
      },
      providerMeta: { exactProvider: "agil-local", coverageMode: "core" },
      warnings: [],
    }));
  }) as typeof fetch;

  const result = await startSearch(buildExactRequest(), "cheapest");

  assert.deepEqual(result.offers.map((offer) => offer.id), ["real-offer"]);
  assert.deepEqual(result.allOffers.map((offer) => offer.id), ["real-offer"]);
  assert.equal(result.offers[0]?.price.total.amount, 425);
  assert.equal(result.offers[0]?.stops, 0);
});

test("search transport drops a round-trip offer without a real inbound itinerary", async () => {
  const request: SearchRequest = {
    ...buildExactRequest(),
    tripType: "round-trip",
    returnDate: "2026-06-22",
  };
  const incompleteOffer = {
    id: "round-trip-missing-inbound",
    providerSource: "agil-local",
    tripType: "round-trip",
    returnDate: "2026-06-22",
    price: { total: { amount: 425, currencyCode: "USD" } },
    itineraries: [{
      direction: "outbound",
      segments: [{
        marketingCarrier: "LA",
        flightNumber: "2460",
        origin: "LIM",
        destination: "MIA",
        departureAt: "2026-06-15T08:00:00-05:00",
        arrivalAt: "2026-06-15T14:00:00-04:00",
      }],
    }],
  };
  const completeOffer = {
    ...incompleteOffer,
    id: "complete-round-trip",
    itineraries: [
      ...incompleteOffer.itineraries,
      {
        direction: "inbound",
        segments: [{
          marketingCarrier: "LA",
          flightNumber: "2461",
          origin: "MIA",
          destination: "LIM",
          departureAt: "2026-06-22T17:00:00-04:00",
          arrivalAt: "2026-06-22T23:00:00-05:00",
        }],
      },
    ],
  };

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "/api/search");
    const payload = JSON.parse(String(init?.body)) as BackendSearchPayload;
    return Promise.resolve(Response.json({
      searchJobId: "strict-round-trip-boundary",
      searchComplete: true,
      searchStatus: "completed",
      revision: 1,
      sortMode: payload.sortMode,
      request: payload.request,
      offers: [incompleteOffer, completeOffer],
      allOffers: [incompleteOffer, completeOffer],
      searchMeta: {
        requestedAt: "2026-06-01T00:00:00.000Z",
        completedAt: "2026-06-01T00:00:00.000Z",
        providersUsed: ["agil-local"],
        warnings: [],
        partial: false,
        searchState: "search_live",
      },
      providerMeta: { exactProvider: "agil-local", coverageMode: "core" },
      warnings: [],
    }));
  }) as typeof fetch;

  const result = await startSearch(request, "cheapest");

  assert.deepEqual(result.offers.map((offer) => offer.id), ["complete-round-trip"]);
  assert.deepEqual(result.allOffers.map((offer) => offer.id), ["complete-round-trip"]);
});

test("browser session id is attached to locations, search, and matrix transports", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const clientSessionId = "browser-session-transport-a";
  const postedPayloads: Array<BackendSearchPayload & { clientSessionId?: string }> = [];
  const locationUrls: URL[] = [];
  const sessionStorage = {
    getItem: () => clientSessionId,
    setItem: () => undefined,
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { sessionStorage },
  });

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/locations?")) {
      locationUrls.push(new URL(url, "http://fly-desk.local"));
      return Promise.resolve(Response.json({ suggestions: [] }));
    }

    const payload = JSON.parse(String(init?.body)) as BackendSearchPayload & { clientSessionId?: string };
    postedPayloads.push(payload);
    if (url === "/api/search") {
      return Promise.resolve(Response.json({
        searchJobId: "session-search",
        searchComplete: true,
        searchStatus: "completed",
        revision: 1,
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
        providerMeta: { exactProvider: "agil-local", coverageMode: "core" },
        warnings: [],
      }));
    }

    assert.equal(url, "/api/matrix");
    return Promise.resolve(Response.json({
      matrixJobId: "session-matrix",
      matrixComplete: true,
      matrixStatus: "completed",
      revision: 1,
      request: payload.request,
      cells: [],
      searchMeta: {
        requestedAt: "2026-06-01T00:00:00.000Z",
        completedAt: "2026-06-01T00:00:00.000Z",
        providersUsed: ["agil-local", "costamar"],
        warnings: [],
        partial: false,
        searchState: "search_live",
      },
      providerMeta: { exactProvider: "agil-local", coverageMode: "core" },
      warnings: [],
    }));
  }) as typeof fetch;

  try {
    await suggestLocations("lim");
    await startSearch(buildExactRequest(), "cheapest");
    await startMatrix({
      ...buildExactRequest(),
      tripType: "round-trip",
      searchMode: "roundtrip-grid",
      departureStart: "2026-06-15",
      departureEnd: "2026-06-16",
      returnStart: "2026-06-22",
      returnEnd: "2026-06-23",
    }, "cheapest");

    assert.equal(locationUrls[0]?.searchParams.get("clientSessionId"), clientSessionId);
    assert.deepEqual(postedPayloads.map((payload) => payload.clientSessionId), [clientSessionId, clientSessionId]);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete (globalThis as typeof globalThis & { window?: Window }).window;
  }
});

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
  }
});

test("migration month summary keeps every offer and counts only unique valid in-range fare dates", async () => {
  const request = {
    ...buildMonthViewRequest(),
    migrationMonths: ["2026-06"],
  };
  const offer = (id: string, departureAt: string, amount: number) => ({
    id,
    providerSource: "agil-local",
    origin: "LIM",
    destination: "MIA",
    itineraries: [
      {
        direction: "outbound",
        segments: [
          {
            origin: "LIM",
            destination: "MIA",
            departureAt,
            arrivalAt: departureAt,
          },
        ],
      },
    ],
    price: {
      total: {
        amount,
        currencyCode: "USD",
      },
    },
  });
  const offers = [
    offer("june-16-first", "2026-06-16T08:00:00-05:00", 420),
    offer("june-16-second", "2026-06-16T12:00:00-05:00", 390),
    offer("june-20-cheapest", "2026-06-20T09:00:00-05:00", 350),
    offer("june-30", "2026-06-30T07:00:00-05:00", 500),
    offer("outside-range", "2026-07-01T07:00:00-05:00", 600),
    offer("invalid-date", "not-a-date", 610),
  ];

  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as BackendSearchPayload;
    return Promise.resolve(new Response(JSON.stringify({
      searchJobId: "job-june-coverage",
      searchComplete: true,
      searchStatus: "completed",
      revision: 1,
      sortMode: payload.sortMode,
      request: payload.request,
      offers,
      allOffers: offers,
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
  }) as typeof fetch;

  const result = await startMigrationSearch(request, "cheapest");
  const month = result.migrationMonths?.[0];

  assert.equal(month?.offers?.length, 6);
  assert.equal(result.allOffers?.length, 6);
  assert.equal(month?.offer?.sourceOfferId, "june-20-cheapest");
  assert.equal(month?.faredDays, 3);
  assert.equal(month?.queriedDays, 16);
});

test("migration month summary omits fare coverage when the completed provider job is partial", async () => {
  const request = {
    ...buildMonthViewRequest(),
    migrationMonths: ["2026-06"],
  };

  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as BackendSearchPayload;
    return Promise.resolve(new Response(JSON.stringify({
      searchJobId: "job-june-partial",
      searchComplete: true,
      searchStatus: "completed",
      revision: 1,
      sortMode: payload.sortMode,
      request: payload.request,
      offers: [{
        id: "partial-offer",
        providerSource: "agil-local",
        origin: "LIM",
        destination: "MIA",
        departureDate: "2026-06-16",
        price: { total: { amount: 450, currencyCode: "USD" } },
      }],
      searchMeta: {
        requestedAt: "2026-06-01T00:00:00.000Z",
        completedAt: "2026-06-01T00:00:00.000Z",
        providersUsed: ["agil-local", "costamar"],
        warnings: ["One provider date lookup failed."],
        partial: true,
        searchState: "search_partial",
      },
      providerMeta: {
        exactProvider: "agil-local",
        coverageMode: "core",
      },
      warnings: ["One provider date lookup failed."],
      diagnosticLog: [],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  }) as typeof fetch;

  const result = await startMigrationSearch(request, "cheapest");
  const month = result.migrationMonths?.[0];

  assert.equal(month?.faredDays, undefined);
  assert.equal(month?.queriedDays, undefined);
  assert.equal(month?.status, "partial");
  assert.equal(result.searchMeta.partial, true);
  assert.equal(result.searchMeta.searchState, "search_partial");
});

test("migration month fan-out keeps eight explicitly selected months across years", async () => {
  const payloads: BackendSearchPayload[] = [];
  const request = {
    ...buildMonthViewRequest(),
    departureDate: "2026-11-15",
    migrationMonths: [
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
      "2027-03",
      "2027-04",
      "2027-05",
      "2027-06",
    ],
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

  assert.equal(payloads.length, 8);
  assert.deepEqual(
    payloads.map((payload) => payload.recordLocationUsage),
    [true, false, false, false, false, false, false, false],
  );
  assert.deepEqual(payloads.map((payload) => payload.request.legs?.[0]?.departureStart), [
    "2026-11-15",
    "2026-12-01",
    "2027-01-01",
    "2027-02-01",
    "2027-03-01",
    "2027-04-01",
    "2027-05-01",
    "2027-06-01",
  ]);
  assert.deepEqual(payloads.map((payload) => payload.request.legs?.[0]?.departureEnd), [
    "2026-11-30",
    "2026-12-31",
    "2027-01-31",
    "2027-02-28",
    "2027-03-31",
    "2027-04-30",
    "2027-05-31",
    "2027-06-30",
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
      tripType: "one-way",
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
      itineraries: [{
        direction: "outbound",
        segments: [{
          marketingCarrier: "LA",
          flightNumber: "2460",
          origin: "LIM",
          destination: "MIA",
          departureAt: "2026-07-14T08:00:00-05:00",
          arrivalAt: "2026-07-14T14:00:00-04:00",
        }],
      }],
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
    tripType: "one-way",
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
    itineraries: [{
      direction: "outbound",
      segments: [{
        marketingCarrier: "LA",
        flightNumber: "2460",
        origin: "LIM",
        destination: "MIA",
        departureAt: "2026-07-14T08:00:00-05:00",
        arrivalAt: "2026-07-14T14:00:00-04:00",
      }],
    }],
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
            tripType: "round-trip",
            origin: "LIM",
            destination: "MAD",
            departureDate: "2026-07-02",
            returnDate: "2026-07-09",
            duration: "11h",
            stops: 0,
            priceConfidence: "indicative",
            priceStatus: "unverified",
            price: { total: { amount: 710, currencyCode: "USD" } },
            itineraries: [
              {
                direction: "outbound",
                segments: [{
                  marketingCarrier: "LA",
                  flightNumber: "2484",
                  origin: "LIM",
                  destination: "MAD",
                  departureAt: "2026-07-02T10:00:00-05:00",
                  arrivalAt: "2026-07-03T05:00:00+02:00",
                }],
              },
              {
                direction: "inbound",
                segments: [{
                  marketingCarrier: "LA",
                  flightNumber: "2485",
                  origin: "MAD",
                  destination: "LIM",
                  departureAt: "2026-07-09T23:00:00+02:00",
                  arrivalAt: "2026-07-10T05:00:00-05:00",
                }],
              },
            ],
            warnings: ["Costamar live search.", "Costamar returned no offers for this search."],
          },
        },
        {
          key: "malformed-tooltip",
          departureDate: "2026-07-02",
          returnDate: "2026-07-09",
          stayNights: 7,
          price: { amount: 705, currencyCode: "USD" },
          confidence: "live",
          providerSource: "costamar",
          selectable: true,
          requiresRequery: false,
          stateCode: "live",
          tooltip: { message: "Costamar live search." },
        },
      ],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  }) as typeof fetch;

  const result = await startMatrix(request, "cheapest");
  const realWarningOffer = result.offers.find((offer) => offer.id === "costamar-offer-real-warning");

  assert.deepEqual(
    result.offers.map((offer) => offer.id),
    ["costamar-offer-real-warning"],
    "price-only matrix cells must not become invented flight offers",
  );
  assert.equal(realWarningOffer?.priceConfidence, "live");
  assert.equal(realWarningOffer?.priceStatus, "unverified");
  assert.deepEqual(realWarningOffer?.warnings ?? [], ["Click and Book Plus no devolvió vuelos para esta búsqueda."]);
});
