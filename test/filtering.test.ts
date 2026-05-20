import { test } from "bun:test";
import assert from "node:assert/strict";
import { applySearchFilters } from "../src/core/filtering";

function buildDirectItinerary(id: string, direction: "outbound" | "inbound", origin: string, destination: string, departureAt: string, durationMinutes: number) {
  const arrivalAt = new Date(Date.parse(departureAt) + durationMinutes * 60000).toISOString();
  return {
    id: `${id}-${direction}`,
    direction,
    durationMinutes,
    stops: 0,
    layoverMinutes: [],
    segments: [
      {
        id: `${id}-${direction}-seg-1`,
        marketingCarrier: "LA",
        flightNumber: direction === "outbound" ? "LA201" : "LA456",
        origin,
        destination,
        departureAt,
        arrivalAt,
        durationMinutes,
      },
    ],
  };
}

function buildOneStopItinerary(
  id: string,
  direction: "outbound" | "inbound",
  origin: string,
  connection: string,
  destination: string,
  departureAt: string,
  layoverMinutes: number,
) {
  const firstDuration = 240;
  const secondDuration = 240;
  const firstArrival = new Date(Date.parse(departureAt) + firstDuration * 60000).toISOString();
  const secondDepartureAt = new Date(Date.parse(firstArrival) + layoverMinutes * 60000).toISOString();
  const secondArrivalAt = new Date(Date.parse(secondDepartureAt) + secondDuration * 60000).toISOString();

  return {
    id: `${id}-${direction}`,
    direction,
    durationMinutes: firstDuration + layoverMinutes + secondDuration,
    stops: 1,
    layoverMinutes: [layoverMinutes],
    segments: [
      {
        id: `${id}-${direction}-seg-1`,
        marketingCarrier: "LA",
        flightNumber: direction === "outbound" ? "LA201" : "LA457",
        origin,
        destination: connection,
        departureAt,
        arrivalAt: firstArrival,
        durationMinutes: firstDuration,
      },
      {
        id: `${id}-${direction}-seg-2`,
        marketingCarrier: "LA",
        flightNumber: direction === "outbound" ? "LA305" : "LA458",
        origin: connection,
        destination,
        departureAt: secondDepartureAt,
        arrivalAt: secondArrivalAt,
        durationMinutes: secondDuration,
      },
    ],
  };
}

function buildFilterOffer(id: string, layoverMinutes: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    signature: id,
    providerSource: "agil-local",
    providerOfferRef: id,
    tripType: "round-trip",
    validatingCarrier: "LA",
    mainCarrier: "LA",
    origin: "LIM",
    destination: "MIA",
    itineraries: [
      buildOneStopItinerary(id, "outbound", "LIM", "BOG", "MIA", "2026-04-15T08:00:00Z", layoverMinutes),
      buildDirectItinerary(id, "inbound", "MIA", "LIM", "2026-04-22T15:00:00Z", 470),
    ],
    price: {
      total: {
        amount: 550,
        currencyCode: "USD",
      },
    },
    baggage: {
      carryOnIncluded: true,
      checkedIncluded: true,
    },
    fareMeta: {},
    priceConfidence: "live",
    priceStatus: "unverified",
    purchasePaths: [],
    comparisonMetrics: {
      totalDurationMinutes: 940 + layoverMinutes,
      totalStops: 1,
      baggageScore: 2,
      purchasePathScore: 0,
    },
    tags: [],
    warnings: [],
    ...overrides,
  } as any;
}

function buildRoundTripWithOneStopEachWay(id: string) {
  return {
    ...buildFilterOffer(id, 120),
    itineraries: [
      buildOneStopItinerary(id, "outbound", "LIM", "BOG", "MIA", "2026-04-15T08:00:00Z", 120),
      buildOneStopItinerary(id, "inbound", "MIA", "BOG", "LIM", "2026-04-22T15:00:00Z", 90),
    ],
    comparisonMetrics: {
      totalDurationMinutes: 1170,
      totalStops: 2,
      baggageScore: 2,
      purchasePathScore: 0,
    },
  } as any;
}

test("applySearchFilters rejects offers whose longest layover exceeds the configured limit", () => {
  const shortLayover = buildFilterOffer("short", 120);
  const longLayover = buildFilterOffer("long", 300);

  const filtered = applySearchFilters([shortLayover, longLayover], {
    maxLayoverMinutes: 180,
  });

  assert.deepEqual(filtered.map((offer) => offer.id), ["short"]);
});

test("applySearchFilters treats maxStops as a per-itinerary limit for round trips", () => {
  const roundTrip = buildRoundTripWithOneStopEachWay("round-trip");

  const filtered = applySearchFilters([roundTrip], {
    maxStops: 1,
  });

  assert.deepEqual(filtered.map((offer) => offer.id), ["round-trip"]);
});

test("applySearchFilters does not apply a hidden maxStops limit when none is configured", () => {
  const roundTrip = buildRoundTripWithOneStopEachWay("round-trip-no-limit");

  const filtered = applySearchFilters([roundTrip], {});

  assert.deepEqual(filtered.map((offer) => offer.id), ["round-trip-no-limit"]);
});

test("applySearchFilters can require carry-on baggage independently", () => {
  const carryOnly = buildFilterOffer("carry-only", 120, {
    baggage: {
      carryOnIncluded: true,
      checkedIncluded: false,
    },
  });
  const checkedOnly = buildFilterOffer("checked-only", 120, {
    baggage: {
      carryOnIncluded: false,
      checkedIncluded: true,
    },
  });

  const filtered = applySearchFilters([carryOnly, checkedOnly], {
    carryOnRequired: true,
  });

  assert.deepEqual(filtered.map((offer) => offer.id), ["carry-only"]);
});

test("applySearchFilters can require checked baggage independently", () => {
  const carryOnly = buildFilterOffer("carry-only", 120, {
    baggage: {
      carryOnIncluded: true,
      checkedIncluded: false,
    },
  });
  const checkedOnly = buildFilterOffer("checked-only", 120, {
    baggage: {
      carryOnIncluded: false,
      checkedIncluded: true,
    },
  });

  const filtered = applySearchFilters([carryOnly, checkedOnly], {
    checkedBaggageRequired: true,
  });

  assert.deepEqual(filtered.map((offer) => offer.id), ["checked-only"]);
});

test("applySearchFilters keeps legacy baggageRequired as checked baggage", () => {
  const carryOnly = buildFilterOffer("carry-only", 120, {
    baggage: {
      carryOnIncluded: true,
      checkedIncluded: false,
    },
  });
  const checkedOnly = buildFilterOffer("checked-only", 120, {
    baggage: {
      carryOnIncluded: false,
      checkedIncluded: true,
    },
  });

  const filtered = applySearchFilters([carryOnly, checkedOnly], {
    baggageRequired: true,
  });

  assert.deepEqual(filtered.map((offer) => offer.id), ["checked-only"]);
});
