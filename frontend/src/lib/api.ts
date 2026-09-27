import type {
  CanonicalOffer,
  LocationSuggestion,
  MatrixCell,
  MigrationMonthSummary,
  ProviderDiagnostics,
  SearchRequest,
  SearchJobResponse,
  SortMode,
} from "@/types"
import { normalizeAirlineDisplayName, resolveAirlineDisplayName } from "@/lib/airline-names"
import { getBrowserClientSessionId } from "@/lib/browser-client-session"
import { formatCount, monthCaption } from "@/lib/format"
import { addMonths, isIsoDate, isIsoMonth, lastDayOfMonth, maxIsoDate } from "@/lib/iso-date"
import { normalizeLocationSuggestions } from "@/lib/locations"
import {
  POLL_FAST_MS,
  POLL_LONG_WAIT_MS,
  POLL_MAX_CONSECUTIVE_FAILURES,
  POLL_RETRY_DELAY_MS,
  nextPollDelayMs,
} from "@/lib/poll-schedule"
import { providerDisplayName } from "@/lib/providers"
import {
  firstSegmentForItinerary,
  lastSegmentForItinerary,
  primaryItineraryForOffer,
  returnItineraryForOffer,
} from "@/lib/offer-display"
import { MIGRATION_CONCURRENT_MONTHS, deskToday } from "@/lib/runtime-config"
import { offerAirlineCode } from "../../../src/core/filtering"
import { normalizeLocationSearchText, rankLocationSuggestions } from "../../../src/core/location-ranking"
import { compareOffers } from "../../../src/core/ranking"

/* 06 §6: the sweep reaches twelve months, the length of the search window. */
export const MIGRATION_MONTH_LIMIT = 12
const LOCATION_SUGGESTION_CACHE_LIMIT = 100
const LOCATION_SUGGESTION_POOL_LIMIT = 500
const locationSuggestionCache = new Map<string, LocationSuggestion[]>()
const locationSuggestionPool = new Map<string, LocationSuggestion>()
const locationRequestsInFlight = new Map<string, Promise<LocationSuggestion[]>>()

class FlyDeskApiError extends Error {
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

/* A 401 from our own API: nothing the page can do fixes it, so polls stop
   retrying instead of spending their attempts on it. */
class FlyDeskSessionExpiredError extends FlyDeskApiError {
  constructor(diagnosticLog: string[]) {
    super("La sesión expiró. Te llevamos al acceso.", diagnosticLog)
    this.name = "FlyDeskSessionExpiredError"
  }
}

/* Every poll in flight sees the same 401 before the page unloads; only the
   first one navigates. */
let redirectingToLogin = false

function isOwnApiRequest(url: string): boolean {
  if (typeof window === "undefined") {
    return false
  }

  try {
    const parsed = new URL(url, window.location.origin)
    return parsed.origin === window.location.origin && parsed.pathname.startsWith("/api/")
  } catch {
    return false
  }
}

function redirectToLogin(): void {
  if (redirectingToLogin || typeof window === "undefined") {
    return
  }

  const { pathname, search } = window.location
  if (pathname === "/login") {
    return
  }

  redirectingToLogin = true
  const next = `${pathname}${search}`
  window.location.assign(next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`)
}

function sessionExpiredError(url: string, res: Response, data: unknown): FlyDeskSessionExpiredError | undefined {
  if (res.status !== 401 || !isOwnApiRequest(url)) {
    return undefined
  }

  redirectToLogin()
  return new FlyDeskSessionExpiredError(buildHttpDiagnosticLog(url, res, data))
}

type QuotationRequest = {
  searchSessionId: string
  offerId: string
  migrationPlan?: boolean
}

type QuotationResponse = {
  searchSessionId: string
  offer: CanonicalOffer
  commercialText: string
}

type ActiveJob = { id: string; type: "search" | "matrix" }

/* Starting requests take no abort signal: a POST the server has accepted
   creates a job, and the only way to stop that job is to learn its id. */
type StartOptions = {
  onJobStart?: (job: ActiveJob) => void
  recordLocationUsage?: boolean
}

type MigrationOptions = StartOptions & {
  signal?: AbortSignal
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

const EXACT_TRANSLATIONS: Record<string, string> = {
  "Origin is required and must be a three-letter IATA code.": "Ingresa un origen válido.",
  "Destination is required and must be a three-letter IATA code.": "Ingresa un destino válido.",
  "Origin and destination must be different.": "El origen y el destino deben ser diferentes.",
  "Multi-city search is not supported.": "La búsqueda multidestino aún no está disponible.",
  "Adults must be a non-negative integer.": "La cantidad de adultos debe ser válida.",
  "Children must be a non-negative integer.": "La cantidad de niños debe ser válida.",
  "Infants must be a non-negative integer.": "La cantidad de bebés debe ser válida.",
  "At least one adult is required.": "Debe viajar al menos un adulto.",
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
  "Click and Book Plus terminalId is required.": "Falta configurar el terminal de Click and Book Plus.",
  "searchSessionId and offerId are required.": "Falta la sesión de búsqueda o la oferta.",
  "Session or offer not found.": "No se encontró la sesión o la oferta.",
  "Search job not found.": "No se encontró la búsqueda.",
  "Matrix job not found.": "No se encontró la matriz de búsqueda.",
  "Purchase path not found.": "No se encontró el enlace de compra.",
  "Purchase path is unavailable.": "El enlace de compra ya no está disponible.",
  "Not found": "No encontrado.",
  "Invalid JSON payload.": "La solicitud enviada no es válida.",
  "Authentication required.": "Inicia sesión para continuar.",
  "AGIL_TOKEN_EXPIRED": "La sesión de Agilsmart venció. Vuelve a iniciar sesión en Agilsmart e intenta nuevamente.",
  "Agil exact search.": "Búsqueda exacta en Agilsmart.",
  "Agil returned no live result for this combination.": "Agilsmart no devolvió una tarifa disponible para esta combinación.",
  "Click and Book Plus live search.": "Búsqueda en vivo de Click and Book Plus.",
  "Click and Book Plus returned no live result for this combination.": "Click and Book Plus no devolvió una tarifa disponible para esta combinación.",
  "Consultando Agil...": "Consultando Agilsmart...",
  "Consultando Click and Book Plus...": "Consultando Click and Book Plus...",
  /* The router's draft warnings, on the first response of every job: without
     them a month still being queried reads as a failure. */
  "Consultando Agil y Click and Book Plus.": "Consultando Agilsmart y Click and Book Plus.",
  "Consultando Agil.": "Consultando Agilsmart.",
  "Consultando Click and Book Plus.": "Consultando Click and Book Plus.",
  "Consultando Agil. Los resultados se iran agregando.": "Consultando Agilsmart. Los resultados se irán agregando.",
  "Consultando Agil en paralelo. Los resultados se iran agregando.": "Consultando Agilsmart. Los resultados se irán agregando.",
  "Consultando Click and Book Plus. Los resultados se iran agregando.": "Consultando Click and Book Plus. Los resultados se irán agregando.",
  "Consultando Click and Book Plus en paralelo. Los resultados se iran agregando.": "Consultando Click and Book Plus. Los resultados se irán agregando.",
  "Mostrando resultados cacheados mientras actualizamos en segundo plano.": "Mostrando resultados cacheados mientras actualizamos en segundo plano.",
  "Matrix loading from Agil in parallel.": "Agilsmart está consultando la matriz.",
  "Matrix finished with partial Agil failures.": "Agilsmart completó la matriz con resultados parciales.",
  "Matrix built from Agil exact searches in parallel.": "Matriz creada con búsquedas exactas de Agilsmart.",
  "Selecting a cell runs a full Agil exact search for offers.": "Selecciona una fecha para ver las ofertas disponibles.",
  "Matrix loading from Click and Book Plus with useful date combinations only.": "Click and Book Plus está consultando la matriz.",
  "Matrix finished with partial Click and Book Plus failures.": "Click and Book Plus completó la matriz con resultados parciales.",
  "Matrix seeded from Click and Book Plus native flexible search and completed with exact searches.": "Matriz creada con búsquedas de Click and Book Plus.",
  "Matrix built from Click and Book Plus exact searches over useful date combinations.": "Matriz creada con búsquedas exactas de Click and Book Plus.",
  "Matrix keeps only useful date combinations based on the requested stay window.": "La matriz conserva las combinaciones útiles para la estadía solicitada.",
  "Selecting a cell runs a full Click and Book Plus exact search for offers.": "Selecciona una fecha para ver las ofertas disponibles.",
  "Search cancelled by user.": "Búsqueda detenida por el usuario.",
  "Search stopped because Fly Desk was restarted.": "Búsqueda detenida por reinicio de Fly Desk.",
  "Search stopped because its page stopped following it.": "Búsqueda detenida porque la página dejó de seguirla.",
  "Search failed unexpectedly.": "La búsqueda se detuvo por un error inesperado. Intenta nuevamente.",
}

/* `validateSearchDateInPolicy` labels every date field of the request. */
const DATE_FIELD_LABELS: Record<string, { label: string; feminine: boolean }> = {
  "Departure date": { label: "La fecha de salida", feminine: true },
  "Return date": { label: "La fecha de regreso", feminine: true },
  "Departure start": { label: "El inicio del rango de salida", feminine: false },
  "Departure end": { label: "El fin del rango de salida", feminine: false },
  "Return start": { label: "El inicio del rango de regreso", feminine: false },
  "Return end": { label: "El fin del rango de regreso", feminine: false },
}

function translateApiMessage(message: string): string {
  const normalized = stripAnsi(String(message)).replace(/\s+/g, " ").trim()

  const exact = EXACT_TRANSLATIONS[normalized]
  if (exact) return exact

  /* The ceilings carry their number, so they are matched by pattern and a
     lowered backend ceiling keeps translating. */
  const passengerCap = normalized.match(/^Passenger count cannot exceed (\d+)\.$/)
  if (passengerCap) {
    return `La búsqueda admite hasta ${passengerCap[1]} pasajeros.`
  }

  const stayCap = normalized.match(/^Stay length cannot exceed (\d+) nights?\.$/)
  if (stayCap) {
    return `La estadía máxima es de ${stayCap[1]} ${stayCap[1] === "1" ? "noche" : "noches"}.`
  }

  const lapInfantCap = normalized.match(/^Lap infants cannot exceed (\d+) per adult\.$/)
  if (lapInfantCap) {
    const infants = lapInfantCap[1] === "1" ? "un bebé" : `${lapInfantCap[1]} bebés`
    return `Se admite ${infants} en falda por adulto.`
  }

  const combinationCap = normalized.match(
    /^Round-trip (?:matrix|range) search cannot exceed (\d+) combinations\. Narrow the departure or return ranges\.$/,
  )
  if (combinationCap) {
    return `El rango pedido supera las ${formatCount(Number(combinationCap[1]))} combinaciones. Estrecha el rango de salida o el de regreso.`
  }

  /* `providerPublicFailureMessage`: the two provider labels plus its fallback. */
  const providerFailure = normalized.match(
    /^(Agilsmart|Click and Book Plus|Provider) (authentication or session is unavailable|is temporarily unavailable|request timed out|returned an invalid response|request failed)\.$/,
  )
  if (providerFailure) {
    const provider = providerFailure[1] === "Provider" ? "El proveedor" : providerFailure[1]
    switch (providerFailure[2]) {
      case "authentication or session is unavailable":
        return `${provider} no tiene una sesión activa. Vuelve a iniciar sesión e intenta nuevamente.`
      case "is temporarily unavailable":
        return `${provider} no está disponible por ahora. Intenta nuevamente en unos minutos.`
      case "request timed out":
        return `${provider} tardó demasiado en responder. Intenta nuevamente.`
      case "returned an invalid response":
        return `${provider} devolvió una respuesta que no se pudo leer. Intenta nuevamente.`
      default:
        return `No se pudo consultar ${provider === "El proveedor" ? "el proveedor" : provider}. Intenta nuevamente.`
    }
  }

  const invalidDate = normalized.match(/^((?:Departure|Return) (?:date|start|end)) must be a valid ISO date \(YYYY-MM-DD\)\.$/)
  const invalidField = invalidDate ? DATE_FIELD_LABELS[invalidDate[1]!] : undefined
  if (invalidField) {
    return `${invalidField.label} no es ${invalidField.feminine ? "válida" : "válido"}.`
  }

  const dateBound = normalized.match(/^((?:Departure|Return) (?:date|start|end)) must be on (or after|or before) ([0-9-]+)\.$/)
  const boundField = dateBound ? DATE_FIELD_LABELS[dateBound[1]!] : undefined
  if (dateBound && boundField) {
    const relation = dateBound[2] === "or after" ? "igual o posterior" : "igual o anterior"
    return `${boundField.label} debe ser ${relation} a ${dateBound[3]}.`
  }

  if (normalized.includes("localhost access or a valid API token")) {
    return "Esta acción requiere acceso local o un token válido."
  }

  if (normalized.includes("Unable to extract Agil session from Chrome profiles")) {
    return "No se pudo leer la sesión local de Agilsmart. Abre Agilsmart en Chrome con la sesión activa y vuelve a intentar."
  }

  if (normalized.includes("byte limit")) {
    return "La solicitud es demasiado grande."
  }

  if (normalized.includes("AGIL_APIM_SUBSCRIPTION_KEY")) {
    return "No se pudo consultar Agilsmart por una configuración local incompleta."
  }

  if (/^Agil returned no offers/i.test(normalized)) {
    return "Agilsmart no devolvió vuelos para esta búsqueda."
  }

  if (/^Click and Book Plus returned no offers/i.test(normalized)) {
    return "Click and Book Plus no devolvió vuelos para esta búsqueda."
  }

  if (/^Agil exact search/i.test(normalized)) {
    return "Búsqueda exacta en Agilsmart."
  }

  if (/Agil/i.test(normalized) && /(failed|error|omitted|rejected|Internal Server Error|500|401|403|expired|session|sesión)/i.test(normalized)) {
    return "No se pudo consultar Agilsmart. Verifica que la sesión esté activa e intenta nuevamente."
  }

  if (/(Costamar|Click and Book Plus)/i.test(normalized) && /(failed|error|token|auth|login|session|sesión|401|403|500|expired|challenge)/i.test(normalized)) {
    return "No se pudo consultar Click and Book Plus. Verifica la autenticación e intenta nuevamente."
  }

  return normalized ? "No se pudo completar la operación. Intenta nuevamente." : "Ocurrió un error inesperado."
}

/* Provenance notes the providers attach to every offer; the card already
   names the provider. Checked before and after translation. */
const REDUNDANT_OFFER_WARNINGS = [
  /^agil exact search(\.|$)/,
  /^click and book plus live search(\.|$)/,
  /^busqueda exacta en agilsmart(\.|$)/,
  /^busqueda en vivo de click and book plus(\.|$)/,
]

function isRedundantOfferWarning(message: string): boolean {
  const normalized = stripAnsi(message)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()

  return REDUNDANT_OFFER_WARNINGS.some((pattern) => pattern.test(normalized))
}

function translatedOfferWarnings(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined

  const warnings = uniqueStrings(input.map((warning) => translateApiMessage(String(warning))))
    .filter((warning) => !isRedundantOfferWarning(warning))

  return warnings.length ? warnings : undefined
}

function translatedMatrixTooltipWarning(tooltip: unknown): string | undefined {
  if (typeof tooltip !== "string") return undefined
  if (!tooltip || isRedundantOfferWarning(tooltip)) return undefined

  const translated = translateApiMessage(tooltip)
  return isRedundantOfferWarning(translated) ? undefined : translated
}

function stripAnsi(value: string) {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "")
}

function redactDiagnosticMessage(message: string): string {
  return stripAnsi(message)
    .replace(/otpauth(?:-migration)?:\/\/[^\s,;]+/gi, "otpauth://[redactado]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redactado]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[jwt redactado]")
    .replace(/[A-Za-z]:\\[^\n\r;]*(?:Chrome|User Data|Profile|Local State)[^\n\r;]*/gi, "[ruta local redactada]")
    .replace(/\/(?:Users|home)\/[^\n\r;]*(?:Chrome|User Data|Profile|Local State)[^\n\r;]*/gi, "[ruta local redactada]")
    .replace(
      /((?:AGIL_APIM_SUBSCRIPTION_KEY|CBPLUS_TOKEN|CBPLUS_B2B_PASSWORD|CBPLUS_B2B_TOTP_SECRET|CBPLUS_B2B_TOTP_URI|COSTAMAR_TOKEN|COSTAMAR_B2B_PASSWORD|COSTAMAR_B2B_TOTP_SECRET|COSTAMAR_B2B_TOTP_URI|FLY_DESK_API_TOKEN|FLY_DESK_WEB_SESSION_SECRET|Authorization|Cookie|Set-Cookie|X-Api-Key|api[-_]?key|subscription[-_]?key|localStorage(?:\.[A-Za-z0-9_-]+)?|sessionStorage(?:\.[A-Za-z0-9_-]+)?|token|secret|password|passwd|pwd|totp|otp))(\s*[:=]\s*)(["']?)([^"',;\s]+)/gi,
      "$1$2$3[redactado]",
    )
}

export function uniqueStrings(values: Array<string | undefined>): string[] {
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
      redactDiagnosticMessage(message)
        .split(/\n+/)
        .map((line) => line.trim())
    )),
  )
}

function providerDiagnosticLines(
  diagnostics: SearchJobResponse["providerDiagnostics"] | undefined
): string[] {
  return (diagnostics ?? []).flatMap((entry) => {
    const provider = providerDisplayName(entry.providerId)
    const summary = [
      `${provider} ${entry.kind}: ${entry.status}`,
      typeof entry.offers === "number" ? `${entry.offers} resultado${entry.offers === 1 ? "" : "s"}` : "",
      typeof entry.warningCount === "number" ? `${entry.warningCount} alerta${entry.warningCount === 1 ? "" : "s"}` : "",
      entry.partial ? "parcial" : "",
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

function apiErrorMessage(data: unknown): string {
  const translated = uniqueStrings(apiRawMessages(data).map((message) => translateApiMessage(message)))
  return translated.length > 0 ? translated.join("\n") : "Ocurrió un error inesperado."
}

function buildHttpDiagnosticLog(url: string, response: Response, data: unknown): string[] {
  return toDiagnosticLines([
    `HTTP ${response.status} ${response.statusText} ${url}`,
    ...apiRawMessages(data),
  ])
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
  if (error instanceof FlyDeskSearchCancelledError || error instanceof FlyDeskApiError) {
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
  return error instanceof Error && error.name === "AbortError"
}

async function requestJson<T>(url: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal)
  let data: unknown
  let res: Response
  try {
    res = await fetch(url, { ...init, signal })
    const text = await res.text()
    try {
      data = text ? JSON.parse(text) : undefined
    } catch {
      data = undefined
    }
  } catch (error) {
    if (isAbortLikeError(error) || signal?.aborted) {
      throw new FlyDeskSearchCancelledError()
    }

    throw new FlyDeskApiError("No se pudo conectar con Fly Desk. Intenta nuevamente.", diagnosticLogFromError(error))
  }
  throwIfAborted(signal)
  if (!res.ok) throw sessionExpiredError(url, res, data) ?? new FlyDeskApiError(apiErrorMessage(data), buildHttpDiagnosticLog(url, res, data))
  if (data === undefined) throw new FlyDeskApiError("El servidor devolvió una respuesta no válida.", buildHttpDiagnosticLog(url, res, data))
  return data as T
}

function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  return requestJson<T>(url, {}, signal)
}

function postJson<T>(url: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  return requestJson<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, signal)
}

/* Concurrent resolutions of one query (a field and its blur, two seeds in a
   row) share one request. */
export function suggestLocations(query: string, limit = 8): Promise<LocationSuggestion[]> {
  if (query.trim().length < 1) return Promise.resolve([])
  const key = locationSuggestionCacheKey(query, limit)
  const inFlight = locationRequestsInFlight.get(key)
  if (inFlight) return inFlight

  const request = fetchLocationSuggestions(query, limit).finally(() => locationRequestsInFlight.delete(key))
  locationRequestsInFlight.set(key, request)
  return request
}

async function fetchLocationSuggestions(query: string, limit: number): Promise<LocationSuggestion[]> {
  const clientSessionId = getBrowserClientSessionId()
  const sessionQuery = clientSessionId
    ? `&clientSessionId=${encodeURIComponent(clientSessionId)}`
    : ""
  const data = await getJson<{ suggestions: LocationSuggestion[] }>(
    `/api/locations?q=${encodeURIComponent(query)}&limit=${limit}${sessionQuery}`
  )
  const suggestions = normalizeLocationSuggestions(data.suggestions)
  const rankedSuggestions = rankLocationSuggestions(query, suggestions, limit)
  rememberLocationSuggestions(query, limit, rankedSuggestions)
  return rankedSuggestions
}

export function getCachedLocationSuggestions(query: string, limit = 8): LocationSuggestion[] {
  if (query.trim().length < 1) return []
  const key = locationSuggestionCacheKey(query, limit)
  const cached = locationSuggestionCache.get(key)
  if (cached) {
    locationSuggestionCache.delete(key)
    locationSuggestionCache.set(key, cached)
    return cached
  }

  return normalizeLocationSearchText(query)
    ? rankLocationSuggestions(query, [...locationSuggestionPool.values()], limit)
    : []
}

function rememberLocationSuggestions(query: string, limit: number, suggestions: LocationSuggestion[]) {
  const key = locationSuggestionCacheKey(query, limit)
  locationSuggestionCache.delete(key)
  locationSuggestionCache.set(key, suggestions)
  trimOldestEntries(locationSuggestionCache, LOCATION_SUGGESTION_CACHE_LIMIT)

  for (const suggestion of suggestions) {
    const id = [
      suggestion.code,
      normalizeLocationSearchText(suggestion.city),
      normalizeLocationSearchText(suggestion.country),
    ].filter(Boolean).join("|")
    if (!id) continue
    locationSuggestionPool.delete(id)
    locationSuggestionPool.set(id, suggestion)
  }
  trimOldestEntries(locationSuggestionPool, LOCATION_SUGGESTION_POOL_LIMIT)
}

function trimOldestEntries<K, V>(map: Map<K, V>, limit: number) {
  while (map.size > limit) {
    const oldestKey = map.keys().next().value
    if (oldestKey === undefined) return
    map.delete(oldestKey)
  }
}

function locationSuggestionCacheKey(query: string, limit: number) {
  return `${normalizeLocationSearchText(query)}::${limit}`
}

export type BackendSearchRequest = {
  tripType?: "round-trip" | "one-way" | "multi-city"
  searchMode?: SearchRequest["searchMode"]
  flexibleMode?: SearchRequest["flexibleMode"]
  legs?: Array<{
    origin?: string
    destination?: string
    originLabel?: string
    destinationLabel?: string
    originCountryCode?: string
    destinationCountryCode?: string
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
    carryOnRequired?: boolean
    checkedBaggageRequired?: boolean
    baggageRequired?: boolean
    maxStops?: number
    maxLayoverMinutes?: number
    includedAirlineCodes?: string[]
  }
  currencyCode?: string
  locale?: string
  market?: string
}

type BackendSearchPayload = {
  clientSessionId?: string
  recordLocationUsage?: boolean
  sortMode: SortMode
  request: BackendSearchRequest
}

type BackendSearchJobResponse = Omit<SearchJobResponse, "request" | "allOffers" | "diagnosticLog"> & {
  request?: BackendSearchRequest
  allOffers?: unknown[]
}

type BackendMatrixJobResponse = {
  matrixJobId: string
  matrixComplete: boolean
  matrixStatus: string
  revision: number
  request?: BackendSearchRequest
  searchMeta?: SearchJobResponse["searchMeta"]
  providerMeta?: SearchJobResponse["providerMeta"]
  warnings?: string[]
  error?: string
  unchanged?: boolean
  cells?: MatrixCell[]
  recommendations?: string[]
  providerDiagnostics?: SearchJobResponse["providerDiagnostics"]
  queued?: boolean
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
          originLabel: request.originLabel,
          destinationLabel: request.destinationLabel,
          originCountryCode: request.originCountryCode,
          destinationCountryCode: request.destinationCountryCode,
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
        carryOnRequired: Boolean(request.carryOnRequired),
        checkedBaggageRequired: Boolean(request.checkedBaggageRequired ?? request.baggageRequired),
        baggageRequired: Boolean(request.checkedBaggageRequired ?? request.baggageRequired),
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

export function fromBackendRequest(request: BackendSearchRequest | undefined): SearchRequest {
  const leg = request?.legs?.[0] ?? {}
  return {
    origin: leg.origin ?? "",
    destination: leg.destination ?? "",
    originLabel: leg.originLabel,
    destinationLabel: leg.destinationLabel,
    originCountryCode: leg.originCountryCode,
    destinationCountryCode: leg.destinationCountryCode,
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
    carryOnRequired: request?.filters?.carryOnRequired,
    checkedBaggageRequired: request?.filters?.checkedBaggageRequired ?? request?.filters?.baggageRequired,
    baggageRequired: request?.filters?.baggageRequired,
    maxLayoverMinutes: request?.filters?.maxLayoverMinutes?.toString(),
    includedAirlineCodes: request?.filters?.includedAirlineCodes,
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

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

/* An offer is only drawn with a positive price, a currency and a complete real
   itinerary for its trip type; nothing is filled in from the request. */
function offerTransportRecord(
  input: unknown,
  expectedTripType?: SearchRequest["tripType"],
): Record<string, unknown> | undefined {
  const offer = objectRecord(input)
  const price = objectRecord(offer?.price)
  const total = objectRecord(price?.total)
  const amount = total?.amount
  const itineraries = offer?.itineraries

  if (
    !offer
    || !nonEmptyString(offer.id)
    || !nonEmptyString(offer.providerSource)
    || typeof amount !== "number"
    || !Number.isFinite(amount)
    || amount <= 0
    || !nonEmptyString(total?.currencyCode)
    || !Array.isArray(itineraries)
    || itineraries.length === 0
  ) return undefined

  const completeItineraries = itineraries.flatMap((itinerary) => {
    const rawItinerary = objectRecord(itinerary)
    const segments = rawItinerary?.segments
    const complete = Array.isArray(segments)
      && segments.length > 0
      && segments.every((segment) => {
        const rawSegment = objectRecord(segment)
        return Boolean(
          rawSegment
          && nonEmptyString(rawSegment.origin)
          && nonEmptyString(rawSegment.destination)
          && nonEmptyString(rawSegment.departureAt)
          && nonEmptyString(rawSegment.arrivalAt),
        )
      })
    return complete && rawItinerary ? [rawItinerary] : []
  })

  if (completeItineraries.length !== itineraries.length) return undefined

  const tripType = expectedTripType
    ?? (offer.tripType === "one-way" || offer.tripType === "round-trip" || offer.tripType === "multi-city"
      ? offer.tripType
      : undefined)
  const directions = new Set(completeItineraries.map((itinerary) => itinerary.direction))
  if (tripType === "one-way" && !directions.has("outbound")) return undefined
  if (tripType === "round-trip" && (!directions.has("outbound") || !directions.has("inbound"))) return undefined
  if (tripType === "multi-city" && !directions.has("multi")) return undefined

  return offer
}

/* The airline that controls the offer (`offerAirlineCode`), named as its own
   flights spell it or as the catalogue knows its code: a partner's flight
   never lends it a name. The card and the airline filter both read this. */
function offerAirlineDisplayName(offer: Record<string, unknown>, itineraries: CanonicalOffer["itineraries"]): string {
  const code = offerAirlineCode({
    mainCarrier: typeof offer.mainCarrier === "string" ? offer.mainCarrier : undefined,
    validatingCarrier: typeof offer.validatingCarrier === "string" ? offer.validatingCarrier : undefined,
  }).toUpperCase()
  const segments = (itineraries ?? []).flatMap((itinerary) => itinerary.segments ?? [])
  const carries = (carrier: unknown) => String(carrier ?? "").trim().toUpperCase() === code
  return resolveAirlineDisplayName({
    names: [
      segments.find((segment) => carries(segment.marketingCarrier) && segment.marketingCarrierName)?.marketingCarrierName,
      segments.find((segment) => carries(segment.operatingCarrier) && segment.operatingCarrierName)?.operatingCarrierName,
    ],
    codes: [code],
    fallback: code,
  })
}

function normalizeOffer(input: unknown, expectedTripType?: SearchRequest["tripType"]): CanonicalOffer | undefined {
  const offer = offerTransportRecord(input, expectedTripType)
  if (!offer) return undefined

  const itineraries = normalizeOfferItineraries(offer.itineraries)
  const itineraryOffer = { itineraries }
  const outboundItinerary = primaryItineraryForOffer(itineraryOffer)
  const outbound = firstSegmentForItinerary(outboundItinerary)
  const outboundLast = lastSegmentForItinerary(outboundItinerary)
  const inbound = firstSegmentForItinerary(returnItineraryForOffer(itineraryOffer))

  return {
    ...(offer as Partial<CanonicalOffer>),
    id: String(offer.id),
    providerSource: String(offer.providerSource),
    airline: offerAirlineDisplayName(offer, itineraries),
    itineraries,
    origin: typeof outbound?.origin === "string" ? outbound.origin : String(offer.origin ?? ""),
    destination: typeof outboundLast?.destination === "string" ? outboundLast.destination : String(offer.destination ?? ""),
    departureDate: String(outbound?.departureAt ?? offer.departureDate ?? ""),
    arrivalDate: typeof outboundLast?.arrivalAt === "string" ? outboundLast.arrivalAt : undefined,
    returnDate: typeof inbound?.departureAt === "string" ? inbound.departureAt : offer.returnDate as string | undefined,
    baggage: typeof offer.baggage === "object" && offer.baggage ? offer.baggage as CanonicalOffer["baggage"] : undefined,
    warnings: translatedOfferWarnings(offer.warnings),
    price: offer.price as CanonicalOffer["price"],
  }
}

function normalizeOffers(input: unknown[] | undefined, expectedTripType?: SearchRequest["tripType"]): CanonicalOffer[] {
  return (input ?? []).flatMap((offer) => {
    const normalized = normalizeOffer(offer, expectedTripType)
    return normalized ? [normalized] : []
  })
}

function rawOfferWarnings(input: unknown): string[] {
  const offer = input && typeof input === "object" ? input as Record<string, unknown> : {}
  return Array.isArray(offer.warnings) ? offer.warnings.map((warning) => String(warning)) : []
}

function noOffersWarningProvider(message: string): string | null {
  if (/^Agil returned no offers/i.test(message)) return "agil-local"
  if (/^Click and Book Plus returned no offers/i.test(message)) return "costamar"
  return null
}

/* «X returned no offers» is noise once X's offers are on screen. */
function filterNoOfferWarningsWhenProviderHasOffers(messages: string[], offers: CanonicalOffer[]): string[] {
  if (messages.length === 0 || offers.length === 0) return messages

  const providersWithOffers = new Set(offers.map((offer) => offer.providerSource))
  return messages.filter((message) => {
    const provider = noOffersWarningProvider(message)
    return !provider || !providersWithOffers.has(provider)
  })
}

function normalizeSearchJob(data: BackendSearchJobResponse): SearchJobResponse {
  const { request: rawRequest, allOffers: rawOffers, ...job } = data
  const request = fromBackendRequest(rawRequest)
  const allOffers = normalizeOffers(rawOffers, request.tripType)
  const rawWarnings = filterNoOfferWarningsWhenProviderHasOffers((job.warnings ?? []).map(String), allOffers)
  const rawMetaWarnings = filterNoOfferWarningsWhenProviderHasOffers((job.searchMeta?.warnings ?? []).map(String), allOffers)

  return {
    ...job,
    searchMeta: job.searchMeta
      ? { ...job.searchMeta, warnings: rawMetaWarnings.map(translateApiMessage) }
      : job.searchMeta,
    warnings: rawWarnings.map(translateApiMessage),
    error: job.error ? translateApiMessage(String(job.error)) : undefined,
    request,
    allOffers,
    diagnosticLog: toDiagnosticLines([
      ...rawWarnings,
      ...rawMetaWarnings,
      ...(rawOffers ?? []).flatMap(rawOfferWarnings),
      ...providerDiagnosticLines(job.providerDiagnostics),
    ]),
  }
}

function normalizeMatrixOffer(
  cell: MatrixCell,
  expectedTripType: SearchRequest["tripType"],
): CanonicalOffer | undefined {
  if (!cell.offer) return undefined

  const offer = normalizeOffer(cell.offer, expectedTripType)
  if (!offer) return undefined

  const tooltipWarning = translatedMatrixTooltipWarning(cell.tooltip)
  return {
    ...offer,
    priceConfidence: cell.confidence || offer.priceConfidence,
    purchasePaths: cell.purchasePaths ?? offer.purchasePaths,
    warnings: uniqueStrings([
      ...(offer.warnings ?? []),
      ...(tooltipWarning ? [tooltipWarning] : []),
    ]),
  }
}

function normalizeMatrixJob(data: BackendMatrixJobResponse, sortMode: SortMode): SearchJobResponse {
  const request = fromBackendRequest(data.request)
  const rawWarnings = (data.warnings ?? []).map((warning) => String(warning))
  const rawMetaWarnings = (data.searchMeta?.warnings ?? []).map((warning) => String(warning))
  const rawError = data.error ? [data.error] : []
  const rawCellTooltips = (data.cells ?? []).map((cell) => cell.tooltip).filter((tooltip): tooltip is string => typeof tooltip === "string" && Boolean(tooltip))
  const recommendations = (data.recommendations ?? []).map(translateApiMessage)
  const allOffers = (data.cells ?? []).flatMap((cell) => {
    const offer = normalizeMatrixOffer(cell, request.tripType)
    return offer ? [offer] : []
  })
  const now = new Date().toISOString()

  return {
    searchJobId: data.matrixJobId,
    searchComplete: data.matrixComplete,
    searchStatus: data.matrixStatus,
    revision: data.revision,
    sortMode,
    request,
    unchanged: data.unchanged,
    queued: data.queued === true,
    allOffers,
    searchMeta: data.searchMeta
      ? { ...data.searchMeta, warnings: rawMetaWarnings.map(translateApiMessage) }
      : {
          requestedAt: now,
          completedAt: now,
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
      ...rawWarnings.map(translateApiMessage),
      ...rawError.map(translateApiMessage),
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

function migrationMonthRanges(startIso: string | undefined, selectedMonthKeys?: string[]): MigrationMonthRange[] {
  const firstSearchDate = isIsoDate(startIso) ? startIso : deskToday()
  const firstMonth = firstSearchDate.slice(0, 7)
  const lastMonth = addMonths(firstMonth, MIGRATION_MONTH_LIMIT - 1)
  const monthKeys = selectedMonthKeys === undefined
    ? Array.from({ length: MIGRATION_MONTH_LIMIT }, (_, index) => addMonths(firstMonth, index))
    : Array.from(new Set(selectedMonthKeys.map((key) => key.trim()).filter(isIsoMonth)))
        .filter((key) => key >= firstMonth && key <= lastMonth)
        .sort()
        .slice(0, MIGRATION_MONTH_LIMIT)

  return monthKeys.map((key) => ({
    key,
    label: monthCaption(key, { capitalized: true }),
    departureStart: key === firstMonth ? maxIsoDate(`${key}-01`, firstSearchDate) : `${key}-01`,
    departureEnd: lastDayOfMonth(key),
  })).filter((range) => range.departureStart <= range.departureEnd)
}

/**
 * One month of the sweep as an ordinary day search, so opening a month runs
 * exactly the search the sweep ran for it. Filters are cleared here and put
 * back by whoever runs it.
 */
export function migrationRequestForMonth(
  request: SearchRequest,
  range: Pick<MigrationMonthRange, "departureStart" | "departureEnd">,
): SearchRequest {
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
    migrationMonths: undefined,
    nonStop: false,
    maxStopsFilter: undefined,
    maxLayoverMinutes: undefined,
    carryOnRequired: false,
    checkedBaggageRequired: false,
    baggageRequired: false,
    includedAirlineCodes: undefined,
  }
}

const compareByPrice = compareOffers("cheapest")

/** The offer a month is represented by: the first row of that month's list sorted by price. */
export function cheapestOffer(offers: readonly CanonicalOffer[]): CanonicalOffer | undefined {
  return offers.reduce<CanonicalOffer | undefined>(
    (best, offer) => (!best || compareByPrice(offer, best) < 0 ? offer : best),
    undefined,
  )
}

function normalizeMigrationOffers(job: SearchJobResponse, range: MigrationMonthRange): CanonicalOffer[] {
  return job.allOffers.map((offer) => ({
    ...offer,
    id: `migration-${range.key}-${offer.id}`,
    sourceOfferId: offer.sourceOfferId ?? offer.id,
    sourceSearchJobId: offer.sourceSearchJobId ?? job.searchJobId,
    tags: uniqueStrings(["Migratorio", range.label, ...(offer.tags ?? [])]),
  }))
}

function withBrowserClientSessionId(payload: BackendSearchPayload): BackendSearchPayload {
  const clientSessionId = getBrowserClientSessionId()
  return clientSessionId ? { ...payload, clientSessionId } : payload
}

/* «12 de 30 días con tarifa» is only stated after a complete, non-partial
   scan: a guessed coverage would make a thin month look thoroughly checked. */
function migrationMonthCoverage(
  result: MigrationMonthWorkResult,
): Pick<MigrationMonthSummary, "faredDays" | "queriedDays"> {
  if (!result.job?.searchComplete || result.job.searchMeta?.partial) {
    return {}
  }

  const startMs = Date.parse(`${result.range.departureStart}T00:00:00Z`)
  const endMs = Date.parse(`${result.range.departureEnd}T00:00:00Z`)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return {}
  }

  const fareDates = new Set(
    result.offers
      .map((offer) => {
        const date = primaryItineraryForOffer(offer)?.segments?.[0]?.departureAt?.slice(0, 10)
        return isIsoDate(date) ? date : isIsoDate(offer.departureDate) ? offer.departureDate : undefined
      })
      .filter((date): date is string => Boolean(
        date
        && date >= result.range.departureStart
        && date <= result.range.departureEnd
      )),
  )

  return {
    faredDays: fareDates.size,
    queriedDays: Math.floor((endMs - startMs) / 86_400_000) + 1,
  }
}

/*
 * The sweep's providers, read like one search's by `describeSearchOutcome`, so
 * the sweep's one line says what the desk's says. Each month is a part of the
 * sweep: a provider that failed a month, or answered one in part, while it
 * answered another, answered the sweep in part, as soon as that is known; one
 * that failed every month failed the sweep. Until every month has finished,
 * anything else is still being asked.
 */
function sweepProviderDiagnostics(monthResults: MigrationMonthWorkResult[]): ProviderDiagnostics[] {
  const sweepRunning = monthResults.some((result) => !result.complete)
  const byProvider = new Map<string, ProviderDiagnostics[]>()
  for (const entry of monthResults.flatMap((result) => result.job?.providerDiagnostics ?? [])) {
    const providerId = String(entry.providerId)
    byProvider.set(providerId, [...(byProvider.get(providerId) ?? []), entry])
  }

  return [...byProvider].flatMap(([providerId, entries]): ProviderDiagnostics[] => {
    const settled = entries.filter((entry) => entry.status === "completed" || entry.status === "failed")
    const failed = settled.filter((entry) => entry.status === "failed")
    const answered = settled.some((entry) => entry.status === "completed")
    const short = failed.length > 0 || settled.some((entry) => entry.partial)
    const sweep = { providerId, kind: "range" as const, events: [] }

    if (answered && short) return [{ ...sweep, status: "completed", partial: true }]
    if (sweepRunning) return [{ ...sweep, status: "running" }]
    if (settled.length === 0) return []
    return failed.length === settled.length
      ? [{ ...sweep, status: "failed", error: failed[0]?.error }]
      : [{ ...sweep, status: "completed" }]
  })
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

/* What `fromBackendRequest` makes of a poll that carried no request. */
function isPlaceholderRequest(request: SearchRequest) {
  return request.origin === ""
    && request.destination === ""
    && request.searchMode === "exact"
    && request.tripType === "round-trip"
    && !request.departureDate
    && !request.departureStart
    && !request.returnDate
    && !request.returnStart
}

/**
 * Polls a job until it completes, reporting each revision. A lost answer is
 * retried: the job runs on the server and one timed-out hop is not a failed
 * search. An expired session is not retried.
 */
export async function followJob(
  first: SearchJobResponse,
  poll: (sinceRevision: number, signal?: AbortSignal) => Promise<SearchJobResponse>,
  {
    signal,
    onUpdate,
    onRetry,
  }: {
    signal?: AbortSignal
    onUpdate: (job: SearchJobResponse) => void
    onRetry?: (error: unknown, attempt: number) => void
  },
): Promise<SearchJobResponse> {
  let job = first
  let failures = 0
  let wait = POLL_FAST_MS

  while (!job.searchComplete) {
    await delay(wait, signal)
    const startedAt = Date.now()
    let next: SearchJobResponse
    try {
      next = await poll(job.revision, signal)
    } catch (error) {
      if (error instanceof FlyDeskSearchCancelledError) throw error
      failures += 1
      onRetry?.(error, failures)
      if (failures >= POLL_MAX_CONSECUTIVE_FAILURES || error instanceof FlyDeskSessionExpiredError) throw error
      wait = POLL_RETRY_DELAY_MS
      continue
    }

    failures = 0
    wait = nextPollDelayMs({ unchanged: Boolean(next.unchanged), elapsedMs: Date.now() - startedAt })
    if (next.unchanged) {
      if (!next.searchComplete) continue
      job = { ...job, searchComplete: true, searchStatus: next.searchStatus }
    } else {
      job = {
        ...next,
        request: isPlaceholderRequest(next.request) ? job.request : next.request,
        searchMeta: next.searchMeta ?? job.searchMeta,
        providerMeta: next.providerMeta ?? job.providerMeta,
      }
    }
    onUpdate(job)
  }

  return job
}

export async function requestQuotation(payload: QuotationRequest): Promise<QuotationResponse> {
  const data = await postJson<{
    searchSessionId?: unknown
    offer?: unknown
    commercialText?: unknown
  }>("/api/quotation", payload)
  const rawOfferRecord = offerTransportRecord(data.offer)
  /* A fare fresh from its search comes back live and dated by its search; an
     older one, confirmed by the provider and dated by that confirmation. */
  const quotedAt = rawOfferRecord?.priceConfidence === "live"
    ? rawOfferRecord.quotationPreparedAt
    : rawOfferRecord?.priceConfidence === "validated" && rawOfferRecord.priceStatus === "verified"
      ? rawOfferRecord.priceVerifiedAt
      : undefined

  if (
    typeof data.searchSessionId !== "string"
    || data.searchSessionId !== payload.searchSessionId
    || typeof data.commercialText !== "string"
    || data.commercialText.trim().length === 0
    || !rawOfferRecord
    || typeof quotedAt !== "string"
    || !Number.isFinite(Date.parse(quotedAt))
  ) {
    throw new FlyDeskApiError(
      "El servidor devolvió una cotización no válida.",
      ["POST /api/quotation returned an invalid contract."],
    )
  }

  const offer = normalizeOffer(data.offer)
  if (!offer) {
    throw new FlyDeskApiError(
      "El servidor devolvió una cotización no válida.",
      ["POST /api/quotation returned an invalid offer."],
    )
  }

  return {
    searchSessionId: data.searchSessionId,
    commercialText: data.commercialText,
    offer,
  }
}

export async function startSearch(
  request: SearchRequest,
  sortMode: SortMode,
  options: StartOptions = {}
): Promise<SearchJobResponse> {
  const payload = withBrowserClientSessionId({
    ...toBackendPayload(request, sortMode),
    ...(options.recordLocationUsage === undefined
      ? {}
      : { recordLocationUsage: options.recordLocationUsage }),
  })
  const data = await postJson<BackendSearchJobResponse>("/api/search", payload)
  if (data.searchJobId) {
    options.onJobStart?.({ id: data.searchJobId, type: "search" })
  }
  return normalizeSearchJob(data)
}

export async function pollSearch(jobId: string, sinceRevision?: number, signal?: AbortSignal): Promise<SearchJobResponse> {
  let url = `/api/search/${encodeURIComponent(jobId)}`
  if (sinceRevision !== undefined) url += `?sinceRevision=${sinceRevision}&wait=${POLL_LONG_WAIT_MS}`
  return normalizeSearchJob(await getJson<BackendSearchJobResponse>(url, signal))
}

export async function startMatrix(
  request: SearchRequest,
  sortMode: SortMode,
  options: StartOptions = {}
): Promise<SearchJobResponse> {
  const payload = withBrowserClientSessionId(toBackendPayload(request, sortMode))
  const data = await postJson<BackendMatrixJobResponse>("/api/matrix", payload)
  if (data.matrixJobId) {
    options.onJobStart?.({ id: data.matrixJobId, type: "matrix" })
  }
  return normalizeMatrixJob(data, sortMode)
}

/** The runner's shared search capacity, as the top bar draws it. */
export type SearchCapacity = {
  version: string
  capacityUnits: number
  activeUnits: number
  activeSearches: number
  queuedSearches: number
}

function capacityCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * Reads the shared capacity: at once without `version`, otherwise held by the
 * server until it is no longer `version` or `waitMs` runs out. A page left
 * open asks this on its own, so an answer it cannot use, a refused session
 * included, only fails the read: it never sends the page to sign in.
 */
export async function readSearchCapacity(version: string | undefined, waitMs: number, signal: AbortSignal): Promise<SearchCapacity> {
  const query = version ? `?version=${encodeURIComponent(version)}&wait=${waitMs}` : ""
  const response = await fetch(`/api/search-capacity${query}`, { signal, cache: "no-store" })
  if (!response.ok) {
    throw new Error(`The capacity answered ${response.status}.`)
  }

  const data = await response.json() as Record<string, unknown>
  const capacityUnits = capacityCount(data.capacityUnits)
  const activeUnits = capacityCount(data.activeUnits)
  const activeSearches = capacityCount(data.activeSearches)
  const queuedSearches = capacityCount(data.queuedSearches)
  if (
    typeof data.version !== "string"
    || !capacityUnits
    || activeUnits === undefined
    || activeSearches === undefined
    || queuedSearches === undefined
  ) {
    throw new Error("The capacity answered an unreadable reading.")
  }

  return { version: data.version, capacityUnits, activeUnits, activeSearches, queuedSearches }
}

export async function pollMatrix(
  jobId: string,
  sortMode: SortMode,
  sinceRevision?: number,
  signal?: AbortSignal,
): Promise<SearchJobResponse> {
  let url = `/api/matrix/${encodeURIComponent(jobId)}`
  if (sinceRevision !== undefined) url += `?sinceRevision=${sinceRevision}&wait=${POLL_LONG_WAIT_MS}`
  return normalizeMatrixJob(await getJson<BackendMatrixJobResponse>(url, signal), sortMode)
}

export async function cancelSearchJob(
  job: ActiveJob,
  options: { cachePartial?: boolean; keepalive?: boolean } = {}
): Promise<void> {
  const path = job.type === "matrix" ? "matrix" : "search"
  const query = options.cachePartial ? "?cachePartial=1" : ""
  const url = `/api/${path}/${encodeURIComponent(job.id)}/cancel${query}`

  if (options.keepalive) {
    const body = "{}"
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

  await postJson<unknown>(url, {})
}

export async function startMigrationSearch(
  request: SearchRequest,
  sortMode: SortMode,
  options: MigrationOptions = {}
): Promise<SearchJobResponse> {
  const requestedAt = new Date().toISOString()
  const ranges = migrationMonthRanges(request.departureStart ?? request.departureDate, request.migrationMonths)
  const monthResults: MigrationMonthWorkResult[] = ranges.map((range) => ({
    range,
    offers: [],
    warnings: [],
    diagnosticLog: [],
    complete: false,
    status: "loading",
  }))

  const buildMigrationJob = (searchComplete: boolean): SearchJobResponse => {
    const pricedMonths = monthResults.filter((result) => result.offer).length
    const warnings = uniqueStrings(monthResults.flatMap((result) => result.warnings))
    const providerMeta = monthResults.find((result) => result.job?.providerMeta)?.job?.providerMeta ?? {
      exactProvider: "agil-local",
      coverageMode: "core",
    }
    /* A month that ends with a fare after a partial provider scan still reads
       «con tarifa» on the grid; the sweep's own partiality comes from the jobs. */
    const migrationIsPartial = monthResults.some((result) => (
      !result.complete || result.status === "error" || Boolean(result.job?.searchMeta?.partial)
    ))
    const monthlyWarnings = searchComplete && pricedMonths === 0
      ? uniqueStrings([
          ...warnings,
          ranges.length === 1
            ? "Migratorio no encontró tarifas disponibles en el mes seleccionado."
            : "Migratorio no encontró tarifas disponibles en los meses seleccionados.",
        ])
      : warnings

    /* A sweep waits while every month it has asked for waits: once one has
       started, a month waiting its turn is a sweep under way, not a queued one. */
    const askedMonths = monthResults.filter((result) => result.job)
    return {
      searchJobId: `migration-${requestedAt}`,
      searchComplete,
      searchStatus: searchComplete ? "completed" : "running",
      queued: !searchComplete
        && askedMonths.length > 0
        && askedMonths.every((result) => result.job?.queued === true && !result.complete),
      revision: Math.max(1, ...monthResults.map((result) => result.job?.revision ?? 0)),
      sortMode,
      request,
      allOffers: monthResults.flatMap((result) => result.offers),
      migrationMonths: monthResults.map((result) => ({
        key: result.range.key,
        label: result.range.label,
        departureStart: result.range.departureStart,
        departureEnd: result.range.departureEnd,
        ...migrationMonthCoverage(result),
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
        partial: migrationIsPartial,
        searchState: searchComplete && !migrationIsPartial ? "search_live" : "search_partial",
      },
      providerMeta,
      providerDiagnostics: sweepProviderDiagnostics(monthResults),
      warnings: monthlyWarnings,
      diagnosticLog: toDiagnosticLines(monthResults.flatMap((result) => result.diagnosticLog)),
    }
  }

  const emitProgress = () => {
    options.onMigrationProgress?.(buildMigrationJob(false))
  }

  emitProgress()

  /* The runner starts one month-long range at a time, in the order it is asked
     for them: each month is asked for once the one before it has its job, so
     the sweep runs in calendar order while the next month already waits. */
  let previousStart: Promise<unknown> = Promise.resolve()

  await runWithConcurrency(
    ranges,
    MIGRATION_CONCURRENT_MONTHS,
    async (range, index) => {
      const record = (job: SearchJobResponse) => {
        const offers = normalizeMigrationOffers(job, range)
        const offer = cheapestOffer(offers)
        monthResults[index] = {
          range,
          job,
          offer,
          offers,
          warnings: uniqueStrings([...job.warnings, ...(job.searchMeta?.warnings ?? [])]),
          diagnosticLog: job.diagnosticLog ?? [],
          complete: job.searchComplete,
          /* Still out is `searchComplete`, never `searchMeta.partial`: the
             router's first answer for every month is a partial draft, and
             `partial` stays true after a month completes with a provider down. */
          status: job.searchComplete
            ? offer ? "available" : "empty"
            : offer ? "partial" : "loading",
        }
        emitProgress()
      }

      const started = previousStart.then(() => {
        throwIfAborted(options.signal)
        return startSearch(migrationRequestForMonth(request, range), "cheapest", {
          onJobStart: options.onJobStart,
          recordLocationUsage: index === 0,
        })
      })
      previousStart = started.catch(() => undefined)

      try {
        const first = await started
        throwIfAborted(options.signal)
        record(first)
        await followJob(first, (since, signal) => pollSearch(first.searchJobId, since, signal), {
          signal: options.signal,
          onUpdate: record,
        })
      } catch (error) {
        if (error instanceof FlyDeskSearchCancelledError) {
          throw error
        }

        const previous = monthResults[index]!
        const preservedOffer = previous.offer ?? cheapestOffer(previous.offers)
        monthResults[index] = {
          range,
          job: previous.job,
          offer: preservedOffer,
          offers: previous.offers.length > 0 ? previous.offers : preservedOffer ? [preservedOffer] : [],
          warnings: uniqueStrings([
            ...previous.warnings,
            `${range.label}: ${userMessageFromError(error)}`,
          ]),
          diagnosticLog: toDiagnosticLines([
            ...previous.diagnosticLog,
            ...diagnosticLogFromError(error).map((line) => `${range.label}: ${line}`),
          ]),
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
