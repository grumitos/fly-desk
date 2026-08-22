import type {
  CanonicalOffer,
  LocationSuggestion,
  MatrixCell,
  MigrationMonthSummary,
  SearchRequest,
  SearchJobResponse,
  SortMode,
} from "@/types"
import { normalizeAirlineDisplayName, resolveAirlineDisplayName } from "@/lib/airline-names"
import { getBrowserClientSessionId } from "@/lib/browser-client-session"
import { isIsoDate } from "@/lib/iso-date"
import { POLL_LONG_WAIT_MS } from "@/lib/poll-schedule"
import { filterLocationSuggestions, normalizeLocationSearchText, normalizeLocationSuggestions } from "@/lib/locations"
import { providerDisplayName } from "@/lib/providers"
import {
  firstSegmentForItinerary,
  formatOfferBaggageLabel,
  itineraryRouteLabel,
  lastSegmentForItinerary,
  primaryItineraryForOffer,
  returnItineraryForOffer,
} from "@/lib/offer-display"

const API_BASE = ""
/* 06 §6: «Límite del barrido: 12 meses». The picker offers twelve, so the
   sweep has to run twelve — cutting it back here is what silently dropped the
   months past the eighth out of a range the agent had chosen. */
const MIGRATION_MONTH_COUNT = 12
const MIGRATION_CONCURRENT_REQUESTS_FALLBACK = 2
const MIGRATION_CONCURRENT_REQUESTS_MAX = 12
const MIGRATION_POLL_INTERVAL_MS = 900
const LOCATION_SUGGESTION_CACHE_LIMIT = 100
const LOCATION_SUGGESTION_POOL_LIMIT = 500
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

export type QuotationRequest = {
  searchSessionId: string
  offerId: string
  migrationPlan?: boolean
}

export type QuotationResponse = {
  searchSessionId: string
  offer: CanonicalOffer
  commercialText: string
}

type SearchRequestOptions = RequestOptions & {
  onJobStart?: (job: { id: string; type: "search" | "matrix" }) => void
  onMigrationProgress?: (job: SearchJobResponse) => void
  recordLocationUsage?: boolean
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

export function translateApiMessage(message: string): string {
  const normalized = stripAnsi(String(message)).replace(/\s+/g, " ").trim()

  const exact: Record<string, string> = {
    "Origin is required and must be an IATA-like code.": "Ingresa un origen válido.",
    "Destination is required and must be an IATA-like code.": "Ingresa un destino válido.",
    "Origin is required and must be a three-letter IATA code.": "Ingresa un origen válido.",
    "Destination is required and must be a three-letter IATA code.": "Ingresa un destino válido.",
    "Origin and destination must be different.": "El origen y el destino deben ser diferentes.",
    "Multi-city search is not supported.": "La búsqueda multidestino aún no está disponible.",
    "Adults must be a non-negative integer.": "La cantidad de adultos debe ser válida.",
    "Children must be a non-negative integer.": "La cantidad de niños debe ser válida.",
    "Infants must be a non-negative integer.": "La cantidad de bebés debe ser válida.",
    "At least one adult is required.": "Debe viajar al menos un adulto.",
    "Infants cannot exceed adults.": "La cantidad de bebés no puede superar la de adultos.",
    "Departure date is required for exact search.": "Selecciona una fecha de salida.",
    "Departure date must be a valid ISO date (YYYY-MM-DD).": "La fecha de salida no es válida.",
    "Return date is required for round-trip exact search.": "Selecciona una fecha de regreso.",
    "Return date must be a valid ISO date (YYYY-MM-DD).": "La fecha de regreso no es válida.",
    "Return date must be after departure date.": "La fecha de regreso debe ser posterior a la salida.",
    "Departure range is required for matrix search.": "Selecciona un rango de salida.",
    "Return range is required for round-trip matrix search.": "Selecciona un rango de regreso.",
    "Stay nights is required for exact-stay matrix search.": "Indica la cantidad de noches.",
    "Departure range is required for range search.": "Selecciona un rango de salida.",
    "Return range is required for round-trip range search.": "Selecciona un rango de regreso.",
    "Departure range end must be on or after departure range start.": "El fin del rango de salida debe ser igual o posterior al inicio.",
    "Return range end must be on or after return range start.": "El fin del rango de regreso debe ser igual o posterior al inicio.",
    "Costamar terminalId is required.": "Falta configurar el terminal de Click and Book Plus.",
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
    "AGIL_TOKEN_EXPIRED": "La sesión de Agil venció. Vuelve a iniciar sesión en Agil e intenta nuevamente.",
    "Agil exact search.": "Búsqueda exacta en Agil.",
    "Agil returned no live result for this combination.": "Agil no devolvió una tarifa disponible para esta combinación.",
    "Agil error while resolving this combination.": "No se pudo consultar Agil para esta combinación.",
    "Agil exact search with stop.": "Búsqueda exacta en Agil con escala.",
    "Agil stopover search.": "Búsqueda en Agil con escala.",
    "Agil direct alt fare.": "Tarifa alternativa directa de Agil.",
    "Costamar exact search.": "Búsqueda exacta en Click and Book Plus.",
    "Costamar live search.": "Búsqueda en vivo de Click and Book Plus.",
    "Click and Book Plus live search.": "Búsqueda en vivo de Click and Book Plus.",
    "Costamar returned no live result for this combination.": "Click and Book Plus no devolvió una tarifa disponible para esta combinación.",
    "Click and Book Plus returned no live result for this combination.": "Click and Book Plus no devolvió una tarifa disponible para esta combinación.",
    "Consultando Costamar...": "Consultando Click and Book Plus...",
    "Consultando Click and Book Plus...": "Consultando Click and Book Plus...",
    "Consultando Agil...": "Consultando Agil...",
    /* The three draft warnings the router emits on the first response of every
       job (`createSearchDraftResponse`). Without them a month that is still
       being queried reads «No se pudo completar la operación» — loading painted
       as failure, the worst confusion in a grid meant for deciding. */
    "Consultando Agil y Costamar.": "Consultando Agil y Click and Book Plus.",
    "Consultando Agil y Click and Book Plus.": "Consultando Agil y Click and Book Plus.",
    "Consultando Agil.": "Consultando Agil.",
    "Consultando Costamar.": "Consultando Click and Book Plus.",
    "Consultando Click and Book Plus.": "Consultando Click and Book Plus.",
    "Consultando Agil y Costamar. Los resultados se iran agregando.": "Consultando Agil y Click and Book Plus. Los resultados se irán agregando.",
    "Consultando Agil y Click and Book Plus. Los resultados se iran agregando.": "Consultando Agil y Click and Book Plus. Los resultados se irán agregando.",
    "Consultando Agil. Los resultados se iran agregando.": "Consultando Agil. Los resultados se irán agregando.",
    "Consultando Costamar. Los resultados se iran agregando.": "Consultando Click and Book Plus. Los resultados se irán agregando.",
    "Consultando Click and Book Plus. Los resultados se iran agregando.": "Consultando Click and Book Plus. Los resultados se irán agregando.",
    "Mostrando resultados cacheados mientras actualizamos en segundo plano.": "Mostrando resultados cacheados mientras actualizamos en segundo plano.",
    "Matrix loading from Agil in parallel.": "Agil está consultando la matriz.",
    "Matrix finished with partial Agil failures.": "Agil completó la matriz con resultados parciales.",
    "Matrix built from Agil exact searches in parallel.": "Matriz creada con búsquedas exactas de Agil.",
    "Selecting a cell runs a full Agil exact search for offers.": "Selecciona una fecha para ver las ofertas disponibles.",
    "Matrix loading from Costamar with useful date combinations only.": "Click and Book Plus está consultando la matriz.",
    "Matrix loading from Click and Book Plus with useful date combinations only.": "Click and Book Plus está consultando la matriz.",
    "Matrix finished with partial Costamar failures.": "Click and Book Plus completó la matriz con resultados parciales.",
    "Matrix finished with partial Click and Book Plus failures.": "Click and Book Plus completó la matriz con resultados parciales.",
    "Matrix seeded from Costamar native flexible search and completed with exact searches.": "Matriz creada con búsquedas de Click and Book Plus.",
    "Matrix seeded from Click and Book Plus native flexible search and completed with exact searches.": "Matriz creada con búsquedas de Click and Book Plus.",
    "Matrix built from Costamar exact searches over useful date combinations.": "Matriz creada con búsquedas exactas de Click and Book Plus.",
    "Matrix built from Click and Book Plus exact searches over useful date combinations.": "Matriz creada con búsquedas exactas de Click and Book Plus.",
    "Matrix keeps only useful date combinations based on the requested stay window.": "La matriz conserva las combinaciones útiles para la estadía solicitada.",
    "Selecting a cell runs a full Costamar exact search for offers.": "Selecciona una fecha para ver las ofertas disponibles.",
    "Selecting a cell runs a full Click and Book Plus exact search for offers.": "Selecciona una fecha para ver las ofertas disponibles.",
    "Search cancelled by user.": "Búsqueda detenida por el usuario.",
    "Search stopped because Fly Desk was restarted.": "Búsqueda detenida por reinicio de Fly Desk.",
  }

  if (exact[normalized]) return exact[normalized]

  /* The ceilings the policy line announces come from the backend runtime, and
     its rejection messages carry the same number. Matching by pattern instead
     of by literal keeps the two in step: when the backend lowers a ceiling the
     line moves on its own, and the rejection keeps translating. */
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

  /* The only ceiling of the form that can be crossed with no warning before or
     after, and the only rejection that tells the agent what to do about it.
     The instruction is the point: dropping it to the generic message leaves a
     matrix that will not run and no way to find out why. */
  const combinationCap = normalized.match(
    /^Round-trip (?:matrix|range) search cannot exceed (\d+) combinations\. Narrow the departure or return ranges\.$/,
  )
  if (combinationCap) {
    const cap = Number(combinationCap[1])
    const formatted = Number.isFinite(cap) ? cap.toLocaleString("es-PE") : combinationCap[1]
    return `El rango pedido supera las ${formatted} combinaciones. Estrecha el rango de salida o el de regreso.`
  }

  /* `providerPublicFailureMessage` builds these from the provider label and the
     reason code. Three of the six fell to the generic message, which dropped
     the name and the reason at once — the two things the notice exists to
     carry. They come before the loose provider rules below on purpose.

     The three labels are every label that function can produce: the two in
     `PROVIDER_STATUS_DEFINITIONS` and its «Provider» fallback. This pattern
     also matched «Agil» and «Costamar», neither of which the backend has been
     able to emit since the rebrand — a dead alternative that kept a retired
     brand alive in the one place a user would have read it. */
  const providerFailure = normalized.match(
    /^(Agilsmart|Click and Book Plus|Provider) (authentication or session is unavailable|is temporarily unavailable|request timed out|returned an invalid response|request failed)\.$/,
  )
  if (providerFailure) {
    const provider = providerFailure[1] === "Click and Book Plus"
      ? providerDisplayName("costamar")
      : providerFailure[1] === "Agilsmart"
        ? providerDisplayName("agil-local")
        : "El proveedor"
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

  if (/^(Costamar|Click and Book Plus) returned no offers/i.test(normalized)) {
    return "Click and Book Plus no devolvió vuelos para esta búsqueda."
  }

  if (/^Agil exact search/i.test(normalized)) {
    return "Búsqueda exacta en Agil."
  }

  if (/^(Costamar|Click and Book Plus) (exact|live) search/i.test(normalized)) {
    return "Búsqueda en vivo de Click and Book Plus."
  }

  if (/Agil/i.test(normalized) && /(failed|error|omitted|rejected|Internal Server Error|500|401|403|expired|session|sesión)/i.test(normalized)) {
    return "No se pudo consultar Agil. Verifica que la sesión esté activa e intenta nuevamente."
  }

  if (/(Costamar|Click and Book Plus)/i.test(normalized) && /(failed|error|token|auth|login|session|sesión|401|403|500|expired|challenge)/i.test(normalized)) {
    return "No se pudo consultar Click and Book Plus. Verifica la autenticación e intenta nuevamente."
  }

  return normalized ? "No se pudo completar la operación. Intenta nuevamente." : "Ocurrió un error inesperado."
}

function isRedundantOfferWarning(message: string): boolean {
  const normalized = stripAnsi(message)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()

  return [
    /^agil exact search(\.|$)/,
    /^agil exact search with stop(\.|$)/,
    /^agil stopover search(\.|$)/,
    /^agil direct alt fare(\.|$)/,
    /^(costamar|click and book plus) (exact|live) search(\.|$)/,
    /^busqueda exacta en agil(\.|$| con escala)/,
    /^busqueda en agil con escala(\.|$)/,
    /^tarifa alternativa directa de agil(\.|$)/,
    /^busqueda exacta en (costamar|click and book plus)(\.|$)/,
    /^busqueda en vivo de (costamar|click and book plus)(\.|$)/,
  ].some((pattern) => pattern.test(normalized))
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
      redactDiagnosticMessage(message)
        .split(/\n+/)
        .map((line) => line.trim())
    )),
  )
}

function providerDiagnosticLabel(providerId: string): string {
  /* Anything that is not Costamar is Agilsmart here, and deliberately so: the
     backend only ever reports the two, and a diagnostic line naming a raw id
     would read as noise in a panel the agent scans for a provider name. The two
     names themselves come from `providerDisplayName`. */
  return providerId === "costamar"
    ? providerDisplayName("costamar")
    : providerDisplayName("agil-local")
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
  const clientSessionId = getBrowserClientSessionId()
  const sessionQuery = clientSessionId
    ? `&clientSessionId=${encodeURIComponent(clientSessionId)}`
    : ""
  const data = await getJson<{ suggestions: LocationSuggestion[] }>(
    `${API_BASE}/api/locations?q=${encodeURIComponent(query)}&limit=${limit}${sessionQuery}`
  )
  const suggestions = normalizeLocationSuggestions(data.suggestions)
  const rankedSuggestions = filterLocationSuggestions(query, suggestions, limit)
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

  return filterLocationSuggestions(query, [...locationSuggestionPool.values()], limit)
}

export function resetLocationSuggestionCachesForTests(): void {
  locationSuggestionCache.clear()
  locationSuggestionPool.clear()
}

function rememberLocationSuggestions(query: string, limit: number, suggestions: LocationSuggestion[]) {
  const key = locationSuggestionCacheKey(query, limit)
  locationSuggestionCache.delete(key)
  locationSuggestionCache.set(key, suggestions)
  trimOldestEntries(locationSuggestionCache, LOCATION_SUGGESTION_CACHE_LIMIT)

  for (const suggestion of suggestions) {
    rememberLocationSuggestionInPool(suggestion)
  }
  trimOldestEntries(locationSuggestionPool, LOCATION_SUGGESTION_POOL_LIMIT)
}

function rememberLocationSuggestionInPool(suggestion: LocationSuggestion) {
  const id = locationSuggestionCacheId(suggestion)
  if (!id) return

  locationSuggestionPool.delete(id)
  locationSuggestionPool.set(id, suggestion)
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

export type BackendSearchPayload = {
  clientSessionId?: string
  recordLocationUsage?: boolean
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

function normalizeOffer(input: unknown, expectedTripType?: SearchRequest["tripType"]): CanonicalOffer | undefined {
  const offer = offerTransportRecord(input, expectedTripType)
  if (!offer) return undefined

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
  const price = offer.price as CanonicalOffer["price"]
  const warnings = translatedOfferWarnings(offer.warnings)
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
    id: String(offer.id),
    providerSource: String(offer.providerSource),
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

function noOffersWarningProvider(message: string): "agil-local" | "costamar" | null {
  const normalized = stripAnsi(message).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  if (/^agil returned no offers/i.test(message) || normalized.includes("agil no devolvio vuelos")) return "agil-local"
  if (
    /^(costamar|click and book plus) returned no offers/i.test(message)
    || normalized.includes("costamar no devolvio vuelos")
    || normalized.includes("click and book plus no devolvio vuelos")
  ) return "costamar"
  return null
}

function filterNoOfferWarningsWhenProviderHasOffers(messages: string[], offers: CanonicalOffer[]): string[] {
  if (messages.length === 0 || offers.length === 0) return messages

  const providersWithOffers = new Set(offers.map((offer) => offer.providerSource))
  return messages.filter((message) => {
    const provider = noOffersWarningProvider(message)
    return !provider || !providersWithOffers.has(provider)
  })
}

function normalizeSearchJob(data: BackendSearchJobResponse): SearchJobResponse {
  const request = fromBackendRequest(data.request)
  const offers = (data.offers ?? []).flatMap((offer) => {
    const normalized = normalizeOffer(offer, request.tripType)
    return normalized ? [normalized] : []
  })
  const allOffers = (data.allOffers ?? []).flatMap((offer) => {
    const normalized = normalizeOffer(offer, request.tripType)
    return normalized ? [normalized] : []
  })
  const offerScope = allOffers.length ? allOffers : offers
  const rawWarnings = filterNoOfferWarningsWhenProviderHasOffers(
    (data.warnings ?? []).map((warning) => String(warning)),
    offerScope,
  )
  const rawMetaWarnings = filterNoOfferWarningsWhenProviderHasOffers(
    (data.searchMeta?.warnings ?? []).map((warning) => String(warning)),
    offerScope,
  )
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
    /* A failed job carries its reason here. It is translated on the way in, like
       every other backend string, so whoever paints it does not have to know
       that it arrived in English. */
    error: data.error ? translateApiMessage(String(data.error)) : undefined,
    request,
    offers,
    allOffers,
    diagnosticLog: toDiagnosticLines([
      ...rawWarnings,
      ...rawMetaWarnings,
      ...rawWarningsFromOffers,
      ...providerDiagnosticLines(data.providerDiagnostics),
    ]),
  }
}

function normalizeMatrixOffer(
  cell: MatrixCell,
  expectedTripType: SearchRequest["tripType"],
): CanonicalOffer | undefined {
  const tooltipWarning = translatedMatrixTooltipWarning(cell.tooltip)

  if (cell.offer) {
    const offer = normalizeOffer(cell.offer, expectedTripType)
    if (!offer) return undefined
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

  return undefined
}

function normalizeMatrixJob(data: BackendMatrixJobResponse, sortMode: SortMode): SearchJobResponse {
  const request = fromBackendRequest(data.request)
  const rawWarnings = (data.warnings ?? []).map((warning) => String(warning))
  const rawMetaWarnings = (data.searchMeta?.warnings ?? []).map((warning) => String(warning))
  const rawError = data.error ? [data.error] : []
  const rawCellTooltips = (data.cells ?? []).map((cell) => cell.tooltip).filter((tooltip): tooltip is string => typeof tooltip === "string" && Boolean(tooltip))
  const recommendations = (data.recommendations ?? []).map((recommendation) => translateApiMessage(recommendation))
  const warnings = [
    ...rawWarnings.map((warning) => translateApiMessage(warning)),
    ...rawError.map((warning) => translateApiMessage(warning)),
  ]
  const cells = data.cells ?? []
  const offers = cells.flatMap((cell) => {
    const offer = normalizeMatrixOffer(cell, request.tripType)
    return offer ? [offer] : []
  })

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

function migrationMonthRanges(startIso: string | undefined, selectedMonthKeys?: string[]): MigrationMonthRange[] {
  const firstSearchDate = isIsoDate(startIso) ? startIso : todayIso()
  const firstMonth = firstSearchDate.slice(0, 7)
  const lastMonth = addMonths(firstMonth, MIGRATION_MONTH_COUNT - 1)
  const monthKeys = selectedMonthKeys === undefined
    ? Array.from({ length: MIGRATION_MONTH_COUNT }, (_, index) => addMonths(firstMonth, index))
    : selectedMonthKeys
        .map((key) => key.trim())
        .filter((key, index, values) => isMigrationMonthKey(key) && values.indexOf(key) === index)
        .filter((key) => key >= firstMonth && key <= lastMonth)
        .sort()
        .slice(0, MIGRATION_MONTH_COUNT)

  return monthKeys.map((key) => {
    const monthStart = `${key}-01`
    const departureStart = key === firstMonth ? maxIsoDate(monthStart, firstSearchDate) : monthStart

    return {
      key,
      label: formatMigrationMonthLabel(key),
      departureStart,
      departureEnd: monthEndIso(key),
    }
  }).filter((range) => range.departureStart <= range.departureEnd)
}

function isMigrationMonthKey(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
}

/**
 * One month of the sweep, as an ordinary day search.
 *
 * Exported because 06 §1.3 — «al elegir un mes se entra en la lista normal de
 * ese mes» — has to open exactly the search the sweep ran for that month, and
 * building a second, nearly-identical request in the shell is how the two drift
 * apart. The filters are cleared here and re-applied by whoever runs it.
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
    nonStop: false,
    maxStopsFilter: undefined,
    maxLayoverMinutes: undefined,
    carryOnRequired: false,
    checkedBaggageRequired: false,
    baggageRequired: false,
    includedAirlineCodes: undefined,
  }
}

function migrationConcurrentRequests() {
  const runtime = typeof window === "undefined"
    ? undefined
    : (window as Window & {
        __FLYDESK_RUNTIME__?: { migrationConcurrentMonths?: number }
      }).__FLYDESK_RUNTIME__
  const configured = Number(runtime?.migrationConcurrentMonths)

  return Number.isFinite(configured)
    ? Math.min(MIGRATION_CONCURRENT_REQUESTS_MAX, Math.max(1, Math.trunc(configured)))
    : MIGRATION_CONCURRENT_REQUESTS_FALLBACK
}

function cheapestOffer(offers: CanonicalOffer[]): CanonicalOffer | undefined {
  return offers.reduce<CanonicalOffer | undefined>((best, offer) => {
    if (!best) return offer
    return compareOfferPriceAndDuration(offer, best) < 0 ? offer : best
  }, undefined)
}

function compareOfferPriceAndDuration(left: CanonicalOffer, right: CanonicalOffer) {
  return offerAmount(left) - offerAmount(right)
    || (left.comparisonMetrics?.totalDurationMinutes ?? Number.POSITIVE_INFINITY)
      - (right.comparisonMetrics?.totalDurationMinutes ?? Number.POSITIVE_INFINITY)
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

function withBrowserClientSessionId(payload: BackendSearchPayload): BackendSearchPayload {
  const clientSessionId = getBrowserClientSessionId()
  return clientSessionId ? { ...payload, clientSessionId } : payload
}

function migrationOfferDepartureDate(offer: CanonicalOffer): string | undefined {
  const outbound = offer.itineraries?.find((itinerary) => itinerary.direction === "outbound")
    ?? offer.itineraries?.[0]
  const departureAt = outbound?.segments?.[0]?.departureAt
  const itineraryDate = typeof departureAt === "string" && departureAt.length >= 10
    ? departureAt.slice(0, 10)
    : undefined

  if (isIsoDate(itineraryDate)) {
    return itineraryDate
  }

  return isIsoDate(offer.departureDate) ? offer.departureDate : undefined
}

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
      .map(migrationOfferDepartureDate)
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

export async function requestQuotation(
  payload: QuotationRequest,
  options: RequestOptions = {},
): Promise<QuotationResponse> {
  const data = await postJson<{
    searchSessionId?: unknown
    offer?: unknown
    commercialText?: unknown
  }>(`${API_BASE}/api/quotation`, payload, options)
  const rawOffer = data.offer
  const rawOfferRecord = offerTransportRecord(rawOffer)
  const priceVerifiedAt = rawOfferRecord?.priceVerifiedAt

  if (
    typeof data.searchSessionId !== "string"
    || data.searchSessionId !== payload.searchSessionId
    || typeof data.commercialText !== "string"
    || data.commercialText.trim().length === 0
    || !rawOfferRecord
    || typeof rawOfferRecord.id !== "string"
    || typeof rawOfferRecord.providerSource !== "string"
    || rawOfferRecord.priceConfidence !== "validated"
    || rawOfferRecord.priceStatus !== "verified"
    || typeof priceVerifiedAt !== "string"
    || !Number.isFinite(Date.parse(priceVerifiedAt))
  ) {
    throw new FlyDeskApiError(
      "El servidor devolvió una cotización no válida.",
      ["POST /api/quotation returned an invalid contract."],
    )
  }

  const offer = normalizeOffer(rawOffer)
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
  options: SearchRequestOptions = {}
): Promise<SearchJobResponse> {
  const payload = withBrowserClientSessionId({
    ...toBackendPayload(request, sortMode),
    ...(options.recordLocationUsage === undefined
      ? {}
      : { recordLocationUsage: options.recordLocationUsage }),
  })
  const data = await postJson<BackendSearchJobResponse>(`${API_BASE}/api/search`, payload, options)
  if (data.searchJobId) {
    options.onJobStart?.({ id: data.searchJobId, type: "search" })
  }
  return normalizeSearchJob(data)
}

export async function pollSearch(jobId: string, sinceRevision?: number, options: RequestOptions = {}): Promise<SearchJobResponse> {
  let url = `${API_BASE}/api/search/${jobId}`
  if (sinceRevision !== undefined) url += `?sinceRevision=${sinceRevision}&wait=${POLL_LONG_WAIT_MS}`
  const data = await getJson<BackendSearchJobResponse>(url, options)
  return normalizeSearchJob(data)
}

export async function startMatrix(
  request: SearchRequest,
  sortMode: SortMode,
  options: SearchRequestOptions = {}
): Promise<SearchJobResponse> {
  const payload = withBrowserClientSessionId(toBackendPayload(request, sortMode))
  const data = await postJson<BackendMatrixJobResponse>(`${API_BASE}/api/matrix`, payload, options)
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
  if (sinceRevision !== undefined) url += `?sinceRevision=${sinceRevision}&wait=${POLL_LONG_WAIT_MS}`
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
    const selectedOffers = monthResults.flatMap((result) => result.offer ? [result.offer] : [])
    const allOffers = monthResults.flatMap((result) => result.offers)
    const warnings = uniqueStrings(monthResults.flatMap((result) => result.warnings))
    const diagnosticLog = toDiagnosticLines(monthResults.flatMap((result) => result.diagnosticLog))
    const providerMeta = monthResults.find((result) => result.job?.providerMeta)?.job?.providerMeta ?? {
      exactProvider: "agil-local",
      coverageMode: "core",
    }
    const hasPendingMonth = monthResults.some((result) => !result.complete)
    /*
     * Whether the sweep is incomplete comes from the months' own jobs, not from
     * the state the grid draws them in. A month that finishes with a fare after
     * a partial provider scan is «con tarifa» on screen (06 §3 has no fifth
     * state for it) while still being a month that was not fully swept, and
     * reading the display status here would have dropped that from the sweep.
     */
    const hasPartialMonth = monthResults.some((result) => (
      result.status === "error" || Boolean(result.job?.searchMeta?.partial)
    ))
    const migrationIsPartial = hasPendingMonth || hasPartialMonth
    const monthlyWarnings = searchComplete && selectedOffers.length === 0
      ? uniqueStrings([
          ...warnings,
          ranges.length === 1
            ? "Migratorio no encontró tarifas disponibles en el mes seleccionado."
            : "Migratorio no encontró tarifas disponibles en los meses seleccionados.",
        ])
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
    migrationConcurrentRequests(),
    async (range, index) => {
      try {
        throwIfAborted(options.signal)
        let job = await startSearch(migrationRequestForMonth(request, range), "cheapest", {
          ...options,
          recordLocationUsage: index === 0,
        })
        let lastRevision = job.revision

        while (true) {
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
            /*
             * Whether the month is still out is `searchComplete`, never
             * `searchMeta.partial`. The router's first response for every month
             * is a draft — `partial: true` with no offers — so keying on it
             * moved a month that had only just been asked straight to
             * «partial», where the grid drew it grey and fareless while the
             * header counted it as searching. It also never let go: `partial`
             * stays true after a month completes with a provider down, which
             * left that month spinning for good.
             */
            status: job.searchComplete
              ? offer ? "available" : "empty"
              : offer ? "partial" : "loading",
          }
          emitProgress()

          if (job.searchComplete) break

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

        const previous = monthResults[index]
        const preservedOffer = previous.offer ?? cheapestOffer(previous.offers)
        const preservedOffers = previous.offers.length > 0
          ? previous.offers
          : preservedOffer
            ? [preservedOffer]
            : []

        monthResults[index] = {
          range,
          job: previous.job,
          offer: preservedOffer,
          offers: preservedOffers,
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
