import { test } from "bun:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CanonicalOffer,
  MatrixCell,
  MatrixResponse,
  ProviderMeta,
  SearchMeta,
  SearchRequest,
} from "../src/core/types";
import { addDays } from "../src/core/flexible-search";
import { buildCommercialQuotation } from "../src/core/quotation";
import {
  buildProviderContext,
  getCostamarChromeSessionScanCountForTests,
  resetCostamarSessionCacheForTests,
} from "../src/provider-context";
import {
  resetCostamarWarmupStateForTests,
  setCostamarWarmupGeneratorForTests,
} from "../src/local-costamar";
import {
  buildMatrixCellIndex,
  createTrailingProgressSync,
  createSharedQuotationRateResolver,
  materializeAggregatedMatrixResponse,
  mergeProviderSearchProgress,
  prepareOffersForQuotation,
  resolveQuotationReadyOffers,
  routeRequest,
  SEARCH_REVALIDATION_CACHE_TTL_MS,
  setQuotationOfferValidatorForTests,
  shouldPersistProgressSnapshot,
  updateMatrixDraftCell,
} from "../src/http-router";
import type { ProviderMatrixState } from "../src/http-router";
import {
  resetQuotationUsdToPenRateCacheForTests,
  resolveStandaloneUsdToPenRateInfo,
} from "../src/quotation-exchange-rate";
import { resolveSearchServiceProxyApiToken } from "../src/service-auth";
import { getSearchDatePolicy } from "../src/search-date-policy";
import { getRuntime } from "../src/runtime";
import { LOCATION_SUGGESTION_CACHE_MAX_QUERY_CHARS } from "../src/location-suggestion-cache";
import {
  DEFAULT_PROVIDER_STATUS_TTL_MS,
  providerStatusTtlMsFor,
} from "../src/provider-status";
import { providerPrewarmEnabled, providerPrewarmIntervalMs } from "../src/provider-prewarm";
import { createScryptPasswordHash, createWebSessionCookie } from "../src/web-auth";
import { resetWebLoginAdmission } from "../src/login-admission";
import { applyEnvironment } from "./helpers/environment";
import { withServer } from "./helpers/server";

function buildJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value))
    .toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

test("progress flushes geometric milestones without cumulative polling churn", async () => {
  let syncs = 0;
  const progress = createTrailingProgressSync(() => {
    syncs += 1;
  }, 20);

  progress.mark();
  progress.mark();
  assert.equal(syncs, 0);
  await Bun.sleep(35);
  assert.equal(syncs, 1);

  progress.mark();
  await Bun.sleep(35);
  assert.equal(syncs, 1);

  progress.mark();
  await Bun.sleep(35);
  assert.equal(syncs, 2);

  progress.mark();
  progress.mark();
  progress.mark();
  await Bun.sleep(35);
  assert.equal(syncs, 2);

  progress.mark();
  await Bun.sleep(35);
  assert.equal(syncs, 3);
  progress.dispose();
});

test("an exact search publishes as it resolves, like every other mode", async () => {
  /*
   * It used to be the exception: `mark()` returned early for `exact`, so a
   * provider that answers in parts — Agil reports each of its seven GDS ids —
   * showed nothing until the last part landed. On a long-haul route that was
   * the whole wait. The schedule is the same one every mode gets.
   */
  let syncs = 0;
  const progress = createTrailingProgressSync(() => {
    syncs += 1;
  }, 10);

  progress.mark();
  await Bun.sleep(20);
  assert.equal(syncs, 1);
  progress.dispose();

  // A job that ends takes its pending publish with it.
  let abandoned = 0;
  const pending = createTrailingProgressSync(() => {
    abandoned += 1;
  }, 50);
  pending.mark();
  pending.dispose();
  await Bun.sleep(70);
  assert.equal(abandoned, 0);
  pending.flush();
  assert.equal(abandoned, 0);
});

test("progress snapshots persist geometrically instead of rewriting every growing result set", () => {
  assert.equal(shouldPersistProgressSnapshot(0, 0), false);
  assert.equal(shouldPersistProgressSnapshot(0, 1), true);
  assert.equal(shouldPersistProgressSnapshot(5, 9), false);
  assert.equal(shouldPersistProgressSnapshot(5, 10), true);
});

test("five thousand progress callbacks publish only logarithmic full snapshots", () => {
  let syncs = 0;
  const progress = createTrailingProgressSync(() => {
    syncs += 1;
  }, 0);

  for (let index = 0; index < 5_000; index += 1) {
    progress.mark();
  }

  assert.equal(syncs, 13);
  progress.flush();
  assert.equal(syncs, 14);
  progress.dispose();
});

function buildTrackedMatrixState(
  providerId: "agil-local" | "costamar",
  cellCount: number,
  onCellRead: () => void,
): ProviderMatrixState {
  const cells = Array.from({ length: cellCount }, (_, index): MatrixCell => ({
    key: `cell-${index}`,
    departureDate: "2026-06-01",
    returnDate: "2026-06-08",
    stayNights: 7,
    confidence: "loading",
    providerSource: providerId,
    selectable: false,
    requiresRequery: true,
    stateCode: "ind",
    tooltip: "Consultando...",
    derivedRequest: buildCostamarRequest(),
  }));
  const cellIndex = buildMatrixCellIndex(cells);
  const trackedCells = new Proxy(cells, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) {
        onCellRead();
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const now = "2026-06-01T00:00:00.000Z";
  const response: MatrixResponse = {
    cells: trackedCells,
    axes: { departureDates: ["2026-06-01"], returnDates: ["2026-06-08"] },
    confidenceSummary: { loading: cellCount },
    recommendations: [],
    searchMeta: {
      requestedAt: now,
      completedAt: now,
      providersUsed: [providerId],
      warnings: [],
      partial: true,
      searchState: "search_partial",
    },
    providerMeta: { exactProvider: providerId, coverageMode: "core" },
    warnings: [],
  };
  return { response, completed: false, cellIndex };
}

test("matrix cell progress updates one indexed slot without rescanning the draft", () => {
  let cellReads = 0;
  const state = buildTrackedMatrixState("agil-local", 2_000, () => {
    cellReads += 1;
  });
  const replacement: MatrixCell = {
    ...state.response.cells[1_500]!,
    confidence: "live",
    selectable: true,
    stateCode: "live",
  };
  cellReads = 0;

  const updated = updateMatrixDraftCell(state.response, replacement, state.cellIndex);
  const updateReads = cellReads;

  assert.strictEqual(updated, state.response);
  assert.ok(updateReads <= 2, `Expected indexed update, observed ${updateReads} cell reads`);
  assert.strictEqual(updated.cells[1_500], replacement);
  assert.deepEqual(updated.confidenceSummary, { loading: 1_999, live: 1 });
});

test("matrix aggregation reads cells linearly through provider indexes", () => {
  const cellCount = 1_000;
  let cellReads = 0;
  const providerIds = ["agil-local", "costamar"] as const;
  const states = new Map(providerIds.map((providerId) => [
    providerId,
    buildTrackedMatrixState(providerId, cellCount, () => {
      cellReads += 1;
    }),
  ]));
  cellReads = 0;

  const materialized = materializeAggregatedMatrixResponse(
    buildCostamarRequest(),
    [...providerIds],
    states,
  );

  assert.equal(materialized.cells.length, cellCount);
  assert.deepEqual(materialized.cells.slice(0, 3).map((cell) => cell.key), ["cell-0", "cell-1", "cell-2"]);
  assert.ok(
    cellReads <= cellCount * providerIds.length * 10,
    `Expected linear aggregation, observed ${cellReads} cell reads`,
  );
});

test("incremental provider progress appends deltas without retaining a cached snapshot", () => {
  const cached = { ...buildCostamarOffer("https://cached.example/search"), id: "cached" };
  const first = { ...buildCostamarOffer("https://first.example/search"), id: "first" };
  const second = { ...buildCostamarOffer("https://second.example/search"), id: "second" };
  const staleState = {
    offers: [cached],
    warnings: ["cached"],
    partial: true,
    completed: false,
    fresh: false,
  };

  const freshState = mergeProviderSearchProgress(staleState, {
    offers: [first],
    warnings: ["first"],
    partial: true,
    incremental: true,
  });
  assert.notEqual(freshState, staleState);
  assert.deepEqual(freshState.offers.map((offer) => offer.id), ["first"]);

  const appendedState = mergeProviderSearchProgress(freshState, {
    offers: [second],
    warnings: ["second"],
    partial: true,
    incremental: true,
  });
  assert.equal(appendedState, freshState);
  assert.deepEqual(appendedState.offers.map((offer) => offer.id), ["first", "second"]);
});

function buildCostamarRequest(): SearchRequest {
  return {
    providerId: "costamar",
    tripType: "round-trip",
    searchMode: "exact",
    legs: [
      {
        origin: "LIM",
        destination: "MAD",
        departureDate: "2026-06-01",
        returnDate: "2026-06-08",
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
  const now = "2026-03-31T00:00:00.000Z";
  return {
    requestedAt: now,
    completedAt: now,
    providersUsed: ["costamar"],
    warnings: [],
    partial: false,
    searchState: "search_live",
  };
}

function buildProviderMeta(): ProviderMeta {
  return {
    exactProvider: "costamar",
    coverageMode: "core",
  };
}

function buildCostamarOffer(url: string): CanonicalOffer {
  return {
    id: "offer-costamar-1",
    signature: "offer-costamar-1-sig",
    providerSource: "costamar",
    providerOfferRef: "offer-costamar-1-ref",
    tripType: "round-trip",
    validatingCarrier: "IB",
    mainCarrier: "IB",
    origin: "LIM",
    destination: "MAD",
    itineraries: [
      {
        id: "offer-costamar-1-out",
        direction: "outbound",
        durationMinutes: 720,
        stops: 0,
        layoverMinutes: [],
        segments: [
          {
            id: "offer-costamar-1-out-seg",
            marketingCarrier: "IB",
            flightNumber: "6650",
            origin: "LIM",
            destination: "MAD",
            departureAt: "2026-06-01T10:00:00Z",
            arrivalAt: "2026-06-01T22:00:00Z",
            durationMinutes: 720,
          },
        ],
      },
      {
        id: "offer-costamar-1-in",
        direction: "inbound",
        durationMinutes: 720,
        stops: 0,
        layoverMinutes: [],
        segments: [
          {
            id: "offer-costamar-1-in-seg",
            marketingCarrier: "IB",
            flightNumber: "6651",
            origin: "MAD",
            destination: "LIM",
            departureAt: "2026-06-08T10:00:00Z",
            arrivalAt: "2026-06-08T22:00:00Z",
            durationMinutes: 720,
          },
        ],
      },
    ],
    price: {
      total: {
        amount: 1234,
        currencyCode: "USD",
      },
    },
    usdToPenRate: 3.5,
    priceConfidence: "live",
    priceStatus: "unverified",
    purchasePaths: [
      {
        id: "offer-costamar-1-path",
        type: "search-redirect",
        provider: "costamar",
        label: "Buscar en Click and Book Plus",
        url,
        precision: "exact-search",
        score: 0.9,
        requiresNewTab: true,
        commercialMode: "provider",
        state: "search_redirect",
      },
    ],
    comparisonMetrics: {
      totalDurationMinutes: 1440,
      totalStops: 0,
      baggageScore: 0,
      purchasePathScore: 0,
    },
    tags: [],
    warnings: [],
  };
}

function buildDomesticCostamarOffer(): CanonicalOffer {
  const offer = buildCostamarOffer("https://booking.clickandbook.com/vuelos/b/LIM/CUZ/2026-06-01/2026-06-08/1/0/0");
  return {
    ...offer,
    destination: "CUZ",
    usdToPenRate: undefined,
    itineraries: offer.itineraries.map((itinerary) => ({
      ...itinerary,
      segments: itinerary.segments.map((segment) => itinerary.direction === "outbound"
        ? { ...segment, destination: "CUZ" }
        : { ...segment, origin: "CUZ" }),
    })),
  };
}

function buildDomesticRequest(): SearchRequest {
  const request = buildCostamarRequest();
  return {
    ...request,
    legs: [{
      ...request.legs[0]!,
      destination: "CUZ",
      originLabel: "LIM - Lima, Perú",
      destinationLabel: "CUZ - Cusco, Perú",
    }],
  };
}

test("Costamar-only domestic offers resolve their quotation rate before publication", async () => {
  const request = buildDomesticRequest();
  const [offer] = await resolveQuotationReadyOffers(
    request,
    [buildDomesticCostamarOffer()],
    async () => ({ rate: 3.61, sourceLabel: "SUNAT", date: "2026-06-01" }),
  );

  assert.equal(offer?.usdToPenRate, 3.61);
  assert.ok(offer?.quotationPreparedAt);
  const quotation = buildCommercialQuotation(offer!, request, { usdToPenRate: offer?.usdToPenRate, timeZone: "UTC" });
  assert.match(quotation, /S\//);
  assert.doesNotMatch(quotation, /US\$/);
});

test("quotation preparation propagates a sibling Agil rate", () => {
  const request = buildDomesticRequest();
  const costamar = buildDomesticCostamarOffer();
  const agil = {
    ...buildDomesticCostamarOffer(),
    id: "offer-agil-domestic",
    signature: "offer-agil-domestic-sig",
    providerSource: "agil-local" as const,
    usdToPenRate: 3.64,
  };
  const prepared = prepareOffersForQuotation(request, [costamar, agil]);
  const matrixSelection = prepareOffersForQuotation(request, [costamar], [agil]);

  assert.deepEqual(prepared.map((offer) => offer.usdToPenRate), [3.64, 3.64]);
  assert.ok(prepared.every((offer) => offer.quotationPreparedAt));
  assert.equal(matrixSelection[0]?.usdToPenRate, 3.64);
  assert.ok(matrixSelection[0]?.quotationPreparedAt);
});

test("quotation preparation timestamps quote-readiness once and preserves it", () => {
  const request = buildDomesticRequest();
  const preexistingTimestamp = "2026-06-01T10:30:00.000Z";
  const preexisting = {
    ...buildDomesticCostamarOffer(),
    usdToPenRate: 3.64,
    quotationPreparedAt: preexistingTimestamp,
  };
  const [preserved] = prepareOffersForQuotation(request, [preexisting]);
  const [firstPreparation] = prepareOffersForQuotation(request, [{
    ...buildDomesticCostamarOffer(),
    usdToPenRate: 3.64,
  }]);
  const [secondPreparation] = prepareOffersForQuotation(request, [firstPreparation!]);

  assert.equal(preserved?.quotationPreparedAt, preexistingTimestamp);
  assert.ok(firstPreparation?.quotationPreparedAt);
  assert.equal(secondPreparation?.quotationPreparedAt, firstPreparation?.quotationPreparedAt);
  assert.equal(firstPreparation?.priceVerifiedAt, undefined);
});

test("quotation preparation withholds readiness when required conversion cannot resolve", async () => {
  const [offer] = await resolveQuotationReadyOffers(
    buildDomesticRequest(),
    [buildDomesticCostamarOffer()],
    async () => undefined,
  );

  assert.equal(offer?.usdToPenRate, undefined);
  assert.equal(offer?.quotationPreparedAt, undefined);

  const internationalPen = {
    ...buildCostamarOffer("https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0"),
    price: { total: { amount: 4_500, currencyCode: "PEN" } },
    usdToPenRate: undefined,
  };
  assert.equal(
    prepareOffersForQuotation(buildCostamarRequest(), [internationalPen])[0]?.quotationPreparedAt,
    undefined,
  );

  const [resolvedInternationalPen] = await resolveQuotationReadyOffers(
    buildCostamarRequest(),
    [internationalPen],
    async () => ({ rate: 3.61, sourceLabel: "SUNAT", date: "2026-06-01" }),
  );
  assert.equal(resolvedInternationalPen?.usdToPenRate, 3.61);
  assert.ok(resolvedInternationalPen?.quotationPreparedAt);
});

test("quotation rate prefetch gets at most one final retry after resolving undefined", async () => {
  const offer = buildDomesticCostamarOffer();
  let lookupCalls = 0;
  const resolver = createSharedQuotationRateResolver(async () => {
    lookupCalls += 1;
    return undefined;
  });

  assert.equal(await resolver(offer), undefined);
  const [firstFinalOffer] = await resolveQuotationReadyOffers(buildDomesticRequest(), [offer], resolver);
  const [secondFinalOffer] = await resolveQuotationReadyOffers(buildDomesticRequest(), [offer], resolver);

  assert.equal(lookupCalls, 2);
  assert.equal(firstFinalOffer?.usdToPenRate, undefined);
  assert.equal(firstFinalOffer?.quotationPreparedAt, undefined);
  assert.equal(secondFinalOffer?.quotationPreparedAt, undefined);
});

test("search revalidation cache ttl is four hours", () => {
  assert.equal(SEARCH_REVALIDATION_CACHE_TTL_MS, 4 * 60 * 60 * 1000);
});

function buildCostamarMatrixCell(url: string): MatrixCell {
  const offer = buildCostamarOffer(url);

  return {
    key: "2026-06-01_2026-06-08",
    departureDate: "2026-06-01",
    returnDate: "2026-06-08",
    stayNights: 7,
    price: {
      amount: 498,
      currencyCode: "USD",
    },
    confidence: "live",
    providerSource: "costamar",
    selectable: true,
    requiresRequery: true,
    stateCode: "live",
    tooltip: "Click and Book Plus live search.",
    derivedRequest: buildCostamarRequest(),
    purchasePaths: [
      {
        id: "matrix-costamar-path",
        type: "search-redirect",
        provider: "costamar",
        label: "Buscar en Click and Book Plus",
        url,
        precision: "exact-search",
        score: 0.9,
        requiresNewTab: true,
        commercialMode: "provider",
        state: "search_redirect",
      },
    ],
    offer: {
      ...offer,
      id: "matrix-offer-costamar-1",
      purchasePaths: [
        {
          ...offer.purchasePaths[0],
          id: "matrix-offer-costamar-1-path",
        },
      ],
    },
  };
}

async function withAcceptedCostamarRedirectValidation<T>(run: () => Promise<T>): Promise<T> {
  const previousFetch = global.fetch;
  global.fetch = (async (input, init) => {
    const url = typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url;
    if (url.startsWith("https://booking.clickandbook.com/") || url.startsWith("https://flights.zdev.tech/")) {
      return new Response("<html><body>Click and Book Plus search accepted</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return previousFetch(input, init);
  }) as typeof fetch;

  try {
    return await run();
  } finally {
    global.fetch = previousFetch;
  }
}

async function withLoopbackTrustForTests<T>(run: () => Promise<T>): Promise<T> {
  const previousTrustLoopback = process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
  process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = "1";

  try {
    return await run();
  } finally {
    if (previousTrustLoopback === undefined) {
      delete process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
    } else {
      process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = previousTrustLoopback;
    }
  }
}

test("quotation uses the stored exact offer when the selected result belongs to a search job", async () => {
  const runtime = getRuntime();
  const offer = {
    ...buildCostamarOffer("https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0"),
    priceConfidence: "validated" as const,
    priceStatus: "verified" as const,
    priceVerifiedAt: new Date().toISOString(),
  };
  const searchMeta = buildSearchMeta();
  const now = new Date().toISOString();
  const job = runtime.sessions.createSearchJob({
    request: buildCostamarRequest(),
    offers: [offer],
    allOffers: [offer],
    searchMeta: {
      ...searchMeta,
      requestedAt: now,
      completedAt: now,
    },
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/quotation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        searchSessionId: job.id,
        offerId: offer.id,
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as { commercialText?: string };
    assert.match(payload.commercialText ?? "", /COTIZACIÓN BOLETO AÉREO/);
    assert.match(payload.commercialText ?? "", /US\$ 1,234 por adulto/);
    assert.doesNotMatch(payload.commercialText ?? "", /S\/|aprox|Tipo de cambio|Fuente:|Fecha:/);

    const migrationResponse = await fetch(`${baseUrl}/api/quotation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        searchSessionId: job.id,
        offerId: offer.id,
        migrationPlan: true,
      }),
    });
    assert.equal(migrationResponse.status, 200);
    const migrationPayload = await migrationResponse.json() as { commercialText?: string };
    assert.match(migrationPayload.commercialText ?? "", /^PAQUETE MIGRATORIO MADRID 🇪🇸/);
  });
});

test("quotation returns the rate that produced the confirmed text", async () => {
  /*
   * 05 §5 lets the «Paquete migratorio» toggle rewrite the quotation in the
   * browser. The endpoint used to resolve the rate for the text only and throw
   * it away, so that rewrite had to find a rate somewhere else — in another
   * provider's offer, or nowhere — and a confirmed «S/ 361 por adulto» came
   * back as «USD 100 por adulto». The rate now travels with the offer.
   */
  const runtime = getRuntime();
  const request = buildDomesticRequest();
  const now = new Date().toISOString();
  const offer = {
    ...buildDomesticCostamarOffer(),
    // The provider did not supply one; the endpoint has to resolve it.
    usdToPenRate: undefined,
    priceConfidence: "validated" as const,
    priceStatus: "verified" as const,
    priceVerifiedAt: now,
  };
  const job = runtime.sessions.createSearchJob({
    request,
    offers: [offer],
    allOffers: [offer],
    searchMeta: { ...buildSearchMeta(), requestedAt: now, completedAt: now },
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });

  // Prime the day cache the endpoint reads, without going to the network.
  await resolveStandaloneUsdToPenRateInfo(offer, { fetchExternalRate: async () => 3.61 });
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/quotation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ searchSessionId: job.id, offerId: offer.id }),
      });

      assert.equal(response.status, 200);
      const payload = await response.json() as {
        commercialText?: string
        offer?: { usdToPenRate?: number }
      };
      assert.match(payload.commercialText ?? "", /S\//);
      assert.equal(payload.offer?.usdToPenRate, 3.61);
    });
  } finally {
    resetQuotationUsdToPenRateCacheForTests();
  }
});

test("quotation rejects client-supplied offer snapshots without a stored server offer", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/quotation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        offer: {
          id: "2026-06-01_2026-06-08",
          providerSource: "costamar",
          airline: "Flexible",
          origin: "LIM",
          destination: "MAD",
          departureDate: "2026-06-01",
          returnDate: "2026-06-08",
          price: {
            total: {
              amount: 498,
              currencyCode: "USD",
            },
          },
          priceConfidence: "live",
          priceStatus: "unverified",
          usdToPenRate: 3.5,
        },
        request: buildCostamarRequest(),
      }),
    });

    assert.equal(response.status, 400);
    const payload = await response.json() as { errors?: string[] };
    assert.ok(payload.errors?.includes("searchSessionId and offerId are required."));
  });
});

test("quotation rejects forged snapshots when the session offer id does not exist", async () => {
  const runtime = getRuntime();
  const storedOffer = {
    ...buildCostamarOffer("https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0"),
    priceConfidence: "validated" as const,
    priceStatus: "verified" as const,
  };
  const job = runtime.sessions.createSearchJob({
    request: buildCostamarRequest(),
    offers: [storedOffer],
    allOffers: [storedOffer],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/quotation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        searchSessionId: job.id,
        offerId: "attacker-offer",
        offer: {
          id: "attacker-offer",
          providerSource: "costamar",
          airline: "Bogus Air",
          origin: "LIM",
          destination: "MAD",
          departureDate: "2026-06-01",
          returnDate: "2026-06-08",
          price: { total: { amount: 33.3, currencyCode: "USD" } },
          usdToPenRate: 7.7,
        },
        request: buildCostamarRequest(),
      }),
    });

    assert.equal(response.status, 404);
    const payload = await response.json() as { errors?: string[] };
    assert.ok(payload.errors?.includes("Session or offer not found."));
  });
});

test("quotation refuses a price-only matrix cell without a real stored itinerary", async () => {
  const runtime = getRuntime();
  const resolved = buildCostamarMatrixCell(
    "https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0",
  );
  const priceOnlyCell: MatrixCell = {
    ...resolved,
    offer: undefined,
  };
  const job = runtime.sessions.createMatrixJob({
    request: {
      ...buildCostamarRequest(),
      searchMode: "roundtrip-grid",
      flexibleMode: "exact-stay",
    },
    cells: [priceOnlyCell],
    axes: {
      departureDates: [priceOnlyCell.departureDate],
      returnDates: [priceOnlyCell.returnDate!],
    },
    confidenceSummary: { live: 1 },
    recommendations: [],
    providerMeta: buildProviderMeta(),
    searchMeta: buildSearchMeta(),
    warnings: [],
    status: "completed",
  });

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/quotation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        searchSessionId: job.id,
        offerId: priceOnlyCell.key,
      }),
    });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      errors: ["Session or offer not found."],
    });
  });
});

test("quotation refuses cached offers that have not been provider validated", async () => {
  const runtime = getRuntime();
  const offer = buildCostamarOffer("https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0");
  const job = runtime.sessions.createSearchJob({
    request: buildCostamarRequest(),
    offers: [offer],
    allOffers: [offer],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/quotation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        searchSessionId: job.id,
        offerId: offer.id,
      }),
    });

    assert.equal(response.status, 409);
    const payload = await response.json() as { errors?: string[] };
    assert.ok(payload.errors?.includes("Selected offer could not be validated for quotation."));
  });
});

test("quotation persists a refreshed exact offer under the selected stable id", { concurrency: false }, async () => {
  const runtime = getRuntime();
  const offer = buildCostamarOffer("https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0");
  const job = runtime.sessions.createSearchJob({
    request: buildCostamarRequest(),
    offers: [offer],
    allOffers: [offer],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });
  let validatorCalls = 0;

  setQuotationOfferValidatorForTests(async (source) => {
    validatorCalls += 1;
    assert.equal(source.sessionId, job.id);
    assert.equal(source.offer.id, offer.id);
    return {
      ...source.offer,
      id: "provider-refreshed-price-id",
      price: {
        ...source.offer.price,
        total: {
          amount: 1500,
          currencyCode: "USD",
        },
      },
      priceConfidence: "validated",
      priceStatus: "verified",
    };
  });

  try {
    const response = await withLoopbackTrustForTests(() =>
      routeRequest(new Request("http://127.0.0.1:8100/api/quotation", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-flydesk-client-loopback": "1",
        },
        body: JSON.stringify({
          searchSessionId: job.id,
          offerId: offer.id,
        }),
      }))
    );

    assert.equal(response.status, 200);
    const payload = await response.json() as { commercialText?: string; offer?: CanonicalOffer };
    assert.equal(validatorCalls, 1);
    assert.equal(payload.offer?.id, offer.id);
    assert.equal(payload.offer?.price.total.amount, 1500);
    assert.ok(payload.offer?.priceVerifiedAt);
    assert.match(payload.commercialText ?? "", /US\$ 1,500 por adulto/);

    const stored = runtime.sessions.getOffer(job.id, offer.id);
    assert.equal(stored?.priceStatus, "verified");
    assert.equal(stored?.price.total.amount, 1500);
    assert.ok(stored?.priceVerifiedAt);

    const secondResponse = await withLoopbackTrustForTests(() =>
      routeRequest(new Request("http://127.0.0.1:8100/api/quotation", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-flydesk-client-loopback": "1",
        },
        body: JSON.stringify({
          searchSessionId: job.id,
          offerId: offer.id,
        }),
      }))
    );
    assert.equal(secondResponse.status, 200);
    assert.equal(validatorCalls, 1);
  } finally {
    setQuotationOfferValidatorForTests();
  }
});

test("quotation refuses a validator result for a different flight on the same route and day", { concurrency: false }, async () => {
  const runtime = getRuntime();
  const offer = buildCostamarOffer("https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0");
  const job = runtime.sessions.createSearchJob({
    request: buildCostamarRequest(),
    offers: [offer],
    allOffers: [offer],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });
  let validatorCalls = 0;

  setQuotationOfferValidatorForTests(async (source) => {
    validatorCalls += 1;
    return {
      ...source.offer,
      id: "different-flight",
      price: {
        ...source.offer.price,
        total: { amount: 99, currencyCode: "USD" },
      },
      itineraries: source.offer.itineraries.map((itinerary, itineraryIndex) => ({
        ...itinerary,
        segments: itinerary.segments.map((segment, segmentIndex) => itineraryIndex === 0 && segmentIndex === 0
          ? { ...segment, flightNumber: `${segment.flightNumber}-different` }
          : segment),
      })),
    };
  });

  try {
    const response = await withLoopbackTrustForTests(() =>
      routeRequest(new Request("http://127.0.0.1:8100/api/quotation", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-flydesk-client-loopback": "1",
        },
        body: JSON.stringify({
          searchSessionId: job.id,
          offerId: offer.id,
        }),
      }))
    );

    assert.equal(response.status, 409);
    assert.equal(validatorCalls, 1);
    assert.deepEqual(await response.json(), {
      errors: ["Selected offer could not be validated for quotation."],
    });
  } finally {
    setQuotationOfferValidatorForTests();
  }
});

test("quotation revalidates a stale verified search result before rendering", { concurrency: false }, async () => {
  const runtime = getRuntime();
  const offer = {
    ...buildCostamarOffer("https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0"),
    quotationPreparedAt: new Date().toISOString(),
    priceConfidence: "validated" as const,
    priceStatus: "verified" as const,
    priceVerifiedAt: new Date(Date.now() - 16 * 60_000).toISOString(),
  };
  const job = runtime.sessions.createSearchJob({
    request: buildCostamarRequest(),
    offers: [offer],
    allOffers: [offer],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });
  let validatorCalls = 0;

  setQuotationOfferValidatorForTests(async (source) => {
    validatorCalls += 1;
    return source.offer;
  });

  try {
    const response = await withLoopbackTrustForTests(() =>
      routeRequest(new Request("http://127.0.0.1:8100/api/quotation", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-flydesk-client-loopback": "1",
        },
        body: JSON.stringify({
          searchSessionId: job.id,
          offerId: offer.id,
        }),
      }))
    );

    assert.equal(response.status, 200);
    assert.equal(validatorCalls, 1);
    const payload = await response.json() as { offer?: CanonicalOffer };
    const verifiedAt = Date.parse(payload.offer?.priceVerifiedAt ?? "");
    assert.ok(Number.isFinite(verifiedAt));
    assert.ok(Date.now() - verifiedAt < 60_000);
  } finally {
    setQuotationOfferValidatorForTests();
  }
});

test("rejects exact searches when origin and destination are omitted", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sortMode: "cheapest",
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              departureDate: "2026-04-15",
              returnDate: "2026-04-22",
            },
          ],
        },
      }),
    });

    assert.equal(response.status, 400);
    const payload = await response.json() as { errors?: string[] };
    assert.ok(payload.errors?.some((message) => message.includes("Origin is required")));
    assert.ok(payload.errors?.some((message) => message.includes("Destination is required")));
  });
});

test("rejects invalid passenger counts", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sortMode: "cheapest",
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureDate: "2026-04-15",
              returnDate: "2026-04-22",
            },
          ],
          passengers: {
            adults: 1.5,
            children: -1,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 400);
    const payload = await response.json() as { errors?: string[] };
    assert.ok(payload.errors?.includes("Adults must be a non-negative integer."));
    assert.ok(payload.errors?.includes("Children must be a non-negative integer."));
  });
});

test("rejects non-loopback location requests without a valid api token", { concurrency: false }, async () => {
  const previousApiToken = process.env.FLY_DESK_API_TOKEN;
  process.env.FLY_DESK_API_TOKEN = "test-token";

  try {
    const response = await routeRequest(new Request("http://fly-desk.local/api/locations?q=", {
      method: "GET",
      headers: {
        "x-flydesk-client-loopback": "0",
      },
    }));

    assert.equal(response.status, 403);
    const payload = await response.json() as { error?: string };
    assert.match(payload.error ?? "", /localhost access or a valid API token/i);
  } finally {
    if (previousApiToken === undefined) {
      delete process.env.FLY_DESK_API_TOKEN;
    } else {
      process.env.FLY_DESK_API_TOKEN = previousApiToken;
    }
  }
});

test("accepts non-loopback location requests with a valid api token", { concurrency: false }, async () => {
  const previousApiToken = process.env.FLY_DESK_API_TOKEN;
  process.env.FLY_DESK_API_TOKEN = "test-token";

  try {
    const response = await routeRequest(new Request("http://fly-desk.local/api/locations?q=", {
      method: "GET",
      headers: {
        "x-flydesk-client-loopback": "0",
        "x-flydesk-api-token": "test-token",
      },
    }));

    assert.equal(response.status, 200);
    const payload = await response.json() as { query?: string; suggestions?: unknown[] };
    assert.equal(payload.query, "");
    assert.deepEqual(payload.suggestions, []);
  } finally {
    if (previousApiToken === undefined) {
      delete process.env.FLY_DESK_API_TOKEN;
    } else {
      process.env.FLY_DESK_API_TOKEN = previousApiToken;
    }
  }
});

test("accepts non-loopback location requests with the internal search service token", { concurrency: false }, async () => {
  const previousApiToken = process.env.FLY_DESK_API_TOKEN;
  const previousSearchToken = process.env.FLY_DESK_SEARCH_SERVICE_API_TOKEN;
  const previousSessionSecret = process.env.FLY_DESK_WEB_SESSION_SECRET;
  delete process.env.FLY_DESK_API_TOKEN;
  delete process.env.FLY_DESK_SEARCH_SERVICE_API_TOKEN;
  process.env.FLY_DESK_WEB_SESSION_SECRET = "test-session-secret-32-characters-minimum";

  try {
    const internalToken = resolveSearchServiceProxyApiToken();
    assert.ok(internalToken);
    const response = await routeRequest(new Request("http://fly-desk.local/api/locations?q=", {
      method: "GET",
      headers: {
        "x-flydesk-client-loopback": "0",
        "x-flydesk-api-token": internalToken,
      },
    }));

    assert.equal(response.status, 200);
    const payload = await response.json() as { query?: string; suggestions?: unknown[] };
    assert.equal(payload.query, "");
    assert.deepEqual(payload.suggestions, []);
  } finally {
    if (previousApiToken === undefined) {
      delete process.env.FLY_DESK_API_TOKEN;
    } else {
      process.env.FLY_DESK_API_TOKEN = previousApiToken;
    }

    if (previousSearchToken === undefined) {
      delete process.env.FLY_DESK_SEARCH_SERVICE_API_TOKEN;
    } else {
      process.env.FLY_DESK_SEARCH_SERVICE_API_TOKEN = previousSearchToken;
    }

    if (previousSessionSecret === undefined) {
      delete process.env.FLY_DESK_WEB_SESSION_SECRET;
    } else {
      process.env.FLY_DESK_WEB_SESSION_SECRET = previousSessionSecret;
    }
  }
});

test("provider status is authenticated, uncached, closed, and contains no provider diagnostics", { concurrency: false }, async () => {
  const previousApiToken = process.env.FLY_DESK_API_TOKEN;
  const previousSearchUrl = process.env.FLY_DESK_SEARCH_SERVICE_URL;
  process.env.FLY_DESK_API_TOKEN = "test-token";
  delete process.env.FLY_DESK_SEARCH_SERVICE_URL;

  try {
    const denied = await routeRequest(new Request("http://fly-desk.local/api/provider-status", {
      headers: { "x-flydesk-client-loopback": "0" },
    }));
    assert.equal(denied.status, 403);

    const tracker = getRuntime().providerStatus;
    tracker.recordSearchResult("agil-local", false);
    tracker.recordSearchFailure(
      "costamar",
      new Error("token=never-return-this-secret request timed out"),
    );

    const response = await routeRequest(new Request("http://fly-desk.local/api/provider-status", {
      headers: {
        "x-flydesk-client-loopback": "0",
        "x-flydesk-api-token": "test-token",
      },
    }));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const payload = await response.json() as {
      generatedAt?: string;
      staleAfterMs?: number;
      providers?: Array<Record<string, unknown>>;
    };
    assert.ok(payload.generatedAt && Number.isFinite(Date.parse(payload.generatedAt)));
    /* 03 §5: «aparecer = disponible». A ready observation has to outlive the
       cycle that renews it, or the rail empties while the providers are up,
       so the TTL is derived from the prewarm interval rather than pinned. */
    const expectedStaleAfterMs = providerPrewarmEnabled()
      ? providerStatusTtlMsFor(providerPrewarmIntervalMs())
      : DEFAULT_PROVIDER_STATUS_TTL_MS;
    assert.equal(payload.staleAfterMs, expectedStaleAfterMs);
    assert.ok(!providerPrewarmEnabled() || expectedStaleAfterMs > providerPrewarmIntervalMs());
    assert.deepEqual(payload.providers?.map(({ id, state, evidence, reasonCode }) => ({
      id,
      state,
      evidence,
      reasonCode,
    })), [
      { id: "agil-local", state: "ready", evidence: "search", reasonCode: null },
      { id: "costamar", state: "degraded", evidence: "search", reasonCode: "timeout" },
    ]);
    assert.deepEqual(Object.keys(payload.providers?.[0] ?? {}), [
      "id",
      "label",
      "configured",
      "state",
      "evidence",
      "reasonCode",
      "observedAt",
      "stale",
    ]);
    const serialized = JSON.stringify(payload);
    assert.doesNotMatch(serialized, /never-return-this-secret|observedAtMs|\"error\"|https?:\/\//i);
  } finally {
    if (previousApiToken === undefined) delete process.env.FLY_DESK_API_TOKEN;
    else process.env.FLY_DESK_API_TOKEN = previousApiToken;
    if (previousSearchUrl === undefined) delete process.env.FLY_DESK_SEARCH_SERVICE_URL;
    else process.env.FLY_DESK_SEARCH_SERVICE_URL = previousSearchUrl;
  }
});

test("rejects unauthenticated search service proxy requests before injecting the runner token", { concurrency: false }, async () => {
  const previousSearchUrl = process.env.FLY_DESK_SEARCH_SERVICE_URL;
  const previousSearchToken = process.env.FLY_DESK_SEARCH_SERVICE_API_TOKEN;
  const previousWebAuth = process.env.FLY_DESK_WEB_AUTH;
  const previousPasswordHash = process.env.FLY_DESK_WEB_PASSWORD_HASH;
  const previousSessionSecret = process.env.FLY_DESK_WEB_SESSION_SECRET;

  process.env.FLY_DESK_SEARCH_SERVICE_URL = "http://127.0.0.1:8101";
  process.env.FLY_DESK_SEARCH_SERVICE_API_TOKEN = "internal-runner-token";
  process.env.FLY_DESK_WEB_AUTH = "1";
  process.env.FLY_DESK_WEB_PASSWORD_HASH = "test-hash";
  process.env.FLY_DESK_WEB_SESSION_SECRET = "test-session-secret-32-characters-minimum";

  try {
    const response = await routeRequest(new Request("http://fly-desk.local/api/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-flydesk-client-loopback": "0",
      },
      body: "{}",
    }));

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Authentication required." });
  } finally {
    if (previousSearchUrl === undefined) delete process.env.FLY_DESK_SEARCH_SERVICE_URL;
    else process.env.FLY_DESK_SEARCH_SERVICE_URL = previousSearchUrl;

    if (previousSearchToken === undefined) delete process.env.FLY_DESK_SEARCH_SERVICE_API_TOKEN;
    else process.env.FLY_DESK_SEARCH_SERVICE_API_TOKEN = previousSearchToken;

    if (previousWebAuth === undefined) delete process.env.FLY_DESK_WEB_AUTH;
    else process.env.FLY_DESK_WEB_AUTH = previousWebAuth;

    if (previousPasswordHash === undefined) delete process.env.FLY_DESK_WEB_PASSWORD_HASH;
    else process.env.FLY_DESK_WEB_PASSWORD_HASH = previousPasswordHash;

    if (previousSessionSecret === undefined) delete process.env.FLY_DESK_WEB_SESSION_SECRET;
    else process.env.FLY_DESK_WEB_SESSION_SECRET = previousSessionSecret;
  }
});

test("quotation requests reach the runner that owns the selected search session", { concurrency: false }, async () => {
  const previousSearchUrl = process.env.FLY_DESK_SEARCH_SERVICE_URL;
  const previousSearchToken = process.env.FLY_DESK_SEARCH_SERVICE_API_TOKEN;
  const previousFetch = global.fetch;
  process.env.FLY_DESK_SEARCH_SERVICE_URL = "http://127.0.0.1:8101";
  process.env.FLY_DESK_SEARCH_SERVICE_API_TOKEN = "internal-runner-token";

  try {
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(input), "http://127.0.0.1:8101/api/quotation");
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer internal-runner-token");
      assert.deepEqual(JSON.parse(await new Response(init?.body).text()), {
        searchSessionId: "runner-session",
        offerId: "runner-offer",
        migrationPlan: true,
      });
      return Response.json({ commercialText: "PAQUETE MIGRATORIO MADRID 🇪🇸", offer: {} });
    }) as typeof fetch;

    const response = await withLoopbackTrustForTests(() => routeRequest(new Request("http://127.0.0.1:8100/api/quotation", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-flydesk-client-loopback": "1",
      },
      body: JSON.stringify({
        searchSessionId: "runner-session",
        offerId: "runner-offer",
        migrationPlan: true,
      }),
    })));

    assert.equal(response.status, 200);
    assert.equal((await response.json() as { commercialText?: string }).commercialText, "PAQUETE MIGRATORIO MADRID 🇪🇸");
  } finally {
    global.fetch = previousFetch;
    if (previousSearchUrl === undefined) delete process.env.FLY_DESK_SEARCH_SERVICE_URL;
    else process.env.FLY_DESK_SEARCH_SERVICE_URL = previousSearchUrl;
    if (previousSearchToken === undefined) delete process.env.FLY_DESK_SEARCH_SERVICE_API_TOKEN;
    else process.env.FLY_DESK_SEARCH_SERVICE_API_TOKEN = previousSearchToken;
  }
});

test("location usage ranking is read-only, uncached by HTTP, and capped at three cards", { concurrency: false }, async () => {
  const previousApiToken = process.env.FLY_DESK_API_TOKEN;
  process.env.FLY_DESK_API_TOKEN = "test-token";
  getRuntime().locationUsage.clearForTests();

  try {
    const usage = getRuntime().locationUsage;
    const clientSessionId = "browser-session-http-a";
    const nowMs = Date.now();
    usage.recordFromSearch({ origin: "LIM", destination: "MAD" }, nowMs, 3, clientSessionId);
    usage.recordFromSearch({ origin: "CUZ", destination: "BOG" }, nowMs + 1, 3, clientSessionId);
    usage.recordFromSearch({ origin: "AQP", destination: "SCL" }, nowMs + 2, 3, clientSessionId);
    usage.recordFromSearch({ origin: "TPP", destination: "MIA" }, nowMs + 3, 3, clientSessionId);

    const response = await routeRequest(new Request(`http://fly-desk.local/api/location-usage-suggestions?limit=20&clientSessionId=${clientSessionId}`, {
      method: "GET",
      headers: {
        "x-flydesk-client-loopback": "0",
        "x-flydesk-api-token": "test-token",
      },
    }));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const payload = await response.json() as {
      suggestions?: { origin?: string[]; destination?: string[] };
      frequent?: { origin?: string[]; destination?: string[] };
      recent?: { origin?: string[]; destination?: string[] };
    };
    assert.deepEqual(payload.suggestions?.origin, ["TPP", "AQP", "CUZ"]);
    assert.deepEqual(payload.suggestions?.destination, ["MIA", "SCL", "BOG"]);
    assert.deepEqual(payload.frequent, payload.suggestions);
    assert.deepEqual(payload.recent, {
      origin: ["TPP", "AQP", "CUZ"],
      destination: ["MIA", "SCL", "BOG"],
    });

    const invalidSession = await routeRequest(new Request("http://fly-desk.local/api/location-usage-suggestions?clientSessionId=invalid/id", {
      method: "GET",
      headers: {
        "x-flydesk-client-loopback": "0",
        "x-flydesk-api-token": "test-token",
      },
    }));
    const invalidPayload = await invalidSession.json() as { recent?: { origin?: string[]; destination?: string[] } };
    assert.deepEqual(invalidPayload.recent, { origin: [], destination: [] });

    const mutation = await routeRequest(new Request("http://fly-desk.local/api/location-usage-suggestions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-flydesk-client-loopback": "0",
        "x-flydesk-api-token": "test-token",
      },
      body: JSON.stringify({ origin: "LIM", destination: "MAD" }),
    }));
    assert.equal(mutation.status, 405);
    assert.equal(mutation.headers.get("Allow"), "GET");
  } finally {
    getRuntime().locationUsage.clearForTests();
    if (previousApiToken === undefined) {
      delete process.env.FLY_DESK_API_TOKEN;
    } else {
      process.env.FLY_DESK_API_TOKEN = previousApiToken;
    }
  }
});

test("accepted searches record global location usage from the backend", { concurrency: false }, async () => {
  const previousApiToken = process.env.FLY_DESK_API_TOKEN;
  process.env.FLY_DESK_API_TOKEN = "test-token";
  getRuntime().locationUsage.clearForTests();

  try {
    const clientSessionId = "browser-session-search-a";
    const request = buildCostamarRequest();
    const departureDate = getSearchDatePolicy().minSearchDate;
    delete request.providerId;
    request.legs[0] = {
      ...request.legs[0],
      departureDate,
      returnDate: addDays(departureDate, 7),
    };
    const accepted = await routeRequest(new Request("http://fly-desk.local/api/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-flydesk-client-loopback": "0",
        "x-flydesk-api-token": "test-token",
      },
      body: JSON.stringify({
        clientSessionId,
        request,
        sortMode: "cheapest",
      }),
    }));
    assert.equal(accepted.status, 200);

    const suggestions = getRuntime().locationUsage.getSuggestions(3);
    assert.deepEqual(suggestions, {
      origin: ["LIM"],
      destination: ["MAD"],
    });
    assert.deepEqual(getRuntime().locationUsage.getUsageSuggestions(clientSessionId).recent, {
      origin: ["LIM"],
      destination: ["MAD"],
    });
  } finally {
    getRuntime().locationUsage.clearForTests();
    if (previousApiToken === undefined) {
      delete process.env.FLY_DESK_API_TOKEN;
    } else {
      process.env.FLY_DESK_API_TOKEN = previousApiToken;
    }
  }
});

test("loopback trust does not authorize forwarded proxy clients unless proxy loopback trust is explicit", { concurrency: false }, async () => {
  const previousTrustLoopback = process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
  const previousProxyTrust = process.env.FLY_DESK_TRUST_REVERSE_PROXY_LOOPBACK;
  process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = "1";
  delete process.env.FLY_DESK_TRUST_REVERSE_PROXY_LOOPBACK;

  try {
    const forwarded = new Request("http://fly-desk.local/api/diagnostics", {
      method: "GET",
      headers: {
        "x-flydesk-client-loopback": "1",
        "x-forwarded-for": "203.0.113.77",
      },
    });

    const denied = await routeRequest(forwarded);
    assert.equal(denied.status, 403);

    process.env.FLY_DESK_TRUST_REVERSE_PROXY_LOOPBACK = "1";
    const accepted = await routeRequest(forwarded);
    assert.equal(accepted.status, 200);
  } finally {
    if (previousTrustLoopback === undefined) {
      delete process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
    } else {
      process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = previousTrustLoopback;
    }

    if (previousProxyTrust === undefined) {
      delete process.env.FLY_DESK_TRUST_REVERSE_PROXY_LOOPBACK;
    } else {
      process.env.FLY_DESK_TRUST_REVERSE_PROXY_LOOPBACK = previousProxyTrust;
    }
  }
});

test("web auth cookie allows API access when loopback trust is disabled", { concurrency: false }, async () => {
  const previousWebAuth = process.env.FLY_DESK_WEB_AUTH;
  const previousTrustLoopback = process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
  const previousPasswordHash = process.env.FLY_DESK_WEB_PASSWORD_HASH;
  const previousSessionSecret = process.env.FLY_DESK_WEB_SESSION_SECRET;
  const previousCookieSecure = process.env.FLY_DESK_COOKIE_SECURE;

  process.env.FLY_DESK_WEB_AUTH = "1";
  process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = "0";
  process.env.FLY_DESK_WEB_PASSWORD_HASH = createScryptPasswordHash("test-password", Buffer.alloc(16, 8));
  process.env.FLY_DESK_WEB_SESSION_SECRET = "test-session-secret-32-characters-minimum";
  process.env.FLY_DESK_COOKIE_SECURE = "1";

  try {
    const denied = await routeRequest(new Request("https://fly-desk.local/api/locations?q=", {
      method: "GET",
      headers: {
        "x-flydesk-client-loopback": "1",
      },
    }));

    assert.equal(denied.status, 401);

    const login = await routeRequest(new Request("https://fly-desk.local/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ password: "test-password" }).toString(),
    }));

    assert.equal(login.status, 303);
    const cookie = login.headers.get("set-cookie");
    const setCookies = login.headers.getSetCookie();
    assert.equal(setCookies.length, 2);
    assert.ok(setCookies.some((value) => value.startsWith("flydesk_session=")));
    assert.ok(setCookies.some((value) => value.startsWith("flydesk_redirect_session=")));
    assert.match(cookie ?? "", /flydesk_session=/);
    assert.match(cookie ?? "", /flydesk_redirect_session=/);
    assert.match(cookie ?? "", /Path=\/r/);
    assert.match(cookie ?? "", /HttpOnly/);
    assert.match(cookie ?? "", /Secure/);
    const webCookie = cookie?.match(/flydesk_session=[^;,]+/)?.[0] ?? "";

    const accepted = await routeRequest(new Request("https://fly-desk.local/api/locations?q=", {
      method: "GET",
      headers: {
        "x-flydesk-client-loopback": "0",
        Cookie: webCookie,
      },
    }));

    assert.equal(accepted.status, 200);
    const payload = await accepted.json() as { query?: string; suggestions?: unknown[] };
    assert.equal(payload.query, "");
    assert.deepEqual(payload.suggestions, []);

    const session = await routeRequest(new Request("https://fly-desk.local/api/auth/session", {
      headers: { Cookie: webCookie },
    }));
    assert.equal(session.status, 200);
    assert.match(session.headers.get("set-cookie") ?? "", /flydesk_redirect_session=/);
    assert.match(session.headers.get("set-cookie") ?? "", /Path=\/r/);

    const logout = await routeRequest(new Request("https://fly-desk.local/logout", {
      method: "POST",
      headers: { Cookie: webCookie },
    }));
    assert.equal(logout.status, 303);
    assert.equal(logout.headers.get("location"), "/login");
    assert.equal(logout.headers.getSetCookie().length, 2);
    assert.ok(logout.headers.getSetCookie().every((value) => value.includes("Max-Age=0")));
  } finally {
    if (previousWebAuth === undefined) {
      delete process.env.FLY_DESK_WEB_AUTH;
    } else {
      process.env.FLY_DESK_WEB_AUTH = previousWebAuth;
    }

    if (previousTrustLoopback === undefined) {
      delete process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
    } else {
      process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = previousTrustLoopback;
    }

    if (previousPasswordHash === undefined) {
      delete process.env.FLY_DESK_WEB_PASSWORD_HASH;
    } else {
      process.env.FLY_DESK_WEB_PASSWORD_HASH = previousPasswordHash;
    }

    if (previousSessionSecret === undefined) {
      delete process.env.FLY_DESK_WEB_SESSION_SECRET;
    } else {
      process.env.FLY_DESK_WEB_SESSION_SECRET = previousSessionSecret;
    }

    if (previousCookieSecure === undefined) {
      delete process.env.FLY_DESK_COOKIE_SECURE;
    } else {
      process.env.FLY_DESK_COOKIE_SECURE = previousCookieSecure;
    }
  }
});

test("web login isolates client buckets while keeping the abusive client throttled", { concurrency: false }, async () => {
  const previousWebAuth = process.env.FLY_DESK_WEB_AUTH;
  const previousWebPassword = process.env.FLY_DESK_WEB_PASSWORD;
  const previousPasswordHash = process.env.FLY_DESK_WEB_PASSWORD_HASH;
  const previousSessionSecret = process.env.FLY_DESK_WEB_SESSION_SECRET;

  process.env.FLY_DESK_WEB_AUTH = "1";
  delete process.env.FLY_DESK_WEB_PASSWORD;
  process.env.FLY_DESK_WEB_PASSWORD_HASH = createScryptPasswordHash(
    "correct-password",
    Buffer.alloc(16, 9),
  );
  process.env.FLY_DESK_WEB_SESSION_SECRET = "test-session-secret-32-characters-minimum";
  resetWebLoginAdmission();

  const clientHeaders = (clientAddress: string) => ({
    "Content-Type": "application/json",
    "x-flydesk-client-address": clientAddress,
    "x-flydesk-client-loopback": "1",
  });

  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await routeRequest(new Request("https://fly-desk.local/api/auth/login", {
        method: "POST",
        headers: clientHeaders("203.0.113.10"),
        body: JSON.stringify({ password: "wrong-password" }),
      }));
      assert.equal(response.status, 401);
    }

    const unaffectedClient = await routeRequest(new Request("https://fly-desk.local/api/auth/login", {
      method: "POST",
      headers: clientHeaders("203.0.113.11"),
      body: JSON.stringify({ password: "correct-password" }),
    }));
    assert.equal(unaffectedClient.status, 200);

    const limited = await routeRequest(new Request("https://fly-desk.local/api/auth/login", {
      method: "POST",
      headers: clientHeaders("203.0.113.10"),
      body: JSON.stringify({ password: "correct-password" }),
    }));
    assert.equal(limited.status, 429);
    assert.match(limited.headers.get("retry-after") ?? "", /^\d+$/);
    assert.deepEqual(await limited.json(), {
      error: "Too many login attempts. Try again later.",
    });
  } finally {
    resetWebLoginAdmission();
    if (previousWebAuth === undefined) delete process.env.FLY_DESK_WEB_AUTH;
    else process.env.FLY_DESK_WEB_AUTH = previousWebAuth;
    if (previousWebPassword === undefined) delete process.env.FLY_DESK_WEB_PASSWORD;
    else process.env.FLY_DESK_WEB_PASSWORD = previousWebPassword;
    if (previousPasswordHash === undefined) delete process.env.FLY_DESK_WEB_PASSWORD_HASH;
    else process.env.FLY_DESK_WEB_PASSWORD_HASH = previousPasswordHash;
    if (previousSessionSecret === undefined) delete process.env.FLY_DESK_WEB_SESSION_SECRET;
    else process.env.FLY_DESK_WEB_SESSION_SECRET = previousSessionSecret;
  }
});
test("invalid web password configuration returns 503 without consuming login admission", { concurrency: false }, async () => {
  const restore = applyEnvironment({
    FLY_DESK_WEB_AUTH: "1",
    FLY_DESK_WEB_PASSWORD: undefined,
    FLY_DESK_WEB_PASSWORD_HASH: "scrypt:not-a-valid-salt:not-a-valid-key",
    FLY_DESK_WEB_SESSION_SECRET: "test-session-secret-32-characters-minimum",
  });
  const clientHeaders = {
    "Content-Type": "application/json",
    "x-flydesk-client-address": "203.0.113.12",
    "x-flydesk-client-loopback": "1",
  };
  resetWebLoginAdmission();

  try {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await routeRequest(new Request("https://fly-desk.local/api/auth/login", {
        method: "POST",
        headers: clientHeaders,
        body: JSON.stringify({ password: "wrong-password" }),
      }));
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: "Web authentication is not configured.",
      });
    }

    process.env.FLY_DESK_WEB_PASSWORD_HASH = createScryptPasswordHash(
      "correct-password",
      Buffer.alloc(16, 10),
    );

    const firstCredentialFailure = await routeRequest(new Request("https://fly-desk.local/api/auth/login", {
      method: "POST",
      headers: clientHeaders,
      body: JSON.stringify({ password: "wrong-password" }),
    }));
    assert.equal(firstCredentialFailure.status, 401);

    const validLogin = await routeRequest(new Request("https://fly-desk.local/api/auth/login", {
      method: "POST",
      headers: clientHeaders,
      body: JSON.stringify({ password: "correct-password" }),
    }));
    assert.equal(validLogin.status, 200);
  } finally {
    resetWebLoginAdmission();
    restore();
  }
});


test("rejects non-loopback purchase path redirects without a valid api token", { concurrency: false }, async () => {
  const previousApiToken = process.env.FLY_DESK_API_TOKEN;
  process.env.FLY_DESK_API_TOKEN = "test-token";

  try {
    const response = await routeRequest(new Request("http://fly-desk.local/r/missing-path", {
      method: "GET",
      headers: {
        "x-flydesk-client-loopback": "0",
      },
    }));

    assert.equal(response.status, 403);
    const payload = await response.json() as { error?: string };
    assert.match(payload.error ?? "", /localhost access or a valid API token/i);
  } finally {
    if (previousApiToken === undefined) {
      delete process.env.FLY_DESK_API_TOKEN;
    } else {
      process.env.FLY_DESK_API_TOKEN = previousApiToken;
    }
  }
});

test("rejects unsupported multi-city searches", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sortMode: "cheapest",
        request: {
          tripType: "multi-city",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureDate: "2026-04-15",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 400);
    const payload = await response.json() as { errors?: string[] };
    assert.ok(payload.errors?.includes("Multi-city search is not supported."));
  });
});

test("search endpoint defaults unsupported sort mode to cheapest", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sortMode: "unsupported",
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureDate: "2026-04-15",
              returnDate: "2026-04-22",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as { sortMode?: string };
    assert.equal(payload.sortMode, "cheapest");
  });
});

test("costamar redirect refreshes the stored token with the latest Chrome session", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-redirect-"));
  const profileName = "Profile 40";
  const sessionsDir = join(tempRoot, profileName, "Sessions");
  mkdirSync(sessionsDir, { recursive: true });

  const staleToken = buildJwt({
    id: "0721808110",
    iat: 1700000000,
    exp: 1700003600,
  });
  const freshToken = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  writeFileSync(
    join(sessionsDir, "Tabs_1"),
    `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&token=${freshToken}`,
    "utf8",
  );

  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;
  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = profileName;
  resetCostamarSessionCacheForTests();
  resetCostamarWarmupStateForTests();
  setCostamarWarmupGeneratorForTests(async () => undefined);

  try {
    const runtime = getRuntime();
    const job = runtime.sessions.createSearchJob({
      request: buildCostamarRequest(),
      providerContext: {
        costamar: {
          apiBaseUrl: "https://costamar.com.pe/vuelos/api",
          brandBaseUrl: "https://booking.clickandbook.com/vuelos",
          terminalId: "0721808110",
          token: staleToken,
          lang: "es",
        },
      },
      offers: [buildCostamarOffer(
        `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${staleToken}`,
      )],
      allOffers: [buildCostamarOffer(
        `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${staleToken}`,
      )],
      searchMeta: buildSearchMeta(),
      providerMeta: buildProviderMeta(),
      warnings: [],
      sortMode: "cheapest",
      status: "completed",
    });

    const session = runtime.sessions.getSession(job.id);
    const redirectPath = session?.offers[0]?.purchasePaths[0]?.url;
    assert.ok(redirectPath);

    await withAcceptedCostamarRedirectValidation(async () => withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}${redirectPath}`, { redirect: "manual" });

      assert.equal(response.status, 302);
      const location = response.headers.get("location");
      assert.ok(location);

      const parsed = new URL(location);
      assert.equal(parsed.searchParams.get("terminalId"), "0721808110");
      assert.equal(parsed.searchParams.get("lang"), "es");
      assert.equal(parsed.searchParams.get("token"), freshToken);
    }));
  } finally {
    resetCostamarWarmupStateForTests();
    resetCostamarSessionCacheForTests();
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("costamar redirect rejects an external stored location before token validation", { concurrency: false }, async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-external-redirect-"));
  const previousFetch = global.fetch;
  const token = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  const maliciousUrl = `https://attacker.invalid/vuelos/pro/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${token}`;
  const restoreEnvironment = applyEnvironment({
    CBPLUS_CHROME_USER_DATA_DIR: tempRoot,
    CBPLUS_AGENT_CHROME_USER_DATA_DIR: tempRoot,
    COSTAMAR_CHROME_USER_DATA_DIR: tempRoot,
    COSTAMAR_AGENT_CHROME_USER_DATA_DIR: tempRoot,
    CBPLUS_CDP_TAB_SCAN_ENABLED: "0",
    COSTAMAR_CDP_TAB_SCAN_ENABLED: "0",
    CBPLUS_SESSION_WARMUP_ENABLED: "0",
    COSTAMAR_SESSION_WARMUP_ENABLED: "0",
  });
  let validationRequests = 0;

  global.fetch = (async () => {
    validationRequests += 1;
    return new Response("<html><body>Click and Book Plus search accepted</body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }) as typeof fetch;

  resetCostamarSessionCacheForTests();
  resetCostamarWarmupStateForTests();
  try {
    const runtime = getRuntime();
    const job = runtime.sessions.createSearchJob({
      request: buildCostamarRequest(),
      providerContext: {
        costamar: {
          apiBaseUrl: "https://costamar.com.pe/vuelos/api",
          brandBaseUrl: "https://booking.clickandbook.com/vuelos",
          terminalId: "0721808110",
          token,
          lang: "es",
        },
      },
      offers: [buildCostamarOffer(maliciousUrl)],
      allOffers: [buildCostamarOffer(maliciousUrl)],
      searchMeta: buildSearchMeta(),
      providerMeta: buildProviderMeta(),
      warnings: [],
      sortMode: "cheapest",
      status: "completed",
    });
    const redirectPath = runtime.sessions.getSession(job.id)?.offers[0]?.purchasePaths[0]?.url;
    assert.ok(redirectPath);

    const response = await withLoopbackTrustForTests(() => routeRequest(new Request(
      `http://127.0.0.1:8100${redirectPath}`,
      { headers: { "x-flydesk-client-loopback": "1" } },
    )));

    assert.equal(response.status, 409);
    assert.equal(response.headers.get("Location"), null);
    assert.equal(validationRequests, 0);
    const body = await response.text();
    assert.doesNotMatch(body, /attacker\.invalid|token=/i);
  } finally {
    global.fetch = previousFetch;
    resetCostamarWarmupStateForTests();
    resetCostamarSessionCacheForTests();
    restoreEnvironment();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("costamar redirect refreshes an unverified stored token before opening Costamar", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-redirect-fast-"));
  const profileName = "Profile 41";
  const sessionsDir = join(tempRoot, profileName, "Sessions");
  mkdirSync(sessionsDir, { recursive: true });

  const usableToken = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  const newerToken = buildJwt({
    id: "0721808110",
    iat: 1893459600,
    exp: 1893463200,
  });
  writeFileSync(
    join(sessionsDir, "Tabs_1"),
    `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&token=${newerToken}`,
    "utf8",
  );

  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;
  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = profileName;
  resetCostamarSessionCacheForTests();
  resetCostamarWarmupStateForTests();
  setCostamarWarmupGeneratorForTests(async () => undefined);

  try {
    const runtime = getRuntime();
    const job = runtime.sessions.createSearchJob({
      request: buildCostamarRequest(),
      providerContext: {
        costamar: {
          apiBaseUrl: "https://costamar.com.pe/vuelos/api",
          brandBaseUrl: "https://booking.clickandbook.com/vuelos",
          terminalId: "0721808110",
          token: usableToken,
          lang: "es",
        },
      },
      offers: [buildCostamarOffer(
        `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${usableToken}`,
      )],
      allOffers: [buildCostamarOffer(
        `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${usableToken}`,
      )],
      searchMeta: buildSearchMeta(),
      providerMeta: buildProviderMeta(),
      warnings: [],
      sortMode: "cheapest",
      status: "completed",
    });

    const session = runtime.sessions.getSession(job.id);
    const redirectPath = session?.offers[0]?.purchasePaths[0]?.url;
    assert.ok(redirectPath);

    await withAcceptedCostamarRedirectValidation(async () => withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}${redirectPath}`, { redirect: "manual" });

      assert.equal(response.status, 302);
      const location = response.headers.get("location");
      assert.ok(location);

      const parsed = new URL(location);
      assert.equal(parsed.searchParams.get("terminalId"), "0721808110");
      assert.equal(parsed.searchParams.get("lang"), "es");
      assert.equal(parsed.searchParams.get("token"), newerToken);
    }));

    assert.ok(getCostamarChromeSessionScanCountForTests() > 0);
  } finally {
    resetCostamarWarmupStateForTests();
    resetCostamarSessionCacheForTests();
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("costamar redirect warms a missing token through the B2B flow", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-redirect-warmup-"));
  const profileName = "Profile 43";
  const freshToken = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  const staleToken = buildJwt({
    id: "0721808110",
    iat: 1700000000,
    exp: 1700003600,
  });
  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;
  const previousWarmupEnabled = process.env.COSTAMAR_SESSION_WARMUP_ENABLED;
  const previousWarmupCooldown = process.env.COSTAMAR_SESSION_WARMUP_COOLDOWN_MS;
  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = profileName;
  process.env.COSTAMAR_SESSION_WARMUP_ENABLED = "1";
  process.env.COSTAMAR_SESSION_WARMUP_COOLDOWN_MS = "0";
  resetCostamarSessionCacheForTests();
  resetCostamarWarmupStateForTests();

  let warmedRequest: SearchRequest | undefined;
  setCostamarWarmupGeneratorForTests(async (request, context) => {
    warmedRequest = request;
    return {
      ...context,
      token: freshToken,
    };
  });

  try {
    const runtime = getRuntime();
    const job = runtime.sessions.createSearchJob({
      request: buildCostamarRequest(),
      providerContext: {
        costamar: {
          apiBaseUrl: "https://costamar.com.pe/vuelos/api",
          brandBaseUrl: "https://booking.clickandbook.com/vuelos",
          terminalId: "0721808110",
          token: staleToken,
          lang: "es",
        },
      },
      offers: [buildCostamarOffer(
        "https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es",
      )],
      allOffers: [buildCostamarOffer(
        "https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es",
      )],
      searchMeta: buildSearchMeta(),
      providerMeta: buildProviderMeta(),
      warnings: [],
      sortMode: "cheapest",
      status: "completed",
    });

    const session = runtime.sessions.getSession(job.id);
    const redirectPath = session?.offers[0]?.purchasePaths[0]?.url;
    assert.ok(redirectPath);

    await withAcceptedCostamarRedirectValidation(async () => withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}${redirectPath}`, { redirect: "manual" });

      assert.equal(response.status, 302);
      const location = response.headers.get("location");
      assert.ok(location);

      const parsed = new URL(location);
      assert.equal(parsed.searchParams.get("terminalId"), "0721808110");
      assert.equal(parsed.searchParams.get("lang"), "es");
      assert.equal(parsed.searchParams.get("token"), freshToken);
    }));

    assert.equal(warmedRequest?.searchMode, "exact");
    assert.equal(warmedRequest?.tripType, "round-trip");
    assert.equal(warmedRequest?.legs[0]?.origin, "LIM");
    assert.equal(warmedRequest?.legs[0]?.destination, "MAD");
    assert.equal(warmedRequest?.legs[0]?.departureDate, "2026-06-01");
    assert.equal(warmedRequest?.legs[0]?.returnDate, "2026-06-08");
  } finally {
    resetCostamarWarmupStateForTests();
    resetCostamarSessionCacheForTests();
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }

    if (previousWarmupEnabled === undefined) {
      delete process.env.COSTAMAR_SESSION_WARMUP_ENABLED;
    } else {
      process.env.COSTAMAR_SESSION_WARMUP_ENABLED = previousWarmupEnabled;
    }

    if (previousWarmupCooldown === undefined) {
      delete process.env.COSTAMAR_SESSION_WARMUP_COOLDOWN_MS;
    } else {
      process.env.COSTAMAR_SESSION_WARMUP_COOLDOWN_MS = previousWarmupCooldown;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("costamar redirect returns a controlled block when refresh hangs", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-redirect-timeout-"));
  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;
  const previousWarmupEnabled = process.env.COSTAMAR_SESSION_WARMUP_ENABLED;
  const previousWarmupCooldown = process.env.COSTAMAR_SESSION_WARMUP_COOLDOWN_MS;
  const previousWarmupFallback = process.env.COSTAMAR_SESSION_WARMUP_OPEN_BROWSER_FALLBACK;
  const previousWarmupTimeout = process.env.COSTAMAR_SESSION_WARMUP_TIMEOUT_MS;
  const previousRedirectTimeout = process.env.COSTAMAR_REDIRECT_TOTAL_TIMEOUT_MS;
  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = "Profile 44";
  process.env.COSTAMAR_SESSION_WARMUP_ENABLED = "1";
  process.env.COSTAMAR_SESSION_WARMUP_COOLDOWN_MS = "0";
  process.env.COSTAMAR_SESSION_WARMUP_OPEN_BROWSER_FALLBACK = "0";
  process.env.COSTAMAR_SESSION_WARMUP_TIMEOUT_MS = "1000";
  process.env.COSTAMAR_REDIRECT_TOTAL_TIMEOUT_MS = "1000";
  resetCostamarSessionCacheForTests();
  resetCostamarWarmupStateForTests();

  const staleToken = buildJwt({
    id: "0721808110",
    iat: 1700000000,
    exp: 1700003600,
  });

  /* The refresh only has to outlast the redirect deadline above, which the
     router floors at one second: this is an upper bound, not a measured
     duration, so it is kept just past that floor instead of far beyond it. */
  setCostamarWarmupGeneratorForTests(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    return undefined;
  });

  try {
    const runtime = getRuntime();
    const job = runtime.sessions.createSearchJob({
      request: buildCostamarRequest(),
      providerContext: {
        costamar: {
          apiBaseUrl: "https://costamar.com.pe/vuelos/api",
          brandBaseUrl: "https://booking.clickandbook.com/vuelos",
          terminalId: "0721808110",
          token: staleToken,
          lang: "es",
        },
      },
      offers: [buildCostamarOffer(
        `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${staleToken}`,
      )],
      allOffers: [buildCostamarOffer(
        `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${staleToken}`,
      )],
      searchMeta: buildSearchMeta(),
      providerMeta: buildProviderMeta(),
      warnings: [],
      sortMode: "cheapest",
      status: "completed",
    });

    const session = runtime.sessions.getSession(job.id);
    const redirectPath = session?.offers[0]?.purchasePaths[0]?.url;
    assert.ok(redirectPath);

    const response = await withLoopbackTrustForTests(() =>
      routeRequest(new Request(`http://127.0.0.1:8100${redirectPath}`, {
        headers: {
          "x-flydesk-client-loopback": "1",
        },
      }))
    );

    assert.equal(response.status, 409);
    const body = await response.text();
    assert.match(body, /Renueva la autenticación de Click and Book Plus/i);
    assert.doesNotMatch(body, /sesion este activa/i);
    assert.match(body, /overflow:\s*hidden/i);
    assert.match(body, /place-items:\s*center/i);
    assert.match(body, /tardo mas de/i);
  } finally {
    resetCostamarWarmupStateForTests();
    resetCostamarSessionCacheForTests();
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }

    if (previousWarmupEnabled === undefined) {
      delete process.env.COSTAMAR_SESSION_WARMUP_ENABLED;
    } else {
      process.env.COSTAMAR_SESSION_WARMUP_ENABLED = previousWarmupEnabled;
    }

    if (previousWarmupCooldown === undefined) {
      delete process.env.COSTAMAR_SESSION_WARMUP_COOLDOWN_MS;
    } else {
      process.env.COSTAMAR_SESSION_WARMUP_COOLDOWN_MS = previousWarmupCooldown;
    }

    if (previousWarmupFallback === undefined) {
      delete process.env.COSTAMAR_SESSION_WARMUP_OPEN_BROWSER_FALLBACK;
    } else {
      process.env.COSTAMAR_SESSION_WARMUP_OPEN_BROWSER_FALLBACK = previousWarmupFallback;
    }

    if (previousWarmupTimeout === undefined) {
      delete process.env.COSTAMAR_SESSION_WARMUP_TIMEOUT_MS;
    } else {
      process.env.COSTAMAR_SESSION_WARMUP_TIMEOUT_MS = previousWarmupTimeout;
    }

    if (previousRedirectTimeout === undefined) {
      delete process.env.COSTAMAR_REDIRECT_TOTAL_TIMEOUT_MS;
    } else {
      process.env.COSTAMAR_REDIRECT_TOTAL_TIMEOUT_MS = previousRedirectTimeout;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("costamar matrix redirects refresh the stored token with the matrix job provider context", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-matrix-redirect-"));
  const profileName = "Profile 42";
  const sessionsDir = join(tempRoot, profileName, "Sessions");
  mkdirSync(sessionsDir, { recursive: true });

  const staleToken = buildJwt({
    id: "0721808110",
    iat: 1700000000,
    exp: 1700003600,
  });
  const freshToken = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  writeFileSync(
    join(sessionsDir, "Tabs_1"),
    `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&token=${freshToken}`,
    "utf8",
  );

  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;
  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = profileName;
  resetCostamarSessionCacheForTests();
  resetCostamarWarmupStateForTests();
  setCostamarWarmupGeneratorForTests(async () => undefined);

  try {
    const runtime = getRuntime();
    const job = runtime.sessions.createMatrixJob({
      request: {
        ...buildCostamarRequest(),
        searchMode: "roundtrip-grid",
        flexibleMode: "exact-stay",
        legs: [
          {
            origin: "LIM",
            destination: "MAD",
            departureStart: "2026-06-01",
            departureEnd: "2026-06-03",
            stayNights: 7,
          },
        ],
      },
      providerContext: {
        costamar: {
          apiBaseUrl: "https://costamar.com.pe/vuelos/api",
          brandBaseUrl: "https://booking.clickandbook.com/vuelos",
          terminalId: "0721808110",
          token: staleToken,
          lang: "es",
        },
      },
      cells: [buildCostamarMatrixCell(
        `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${staleToken}`,
      )],
      axes: {
        departureDates: ["2026-06-01"],
        returnDates: ["2026-06-08"],
      },
      confidenceSummary: {
        live: 1,
      },
      recommendations: [],
      providerMeta: buildProviderMeta(),
      searchMeta: buildSearchMeta(),
      warnings: [],
      status: "completed",
    });

    const redirectPath = job.cells[0]?.purchasePaths?.[0]?.url;
    assert.ok(redirectPath);
    assert.equal(job.cells[0]?.offer?.purchasePaths[0]?.url, redirectPath);
    assert.doesNotMatch(JSON.stringify(job.cells), /token=/);

    await withAcceptedCostamarRedirectValidation(async () => withServer(async (baseUrl) => {
      const jobResponse = await fetch(`${baseUrl}/api/matrix/${job.id}`);
      assert.equal(jobResponse.status, 200);
      const jobBody = await jobResponse.text();
      assert.match(jobBody, /"offer"/);
      assert.doesNotMatch(jobBody, /token=/);

      const response = await fetch(`${baseUrl}${redirectPath}`, { redirect: "manual" });

      assert.equal(response.status, 302);
      const location = response.headers.get("location");
      assert.ok(location);

      const parsed = new URL(location);
      assert.equal(parsed.searchParams.get("terminalId"), "0721808110");
      assert.equal(parsed.searchParams.get("lang"), "es");
      assert.equal(parsed.searchParams.get("token"), freshToken);
    }));
  } finally {
    resetCostamarWarmupStateForTests();
    resetCostamarSessionCacheForTests();
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("agil search redirect returns the provider URL without local handoff page", async () => {
  const runtime = getRuntime();
  const agilUrl = "https://www.agilsmart.com/home-user/flight-result?origin=LIM&destination=MIA";
  const agilOffer: CanonicalOffer = {
    ...buildCostamarOffer(agilUrl),
    id: "offer-agil-local",
    providerSource: "agil-local",
    purchasePaths: [
      {
        id: "agil-path",
        type: "search-redirect",
        provider: "agil-local",
        label: "Buscar en Agil",
        url: agilUrl,
        precision: "exact-search",
        score: 0.9,
        requiresNewTab: true,
        commercialMode: "provider",
        state: "search_redirect",
      },
    ],
  };
  const job = runtime.sessions.createSearchJob({
    request: {
      ...buildCostamarRequest(),
      providerId: "agil-local",
    },
    offers: [agilOffer],
    allOffers: [agilOffer],
    searchMeta: {
      ...buildSearchMeta(),
      providersUsed: ["agil-local"],
    },
    providerMeta: {
      ...buildProviderMeta(),
      exactProvider: "agil-local",
    },
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });
  const redirectPath = runtime.sessions.getSession(job.id)?.offers[0]?.purchasePaths[0]?.url;

  assert.ok(redirectPath);
  assert.equal(redirectPath.includes("open=local"), false);

  const response = await withLoopbackTrustForTests(() =>
    routeRequest(new Request(`http://127.0.0.1:8100${redirectPath}?open=local`, {
      headers: {
        "x-flydesk-client-loopback": "1",
      },
    }))
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), agilUrl);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.doesNotMatch(await response.text(), /Abriendo proveedor|Abrir manualmente/);
});

test("costamar redirect blocks locally when no fresh token is available", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-redirect-blocked-"));
  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;
  const previousWarmupEnabled = process.env.COSTAMAR_SESSION_WARMUP_ENABLED;
  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = "Profile 99";
  process.env.COSTAMAR_SESSION_WARMUP_ENABLED = "0";
  resetCostamarSessionCacheForTests();
  resetCostamarWarmupStateForTests();

  const staleToken = buildJwt({
    id: "0721808110",
    iat: 1700000000,
    exp: 1700003600,
  });
  try {
    const runtime = getRuntime();
    const job = runtime.sessions.createSearchJob({
      request: buildCostamarRequest(),
      providerContext: {
        costamar: {
          apiBaseUrl: "https://costamar.com.pe/vuelos/api",
          brandBaseUrl: "https://booking.clickandbook.com/vuelos",
          terminalId: "0721808110",
          token: staleToken,
          lang: "es",
        },
      },
      offers: [buildCostamarOffer(
        `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${staleToken}`,
      )],
      allOffers: [buildCostamarOffer(
        `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${staleToken}`,
      )],
      searchMeta: buildSearchMeta(),
      providerMeta: buildProviderMeta(),
      warnings: [],
      sortMode: "cheapest",
      status: "completed",
    });

    const session = runtime.sessions.getSession(job.id);
    const redirectPath = session?.offers[0]?.purchasePaths[0]?.url;
    assert.ok(redirectPath);

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}${redirectPath}`, { redirect: "manual" });

      assert.equal(response.status, 409);
      assert.match(response.headers.get("content-type") ?? "", /text\/html/i);
      const body = await response.text();
      assert.match(body, /Renueva la autenticación de Click and Book Plus/i);
      assert.match(body, /redirect verificado/i);
    });
  } finally {
    resetCostamarWarmupStateForTests();
    resetCostamarSessionCacheForTests();
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }

    if (previousWarmupEnabled === undefined) {
      delete process.env.COSTAMAR_SESSION_WARMUP_ENABLED;
    } else {
      process.env.COSTAMAR_SESSION_WARMUP_ENABLED = previousWarmupEnabled;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("accepts exact searches inside the rolling date window", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sortMode: "cheapest",
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MIA",
              departureDate: "2027-01-01",
              returnDate: "2027-01-08",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
  });
});

test("rejects exact searches outside the rolling date window", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sortMode: "cheapest",
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MIA",
              departureDate: "2027-04-01",
              returnDate: "2027-04-08",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 400);
    const payload = await response.json() as { errors?: string[] };
    assert.ok(payload.errors?.some((message) => message.includes("Departure date must be on or before 2027-03-31.")));
  });
});



test("rejects one-way stay-range searches outside the rolling date window", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request: {
          tripType: "one-way",
          searchMode: "stay-range",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureStart: "2027-03-01",
              departureEnd: "2027-04-01",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 400);
    const payload = await response.json() as { errors?: string[] };
    assert.ok(payload.errors?.some((message) => message.includes("Departure end must be on or before 2027-03-31.")));
  });
});
test("rejects round-trip stays longer than 90 nights", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sortMode: "cheapest",
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MIA",
              departureDate: "2026-06-01",
              returnDate: "2026-09-01",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 400);
    const payload = await response.json() as { errors?: string[] };
    assert.ok(payload.errors?.some((message) => message.includes("Stay length cannot exceed 90 nights.")));
  });
});

test("rejects flexible exact-stay searches longer than 90 nights", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/matrix`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sortMode: "cheapest",
        request: {
          tripType: "round-trip",
          searchMode: "roundtrip-grid",
          flexibleMode: "exact-stay",
          legs: [
            {
              origin: "LIM",
              destination: "MIA",
              departureStart: "2026-06-01",
              departureEnd: "2026-06-10",
              stayNights: 91,
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 400);
    const payload = await response.json() as { errors?: string[] };
    assert.ok(payload.errors?.some((message) => message.includes("Stay length cannot exceed 90 nights.")));
  });
});

test("rejects fixed-ranges matrix searches with too many combinations", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/matrix`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request: {
          tripType: "round-trip",
          searchMode: "roundtrip-grid",
          flexibleMode: "fixed-ranges",
          legs: [
            {
              origin: "LIM",
              destination: "MIA",
              departureStart: "2026-06-01",
              departureEnd: "2026-12-31",
              returnStart: "2026-06-02",
              returnEnd: "2026-12-31",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 400);
    const payload = await response.json() as { errors?: string[] };
    assert.ok(payload.errors?.some((message) => message.includes("Round-trip matrix search cannot exceed 5000 combinations.")));
  });
});

test("accepts extended one-way month scans for migratory search beyond the normal stay limit", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sortMode: "cheapest",
        request: {
          tripType: "one-way",
          searchMode: "stay-range",
          legs: [
            {
              origin: "LIM",
              destination: "MIA",
              departureStart: "2026-07-01",
              departureEnd: "2026-07-31",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
          filters: {},
        },
      }),
    });

    assert.equal(response.status, 200);
  });
});

test("public search ignores provider override and keeps provider token out of the job response", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "costamar",
        providerConfig: {
          costamar: {
            terminalId: "0721808110",
            token: "super-secret-token",
            apiBaseUrl: "https://127.0.0.1:1/vuelos/api",
            brandBaseUrl: "https://booking.clickandbook.com/vuelos",
            lang: "es",
          },
        },
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureDate: "2026-06-01",
              returnDate: "2026-06-08",
            },
          ],
          passengers: {
            adults: 1,
            children: 1,
            infants: 1,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      request?: { providerId?: string };
      providerMeta?: { exactProvider?: string };
      searchMeta?: { providersUsed?: string[] };
      warnings?: string[];
    };

    assert.equal(payload.request?.providerId, undefined);
    assert.equal(payload.providerMeta?.exactProvider, "agil-local");
    assert.deepEqual(payload.searchMeta?.providersUsed, ["agil-local", "costamar"]);
    assert.equal(JSON.stringify(payload).includes("super-secret-token"), false);
  });
});

test("public search cannot disable either provider with a top-level providerId", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "costamar",
        providerConfig: {
          costamar: {
            terminalId: "0721808110",
            apiBaseUrl: "https://127.0.0.1:1/vuelos/api",
            brandBaseUrl: "https://booking.clickandbook.com/vuelos",
            lang: "es",
          },
        },
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureDate: "2026-06-01",
              returnDate: "2026-06-08",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      request?: { providerId?: string };
      searchMeta?: { providersUsed?: string[] };
    };
    assert.equal(payload.request?.providerId, undefined);
    assert.deepEqual(payload.searchMeta?.providersUsed, ["agil-local", "costamar"]);
  });
});

test("default search keeps Costamar enabled even when its token is missing", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureDate: "2026-06-01",
              returnDate: "2026-06-08",
            },
          ],
          passengers: {
            adults: 1,
            children: 1,
            infants: 1,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      searchMeta?: { providersUsed?: string[] };
      providerDiagnostics?: Array<{
        providerId?: string;
        kind?: string;
        status?: string;
        events?: Array<{ name?: string; detail?: string }>;
      }>;
    };

    assert.deepEqual(payload.searchMeta?.providersUsed, ["agil-local", "costamar"]);
    assert.deepEqual(
      payload.providerDiagnostics?.map((entry) => entry.providerId),
      ["agil-local", "costamar"],
    );
    assert.deepEqual(
      payload.providerDiagnostics?.map((entry) => entry.kind),
      ["exact", "exact"],
    );
    assert.deepEqual(
      payload.providerDiagnostics?.map((entry) => entry.status),
      ["queued", "queued"],
    );
    assert.equal(
      payload.providerDiagnostics?.every((entry) =>
        entry.events?.some((event) => event.name === "queued")
        && !entry.events?.some((event) => /token/i.test(event.detail ?? ""))
      ),
      true,
    );
  });
});

test("default search ignores providerId nested inside the request payload", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request: {
          providerId: "costamar",
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureDate: "2026-06-01",
              returnDate: "2026-06-08",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      request?: { providerId?: string };
      searchMeta?: { providersUsed?: string[] };
    };

    assert.equal(payload.request?.providerId, undefined);
    assert.deepEqual(payload.searchMeta?.providersUsed, ["agil-local", "costamar"]);
  });
});

test("default matrix keeps both providers enabled when no providerId is specified", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/matrix`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request: {
          tripType: "round-trip",
          searchMode: "roundtrip-grid",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureStart: "2026-06-01",
              departureEnd: "2026-06-03",
              returnStart: "2026-06-08",
              returnEnd: "2026-06-10",
              minNights: 7,
              maxNights: 7,
            },
          ],
          passengers: {
            adults: 1,
            children: 1,
            infants: 1,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      request?: { providerId?: string };
      cells?: Array<{ derivedRequest?: { providerId?: string } }>;
      searchMeta?: { providersUsed?: string[] };
      matrixStatus?: string;
    };

    assert.equal(payload.request?.providerId, undefined);
    assert.equal(payload.cells?.[0]?.derivedRequest?.providerId, undefined);
    assert.deepEqual(payload.searchMeta?.providersUsed, ["agil-local", "costamar"]);
    assert.equal(payload.matrixStatus, "running");
  });
});

test("default matrix ignores providerId nested inside the request payload", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/matrix`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request: {
          providerId: "costamar",
          tripType: "round-trip",
          searchMode: "roundtrip-grid",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureStart: "2026-06-01",
              departureEnd: "2026-06-03",
              returnStart: "2026-06-08",
              returnEnd: "2026-06-10",
              minNights: 7,
              maxNights: 7,
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      request?: { providerId?: string };
      cells?: Array<{ derivedRequest?: { providerId?: string } }>;
      searchMeta?: { providersUsed?: string[] };
    };

    assert.equal(payload.request?.providerId, undefined);
    assert.equal(payload.cells?.[0]?.derivedRequest?.providerId, undefined);
    assert.deepEqual(payload.searchMeta?.providersUsed, ["agil-local", "costamar"]);
  });
});

test("public matrix cannot disable either provider with a top-level providerId", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/matrix`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "costamar",
        providerConfig: {
          costamar: {
            terminalId: "0721808110",
          },
        },
        request: {
          tripType: "round-trip",
          searchMode: "roundtrip-grid",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureStart: "2026-06-01",
              departureEnd: "2026-06-03",
              returnStart: "2026-06-08",
              returnEnd: "2026-06-10",
              minNights: 7,
              maxNights: 7,
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      request?: { providerId?: string };
      searchMeta?: { providersUsed?: string[] };
    };
    assert.equal(payload.request?.providerId, undefined);
    assert.deepEqual(payload.searchMeta?.providersUsed, ["agil-local", "costamar"]);
  });
});

test("public matrix ignores top-level providerId even when provider config is present", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/matrix`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "costamar",
        providerConfig: {
          costamar: {
            terminalId: "0721808110",
            token: buildJwt({
              id: "0721808110",
              iat: 1893456000,
              exp: 1893459600,
            }),
          },
        },
        request: {
          tripType: "round-trip",
          searchMode: "roundtrip-grid",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureStart: "2026-06-01",
              departureEnd: "2026-06-03",
              returnStart: "2026-06-08",
              returnEnd: "2026-06-10",
              minNights: 7,
              maxNights: 7,
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      request?: { providerId?: string };
      cells?: Array<{ derivedRequest?: { providerId?: string } }>;
      searchMeta?: { providersUsed?: string[] };
    };

    assert.equal(payload.request?.providerId, undefined);
    assert.equal(payload.cells?.[0]?.derivedRequest?.providerId, undefined);
    assert.deepEqual(payload.searchMeta?.providersUsed, ["agil-local", "costamar"]);
  });
});

test("search jobs can be cancelled before polling completes", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureDate: "2026-05-01",
              returnDate: "2026-05-31",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
          filters: {
            nonStop: false,
            baggageRequired: false,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const accepted = await response.json() as {
      searchJobId?: string;
      searchStatus?: string;
    };
    assert.equal(accepted.searchStatus, "running");
    assert.ok(accepted.searchJobId);

    const cancelResponse = await fetch(`${baseUrl}/api/search/${accepted.searchJobId}/cancel`, {
      method: "POST",
    });
    assert.equal(cancelResponse.status, 200);
    const cancelled = await cancelResponse.json() as {
      searchComplete?: boolean;
      searchStatus?: string;
      searchMeta?: { searchState?: string; warnings?: string[] };
      warnings?: string[];
    };
    assert.equal(cancelled.searchStatus, "cancelled");
    assert.equal(cancelled.searchComplete, true);
    assert.equal(cancelled.searchMeta?.searchState, "search_cancelled");
    assert.ok(cancelled.warnings?.includes("Search cancelled by user."));

    const pollResponse = await fetch(`${baseUrl}/api/search/${accepted.searchJobId}`);
    assert.equal(pollResponse.status, 200);
    const polled = await pollResponse.json() as {
      searchComplete?: boolean;
      searchStatus?: string;
    };
    assert.equal(polled.searchStatus, "cancelled");
    assert.equal(polled.searchComplete, true);
  });
});

test("search cancel from page refresh completes partial results so they remain cacheable", async () => {
  const runtime = getRuntime();
  const request = buildCostamarRequest();
  const token = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  const providerContext = buildProviderContext("costamar", {
    costamar: {
      apiBaseUrl: "https://costamar.com.pe/vuelos/api",
      brandBaseUrl: "https://booking.clickandbook.com/vuelos",
      terminalId: "0721808110",
      token,
      lang: "es",
    },
  });
  const offer = buildCostamarOffer(
    `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${token}`,
  );
  const job = runtime.sessions.createSearchJob({
    request,
    providerContext,
    offers: [offer],
    allOffers: [offer],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "running",
  });

  await withServer(async (baseUrl) => {
    const cancelResponse = await fetch(`${baseUrl}/api/search/${job.id}/cancel?cachePartial=1`, {
      method: "POST",
    });
    assert.equal(cancelResponse.status, 200);
    const cancelled = await cancelResponse.json() as {
      searchComplete?: boolean;
      searchStatus?: string;
      searchMeta?: { searchState?: string; partial?: boolean; warnings?: string[] };
      warnings?: string[];
    };
    assert.equal(cancelled.searchStatus, "completed");
    assert.equal(cancelled.searchComplete, true);
    assert.equal(cancelled.searchMeta?.searchState, "search_partial");
    assert.equal(cancelled.searchMeta?.partial, true);
    assert.ok(cancelled.warnings?.includes("Search stopped because the page was refreshed."));

    const cached = runtime.sessions.findRecentCompletedSearchJob({
      request,
      providerContext,
      providerIds: ["costamar"],
      sortMode: "cheapest",
      maxAgeMs: 5 * 60 * 1000,
    });
    assert.equal(cached?.id, job.id);
    assert.equal(cached?.offers.length, 1);
  });
});

test("search endpoint serves cached results first for the same config while revalidating in background", async () => {
  const runtime = getRuntime();
  const terminalId = "9990001112";
  const seededToken = buildJwt({
    id: terminalId,
    iat: 1893456000,
    exp: 1893459600,
  });
  const refreshToken = buildJwt({
    id: terminalId,
    iat: 1893459600,
    exp: 1893463200,
  });
  const request: SearchRequest = {
    ...buildCostamarRequest(),
    providerId: undefined,
    legs: [
      {
        origin: "LIM",
        destination: "BCN",
        originLabel: "",
        destinationLabel: "",
        departureDate: "2026-06-04",
        departureStart: "",
        departureEnd: "",
        returnDate: "2026-06-18",
        returnStart: "",
        returnEnd: "",
      },
    ],
    filters: {
      nonStop: false,
      includedAirlineCodes: undefined,
      excludedAirlineCodes: undefined,
      maxPrice: undefined,
      maxTotalDurationMinutes: undefined,
      maxLayoverMinutes: undefined,
      maxStops: undefined,
      minDepartureMinutes: undefined,
      maxDepartureMinutes: undefined,
      minArrivalMinutes: undefined,
      maxArrivalMinutes: undefined,
      baggageRequired: false,
      verifiedOnly: false,
      exactPurchasePathOnly: false,
    },
  };
  const cachedOffer = {
    ...buildCostamarOffer(
      `https://booking.clickandbook.com/vuelos/b/LIM/BCN/2026-06-04/2026-06-18/1/0/0?terminalId=${terminalId}&lang=es&token=${seededToken}`,
    ),
    quotationPreparedAt: "2026-06-04T12:00:00.000Z",
    purchasePaths: [],
  };
  const cachedJob = runtime.sessions.createSearchJob({
    request,
    providerContext: buildProviderContext("costamar", {
      costamar: {
        terminalId,
        token: seededToken,
        lang: "es",
      },
    }),
    offers: [cachedOffer],
    allOffers: [cachedOffer],
    searchMeta: {
      ...buildSearchMeta(),
      completedAt: new Date().toISOString(),
      providersUsed: ["agil-local", "costamar"],
    },
    providerMeta: buildProviderMeta(),
    warnings: ["Snapshot cache listo"],
    sortMode: "cheapest",
    status: "completed",
  });

  const mismatchedTokenCacheHit = runtime.sessions.findRecentCompletedSearchJob({
    request,
    providerContext: buildProviderContext("costamar", {
      costamar: {
        apiBaseUrl: "https://costamar.com.pe/vuelos/api",
        brandBaseUrl: "https://booking.clickandbook.com/vuelos",
        terminalId,
        token: refreshToken,
        lang: "es",
      },
    }),
    providerIds: ["agil-local", "costamar"],
    sortMode: "cheapest",
    maxAgeMs: 5 * 60 * 1000,
  });
  assert.equal(mismatchedTokenCacheHit, undefined);

  const previewCacheHit = runtime.sessions.findRecentCompletedSearchJob({
    request,
    providerContext: buildProviderContext("costamar", {
      costamar: {
        apiBaseUrl: "https://costamar.com.pe/vuelos/api",
        brandBaseUrl: "https://booking.clickandbook.com/vuelos",
        terminalId,
        token: seededToken,
        lang: "es",
      },
    }),
    providerIds: ["agil-local", "costamar"],
    sortMode: "cheapest",
    maxAgeMs: 5 * 60 * 1000,
  });
  assert.equal(previewCacheHit?.id, cachedJob.id);

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "costamar",
        providerConfig: {
          costamar: {
            apiBaseUrl: "https://costamar.com.pe/vuelos/api",
            brandBaseUrl: "https://booking.clickandbook.com/vuelos",
            terminalId,
            token: seededToken,
            lang: "es",
          },
        },
        sortMode: "cheapest",
        request,
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      searchJobId?: string;
      searchStatus?: string;
      searchComplete?: boolean;
      searchMeta?: { searchState?: string; partial?: boolean };
      warnings?: string[];
      offers?: Array<{ quotationPreparedAt?: string; purchasePaths?: Array<{ provider?: string; type?: string; url?: string }> }>;
    };

    assert.equal(payload.searchStatus, "running");
    assert.equal(payload.searchComplete, false);
    assert.equal(payload.searchJobId === cachedJob.id, false);
    assert.equal(payload.searchMeta?.searchState, "search_cached");
    assert.equal(payload.searchMeta?.partial, true);
    assert.ok((payload.offers?.length ?? 0) > 0);
    assert.equal(payload.offers?.[0]?.quotationPreparedAt, undefined);
    const purchasePath = payload.offers?.[0]?.purchasePaths?.[0];
    assert.equal(purchasePath?.provider, "costamar");
    assert.equal(purchasePath?.type, "search-redirect");
    assert.match(purchasePath?.url ?? "", /^\/r\//);
    assert.ok(payload.warnings?.some((warning) => /cachead/i.test(warning)));
  });
});

test("matrix endpoint serves partial cached cells first after cancellation and revalidates", async () => {
  const runtime = getRuntime();
  const requestPayload = {
    sortMode: "cheapest",
    providerConfig: {
      costamar: {
        terminalId: "0721808110",
        token: buildJwt({
          id: "0721808110",
          iat: 1893456000,
          exp: 1893459600,
        }),
        lang: "es",
      },
    },
    request: {
      tripType: "round-trip",
      searchMode: "roundtrip-grid",
      flexibleMode: "fixed-ranges",
      legs: [
        {
          origin: "LIM",
          destination: "MAD",
          departureStart: "2026-06-01",
          departureEnd: "2026-06-03",
          returnStart: "2026-06-08",
          returnEnd: "2026-06-10",
          minNights: 7,
          maxNights: 7,
        },
      ],
      passengers: {
        adults: 1,
        children: 0,
        infants: 0,
      },
    },
  };

  await withServer(async (baseUrl) => {
    const firstResponse = await fetch(`${baseUrl}/api/matrix`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestPayload),
    });
    assert.equal(firstResponse.status, 200);
    const accepted = await firstResponse.json() as {
      matrixJobId?: string;
      matrixStatus?: string;
    };
    assert.ok(accepted.matrixJobId);
    assert.equal(accepted.matrixStatus, "running");

    const cachedCellSeed = buildCostamarMatrixCell(
      "https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0",
    );
    const cachedCell = {
      ...cachedCellSeed,
      offer: {
        ...cachedCellSeed.offer!,
        quotationPreparedAt: "2026-06-01T12:00:00.000Z",
      },
    };
    const partial = runtime.sessions.updateMatrixJob(accepted.matrixJobId!, (current) => ({
      ...current,
      cells: [cachedCell],
      axes: {
        departureDates: [cachedCell.departureDate],
        returnDates: [cachedCell.returnDate],
      },
      confidenceSummary: { live: 1 },
      searchMeta: {
        ...current.searchMeta,
        providersUsed: ["agil-local", "costamar"],
        partial: true,
        searchState: "search_partial",
      },
    }));
    assert.equal(partial?.cells.length, 1);

    const cancelResponse = await fetch(`${baseUrl}/api/matrix/${accepted.matrixJobId}/cancel?cachePartial=1`, {
      method: "POST",
    });
    assert.equal(cancelResponse.status, 200);
    const cancelled = await cancelResponse.json() as { matrixStatus?: string };
    assert.equal(cancelled.matrixStatus, "completed");

    const repeatedResponse = await fetch(`${baseUrl}/api/matrix`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestPayload),
    });
    assert.equal(repeatedResponse.status, 200);
    const repeated = await repeatedResponse.json() as {
      matrixJobId?: string;
      matrixStatus?: string;
      matrixComplete?: boolean;
      searchMeta?: { searchState?: string; partial?: boolean };
      warnings?: string[];
      cells?: Array<{ key?: string; offer?: { quotationPreparedAt?: string } }>;
    };

    assert.equal(repeated.matrixStatus, "running");
    assert.equal(repeated.matrixComplete, false);
    assert.notEqual(repeated.matrixJobId, accepted.matrixJobId);
    assert.equal(repeated.searchMeta?.searchState, "search_cached");
    assert.equal(repeated.searchMeta?.partial, true);
    assert.equal(repeated.cells?.[0]?.key, cachedCell.key);
    assert.equal(repeated.cells?.[0]?.offer?.quotationPreparedAt, undefined);
    assert.ok(repeated.warnings?.some((warning) => /cachead/i.test(warning)));
  });
});

test("search job polling returns a lightweight unchanged payload when revision has not moved", async () => {
  const runtime = getRuntime();
  const offer = buildCostamarOffer(
    "https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=test",
  );
  const job = runtime.sessions.createSearchJob({
    request: buildCostamarRequest(),
    offers: [offer],
    allOffers: [offer],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "running",
  });

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search/${job.id}?sinceRevision=${job.revision}`);
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      unchanged?: boolean;
      revision?: number;
      offers?: unknown[];
      allOffers?: unknown[];
      searchStatus?: string;
      searchComplete?: boolean;
    };

    assert.equal(payload.unchanged, true);
    assert.equal(payload.revision, job.revision);
    assert.equal(payload.searchStatus, "running");
    assert.equal(payload.searchComplete, false);
    assert.equal(payload.offers, undefined);
    assert.equal(payload.allOffers, undefined);
  });
});

test("matrix job polling returns a lightweight unchanged payload when revision has not moved", async () => {
  const runtime = getRuntime();
  const job = runtime.sessions.createMatrixJob({
    request: {
      ...buildCostamarRequest(),
      searchMode: "roundtrip-grid",
      flexibleMode: "exact-stay",
      tripType: "round-trip",
      legs: [
        {
          origin: "LIM",
          destination: "MAD",
          departureStart: "2026-06-01",
          departureEnd: "2026-06-03",
          stayNights: 7,
        },
      ],
    },
    cells: [buildCostamarMatrixCell(
      "https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=test",
    )],
    axes: {
      departureDates: ["2026-06-01"],
      returnDates: ["2026-06-08"],
    },
    confidenceSummary: { live: 1 },
    recommendations: [],
    providerMeta: buildProviderMeta(),
    searchMeta: buildSearchMeta(),
    warnings: [],
    status: "running",
  });

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/matrix/${job.id}?sinceRevision=${job.revision}`);
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      unchanged?: boolean;
      revision?: number;
      cells?: unknown[];
      matrixStatus?: string;
      matrixComplete?: boolean;
    };

    assert.equal(payload.unchanged, true);
    assert.equal(payload.revision, job.revision);
    assert.equal(payload.matrixStatus, "running");
    assert.equal(payload.matrixComplete, false);
    assert.equal(payload.cells, undefined);
  });
});

/*
 * The poll that waits for the news instead of asking again for it.
 *
 * `wait=<ms>` parks the request in the session store, so a revision that lands
 * mid-flight answers it immediately rather than on the browser's next tick. The
 * timing assertions are one-sided on purpose: the first case only claims the
 * answer beat the wait it asked for, and the second only claims it did not come
 * back before its own timeout.
 */
test("search job polling with wait returns as soon as the revision moves", async () => {
  const runtime = getRuntime();
  const job = runtime.sessions.createSearchJob({
    request: buildCostamarRequest(),
    offers: [],
    allOffers: [],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "running",
  });

  await withServer(async (baseUrl) => {
    const offer = buildCostamarOffer(
      "https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=test",
    );
    const startedAt = Date.now();
    const pending = fetch(`${baseUrl}/api/search/${job.id}?sinceRevision=${job.revision}&wait=2000`);
    const bump = setTimeout(() => {
      runtime.sessions.updateSearchJob(job.id, (current) => ({
        ...current,
        offers: [offer],
        allOffers: [offer],
        status: "completed",
      }));
    }, 100);

    try {
      const response = await pending;
      const elapsedMs = Date.now() - startedAt;
      assert.equal(response.status, 200);
      const payload = await response.json() as {
        unchanged?: boolean;
        revision?: number;
        searchComplete?: boolean;
        offers?: unknown[];
      };

      assert.equal(payload.unchanged, false);
      assert.equal(payload.revision, job.revision + 1);
      assert.equal(payload.searchComplete, true);
      assert.equal(payload.offers?.length, 1);
      assert.ok(elapsedMs < 1500, `long poll returned late: ms=${elapsedMs}`);
    } finally {
      clearTimeout(bump);
    }
  });
});

test("search job polling with wait returns unchanged once the wait elapses", async () => {
  const runtime = getRuntime();
  const job = runtime.sessions.createSearchJob({
    request: buildCostamarRequest(),
    offers: [],
    allOffers: [],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "running",
  });

  await withServer(async (baseUrl) => {
    const startedAt = Date.now();
    const response = await fetch(`${baseUrl}/api/search/${job.id}?sinceRevision=${job.revision}&wait=300`);
    const elapsedMs = Date.now() - startedAt;
    assert.equal(response.status, 200);
    const payload = await response.json() as { unchanged?: boolean; revision?: number };
    assert.equal(payload.unchanged, true);
    assert.equal(payload.revision, job.revision);
    assert.ok(elapsedMs >= 250, `long poll returned before its wait: ms=${elapsedMs}`);
  });
});

test("matrix job polling with wait returns as soon as the revision moves", async () => {
  const runtime = getRuntime();
  const cell = buildCostamarMatrixCell(
    "https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=test",
  );
  const job = runtime.sessions.createMatrixJob({
    request: {
      ...buildCostamarRequest(),
      searchMode: "roundtrip-grid",
      flexibleMode: "exact-stay",
    },
    cells: [],
    axes: { departureDates: [cell.departureDate], returnDates: [cell.returnDate!] },
    confidenceSummary: {},
    recommendations: [],
    providerMeta: buildProviderMeta(),
    searchMeta: buildSearchMeta(),
    warnings: [],
    status: "running",
  });

  await withServer(async (baseUrl) => {
    const startedAt = Date.now();
    const pending = fetch(`${baseUrl}/api/matrix/${job.id}?sinceRevision=${job.revision}&wait=2000`);
    const bump = setTimeout(() => {
      runtime.sessions.updateMatrixJob(job.id, (current) => ({
        ...current,
        cells: [cell],
        confidenceSummary: { live: 1 },
      }));
    }, 100);

    try {
      const response = await pending;
      const elapsedMs = Date.now() - startedAt;
      assert.equal(response.status, 200);
      const payload = await response.json() as {
        unchanged?: boolean;
        revision?: number;
        cells?: Array<{ key?: string }>;
      };

      assert.equal(payload.unchanged, false);
      assert.equal(payload.revision, job.revision + 1);
      assert.deepEqual(payload.cells?.map((entry) => entry.key), [cell.key]);
      assert.ok(elapsedMs < 1500, `long poll returned late: ms=${elapsedMs}`);
    } finally {
      clearTimeout(bump);
    }
  });
});

test("matrix polling omits cells without results from progressive payloads", async () => {
  const runtime = getRuntime();
  const resolved = buildCostamarMatrixCell(
    "https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=test",
  );
  const loading: MatrixCell = {
    ...resolved,
    key: "matrix-loading-placeholder",
    confidence: "loading",
    price: undefined,
    offer: undefined,
    purchasePaths: [],
    selectable: false,
  };
  const unavailable: MatrixCell = {
    ...loading,
    key: "matrix-unavailable-placeholder",
    confidence: "unavailable",
  };
  const job = runtime.sessions.createMatrixJob({
    request: {
      ...buildCostamarRequest(),
      searchMode: "roundtrip-grid",
      flexibleMode: "exact-stay",
    },
    cells: [resolved, loading, unavailable],
    axes: { departureDates: [resolved.departureDate], returnDates: [resolved.returnDate!] },
    confidenceSummary: { live: 1, loading: 1, unavailable: 1 },
    recommendations: [],
    providerMeta: buildProviderMeta(),
    searchMeta: buildSearchMeta(),
    warnings: [],
    status: "running",
  });

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/matrix/${job.id}?sinceRevision=0`);
    assert.equal(response.status, 200);
    const payload = await response.json() as { cells?: MatrixCell[] };
    assert.deepEqual(payload.cells?.map((cell) => cell.key), [resolved.key]);
  });
});

test("removed results layout endpoints return not found", async () => {
  await withServer(async (baseUrl) => {
    const getResponse = await fetch(`${baseUrl}/api/results-layout`);
    assert.equal(getResponse.status, 404);
    assert.deepEqual(await getResponse.json(), { error: "Not found" });

    const postResponse = await fetch(`${baseUrl}/api/results-layout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ columns: {} }),
    });
    assert.equal(postResponse.status, 404);
    assert.deepEqual(await postResponse.json(), { error: "Not found" });
  });
});

test("costamar redirect HTML never exposes a token-bearing validation error", async () => {
  const previousFetch = global.fetch;
  const previousWarmupEnabled = process.env.CBPLUS_SESSION_WARMUP_ENABLED;
  const token = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  process.env.CBPLUS_SESSION_WARMUP_ENABLED = "0";
  resetCostamarWarmupStateForTests();

  try {
    const runtime = getRuntime();
    const tokenUrl = `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${token}`;
    const job = runtime.sessions.createSearchJob({
      request: buildCostamarRequest(),
      providerContext: {
        costamar: {
          apiBaseUrl: "https://costamar.com.pe/vuelos/api",
          brandBaseUrl: "https://booking.clickandbook.com/vuelos",
          terminalId: "0721808110",
          token,
          lang: "es",
        },
      },
      offers: [buildCostamarOffer(tokenUrl)],
      allOffers: [buildCostamarOffer(tokenUrl)],
      searchMeta: buildSearchMeta(),
      providerMeta: buildProviderMeta(),
      warnings: [],
      sortMode: "cheapest",
      status: "completed",
    });
    const redirectPath = runtime.sessions.getSession(job.id)?.offers[0]?.purchasePaths[0]?.url;
    assert.ok(redirectPath);

    global.fetch = (async (input) => {
      throw new Error(`private validation failed at ${String(input)}&internal=private-main-secret`);
    }) as typeof fetch;

    const response = await withLoopbackTrustForTests(() =>
      routeRequest(new Request(`http://127.0.0.1:8100${redirectPath}`, {
        headers: { "x-flydesk-client-loopback": "1" },
      }))
    );
    const body = await response.text();
    assert.equal(response.status, 409);
    assert.match(body, /Renueva la autenticación de Click and Book Plus/i);
    assert.doesNotMatch(body, /token=|private-main-secret|booking\.clickandbook\.com/i);
  } finally {
    global.fetch = previousFetch;
    resetCostamarWarmupStateForTests();
    if (previousWarmupEnabled === undefined) delete process.env.CBPLUS_SESSION_WARMUP_ENABLED;
    else process.env.CBPLUS_SESSION_WARMUP_ENABLED = previousWarmupEnabled;
  }
});

test("search fan-out can suppress duplicate location usage accounting", { concurrency: false }, async () => {
  const previousApiToken = process.env.FLY_DESK_API_TOKEN;
  process.env.FLY_DESK_API_TOKEN = "test-token";
  getRuntime().locationUsage.clearForTests();

  try {
    const request = buildCostamarRequest();
    const departureDate = getSearchDatePolicy().minSearchDate;
    delete request.providerId;
    request.legs[0] = {
      ...request.legs[0],
      departureDate,
      returnDate: addDays(departureDate, 7),
    };

    const accepted = await routeRequest(new Request("http://fly-desk.local/api/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-flydesk-client-loopback": "0",
        "x-flydesk-api-token": "test-token",
      },
      body: JSON.stringify({
        clientSessionId: "browser-session-search-fanout",
        recordLocationUsage: false,
        request,
        sortMode: "cheapest",
      }),
    }));
    assert.equal(accepted.status, 200);
    assert.deepEqual(getRuntime().locationUsage.getSuggestions(3), {
      origin: [],
      destination: [],
    });
    assert.deepEqual(
      getRuntime().locationUsage.getUsageSuggestions("browser-session-search-fanout").recent,
      { origin: [], destination: [] },
    );
  } finally {
    getRuntime().locationUsage.clearForTests();
    if (previousApiToken === undefined) {
      delete process.env.FLY_DESK_API_TOKEN;
    } else {
      process.env.FLY_DESK_API_TOKEN = previousApiToken;
    }
  }
});

test("matrix fan-out can suppress duplicate location usage accounting", { concurrency: false }, async () => {
  const previousApiToken = process.env.FLY_DESK_API_TOKEN;
  process.env.FLY_DESK_API_TOKEN = "test-token";
  getRuntime().locationUsage.clearForTests();

  try {
    const departureStart = getSearchDatePolicy().minSearchDate;

    /* Not stamped as proxied: the caller is the web unit itself, asking the
       matrix route for a grid it has already counted. Only the flag can hold
       the ranking back here, which is what the search route has always
       honoured and the matrix route used to ignore. */
    const accepted = await routeRequest(new Request("http://fly-desk.local/api/matrix", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-flydesk-client-loopback": "0",
        "x-flydesk-api-token": "test-token",
      },
      body: JSON.stringify({
        clientSessionId: "browser-session-matrix-fanout",
        recordLocationUsage: false,
        request: {
          tripType: "round-trip",
          searchMode: "roundtrip-grid",
          legs: [
            {
              origin: "CUZ",
              destination: "BOG",
              departureStart,
              departureEnd: addDays(departureStart, 2),
              returnStart: addDays(departureStart, 7),
              returnEnd: addDays(departureStart, 9),
              minNights: 7,
              maxNights: 7,
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    }));

    assert.equal(accepted.status, 200);
    assert.deepEqual(getRuntime().locationUsage.getSuggestions(3), {
      origin: [],
      destination: [],
    });
    assert.deepEqual(
      getRuntime().locationUsage.getUsageSuggestions("browser-session-matrix-fanout").recent,
      { origin: [], destination: [] },
    );
    assert.equal(getRuntime().locationUsage.getDiagnostics().entries, 0);
  } finally {
    getRuntime().locationUsage.clearForTests();
    if (previousApiToken === undefined) {
      delete process.env.FLY_DESK_API_TOKEN;
    } else {
      process.env.FLY_DESK_API_TOKEN = previousApiToken;
    }
  }
});

test("a delegated search is counted in the store the web unit serves, and only once", { concurrency: false }, async () => {
  const previousApiToken = process.env.FLY_DESK_API_TOKEN;
  const previousSearchUrl = process.env.FLY_DESK_SEARCH_SERVICE_URL;
  const previousSearchToken = process.env.FLY_DESK_SEARCH_SERVICE_API_TOKEN;
  const previousFetch = global.fetch;
  process.env.FLY_DESK_API_TOKEN = "test-token";
  process.env.FLY_DESK_SEARCH_SERVICE_URL = "http://127.0.0.1:8101";
  process.env.FLY_DESK_SEARCH_SERVICE_API_TOKEN = "internal-runner-token";
  getRuntime().locationUsage.clearForTests();

  try {
    const request = buildCostamarRequest();
    const departureDate = getSearchDatePolicy().minSearchDate;
    delete request.providerId;
    request.legs[0] = {
      ...request.legs[0],
      origin: "AQP",
      destination: "SCL",
      departureDate,
      returnDate: addDays(departureDate, 7),
    };

    let forwardedBody: string | undefined;
    let forwardedProxyHeader: string | null = null;
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(input), "http://127.0.0.1:8101/api/search");
      forwardedProxyHeader = new Headers(init?.headers).get("x-flydesk-search-proxy");
      forwardedBody = await new Response(init?.body).text();
      return Response.json({ searchJobId: "runner-job", status: "running", revision: 1 });
    }) as typeof fetch;

    const payload = {
      clientSessionId: "browser-session-delegated-01",
      request,
      sortMode: "cheapest",
    };
    const delegated = await routeRequest(new Request("http://fly-desk.local/api/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-flydesk-client-loopback": "0",
        "x-flydesk-api-token": "test-token",
      },
      body: JSON.stringify(payload),
    }));

    assert.equal(delegated.status, 200);
    // The rebuilt request still carries the whole payload to the runner.
    assert.deepEqual(JSON.parse(forwardedBody ?? "null"), payload);
    assert.equal(forwardedProxyHeader, "1");
    /* The point of the case: the search ran in the runner, and the ranking the
       web unit answers with knows about it. */
    assert.deepEqual(getRuntime().locationUsage.getSuggestions(3), {
      origin: ["AQP"],
      destination: ["SCL"],
    });
    assert.deepEqual(
      getRuntime().locationUsage.getUsageSuggestions("browser-session-delegated-01").recent,
      { origin: ["AQP"], destination: ["SCL"] },
    );

    /* And the runner's own half of the arrangement: a request that arrives
       stamped as proxied has already been counted upstream, so counting it
       again would give a delegated search twice the weight of a direct one. */
    delete process.env.FLY_DESK_SEARCH_SERVICE_URL;
    global.fetch = previousFetch;
    const atRunner = await routeRequest(new Request("http://fly-desk.local/api/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-flydesk-client-loopback": "0",
        "x-flydesk-api-token": "test-token",
        "x-flydesk-search-proxy": "1",
      },
      body: JSON.stringify({
        ...payload,
        request: {
          ...request,
          legs: [{ ...request.legs[0], origin: "TPP", destination: "MIA" }],
        },
      }),
    }));
    assert.equal(atRunner.status, 200);
    assert.deepEqual(getRuntime().locationUsage.getSuggestions(3), {
      origin: ["AQP"],
      destination: ["SCL"],
    });
    assert.equal(getRuntime().locationUsage.getDiagnostics().entries, 2);

    /* A runner that is down is not a route the desk searched. */
    process.env.FLY_DESK_SEARCH_SERVICE_URL = "http://127.0.0.1:8101";
    global.fetch = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;
    const unavailable = await routeRequest(new Request("http://fly-desk.local/api/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-flydesk-client-loopback": "0",
        "x-flydesk-api-token": "test-token",
      },
      body: JSON.stringify({
        ...payload,
        request: {
          ...request,
          legs: [{ ...request.legs[0], origin: "IQT", destination: "UIO" }],
        },
      }),
    }));
    assert.equal(unavailable.status, 503);
    assert.deepEqual(getRuntime().locationUsage.getSuggestions(3), {
      origin: ["AQP"],
      destination: ["SCL"],
    });
  } finally {
    global.fetch = previousFetch;
    getRuntime().locationUsage.clearForTests();
    if (previousApiToken === undefined) delete process.env.FLY_DESK_API_TOKEN;
    else process.env.FLY_DESK_API_TOKEN = previousApiToken;
    if (previousSearchUrl === undefined) delete process.env.FLY_DESK_SEARCH_SERVICE_URL;
    else process.env.FLY_DESK_SEARCH_SERVICE_URL = previousSearchUrl;
    if (previousSearchToken === undefined) delete process.env.FLY_DESK_SEARCH_SERVICE_API_TOKEN;
    else process.env.FLY_DESK_SEARCH_SERVICE_API_TOKEN = previousSearchToken;
  }
});

test("rejects overlong location queries before provider lookup", { concurrency: false }, async () => {
  const previousApiToken = process.env.FLY_DESK_API_TOKEN;
  process.env.FLY_DESK_API_TOKEN = "test-token";

  try {
    const query = "x".repeat(LOCATION_SUGGESTION_CACHE_MAX_QUERY_CHARS + 1);
    const response = await routeRequest(new Request(`http://fly-desk.local/api/locations?q=${query}`, {
      method: "GET",
      headers: {
        "x-flydesk-client-loopback": "0",
        "x-flydesk-api-token": "test-token",
      },
    }));

    assert.equal(response.status, 400);
    const payload = await response.json() as { errors?: string[] };
    assert.match(payload.errors?.[0] ?? "", /cannot exceed 120 characters/i);
  } finally {
    if (previousApiToken === undefined) delete process.env.FLY_DESK_API_TOKEN;
    else process.env.FLY_DESK_API_TOKEN = previousApiToken;
  }
});

test("diagnostics endpoint exposes loopback-only runtime counters", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/diagnostics`);
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      ok?: boolean;
      memoryUsage?: { rss?: number };
      searchAdmission?: { capacityUnits?: number; activeUnits?: number; queuedCount?: number };
      sessions?: { counts?: { searchJobs?: number; purchasePaths?: number } };
      tempArtifacts?: { totals?: { count?: number } };
    };

    assert.equal(payload.ok, true);
    assert.equal(typeof payload.memoryUsage?.rss, "number");
    assert.equal(typeof payload.searchAdmission?.capacityUnits, "number");
    assert.equal(typeof payload.searchAdmission?.activeUnits, "number");
    assert.equal(typeof payload.searchAdmission?.queuedCount, "number");
    assert.equal(typeof payload.sessions?.counts?.searchJobs, "number");
    assert.equal(typeof payload.sessions?.counts?.purchasePaths, "number");
    assert.equal(typeof payload.tempArtifacts?.totals?.count, "number");
  });
});

test("diagnostics endpoint ignores spoofed Host headers on loopback", async () => {
  await withServer(async (baseUrl) => {
    const url = new URL(baseUrl);
    const payload = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = httpRequest({
        host: url.hostname,
        port: Number(url.port),
        path: "/api/diagnostics",
        method: "GET",
        headers: {
          Host: "evil.example",
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      });

      req.on("error", reject);
      req.end();
    });

    assert.equal(payload.statusCode, 200);
    const json = JSON.parse(payload.body) as { ok?: boolean };
    assert.equal(json.ok, true);
  });
});

test("rejects oversized JSON bodies before routing", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureDate: "2026-04-15",
              returnDate: "2026-04-22",
              originLabel: "X".repeat(1_100_000),
            },
          ],
        },
      }),
    });

    assert.equal(response.status, 413);
    const payload = await response.json() as { error?: string };
    assert.match(payload.error ?? "", /byte limit/i);
  });
});

/*
 * A shared search link is entirely query string, and the gate used to drop it:
 * the redirect to `/login` kept the path and nothing else, so signing in landed
 * the agent on an empty workspace. The return path is now carried through, and
 * because it arrives from whoever sent the link it is only ever a path here.
 */
test("the gate returns the agent to the link they followed", { concurrency: false }, async () => {
  const restore = applyEnvironment({
    FLY_DESK_WEB_AUTH: "1",
    FLY_DESK_WEB_PASSWORD: undefined,
    FLY_DESK_WEB_PASSWORD_HASH: createScryptPasswordHash("test-password", Buffer.alloc(16, 21)),
    FLY_DESK_WEB_SESSION_SECRET: "test-session-secret-32-characters-minimum",
  });

  const signIn = async (client: string, password: string, next?: string) => {
    resetWebLoginAdmission(client);
    const body = new URLSearchParams({ password });
    if (next !== undefined) {
      body.set("next", next);
    }

    return routeRequest(new Request("https://fly-desk.local/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-flydesk-client-address": client,
      },
      body: body.toString(),
    }));
  };

  try {
    const shared = await signIn("next-a", "test-password", "/?mode=exact&trip=one-way&origin=LIM&destination=MIA");
    assert.equal(shared.status, 303);
    assert.equal(shared.headers.get("location"), "/?mode=exact&trip=one-way&origin=LIM&destination=MIA");

    const plain = await signIn("next-b", "test-password");
    assert.equal(plain.headers.get("location"), "/");

    /* An open redirect here would be a real one: the gate is reachable from
       any link, and the browser follows whatever comes back. Every shape below
       has to fall back to this origin. */
    for (const hostile of [
      "https://evil.com/",
      "http://evil.com",
      "//evil.com",
      "//evil.com/path",
      "/\\evil.com",
      "\\\\evil.com",
      "javascript:alert(1)",
      "evil.com",
    ]) {
      const attempt = await signIn(`next-hostile-${hostile}`, "test-password", hostile);
      assert.equal(attempt.status, 303);
      assert.equal(
        attempt.headers.get("location"),
        "/",
        `expected ${hostile} to be refused as a return path`,
      );
    }

    /* A wrong password costs the attempt, not the link. */
    const refused = await signIn("next-c", "wrong-password", "/?origin=LIM");
    assert.equal(refused.status, 303);
    assert.equal(refused.headers.get("location"), "/login?error=1&next=%2F%3Forigin%3DLIM");

    const refusedHostile = await signIn("next-d", "wrong-password", "https://evil.com/");
    assert.equal(refusedHostile.headers.get("location"), "/login?error=1");
  } finally {
    restore();
  }
});

/*
 * The other half of the same fix: while the agent works, the window moves.
 * Nothing is written until the session is more than half spent, so an ordinary
 * response is unchanged and stays as cacheable as it was.
 */
test("an authenticated request slides the session forward once it is half spent", { concurrency: false }, async () => {
  const restore = applyEnvironment({
    FLY_DESK_WEB_AUTH: "1",
    FLY_DESK_TRUST_LOOPBACK_CLIENT: "0",
    FLY_DESK_WEB_PASSWORD: undefined,
    FLY_DESK_WEB_PASSWORD_HASH: createScryptPasswordHash("test-password", Buffer.alloc(16, 22)),
    FLY_DESK_WEB_SESSION_SECRET: "test-session-secret-32-characters-minimum",
    FLY_DESK_WEB_SESSION_TTL_SECONDS: "300",
  });

  const call = (cookie: string) => routeRequest(new Request("https://fly-desk.local/api/locations?q=", {
    headers: { "x-flydesk-client-loopback": "0", Cookie: cookie },
  }));

  try {
    const freshCookie = createWebSessionCookie(new Request("https://fly-desk.local/"), Date.now())
      .split(";", 1)[0]!;
    const fresh = await call(freshCookie);
    assert.equal(fresh.status, 200);
    assert.equal(fresh.headers.getSetCookie().length, 0);

    /* The same session, seen from far enough into its window that renewal is
       due. `createWebSessionCookie` takes the clock, so the wait is skipped. */
    const agedCookie = createWebSessionCookie(
      new Request("https://fly-desk.local/"),
      Date.now() - 151_000,
    ).split(";", 1)[0]!;
    const aged = await call(agedCookie);
    assert.equal(aged.status, 200);
    const renewed = aged.headers.getSetCookie();
    assert.equal(renewed.length, 2);
    assert.ok(renewed.some((value) => value.startsWith("flydesk_session=v2.")));
    assert.ok(renewed.some((value) => value.startsWith("flydesk_redirect_session=")));
    assert.ok(renewed.every((value) => value.includes("HttpOnly")));
    assert.ok(renewed.every((value) => value.includes("SameSite=Lax")));

    /* Signing out has to win over renewal, or the request that ends the
       session would be the one that extends it. */
    const logout = await routeRequest(new Request("https://fly-desk.local/logout", {
      method: "POST",
      headers: { Cookie: agedCookie },
    }));
    assert.equal(logout.headers.getSetCookie().length, 2);
    assert.ok(logout.headers.getSetCookie().every((value) => value.includes("Max-Age=0")));
  } finally {
    restore();
  }
});
