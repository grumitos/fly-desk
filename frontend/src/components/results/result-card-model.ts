import type { CanonicalOffer, Itinerary, RedirectVerification, Segment } from "@/types"
import { airlineLogoAssetPath } from "../../../../src/core/airline-assets"
import { normalizeAirlineDisplayName, resolveAirlineDisplayName } from "@/lib/airline-names"
import {
  diffDaysIso,
  formatJourneyDuration,
  isoDatePart,
  layoverItemsForItinerary,
  primaryItineraryForOffer,
  returnItineraryForOffer,
  stopsCountFromItinerary,
  timeOfIso,
} from "@/lib/offer-display"
import { providerDisplayName } from "@/lib/providers"

/*
 * The card model for plate 1b.
 *
 * Two decisions from the plate shape this file:
 *
 * 1. Duration and stops are *per leg*. The old card added outbound and inbound
 *    together, which produced a number ("19h 05m") that matches no flight the
 *    agent is about to sell.
 * 2. The "Ruta" column is gone. It restated the origin and destination that were
 *    typed into the search, and with its width returned the two schedules sit
 *    together and the price has nothing to its left.
 */

/** How urgent a seat count is. Only shown at four seats or fewer. */
export type SeatsUrgency = "low" | "critical"

export type ResultLegModel = {
  /** "Ida" / "Vta" — the short form the 58px label column can hold. */
  label: string
  ariaLabel: string
  /** dd/MM next to the label, so the row says which day it departs. */
  dateLabel: string
  departureTime: string
  arrivalTime: string
  hasKnownSchedule: boolean
  /** "+1" when the flight lands on a later day; lives in its own lane. */
  dayOffset: string
  duration: string
  /** "Directo" · "1 escala en PTY" · "2 escalas · PTY, BOG" · "PTY, BOG +2". */
  stopsLabel: string
  stopsTitle: string
  stopsTone: "direct" | "one-stop" | "many-stops" | "unknown"
}

export type ResultCardModel = {
  carrier: {
    code: string
    name: string
    logo: string
    /** "op. LATAM" — the codeshare operator, when it differs from the marketer. */
    operatedBy: string
  }
  baggage: {
    carryOnIncluded: boolean | undefined
    checkedIncluded: boolean | undefined
    label: string
    ariaLabel: string
  }
  legs: ResultLegModel[]
  price: {
    label: string
    perPersonLabel: string
    ariaLabel: string
  }
  seats: {
    label: string
    urgency: SeatsUrgency
  } | null
  provider: {
    label: string
    shortLabel: string
    icon: string
  }
  costamarRedirect?: ResultRedirectStatus
  tripType: "one-way" | "round-trip"
}

export type ResultRedirectStatus = {
  label: string
  title: string
  tone: "verified" | "pending" | "blocked"
}

export type ResultProviderBadge = ResultCardModel["provider"]

/** Below this the count is worth interrupting the agent for; above it, noise. */
const SEATS_VISIBLE_THRESHOLD = 4
const SEATS_CRITICAL_THRESHOLD = 2

export function buildResultCardModel(
  offer: CanonicalOffer,
  passengerCount: number,
): ResultCardModel {
  const outbound = primaryItineraryForOffer(offer)
  const inbound = returnItineraryForOffer(offer)
  const outboundLeg = legModel(outbound, offer, "outbound")
  const inboundLeg = inbound || offer.returnDate ? legModel(inbound, offer, "inbound") : null

  return {
    carrier: carrierParts(offer),
    baggage: baggageParts(offer),
    legs: [outboundLeg, inboundLeg].filter((leg): leg is ResultLegModel => Boolean(leg)),
    price: priceParts(offer, passengerCount),
    seats: seatsParts(offer),
    provider: providerBadge(offer),
    costamarRedirect: costamarRedirectStatus(offer),
    tripType: inboundLeg ? "round-trip" : "one-way",
  }
}

function legModel(
  itinerary: Itinerary | null,
  offer: CanonicalOffer,
  direction: "outbound" | "inbound",
): ResultLegModel {
  const segments = itinerary?.segments ?? []
  const first = segments[0]
  const last = segments[segments.length - 1]
  const departureIso = first?.departureAt ?? (direction === "inbound" ? offer.returnDate : offer.departureDate)
  const arrivalIso = last?.arrivalAt ?? (direction === "inbound" ? undefined : offer.arrivalDate)
  const departureDate = isoDatePart(departureIso)
  const arrivalDate = isoDatePart(arrivalIso)
  const departureTime = timeOfIso(departureIso)
  const arrivalTime = timeOfIso(arrivalIso)
  const hasKnownSchedule = Boolean(departureTime || arrivalTime)
  const dayOffset = departureDate && arrivalDate ? Math.max(0, diffDaysIso(departureDate, arrivalDate)) : 0
  const stops = stopsForItinerary(itinerary)

  return {
    label: direction === "outbound" ? "Ida" : "Vta",
    ariaLabel: direction === "outbound" ? "Ida" : "Vuelta",
    dateLabel: dayMonthLabel(departureDate),
    departureTime: departureTime || "--:--",
    arrivalTime: arrivalTime || "--:--",
    hasKnownSchedule,
    dayOffset: dayOffset > 0 ? `+${dayOffset}` : "",
    duration: legDuration(itinerary, offer),
    stopsLabel: stops.label,
    stopsTitle: stops.title,
    stopsTone: stops.tone,
  }
}

/** Per-leg duration, falling back to the offer's own string only if we must. */
function legDuration(itinerary: Itinerary | null, offer: CanonicalOffer): string {
  const minutes = itinerary?.durationMinutes
  if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0) {
    return formatJourneyDuration(minutes)
  }

  return offer.duration || "--"
}

/**
 * Stops for one leg, named by airport. From three stops the label shows two
 * codes and `+n`: the third code costs more width than it buys, and the agent
 * who cares opens the detail panel anyway.
 */
function stopsForItinerary(itinerary: Itinerary | null) {
  if (!itinerary) {
    return {
      label: "Escalas por confirmar",
      title: "No hay itinerario para confirmar las escalas",
      tone: "unknown" as const,
    }
  }

  const segments = itinerary?.segments ?? []
  const stopCount = stopsCountFromItinerary(itinerary)
    ?? Math.max(0, segments.length - 1)

  if (stopCount === 0) {
    return { label: "Directo", title: "Vuelo directo", tone: "direct" as const }
  }

  const codes = segments
    .slice(0, -1)
    .map((segment) => String(segment.destination ?? "").trim().toUpperCase())
    .filter(Boolean)
  const layovers = itinerary ? layoverItemsForItinerary(itinerary) : []
  const title = layovers.length
    ? layovers.map((item) => `${item.city}: ${formatJourneyDuration(item.minutes)}`).join(" · ")
    : `${stopCount} ${stopCount === 1 ? "escala" : "escalas"}`

  if (stopCount === 1) {
    return {
      label: codes[0] ? `1 escala en ${codes[0]}` : "1 escala",
      title,
      tone: "one-stop" as const,
    }
  }

  const shown = codes.slice(0, 2).join(", ")
  const overflow = codes.length > 2 ? ` +${codes.length - 2}` : ""
  return {
    label: shown ? `${stopCount} escalas · ${shown}${overflow}` : `${stopCount} escalas`,
    title,
    tone: "many-stops" as const,
  }
}

function carrierParts(offer: CanonicalOffer) {
  const segment = primaryItineraryForOffer(offer)?.segments?.[0]
  const code = String(
    offer.mainCarrier ?? offer.validatingCarrier ?? segment?.marketingCarrier ?? offer.airline ?? "",
  ).trim()
  const names = [segment?.marketingCarrierName, offer.airline, segment?.operatingCarrierName]
  const name = resolveAirlineDisplayName({
    names,
    codes: [code, offer.validatingCarrier, segment?.marketingCarrier, segment?.operatingCarrier],
  })
  const knownTokens = new Set(
    [code, name, names.find((value) => value?.trim())].map((value) => String(value ?? "").trim().toUpperCase()),
  )

  return {
    code,
    name: name || "Aerolínea",
    logo: airlineLogoAssetPath(code),
    operatedBy: operatingCopy(offer, knownTokens),
  }
}

/**
 * The codeshare operator, phrased "op. LATAM" — the agent needs to know who
 * actually flies it, because that is who the passenger will deal with at the
 * gate. Only the operators that differ from the marketing carrier appear.
 */
function operatingCopy(offer: CanonicalOffer, knownTokens: Set<string>): string {
  const operators = new Set<string>()

  offer.itineraries?.forEach((itinerary) => {
    itinerary.segments.forEach((segment: Segment) => {
      const marketing = String(segment.marketingCarrier ?? "").trim().toUpperCase()
      const operating = String(segment.operatingCarrier ?? "").trim().toUpperCase()
      const label = normalizeAirlineDisplayName(segment.operatingCarrierName?.trim() || operating)

      if (!label) return
      if (operating && marketing && operating === marketing) return
      if (knownTokens.has(label.toUpperCase()) || knownTokens.has(operating)) return
      operators.add(label)
    })
  })

  return operators.size > 0 ? `op. ${Array.from(operators).join(" / ")}` : ""
}

function baggageParts(offer: CanonicalOffer) {
  const carryOnIncluded = offer.baggage?.carryOnIncluded
  const checkedIncluded = offer.baggage?.checkedIncluded
  const labels = [
    carryOnIncluded === true ? "mano" : carryOnIncluded === false ? "mano: no incluido" : "",
    checkedIncluded === true ? "bodega" : checkedIncluded === false ? "bodega: no incluido" : "",
  ].filter(Boolean)
  const ariaLabels = [
    carryOnIncluded === true
      ? "Equipaje de mano incluido"
      : carryOnIncluded === false ? "Equipaje de mano no incluido" : "",
    checkedIncluded === true
      ? "Equipaje de bodega incluido"
      : checkedIncluded === false ? "Equipaje de bodega no incluido" : "",
  ].filter(Boolean)

  return {
    carryOnIncluded,
    checkedIncluded,
    label: labels.join(" + "),
    ariaLabel: ariaLabels.join(", "),
  }
}

function priceParts(offer: CanonicalOffer, passengerCount: number) {
  const money = offer.price?.total
  if (!money) {
    return { label: "--", perPersonLabel: "", ariaLabel: "Precio no disponible" }
  }

  const label = formatMoney(money)
  const showPerPerson = Number.isFinite(passengerCount) && passengerCount > 1
  const perPersonLabel = showPerPerson
    ? formatMoney({ ...money, amount: money.amount / passengerCount })
    : ""

  return {
    label,
    perPersonLabel,
    ariaLabel: perPersonLabel ? `${label} total, ${perPersonLabel} por persona` : `${label} total`,
  }
}

/**
 * Seats remaining, shown only at four or fewer. Above that the number is not a
 * reason to act, and a card that always shows a count trains the agent to stop
 * reading it.
 */
function seatsParts(offer: CanonicalOffer): ResultCardModel["seats"] {
  const seats = offer.fareMeta?.seatsRemaining
  if (typeof seats !== "number" || !Number.isFinite(seats) || seats <= 0) return null
  if (seats > SEATS_VISIBLE_THRESHOLD) return null

  return {
    label: seats === 1 ? "1 asiento" : `${seats} asientos`,
    urgency: seats <= SEATS_CRITICAL_THRESHOLD ? "critical" : "low",
  }
}

function costamarRedirectStatus(offer: CanonicalOffer): ResultRedirectStatus | undefined {
  const verification = resolveCostamarRedirectVerification(offer)
  if (!verification) return undefined

  if (verification.verified) {
    return {
      label: "Redirect verificado",
      title: "El enlace de Click and Book Plus fue validado antes de mostrar la oferta.",
      tone: "verified",
    }
  }

  if (verification.state === "blocked") {
    return {
      label: "Redirect bloqueado",
      title: "Click and Book Plus no devolvió un redirect usable para esta búsqueda.",
      tone: "blocked",
    }
  }

  return undefined
}

function resolveCostamarRedirectVerification(offer: CanonicalOffer): RedirectVerification | undefined {
  if (!/costamar/i.test(String(offer.providerSource ?? ""))) {
    return undefined
  }

  if (offer.redirectVerification) {
    return offer.redirectVerification
  }

  return offer.purchasePaths?.find((path) =>
    /costamar/i.test(String(path.provider ?? "")) &&
    path.type === "search-redirect" &&
    path.redirectVerification
  )?.redirectVerification
}

function formatMoney(money: CanonicalOffer["price"]["total"]) {
  return `${money.currencyCode} ${money.amount.toLocaleString("es-PE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function dayMonthLabel(isoDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return ""
  return `${isoDate.slice(8)}/${isoDate.slice(5, 7)}`
}

function providerBadge(offer: CanonicalOffer) {
  const primaryProviderId = normalizedProviderId(offer.providerSource)
  if (primaryProviderId) {
    return providerBadgeForId(primaryProviderId)
  }

  const fallbackProviderId = normalizedProviderId(offer.purchasePaths?.find((path) => path.provider)?.provider)
  return providerBadgeForId(fallbackProviderId)
}

function normalizedProviderId(providerId?: string) {
  const value = String(providerId ?? "").trim()
  if (!value) return undefined
  if (/costamar/i.test(value)) return "costamar"
  if (/agil/i.test(value)) return "agil-local"

  return value
}

export function providerBadgeForId(providerId?: string): ResultProviderBadge {
  if (providerId === "costamar") {
    return {
      label: providerDisplayName(providerId),
      shortLabel: "CB+",
      icon: "/assets/provider-icons/click-and-book-plus-128.png",
    }
  }

  if (providerId === "agil-local") {
    return {
      label: providerDisplayName(providerId),
      shortLabel: "AG",
      icon: "/assets/provider-icons/agilsmart-128.png",
    }
  }

  const label = providerDisplayName(providerId)
  return {
    label,
    shortLabel: label.slice(0, 2).toUpperCase(),
    icon: "",
  }
}
