import test from "node:test";
import assert from "node:assert/strict";
import { limitSearchResponseForPagination, resolveListSearchResultLimit } from "../src/search-limits";
import type { SearchRequest, SearchResponse } from "../src/core/types";

function buildRequest(maxResults?: number): SearchRequest {
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
    filters: typeof maxResults === "number" ? { maxResults } : {},
    coverageMode: "core",
    redirectMode: "best-effort",
    currencyCode: "USD",
    locale: "es-PE",
    market: "PE",
  };
}

function buildResponse(totalOffers: number): SearchResponse {
  const offers = Array.from({ length: totalOffers }, (_, index) => ({
    id: `offer-${index + 1}`,
    origin: "LIM",
    destination: "MIA",
    tripType: "round-trip" as const,
    providerSource: "agil-local" as const,
    providerOfferRef: `ref-${index + 1}`,
    signature: `sig-${index + 1}`,
    validatingCarrier: "LA",
    mainCarrier: "LA",
    itineraries: [],
    price: {
      total: {
        amount: 100 + index,
        currencyCode: "USD",
      },
    },
    priceConfidence: "live" as const,
    priceStatus: "unverified" as const,
    purchasePaths: [],
    comparisonMetrics: {
      totalDurationMinutes: 0,
      totalStops: 0,
      baggageScore: 0,
      purchasePathScore: 0,
    },
    tags: [],
    warnings: [],
    valueScore: 0,
  }));

  return {
    offers,
    allOffers: offers,
    searchMeta: {
      requestedAt: "2026-04-07T00:00:00.000Z",
      completedAt: "2026-04-07T00:00:00.000Z",
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
  };
}

test("default list searches cap pagination work at 25 pages", () => {
  assert.equal(resolveListSearchResultLimit(buildRequest()), 375);

  const limited = limitSearchResponseForPagination(buildRequest(), buildResponse(390));
  assert.equal(limited.offers.length, 375);
  assert.equal(limited.allOffers?.length, 375);
  assert.equal(limited.offers[374]?.id, "offer-375");
});

test("explicit lower maxResults still wins over the default early-stop limit", () => {
  assert.equal(resolveListSearchResultLimit(buildRequest(5)), 5);

  const limited = limitSearchResponseForPagination(buildRequest(5), buildResponse(14));
  assert.equal(limited.offers.length, 5);
  assert.equal(limited.allOffers?.length, 5);
  assert.equal(limited.offers[4]?.id, "offer-5");
});
