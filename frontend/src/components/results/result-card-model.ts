import type { CanonicalOffer, Itinerary } from "@/types"
import { providerDisplayName } from "@/lib/providers"

type LayoverItem = {
  city: string
  minutes: number
}

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
    tripType: inboundSummary ? "round-trip" : "one-way",
  }
}

function primaryItineraryForOffer(offer: CanonicalOffer) {
  return offer.itineraries?.find((itinerary) => itinerary.direction === "outbound")
    ?? offer.itineraries?.[0]
    ?? null
}

function returnItineraryForOffer(offer: CanonicalOffer) {
  return offer.itineraries?.find((itinerary) => itinerary.direction === "inbound")
    ?? null
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
  const rawName = [
    segment?.marketingCarrierName,
    offer.airline,
    segment?.operatingCarrierName,
  ].find((value) => typeof value === "string" && value.trim())
  const name = rawName && rawName.trim().toUpperCase() !== code.toUpperCase()
    ? rawName.trim()
    : ""
  const operatedBy = operatingCopy(offer, new Set([code, name, rawName].map((value) => String(value ?? "").trim().toUpperCase())))

  return {
    code,
    name,
    display: name || code || "Aerolínea",
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
      const label = operatingName || operatingCarrier
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
    route: [origin, destination].filter(Boolean).join(" - ") || "Ruta por confirmar",
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

function formatJourneyDuration(minutes: number) {
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

function stopsSummary(offer: CanonicalOffer) {
  const stops = offer.comparisonMetrics?.totalStops ?? offer.stops
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

function layoverItemsForOffer(offer: CanonicalOffer): LayoverItem[] {
  return (offer.itineraries ?? []).flatMap((itinerary) => layoverItemsForItinerary(itinerary))
}

function layoverItemsForItinerary(itinerary: Itinerary): LayoverItem[] {
  if (itinerary.segments.length < 2) return []

  return itinerary.segments.slice(0, -1).flatMap((segment, index) => {
    const next = itinerary.segments[index + 1]
    const minutes = computeLayoverMinutes(segment, next)
    if (!Number.isFinite(minutes) || minutes <= 0) return []

    return {
      city: cityLabel(segment.destinationName || segment.destination || "Escala"),
      minutes,
    }
  })
}

function computeLayoverMinutes(current: Segment, next?: Segment) {
  if (!current.arrivalAt || !next?.departureAt) return 0
  const currentMs = new Date(current.arrivalAt).getTime()
  const nextMs = new Date(next.departureAt).getTime()
  if (!Number.isFinite(currentMs) || !Number.isFinite(nextMs) || nextMs <= currentMs) return 0
  return Math.round((nextMs - currentMs) / 60000)
}

function cityLabel(value = "") {
  const normalized = String(value).trim()
  if (!normalized) return ""

  return normalized
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
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

function formatMoney(money: CanonicalOffer["price"]["total"]) {
  return `${money.currencyCode || "USD"} ${money.amount.toLocaleString("es-PE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function providerBadge(offer: CanonicalOffer) {
  const candidates = [
    offer.providerSource,
    ...(offer.purchasePaths ?? []).map((path) => path.provider),
  ].filter(Boolean)
  const providerId = candidates.find((candidate) => /costamar/i.test(candidate))
    ? "costamar"
    : candidates.find((candidate) => /agil/i.test(candidate))
      ? "agil-local"
      : ""

  return providerBadgeForId(providerId || candidates[0])
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

function timeOfIso(value?: string) {
  if (!value) return ""
  const trimmed = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return ""
  if (trimmed.includes("T") && trimmed.length >= 16) return trimmed.slice(11, 16)

  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) return ""
  return parsed.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", hour12: false })
}

function isoDatePart(value?: string) {
  if (!value) return ""
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10)

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return ""
  return parsed.toISOString().slice(0, 10)
}

function formatDateCompact(iso?: string) {
  const value = isoDatePart(iso)
  if (!value) return "-"

  const [year, month, day] = value.split("-")
  if (!year || !month || !day) return value
  return `${day}/${month}`
}

function diffDaysIso(from: string, to: string) {
  const fromMs = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)))
  const toMs = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)))
  return Math.round((toMs - fromMs) / 86400000)
}
