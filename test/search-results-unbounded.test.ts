import { test } from "bun:test";
import assert from "node:assert/strict";
import { materializeSearchResponse } from "../src/core/orchestrator";
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
    filters: {
      maxResults: 5,
      compactAllOffers: true,
    },
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

test("search materialization keeps every provider result even when legacy cap filters are present", () => {
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
