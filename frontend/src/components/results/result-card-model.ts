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
import { providerDisplayName, providerIconPath } from "@/lib/providers"

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

export type ResultLegModel = {
  /** "Ida" / "Vta" — the short form the 56px label column can hold. */
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
  /** "Directo" · "1 escala · PTY" · "2 escalas · PTY, BOG +1". */
  stopsLabel: string
  /**
   * The same wording, cut where the desk reads it in two lanes: the count on
   * its own and the airports on theirs. A card's two legs rarely carry the
   * same count, and «2 escalas · CDG, AMS» over «1 escala · CDG» pushed the
   * second row's codes a whole word to the left of the first row's — the
   * airports are what the agent scans down, so they are what has to line up.
   */
  stopsCountLabel: string
  /**
   * " · PTY, BOG +1" — the separator travels with the codes, and so does the
   * space in front of it. On a desk the two are separate cells and a leading
   * space at the start of a cell is dropped, so the lane pays for that space
   * once, in `padding-left`; on a phone they are one string again and the
   * space is the one that was always there. Either way the text a reader
   * selects, and a screen reader speaks, is «1 escala · BOG».
   */
  stopsCodesLabel: string
  /**
   * The same fact in the 57px the stacked card can spare ("1 esc · PTY").
   * Plate 8c abbreviates here for a reason that is arithmetic, not taste: the
   * full wording overflows by a few pixels and takes the airport code with it,
   * and the code is the part the agent is reading. From two stops even the
   * abbreviation cannot carry the codes, so it stops trying — see below.
   */
  stopsShortLabel: string
  stopsTitle: string
  stopsTone: "direct" | "one-stop" | "many-stops" | "unknown"
}

export type ResultCardModel = {
  carrier: {
    code: string
    name: string
    logo: string
    /** "LATAM" — the codeshare operator, when it differs from the marketer. */
    operatedBy: string
  }
  baggage: {
    carryOnIncluded: boolean | undefined
    checkedIncluded: boolean | undefined
    /** True when the provider said anything at all, included or not. */
    shown: boolean
    label: string
    /** What the pair means on hover, including when it means «nothing». */
    title: string
    ariaLabel: string
  }
  legs: ResultLegModel[]
  price: {
    label: string
    perPersonLabel: string
    ariaLabel: string
  }
  provider: {
    label: string
    shortLabel: string
    icon: string
  }
  costamarRedirect?: ResultRedirectStatus
  tripType: "one-way" | "round-trip"
}

export type ResultAlternateScheduleModel = {
  legAriaLabel: string
  time: string
  meta: string
}

export type ResultCardModelOptions = {
  showPerPerson?: boolean
}

export type ResultRedirectStatus = {
  label: string
  title: string
  tone: "verified" | "pending" | "blocked"
}

export type ResultProviderBadge = ResultCardModel["provider"]

export function buildResultCardModel(
  offer: CanonicalOffer,
  passengerCount: number,
  options: ResultCardModelOptions = {},
): ResultCardModel {
  const outbound = primaryItineraryForOffer(offer)
  const inbound = returnItineraryForOffer(offer)
  const outboundLeg = legModel(outbound, offer, "outbound")
  const inboundLeg = inbound ? legModel(inbound, offer, "inbound") : null

  return {
    carrier: carrierParts(offer),
    baggage: baggageParts(offer),
    legs: [outboundLeg, inboundLeg].filter((leg): leg is ResultLegModel => Boolean(leg)),
    price: priceParts(offer, passengerCount, options.showPerPerson ?? true),
    provider: providerBadge(offer),
    costamarRedirect: costamarRedirectStatus(offer),
    tripType: inboundLeg ? "round-trip" : "one-way",
  }
}

export function buildAlternateScheduleModel(
  alternateOffer: CanonicalOffer,
  currentOffer: CanonicalOffer,
): ResultAlternateScheduleModel {
  const alternate = buildResultCardModel(alternateOffer, 1)
  const current = buildResultCardModel(currentOffer, 1)
  const changedLegIndex = alternate.legs.findIndex(
    (leg, index) => !sameDisplayedSchedule(leg, current.legs[index]),
  )
  const leg = alternate.legs[changedLegIndex >= 0 ? changedLegIndex : 0]

  /*
   * The duration, and only the duration. This used to show a price difference
   * whenever there was one, and there never is: a schedule group refuses to
   * hold two offers whose currency, amount and baggage do not match
   * (`offer-schedule-groups.ts::groupKeyForOffer`, and the fold rule in the
   * contract), so every chip in a strip carries the price the card already
   * states. The delta was arithmetic that could only ever produce zero, drawn
   * as «mismo precio» in the full list and as nothing here.
   */
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
    duration: legDuration(itinerary),
    stopsLabel: stops.label,
    stopsCountLabel: stops.countLabel,
    stopsCodesLabel: stops.codesLabel,
    stopsShortLabel: stops.shortLabel,
    stopsTitle: stops.title,
    stopsTone: stops.tone,
  }
}

/** Per-leg duration; a whole-offer duration cannot stand in for a missing leg. */
function legDuration(itinerary: Itinerary | null): string {
  const minutes = itinerary?.durationMinutes
  if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0) {
    return formatJourneyDuration(minutes)
  }

  return "--"
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
      countLabel: "Escalas por confirmar",
      codesLabel: "",
      shortLabel: "Escalas ?",
      title: "No hay itinerario para confirmar las escalas",
      tone: "unknown" as const,
    }
  }

  const segments = itinerary?.segments ?? []
  const stopCount = stopsCountFromItinerary(itinerary)
    ?? Math.max(0, segments.length - 1)

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
  const layovers = itinerary ? layoverItemsForItinerary(itinerary) : []
  const title = layovers.length
    ? layovers.map((item) => `${item.city}: ${formatJourneyDuration(item.minutes)}`).join(" · ")
    : `${stopCount} ${stopCount === 1 ? "escala" : "escalas"}`

  const shown = codes.slice(0, 2).join(", ")
  const overflow = codes.length > 2 ? ` +${codes.length - 2}` : ""
  const codeSuffix = shown ? ` · ${shown}${overflow}` : ""

  if (stopCount === 1) {
    // "1 escala · BOG" — the same separator the multi-stop label uses, so the
    // column reads as one shape whatever the count (plate 8c).
    return {
      label: codes[0] ? `1 escala · ${codes[0]}` : "1 escala",
      countLabel: "1 escala",
      codesLabel: codes[0] ? ` · ${codes[0]}` : "",
      shortLabel: codes[0] ? `1 esc · ${codes[0]}` : "1 esc",
      title,
      tone: "one-stop" as const,
    }
  }

  /*
   * From two stops the short form drops the airports and keeps the count. The
   * stacked lane is 60px on the narrowest phone this application draws, and
   * «2 esc · BOG, PTY» measures 82 and «3 esc · BOG, PTY
   * +1» 95, so the lane ellipsised them back to «2 esc…» — a dangling ellipsis
   * that hid the very codes it was cut to show. A bare count says the same
   * thing and says all of it; the airports are still in the long form the desk
   * shows, in the `title`, and named one by one in the detail sheet.
   */
  return {
    label: `${stopCount} escalas${codeSuffix}`,
    countLabel: `${stopCount} escalas`,
    codesLabel: shown ? ` · ${shown}${overflow}` : "",
    shortLabel: `${stopCount} esc`,
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
 * The codeshare operator, bare — the agent needs to know who actually flies
 * it, because that is who the passenger will deal with at the gate. Only the
 * operators that differ from the marketing carrier appear.
 *
 * The name and nothing else, because the two surfaces introduce it differently
 * and neither wording is data: `Main.dc.html` writes «Operado por Level» on
 * its own line under the airline, and `Movil.dc.html` writes «· Level» glued
 * to it. Both prefixes live in `result-card.css`, where the disposition that
 * chooses between them already lives.
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

  return operators.size > 0 ? Array.from(operators).join(" / ") : ""
}

/*
 * The visible label names what the fare *includes*, and nothing else.
 *
 * It used to enumerate absences too, which produced «mano + bodega: no
 * incluido» — a line that reads as a fare with hold luggage until you get to
 * the last word. Absence is already said, and said better, by the two 14px
 * icons the card dims (04 §4: «Nunca texto»). The screen-reader label below
 * still states both, because there the icons say nothing.
 *
 * «Mano y bodega», which is what `Main.dc.html` and `MovilDetalle.dc.html`
 * both write in the detail's condition row. Not «Cabina + Bodega»: the filter
 * that switches this fact on is labelled «Mano», so the panel that reports it
 * has to use the same word, and «y» is the conjunction the sentence takes —
 * the «+» belonged to a list of tokens, not to a phrase an agent reads.
 */
function baggageParts(offer: CanonicalOffer) {
  const carryOnIncluded = offer.baggage?.carryOnIncluded
  const checkedIncluded = offer.baggage?.checkedIncluded
  const included = [carryOnIncluded === true, checkedIncluded === true]
  const label = included[0] && included[1]
    ? "Mano y bodega"
    : included[0] ? "Mano" : included[1] ? "Bodega" : ""
  const ariaLabels = [
    carryOnIncluded === true
      ? "Equipaje de mano incluido"
      : carryOnIncluded === false ? "Equipaje de mano no incluido" : "",
    checkedIncluded === true
      ? "Equipaje de bodega incluido"
      : checkedIncluded === false ? "Equipaje de bodega no incluido" : "",
  ].filter(Boolean)

  /*
   * `label` names what the fare includes, so it is empty for a fare that
   * includes neither — and the card used to hang the whole pair on it. But an
   * explicit `false` is evidence too: it is what the greyed-out icon draws, and
   * «no lleva bodega» is the fact an agent needs before the counter. What
   * decides whether the pair is drawn is therefore whether the provider said
   * anything at all, and only a fare it said nothing about goes without.
   */
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
  /* The figure above it already says which currency this is, and every plate
     that draws the pair — `Main`, `Movil`, `MovilCompacta` — writes the second
     line bare: «512.00 p/p». Repeating the code under a total that carries it
     spends 30 of the 116px lane restating what the eye read a line earlier. It
     stays in the spoken label, where there is no line above to carry it. */
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
  return `${money.currencyCode} ${formatAmount(money.amount)}`
}

function formatAmount(amount: number) {
  return amount.toLocaleString("es-PE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
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
      icon: providerIconPath(providerId),
    }
  }

  if (providerId === "agil-local") {
    return {
      label: providerDisplayName(providerId),
      shortLabel: "AG",
      icon: providerIconPath(providerId),
    }
  }

  const label = providerDisplayName(providerId)
  return {
    label,
    shortLabel: label.slice(0, 2).toUpperCase(),
    icon: "",
  }
}
