import type { CanonicalOffer, Itinerary, RedirectVerification, Segment } from "@/types"
import { airlineLogoAssetPath } from "../../../../src/core/airline-assets"
import { offerAirlineCode } from "../../../../src/core/filtering"
import { normalizeAirlineDisplayName } from "@/lib/airline-names"
import { formatAmount, formatDayMonthNumeric, formatMoney } from "@/lib/format"
import { diffDays } from "@/lib/iso-date"
import {
  formatJourneyDuration,
  isoDatePart,
  layoverItemsForItinerary,
  primaryItineraryForOffer,
  returnItineraryForOffer,
  stopsCountFromItinerary,
  timeOfIso,
} from "@/lib/offer-display"
import { providerDisplayName, providerIconPath } from "@/lib/providers"

/*
 * The card model for plate 1b. Duration and stops are per leg: a sum of the
 * two legs is a number that matches no flight the agent is selling.
 */

export type ResultLegModel = {
  /** "Ida" / "Vta" — what the 56px label column holds. */
  label: string
  ariaLabel: string
  /** dd/MM next to the label. */
  dateLabel: string
  departureTime: string
  arrivalTime: string
  hasKnownSchedule: boolean
  /** "+1" when the flight lands on a later day. */
  dayOffset: string
  duration: string
  /** "Directo" · "1 escala · PTY" · "2 escalas · PTY, BOG +1". */
  stopsLabel: string
  /* The desk draws the count and the airports in two lanes so the codes line
     up down the list; the phone draws them as one string. */
  stopsCountLabel: string
  /** " · PTY, BOG +1": the separator and its space travel with the codes. */
  stopsCodesLabel: string
  /** The stacked lane's form ("1 esc · PTY"); from two stops, the count alone. */
  stopsShortLabel: string
  stopsTitle: string
  stopsTone: "direct" | "one-stop" | "many-stops" | "unknown"
}

export type ResultCardModel = {
  carrier: {
    code: string
    name: string
    logo: string
    /** The codeshare operator, when it differs from the marketer. */
    operatedBy: string
  }
  baggage: {
    carryOnIncluded: boolean | undefined
    checkedIncluded: boolean | undefined
    /** True when the provider said anything at all, included or not. */
    shown: boolean
    label: string
    title: string
    ariaLabel: string
  }
  legs: ResultLegModel[]
  price: {
    label: string
    perPersonLabel: string
    ariaLabel: string
  }
  provider: ResultProviderBadge
  costamarRedirect?: ResultRedirectStatus
  tripType: "one-way" | "round-trip"
}

type ResultAlternateScheduleModel = {
  legAriaLabel: string
  time: string
  meta: string
}

type ResultRedirectStatus = {
  label: string
  title: string
  tone: "verified" | "pending" | "blocked"
}

type ResultProviderBadge = {
  label: string
  shortLabel: string
  icon: string
}

type OfferModelParts = Omit<ResultCardModel, "price">

/* Everything but the price depends on the offer alone, and one offer is drawn
   by its card, its group, the chips of its siblings and the detail panel. The
   offer objects live as long as their job revision, and so does this. */
const offerModelCache = new WeakMap<CanonicalOffer, OfferModelParts>()

function offerModelParts(offer: CanonicalOffer): OfferModelParts {
  const cached = offerModelCache.get(offer)
  if (cached) return cached

  const inbound = returnItineraryForOffer(offer)
  const legs = [legModel(primaryItineraryForOffer(offer), offer, "outbound")]
  if (inbound) legs.push(legModel(inbound, offer, "inbound"))
  const parts: OfferModelParts = {
    carrier: carrierParts(offer),
    baggage: baggageParts(offer),
    legs,
    provider: providerBadge(offer),
    costamarRedirect: costamarRedirectStatus(offer),
    tripType: inbound ? "round-trip" : "one-way",
  }
  offerModelCache.set(offer, parts)
  return parts
}

export function resultLegModels(offer: CanonicalOffer): ResultLegModel[] {
  return offerModelParts(offer).legs
}

export function buildResultCardModel(
  offer: CanonicalOffer,
  passengerCount: number,
  { showPerPerson = true }: { showPerPerson?: boolean } = {},
): ResultCardModel {
  return {
    ...offerModelParts(offer),
    price: priceParts(offer, passengerCount, showPerPerson),
  }
}

/* The duration alone: a schedule group shares one price and baggage, which
   the card already states. */
export function buildAlternateScheduleModel(
  alternateOffer: CanonicalOffer,
  currentOffer: CanonicalOffer,
): ResultAlternateScheduleModel {
  const alternateLegs = resultLegModels(alternateOffer)
  const currentLegs = resultLegModels(currentOffer)
  const changedLegIndex = alternateLegs.findIndex(
    (leg, index) => !sameDisplayedSchedule(leg, currentLegs[index]),
  )
  const leg = alternateLegs[changedLegIndex >= 0 ? changedLegIndex : 0]

  return {
    legAriaLabel: leg?.ariaLabel ?? "Tramo",
    time: leg?.departureTime ?? "--:--",
    meta: leg?.duration ?? "",
  }
}

function sameDisplayedSchedule(
  left: ResultLegModel,
  right: ResultLegModel | undefined,
): boolean {
  if (!right) return false

  return left.dateLabel === right.dateLabel
    && left.departureTime === right.departureTime
    && left.arrivalTime === right.arrivalTime
    && left.dayOffset === right.dayOffset
    && left.duration === right.duration
    && left.stopsLabel === right.stopsLabel
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
  const dayOffset = departureDate && arrivalDate ? Math.max(0, diffDays(departureDate, arrivalDate)) : 0
  const stops = stopsForItinerary(itinerary)

  return {
    label: direction === "outbound" ? "Ida" : "Vta",
    ariaLabel: direction === "outbound" ? "Ida" : "Vuelta",
    dateLabel: formatDayMonthNumeric(departureDate),
    departureTime: departureTime || "--:--",
    arrivalTime: arrivalTime || "--:--",
    hasKnownSchedule: Boolean(departureTime || arrivalTime),
    dayOffset: dayOffset > 0 ? `+${dayOffset}` : "",
    duration: legDuration(itinerary),
    stopsLabel: stops.label,
    stopsCountLabel: stops.countLabel,
    stopsCodesLabel: stops.codesLabel,
    stopsShortLabel: stops.shortLabel,
    stopsTitle: stops.title,
    stopsTone: stops.tone,
  }
}

/** Per leg; a whole-offer duration cannot stand in for a missing leg. */
function legDuration(itinerary: Itinerary | null): string {
  const minutes = itinerary?.durationMinutes
  if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0) {
    return formatJourneyDuration(minutes)
  }

  return "--"
}

/* From three stops the label shows two codes and `+n`; the detail names them all. */
function stopsForItinerary(itinerary: Itinerary | null) {
  if (!itinerary) {
    return {
      label: "Escalas por confirmar",
      countLabel: "Escalas por confirmar",
      codesLabel: "",
      shortLabel: "Escalas ?",
      title: "No hay itinerario para confirmar las escalas",
      tone: "unknown" as const,
    }
  }

  const segments = itinerary.segments ?? []
  const stopCount = stopsCountFromItinerary(itinerary) ?? Math.max(0, segments.length - 1)

  if (stopCount === 0) {
    return {
      label: "Directo",
      countLabel: "Directo",
      codesLabel: "",
      shortLabel: "Directo",
      title: "Vuelo directo",
      tone: "direct" as const,
    }
  }

  const codes = segments
    .slice(0, -1)
    .map((segment) => String(segment.destination ?? "").trim().toUpperCase())
    .filter(Boolean)
  const layovers = layoverItemsForItinerary(itinerary)
  const title = layovers.length
    ? layovers.map((item) => `${item.city}: ${formatJourneyDuration(item.minutes)}`).join(" · ")
    : `${stopCount} ${stopCount === 1 ? "escala" : "escalas"}`

  const shown = codes.slice(0, 2).join(", ")
  const overflow = codes.length > 2 ? ` +${codes.length - 2}` : ""

  if (stopCount === 1) {
    return {
      label: codes[0] ? `1 escala · ${codes[0]}` : "1 escala",
      countLabel: "1 escala",
      codesLabel: codes[0] ? ` · ${codes[0]}` : "",
      shortLabel: codes[0] ? `1 esc · ${codes[0]}` : "1 esc",
      title,
      tone: "one-stop" as const,
    }
  }

  /* «2 esc · BOG, PTY» measures 82px, wider than the narrowest phone lane: the
     short form keeps the count and the title and detail keep the airports. */
  return {
    label: `${stopCount} escalas${shown ? ` · ${shown}${overflow}` : ""}`,
    countLabel: `${stopCount} escalas`,
    codesLabel: shown ? ` · ${shown}${overflow}` : "",
    shortLabel: `${stopCount} esc`,
    title,
    tone: "many-stops" as const,
  }
}

/* The airline that controls the fare, as the airline filter reads it: its
   code (`offerAirlineCode`) and the name `lib/api.ts` gave it. */
function carrierParts(offer: CanonicalOffer) {
  const code = offerAirlineCode(offer)
  const name = offer.airline
  const knownTokens = new Set([code, name].map((value) => String(value ?? "").trim().toUpperCase()))

  return {
    code,
    name: name || "Aerolínea",
    logo: airlineLogoAssetPath(code),
    operatedBy: operatingCopy(offer, knownTokens),
  }
}

/* The operator's bare name; the card adds the words around it. */
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

  return operators.size > 0 ? Array.from(operators).join(" / ") : ""
}

/* The label names what the fare includes, in the filter's words; absence is
   drawn by dimmed icons and spoken in the aria label. An explicit «no bodega»
   is evidence too, so the pair shows whenever the provider said anything. */
function baggageParts(offer: CanonicalOffer) {
  const carryOnIncluded = offer.baggage?.carryOnIncluded
  const checkedIncluded = offer.baggage?.checkedIncluded
  const label = carryOnIncluded === true && checkedIncluded === true
    ? "Mano y bodega"
    : carryOnIncluded === true ? "Mano" : checkedIncluded === true ? "Bodega" : ""
  const ariaLabels = [
    carryOnIncluded === true
      ? "Equipaje de mano incluido"
      : carryOnIncluded === false ? "Equipaje de mano no incluido" : "",
    checkedIncluded === true
      ? "Equipaje de bodega incluido"
      : checkedIncluded === false ? "Equipaje de bodega no incluido" : "",
  ].filter(Boolean)
  const shown = carryOnIncluded !== undefined || checkedIncluded !== undefined

  return {
    carryOnIncluded,
    checkedIncluded,
    shown,
    label,
    title: label || (shown ? "Sin equipaje incluido" : ""),
    ariaLabel: ariaLabels.join(", "),
  }
}

function priceParts(offer: CanonicalOffer, passengerCount: number, showPerPerson: boolean) {
  const money = offer.price?.total
  if (!money) {
    return { label: "--", perPersonLabel: "", ariaLabel: "Precio no disponible" }
  }

  const label = formatMoney(money)
  const canShowPerPerson = showPerPerson && Number.isFinite(passengerCount) && passengerCount > 1
  /* The line under the total is bare («512.00 p/p»): the currency is on the
     line above, and it stays in the spoken label, which has no line above. */
  const perPersonLabel = canShowPerPerson ? formatAmount(money.amount / passengerCount) : ""

  return {
    label,
    perPersonLabel,
    ariaLabel: perPersonLabel
      ? `${label} total, ${money.currencyCode} ${perPersonLabel} por persona`
      : `${label} total`,
  }
}

function costamarRedirectStatus(offer: CanonicalOffer): ResultRedirectStatus | undefined {
  const verification = resolveCostamarRedirectVerification(offer)
  if (!verification) return undefined

  if (verification.verified) {
    return {
      label: "Enlace del proveedor verificado",
      title: "El enlace de Click and Book Plus fue validado antes de mostrar la oferta.",
      tone: "verified",
    }
  }

  if (verification.state === "blocked") {
    return {
      label: "Enlace del proveedor bloqueado",
      title: "Click and Book Plus no devolvió un enlace utilizable para esta búsqueda.",
      tone: "blocked",
    }
  }

  return undefined
}

function resolveCostamarRedirectVerification(offer: CanonicalOffer): RedirectVerification | undefined {
  if (offer.providerSource !== "costamar") {
    return undefined
  }

  if (offer.redirectVerification) {
    return offer.redirectVerification
  }

  return offer.purchasePaths?.find((path) =>
    path.provider === "costamar" &&
    path.type === "search-redirect" &&
    path.redirectVerification
  )?.redirectVerification
}

function providerBadge(offer: CanonicalOffer): ResultProviderBadge {
  return providerBadgeForId(offer.providerSource || offer.purchasePaths?.find((path) => path.provider)?.provider)
}

export function providerBadgeForId(providerId?: string): ResultProviderBadge {
  const label = providerDisplayName(providerId)
  const icon = providerIconPath(providerId)
  const shortLabel = providerId === "costamar" ? "CB+" : providerId === "agil-local" ? "AG" : label.slice(0, 2).toUpperCase()
  return { label, shortLabel, icon }
}
