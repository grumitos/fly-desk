import type { CanonicalOffer, Itinerary, Segment } from "@/types"
import { formatDate } from "@/lib/format"
import {
  cityNameForIataCode,
  isAirportFacilityLabel,
  normalizeIataCode,
  stripAirportFacilityWords,
  stripAllAirportsLabel,
} from "../../../src/core/location-display"

export type LayoverItem = {
  city: string
  minutes: number
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

/*
 * Hours and minutes however many hours it takes, and «0m» kept: the column is
 * sorted by eye, and «29h 50m» over «1d 5h 50m» cannot be compared.
 */
export function formatJourneyDuration(minutes: number): string {
  const total = Math.round(minutes)
  const hours = Math.floor(total / 60)
  const mins = total % 60

  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`
}

/** «26 set 2026», a date that is read rather than typed. */
export function formatOfferDate(value?: string): string {
  return formatDate(isoDatePart(value), { padDay: false }) || "-"
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

export function diffDaysIso(from: string, to: string): number {
  const fromMs = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)))
  const toMs = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)))
  return Math.round((toMs - fromMs) / 86400000)
}

function routeLocationToken(value: unknown): string {
  const normalized = normalizeIataCode(String(value ?? ""))
  if (!normalized) return ""
  return normalized.match(/\b[A-Z]{3}\b/)?.[0] ?? normalized
}

/*
 * The larger count wins: two segments declared as zero stops is a plane change
 * the provider forgot, while a technical stop keeps one segment and is believed.
 */
export function stopsCountFromItinerary(itinerary: Itinerary): number | undefined {
  const explicit = nonNegativeNumber(itinerary.stops)
  const segmentStops = itinerary.segments.length > 0 ? Math.max(0, itinerary.segments.length - 1) : undefined
  if (explicit !== undefined) return Math.max(explicit, segmentStops ?? 0)
  return segmentStops
}

function stopCityLabel(segment: Segment): string {
  const code = routeLocationToken(segment.destination)
  if (code) return code

  const name = normalizeCityLabel(segment.destinationName)
  if (name && name.toUpperCase() !== code) return name
  return cityNameForIataCode(code) || "Ciudad por confirmar"
}

function normalizeCityLabel(value: unknown): string {
  const normalized = stripStationNoise(String(value ?? ""))

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

/* Providers shout station names («SAO PAULO GUARULHOS»); a name with no
   lowercase of its own is re-cased, keeping Spanish connectors lowercase. */
const SPANISH_CONNECTORS = new Set(["de", "del", "la", "las", "el", "los", "y", "e", "da", "do", "dos"])

/** «(todos los aeropuertos)» is a search concept, and the code prefix/suffix repeats the code. */
function stripStationNoise(value: string): string {
  return stripAllAirportsLabel(value)
    .replace(/^[A-Z]{3}\s*[·-]\s*/iu, "")
    .replace(/\s*\([A-Z]{3}\)\s*$/iu, "")
    .trim()
}

/**
 * What the itinerary calls the place a code names. The catalogue decides, so
 * two providers describing one runway read alike; an unknown code keeps the
 * provider's own name without the facility words.
 */
export function stationPlaceName(code?: string, name?: string): string {
  const city = cityNameForIataCode(code)
  if (city) return city

  const provider = stationDisplayName(name)
  return isAirportFacilityLabel(provider) ? stripAirportFacilityWords(provider) : provider
}

function stationDisplayName(value?: string): string {
  const name = stripStationNoise(String(value ?? "").trim())
  if (!name || /\p{Ll}/u.test(name)) return name

  return name
    .toLocaleLowerCase("es")
    .split(/\s+/)
    .map((word, index) => (
      index > 0 && SPANISH_CONNECTORS.has(word)
        ? word
        : word.charAt(0).toLocaleUpperCase("es") + word.slice(1)
    ))
    .join(" ")
}
