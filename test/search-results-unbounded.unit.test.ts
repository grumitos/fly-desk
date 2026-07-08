import { test } from "bun:test";
import assert from "node:assert/strict";
import { materializeSearchResponse } from "../src/core/orchestrator";
import { PROVIDER_OFFER_VARIANT_LIMIT, takeProviderOfferVariants } from "../src/core/provider-offer-limits";
import type { CanonicalOffer, SearchRequest } from "../src/core/types";

function buildRequest(): SearchRequest {
  return {
    tripType: "round-trip",
    searchMode: "exact",
    legs: [
      {
        origin: "LIM",
        destination: "MIA",
        departureDate: "2026-04-15",
        returnDate: "2026-04-22",
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

function buildOffer(index: number): CanonicalOffer {
  return {
    id: `offer-${index}`,
    origin: "LIM",
    destination: "MIA",
    tripType: "round-trip",
    providerSource: "agil-local",
    providerOfferRef: `ref-${index}`,
    signature: `sig-${index}`,
    validatingCarrier: "LA",
    mainCarrier: "LA",
    itineraries: [],
    price: {
      total: {
        amount: 100 + index,
        currencyCode: "USD",
      },
    },
    priceConfidence: "live",
    priceStatus: "unverified",
    purchasePaths: [],
    comparisonMetrics: {
      totalDurationMinutes: 0,
      totalStops: 0,
      baggageScore: 0,
      purchasePathScore: 0,
    },
    tags: [],
    warnings: [],
  };
}

test("search materialization keeps every provider result", () => {
  const response = materializeSearchResponse(
    buildRequest(),
    "cheapest",
    "agil-local",
    {
      offers: Array.from({ length: 14 }, (_, index) => buildOffer(index + 1)),
      warnings: [],
      partial: false,
    },
  );

  assert.equal(response.offers.length, 14);
  assert.equal(response.allOffers?.length, 14);
  assert.equal(response.offers[13]?.providerOfferRef, "ref-14");
});

test("provider adapters cap variants before offer materialization", () => {
  const variants = Array.from({ length: PROVIDER_OFFER_VARIANT_LIMIT + 30 }, (_, index) => index + 1);

  assert.equal(takeProviderOfferVariants(variants).length, PROVIDER_OFFER_VARIANT_LIMIT);
  assert.equal(takeProviderOfferVariants(variants)[PROVIDER_OFFER_VARIANT_LIMIT - 1], PROVIDER_OFFER_VARIANT_LIMIT);
});

test("search filters narrow visible offers without removing retained provider results", () => {
  const direct = buildOffer(1);
  const stopover = {
    ...buildOffer(2),
    itineraries: [
      {
        id: "outbound-stopover",
        direction: "outbound" as const,
        durationMinutes: 360,
        stops: 1,
        segments: [
          {
            id: "segment-1",
            origin: "LIM",
            destination: "BOG",
            departureAt: "2026-04-15T10:00:00Z",
            arrivalAt: "2026-04-15T13:00:00Z",
          },
          {
            id: "segment-2",
            origin: "BOG",
            destination: "MIA",
            departureAt: "2026-04-15T14:00:00Z",
            arrivalAt: "2026-04-15T17:00:00Z",
          },
        ],
      },
    ],
  };
  const request = buildRequest();
  request.filters.maxStops = 0;

  const response = materializeSearchResponse(
    request,
    "cheapest",
    "agil-local",
    {
      offers: [direct, stopover],
      warnings: [],
      partial: false,
    },
  );

  assert.equal(response.offers.length, 1);
  assert.equal(response.allOffers?.length, 2);
});

test("search materialization does not mark unverified offers as quote-ready", () => {
  const response = materializeSearchResponse(
    buildRequest(),
    "cheapest",
    "agil-local",
    {
      offers: [buildOffer(1)],
      warnings: [],
      partial: false,
    },
  );

  assert.equal(response.offers[0]?.priceConfidence, "live");
  assert.equal(response.offers[0]?.priceStatus, "unverified");
  assert.equal(response.offers[0]?.quotationPreparedAt, undefined);
  assert.equal(response.allOffers?.[0]?.quotationPreparedAt, undefined);
});
