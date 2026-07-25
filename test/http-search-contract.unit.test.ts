import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  prepareSearchContract,
  validateSearchContract,
  type SearchPayload,
} from "../src/http-search-contract";

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
