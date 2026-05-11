import { test } from "bun:test";
import assert from "node:assert/strict";
import type { CanonicalOffer, ProviderId, PurchasePath } from "../src/core/types";
import { groupExactProviderOffers } from "../src/core/offer-grouping";
import { materializeSearchResponse } from "../src/core/orchestrator";

function buildPath(provider: ProviderId, url: string): PurchasePath {
  return {
    id: `${provider}-path`,
    type: provider === "costamar" ? "search-redirect" : "deeplink",
    provider,
    label: provider === "costamar" ? "Buscar en Costamar" : "Buscar en Agil",
    url,
    precision: provider === "costamar" ? "exact-search" : "exact-offer",
    score: provider === "costamar" ? 0.8 : 1,
    requiresNewTab: true,
    commercialMode: "provider",
    state: provider === "costamar" ? "search_redirect" : "deeplink_exact",
  };
}

function buildOffer(
  provider: ProviderId,
  overrides: Partial<CanonicalOffer> = {},
): CanonicalOffer {
  const path = buildPath(provider, `https://example.test/${provider}`);

  return {
    id: `${provider}-offer`,
    signature: `${provider}-signature`,
    providerSource: provider,
    providerOfferRef: `${provider}-ref`,
    tripType: "round-trip",
    validatingCarrier: "LA",
    mainCarrier: "LA",
    origin: "LIM",
    destination: "MIA",
    itineraries: [
      {
        id: `${provider}-outbound`,
        direction: "outbound",
        durationMinutes: 360,
        stops: 0,
        layoverMinutes: [],
        segments: [
          {
            id: `${provider}-outbound-segment`,
            marketingCarrier: "LA",
            flightNumber: provider === "costamar" ? "LA 500" : "500",
            origin: "LIM",
            destination: "MIA",
            departureAt: "2026-06-15T08:10:00",
            arrivalAt: "2026-06-15T14:10:00",
            durationMinutes: 360,
          },
        ],
      },
      {
        id: `${provider}-inbound`,
        direction: "inbound",
        durationMinutes: 355,
        stops: 0,
        layoverMinutes: [],
        segments: [
          {
            id: `${provider}-inbound-segment`,
            marketingCarrier: "LA",
            flightNumber: provider === "costamar" ? "LA 501" : "501",
            origin: "MIA",
            destination: "LIM",
            departureAt: "2026-06-22T10:20:00",
            arrivalAt: "2026-06-22T16:15:00",
            durationMinutes: 355,
          },
        ],
      },
    ],
    price: {
      total: { amount: 512, currencyCode: "USD" },
      base: { amount: 420, currencyCode: "USD" },
      taxes: { amount: 92, currencyCode: "USD" },
    },
    baggage: {
      carryOnIncluded: true,
      checkedIncluded: true,
      checkedBags: 1,
    },
    priceConfidence: "live",
    priceStatus: "verified",
    purchasePaths: [path],
    comparisonMetrics: {
      totalDurationMinutes: 715,
      totalStops: 0,
      baggageScore: 2,
      purchasePathScore: 3,
    },
    tags: [],
    warnings: [],
    ...overrides,
  };
}

test("groupExactProviderOffers merges identical Agil and Costamar offers while preserving provider links", () => {
  const grouped = groupExactProviderOffers([
    buildOffer("agil-local"),
    buildOffer("costamar"),
  ]);

  assert.equal(grouped.length, 1);
  assert.match(grouped[0].id, /^exact-group-/);
  assert.deepEqual(
    grouped[0].purchasePaths.map((path) => path.provider),
    ["agil-local", "costamar"],
  );
  assert.deepEqual(grouped[0].tags, ["Agil + Costamar"]);
});

test("groupExactProviderOffers keeps offers with different schedules separate", () => {
  const costamarOffer = buildOffer("costamar");
  const grouped = groupExactProviderOffers([
    buildOffer("agil-local"),
    buildOffer("costamar", {
      itineraries: [
        {
          ...costamarOffer.itineraries[0],
          segments: [
            {
              ...costamarOffer.itineraries[0].segments[0],
              departureAt: "2026-06-15T09:10:00",
              arrivalAt: "2026-06-15T15:10:00",
            },
          ],
        },
        costamarOffer.itineraries[1],
      ],
    }),
  ]);

  assert.equal(grouped.length, 2);
});

test("materializeSearchResponse returns grouped provider duplicates", () => {
  const response = materializeSearchResponse(
    {
      providerId: "agil-local",
      tripType: "round-trip",
      searchMode: "exact",
      legs: [
        {
          origin: "LIM",
          destination: "MIA",
          departureDate: "2026-06-15",
          returnDate: "2026-06-22",
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
    },
    "cheapest",
    "agil-local",
    {
      offers: [
        buildOffer("agil-local"),
        buildOffer("costamar"),
      ],
      warnings: [],
      partial: false,
    },
  );

  assert.equal(response.offers.length, 1);
  assert.equal(response.allOffers?.length, 1);
  assert.deepEqual(
    response.offers[0].purchasePaths.map((path) => path.provider),
    ["agil-local", "costamar"],
  );
});
