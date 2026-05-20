import type { CanonicalOffer, Itinerary, RedirectVerification } from "@/types"
import { normalizeAirlineDisplayName, resolveAirlineDisplayName } from "@/lib/airline-names"
import {
  diffDaysIso,
  formatDateCompact,
  formatJourneyDuration,
  itineraryRouteLabel,
  isoDatePart,
  layoverItemsForOffer,
  primaryItineraryForOffer,
  returnItineraryForOffer,
  stopsCountForOffer,
  timeOfIso,
} from "@/lib/offer-display"
import { providerDisplayName } from "@/lib/providers"

export type ResultJourneySummary = {
  label: "Ida" | "Vuelta"
  origin: string
  destination: string
  route: string
  schedule: string
  hasKnownSchedule: boolean
  departureTime: string
  arrivalTime: string
  departureDateLabel: string
  arrivalDayOffset: number
}

export type ResultRedirectStatus = {
  label: string
  title: string
  tone: "verified" | "pending" | "blocked"
}

export type ResultCardModel = {
  carrier: {
    code: string
    name: string
    display: string
    operatedBy: string
  }
  journeys: ResultJourneySummary[]
  route: string
  duration: string
  stops: {
    label: string
    title: string
    layoverLabel: string
    tone: "direct" | "warning" | "danger"
  }
  price: {
    totalLabel: string
    perPersonLabel: string
    combinedLabel: string
  }
  provider: {
    label: string
    shortLabel: string
    icon: string
  }
  costamarRedirect?: ResultRedirectStatus
  tripType: "one-way" | "round-trip"
}

export type ResultProviderBadge = ResultCardModel["provider"]

export function buildResultCardModel(
  offer: CanonicalOffer,
  passengerCount: number,
): ResultCardModel {
  const outboundItinerary = primaryItineraryForOffer(offer)
  const inboundItinerary = returnItineraryForOffer(offer)
  const outboundSummary = itineraryWindowSummary(outboundItinerary, offer, "Ida")
  const inboundSummary = returnWindowSummary(inboundItinerary, offer)
  const journeys = [outboundSummary, inboundSummary].filter((journey): journey is ResultJourneySummary => Boolean(journey))

  return {
    carrier: carrierDisplayParts(offer),
    journeys,
    route: outboundSummary.route,
    duration: journeyDurationLabel(offer),
    stops: stopsSummary(offer),
    price: priceLabels(offer.price?.total, passengerCount),
    provider: providerBadge(offer),
    costamarRedirect: costamarRedirectStatus(offer),
    tripType: inboundSummary ? "round-trip" : "one-way",
  }
}

function carrierDisplayParts(offer: CanonicalOffer) {
  const segment = primarySegmentForOffer(offer)
  const code = String(
    offer.mainCarrier
      ?? offer.validatingCarrier
      ?? segment?.marketingCarrier
      ?? offer.airline
      ?? "",
  ).trim()
  const rawNames = [
    segment?.marketingCarrierName,
    offer.airline,
    segment?.operatingCarrierName,
  ]
  const rawName = rawNames.find((value) => typeof value === "string" && value.trim())
  const name = resolveAirlineDisplayName({
    names: rawNames,
    codes: [
      code,
      offer.validatingCarrier,
      segment?.marketingCarrier,
      segment?.operatingCarrier,
    ],
  })
  const operatedBy = operatingCopy(offer, new Set([code, name, rawName].map((value) => String(value ?? "").trim().toUpperCase())))

  return {
    code,
    name,
    display: name || "Aerolínea",
    operatedBy,
  }
}

function primarySegmentForOffer(offer: CanonicalOffer) {
  return primaryItineraryForOffer(offer)?.segments?.[0]
}

function operatingCopy(offer: CanonicalOffer, primaryTokens: Set<string>) {
  const operators = new Set<string>()

  offer.itineraries?.forEach((itinerary) => {
    itinerary.segments.forEach((segment) => {
      const marketingCarrier = String(segment.marketingCarrier ?? "").trim().toUpperCase()
      const operatingCarrier = String(segment.operatingCarrier ?? "").trim().toUpperCase()
      const operatingName = segment.operatingCarrierName?.trim() ?? ""
      const label = normalizeAirlineDisplayName(operatingName || operatingCarrier)
      const normalizedLabel = label.toUpperCase()

      if (!label) return
      if (operatingCarrier && marketingCarrier && operatingCarrier === marketingCarrier) return
      if (primaryTokens.has(normalizedLabel) || primaryTokens.has(operatingCarrier)) return
      operators.add(label)
    })
  })

  return operators.size > 0 ? `+ ${Array.from(operators).join(" / ")}` : ""
}

function itineraryWindowSummary(itinerary: Itinerary | null, offer: CanonicalOffer, label: "Ida" | "Vuelta") {
  const segments = itinerary?.segments ?? []
  const first = segments[0]
  const last = segments[segments.length - 1]
  const departureIso = first?.departureAt ?? (label === "Vuelta" ? offer.returnDate : offer.departureDate)
  const arrivalIso = last?.arrivalAt ?? (label === "Vuelta" ? undefined : offer.arrivalDate)
  const departureDate = isoDatePart(departureIso)
  const arrivalDate = isoDatePart(arrivalIso)
  const origin = String(first?.origin ?? offer.origin ?? "").trim().toUpperCase()
  const destination = String(last?.destination ?? offer.destination ?? "").trim().toUpperCase()
  const parsedDepartureTime = timeOfIso(departureIso)
  const parsedArrivalTime = timeOfIso(arrivalIso)
  const hasKnownSchedule = Boolean(parsedDepartureTime || parsedArrivalTime)
  const departureTime = parsedDepartureTime || "-"
  const arrivalTime = parsedArrivalTime || "-"

  return {
    label,
    origin,
    destination,
    route: itineraryRouteLabel(itinerary, { origin, destination }),
    schedule: hasKnownSchedule ? `${departureTime} - ${arrivalTime}` : "Horario por confirmar",
    hasKnownSchedule,
    departureTime,
    arrivalTime,
    departureDateLabel: departureDate ? `${label} ${formatDateCompact(departureDate)}` : "Horario por confirmar",
    arrivalDayOffset: departureDate && arrivalDate ? Math.max(0, diffDaysIso(departureDate, arrivalDate)) : 0,
  }
}

function returnWindowSummary(itinerary: Itinerary | null, offer: CanonicalOffer) {
  if (!itinerary && !offer.returnDate) return null

  return itineraryWindowSummary(itinerary, offer, "Vuelta")
}

function journeyDurationLabel(offer: CanonicalOffer) {
  const minutes = offer.comparisonMetrics?.totalDurationMinutes
  if (Number.isFinite(minutes) && typeof minutes === "number" && minutes > 0) {
    return formatJourneyDuration(minutes)
  }

  return offer.duration || "-"
}

function stopsSummary(offer: CanonicalOffer) {
  const stops = stopsCountForOffer(offer)
  const layovers = layoverItemsForOffer(offer)

  if (stops === 0) {
    return {
      label: "Directo",
      title: "Vuelo directo",
      layoverLabel: "",
      tone: "direct" as const,
    }
  }

  const label = stops === 1 ? "1 escala" : `${stops} escalas`
  const primaryCity = layovers[0]?.city || "Ciudad por confirmar"
  const citySummary = layovers.length > 1 ? `${primaryCity} +${layovers.length - 1}` : primaryCity
  const maxLayover = layovers.reduce((max, item) => Math.max(max, item.minutes), 0)
  const layoverLabel = maxLayover > 0 ? formatJourneyDuration(maxLayover) : ""
  const title = layovers.length
    ? `Escala max.: ${layoverLabel} | ${layovers.map((item) => `${item.city}: ${formatJourneyDuration(item.minutes)}`).join(" | ")}`
    : `${label} · ${citySummary}`

  return {
    label: `${label} · ${citySummary}`,
    title,
    layoverLabel,
    tone: stops === 1 ? "warning" as const : "danger" as const,
  }
}

function priceLabels(
  money: CanonicalOffer["price"]["total"] | undefined,
  passengerCount: number,
) {
  if (!money) {
    return {
      totalLabel: "-",
      perPersonLabel: "",
      combinedLabel: "-",
    }
  }

  const totalLabel = formatMoney(money)
  const showPerPerson = Number.isFinite(passengerCount) && passengerCount > 1
  const perPersonLabel = showPerPerson
    ? formatMoney({ ...money, amount: money.amount / passengerCount })
    : ""

  return {
    totalLabel,
    perPersonLabel,
    combinedLabel: perPersonLabel ? `${totalLabel} · ${perPersonLabel}` : totalLabel,
  }
}

function costamarRedirectStatus(offer: CanonicalOffer): ResultRedirectStatus | undefined {
  const verification = resolveCostamarRedirectVerification(offer)
  if (!verification) return undefined

  if (verification.verified) {
    return {
      label: "Redirect verificado",
      title: "El enlace de Costamar fue validado antes de mostrar la oferta.",
      tone: "verified",
    }
  }

  if (verification.state === "blocked") {
    return {
      label: "Redirect bloqueado",
      title: verification.reason || "Costamar no devolvió un redirect usable para esta búsqueda.",
      tone: "blocked",
    }
  }

  return {
    label: "Redirect pendiente",
    title: verification.reason || "Fly Desk mostrará el enlace de Costamar, pero aún no está validado.",
    tone: "pending",
  }
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
  return `${money.currencyCode || "USD"} ${money.amount.toLocaleString("es-PE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
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
      shortLabel: "CO",
      icon: "/assets/provider-icons/costamar-128.png",
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
