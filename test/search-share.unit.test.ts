import { test } from "bun:test"
import assert from "node:assert/strict"
import {
  decodeSharedSearchPayload,
  readSharedSearchFromText,
  readSharedSearchFromUrl,
  searchUrlWasWrittenHere,
  serializeSharedSearchPayload,
  writeSharedSearchToClipboard,
  writeSharedSearchToUrl,
} from "../frontend/src/lib/search-share"
import { SORT_MODES, type SearchRequest, type SortMode } from "../frontend/src/types"

/*
 * The shareable search, both halves of it.
 *
 * `writeReadableSharedSearchParams` and `readReadableSharedSearchFromUrl` are
 * two separate transcriptions of the same query string, and nothing but a test
 * keeps them saying the same thing. The Playwright case in
 * `test/ui/sharing.playwright.ts` drives the whole gesture — copy the URL,
 * reopen it in a second tab, search again — but only for an exact round trip
 * with no filters at all, which is the one shape where the two halves cannot
 * disagree.
 *
 * These tests moved here from `baggage-filter-contract.unit.test.ts`, which had
 * become the home of everything about sharing that happened to have been
 * written next to a baggage case. The baggage query params stay there, because
 * that is what that file is about.
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

type TabStorageStub = Pick<Storage, "getItem" | "setItem">

type WindowStub = typeof globalThis & {
  window?: {
    history: { replaceState: (_state: unknown, _title: string, url: string) => void }
    location: { href: string }
    sessionStorage?: TabStorageStub
  }
}

/** Runs `writeSharedSearchToUrl` against a stub `window` and returns the URL it wrote. */
function urlWrittenFor(searchRequest: SearchRequest, sortMode: SortMode, href = "http://localhost/"): URL {
  const globalWindow = globalThis as WindowStub
  const originalWindow = globalWindow.window
  const writtenUrls: string[] = []
  globalWindow.window = {
    location: { href },
    history: {
      replaceState: (_state: unknown, _title: string, url: string) => {
        writtenUrls.push(url)
      },
    },
  }

  try {
    assert.equal(writeSharedSearchToUrl(searchRequest, sortMode), true)
    assert.equal(writtenUrls.length, 1)
    return new URL(`http://localhost${writtenUrls[0] ?? ""}`)
  } finally {
    globalWindow.window = originalWindow
  }
}

/** The half of the gesture the Playwright case performs: write the URL, then read it back. */
function roundTrip(searchRequest: SearchRequest, sortMode: SortMode) {
  const url = urlWrittenFor(searchRequest, sortMode)
  const state = readSharedSearchFromUrl(url)
  assert.ok(state, `The URL this request wrote did not read back at all: ${url.search}`)
  return { state, url }
}

test("an exact search survives the URL with its filters and its passenger counts", () => {
  const source = request({
    adults: 2,
    children: 1,
    infants: 1,
    maxStopsFilter: "1",
    maxLayoverMinutes: "300",
    carryOnRequired: true,
    checkedBaggageRequired: true,
    // Lower case on purpose: the codes are normalised on the way out, not in.
    includedAirlineCodes: ["la", "cm"],
  })
  const { state, url } = roundTrip(source, "fastest")

  assert.equal(url.searchParams.get("mode"), "exact")
  assert.equal(url.searchParams.get("airlines"), "LA,CM")
  assert.equal(state.sortMode, "fastest")
  assert.equal(state.request.searchMode, "exact")
  assert.equal(state.request.tripType, "round-trip")
  assert.equal(state.request.origin, "LIM")
  assert.equal(state.request.destination, "MIA")
  assert.equal(state.request.departureDate, "2026-06-15")
  assert.equal(state.request.returnDate, "2026-06-22")
  assert.deepEqual(
    [state.request.adults, state.request.children, state.request.infants],
    [2, 1, 1],
  )
  assert.equal(state.request.maxStopsFilter, "1")
  assert.equal(state.request.maxLayoverMinutes, "300")
  assert.equal(state.request.carryOnRequired, true)
  assert.equal(state.request.checkedBaggageRequired, true)
  assert.deepEqual(state.request.includedAirlineCodes, ["LA", "CM"])
  assert.equal(state.request.nonStop, false)
})

test("«sin escalas» is written as itself and takes the stops ceiling with it", () => {
  /* The two controls say the same thing and 0 is the stricter reading of it, so
     the ceiling is not written beside the flag and does not come back. A URL
     carrying both would let `maxStops=2` reopen a search the agent had pinned
     at direct flights. */
  const { state, url } = roundTrip(request({ nonStop: true, maxStopsFilter: "2" }), "cheapest")

  assert.equal(url.searchParams.get("nonStop"), "1")
  assert.equal(url.searchParams.has("maxStops"), false)
  assert.equal(state.request.nonStop, true)
  assert.equal(state.request.maxStopsFilter, undefined)
})

test("maxStops=0 reopens as «sin escalas» rather than as a ceiling of zero", () => {
  const state = readSharedSearchFromUrl(new URL(
    "http://localhost/?origin=LIM&destination=MIA&departure=2026-06-15&maxStops=0",
  ))

  assert.equal(state?.request.nonStop, true)
  assert.equal(state?.request.maxStopsFilter, undefined)
})

test("a flexible round trip survives the URL as roundtrip-grid with its stay", () => {
  const source = request({
    searchMode: "roundtrip-grid",
    flexibleMode: "exact-stay",
    departureDate: undefined,
    returnDate: undefined,
    departureStart: "2026-06-01",
    departureEnd: "2026-06-10",
    returnStart: "2026-06-08",
    returnEnd: "2026-06-18",
    stayNights: 7,
  })
  const { state, url } = roundTrip(source, "cheapest")

  // The query string names the mode the agent chose; the shape is derived from
  // it and the trip type on the way back in.
  assert.equal(url.searchParams.get("mode"), "flexible")
  assert.equal(url.searchParams.get("trip"), "round-trip")
  assert.equal(state.request.searchMode, "roundtrip-grid")
  assert.equal(state.request.flexibleMode, "exact-stay")
  assert.equal(state.request.departureStart, "2026-06-01")
  assert.equal(state.request.departureEnd, "2026-06-10")
  assert.equal(state.request.returnStart, "2026-06-08")
  assert.equal(state.request.returnEnd, "2026-06-18")
  assert.equal(state.request.stayNights, 7)
  assert.equal(state.request.departureDate, undefined)
})

test("a flexible one-way survives the URL as stay-range and keeps no grid mode", () => {
  /* `flexibleMode` belongs to the round-trip grid — the form only ever sets it
     there — so a one way reopens without one however the URL was written. */
  const source = request({
    tripType: "one-way",
    searchMode: "stay-range",
    flexibleMode: "exact-stay",
    departureDate: undefined,
    returnDate: undefined,
    departureStart: "2026-06-01",
    departureEnd: "2026-06-10",
    stayNights: 5,
  })
  const { state } = roundTrip(source, "cheapest")

  assert.equal(state.request.searchMode, "stay-range")
  assert.equal(state.request.tripType, "one-way")
  assert.equal(state.request.flexibleMode, undefined)
  assert.equal(state.request.stayNights, 5)
  assert.equal(state.request.returnDate, undefined)
})

test("a migratory sweep survives the URL with the months it was asked for", () => {
  const source = request({
    tripType: "one-way",
    searchMode: "month-view",
    departureDate: undefined,
    returnDate: undefined,
    departureStart: "2026-06-01",
    departureEnd: "2026-08-31",
    migrationMonths: ["2026-06", "2026-07", "2026-08"],
  })
  const { state, url } = roundTrip(source, "cheapest")

  assert.equal(url.searchParams.get("mode"), "migration")
  assert.equal(state.request.searchMode, "month-view")
  assert.deepEqual(state.request.migrationMonths, ["2026-06", "2026-07", "2026-08"])
})

test("the months only travel with the sweep that has them", () => {
  /* `months` is a Migratorio fact. Writing it beside an exact search would put
     a month list on a URL whose mode cannot act on it, and the next write of
     the same URL has to clear it. */
  const exact = urlWrittenFor(request({ migrationMonths: ["2026-06"] }), "cheapest")
  assert.equal(exact.searchParams.has("months"), false)

  const state = readSharedSearchFromUrl(new URL(
    "http://localhost/?origin=LIM&destination=MIA&departure=2026-06-15&months=2026-13,nope,2026-06&month=2026-07",
  ))
  // Only real months, and each of them once.
  assert.deepEqual(state?.request.migrationMonths, ["2026-07", "2026-06"])
})

test("writing a shared search replaces the parameters of the search already on the URL", () => {
  /* Every shared key is deleted before the new ones are set, so a second search
     cannot inherit the first one's filters. Anything that is not ours stays. */
  const globalWindow = globalThis as WindowStub
  const originalWindow = globalWindow.window
  let replacedUrl = ""
  globalWindow.window = {
    location: {
      href: "https://fly-desk.test/?origin=CUZ&destination=BOG&nonStop=1&airlines=LA&months=2026-06&keep=1#results",
    },
    history: {
      replaceState: (_state: unknown, _title: string, url: string) => {
        replacedUrl = url
      },
    },
  }

  try {
    assert.equal(writeSharedSearchToUrl(request(), "cheapest"), true)
  } finally {
    globalWindow.window = originalWindow
  }

  const url = new URL(`https://fly-desk.test${replacedUrl}`)
  assert.equal(url.searchParams.get("origin"), "LIM")
  assert.equal(url.searchParams.get("destination"), "MIA")
  assert.equal(url.searchParams.has("nonStop"), false)
  assert.equal(url.searchParams.has("airlines"), false)
  assert.equal(url.searchParams.has("months"), false)
  assert.equal(url.searchParams.get("keep"), "1")
  assert.equal(url.hash, "#results")
})

test("a URL without a route is not a shared search", () => {
  assert.equal(readSharedSearchFromUrl(new URL("http://localhost/?departure=2026-06-15")), null)
  assert.equal(readSharedSearchFromUrl(new URL("http://localhost/?origin=LIM")), null)
})

test("writeSharedSearchToUrl emits migration mode and month range params", () => {
  const updatedUrl = urlWrittenFor(request({
    tripType: "one-way",
    searchMode: "month-view",
    departureDate: undefined,
    returnDate: undefined,
    departureStart: "2026-06-01",
    departureEnd: "2026-06-30",
    migrationMonths: ["2026-06", "2026-07"],
  }), "cheapest")

  assert.equal(updatedUrl.searchParams.get("mode"), "migration")
  assert.equal(updatedUrl.searchParams.get("trip"), "one-way")
  assert.equal(updatedUrl.searchParams.get("departureStart"), "2026-06-01")
  assert.equal(updatedUrl.searchParams.get("departureEnd"), "2026-06-30")
  assert.equal(updatedUrl.searchParams.get("months"), "2026-06,2026-07")
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

test("a pasted payload from another build is refused rather than half-read", () => {
  /* The version is the whole compatibility story: a payload of the wrong shape
     under the right name would be read field by field into a search the agent
     never described. */
  const serialized = JSON.parse(serializeSharedSearchPayload(request(), "cheapest")) as Record<string, unknown>

  assert.equal(readSharedSearchFromText(JSON.stringify({ ...serialized, version: 1 })), null)
  assert.equal(readSharedSearchFromText(JSON.stringify({ ...serialized, type: "other-app" })), null)
  assert.equal(readSharedSearchFromText(JSON.stringify({ ...serialized, request: undefined, frontendRequest: undefined })), null)
  assert.equal(readSharedSearchFromText("   "), null)
  assert.ok(readSharedSearchFromText(JSON.stringify(serialized)))
})

test("shared search payload never serializes the browser client session", () => {
  const clientSessionId = "browser-session-share-a"
  const searchRequest = {
    ...request(),
    clientSessionId,
  } as ReturnType<typeof request> & { clientSessionId: string }

  const serialized = serializeSharedSearchPayload(searchRequest, "cheapest")

  assert.doesNotMatch(serialized, new RegExp(clientSessionId))
  assert.equal(Object.hasOwn(JSON.parse(serialized) as object, "clientSessionId"), false)
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

/*
 * Which URL is a link, and which one is this tab's own address bar.
 *
 * `App` refuses to launch a shared search when the query on screen is the one
 * this tab wrote for itself, so what this memory answers is whether a reload
 * costs a provider search. Every way of not knowing — a tab that has not
 * searched, a tab whose storage is denied, a link edited by hand — has to
 * answer «not mine», which degrades to a filled form rather than to a surprise.
 */

/** A `window` whose address bar and tab storage the case can read back. */
function withStubbedTab<T>(
  href: string,
  sessionStorage: TabStorageStub | undefined,
  run: (tab: { href: string }) => T,
): T {
  const globalWindow = globalThis as WindowStub
  const originalWindow = globalWindow.window
  const location = { href }
  globalWindow.window = {
    location,
    history: {
      replaceState: (_state: unknown, _title: string, url: string) => {
        location.href = new URL(url, href).href
      },
    },
    sessionStorage,
  }

  try {
    return run(location)
  } finally {
    globalWindow.window = originalWindow
  }
}

function tabStorage() {
  const entries = new Map<string, string>()

  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value) },
  }
}

test("the query a search wrote is remembered as this tab's own", () => {
  const storage = tabStorage()
  let writtenSearch = ""

  withStubbedTab("http://localhost/", storage, (tab) => {
    assert.equal(writeSharedSearchToUrl(request(), "cheapest"), true)
    writtenSearch = new URL(tab.href).search
    assert.equal(searchUrlWasWrittenHere(new URL(tab.href)), true)
    // A different link pasted into the same tab is still a link.
    assert.equal(searchUrlWasWrittenHere(new URL("http://localhost/?origin=CUZ&destination=BOG")), false)
  })

  // The query itself, not merely the fact that something was written.
  assert.ok(writtenSearch.includes("origin=LIM"), writtenSearch)
  assert.deepEqual([...storage.entries.values()], [writtenSearch])
})

test("a tab that has not searched, or cannot remember, owns no URL", () => {
  const url = new URL("http://localhost/?mode=exact&origin=LIM&destination=MIA&departure=2026-06-15")

  withStubbedTab(url.href, tabStorage(), () => {
    assert.equal(searchUrlWasWrittenHere(url), false)
  })

  const denied: TabStorageStub = {
    getItem: () => { throw new Error("Storage is denied in this context.") },
    setItem: () => { throw new Error("Storage is denied in this context.") },
  }
  withStubbedTab(url.href, denied, (tab) => {
    /* The URL is what the share *is*, so writing it has to survive the refusal.
       Losing the memory only costs the reload a search it used to cost anyway. */
    assert.equal(writeSharedSearchToUrl(request(), "cheapest"), true)
    assert.equal(searchUrlWasWrittenHere(new URL(tab.href)), false)
  })

  withStubbedTab(url.href, undefined, (tab) => {
    assert.equal(writeSharedSearchToUrl(request(), "cheapest"), true)
    assert.equal(searchUrlWasWrittenHere(new URL(tab.href)), false)
  })
})

test("a shared link carries every order the backend knows how to serve", () => {
  /* The link carries its order in `?sort=`, and whoever opens it runs the
     search the link describes. If this list and the backend's drift apart, the
     link arrives saying «Escalas» and the search goes out by price. */
  for (const sortMode of SORT_MODES) {
    const { state, url } = roundTrip(request(), sortMode)
    assert.equal(url.searchParams.get("sort"), sortMode)
    assert.equal(state.sortMode, sortMode)
  }
})

test("an unknown order in a link opens the search by price instead of failing", () => {
  const url = urlWrittenFor(request(), "stops")
  url.searchParams.set("sort", "by-airline")

  assert.equal(readSharedSearchFromUrl(url)?.sortMode, "cheapest")
})
