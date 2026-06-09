import { test } from "bun:test"
import assert from "node:assert/strict"
import { fromBackendRequest, toBackendPayload } from "../frontend/src/lib/api"
import { readSharedSearchFromUrl, writeSharedSearchToUrl } from "../frontend/src/lib/search-share"
import type { SearchRequest } from "../frontend/src/types"

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

test("writeSharedSearchToUrl emits migration mode and month range params", () => {
  const globalWindow = globalThis as typeof globalThis & {
    window?: {
      history: {
        replaceState: (_state: unknown, _title: string, url: string) => void
      }
      location: {
        href: string
      }
    }
  }
  const originalWindow = globalWindow.window
  const writtenUrls: string[] = []
  globalWindow.window = {
    location: {
      href: "http://localhost/",
    },
    history: {
      replaceState: (_state: unknown, _title: string, url: string) => {
        writtenUrls.push(url)
      },
    },
  }

  try {
    const wrote = writeSharedSearchToUrl(request({
      tripType: "one-way",
      searchMode: "month-view",
      departureDate: undefined,
      returnDate: undefined,
      departureStart: "2026-06-01",
      departureEnd: "2026-06-30",
      migrationMonths: ["2026-06", "2026-07"],
    }), "cheapest")

    assert.equal(wrote, true)
    assert.equal(writtenUrls.length, 1)

    const updatedUrl = new URL(`http://localhost${writtenUrls[0] ?? ""}`)
    assert.equal(updatedUrl.searchParams.get("mode"), "migration")
    assert.equal(updatedUrl.searchParams.get("trip"), "one-way")
    assert.equal(updatedUrl.searchParams.get("departureStart"), "2026-06-01")
    assert.equal(updatedUrl.searchParams.get("departureEnd"), "2026-06-30")
    assert.equal(updatedUrl.searchParams.get("months"), "2026-06,2026-07")
  } finally {
    globalWindow.window = originalWindow
  }
})
