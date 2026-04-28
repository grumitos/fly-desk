import type { CanonicalOffer, LocationSuggestion, MatrixCell, SearchRequest, SearchJobResponse, SortMode } from "@/types"
import { filterLocationSuggestions, normalizeLocationSearchText, normalizeLocationSuggestions } from "@/lib/locations"

const API_BASE = ""
const MIGRATION_MONTH_COUNT = 8
const MIGRATION_CONCURRENT_REQUESTS = 2
const MIGRATION_POLL_INTERVAL_MS = 900
const MIGRATION_POLL_LIMIT = 90
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

type MigrationMonthRange = {
  key: string
  label: string
  departureStart: string
  departureEnd: string
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
    "Return date is required for round-trip exact search.": "Selecciona una fecha de regreso.",
    "Return date must be after departure date.": "La fecha de regreso debe ser posterior a la salida.",
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
    return "Agil no devolvió ofertas para esta búsqueda."
  }

  if (/^Costamar returned no offers/i.test(normalized)) {
    return "Costamar no devolvió ofertas para esta búsqueda."
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
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

export function diagnosticLogFromError(error: unknown): string[] {
  if (error instanceof FlyDeskApiError) {
    return error.diagnosticLog
  }

  if (error instanceof Error) {
    return toDiagnosticLines([error.message])
  }

  return toDiagnosticLines([String(error)])
}

export function userMessageFromError(error: unknown): string {
  if (error instanceof FlyDeskApiError) {
    return error.message
  }

  return "No se pudo completar la búsqueda. Intenta nuevamente."
}

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    throw new FlyDeskApiError("No se pudo conectar con Fly Desk. Intenta nuevamente.", diagnosticLogFromError(error))
  }
  const data = await readJsonBody(res)
  if (!res.ok) throw new FlyDeskApiError(apiErrorMessage(data), buildHttpDiagnosticLog(url, res, data))
  return data as T
}

async function getJson<T>(url: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(url)
  } catch (error) {
    throw new FlyDeskApiError("No se pudo conectar con Fly Desk. Intenta nuevamente.", diagnosticLogFromError(error))
  }
  const data = await readJsonBody(res)
  if (!res.ok) throw new FlyDeskApiError(apiErrorMessage(data), buildHttpDiagnosticLog(url, res, data))
  return data as T
}

export async function suggestLocations(query: string, limit = 8): Promise<LocationSuggestion[]> {
  if (query.length < 2) return []
  const data = await getJson<{ suggestions: LocationSuggestion[] }>(
    `${API_BASE}/api/locations?q=${encodeURIComponent(query)}&limit=${limit}`
  )
  const suggestions = normalizeLocationSuggestions(data.suggestions)
  rememberLocationSuggestions(query, limit, suggestions)
  return suggestions
}

export function getCachedLocationSuggestions(query: string, limit = 8): LocationSuggestion[] {
  if (query.length < 2) return []
  const key = locationSuggestionCacheKey(query, limit)
  return locationSuggestionCache.get(key) ?? filterLocationSuggestions(query, [...locationSuggestionPool.values()], limit)
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

type BackendSearchJobResponse = Omit<SearchJobResponse, "request" | "offers" | "allOffers"> & {
  request?: {
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
    }
  }
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
}

function toBackendPayload(request: SearchRequest, sortMode: SortMode) {
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
      },
      currencyCode: "USD",
      locale: "es-PE",
      market: "PE",
    },
  }
}

function fromBackendRequest(request: BackendSearchJobResponse["request"]): SearchRequest {
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
  }
}

function firstSegment(offer: Record<string, unknown>, direction: "outbound" | "inbound") {
  const itineraries = Array.isArray(offer.itineraries) ? offer.itineraries as Array<Record<string, unknown>> : []
  const itinerary = itineraries.find((item) => item.direction === direction)
    ?? (direction === "outbound" ? itineraries[0] : itineraries[1])
  const segments = Array.isArray(itinerary?.segments) ? itinerary.segments as Array<Record<string, unknown>> : []
  return segments[0]
}

function durationLabel(minutes: unknown): string {
  const value = typeof minutes === "number" ? minutes : Number(minutes)
  if (!Number.isFinite(value) || value <= 0) return ""
  const hours = Math.floor(value / 60)
  const mins = Math.round(value % 60)
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

function baggageLabel(baggage: unknown): string | undefined {
  if (!baggage) return undefined
  if (typeof baggage === "string") return baggage
  if (typeof baggage !== "object") return undefined

  const value = baggage as CanonicalOffer["baggage"]
  const parts: string[] = []
  if (value?.carryOnIncluded) parts.push("Cabina")
  if (value?.checkedIncluded) {
    parts.push(value.checkedBags && value.checkedBags > 1 ? `${value.checkedBags} maletas` : "Bodega")
  }
  if (!parts.length && value?.description) return value.description
  return parts.length ? parts.join(" + ") : undefined
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
  const metrics = offer.comparisonMetrics && typeof offer.comparisonMetrics === "object"
    ? offer.comparisonMetrics as Record<string, unknown>
    : {}
  const outbound = firstSegment(offer, "outbound")
  const inbound = firstSegment(offer, "inbound")
  const price = offer.price && typeof offer.price === "object"
    ? offer.price as CanonicalOffer["price"]
    : { total: { amount: 0, currencyCode: "USD" } }
  const warnings = Array.isArray(offer.warnings)
    ? uniqueStrings(offer.warnings.map((warning) => translateApiMessage(String(warning))))
    : undefined

  return {
    ...(offer as Partial<CanonicalOffer>),
    id: String(offer.id ?? crypto.randomUUID()),
    providerSource: String(offer.providerSource ?? ""),
    airline: String(offer.mainCarrier ?? offer.validatingCarrier ?? offer.airline ?? ""),
    origin: typeof offer.origin === "string" ? offer.origin : String(outbound?.origin ?? ""),
    destination: typeof offer.destination === "string" ? offer.destination : String(outbound?.destination ?? ""),
    departureDate: String(outbound?.departureAt ?? offer.departureDate ?? ""),
    arrivalDate: typeof outbound?.arrivalAt === "string" ? outbound.arrivalAt : undefined,
    returnDate: typeof inbound?.departureAt === "string" ? inbound.departureAt : offer.returnDate as string | undefined,
    duration: durationLabel(metrics.totalDurationMinutes),
    stops: typeof metrics.totalStops === "number" ? metrics.totalStops : Number(offer.stops ?? 0),
    stopMeta: `${String(outbound?.origin ?? "")} -> ${String(outbound?.destination ?? "")}`,
    baggage: typeof offer.baggage === "object" && offer.baggage ? offer.baggage as CanonicalOffer["baggage"] : undefined,
    baggageLabel: baggageLabel(offer.baggage),
    hasCheckedBaggage: hasCheckedBaggage(offer.baggage),
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
    diagnosticLog: toDiagnosticLines([...rawWarnings, ...rawMetaWarnings, ...rawWarningsFromOffers]),
  }
}

function normalizeMatrixOffer(cell: MatrixCell, request: SearchRequest): CanonicalOffer {
  const currencyCode = cell.price?.currencyCode ?? "USD"
  const amount = cell.price?.amount ?? 0
  const departureAt = `${cell.departureDate}T00:00:00Z`
  const returnAt = cell.returnDate ? `${cell.returnDate}T00:00:00Z` : undefined
  const tooltip = cell.tooltip ? translateApiMessage(cell.tooltip) : undefined

  return {
    id: cell.key,
    providerSource: cell.providerSource,
    airline: "Flexible",
    origin: request.origin,
    destination: request.destination,
    departureDate: departureAt,
    returnDate: returnAt,
    arrivalDate: returnAt,
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
    diagnosticLog: toDiagnosticLines([
      ...rawWarnings,
      ...rawMetaWarnings,
      ...rawError,
      ...rawCellTooltips,
      ...(data.recommendations ?? []),
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
  }
}

async function settleSearchJob(job: SearchJobResponse): Promise<SearchJobResponse> {
  let current = job

  for (let attempt = 0; attempt < MIGRATION_POLL_LIMIT && !current.searchComplete; attempt += 1) {
    await delay(MIGRATION_POLL_INTERVAL_MS)
    current = await pollSearch(job.searchJobId)
  }

  return current
}

function cheapestOffer(job: SearchJobResponse): CanonicalOffer | undefined {
  const offers = job.allOffers?.length ? job.allOffers : job.offers
  return [...offers].sort((left, right) => offerAmount(left) - offerAmount(right))[0]
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

function delay(ms: number) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms))
}

export async function startSearch(request: SearchRequest, sortMode: SortMode): Promise<SearchJobResponse> {
  const data = await postJson<BackendSearchJobResponse>(`${API_BASE}/api/search`, toBackendPayload(request, sortMode))
  return normalizeSearchJob(data)
}

export async function pollSearch(jobId: string, sinceRevision?: number): Promise<SearchJobResponse> {
  let url = `${API_BASE}/api/search/${jobId}`
  if (sinceRevision !== undefined) url += `?sinceRevision=${sinceRevision}`
  const data = await getJson<BackendSearchJobResponse>(url)
  return normalizeSearchJob(data)
}

export async function startMatrix(request: SearchRequest, sortMode: SortMode): Promise<SearchJobResponse> {
  const data = await postJson<BackendMatrixJobResponse>(`${API_BASE}/api/matrix`, toBackendPayload(request, sortMode))
  return normalizeMatrixJob(data, sortMode)
}

export async function startMigrationSearch(request: SearchRequest, sortMode: SortMode): Promise<SearchJobResponse> {
  const requestedAt = new Date().toISOString()
  const ranges = migrationMonthRanges(request.departureStart ?? request.departureDate)
  const monthResults = await runWithConcurrency(
    ranges,
    MIGRATION_CONCURRENT_REQUESTS,
    async (range) => {
      try {
        const initial = await startSearch(migrationRequestForMonth(request, range), "cheapest")
        const job = await settleSearchJob(initial)
        const offer = cheapestOffer(job)

        return {
          range,
          job,
          offer: offer ? normalizeMigrationOffer(offer, range, job) : undefined,
          warnings: uniqueStrings([...(job.warnings ?? []), ...(job.searchMeta?.warnings ?? [])]),
          diagnosticLog: job.diagnosticLog ?? [],
          complete: job.searchComplete,
        }
      } catch (error) {
        return {
          range,
          job: undefined,
          offer: undefined,
          warnings: [`${range.label}: ${userMessageFromError(error)}`],
          diagnosticLog: diagnosticLogFromError(error).map((line) => `${range.label}: ${line}`),
          complete: false,
        }
      }
    }
  )
  const offers = monthResults.flatMap((result) => result.offer ? [result.offer] : [])
  const warnings = uniqueStrings(monthResults.flatMap((result) => result.warnings))
  const diagnosticLog = toDiagnosticLines(monthResults.flatMap((result) => result.diagnosticLog))
  const providerMeta = monthResults.find((result) => result.job?.providerMeta)?.job?.providerMeta ?? {
    exactProvider: "agil-local",
    coverageMode: "core",
  }
  const completedAt = new Date().toISOString()
  const monthlyWarnings = offers.length
    ? warnings
    : uniqueStrings([...warnings, "Migratorio no encontró tarifas disponibles en los próximos 8 meses."])

  return {
    searchJobId: `migration-${Date.now()}`,
    searchComplete: true,
    searchStatus: "completed",
    revision: Math.max(1, ...monthResults.map((result) => result.job?.revision ?? 0)),
    sortMode,
    request,
    offers,
    allOffers: offers,
    searchMeta: {
      requestedAt,
      completedAt,
      providersUsed: uniqueStrings(monthResults.flatMap((result) => result.job?.searchMeta?.providersUsed ?? [])),
      warnings: monthlyWarnings,
      partial: monthResults.some((result) => !result.complete),
      searchState: monthResults.some((result) => !result.complete) ? "search_partial" : "search_live",
    },
    providerMeta,
    warnings: monthlyWarnings,
    diagnosticLog,
  }
}

export async function pollMatrix(jobId: string, sortMode: SortMode, sinceRevision?: number): Promise<SearchJobResponse> {
  let url = `${API_BASE}/api/matrix/${jobId}`
  if (sinceRevision !== undefined) url += `?sinceRevision=${sinceRevision}`
  const data = await getJson<BackendMatrixJobResponse>(url)
  return normalizeMatrixJob(data, sortMode)
}

export async function fetchQuotation(searchSessionId: string, offerId: string) {
  return postJson<{ commercialText: string; offer: unknown }>(`${API_BASE}/api/quotation`, {
    searchSessionId,
    offerId,
  })
}
