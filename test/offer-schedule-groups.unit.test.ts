import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildOfferScheduleGroups } from "../src/core/offer-schedule-groups";
import type {
  CanonicalOffer,
  Itinerary,
  OfferScheduleGroup,
  ProviderId,
} from "../src/core/types";

function buildItinerary(direction: "outbound" | "inbound", optionKey: string): Itinerary {
  const variant = Number(optionKey.replace(/\D/g, "")) || 1;
  const outbound = direction === "outbound";
  const day = outbound ? "10" : "20";
  const departureHour = String(8 + variant).padStart(2, "0");
  const arrivalHour = String(16 + variant).padStart(2, "0");
  const origin = outbound ? "LIM" : "MIA";
  const destination = outbound ? "MIA" : "LIM";

  return {
    id: `${direction}-${optionKey}`,
    direction,
    durationMinutes: 480 + variant,
    stops: 0,
    layoverMinutes: [],
    segments: [{
      id: `${direction}-${optionKey}-segment`,
      marketingCarrier: "LA",
      flightNumber: `LA ${outbound ? 100 : 200}${variant}`,
      origin,
      destination,
      departureAt: `2026-04-${day}T${departureHour}:00:00Z`,
      arrivalAt: `2026-04-${day}T${arrivalHour}:00:00Z`,
      durationMinutes: 480 + variant,
    }],
  };
}

function buildRoundTripOffer(options: {
  id: string;
  providerSource: ProviderId;
  outbound: string;
  inbound: string;
  rawRefs?: Record<string, unknown>;
}): CanonicalOffer {
  return {
    id: options.id,
    signature: `signature-${options.id}`,
    providerSource: options.providerSource,
    providerOfferRef: `provider-${options.id}`,
    tripType: "round-trip",
    mainCarrier: "LA",
    validatingCarrier: "LA",
    origin: "LIM",
    destination: "MIA",
    itineraries: [
      buildItinerary("outbound", options.outbound),
      buildItinerary("inbound", options.inbound),
    ],
    price: {
      total: { amount: 500, currencyCode: "USD" },
    },
    baggage: {
      carryOnIncluded: true,
      checkedIncluded: true,
      checkedBags: 1,
    },
    priceConfidence: "live",
    priceStatus: "unverified",
    purchasePaths: [],
    comparisonMetrics: {
      totalDurationMinutes: 960,
      totalStops: 0,
      baggageScore: 2,
      purchasePathScore: 0,
    },
    tags: [],
    warnings: [],
    rawRefs: options.rawRefs,
  };
}

function resolvedCombinations(group: OfferScheduleGroup): string[] {
  const outbound = new Map(group.outboundOptions.map((option) => [option.id, option.itinerary.id]));
  const inbound = new Map((group.inboundOptions ?? []).map((option) => [option.id, option.itinerary.id]));

  return group.combinations.map((combination) => [
    outbound.get(combination.outboundOptionId),
    combination.inboundOptionId ? inbound.get(combination.inboundOptionId) : "one-way",
    combination.offerId,
  ].join("/")).sort();
}

function assertReferencesExistingEntities(group: OfferScheduleGroup, offers: CanonicalOffer[]): void {
  const offerIds = new Set(offers.map((offer) => offer.id));
  const outboundOptionIds = new Set(group.outboundOptions.map((option) => option.id));
  const inboundOptionIds = new Set((group.inboundOptions ?? []).map((option) => option.id));

  for (const combination of group.combinations) {
    assert.equal(offerIds.has(combination.offerId), true);
    assert.equal(outboundOptionIds.has(combination.outboundOptionId), true);
    if (combination.inboundOptionId) {
      assert.equal(inboundOptionIds.has(combination.inboundOptionId), true);
    }
  }
}

test("Agil 2x2 variants become four exact offer-backed combinations", () => {
  const offers = [
    ["o1", "i1"],
    ["o1", "i2"],
    ["o2", "i1"],
    ["o2", "i2"],
  ].map(([outbound, inbound]) => buildRoundTripOffer({
    id: `agil-${outbound}-${inbound}`,
    providerSource: "agil-local",
    outbound,
    inbound,
    rawRefs: {
      agilGroupId: "agil-group-7",
      outboundKey: outbound,
      inboundKey: inbound,
    },
  }));

  const groups = buildOfferScheduleGroups(offers);

  assert.equal(groups.length, 1);
  const group = groups[0]!;
  assert.equal(group.providerSource, "agil-local");
  assert.equal(group.outboundOptions.length, 2);
  assert.equal(group.inboundOptions?.length, 2);
  assert.equal(group.truncated, false);
  assert.deepEqual(resolvedCombinations(group), [
    "outbound-o1/inbound-i1/agil-o1-i1",
    "outbound-o1/inbound-i2/agil-o1-i2",
    "outbound-o2/inbound-i1/agil-o2-i1",
    "outbound-o2/inbound-i2/agil-o2-i2",
  ]);
  assertReferencesExistingEntities(group, offers);
});

test("Costamar recommendation variants derive option identity from their itineraries", () => {
  const offers = [
    ["o1", "i1"],
    ["o1", "i2"],
    ["o2", "i1"],
    ["o2", "i2"],
  ].map(([outbound, inbound], index) => buildRoundTripOffer({
    id: `costamar-${outbound}-${inbound}`,
    providerSource: "costamar",
    outbound,
    inbound,
    rawRefs: {
      recommendationId: `cbplus-42:${Math.floor(index / 2)}-${index % 2}`,
    },
  }));

  const groups = buildOfferScheduleGroups(offers);

  assert.equal(groups.length, 1);
  const group = groups[0]!;
  assert.equal(group.providerSource, "costamar");
  assert.equal(group.outboundOptions.length, 2);
  assert.equal(group.inboundOptions?.length, 2);
  assert.deepEqual(resolvedCombinations(group), [
    "outbound-o1/inbound-i1/costamar-o1-i1",
    "outbound-o1/inbound-i2/costamar-o1-i2",
    "outbound-o2/inbound-i1/costamar-o2-i1",
    "outbound-o2/inbound-i2/costamar-o2-i2",
  ]);
  assertReferencesExistingEntities(group, offers);
});

test("an incomplete provider set exposes only returned combinations and never fills the grid", () => {
  const offers = [
    ["o1", "i1"],
    ["o1", "i2"],
    ["o2", "i1"],
  ].map(([outbound, inbound]) => buildRoundTripOffer({
    id: `agil-${outbound}-${inbound}`,
    providerSource: "agil-local",
    outbound,
    inbound,
    rawRefs: {
      agilGroupId: "agil-group-incomplete",
      outboundKey: outbound,
      inboundKey: inbound,
    },
  }));

  const group = buildOfferScheduleGroups(offers)[0]!;
  const combinations = resolvedCombinations(group);

  assert.equal(group.outboundOptions.length, 2);
  assert.equal(group.inboundOptions?.length, 2);
  assert.equal(group.combinations.length, 3);
  assert.equal(combinations.some((entry) => entry.startsWith("outbound-o2/inbound-i2/")), false);
  assertReferencesExistingEntities(group, offers);
});

test("missing option keys fall back to itinerary identity while missing native group IDs stay ungrouped", () => {
  const fallbackOffers = ["o1", "o2"].map((outbound) => buildRoundTripOffer({
    id: `agil-fallback-${outbound}`,
    providerSource: "agil-local",
    outbound,
    inbound: "i1",
    rawRefs: { agilGroupId: "agil-fallback-group" },
  }));
  const unscopedOffers = ["o1", "o2"].map((outbound) => buildRoundTripOffer({
    id: `unscoped-${outbound}`,
    providerSource: "agil-local",
    outbound,
    inbound: "i1",
  }));

  const fallbackGroups = buildOfferScheduleGroups(fallbackOffers);

  assert.equal(fallbackGroups.length, 1);
  assert.equal(fallbackGroups[0]?.combinations.length, 2);
  assertReferencesExistingEntities(fallbackGroups[0]!, fallbackOffers);
  assert.deepEqual(buildOfferScheduleGroups(unscopedOffers), []);
});

test("reused native IDs stay isolated by provider response scope", () => {
  const offers = [
    ...["o1", "o2"].map((outbound) => buildRoundTripOffer({
      id: `agil-gds-0-${outbound}`,
      providerSource: "agil-local",
      outbound,
      inbound: "i1",
      rawRefs: {
        agilGroupId: "reused-group-id",
        outboundKey: outbound,
        inboundKey: "i1",
        scheduleGroupScope: "agil:gds=0:2026-04-11:2026-04-21",
      },
    })),
    ...["o1", "o2"].map((outbound) => buildRoundTripOffer({
      id: `agil-gds-1-${outbound}`,
      providerSource: "agil-local",
      outbound,
      inbound: "i1",
      rawRefs: {
        agilGroupId: "reused-group-id",
        outboundKey: outbound,
        inboundKey: "i1",
        scheduleGroupScope: "agil:gds=1:2026-04-11:2026-04-21",
      },
    })),
  ];

  const groups = buildOfferScheduleGroups(offers);

  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((group) => group.combinations.map((combination) => combination.offerId).sort()).sort(),
    [
      ["agil-gds-0-o1", "agil-gds-0-o2"],
      ["agil-gds-1-o1", "agil-gds-1-o2"],
    ],
  );
});

test("reaching the provider cap alone does not claim truncation without explicit evidence", () => {
  const offers = Array.from({ length: 5 }, (_, outboundIndex) =>
    Array.from({ length: 10 }, (_, inboundIndex) => buildRoundTripOffer({
      id: `costamar-o${outboundIndex + 1}-i${inboundIndex + 1}`,
      providerSource: "costamar",
      outbound: `o${outboundIndex + 1}`,
      inbound: `i${inboundIndex + 1}`,
      rawRefs: {
        recommendationId: `cbplus-cap:${outboundIndex}-${inboundIndex}`,
      },
    }))).flat();

  const group = buildOfferScheduleGroups(offers)[0]!;

  assert.equal(group.combinations.length, 50);
  assert.equal(group.truncated, false);
  assertReferencesExistingEntities(group, offers);
});

test("explicit provider evidence marks a capped schedule group as truncated", () => {
  const offers = Array.from({ length: 5 }, (_, outboundIndex) =>
    Array.from({ length: 10 }, (_, inboundIndex) => buildRoundTripOffer({
      id: `costamar-truncated-o${outboundIndex + 1}-i${inboundIndex + 1}`,
      providerSource: "costamar",
      outbound: `o${outboundIndex + 1}`,
      inbound: `i${inboundIndex + 1}`,
      rawRefs: {
        recommendationId: `cbplus-truncated:${outboundIndex}-${inboundIndex}`,
        scheduleGroupScope: "costamar:2026-04-11:2026-04-21",
        scheduleVariantsTruncated: true,
      },
    }))).flat();

  const group = buildOfferScheduleGroups(offers)[0]!;

  assert.equal(group.combinations.length, 50);
  assert.equal(group.truncated, true);
  assertReferencesExistingEntities(group, offers);
});
