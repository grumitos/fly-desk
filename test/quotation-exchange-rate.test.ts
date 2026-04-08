import test from "node:test";
import assert from "node:assert/strict";
import type { SearchRequest } from "../src/core/types";
import {
  buildQuotationRateLookupRequest,
  resolveQuotationUsdToPenRate,
  resetQuotationUsdToPenRateCacheForTests,
  warmQuotationUsdToPenRate,
} from "../src/quotation-exchange-rate";
import type { SearchSessionRecord } from "../src/session-store";
import { buildOffer, buildSearchMeta } from "./helpers/ui-fixtures";

function buildRequest(): SearchRequest {
  return {
    providerId: "costamar",
    tripType: "round-trip",
    searchMode: "stay-range",
    legs: [
      {
        origin: "LIM",
        destination: "BUE",
        originLabel: "LIM - Lima, Peru",
        destinationLabel: "BUE - Buenos Aires, Argentina",
        departureStart: "2026-04-10",
        departureEnd: "2026-04-15",
        returnStart: "2026-05-10",
        returnEnd: "2026-05-15",
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

function buildSession(overrides: Partial<SearchSessionRecord> = {}): SearchSessionRecord {
  const searchMeta = buildSearchMeta("search_live");

  return {
    id: "session-1",
    request: buildRequest(),
    offers: [buildOffer()],
    searchMeta: {
      ...searchMeta,
      requestedAt: "2026-04-07T12:00:00.000Z",
      completedAt: "2026-04-07T12:00:00.000Z",
    },
    providerMeta: {
      exactProvider: "costamar",
      coverageMode: "core",
    },
    warnings: [],
    createdAt: "2026-04-07T12:00:00.000Z",
    ...overrides,
  };
}

test("buildQuotationRateLookupRequest derives an exact Agil request from the selected offer", () => {
  const request = buildRequest();
  const offer = buildOffer({
    tripType: "round-trip",
    itineraries: [
      {
        direction: "outbound",
        durationMinutes: 260,
        stops: 0,
        segments: [
          {
            id: "seg-1",
            marketingCarrier: "AR",
            flightNumber: "1365",
            origin: "LIM",
            destination: "AEP",
            departureAt: "2026-04-11T02:45:00Z",
            arrivalAt: "2026-04-11T09:05:00Z",
            durationMinutes: 260,
          },
        ],
      },
      {
        direction: "inbound",
        durationMinutes: 295,
        stops: 0,
        segments: [
          {
            id: "seg-2",
            marketingCarrier: "LA",
            flightNumber: "2381",
            origin: "AEP",
            destination: "LIM",
            departureAt: "2026-05-10T22:35:00Z",
            arrivalAt: "2026-05-11T01:30:00Z",
            durationMinutes: 295,
          },
        ],
      },
    ],
  });

  assert.deepEqual(buildQuotationRateLookupRequest(request, offer), {
    ...request,
    providerId: "agil-local",
    tripType: "round-trip",
    searchMode: "exact",
    legs: [
      {
        origin: "LIM",
        destination: "BUE",
        originLabel: "LIM - Lima, Peru",
        destinationLabel: "BUE - Buenos Aires, Argentina",
        departureDate: "2026-04-11",
        returnDate: "2026-05-10",
      },
    ],
  });
});

test("resolveQuotationUsdToPenRate reuses the rate already present in the session and keeps a same-day cache", async () => {
  resetQuotationUsdToPenRateCacheForTests();

  const quotedOffer = buildOffer({
    id: "offer-costamar",
    providerSource: "costamar",
    tripType: "round-trip",
  });
  const session = buildSession({
    offers: [
      quotedOffer,
      buildOffer({
        id: "offer-agil",
        providerSource: "agil-local",
        tripType: "round-trip",
        usdToPenRate: 3.61,
      }),
    ],
  });
  let lookupCalls = 0;

  const firstRate = await resolveQuotationUsdToPenRate(session, quotedOffer, {
    now: new Date("2026-04-07T15:00:00.000Z"),
    searchRate: async () => {
      lookupCalls += 1;
      return 3.55;
    },
  });
  const secondRate = await resolveQuotationUsdToPenRate(
    buildSession({
      offers: [quotedOffer],
    }),
    quotedOffer,
    {
      now: new Date("2026-04-07T20:00:00.000Z"),
      searchRate: async () => {
        lookupCalls += 1;
        return 3.55;
      },
    },
  );

  assert.equal(firstRate, 3.61);
  assert.equal(secondRate, 3.61);
  assert.equal(lookupCalls, 0);
});

test("resolveQuotationUsdToPenRate refreshes the cache on a new Lima day", async () => {
  resetQuotationUsdToPenRateCacheForTests();

  const offer = buildOffer({
    providerSource: "costamar",
    tripType: "round-trip",
  });
  const session = buildSession({
    offers: [offer],
  });
  let lookupCalls = 0;

  const firstRate = await resolveQuotationUsdToPenRate(session, offer, {
    now: new Date("2026-04-07T15:00:00.000Z"),
    searchRate: async () => {
      lookupCalls += 1;
      return 3.5;
    },
  });
  const secondRate = await resolveQuotationUsdToPenRate(session, offer, {
    now: new Date("2026-04-07T23:00:00.000Z"),
    searchRate: async () => {
      lookupCalls += 1;
      return 3.7;
    },
  });
  const thirdRate = await resolveQuotationUsdToPenRate(session, offer, {
    now: new Date("2026-04-08T15:00:00.000Z"),
    searchRate: async () => {
      lookupCalls += 1;
      return 3.7;
    },
  });

  assert.equal(firstRate, 3.5);
  assert.equal(secondRate, 3.5);
  assert.equal(thirdRate, 3.7);
  assert.equal(lookupCalls, 2);
});

test("resolveQuotationUsdToPenRate shares the same in-flight lookup on the current Lima day", async () => {
  resetQuotationUsdToPenRateCacheForTests();

  const offer = buildOffer({
    providerSource: "costamar",
    tripType: "round-trip",
  });
  const session = buildSession({
    offers: [offer],
  });
  let lookupCalls = 0;
  const searchRate = async () => {
    lookupCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return 3.66;
  };

  const [firstRate, secondRate] = await Promise.all([
    resolveQuotationUsdToPenRate(session, offer, {
      now: new Date("2026-04-07T15:00:00.000Z"),
      searchRate,
    }),
    resolveQuotationUsdToPenRate(session, offer, {
      now: new Date("2026-04-07T15:00:00.000Z"),
      searchRate,
    }),
  ]);

  assert.equal(firstRate, 3.66);
  assert.equal(secondRate, 3.66);
  assert.equal(lookupCalls, 1);
});

test("warmQuotationUsdToPenRate primes the daily cache before the quotation endpoint needs it", async () => {
  resetQuotationUsdToPenRateCacheForTests();

  const offer = buildOffer({
    providerSource: "costamar",
    tripType: "round-trip",
  });
  let lookupCalls = 0;

  await warmQuotationUsdToPenRate(buildSession({
    offers: [offer],
  }), {
    now: new Date("2026-04-07T15:00:00.000Z"),
    searchRate: async () => {
      lookupCalls += 1;
      return 3.58;
    },
  });

  const rate = await resolveQuotationUsdToPenRate(buildSession({
    offers: [offer],
  }), offer, {
    now: new Date("2026-04-07T18:00:00.000Z"),
    searchRate: async () => {
      lookupCalls += 1;
      return 3.7;
    },
  });

  assert.equal(rate, 3.58);
  assert.equal(lookupCalls, 1);
});
