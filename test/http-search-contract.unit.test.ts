import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  prepareSearchContract,
  resolveSortMode,
  validateSearchContract,
  type SearchPayload,
} from "../src/http-search-contract";
import { SORT_MODES } from "../src/core/types";
import {
  MAX_LAP_INFANTS_PER_ADULT,
  MAX_SEARCH_PASSENGERS,
} from "../src/core/search-limits";

function validationErrors(request: NonNullable<SearchPayload["request"]>): string[] {
  return validateSearchContract(prepareSearchContract({ request }), undefined);
}

function baseRequest(): NonNullable<SearchPayload["request"]> {
  return {
    tripType: "round-trip",
    searchMode: "exact",
    legs: [{
      origin: "LIM",
      destination: "MIA",
      departureDate: "2026-06-01",
      returnDate: "2026-06-08",
    }],
    passengers: { adults: 1, children: 0, infants: 0 },
  };
}

test("search contract accepts only exact three-letter IATA codes", () => {
  const errors = validationErrors({
    ...baseRequest(),
    legs: [{
      ...baseRequest().legs![0],
      origin: "LIMA",
      destination: "MIA-extra",
    }],
  });

  assert.ok(errors.some((message) => message.includes("Origin")));
  assert.ok(errors.some((message) => message.includes("Destination")));
});

test("legacy night ranges reject stays longer than 90 nights", () => {
  const errors = validationErrors({
    ...baseRequest(),
    searchMode: "roundtrip-grid",
    legs: [{
      origin: "LIM",
      destination: "MIA",
      departureStart: "2026-06-01",
      departureEnd: "2026-06-10",
      returnStart: "2026-06-02",
      returnEnd: "2026-10-01",
      minNights: 1,
      maxNights: 91,
    }],
  });

  assert.ok(errors.some((message) => message.includes("Stay length cannot exceed 90 nights.")));
});

test("passenger validation uses the canonical total and lap-infant limits", () => {
  const tooManyPassengers = validationErrors({
    ...baseRequest(),
    passengers: { adults: MAX_SEARCH_PASSENGERS, children: 1, infants: 0 },
  });
  const tooManyLapInfants = validationErrors({
    ...baseRequest(),
    passengers: {
      adults: 2,
      children: 0,
      infants: (2 * MAX_LAP_INFANTS_PER_ADULT) + 1,
    },
  });

  assert.ok(tooManyPassengers.some((message) => message.includes(`cannot exceed ${MAX_SEARCH_PASSENGERS}`)));
  assert.ok(tooManyLapInfants.some((message) => message.includes("Lap infants cannot exceed")));
});

test("round-trip stay-range rejects excessive stay length and fan-out", () => {
  const excessiveStay = validationErrors({
    ...baseRequest(),
    searchMode: "stay-range",
    legs: [{
      origin: "LIM",
      destination: "MIA",
      departureStart: "2026-06-01",
      departureEnd: "2026-06-30",
      returnStart: "2026-06-02",
      returnEnd: "2026-10-15",
      minNights: 1,
      maxNights: 91,
    }],
  });
  const excessiveFanOut = validationErrors({
    ...baseRequest(),
    searchMode: "stay-range",
    legs: [{
      origin: "LIM",
      destination: "MIA",
      departureStart: "2026-06-01",
      departureEnd: "2027-02-28",
      returnStart: "2026-06-02",
      returnEnd: "2027-03-31",
      minNights: 1,
      maxNights: 90,
    }],
  });

  assert.ok(excessiveStay.some((message) => message.includes("Stay length cannot exceed 90 nights.")));
  assert.ok(excessiveFanOut.some((message) => message.includes("cannot exceed 5000 combinations")));
});

test("the sort catalogue is what the request is validated against", () => {
  /* The order criterion travels in the request and the backend applies it,
     so what this resolver accepts IS the contract: if the catalogue and this
     door drift apart, the frontend offers an order the server cannot serve. */
  for (const mode of SORT_MODES) {
    assert.equal(resolveSortMode(mode), mode);
  }

  assert.deepEqual([...SORT_MODES], ["cheapest", "fastest", "departure", "stops"]);
});

test("an unknown sort mode falls back to price instead of failing the search", () => {
  /* An older client, or a link shared before the two new orders existed,
     still gets its list. */
  for (const mode of ["unsupported", "", null, undefined, 7, { mode: "stops" }, ["stops"]]) {
    assert.equal(resolveSortMode(mode), "cheapest");
  }
});
