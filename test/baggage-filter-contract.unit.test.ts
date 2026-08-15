import { test } from "bun:test"
import assert from "node:assert/strict"
import { fromBackendRequest, toBackendPayload } from "../frontend/src/lib/api"
import { readSharedSearchFromUrl } from "../frontend/src/lib/search-share"
import type { SearchRequest } from "../frontend/src/types"
import { prepareSearchContract } from "../src/http-search-contract"

/*
 * Carry-on and checked baggage as two independent facts, across every boundary
 * that has to keep them apart: the backend payload, the legacy single
 * `baggageRequired` flag, and the query params of a shared search.
 *
 * The rest of the sharing contract lives in `search-share.unit.test.ts`; it was
 * written here only because the first shared-URL case happened to be a baggage
 * one.
 */

function request(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    origin: "LIM",
    destination: "MIA",
    departureDate: "2026-06-15",
    returnDate: "2026-06-22",
    tripType: "round-trip",
    adults: 1,
    children: 0,
    infants: 0,
    searchMode: "exact",
    ...overrides,
  }
}

test("toBackendPayload sends carry-on and checked baggage filters independently", () => {
  const payload = toBackendPayload(request({
    carryOnRequired: true,
    checkedBaggageRequired: true,
  }), "cheapest")

  assert.equal(payload.request.filters?.carryOnRequired, true)
  assert.equal(payload.request.filters?.checkedBaggageRequired, true)
  assert.equal(payload.request.filters?.baggageRequired, true)
})

test("quotation location metadata survives the frontend/backend request boundary", () => {
  const payload = toBackendPayload(request({
    originLabel: "LIM - Lima, Perú",
    destinationLabel: "MAD - Madrid, España",
    originCountryCode: "pe",
    destinationCountryCode: "ES",
  }), "cheapest")
  const prepared = prepareSearchContract(payload)
  const restored = fromBackendRequest(prepared.request)

  assert.equal(restored.originLabel, "LIM - Lima, Perú")
  assert.equal(restored.destinationLabel, "MAD - Madrid, España")
  assert.equal(restored.originCountryCode, "PE")
  assert.equal(restored.destinationCountryCode, "ES")

  payload.request.legs[0]!.destinationCountryCode = "ESP"
  const invalid = prepareSearchContract(payload)
  assert.equal(invalid.request.legs[0]?.destinationCountryCode, undefined)
})

test("fromBackendRequest maps legacy baggageRequired to checked baggage", () => {
  const normalized = fromBackendRequest({
    tripType: "round-trip",
    searchMode: "exact",
    legs: [{ origin: "LIM", destination: "MIA", departureDate: "2026-06-15" }],
    passengers: { adults: 1, children: 0, infants: 0 },
    filters: {
      baggageRequired: true,
    },
  })

  assert.equal(normalized.carryOnRequired, undefined)
  assert.equal(normalized.checkedBaggageRequired, true)
})

test("readSharedSearchFromUrl separates carry-on and checked baggage query params", () => {
  const state = readSharedSearchFromUrl(new URL(
    "http://localhost/?origin=LIM&destination=MIA&departure=2026-06-15&return=2026-06-22&carryOn=1&checkedBaggage=1",
  ))

  assert.equal(state?.request.carryOnRequired, true)
  assert.equal(state?.request.checkedBaggageRequired, true)
})

test("readSharedSearchFromUrl treats legacy baggage query param as checked baggage", () => {
  const state = readSharedSearchFromUrl(new URL(
    "http://localhost/?origin=LIM&destination=MIA&departure=2026-06-15&return=2026-06-22&baggage=1",
  ))

  assert.equal(state?.request.carryOnRequired, false)
  assert.equal(state?.request.checkedBaggageRequired, true)
})
