import type { BaggageSummary, CanonicalOffer, Itinerary, Segment } from "@/types"
import { cityNameForIataCode, normalizeIataCode, stripAllAirportsLabel } from "../../../src/core/location-display"

export type LayoverItem = {
  city: string
  minutes: number
}

export type OfferDetailSummary = {
  routeLabel: string
  stopsLabel: string
  baggageLabel: string
  departureDateTime: string
  returnDateTime: string
}

export function primaryItineraryForOffer(offer: Pick<CanonicalOffer, "itineraries">): Itinerary | null {
  return offer.itineraries?.find((itinerary) => itinerary.direction === "outbound")
    ?? offer.itineraries?.[0]
    ?? null
}

export function returnItineraryForOffer(offer: Pick<CanonicalOffer, "itineraries">): Itinerary | null {
  return offer.itineraries?.find((itinerary) => itinerary.direction === "inbound")
    ?? null
}

export function firstSegmentForItinerary(itinerary?: Itinerary | null): Segment | undefined {
  return itinerary?.segments?.[0]
}

export function lastSegmentForItinerary(itinerary?: Itinerary | null): Segment | undefined {
  const segments = itinerary?.segments ?? []
  return segments[segments.length - 1]
}

export function itineraryRouteLabel(
  itinerary?: Itinerary | null,
  fallback: { origin?: unknown; destination?: unknown } = {},
): string {
  const route = itineraryRouteCodes(itinerary, fallback)
  return route.length > 0 ? route.join(" - ") : "Ruta por confirmar"
}

export function offerRouteLabel(offer: CanonicalOffer): string {
  return itineraryRouteLabel(primaryItineraryForOffer(offer), {
    origin: offer.origin,
    destination: offer.destination,
  })
}

export function stopsCountForOffer(offer: CanonicalOffer): number {
  const itineraryStops = (offer.itineraries ?? [])
    .map(stopsCountFromItinerary)
    .filter((value): value is number => value !== undefined)

  if (itineraryStops.length > 0) {
    return itineraryStops.reduce((sum, value) => sum + value, 0)
  }

  return nonNegativeNumber(offer.comparisonMetrics?.totalStops)
    ?? nonNegativeNumber(offer.stops)
    ?? 0
}

export function layoverItemsForOffer(offer: CanonicalOffer): LayoverItem[] {
  return (offer.itineraries ?? []).flatMap((itinerary) => layoverItemsForItinerary(itinerary))
}

export function layoverItemsForItinerary(itinerary: Itinerary): LayoverItem[] {
  if (itinerary.segments.length < 2) return []

  return itinerary.segments.slice(0, -1).flatMap((segment, index) => {
    const next = itinerary.segments[index + 1]
    const minutes = positiveNumber(itinerary.layoverMinutes?.[index]) ?? computeLayoverMinutes(segment, next)
    if (!Number.isFinite(minutes) || minutes <= 0) return []

    return {
      city: stopCityLabel(segment),
      minutes,
    }
  })
}

export function formatOfferStopsLabel(offer: CanonicalOffer): string {
  const stops = stopsCountForOffer(offer)
  if (stops <= 0) return "Directo"

  const label = stops === 1 ? "1 escala" : `${stops} escalas`
  const layovers = layoverItemsForOffer(offer)
  if (layovers.length === 0) return label

  const primaryCity = layovers[0]?.city || "Ciudad por confirmar"
  const citySummary = layovers.length > 1 ? `${primaryCity} +${layovers.length - 1}` : primaryCity
  return `${label} · ${citySummary}`
}

export function formatOfferBaggageLabel(baggage: unknown): string | undefined {
  if (!baggage) return undefined
  if (typeof baggage === "string") return baggage
  if (typeof baggage !== "object") return undefined

  const value = baggage as BaggageSummary
  const parts: string[] = []
  if (value.carryOnIncluded) parts.push("Cabina")
  if (value.checkedIncluded) {
    parts.push(value.checkedBags && value.checkedBags > 1 ? `${value.checkedBags} maletas` : "Bodega")
  }
  if (!parts.length && value.description) return value.description
  return parts.length ? parts.join(" + ") : undefined
}

export function buildOfferDetailSummary(offer: CanonicalOffer): OfferDetailSummary {
  const outbound = primaryItineraryForOffer(offer)
  const inbound = returnItineraryForOffer(offer)
  const outboundDeparture = firstSegmentForItinerary(outbound)?.departureAt ?? offer.departureDate
  const inboundDeparture = firstSegmentForItinerary(inbound)?.departureAt ?? offer.returnDate

  return {
    routeLabel: offerRouteLabel(offer),
    stopsLabel: formatOfferStopsLabel(offer),
    baggageLabel: offer.baggageLabel || formatOfferBaggageLabel(offer.baggage) || "Consultar",
    departureDateTime: formatOfferDateTime(outboundDeparture),
    returnDateTime: inboundDeparture ? formatOfferDateTime(inboundDeparture) : "No aplica",
  }
}

export function formatJourneyDuration(minutes: number): string {
  const total = Math.round(minutes)
  const days = Math.floor(total / 1440)
  const hours = Math.floor((total % 1440) / 60)
  const mins = total % 60
  const parts: string[] = []

  if (days > 0) parts.push(`${days}d`)
  if (hours > 0 || days > 0) parts.push(`${hours}h`)
  parts.push(`${mins}m`)
  return parts.join(" ")
}

export function formatOfferDateTime(value?: string): string {
  if (!value) return "-"
  const date = isoDatePart(value)
  const time = timeOfIso(value)
  if (date && time) return `${formatDateCompact(date)}, ${time}`
  if (date) return formatDateCompact(date)
  if (time) return time
  return String(value).trim() || "-"
}

export function formatOfferDate(value?: string): string {
  const date = isoDatePart(value)
  if (!date) return "-"

  const [year, month, day] = date.split("-")
  if (!year || !month || !day) return date
  return `${day}/${month}/${year}`
}

export function timeOfIso(value?: string): string {
  if (!value) return ""
  const trimmed = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return ""
  if (trimmed.includes("T") && trimmed.length >= 16) return trimmed.slice(11, 16)

  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) return ""
  return parsed.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", hour12: false })
}

export function isoDatePart(value?: string): string {
  if (!value) return ""
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10)

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return ""
  return parsed.toISOString().slice(0, 10)
}

export function formatDateCompact(iso?: string): string {
  const value = isoDatePart(iso)
  if (!value) return "-"

  const [year, month, day] = value.split("-")
  if (!year || !month || !day) return value
  return `${day}/${month}`
}

export function diffDaysIso(from: string, to: string): number {
  const fromMs = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)))
  const toMs = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)))
  return Math.round((toMs - fromMs) / 86400000)
}

function itineraryRouteCodes(
  itinerary?: Itinerary | null,
  fallback: { origin?: unknown; destination?: unknown } = {},
): string[] {
  const segments = itinerary?.segments ?? []
  const route: string[] = []

  if (segments.length > 0) {
    appendRouteToken(route, segments[0]?.origin ?? fallback.origin)
    segments.forEach((segment) => appendRouteToken(route, segment.destination))
  } else {
    appendRouteToken(route, fallback.origin)
    appendRouteToken(route, fallback.destination)
  }

  return route
}

function appendRouteToken(route: string[], value: unknown): void {
  const token = routeLocationToken(value)
  if (!token || route[route.length - 1] === token) return
  route.push(token)
}

function routeLocationToken(value: unknown): string {
  const normalized = normalizeIataCode(String(value ?? ""))
  if (!normalized) return ""
  return normalized.match(/\b[A-Z]{3}\b/)?.[0] ?? normalized
}

function stopsCountFromItinerary(itinerary: Itinerary): number | undefined {
  const explicit = nonNegativeNumber(itinerary.stops)
  const segmentStops = itinerary.segments.length > 0 ? Math.max(0, itinerary.segments.length - 1) : undefined
  if (explicit !== undefined) return Math.max(explicit, segmentStops ?? 0)
  return segmentStops
}

function stopCityLabel(segment: Segment): string {
  const code = routeLocationToken(segment.destination)
  const fallback = cityNameForIataCode(code)
  if (fallback) return fallback

  const name = normalizeCityLabel(segment.destinationName)
  if (name && name.toUpperCase() !== code) return name
  return code || "Ciudad por confirmar"
}

function normalizeCityLabel(value: unknown): string {
  const normalized = stripAllAirportsLabel(String(value ?? ""))
    .replace(/^[A-Z]{3}\s*[·-]\s*/iu, "")
    .replace(/\(([A-Z]{3})\)\s*$/iu, "")
    .trim()

  if (!normalized) return ""
  if (/^[A-Z]{3}$/.test(normalized)) return normalized
  return normalized
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function computeLayoverMinutes(current: Segment, next?: Segment): number {
  if (!current.arrivalAt || !next?.departureAt) return 0
  const currentMs = Date.parse(current.arrivalAt)
  const nextMs = Date.parse(next.departureAt)
  if (!Number.isFinite(currentMs) || !Number.isFinite(nextMs) || nextMs <= currentMs) return 0
  return Math.round((nextMs - currentMs) / 60000)
}

function nonNegativeNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : undefined
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined
}
