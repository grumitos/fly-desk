import type { CanonicalOffer, LocationSuggestion, SearchRequest, SearchJobResponse, SortMode } from "@/types"
import { filterLocationSuggestions, normalizeLocationSearchText, normalizeLocationSuggestions } from "@/lib/locations"

const API_BASE = ""
const locationSuggestionCache = new Map<string, LocationSuggestion[]>()
const locationSuggestionPool = new Map<string, LocationSuggestion>()

function translateApiMessage(message: string): string {
  const normalized = message.trim()

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

  if (normalized.includes("byte limit")) {
    return "La solicitud es demasiado grande."
  }

  if (/^Agil returned no offers/i.test(normalized)) {
    return "Agil no devolvió ofertas para esta búsqueda."
  }

  if (/^Costamar returned no offers/i.test(normalized)) {
    return "Costamar no devolvió ofertas para esta búsqueda."
  }

  if (/Agil .*search failed/i.test(normalized)) {
    return "Falló la búsqueda en Agil."
  }

  if (/Costamar .*search failed/i.test(normalized)) {
    return "Falló la búsqueda en Costamar."
  }

  return normalized || "Ocurrió un error inesperado."
}

function apiErrorMessage(data: { errors?: unknown; error?: unknown }): string {
  if (Array.isArray(data.errors)) {
    return data.errors
      .map((message) => translateApiMessage(String(message)))
      .join(" ")
  }

  if (typeof data.error === "string") {
    return translateApiMessage(data.error)
  }

  return "Ocurrió un error inesperado."
}

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(apiErrorMessage(data))
  return data as T
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  const data = await res.json()
  if (!res.ok) throw new Error(apiErrorMessage(data))
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
    legs?: Array<{
      origin?: string
      destination?: string
      departureDate?: string
      returnDate?: string
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
      legs: [
        {
          origin: request.origin,
          destination: request.destination,
          departureDate: request.departureDate,
          returnDate: request.returnDate,
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
    returnDate: leg.returnDate,
    tripType: request?.tripType === "one-way" ? "one-way" : "round-trip",
    adults: request?.passengers?.adults ?? 1,
    children: request?.passengers?.children ?? 0,
    infants: request?.passengers?.infants ?? 0,
    searchMode: request?.searchMode ?? "exact",
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
    price,
  }
}

function normalizeSearchJob(data: BackendSearchJobResponse): SearchJobResponse {
  const warnings = (data.warnings ?? []).map((warning) => translateApiMessage(String(warning)))
  const searchMeta = data.searchMeta
    ? {
        ...data.searchMeta,
        warnings: (data.searchMeta.warnings ?? []).map((warning) => translateApiMessage(String(warning))),
      }
    : data.searchMeta

  return {
    ...data,
    searchMeta,
    warnings,
    request: fromBackendRequest(data.request),
    offers: (data.offers ?? []).map(normalizeOffer),
    allOffers: (data.allOffers ?? []).map(normalizeOffer),
  }
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

export async function fetchQuotation(searchSessionId: string, offerId: string) {
  return postJson<{ commercialText: string; offer: unknown }>(`${API_BASE}/api/quotation`, {
    searchSessionId,
    offerId,
  })
}
