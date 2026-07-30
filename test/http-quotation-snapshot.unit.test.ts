import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  normalizeQuotationOfferSnapshot,
} from "../src/http-quotation-snapshot";
import type { SearchRequest } from "../src/core/types";

const request: SearchRequest = {
  tripType: "one-way",
  searchMode: "exact",
  legs: [{ origin: "LIM", destination: "MIA", departureDate: "2026-08-10" }],
  passengers: { adults: 1, children: 0, infants: 0 },
  cabin: "ECONOMY",
  filters: {},
  coverageMode: "core",
  redirectMode: "best-effort",
  currencyCode: "USD",
  locale: "es-PE",
  market: "PE",
};

const itinerary = [{
  direction: "outbound",
  segments: [{
    origin: "LIM",
    destination: "MIA",
    departureAt: "2026-08-10T08:00:00-05:00",
    arrivalAt: "2026-08-10T14:00:00-04:00",
  }],
}];

test("quotation snapshot refuses to synthesize price, currency, or itinerary", () => {
  const base = {
    id: "offer-1",
    providerSource: "agil-local",
    price: { total: { amount: 500, currencyCode: "USD" } },
    itineraries: itinerary,
  };

  assert.equal(normalizeQuotationOfferSnapshot({ ...base, itineraries: undefined }, request), undefined);
  assert.equal(normalizeQuotationOfferSnapshot({ ...base, price: undefined }, request), undefined);
  assert.equal(normalizeQuotationOfferSnapshot({
    ...base,
    price: { total: { amount: 500, currencyCode: "" } },
  }, request), undefined);
  assert.equal(normalizeQuotationOfferSnapshot({
    ...base,
    price: { total: { amount: 0, currencyCode: "USD" } },
  }, request), undefined);
});

test("quotation snapshot keeps optional carrier and flight number unknown", () => {
  const normalized = normalizeQuotationOfferSnapshot({
    id: "offer-optional-flight-fields",
    providerSource: "costamar",
    tripType: "one-way",
    origin: "LIM",
    destination: "MIA",
    price: { total: { amount: 500, currencyCode: "USD" } },
    itineraries: itinerary,
  }, request);

  assert.ok(normalized);
  assert.equal(normalized.itineraries[0]?.segments[0]?.marketingCarrier, "");
  assert.equal(normalized.itineraries[0]?.segments[0]?.flightNumber, "");
});
