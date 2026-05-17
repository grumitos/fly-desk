import type {
  CanonicalOffer,
  LocationSuggestion,
  MatrixCell,
  MigrationMonthSummary,
  ResultsColumnLayout,
  ResultsLayout,
  SearchRequest,
  SearchJobResponse,
  SortMode,
} from "@/types"
import { normalizeAirlineDisplayName, resolveAirlineDisplayName } from "@/lib/airline-names"
import { filterLocationSuggestions, normalizeLocationSearchText, normalizeLocationSuggestions } from "@/lib/locations"
import {
  firstSegmentForItinerary,
  formatOfferBaggageLabel,
  itineraryRouteLabel,
  lastSegmentForItinerary,
  primaryItineraryForOffer,
  returnItineraryForOffer,
} from "@/lib/offer-display"

const API_BASE = ""
const MIGRATION_MONTH_COUNT = 8
const MIGRATION_CONCURRENT_REQUESTS = 2
const MIGRATION_POLL_INTERVAL_MS = 900
const MIGRATION_POLL_LIMIT = 90
const MIGRATION_MONTH_RESULT_LIMIT = 25
const MIGRATION_MONTH_LABEL_FORMATTER = new Intl.DateTimeFormat("es-PE", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
})
const locationSuggestionCache = new Map<string, LocationSuggestion[]>()
const locationSuggestionPool = new Map<string, LocationSuggestion>()

export class FlyDeskApiError extends Error {
  readonly diagnosticLog: string[]

  constructor(message: string, diagnosticLog: string[]) {
    super(message)
    this.name = "FlyDeskApiError"
    this.diagnosticLog = diagnosticLog
  }
}

export class FlyDeskSearchCancelledError extends Error {
  constructor() {
    super("Búsqueda detenida por el usuario.")
    this.name = "FlyDeskSearchCancelledError"
  }
}

type RequestOptions = {
  signal?: AbortSignal
}

type SearchRequestOptions = RequestOptions & {
  onJobStart?: (job: { id: string; type: "search" | "matrix" }) => void
  onMigrationProgress?: (job: SearchJobResponse) => void
}

type MigrationMonthRange = {
  key: string
  label: string
  departureStart: string
  departureEnd: string
}

type MigrationMonthWorkResult = {
  complete: boolean
  diagnosticLog: string[]
  job?: SearchJobResponse
  offer?: CanonicalOffer
  offers: CanonicalOffer[]
  range: MigrationMonthRange
  status: MigrationMonthSummary["status"]
  warnings: string[]
}

function translateApiMessage(message: string): string {
  const normalized = stripAnsi(String(message)).replace(/\s+/g, " ").trim()

  const exact: Record<string, string> = {
    "Origin is required and must be an IATA-like code.": "Ingresa un origen válido.",
    "Destination is required and must be an IATA-like code.": "Ingresa un destino válido.",
    "Origin and destination must be different.": "El origen y el destino deben ser diferentes.",
    "Multi-city search is not supported.": "La búsqueda multidestino aún no está disponible.",
    "Adults must be a non-negative integer.": "La cantidad de adultos debe ser válida.",
    "Children must be a non-negative integer.": "La cantidad de niños debe ser válida.",
    "Infants must be a non-negative integer.": "La cantidad de bebés debe ser válida.",
    "At least one adult is required.": "Debe viajar al menos un adulto.",
    "Infants cannot exceed adults.": "La cantidad de bebés no puede superar la de adultos.",
    "Passenger count cannot exceed 9.": "La búsqueda admite hasta 9 pasajeros.",
    "Departure date is required for exact search.": "Selecciona una fecha de salida.",
    "Departure date must be a valid ISO date (YYYY-MM-DD).": "La fecha de salida no es válida.",
    "Return date is required for round-trip exact search.": "Selecciona una fecha de regreso.",
    "Return date must be a valid ISO date (YYYY-MM-DD).": "La fecha de regreso no es válida.",
    "Return date must be after departure date.": "La fecha de regreso debe ser posterior a la salida.",
    "Stay length cannot exceed 90 nights.": "La estadía máxima es de 90 noches.",
    "Departure range is required for matrix search.": "Selecciona un rango de salida.",
    "Return range is required for round-trip matrix search.": "Selecciona un rango de regreso.",
    "Stay nights is required for exact-stay matrix search.": "Indica la cantidad de noches.",
    "Departure range is required for range search.": "Selecciona un rango de salida.",
    "Return range is required for round-trip range search.": "Selecciona un rango de regreso.",
    "Departure range end must be on or after departure range start.": "El fin del rango de salida debe ser igual o posterior al inicio.",
    "Return range end must be on or after return range start.": "El fin del rango de regreso debe ser igual o posterior al inicio.",
    "Costamar terminalId is required.": "Falta configurar el terminal de Costamar.",
    "A full results column layout is required.": "El layout de resultados está incompleto.",
    "searchSessionId and offerId are required.": "Falta la sesión de búsqueda o la oferta.",
    "Session or offer not found.": "No se encontró la sesión o la oferta.",
    "Search job not found.": "No se encontró la búsqueda.",
    "Matrix job not found.": "No se encontró la matriz de búsqueda.",
    "Purchase path not found.": "No se encontró el enlace de compra.",
    "Purchase path is unavailable.": "El enlace de compra ya no está disponible.",
    "Not found": "No encontrado.",
    "Invalid JSON payload.": "La solicitud enviada no es válida.",
    "AGIL_TOKEN_EXPIRED": "La sesión de Agil venció. Vuelve a iniciar sesión en Agil e intenta nuevamente.",
    "Agil exact search.": "Búsqueda exacta en Agil.",
    "Agil returned no live result for this combination.": "Agil no devolvió una tarifa disponible para esta combinación.",
    "Agil error while resolving this combination.": "No se pudo consultar Agil para esta combinación.",
    "Agil exact search with stop.": "Búsqueda exacta en Agil con escala.",
    "Agil stopover search.": "Búsqueda en Agil con escala.",
    "Agil direct alt fare.": "Tarifa alternativa directa de Agil.",
    "Costamar exact search.": "Búsqueda exacta en Costamar.",
    "Costamar live search.": "Búsqueda en vivo de Costamar.",
    "Costamar returned no live result for this combination.": "Costamar no devolvió una tarifa disponible para esta combinación.",
    "Consultando Costamar...": "Consultando Costamar...",
    "Consultando Agil...": "Consultando Agil...",
    "Consultando Agil y Costamar. Los resultados se iran agregando.": "Consultando Agil y Costamar. Los resultados se irán agregando.",
    "Consultando Agil. Los resultados se iran agregando.": "Consultando Agil. Los resultados se irán agregando.",
    "Consultando Costamar. Los resultados se iran agregando.": "Consultando Costamar. Los resultados se irán agregando.",
    "Mostrando resultados cacheados mientras actualizamos en segundo plano.": "Mostrando resultados cacheados mientras actualizamos en segundo plano.",
    "Matrix loading from Agil in parallel.": "Agil está consultando la matriz.",
    "Matrix finished with partial Agil failures.": "Agil completó la matriz con resultados parciales.",
    "Matrix built from Agil exact searches in parallel.": "Matriz creada con búsquedas exactas de Agil.",
    "Selecting a cell runs a full Agil exact search for offers.": "Selecciona una fecha para ver las ofertas disponibles.",
    "Matrix loading from Costamar with useful date combinations only.": "Costamar está consultando la matriz.",
    "Matrix finished with partial Costamar failures.": "Costamar completó la matriz con resultados parciales.",
    "Matrix seeded from Costamar native flexible search and completed with exact searches.": "Matriz creada con búsquedas de Costamar.",
    "Matrix built from Costamar exact searches over useful date combinations.": "Matriz creada con búsquedas exactas de Costamar.",
    "Matrix keeps only useful date combinations based on the requested stay window.": "La matriz conserva las combinaciones útiles para la estadía solicitada.",
    "Selecting a cell runs a full Costamar exact search for offers.": "Selecciona una fecha para ver las ofertas disponibles.",
    "Search cancelled by user.": "Búsqueda detenida por el usuario.",
  }

  if (exact[normalized]) return exact[normalized]

  const dateMatch = normalized.match(/^(Departure|Return) date must be on (or after|or before) ([0-9-]+)\.$/)
  if (dateMatch) {
    const [, field, direction, date] = dateMatch
    const label = field === "Departure" ? "La fecha de salida" : "La fecha de regreso"
    const relation = direction === "or after" ? "igual o posterior" : "igual o anterior"
    return `${label} debe ser ${relation} a ${date}.`
  }

  if (normalized.includes("localhost access or a valid API token")) {
    return "Esta acción requiere acceso local o un token válido."
  }

  if (normalized.includes("Unable to extract Agil session from Chrome profiles")) {
    return "No se pudo leer la sesión local de Agil. Abre Agil en Chrome con la sesión activa y vuelve a intentar."
  }

  if (normalized.includes("byte limit")) {
    return "La solicitud es demasiado grande."
  }

  if (normalized.includes("AGIL_APIM_SUBSCRIPTION_KEY")) {
    return "No se pudo consultar Agil por una configuración local incompleta."
  }

  if (/^Agil returned no offers/i.test(normalized)) {
    return "Agil no devolvió vuelos para esta búsqueda."
  }

  if (/^Costamar returned no offers/i.test(normalized)) {
    return "Costamar no devolvió vuelos para esta búsqueda."
  }

  if (/^Agil exact search/i.test(normalized)) {
    return "Búsqueda exacta en Agil."
  }

  if (/^Costamar (exact|live) search/i.test(normalized)) {
    return "Búsqueda en vivo de Costamar."
  }

  if (/Agil/i.test(normalized) && /(failed|error|omitted|rejected|Internal Server Error|500|401|403|expired|session|sesión)/i.test(normalized)) {
    return "No se pudo consultar Agil. Verifica que la sesión esté activa e intenta nuevamente."
  }

  if (/Costamar/i.test(normalized) && /(failed|error|token|auth|login|session|sesión|401|403|500|expired|challenge)/i.test(normalized)) {
    return "No se pudo consultar Costamar. Verifica que la sesión esté activa e intenta nuevamente."
  }

  return normalized ? "No se pudo completar la operación. Intenta nuevamente." : "Ocurrió un error inesperado."
}

function stripAnsi(value: string) {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "")
}

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))))
}

function apiRawMessages(data: unknown): string[] {
  if (!data || typeof data !== "object") {
    return []
  }

  const payload = data as { errors?: unknown; error?: unknown }
  if (Array.isArray(payload.errors)) {
    return payload.errors.map((message) => String(message))
  }

  if (typeof payload.error === "string") {
    return [payload.error]
  }

  if (payload.error !== undefined) {
    return [JSON.stringify(payload.error)]
  }

  return []
}

function toDiagnosticLines(messages: string[]): string[] {
  return uniqueStrings(
    messages.flatMap((message) => (
      stripAnsi(message)
        .split(/\n+/)
        .map((line) => line.trim())
    )),
  )
}

function providerDiagnosticLabel(providerId: string): string {
  return providerId === "costamar" ? "Costamar" : "Agilsmart"
}

function providerDiagnosticLines(
  diagnostics: SearchJobResponse["providerDiagnostics"] | undefined
): string[] {
  return (diagnostics ?? []).flatMap((entry) => {
    const provider = providerDiagnosticLabel(entry.providerId)
    const summary = [
      `${provider} ${entry.kind}: ${entry.status}`,
      typeof entry.offers === "number" ? `${entry.offers} resultado${entry.offers === 1 ? "" : "s"}` : "",
      typeof entry.warningCount === "number" ? `${entry.warningCount} alerta${entry.warningCount === 1 ? "" : "s"}` : "",
      entry.error ? `error=${entry.error}` : "",
    ].filter(Boolean).join(" · ")

    const events = entry.events.map((event) => {
      const elapsed = typeof event.elapsedMs === "number" ? `+${Math.round(event.elapsedMs)}ms` : ""
      const detail = event.detail ? ` · ${event.detail}` : ""
      return `${provider} ${entry.kind}: ${event.name}${elapsed ? ` ${elapsed}` : ""}${detail}`
    })

    return [summary, ...events]
  })
}

function translateMessages(messages: string[]): string {
  const translated = uniqueStrings(messages.map((message) => translateApiMessage(message)))
  return translated.length > 0 ? translated.join("\n") : "Ocurrió un error inesperado."
}

function apiErrorMessage(data: unknown): string {
  return translateMessages(apiRawMessages(data))
}

function buildHttpDiagnosticLog(url: string, response: Response, data: unknown): string[] {
  return toDiagnosticLines([
    `HTTP ${response.status} ${response.statusText} ${url}`,
    ...apiRawMessages(data),
  ])
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined

  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function diagnosticLogFromError(error: unknown): string[] {
  if (error instanceof FlyDeskSearchCancelledError) {
    return toDiagnosticLines([error.message])
  }

  if (error instanceof FlyDeskApiError) {
    return error.diagnosticLog
  }

  if (error instanceof Error) {
    return toDiagnosticLines([error.message])
  }

  return toDiagnosticLines([String(error)])
}

export function userMessageFromError(error: unknown): string {
  if (error instanceof FlyDeskSearchCancelledError) {
    return error.message
  }

  if (error instanceof FlyDeskApiError) {
    return error.message
  }

  return "No se pudo completar la búsqueda. Intenta nuevamente."
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new FlyDeskSearchCancelledError()
  }
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError"
}

async function postJson<T>(url: string, payload: unknown, options: RequestOptions = {}): Promise<T> {
  throwIfAborted(options.signal)
  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: options.signal,
    })
  } catch (error) {
    if (isAbortLikeError(error) || options.signal?.aborted) {
      throw new FlyDeskSearchCancelledError()
    }

    throw new FlyDeskApiError("No se pudo conectar con Fly Desk. Intenta nuevamente.", diagnosticLogFromError(error))
  }
  throwIfAborted(options.signal)
  const data = await readJsonBody(res)
  if (!res.ok) throw new FlyDeskApiError(apiErrorMessage(data), buildHttpDiagnosticLog(url, res, data))
  if (data === undefined) throw new FlyDeskApiError("El servidor devolvió una respuesta no válida.", buildHttpDiagnosticLog(url, res, data))
  return data as T
}

async function getJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  throwIfAborted(options.signal)
  let res: Response
  try {
    res = await fetch(url, { signal: options.signal })
  } catch (error) {
    if (isAbortLikeError(error) || options.signal?.aborted) {
      throw new FlyDeskSearchCancelledError()
    }

    throw new FlyDeskApiError("No se pudo conectar con Fly Desk. Intenta nuevamente.", diagnosticLogFromError(error))
  }
  throwIfAborted(options.signal)
  const data = await readJsonBody(res)
  if (!res.ok) throw new FlyDeskApiError(apiErrorMessage(data), buildHttpDiagnosticLog(url, res, data))
  if (data === undefined) throw new FlyDeskApiError("El servidor devolvió una respuesta no válida.", buildHttpDiagnosticLog(url, res, data))
  return data as T
}

export async function suggestLocations(query: string, limit = 8): Promise<LocationSuggestion[]> {
  if (query.trim().length < 1) return []
  const data = await getJson<{ suggestions: LocationSuggestion[] }>(
    `${API_BASE}/api/locations?q=${encodeURIComponent(query)}&limit=${limit}&providerId=costamar`
  )
  const suggestions = normalizeLocationSuggestions(data.suggestions)
  const rankedSuggestions = filterLocationSuggestions(query, suggestions, limit)
  rememberLocationSuggestions(query, limit, rankedSuggestions)
  return rankedSuggestions
}

export function getCachedLocationSuggestions(query: string, limit = 8): LocationSuggestion[] {
  if (query.trim().length < 1) return []
  const key = locationSuggestionCacheKey(query, limit)
  return locationSuggestionCache.get(key) ?? filterLocationSuggestions(query, [...locationSuggestionPool.values()], limit)
}

export async function getResultsLayout(options: RequestOptions = {}): Promise<ResultsLayout | null> {
  const data = await getJson<{ layout: ResultsLayout | null }>(`${API_BASE}/api/results-layout`, options)
  return data.layout ?? null
}

export async function saveResultsLayout(
  columns: ResultsColumnLayout,
  options: RequestOptions = {},
): Promise<ResultsLayout> {
  const data = await postJson<{ ok?: boolean; layout: ResultsLayout }>(
    `${API_BASE}/api/results-layout`,
    { columns },
    options,
  )
  return data.layout
}

function rememberLocationSuggestions(query: string, limit: number, suggestions: LocationSuggestion[]) {
  const key = locationSuggestionCacheKey(query, limit)
  locationSuggestionCache.set(key, suggestions)

  for (const suggestion of suggestions) {
    locationSuggestionPool.set(locationSuggestionCacheId(suggestion), suggestion)
  }
}

function locationSuggestionCacheKey(query: string, limit: number) {
  return `${normalizeLocationSearchText(query)}::${limit}`
}

function locationSuggestionCacheId(suggestion: LocationSuggestion) {
  return [
    suggestion.code,
    normalizeLocationSearchText(suggestion.city),
    normalizeLocationSearchText(suggestion.country),
  ]
    .filter(Boolean)
    .join("|")
}

export type BackendSearchRequest = {
  tripType?: "round-trip" | "one-way" | "multi-city"
  searchMode?: SearchRequest["searchMode"]
  flexibleMode?: SearchRequest["flexibleMode"]
  legs?: Array<{
    origin?: string
    destination?: string
    departureDate?: string
    departureStart?: string
    departureEnd?: string
    returnDate?: string
    returnStart?: string
    returnEnd?: string
    stayNights?: number
  }>
  passengers?: {
    adults?: number
    children?: number
    infants?: number
  }
  filters?: {
    nonStop?: boolean
    baggageRequired?: boolean
    maxStops?: number
    maxLayoverMinutes?: number
    includedAirlineCodes?: string[]
    maxResults?: number
    compactAllOffers?: boolean
  }
  currencyCode?: string
  locale?: string
  market?: string
}

export type BackendSearchPayload = {
  sortMode: SortMode
  request: BackendSearchRequest
}

type BackendSearchJobResponse = Omit<SearchJobResponse, "request" | "offers" | "allOffers"> & {
  request?: BackendSearchRequest
  offers?: unknown[]
  allOffers?: unknown[]
}

type BackendMatrixJobResponse = {
  matrixJobId: string
  matrixComplete: boolean
  matrixStatus: string
  revision: number
  request?: BackendSearchJobResponse["request"]
  searchMeta?: SearchJobResponse["searchMeta"]
  providerMeta?: SearchJobResponse["providerMeta"]
  warnings?: string[]
  error?: string
  unchanged?: boolean
  cells?: MatrixCell[]
  axes?: {
    departureDates: string[]
    returnDates: string[]
  }
  confidenceSummary?: Record<string, number>
  recommendations?: string[]
  providerDiagnostics?: SearchJobResponse["providerDiagnostics"]
}

export function toBackendPayload(request: SearchRequest, sortMode: SortMode): BackendSearchPayload {
  const maxStops = request.nonStop
    ? 0
    : request.maxStopsFilter === "1"
      ? 1
      : undefined

  return {
    sortMode,
    request: {
      tripType: request.tripType,
      searchMode: request.searchMode,
      flexibleMode: request.flexibleMode,
      legs: [
        {
          origin: request.origin,
          destination: request.destination,
          departureDate: request.departureDate,
          departureStart: request.departureStart,
          departureEnd: request.departureEnd,
          returnDate: request.returnDate,
          returnStart: request.returnStart,
          returnEnd: request.returnEnd,
          stayNights: request.stayNights,
        },
      ],
      passengers: {
        adults: request.adults,
        children: request.children,
        infants: request.infants,
      },
      filters: {
        nonStop: Boolean(request.nonStop),
        baggageRequired: Boolean(request.baggageRequired),
        maxStops,
        maxLayoverMinutes: request.maxLayoverMinutes ? Number(request.maxLayoverMinutes) : undefined,
        includedAirlineCodes: request.includedAirlineCodes?.length ? request.includedAirlineCodes : undefined,
        maxResults: request.maxResults,
        compactAllOffers: request.compactAllOffers,
      },
      currencyCode: "USD",
      locale: "es-PE",
      market: "PE",
    },
  }
}

export function fromBackendRequest(request: BackendSearchRequest | undefined): SearchRequest {
  const leg = request?.legs?.[0] ?? {}
  return {
    origin: leg.origin ?? "",
    destination: leg.destination ?? "",
    departureDate: leg.departureDate,
    departureStart: leg.departureStart,
    departureEnd: leg.departureEnd,
    returnDate: leg.returnDate,
    returnStart: leg.returnStart,
    returnEnd: leg.returnEnd,
    stayNights: leg.stayNights,
    tripType: request?.tripType === "one-way" ? "one-way" : "round-trip",
    adults: request?.passengers?.adults ?? 1,
    children: request?.passengers?.children ?? 0,
    infants: request?.passengers?.infants ?? 0,
    searchMode: request?.searchMode ?? "exact",
    flexibleMode: request?.flexibleMode,
    nonStop: request?.filters?.nonStop,
    maxStopsFilter: typeof request?.filters?.maxStops === "number" ? String(request.filters.maxStops) : undefined,
    baggageRequired: request?.filters?.baggageRequired,
    maxLayoverMinutes: request?.filters?.maxLayoverMinutes?.toString(),
    includedAirlineCodes: request?.filters?.includedAirlineCodes,
    maxResults: request?.filters?.maxResults,
    compactAllOffers: request?.filters?.compactAllOffers,
  }
}

function normalizeOfferItineraries(value: unknown): CanonicalOffer["itineraries"] | undefined {
  if (!Array.isArray(value)) return undefined

  return value.map((itinerary) => {
    const rawItinerary = itinerary && typeof itinerary === "object" ? itinerary as Record<string, unknown> : {}
    const rawSegments = Array.isArray(rawItinerary.segments) ? rawItinerary.segments : []
    return {
      ...rawItinerary,
      segments: rawSegments.map((segment) => {
        const rawSegment = segment && typeof segment === "object" ? segment as Record<string, unknown> : {}
        return {
          ...rawSegment,
          marketingCarrierName: normalizeAirlineDisplayName(rawSegment.marketingCarrierName) || undefined,
          operatingCarrierName: normalizeAirlineDisplayName(rawSegment.operatingCarrierName) || undefined,
        }
      }),
    }
  }) as CanonicalOffer["itineraries"]
}

function offerAirlineCode(offer: Record<string, unknown>, segment?: Record<string, unknown>): string {
  return String(
    offer.mainCarrier
      ?? offer.validatingCarrier
      ?? segment?.marketingCarrier
      ?? offer.airline
      ?? "",
  ).trim()
}

function offerAirlineDisplayName(offer: Record<string, unknown>, segment?: Record<string, unknown>): string {
  const code = offerAirlineCode(offer, segment)
  return resolveAirlineDisplayName({
    names: [
      segment?.marketingCarrierName,
      offer.airline,
      segment?.operatingCarrierName,
    ],
    codes: [
      code,
      offer.validatingCarrier,
      segment?.marketingCarrier,
      segment?.operatingCarrier,
    ],
    fallback: code,
  })
}

function durationLabel(minutes: unknown): string {
  const value = typeof minutes === "number" ? minutes : Number(minutes)
  if (!Number.isFinite(value) || value <= 0) return ""
  const hours = Math.floor(value / 60)
  const mins = Math.round(value % 60)
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = finiteNumber(value)
  return parsed !== undefined && parsed > 0 ? parsed : undefined
}

function itineraryDurationMinutesFromOffer(offer: Record<string, unknown>): number | undefined {
  const itineraries = Array.isArray(offer.itineraries) ? offer.itineraries as Array<Record<string, unknown>> : []
  const total = itineraries.reduce((sum, itinerary) => {
    const direct = positiveNumber(itinerary.durationMinutes)
    if (direct !== undefined) return sum + direct

    const segments = Array.isArray(itinerary.segments) ? itinerary.segments as Array<Record<string, unknown>> : []
    return sum + segments.reduce((segmentSum, segment) => {
      const duration = positiveNumber(segment.durationMinutes)
      if (duration !== undefined) return segmentSum + duration

      const departureAt = typeof segment.departureAt === "string" ? Date.parse(segment.departureAt) : Number.NaN
      const arrivalAt = typeof segment.arrivalAt === "string" ? Date.parse(segment.arrivalAt) : Number.NaN
      const diff = arrivalAt - departureAt
      return Number.isFinite(diff) && diff > 0 ? segmentSum + Math.round(diff / 60000) : segmentSum
    }, 0)
  }, 0)

  return total > 0 ? total : undefined
}

function itineraryStopsFromOffer(offer: Record<string, unknown>): number | undefined {
  const itineraries = Array.isArray(offer.itineraries) ? offer.itineraries as Array<Record<string, unknown>> : []
  if (!itineraries.length) return undefined

  let foundStops = false
  return itineraries.reduce((sum, itinerary) => {
    const direct = finiteNumber(itinerary.stops)
    const segments = Array.isArray(itinerary.segments) ? itinerary.segments : []
    const segmentStops = segments.length > 0 ? Math.max(0, segments.length - 1) : undefined
    const resolved = direct !== undefined && direct >= 0
      ? Math.max(direct, segmentStops ?? 0)
      : segmentStops
    if (resolved === undefined) return sum
    foundStops = true
    return sum + resolved
  }, 0) || (foundStops ? 0 : undefined)
}

function hasCheckedBaggage(baggage: unknown): boolean {
  return Boolean(
    baggage &&
      typeof baggage === "object" &&
      (baggage as CanonicalOffer["baggage"])?.checkedIncluded
  )
}

function normalizeOffer(input: unknown): CanonicalOffer {
  const offer = input && typeof input === "object" ? input as Record<string, unknown> : {}
  const itineraries = normalizeOfferItineraries(offer.itineraries)
  const offerWithNormalizedNames = {
    ...offer,
    ...(itineraries ? { itineraries } : {}),
  }
  const metrics = offer.comparisonMetrics && typeof offer.comparisonMetrics === "object"
    ? offer.comparisonMetrics as Record<string, unknown>
    : {}
  const itineraryOffer = offerWithNormalizedNames as Pick<CanonicalOffer, "itineraries">
  const outboundItinerary = primaryItineraryForOffer(itineraryOffer)
  const inboundItinerary = returnItineraryForOffer(itineraryOffer)
  const outbound = firstSegmentForItinerary(outboundItinerary)
  const outboundLast = lastSegmentForItinerary(outboundItinerary)
  const inbound = firstSegmentForItinerary(inboundItinerary)
  const price = offer.price && typeof offer.price === "object"
    ? offer.price as CanonicalOffer["price"]
    : { total: { amount: 0, currencyCode: "USD" } }
  const warnings = Array.isArray(offer.warnings)
    ? uniqueStrings(offer.warnings.map((warning) => translateApiMessage(String(warning))))
    : undefined
  const totalDurationMinutes = positiveNumber(metrics.totalDurationMinutes)
    ?? itineraryDurationMinutesFromOffer(offer)
  const totalStops = itineraryStopsFromOffer(offerWithNormalizedNames)
    ?? finiteNumber(metrics.totalStops)
    ?? finiteNumber(offer.stops)
    ?? 0
  const comparisonMetrics = {
    ...(offer.comparisonMetrics && typeof offer.comparisonMetrics === "object"
      ? offer.comparisonMetrics as CanonicalOffer["comparisonMetrics"]
      : {}),
    ...(totalDurationMinutes !== undefined ? { totalDurationMinutes } : {}),
    totalStops,
  }

  return {
    ...(offer as Partial<CanonicalOffer>),
    id: String(offer.id ?? crypto.randomUUID()),
    providerSource: String(offer.providerSource ?? ""),
    airline: offerAirlineDisplayName(offerWithNormalizedNames, outbound),
    itineraries,
    origin: typeof outbound?.origin === "string" ? outbound.origin : String(offer.origin ?? ""),
    destination: typeof outboundLast?.destination === "string" ? outboundLast.destination : String(offer.destination ?? ""),
    departureDate: String(outbound?.departureAt ?? offer.departureDate ?? ""),
    arrivalDate: typeof outboundLast?.arrivalAt === "string" ? outboundLast.arrivalAt : undefined,
    returnDate: typeof inbound?.departureAt === "string" ? inbound.departureAt : offer.returnDate as string | undefined,
    duration: durationLabel(totalDurationMinutes),
    stops: totalStops,
    stopMeta: itineraryRouteLabel(outboundItinerary, {
      origin: offer.origin,
      destination: offer.destination,
    }),
    baggage: typeof offer.baggage === "object" && offer.baggage ? offer.baggage as CanonicalOffer["baggage"] : undefined,
    baggageLabel: formatOfferBaggageLabel(offer.baggage),
    hasCheckedBaggage: hasCheckedBaggage(offer.baggage),
    comparisonMetrics,
    warnings,
    price,
  }
}

function rawOfferWarnings(input: unknown): string[] {
  const offer = input && typeof input === "object" ? input as Record<string, unknown> : {}
  return Array.isArray(offer.warnings) ? offer.warnings.map((warning) => String(warning)) : []
}

function normalizeSearchJob(data: BackendSearchJobResponse): SearchJobResponse {
  const rawWarnings = (data.warnings ?? []).map((warning) => String(warning))
  const rawMetaWarnings = (data.searchMeta?.warnings ?? []).map((warning) => String(warning))
  const rawWarningsFromOffers = [...(data.offers ?? []), ...(data.allOffers ?? [])].flatMap(rawOfferWarnings)
  const warnings = rawWarnings.map((warning) => translateApiMessage(warning))
  const searchMeta = data.searchMeta
    ? {
        ...data.searchMeta,
        warnings: rawMetaWarnings.map((warning) => translateApiMessage(warning)),
      }
    : data.searchMeta

  return {
    ...data,
    searchMeta,
    warnings,
    request: fromBackendRequest(data.request),
    offers: (data.offers ?? []).map(normalizeOffer),
    allOffers: (data.allOffers ?? []).map(normalizeOffer),
    diagnosticLog: toDiagnosticLines([
      ...rawWarnings,
      ...rawMetaWarnings,
      ...rawWarningsFromOffers,
      ...providerDiagnosticLines(data.providerDiagnostics),
    ]),
  }
}

function normalizeMatrixOffer(cell: MatrixCell, request: SearchRequest): CanonicalOffer {
  const currencyCode = cell.price?.currencyCode ?? "USD"
  const amount = cell.price?.amount ?? 0
  const tooltip = cell.tooltip ? translateApiMessage(cell.tooltip) : undefined

  if (cell.offer) {
    const offer = normalizeOffer(cell.offer)
    return {
      ...offer,
      priceConfidence: cell.confidence || offer.priceConfidence,
      priceStatus: cell.confidence || offer.priceStatus,
      purchasePaths: cell.purchasePaths ?? offer.purchasePaths,
      warnings: uniqueStrings([
        ...(offer.warnings ?? []),
        ...(tooltip && !/live search|exact search/i.test(tooltip) ? [tooltip] : []),
      ]),
    }
  }

  return {
    id: cell.key,
    providerSource: cell.providerSource,
    airline: "Flexible",
    origin: request.origin,
    destination: request.destination,
    departureDate: cell.departureDate,
    returnDate: cell.returnDate,
    arrivalDate: cell.returnDate,
    duration: cell.stayNights ? `${cell.stayNights} noches` : "",
    stops: 0,
    stopMeta: cell.returnDate
      ? `${cell.departureDate} -> ${cell.returnDate}`
      : cell.departureDate,
    baggageLabel: tooltip,
    priceConfidence: cell.confidence,
    priceStatus: cell.confidence,
    purchasePaths: cell.purchasePaths,
    warnings: tooltip ? [tooltip] : undefined,
    price: {
      total: {
        amount,
        currencyCode,
      },
    },
  }
}

function normalizeMatrixJob(data: BackendMatrixJobResponse, sortMode: SortMode): SearchJobResponse {
  const request = fromBackendRequest(data.request)
  const rawWarnings = (data.warnings ?? []).map((warning) => String(warning))
  const rawMetaWarnings = (data.searchMeta?.warnings ?? []).map((warning) => String(warning))
  const rawError = data.error ? [data.error] : []
  const rawCellTooltips = (data.cells ?? []).map((cell) => cell.tooltip).filter((tooltip): tooltip is string => Boolean(tooltip))
  const recommendations = (data.recommendations ?? []).map((recommendation) => translateApiMessage(recommendation))
  const warnings = [
    ...rawWarnings.map((warning) => translateApiMessage(warning)),
    ...rawError.map((warning) => translateApiMessage(warning)),
  ]
  const cells = data.cells ?? []
  const pricedCells = cells.filter((cell) => typeof cell.price?.amount === "number")
  const offers = pricedCells.map((cell) => normalizeMatrixOffer(cell, request))

  return {
    searchJobId: data.matrixJobId,
    searchComplete: data.matrixComplete,
    searchStatus: data.matrixStatus,
    revision: data.revision,
    sortMode,
    request,
    unchanged: data.unchanged,
    offers,
    allOffers: offers,
    searchMeta: data.searchMeta
      ? {
          ...data.searchMeta,
          warnings: rawMetaWarnings.map((warning) => translateApiMessage(warning)),
        }
      : {
          requestedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          providersUsed: [],
          warnings: [],
          partial: !data.matrixComplete,
          searchState: data.matrixComplete ? "search_live" : "search_partial",
        },
    providerMeta: data.providerMeta ?? {
      exactProvider: "agil-local",
      coverageMode: "core",
    },
    warnings: [
      ...warnings,
      ...recommendations,
    ],
    providerDiagnostics: data.providerDiagnostics,
    diagnosticLog: toDiagnosticLines([
      ...rawWarnings,
      ...rawMetaWarnings,
      ...rawError,
      ...rawCellTooltips,
      ...(data.recommendations ?? []),
      ...providerDiagnosticLines(data.providerDiagnostics),
    ]),
  }
}

function migrationMonthRanges(startIso: string | undefined, count = MIGRATION_MONTH_COUNT): MigrationMonthRange[] {
  const firstSearchDate = isIsoDate(startIso) ? startIso : todayIso()
  const firstMonth = firstSearchDate.slice(0, 7)

  return Array.from({ length: count }, (_, index) => {
    const key = addMonths(firstMonth, index)
    const monthStart = `${key}-01`
    const departureStart = index === 0 ? maxIsoDate(monthStart, firstSearchDate) : monthStart

    return {
      key,
      label: formatMigrationMonthLabel(key),
      departureStart,
      departureEnd: monthEndIso(key),
    }
  }).filter((range) => range.departureStart <= range.departureEnd)
}

function migrationRequestForMonth(request: SearchRequest, range: MigrationMonthRange): SearchRequest {
  return {
    ...request,
    tripType: "one-way",
    searchMode: "stay-range",
    departureDate: undefined,
    departureStart: range.departureStart,
    departureEnd: range.departureEnd,
    returnDate: undefined,
    returnStart: undefined,
    returnEnd: undefined,
    flexibleMode: undefined,
    stayNights: undefined,
    maxResults: MIGRATION_MONTH_RESULT_LIMIT,
    compactAllOffers: true,
  }
}

function cheapestOffer(offers: CanonicalOffer[]): CanonicalOffer | undefined {
  return [...offers].sort((left, right) =>
    offerAmount(left) - offerAmount(right)
      || (left.comparisonMetrics?.totalDurationMinutes ?? Number.POSITIVE_INFINITY)
        - (right.comparisonMetrics?.totalDurationMinutes ?? Number.POSITIVE_INFINITY)
  )[0]
}

function normalizeMigrationOffer(offer: CanonicalOffer, range: MigrationMonthRange, job: SearchJobResponse): CanonicalOffer {
  return {
    ...offer,
    id: `migration-${range.key}-${offer.id}`,
    sourceOfferId: offer.sourceOfferId ?? offer.id,
    sourceSearchJobId: offer.sourceSearchJobId ?? job.searchJobId,
    stopMeta: `${range.label} · ${offer.stopMeta || `${offer.origin ?? ""} -> ${offer.destination ?? ""}`}`,
    tags: uniqueStrings(["Migratorio", range.label, ...(offer.tags ?? [])]),
  }
}

function normalizeMigrationOffers(job: SearchJobResponse, range: MigrationMonthRange): CanonicalOffer[] {
  const offers = job.allOffers?.length ? job.allOffers : job.offers
  return offers.map((offer) => normalizeMigrationOffer(offer, range, job))
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0

  async function runner() {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await worker(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner))
  return results
}

function offerAmount(offer: CanonicalOffer) {
  const amount = offer.price?.total?.amount
  return typeof amount === "number" && Number.isFinite(amount) ? amount : Number.POSITIVE_INFINITY
}

function todayIso() {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function addMonths(monthValue: string, delta: number) {
  const [year, month] = monthValue.split("-").map(Number)
  const date = new Date(Date.UTC(year, month - 1 + delta, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`
}

function monthEndIso(monthValue: string) {
  const [year, month] = monthValue.split("-").map(Number)
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}

function maxIsoDate(left: string, right: string) {
  return left > right ? left : right
}

function formatMigrationMonthLabel(monthValue: string) {
  const label = MIGRATION_MONTH_LABEL_FORMATTER.format(new Date(`${monthValue}-01T00:00:00Z`))
  return label.charAt(0).toUpperCase() + label.slice(1)
}

function delay(ms: number, signal?: AbortSignal) {
  throwIfAborted(signal)

  return new Promise<void>((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort)
      resolve()
    }, ms)
    const handleAbort = () => {
      globalThis.clearTimeout(timeout)
      reject(new FlyDeskSearchCancelledError())
    }

    signal?.addEventListener("abort", handleAbort, { once: true })
  })
}

export async function startSearch(
  request: SearchRequest,
  sortMode: SortMode,
  options: SearchRequestOptions = {}
): Promise<SearchJobResponse> {
  const data = await postJson<BackendSearchJobResponse>(`${API_BASE}/api/search`, toBackendPayload(request, sortMode), options)
  if (data.searchJobId) {
    options.onJobStart?.({ id: data.searchJobId, type: "search" })
  }
  return normalizeSearchJob(data)
}

export async function pollSearch(jobId: string, sinceRevision?: number, options: RequestOptions = {}): Promise<SearchJobResponse> {
  let url = `${API_BASE}/api/search/${jobId}`
  if (sinceRevision !== undefined) url += `?sinceRevision=${sinceRevision}`
  const data = await getJson<BackendSearchJobResponse>(url, options)
  return normalizeSearchJob(data)
}

export async function startMatrix(
  request: SearchRequest,
  sortMode: SortMode,
  options: SearchRequestOptions = {}
): Promise<SearchJobResponse> {
  const data = await postJson<BackendMatrixJobResponse>(`${API_BASE}/api/matrix`, toBackendPayload(request, sortMode), options)
  if (data.matrixJobId) {
    options.onJobStart?.({ id: data.matrixJobId, type: "matrix" })
  }
  return normalizeMatrixJob(data, sortMode)
}

export async function pollMatrix(
  jobId: string,
  sortMode: SortMode,
  sinceRevision?: number,
  options: RequestOptions = {}
): Promise<SearchJobResponse> {
  let url = `${API_BASE}/api/matrix/${jobId}`
  if (sinceRevision !== undefined) url += `?sinceRevision=${sinceRevision}`
  const data = await getJson<BackendMatrixJobResponse>(url, options)
  return normalizeMatrixJob(data, sortMode)
}

export async function cancelSearchJob(
  job: { id: string; type: "search" | "matrix" },
  options: { cachePartial?: boolean; keepalive?: boolean } = {}
): Promise<void> {
  const path = job.type === "matrix" ? "matrix" : "search"
  const query = options.cachePartial ? "?cachePartial=1" : ""
  const url = `${API_BASE}/api/${path}/${encodeURIComponent(job.id)}/cancel${query}`
  const payload = {}

  if (options.keepalive) {
    const body = JSON.stringify(payload)
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const sent = navigator.sendBeacon(url, new Blob([body], { type: "application/json" }))
      if (sent) return
    }

    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    })
    return
  }

  await postJson<unknown>(url, payload)
}

export async function startMigrationSearch(
  request: SearchRequest,
  sortMode: SortMode,
  options: SearchRequestOptions = {}
): Promise<SearchJobResponse> {
  const requestedAt = new Date().toISOString()
  const ranges = migrationMonthRanges(request.departureStart ?? request.departureDate)
  const monthResults: MigrationMonthWorkResult[] = ranges.map((range) => ({
    range,
    offers: [],
    warnings: [],
    diagnosticLog: [],
    complete: false,
    status: "loading",
  }))

  const buildMigrationJob = (searchComplete: boolean): SearchJobResponse => {
    const selectedOffers = monthResults.flatMap((result) => result.offer ? [result.offer] : [])
    const allOffers = monthResults.flatMap((result) => result.offers)
    const warnings = uniqueStrings(monthResults.flatMap((result) => result.warnings))
    const diagnosticLog = toDiagnosticLines(monthResults.flatMap((result) => result.diagnosticLog))
    const providerMeta = monthResults.find((result) => result.job?.providerMeta)?.job?.providerMeta ?? {
      exactProvider: "agil-local",
      coverageMode: "core",
    }
    const hasPendingMonth = monthResults.some((result) => !result.complete)
    const monthlyWarnings = searchComplete && selectedOffers.length === 0
      ? uniqueStrings([...warnings, "Migratorio no encontró tarifas disponibles en los próximos 8 meses."])
      : warnings

    return {
      searchJobId: `migration-${requestedAt}`,
      searchComplete,
      searchStatus: searchComplete ? "completed" : "running",
      revision: Math.max(1, ...monthResults.map((result) => result.job?.revision ?? 0)),
      sortMode,
      request,
      offers: selectedOffers,
      allOffers,
      migrationMonths: monthResults.map((result) => ({
        key: result.range.key,
        label: result.range.label,
        departureStart: result.range.departureStart,
        departureEnd: result.range.departureEnd,
        searchJobId: result.job?.searchJobId,
        offer: result.offer,
        offers: result.offers,
        warnings: result.warnings,
        status: result.status,
      })),
      searchMeta: {
        requestedAt,
        completedAt: searchComplete ? new Date().toISOString() : "",
        providersUsed: uniqueStrings(monthResults.flatMap((result) => result.job?.searchMeta?.providersUsed ?? [])),
        warnings: monthlyWarnings,
        partial: hasPendingMonth || monthResults.some((result) => result.status === "partial" || result.status === "error"),
        searchState: searchComplete && !hasPendingMonth ? "search_live" : "search_partial",
      },
      providerMeta,
      warnings: monthlyWarnings,
      diagnosticLog,
    }
  }

  const emitProgress = () => {
    options.onMigrationProgress?.(buildMigrationJob(false))
  }

  emitProgress()

  await runWithConcurrency(
    ranges,
    MIGRATION_CONCURRENT_REQUESTS,
    async (range, index) => {
      try {
        throwIfAborted(options.signal)
        let job = await startSearch(migrationRequestForMonth(request, range), "cheapest", options)
        let lastRevision = job.revision

        for (let attempt = 0; attempt <= MIGRATION_POLL_LIMIT; attempt += 1) {
          const offers = normalizeMigrationOffers(job, range)
          const offer = cheapestOffer(offers)
          monthResults[index] = {
            range,
            job,
            offer,
            offers,
            warnings: uniqueStrings([...(job.warnings ?? []), ...(job.searchMeta?.warnings ?? [])]),
            diagnosticLog: job.diagnosticLog ?? [],
            complete: job.searchComplete,
            status: offer
              ? job.searchComplete ? "available" : "partial"
              : job.searchComplete ? "empty" : "loading",
          }
          emitProgress()

          if (job.searchComplete || attempt === MIGRATION_POLL_LIMIT) break

          await delay(MIGRATION_POLL_INTERVAL_MS, options.signal)
          const polled = await pollSearch(job.searchJobId, lastRevision, options)
          if (!polled.unchanged) {
            job = polled
            lastRevision = polled.revision
          }
        }
      } catch (error) {
        if (error instanceof FlyDeskSearchCancelledError) {
          throw error
        }

        monthResults[index] = {
          range,
          offers: [],
          warnings: [`${range.label}: ${userMessageFromError(error)}`],
          diagnosticLog: diagnosticLogFromError(error).map((line) => `${range.label}: ${line}`),
          complete: true,
          status: "error",
        }
        emitProgress()
      }
    }
  )

  const finalJob = buildMigrationJob(true)
  options.onMigrationProgress?.(finalJob)
  return finalJob
}

export async function fetchQuotation(input: {
  searchSessionId?: string
  offerId?: string
  offer: CanonicalOffer
  request: SearchRequest
}) {
  return postJson<{ commercialText: string; offer: unknown }>(`${API_BASE}/api/quotation`, {
    searchSessionId: input.searchSessionId,
    offerId: input.offerId,
    offer: input.offer,
    request: toBackendPayload(input.request, input.request.sortMode === "cheapest" || input.request.sortMode === "fastest"
      ? input.request.sortMode
      : "cheapest").request,
  })
}
