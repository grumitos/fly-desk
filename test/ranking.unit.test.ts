import { test } from "bun:test";
import assert from "node:assert/strict";
import { sortOffers } from "../src/core/ranking";
import type { CanonicalOffer, Itinerary } from "../src/core/types";

function buildItinerary(
  id: string,
  direction: Itinerary["direction"],
  departureAt: string,
  stops: number,
  durationMinutes: number,
): Itinerary {
  /* One segment per stop plus one; only the first `departureAt` and the
     count matter, which is what both new orders read. */
  const segments = Array.from({ length: stops + 1 }, (_, index) => ({
    id: `${id}-seg-${index + 1}`,
    marketingCarrier: "LA",
    flightNumber: `LA${100 + index}`,
    origin: index === 0 ? "LIM" : "SCL",
    destination: index === stops ? "MAD" : "SCL",
    departureAt: index === 0 ? departureAt : departureAt,
    arrivalAt: departureAt,
    durationMinutes: Math.round(durationMinutes / (stops + 1)),
  }));

  return { id, direction, durationMinutes, stops, layoverMinutes: [], segments };
}

function buildOffer(input: {
  id: string;
  amount: number;
  outboundDepartureAt: string;
  stops?: number;
  durationMinutes?: number;
  inboundDepartureAt?: string;
}): CanonicalOffer {
  const stops = input.stops ?? 0;
  const itineraries = [
    buildItinerary(`${input.id}-out`, "outbound", input.outboundDepartureAt, stops, input.durationMinutes ?? 600),
  ];

  if (input.inboundDepartureAt) {
    itineraries.push(buildItinerary(`${input.id}-in`, "inbound", input.inboundDepartureAt, stops, 600));
  }

  return {
    id: input.id,
    signature: `agil-local:${input.id}`,
    providerSource: "agil-local",
    providerOfferRef: input.id,
    tripType: input.inboundDepartureAt ? "round-trip" : "one-way",
    origin: "LIM",
    destination: "MAD",
    itineraries,
    price: { total: { amount: input.amount, currencyCode: "USD" } },
    priceConfidence: "live",
    priceStatus: "unverified",
    purchasePaths: [],
    comparisonMetrics: {
      totalDurationMinutes: input.durationMinutes ?? 600,
      totalStops: stops,
      baggageScore: 0,
      purchasePathScore: 0,
    },
    tags: [],
    warnings: [],
  };
}

function ids(offers: CanonicalOffer[]): string[] {
  return offers.map((offer) => offer.id);
}

test("sorting by departure reads the first leg and not the return", () => {
  /* The trap this case covers: `late-out` returns before anybody else. An
     order that looked at the return would put it first, and it is the one that
     leaves last. */
  const offers = [
    buildOffer({ id: "late-out", amount: 400, outboundDepartureAt: "2026-06-08T22:00:00Z", inboundDepartureAt: "2026-06-20T05:00:00Z" }),
    buildOffer({ id: "early-out", amount: 900, outboundDepartureAt: "2026-06-08T06:00:00Z", inboundDepartureAt: "2026-06-20T23:00:00Z" }),
    buildOffer({ id: "mid-out", amount: 600, outboundDepartureAt: "2026-06-08T13:30:00Z", inboundDepartureAt: "2026-06-20T11:00:00Z" }),
  ];

  assert.deepEqual(ids(sortOffers(offers, "departure")), ["early-out", "mid-out", "late-out"]);
});

test("sorting by departure compares the whole instant, not the time of day", () => {
  /* In a flexible search the offers fall on different days: 07:00 on the 9th
     comes after 22:00 on the 8th. */
  const offers = [
    buildOffer({ id: "next-day-morning", amount: 400, outboundDepartureAt: "2026-06-09T07:00:00Z" }),
    buildOffer({ id: "same-day-night", amount: 400, outboundDepartureAt: "2026-06-08T22:00:00Z" }),
  ];

  assert.deepEqual(ids(sortOffers(offers, "departure")), ["same-day-night", "next-day-morning"]);
});

test("departure ties break by price and stay deterministic", () => {
  const offers = [
    buildOffer({ id: "b-expensive", amount: 900, outboundDepartureAt: "2026-06-08T07:00:00Z" }),
    buildOffer({ id: "a-cheap", amount: 500, outboundDepartureAt: "2026-06-08T07:00:00Z" }),
    buildOffer({ id: "c-mid", amount: 700, outboundDepartureAt: "2026-06-08T07:00:00Z" }),
  ];

  assert.deepEqual(ids(sortOffers(offers, "departure")), ["a-cheap", "c-mid", "b-expensive"]);
});

test("an unreadable departure sinks instead of leading the list", () => {
  const offers = [
    buildOffer({ id: "broken-late", amount: 900, outboundDepartureAt: "" }),
    buildOffer({ id: "broken-cheap", amount: 100, outboundDepartureAt: "not-a-date" }),
    buildOffer({ id: "real", amount: 800, outboundDepartureAt: "2026-06-08T20:00:00Z" }),
  ];

  /* The two unreadable ones tie at +Infinity and price breaks it; neither
     slips ahead of the flight that does have a time. */
  assert.deepEqual(ids(sortOffers(offers, "departure")), ["real", "broken-cheap", "broken-late"]);
});

test("sorting by stops breaks the tie by price rather than by provider order", () => {
  /* Half of an ordinary route is direct: with no tie-break the block of
     direct flights would come out in the order the providers answered in,
     which changes between runs of the same search. */
  const offers = [
    buildOffer({ id: "direct-expensive", amount: 950, outboundDepartureAt: "2026-06-08T09:00:00Z", stops: 0 }),
    buildOffer({ id: "two-stops-cheapest", amount: 300, outboundDepartureAt: "2026-06-08T08:00:00Z", stops: 2 }),
    buildOffer({ id: "direct-cheap", amount: 700, outboundDepartureAt: "2026-06-08T20:00:00Z", stops: 0 }),
    buildOffer({ id: "one-stop", amount: 500, outboundDepartureAt: "2026-06-08T07:00:00Z", stops: 1 }),
  ];

  assert.deepEqual(
    ids(sortOffers(offers, "stops")),
    ["direct-cheap", "direct-expensive", "one-stop", "two-stops-cheapest"],
  );
});

test("stops counts every itinerary of a round trip", () => {
  const offers = [
    buildOffer({ id: "direct-out-one-stop-back", amount: 400, outboundDepartureAt: "2026-06-08T09:00:00Z", stops: 1, inboundDepartureAt: "2026-06-20T09:00:00Z" }),
    buildOffer({ id: "direct-both-ways", amount: 900, outboundDepartureAt: "2026-06-08T09:00:00Z", stops: 0, inboundDepartureAt: "2026-06-20T09:00:00Z" }),
  ];

  assert.deepEqual(ids(sortOffers(offers, "stops")), ["direct-both-ways", "direct-out-one-stop-back"]);
});

test("both new orders give the same list twice over a reshuffled input", () => {
  /* Determinism, which is what `sort`'s stability alone does not give: the
     input is the order two providers answered in, in parallel. */
  const offers = [
    buildOffer({ id: "alpha", amount: 500, outboundDepartureAt: "2026-06-08T09:00:00Z", stops: 1 }),
    buildOffer({ id: "bravo", amount: 500, outboundDepartureAt: "2026-06-08T09:00:00Z", stops: 1 }),
    buildOffer({ id: "charlie", amount: 500, outboundDepartureAt: "2026-06-08T09:00:00Z", stops: 1 }),
  ];
  const reversed = [...offers].reverse();

  for (const mode of ["departure", "stops"] as const) {
    assert.deepEqual(ids(sortOffers(offers, mode)), ids(sortOffers(reversed, mode)));
  }
});

test("sorting never mutates the list it was handed", () => {
  const offers = [
    buildOffer({ id: "second", amount: 900, outboundDepartureAt: "2026-06-08T20:00:00Z" }),
    buildOffer({ id: "first", amount: 100, outboundDepartureAt: "2026-06-08T06:00:00Z" }),
  ];

  sortOffers(offers, "departure");
  sortOffers(offers, "stops");
  assert.deepEqual(ids(offers), ["second", "first"]);
});
