import type { CanonicalOffer, LocationSuggestion, SearchRequest, SearchJobResponse, SortMode } from "@/types"

const API_BASE = ""

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.errors?.join(" ") || data.error || "Error inesperado")
  return data as T
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || "Error inesperado")
  return data as T
}

export async function suggestLocations(query: string, limit = 8): Promise<LocationSuggestion[]> {
  if (query.length < 2) return []
  const data = await getJson<{ suggestions: LocationSuggestion[] }>(
    `${API_BASE}/api/locations?q=${encodeURIComponent(query)}&limit=${limit}`
  )
  return data.suggestions
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
      maxLayoverMinutes?: number
    }
  }
  offers?: unknown[]
  allOffers?: unknown[]
}

function toBackendPayload(request: SearchRequest, sortMode: SortMode) {
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
        maxLayoverMinutes: request.maxLayoverMinutes ? Number(request.maxLayoverMinutes) : undefined,
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
    baggageRequired: request?.filters?.baggageRequired,
    maxLayoverMinutes: request?.filters?.maxLayoverMinutes?.toString(),
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
    departureDate: String(outbound?.departureAt ?? offer.departureDate ?? ""),
    returnDate: typeof inbound?.departureAt === "string" ? inbound.departureAt : offer.returnDate as string | undefined,
    duration: durationLabel(metrics.totalDurationMinutes),
    stops: typeof metrics.totalStops === "number" ? metrics.totalStops : Number(offer.stops ?? 0),
    stopMeta: `${String(outbound?.origin ?? "")} -> ${String(outbound?.destination ?? "")}`,
    baggage: typeof offer.baggage === "string" ? offer.baggage : undefined,
    price,
  }
}

function normalizeSearchJob(data: BackendSearchJobResponse): SearchJobResponse {
  return {
    ...data,
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
