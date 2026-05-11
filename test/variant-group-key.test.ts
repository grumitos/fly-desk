import { test } from "bun:test";
import assert from "node:assert/strict";
import { Itinerary } from "../src/core/types";
import { buildFlexibleVariantGroupKey } from "../src/core/variant-group-key";

function buildItineraries(
  departureDate: string,
  returnDate: string,
  options?: { withStop?: boolean },
): Itinerary[] {
  const outboundSegments = options?.withStop
    ? [
        {
          id: "out-1",
          marketingCarrier: "LA",
          flightNumber: "LA2041",
          origin: "LIM",
          destination: "SCL",
          departureAt: `${departureDate}T08:10:00`,
          arrivalAt: `${departureDate}T12:00:00`,
          durationMinutes: 230,
        },
        {
          id: "out-2",
          marketingCarrier: "LA",
          flightNumber: "LA540",
          origin: "SCL",
          destination: "MIA",
          departureAt: `${departureDate}T13:20:00`,
          arrivalAt: `${departureDate}T18:40:00`,
          durationMinutes: 320,
        },
      ]
    : [
        {
          id: "out-1",
          marketingCarrier: "LA",
          flightNumber: "LA500",
          origin: "LIM",
          destination: "MIA",
          departureAt: `${departureDate}T08:10:00`,
          arrivalAt: `${departureDate}T14:00:00`,
          durationMinutes: 350,
        },
      ];

  const outbound: Itinerary = {
    id: "outbound",
    direction: "outbound",
    durationMinutes: options?.withStop ? 630 : 350,
    stops: options?.withStop ? 1 : 0,
    layoverMinutes: options?.withStop ? [80] : [],
    segments: outboundSegments,
  };

  const inbound: Itinerary = {
    id: "inbound",
    direction: "inbound",
    durationMinutes: 345,
    stops: 0,
    layoverMinutes: [],
    segments: [
      {
        id: "in-1",
        marketingCarrier: "LA",
        flightNumber: "LA501",
        origin: "MIA",
        destination: "LIM",
        departureAt: `${returnDate}T10:40:00`,
        arrivalAt: `${returnDate}T16:25:00`,
        durationMinutes: 345,
      },
    ],
  };

  return [outbound, inbound];
}

test("flexible variant keys match when the flight is the same but dates change", () => {
  const first = buildFlexibleVariantGroupKey({
    mainCarrier: "LA",
    validatingCarrier: "LA",
    totalAmount: 512,
    currencyCode: "USD",
    itineraries: buildItineraries("2026-05-10", "2026-05-17"),
    baggage: {
      carryOnIncluded: true,
      checkedIncluded: true,
    },
  });

  const second = buildFlexibleVariantGroupKey({
    mainCarrier: "LA",
    validatingCarrier: "LA",
    totalAmount: 512,
    currencyCode: "USD",
    itineraries: buildItineraries("2026-05-11", "2026-05-18"),
    baggage: {
      carryOnIncluded: true,
      checkedIncluded: true,
    },
  });

  assert.equal(first, second);
});

test("flexible variant keys match normalized airline names across carrier code variants", () => {
  const withCarrier = (carrier: string, name: string): Itinerary[] =>
    buildItineraries("2026-05-10", "2026-05-17").map((itinerary) => ({
      ...itinerary,
      segments: itinerary.segments.map((segment) => ({
        ...segment,
        marketingCarrier: carrier,
        marketingCarrierName: name,
        flightNumber: `${carrier}${segment.flightNumber.replace(/^LA/, "")}`,
      })),
    }));

  const first = buildFlexibleVariantGroupKey({
    mainCarrier: "JA",
    validatingCarrier: "JA",
    totalAmount: 512,
    currencyCode: "USD",
    itineraries: withCarrier("JA", "JetSMART"),
    baggage: {
      carryOnIncluded: true,
      checkedIncluded: true,
    },
  });

  const second = buildFlexibleVariantGroupKey({
    mainCarrier: "JZ",
    validatingCarrier: "JZ",
    totalAmount: 512,
    currencyCode: "USD",
    itineraries: withCarrier("JZ", "JetSmart Airlines SpA"),
    baggage: {
      carryOnIncluded: true,
      checkedIncluded: true,
    },
  });

  assert.equal(first, second);
});

test("flexible variant keys split direct flights and stopover flights", () => {
  const direct = buildFlexibleVariantGroupKey({
    mainCarrier: "LA",
    validatingCarrier: "LA",
    totalAmount: 512,
    currencyCode: "USD",
    itineraries: buildItineraries("2026-05-10", "2026-05-17"),
    baggage: {
      carryOnIncluded: true,
      checkedIncluded: true,
    },
  });

  const withStop = buildFlexibleVariantGroupKey({
    mainCarrier: "LA",
    validatingCarrier: "LA",
    totalAmount: 512,
    currencyCode: "USD",
    itineraries: buildItineraries("2026-05-10", "2026-05-17", { withStop: true }),
    baggage: {
      carryOnIncluded: true,
      checkedIncluded: true,
    },
  });

  assert.notEqual(direct, withStop);
});

test("flexible variant keys split fares when baggage inclusion changes", () => {
  const withBag = buildFlexibleVariantGroupKey({
    mainCarrier: "LA",
    validatingCarrier: "LA",
    totalAmount: 512,
    currencyCode: "USD",
    itineraries: buildItineraries("2026-05-10", "2026-05-17"),
    baggage: {
      carryOnIncluded: true,
      checkedIncluded: true,
    },
  });

  const withoutBag = buildFlexibleVariantGroupKey({
    mainCarrier: "LA",
    validatingCarrier: "LA",
    totalAmount: 512,
    currencyCode: "USD",
    itineraries: buildItineraries("2026-05-10", "2026-05-17"),
    baggage: {
      carryOnIncluded: true,
      checkedIncluded: false,
    },
  });

  assert.notEqual(withBag, withoutBag);
});
