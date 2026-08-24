import { fromBackendRequest, toBackendPayload, type BackendSearchRequest } from "@/lib/api"
import type { SearchRequest, SortMode } from "@/types"

const SEARCH_SHARE_PAYLOAD_TYPE = "fly-desk-search-config"
const SEARCH_SHARE_PAYLOAD_VERSION = 2
export const SEARCH_LAUNCH_PAYLOAD_QUERY_PARAM = "launchPayload"
/** Read by `test/ui/support.ts` too, which cannot import this module. */
export const OWN_SEARCH_URL_SESSION_KEY = "fly-desk:search-url-written-here:v1"
const SHARED_SEARCH_QUERY_PARAMS = [
  SEARCH_LAUNCH_PAYLOAD_QUERY_PARAM,
  "mode",
  "searchMode",
  "trip",
  "tripType",
  "origin",
  "destination",
  "departure",
  "departureDate",
  "return",
  "returnDate",
  "departureStart",
  "departureEnd",
  "returnStart",
  "returnEnd",
  "stayNights",
  "flexible",
  "adults",
  "children",
  "infants",
  "sort",
  "nonStop",
  "maxStops",
  "maxLayover",
  "carryOn",
  "checkedBaggage",
  "baggage",
  "airlines",
  "airline",
  "months",
  "month",
]

type SharedSearchMode = "exact" | "flexible" | "migration"

interface LegacySharedSearchPayload {
  type: typeof SEARCH_SHARE_PAYLOAD_TYPE
  version: typeof SEARCH_SHARE_PAYLOAD_VERSION
  copiedAt?: unknown
  mode?: unknown
  tripType?: unknown
  sortMode?: unknown
  providerConfig?: unknown
  request?: BackendSearchRequest
  frontendRequest?: unknown
}

export interface SharedSearchState {
  request: SearchRequest
  sortMode: SortMode
}

export function decodeSharedSearchPayload(encoded: string): SharedSearchState | null {
  const source = encoded.trim()
  if (!source) return null

  try {
    const base64 = source.replace(/-/g, "+").replace(/_/g, "/")
    const paddingLength = (4 - (base64.length % 4)) % 4
    const binary = atob(`${base64}${"=".repeat(paddingLength)}`)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<LegacySharedSearchPayload>

    return normalizeSharedSearchPayload(parsed)
  } catch {
    return null
  }
}

export function readSharedSearchFromText(text: string): SharedSearchState | null {
  const source = text.trim()
  if (!source) return null

  try {
    const parsed = JSON.parse(source) as Partial<LegacySharedSearchPayload>
    const normalized = normalizeSharedSearchPayload(parsed)
    if (normalized) return normalized
  } catch {
    // The URL launch payload is base64url-encoded JSON.
  }

  return decodeSharedSearchPayload(source)
}

export function readSharedSearchFromUrl(url: URL): SharedSearchState | null {
  const readableSearch = readReadableSharedSearchFromUrl(url)
  if (readableSearch) return readableSearch

  const encodedPayload = url.searchParams.get(SEARCH_LAUNCH_PAYLOAD_QUERY_PARAM)
  return encodedPayload ? decodeSharedSearchPayload(encodedPayload) : null
}

export function writeSharedSearchToUrl(request: SearchRequest, sortMode: SortMode): boolean {
  if (typeof window === "undefined") return false

  const url = new URL(window.location.href)
  writeReadableSharedSearchParams(url, request, sortMode)
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`)
  rememberSearchUrlWrittenHere(url.search)
  return true
}

/**
 * Whether the URL on screen is the one this tab wrote for itself.
 *
 * A search puts itself on the address bar, so afterwards the URL is letter for
 * letter the link the agent would share — and a shared link runs its search. If
 * nothing told the two apart, F5 would buy the search again, moments after
 * `pagehide` cancelled it precisely so that it would not be paid for twice. A
 * link is a request; the address bar is a record of one already made.
 *
 * `sessionStorage` is the scope that says this: it dies with the tab and is not
 * carried into the tab the link is pasted into. `history.state` would have been
 * the tighter scope, but the sheet layer already owns it (`fdSheet` in
 * `components/ui/sheet.tsx`) and the `replaceState` above deliberately clears
 * it; sharing that object between two unrelated concerns is how the back button
 * stops closing sheets.
 *
 * The query is stored whole rather than a bare flag, so that pasting a
 * different link into a tab that has already searched is still a link.
 */
export function searchUrlWasWrittenHere(url: URL): boolean {
  try {
    return window.sessionStorage.getItem(OWN_SEARCH_URL_SESSION_KEY) === url.search
  } catch {
    return false
  }
}

function rememberSearchUrlWrittenHere(search: string) {
  try {
    window.sessionStorage.setItem(OWN_SEARCH_URL_SESSION_KEY, search)
  } catch {
    /* Storage can be denied, and a tab that cannot remember reads its own
       address bar as a link and searches again on reload. That is the cost of
       one extra search in a hardened context, not a broken page. */
  }
}

export function serializeSharedSearchPayload(request: SearchRequest, sortMode: SortMode): string {
  const backendPayload = toBackendPayload(request, sortMode)

  return JSON.stringify({
    type: SEARCH_SHARE_PAYLOAD_TYPE,
    version: SEARCH_SHARE_PAYLOAD_VERSION,
    copiedAt: new Date().toISOString(),
    mode: sharedModeForRequest(request),
    tripType: request.tripType,
    sortMode,
    providerConfig: null,
    request: backendPayload.request,
    frontendRequest: normalizeFrontendRequest(request),
  })
}

export async function writeSharedSearchToClipboard(request: SearchRequest, sortMode: SortMode): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return false

  await navigator.clipboard.writeText(serializeSharedSearchPayload(request, sortMode))
  return true
}

function readReadableSharedSearchFromUrl(url: URL): SharedSearchState | null {
  const params = url.searchParams
  const origin = stringValue(params.get("origin")).toUpperCase()
  const destination = stringValue(params.get("destination")).toUpperCase()
  if (!origin || !destination) return null

  const tripType = (params.get("trip") ?? params.get("tripType")) === "one-way" ? "one-way" : "round-trip"
  const searchMode = searchModeFromReadableParams(params, tripType)
  const maxStops = optionalString(params.get("maxStops"))
  const includedAirlineCodes = [
    ...params.getAll("airline"),
    ...(optionalString(params.get("airlines")) ?? "").split(","),
  ]
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean)
  const migrationMonths = [
    ...params.getAll("month"),
    ...(optionalString(params.get("months")) ?? "").split(","),
  ]
    .map((month) => month.trim())
    .filter(isMonthKey)

  const request: SearchRequest = {
    origin,
    destination,
    departureDate: optionalString(params.get("departure") ?? params.get("departureDate")),
    departureStart: optionalString(params.get("departureStart")),
    departureEnd: optionalString(params.get("departureEnd")),
    returnDate: optionalString(params.get("return") ?? params.get("returnDate")),
    returnStart: optionalString(params.get("returnStart")),
    returnEnd: optionalString(params.get("returnEnd")),
    stayNights: numberValue(params.get("stayNights")),
    tripType,
    adults: numberValue(params.get("adults")) ?? 1,
    children: numberValue(params.get("children")) ?? 0,
    infants: numberValue(params.get("infants")) ?? 0,
    searchMode,
    flexibleMode: normalizeFlexibleMode(params.get("flexible")),
    nonStop: boolParam(params, "nonStop") || maxStops === "0",
    maxStopsFilter: maxStops && maxStops !== "0" ? maxStops : undefined,
    maxLayoverMinutes: optionalString(params.get("maxLayover")),
    carryOnRequired: boolParam(params, "carryOn"),
    checkedBaggageRequired: boolParam(params, "checkedBaggage") || boolParam(params, "baggage"),
    baggageRequired: boolParam(params, "baggage"),
    includedAirlineCodes: includedAirlineCodes.length ? includedAirlineCodes : undefined,
    migrationMonths: migrationMonths.length ? Array.from(new Set(migrationMonths)) : undefined,
  }

  if (searchMode !== "roundtrip-grid") {
    request.flexibleMode = undefined
  }

  return {
    request,
    sortMode: normalizeSortMode(params.get("sort")),
  }
}

function writeReadableSharedSearchParams(url: URL, request: SearchRequest, sortMode: SortMode) {
  for (const key of SHARED_SEARCH_QUERY_PARAMS) {
    url.searchParams.delete(key)
  }

  setReadableParam(url, "mode", sharedModeForRequest(request))
  setReadableParam(url, "trip", request.tripType)
  setReadableParam(url, "origin", request.origin.toUpperCase().trim())
  setReadableParam(url, "destination", request.destination.toUpperCase().trim())
  setReadableParam(url, "departure", request.departureDate)
  setReadableParam(url, "return", request.returnDate)
  setReadableParam(url, "departureStart", request.departureStart)
  setReadableParam(url, "departureEnd", request.departureEnd)
  setReadableParam(url, "returnStart", request.returnStart)
  setReadableParam(url, "returnEnd", request.returnEnd)
  setReadableParam(url, "stayNights", request.stayNights)
  setReadableParam(url, "flexible", request.flexibleMode)
  setReadableParam(url, "adults", request.adults)
  setReadableParam(url, "children", request.children)
  setReadableParam(url, "infants", request.infants)
  setReadableParam(url, "sort", sortMode)
  if (request.nonStop) setReadableParam(url, "nonStop", 1)
  if (request.maxStopsFilter && !request.nonStop) setReadableParam(url, "maxStops", request.maxStopsFilter)
  if (request.maxLayoverMinutes) setReadableParam(url, "maxLayover", request.maxLayoverMinutes)
  if (request.carryOnRequired) setReadableParam(url, "carryOn", 1)
  if (request.checkedBaggageRequired ?? request.baggageRequired) setReadableParam(url, "checkedBaggage", 1)
  if (request.includedAirlineCodes?.length) {
    setReadableParam(url, "airlines", request.includedAirlineCodes.map((code) => code.toUpperCase()).join(","))
  }
  if (request.searchMode === "month-view" && request.migrationMonths?.length) {
    setReadableParam(url, "months", request.migrationMonths.join(","))
  }
}

function setReadableParam(url: URL, key: string, value: string | number | undefined) {
  const normalized = value === undefined ? "" : String(value).trim()
  if (normalized) {
    url.searchParams.set(key, normalized)
  }
}

function normalizeSharedSearchPayload(payload: Partial<LegacySharedSearchPayload>): SharedSearchState | null {
  if (
    payload.type !== SEARCH_SHARE_PAYLOAD_TYPE
    || Number.parseInt(String(payload.version), 10) !== SEARCH_SHARE_PAYLOAD_VERSION
    || !payload.request
  ) {
    return null
  }

  const sortMode = normalizeSortMode(payload.sortMode)
  const request = normalizeFrontendRequest(payload.frontendRequest) ?? fromBackendRequest(payload.request as BackendSearchRequest)
  if (!request.origin || !request.destination) return null

  return { request, sortMode }
}

function normalizeFrontendRequest(value: unknown): SearchRequest | null {
  if (!value || typeof value !== "object") return null

  const request = value as Partial<SearchRequest>
  const origin = stringValue(request.origin).toUpperCase()
  const destination = stringValue(request.destination).toUpperCase()
  if (!origin || !destination) return null

  return {
    origin,
    destination,
    departureDate: optionalString(request.departureDate),
    departureStart: optionalString(request.departureStart),
    departureEnd: optionalString(request.departureEnd),
    returnDate: optionalString(request.returnDate),
    returnStart: optionalString(request.returnStart),
    returnEnd: optionalString(request.returnEnd),
    stayNights: numberValue(request.stayNights),
    tripType: request.tripType === "one-way" ? "one-way" : "round-trip",
    adults: numberValue(request.adults) ?? 1,
    children: numberValue(request.children) ?? 0,
    infants: numberValue(request.infants) ?? 0,
    searchMode: normalizeSearchMode(request.searchMode),
    flexibleMode: request.flexibleMode === "fixed-ranges" ? "fixed-ranges" : request.flexibleMode === "exact-stay" ? "exact-stay" : undefined,
    nonStop: request.nonStop === true,
    maxStopsFilter: optionalString(request.maxStopsFilter),
    maxLayoverMinutes: optionalString(request.maxLayoverMinutes),
    carryOnRequired: request.carryOnRequired === true,
    checkedBaggageRequired: request.checkedBaggageRequired === true || request.baggageRequired === true,
    baggageRequired: request.baggageRequired === true,
    includedAirlineCodes: Array.isArray(request.includedAirlineCodes)
      ? request.includedAirlineCodes.map(stringValue).filter(Boolean)
      : undefined,
    migrationMonths: Array.isArray(request.migrationMonths)
      ? Array.from(new Set(request.migrationMonths.map(stringValue).filter(isMonthKey)))
      : undefined,
    sortMode: optionalString(request.sortMode),
  }
}

function normalizeSortMode(value: unknown): SortMode {
  return value === "cheapest" || value === "fastest"
    ? value
    : "cheapest"
}

function normalizeSearchMode(value: unknown): SearchRequest["searchMode"] {
  return value === "stay-range" || value === "roundtrip-grid" || value === "month-view" || value === "exact"
    ? value
    : "exact"
}

function searchModeFromReadableParams(
  params: URLSearchParams,
  tripType: SearchRequest["tripType"]
): SearchRequest["searchMode"] {
  const rawMode = stringValue(params.get("mode"))
  if (rawMode === "migration") return "month-view"
  if (rawMode === "flexible") return tripType === "round-trip" ? "roundtrip-grid" : "stay-range"
  if (rawMode === "exact") return "exact"
  return normalizeSearchMode(params.get("searchMode"))
}

function normalizeFlexibleMode(value: unknown): SearchRequest["flexibleMode"] | undefined {
  return value === "fixed-ranges" || value === "exact-stay" ? value : undefined
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function optionalString(value: unknown) {
  const normalized = stringValue(value)
  return normalized || undefined
}

function numberValue(value: unknown) {
  const normalized = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  return Number.isFinite(normalized) ? normalized : undefined
}

function boolParam(params: URLSearchParams, key: string) {
  const value = stringValue(params.get(key)).toLowerCase()
  return value === "1" || value === "true" || value === "yes"
}

function isMonthKey(value: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
}

function sharedModeForRequest(request: SearchRequest): SharedSearchMode {
  if (request.searchMode === "month-view") return "migration"
  return request.searchMode === "exact" ? "exact" : "flexible"
}
