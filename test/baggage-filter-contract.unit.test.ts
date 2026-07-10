import { test } from "bun:test"
import assert from "node:assert/strict"
import { fromBackendRequest, toBackendPayload } from "../frontend/src/lib/api"
import {
  clearSharedSearchFromUrl,
  decodeSharedSearchPayload,
  readSharedSearchFromText,
  readSharedSearchFromUrl,
  serializeSharedSearchPayload,
  writeSharedSearchToClipboard,
  writeSharedSearchToUrl,
} from "../frontend/src/lib/search-share"
import type { SearchRequest } from "../frontend/src/types"
import { prepareSearchContract } from "../src/http-search-contract"
import { normalizeQuotationRequestSnapshot } from "../src/http-quotation-snapshot"

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

test("frontend contracts omit legacy result-cap fields", () => {
  const legacyRequest = {
    ...request(),
    maxResults: 25,
    compactAllOffers: true,
  } as SearchRequest & {
    maxResults: number
    compactAllOffers: boolean
  }
  const payload = toBackendPayload(legacyRequest, "cheapest")
  const restored = fromBackendRequest({
    ...payload.request,
    filters: {
      ...payload.request.filters,
      maxResults: 25,
      compactAllOffers: true,
    },
  })

  assert.equal(Object.hasOwn(payload.request.filters ?? {}, "maxResults"), false)
  assert.equal(Object.hasOwn(payload.request.filters ?? {}, "compactAllOffers"), false)
  assert.equal(Object.hasOwn(restored, "maxResults"), false)
  assert.equal(Object.hasOwn(restored, "compactAllOffers"), false)
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

test("shared search ignores legacy result-cap fields", () => {
  const fromUrl = readSharedSearchFromUrl(new URL(
    "http://localhost/?origin=LIM&destination=MIA&departure=2026-06-15&return=2026-06-22&maxResults=25&compact=1",
  ))
  const serialized = serializeSharedSearchPayload({
    ...request(),
    maxResults: 25,
    compactAllOffers: true,
  } as SearchRequest & {
    maxResults: number
    compactAllOffers: boolean
  }, "cheapest")
  const fromText = readSharedSearchFromText(serialized)

  assert.equal(Object.hasOwn(fromUrl?.request ?? {}, "maxResults"), false)
  assert.equal(Object.hasOwn(fromUrl?.request ?? {}, "compactAllOffers"), false)
  assert.equal(serialized.includes("maxResults"), false)
  assert.equal(serialized.includes("compactAllOffers"), false)
  assert.equal(Object.hasOwn(fromText?.request ?? {}, "maxResults"), false)
  assert.equal(Object.hasOwn(fromText?.request ?? {}, "compactAllOffers"), false)
})

test("quotation snapshots omit legacy result-cap fields", () => {
  const snapshot = normalizeQuotationRequestSnapshot({
    tripType: "round-trip",
    searchMode: "exact",
    legs: [{
      origin: "LIM",
      destination: "MIA",
      departureDate: "2026-06-15",
      returnDate: "2026-06-22",
    }],
    filters: {
      maxResults: 25,
      compactAllOffers: true,
      exhaustiveResults: true,
    },
  })

  assert.equal(Object.hasOwn(snapshot?.filters ?? {}, "maxResults"), false)
  assert.equal(Object.hasOwn(snapshot?.filters ?? {}, "compactAllOffers"), false)
  assert.equal(Object.hasOwn(snapshot?.filters ?? {}, "exhaustiveResults"), false)
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

test("shared search payload round-trips through text and base64url formats", () => {
  const searchRequest = request()
  const serialized = serializeSharedSearchPayload(searchRequest, "fastest")
  const encoded = Buffer.from(serialized).toString("base64url")
  const fromText = readSharedSearchFromText(serialized)

  assert.equal(fromText?.request.origin, searchRequest.origin)
  assert.equal(fromText?.request.destination, searchRequest.destination)
  assert.equal(fromText?.request.departureDate, searchRequest.departureDate)
  assert.equal(fromText?.request.returnDate, searchRequest.returnDate)
  assert.equal(fromText?.sortMode, "fastest")
  assert.deepEqual(decodeSharedSearchPayload(encoded), fromText)
  assert.equal(decodeSharedSearchPayload("not-json"), null)
})

test("shared search URL cleanup removes only Fly Desk search parameters", () => {
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
  let replacedUrl = ""
  globalWindow.window = {
    location: {
      href: "https://fly-desk.test/?origin=LIM&destination=MIA&keep=1#results",
    },
    history: {
      replaceState: (_state: unknown, _title: string, url: string) => {
        replacedUrl = url
      },
    },
  }

  try {
    assert.equal(clearSharedSearchFromUrl(), true)
    assert.equal(replacedUrl, "/?keep=1#results")
  } finally {
    globalWindow.window = originalWindow
  }
})

test("clipboard sharing reports unavailable browser support", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {},
  })

  try {
    assert.equal(await writeSharedSearchToClipboard(request(), "cheapest"), false)
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "navigator", descriptor)
    } else {
      delete (globalThis as { navigator?: unknown }).navigator
    }
  }
})
