import type { BaggageSummary, CanonicalOffer, Itinerary, Segment } from "@/types"
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

export function itineraryRouteLabel(
  itinerary?: Itinerary | null,
  fallback: { origin?: unknown; destination?: unknown } = {},
): string {
  const route = itineraryRouteCodes(itinerary, fallback)
  return route.length > 0 ? route.join(" - ") : "Ruta por confirmar"
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

/**
 * Hours and minutes, however many hours it takes.
 *
 * It used to break a day out — «1d 5h 50m» — and for as long as every duration
 * in the product was silently reduced modulo 24 hours, no row ever reached the
 * branch. With the clocks read properly a Lima-Madrid connection is 29h 50m,
 * and the column that names it is the one the agent sorts on: «19h 55m» over
 * «1d 5h 50m» over «22h 20m» cannot be compared by eye, and two of those three
 * need arithmetic before they can even be ranked. One unit, always the same
 * one, and the figures line up as figures.
 *
 * The minutes stay when they are zero — «32h 0m», beside «19h 55m» — because
 * this is a lane of tabular numerals and a row that drops its last term is a
 * row that stops lining up with the rest.
 */
export function formatJourneyDuration(minutes: number): string {
  const total = Math.round(minutes)
  const hours = Math.floor(total / 60)
  const mins = total % 60

  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`
}

const OFFER_DATE_MONTHS = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic",
]

/**
 * «26 may 2026», the way both detail plates write a ticketing date.
 *
 * Not `26/05/2026`. A slashed date is a field the agent types into; this one is
 * read, and the month in letters is what stops it being confused with the
 * day — the panel it sits in already carries four other figures.
 */
export function formatOfferDate(value?: string): string {
  const date = isoDatePart(value)
  if (!date) return "-"

  const [year, month, day] = date.split("-")
  if (!year || !month || !day) return date
  const name = OFFER_DATE_MONTHS[Number(month) - 1]
  return name ? `${Number(day)} ${name} ${year}` : `${day}/${month}/${year}`
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

/**
 * Stops on one leg.
 *
 * When the declared count disagrees with the segments, the larger wins. A
 * provider that sends two segments but declares zero stops is simply wrong —
 * there is demonstrably a plane change. The reverse can be legitimate: a
 * technical stop keeps one flight number and one segment, so a declared count
 * above the segment boundaries is believed.
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
  // One parser for both surfaces: the card's stop label and the detail's
  // station line used to strip different things, which is how «(todos los
  // aeropuertos)» survived into the itinerary.
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

/*
 * Plate 1b writes the stop as «LIM · Jorge Chávez», in the case a person would
 * write it. Agil hands the airport name straight through and Click and Book
 * Plus falls back to its own label, and both providers shout: «SAO PAULO
 * GUARULHOS». Shouting is not a fact about the airport, so it is corrected on
 * the way to the screen — and only when there is nothing to lose, i.e. when the
 * provider sent no lowercase of its own.
 */
const SPANISH_CONNECTORS = new Set(["de", "del", "la", "las", "el", "los", "y", "e", "da", "do", "dos"])

/**
 * Everything a provider bolts onto a station name that is not the station.
 *
 * «(todos los aeropuertos)» is a *search* concept — it means the query covered
 * a whole city — and it has no business on a leg of an itinerary that departs
 * from one runway. The `LIM ·` prefix and the trailing `(LIM)` are the code the
 * label is already paired with, so leaving them in prints it twice.
 */
function stripStationNoise(value: string): string {
  return stripAllAirportsLabel(value)
    .replace(/^[A-Z]{3}\s*[·-]\s*/iu, "")
    .replace(/\s*\([A-Z]{3}\)\s*$/iu, "")
    .trim()
}

/**
 * What the itinerary calls the place a code names.
 *
 * The code decides it, not the provider: Agil answers «Lima» for LIM and Click
 * and Book Plus answers «Aeropuerto Internacional Jorge Chávez», and the same
 * flight read one way in one search and the other way in the next. The
 * catalogue behind `cityNameForIataCode` is the one the card's stop label
 * already falls back to, so this is the *same* parser reaching the detail
 * rather than a second opinion about the same station.
 *
 * A code the catalogue does not know keeps the provider's own name, cleaned:
 * no catalogue can derive «Lima» from «Jorge Chávez», and a name is more than
 * three letters of nothing.
 */
export function stationPlaceName(code?: string, name?: string): string {
  const city = cityNameForIataCode(code)
  if (city) return city

  /* Plate 1b's shape, for a code the catalogue cannot answer: «SYD · Sydney
     Kingsford Smith», not «SYD · Sydney Kingsford Smith International
     Airport». The words that name the facility are not the name of the place,
     and dropping them is what makes two providers describing the same runway
     at different lengths read alike. Only applied to a label that announces
     itself as one, so a station whose real name happens to be long is left as
     the provider wrote it.

     LIM is deliberately not the example: it is catalogued, so it never reaches
     this branch — the line above answers «Lima» whichever provider asked. */
  const provider = stationDisplayName(name)
  return isAirportFacilityLabel(provider) ? stripAirportFacilityWords(provider) : provider
}

export function stationDisplayName(value?: string): string {
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
