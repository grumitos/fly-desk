import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderMeta, SearchRequest } from "../src/core/types";
import {
  enumerateUsefulRoundTripPairs,
  normalizeFlexibleRoundTripRequest,
  resolveFlexibleRoundTripMode,
} from "../src/core/flexible-search";
import { createLocalAgilMatrixDraft } from "../src/local-agil";
import { createLocalCostamarMatrixDraft } from "../src/local-costamar";

const agilProviderMeta: ProviderMeta = {
  exactProvider: "agil-local",
  coverageMode: "core",
};

const costamarProviderMeta: ProviderMeta = {
  exactProvider: "costamar",
  coverageMode: "core",
};

function buildBaseRequest(): SearchRequest {
  return {
    tripType: "round-trip",
    searchMode: "roundtrip-grid",
    legs: [
      {
        origin: "LIM",
        destination: "MAD",
        departureStart: "2026-05-01",
        departureEnd: "2026-05-31",
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

test("exact-stay keeps only round-trip pairs whose return remains inside the active window", () => {
  const request = normalizeFlexibleRoundTripRequest({
    ...buildBaseRequest(),
    flexibleMode: "exact-stay",
    legs: [
      {
        ...buildBaseRequest().legs[0],
        departureStart: "2026-05-01",
        departureEnd: "2026-05-31",
        returnStart: "2026-05-01",
        returnEnd: "2026-05-31",
        stayNights: 10,
      },
    ],
  });

  const pairs = enumerateUsefulRoundTripPairs(request);

  assert.equal(resolveFlexibleRoundTripMode(request), "exact-stay");
  assert.equal(pairs.length, 21);
  assert.deepEqual(pairs[0], {
    departureDate: "2026-05-01",
    returnDate: "2026-05-11",
    stayNights: 10,
  });
  assert.deepEqual(pairs.at(-1), {
    departureDate: "2026-05-21",
    returnDate: "2026-05-31",
    stayNights: 10,
  });
  assert.equal(pairs.every((pair) => pair.returnDate <= "2026-05-31"), true);
  assert.equal(pairs.some((pair) => pair.returnDate.startsWith("2026-06")), false);
});

test("fixed-ranges enumerates every valid departure and return pair without an implicit 3-7 night filter", () => {
  const request = normalizeFlexibleRoundTripRequest({
    ...buildBaseRequest(),
    legs: [
      {
        ...buildBaseRequest().legs[0],
        departureStart: "2026-05-01",
        departureEnd: "2026-05-31",
        returnStart: "2026-07-01",
        returnEnd: "2026-07-31",
      },
    ],
  });

  const pairs = enumerateUsefulRoundTripPairs(request);

  assert.equal(resolveFlexibleRoundTripMode(request), "fixed-ranges");
  assert.equal(pairs.length, 31 * 31);
  assert.equal(
    pairs.some((pair) => pair.departureDate === "2026-05-31" && pair.returnDate === "2026-07-01"),
    true,
  );
  assert.equal(
    pairs.some((pair) => pair.departureDate === "2026-05-01" && pair.returnDate === "2026-07-31"),
    true,
  );
  assert.equal(pairs.some((pair) => pair.stayNights > 7), true);
});

test("minNights equal to maxNights stays compatible with exact-stay semantics", () => {
  const exactStayRequest = normalizeFlexibleRoundTripRequest({
    ...buildBaseRequest(),
    flexibleMode: "exact-stay",
    legs: [
      {
        ...buildBaseRequest().legs[0],
        departureStart: "2026-05-01",
        departureEnd: "2026-05-31",
        returnStart: "2026-05-01",
        returnEnd: "2026-05-31",
        stayNights: 10,
      },
    ],
  });

  const compatibleLegacyRequest = normalizeFlexibleRoundTripRequest({
    ...buildBaseRequest(),
    legs: [
      {
        ...buildBaseRequest().legs[0],
        departureStart: "2026-05-01",
        departureEnd: "2026-05-31",
        returnStart: "2026-05-01",
        returnEnd: "2026-05-31",
        minNights: 10,
        maxNights: 10,
      },
    ],
  });

  assert.equal(resolveFlexibleRoundTripMode(compatibleLegacyRequest), "exact-stay");
  assert.deepEqual(
    enumerateUsefulRoundTripPairs(compatibleLegacyRequest),
    enumerateUsefulRoundTripPairs(exactStayRequest),
  );
});

test("normalizeFlexibleRoundTripRequest derives exact-stay from stayNights and offsets the return window by the stay length", () => {
  const normalized = normalizeFlexibleRoundTripRequest({
    ...buildBaseRequest(),
    legs: [
      {
        ...buildBaseRequest().legs[0],
        departureStart: "2026-05-01",
        departureEnd: "2026-05-31",
        stayNights: 10,
      },
    ],
  });

  assert.equal(normalized.flexibleMode, "exact-stay");
  assert.equal(normalized.legs[0]?.stayNights, 10);
  assert.equal(normalized.legs[0]?.minNights, undefined);
  assert.equal(normalized.legs[0]?.maxNights, undefined);
  assert.equal(normalized.legs[0]?.returnStart, "2026-05-11");
  assert.equal(normalized.legs[0]?.returnEnd, "2026-06-10");
});

test("normalizeFlexibleRoundTripRequest derives exact-stay from legacy min/max equality", () => {
  const normalized = normalizeFlexibleRoundTripRequest({
    ...buildBaseRequest(),
    legs: [
      {
        ...buildBaseRequest().legs[0],
        departureStart: "2026-06-01",
        departureEnd: "2026-06-03",
        returnStart: "2026-06-08",
        returnEnd: "2026-06-10",
        minNights: 7,
        maxNights: 7,
      },
    ],
  });

  assert.equal(normalized.flexibleMode, "exact-stay");
  assert.equal(normalized.legs[0]?.stayNights, 7);
  assert.equal(normalized.legs[0]?.minNights, undefined);
  assert.equal(normalized.legs[0]?.maxNights, undefined);
});

test("normalizeFlexibleRoundTripRequest derives fixed-ranges from explicit departure and return windows", () => {
  const normalized = normalizeFlexibleRoundTripRequest({
    ...buildBaseRequest(),
    legs: [
      {
        ...buildBaseRequest().legs[0],
        departureStart: "2026-05-01",
        departureEnd: "2026-05-31",
        returnStart: "2026-07-01",
        returnEnd: "2026-07-31",
      },
    ],
  });

  assert.equal(normalized.flexibleMode, "fixed-ranges");
  assert.equal(normalized.legs[0]?.stayNights, undefined);
  assert.equal(normalized.legs[0]?.minNights, undefined);
  assert.equal(normalized.legs[0]?.maxNights, undefined);
  assert.equal(normalized.legs[0]?.returnStart, "2026-07-01");
  assert.equal(normalized.legs[0]?.returnEnd, "2026-07-31");
});

test("normalizeFlexibleRoundTripRequest preserves legacy night ranges when the payload still uses a real span", () => {
  const normalized = normalizeFlexibleRoundTripRequest({
    ...buildBaseRequest(),
    legs: [
      {
        ...buildBaseRequest().legs[0],
        departureStart: "2026-06-01",
        departureEnd: "2026-06-03",
        returnStart: "2026-06-04",
        returnEnd: "2026-06-10",
        minNights: 3,
        maxNights: 7,
      },
    ],
  });

  assert.equal(normalized.flexibleMode, undefined);
  assert.equal(normalized.legs[0]?.stayNights, undefined);
  assert.equal(normalized.legs[0]?.minNights, 3);
  assert.equal(normalized.legs[0]?.maxNights, 7);
});

test("Agil and Costamar drafts materialize the same exact-stay keys as the shared helper", () => {
  const request = normalizeFlexibleRoundTripRequest({
    ...buildBaseRequest(),
    flexibleMode: "exact-stay",
    legs: [
      {
        ...buildBaseRequest().legs[0],
        departureStart: "2026-05-01",
        departureEnd: "2026-05-15",
        returnStart: "2026-05-01",
        returnEnd: "2026-05-15",
        stayNights: 4,
      },
    ],
  });

  const expectedKeys = enumerateUsefulRoundTripPairs(request)
    .map((pair) => `${pair.departureDate}_${pair.returnDate}`)
    .sort();
  const agilDraft = createLocalAgilMatrixDraft(request, agilProviderMeta);
  const costamarDraft = createLocalCostamarMatrixDraft(request, costamarProviderMeta);
  const agilKeys = agilDraft.cells.map((cell) => cell.key).sort();
  const costamarKeys = costamarDraft.cells.map((cell) => cell.key).sort();

  assert.deepEqual(agilKeys, expectedKeys);
  assert.deepEqual(costamarKeys, expectedKeys);
  assert.equal(agilDraft.cells.some((cell) => cell.confidence === "empty"), false);
  assert.equal(costamarDraft.cells.some((cell) => cell.confidence === "empty"), false);
});
