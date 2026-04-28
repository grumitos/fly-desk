import { Backpack, Luggage } from "lucide-react"
import { cn } from "@/lib/utils"
import type { CanonicalOffer, Itinerary, Segment } from "@/types"
import "./result-card.css"

interface ResultCardProps {
  offer: CanonicalOffer
  selected: boolean
  passengerCount: number
  onSelect: (offer: CanonicalOffer) => void
}

type LayoverItem = {
  city: string
  minutes: number
}

export function ResultCard({ offer, selected, passengerCount, onSelect }: ResultCardProps) {
  const carrier = carrierDisplayParts(offer)
  const itinerary = primaryItineraryForOffer(offer)
  const windowSummary = itineraryWindowSummary(itinerary, offer)
  const flightCodes = offerFlightCodesLabel(offer)
  const dates = offerDateSummary(offer)
  const duration = journeyDurationLabel(offer)
  const stops = stopsSummary(offer)
  const price = priceLabels(offer.price?.total, passengerCount)
  const provider = providerBadge(offer)
  const rowLabel = [
    selected ? "Oferta seleccionada" : "Seleccionar oferta",
    carrier.display,
    windowSummary.schedule,
    windowSummary.route,
    dates.primary,
    duration,
    price.combinedLabel,
  ]
    .filter(Boolean)
    .join(" - ")

  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={rowLabel}
      aria-pressed={selected}
      data-testid="result-card"
      className={cn("fd-result-card", selected && "is-selected")}
      onClick={() => onSelect(offer)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onSelect(offer)
        }
      }}
    >
      <div className="fd-result-card__airline">
        <span className="fd-result-card__airline-name" title={carrier.display}>{carrier.display}</span>
        <span className="fd-result-card__meta" title={flightCodes || offer.providerSource || undefined}>
          {flightCodes || offer.providerSource || "Vuelo por confirmar"}
        </span>
        {carrier.operatedBy && <span className="fd-result-card__meta fd-result-card__meta--muted">{carrier.operatedBy}</span>}
      </div>

      <div className="fd-result-card__schedule">
        <div className="fd-result-card__schedule-main">
          <span>{windowSummary.departureTime}</span>
          <span className="fd-result-card__schedule-separator">-</span>
          <span>{windowSummary.arrivalTime}</span>
          {windowSummary.arrivalDayOffset > 0 && (
            <span className="fd-result-card__schedule-offset">+{windowSummary.arrivalDayOffset}</span>
          )}
        </div>
        <span className="fd-result-card__meta">{windowSummary.departureDateLabel}</span>
      </div>

      <div className="fd-result-card__route">
        <span className="fd-result-card__route-main" title={windowSummary.route}>{windowSummary.route}</span>
        <span className="fd-result-card__date-main" title={dates.title}>{dates.primary}</span>
        {dates.secondary && <span className="fd-result-card__meta">{dates.secondary}</span>}
      </div>

      <div className="fd-result-card__journey">
        <span className="fd-result-card__journey-main">{duration}</span>
        <span
          className={cn(
            "fd-result-card__stops",
            stops.tone === "direct" && "fd-result-card__stops--direct",
            stops.tone === "warning" && "fd-result-card__stops--warning",
            stops.tone === "danger" && "fd-result-card__stops--danger",
          )}
          title={stops.title}
        >
          {stops.label}
        </span>
        {stops.layoverLabel && <span className="fd-result-card__layover">{stops.layoverLabel}</span>}
      </div>

      <div className="fd-result-card__baggage">
        <span className="fd-result-card__micro-label">Equipaje</span>
        <BaggageIcons offer={offer} />
      </div>

      <div className="fd-result-card__price">
        <span className="fd-result-card__price-total" title={price.totalLabel}>{price.totalLabel}</span>
        {price.perPersonLabel && <span className="fd-result-card__price-meta">{price.perPersonLabel} por persona</span>}
      </div>

      <div className="fd-result-card__provider" title={provider.label}>
        {provider.icon ? (
          <img src={provider.icon} alt="" aria-hidden="true" decoding="async" />
        ) : (
          <span>{provider.shortLabel}</span>
        )}
      </div>
    </article>
  )
}

function BaggageIcons({ offer }: { offer: CanonicalOffer }) {
  const carryOn = offer.baggage?.carryOnIncluded === true
  const checked = offer.baggage?.checkedIncluded === true
  const label = [
    `Cabina ${carryOn ? "incluida" : "no incluida"}`,
    `Bodega ${checked ? "incluida" : "no incluida"}`,
  ].join(", ")

  return (
    <span className="fd-result-card__baggage-icons" aria-label={label}>
      <span className={cn("fd-result-card__bag-icon", carryOn ? "is-included" : "is-missing")} title="Cabina">
        <Backpack aria-hidden="true" />
      </span>
      <span className={cn("fd-result-card__bag-icon", checked ? "is-included" : "is-missing")} title="Bodega">
        <Luggage aria-hidden="true" />
      </span>
    </span>
  )
}

function primaryItineraryForOffer(offer: CanonicalOffer) {
  return offer.itineraries?.find((itinerary) => itinerary.direction === "outbound")
    ?? offer.itineraries?.[0]
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

  return operators.size > 0 ? `Opera con ${Array.from(operators).join(" / ")}` : ""
}

function offerFlightCodesLabel(offer: CanonicalOffer) {
  const tokens = (offer.itineraries ?? [])
    .flatMap((itinerary) => itinerary.segments)
    .map((segment) => flightCodeLabel(segment))
    .filter(Boolean)

  return Array.from(new Set(tokens)).join(" · ")
}

function flightCodeLabel(segment: Segment) {
  const carrier = String(segment.marketingCarrier ?? "").trim().toUpperCase()
  const flightNumber = typeof segment.flightNumber === "string"
    ? segment.flightNumber.trim().toUpperCase().replace(/\s+/g, "")
    : ""

  if (!flightNumber) return ""
  if (carrier && !flightNumber.startsWith(carrier)) return `${carrier}${flightNumber}`
  return flightNumber
}

function itineraryWindowSummary(itinerary: Itinerary | null, offer: CanonicalOffer) {
  const segments = itinerary?.segments ?? []
  const first = segments[0]
  const last = segments[segments.length - 1]
  const departureIso = first?.departureAt ?? offer.departureDate
  const arrivalIso = last?.arrivalAt ?? offer.arrivalDate
  const departureDate = isoDatePart(departureIso)
  const arrivalDate = isoDatePart(arrivalIso)
  const origin = String(first?.origin ?? offer.origin ?? "").trim().toUpperCase()
  const destination = String(last?.destination ?? offer.destination ?? "").trim().toUpperCase()
  const departureTime = timeOfIso(departureIso) || "-"
  const arrivalTime = timeOfIso(arrivalIso) || "-"

  return {
    origin,
    destination,
    route: [origin, destination].filter(Boolean).join(" - ") || "Ruta por confirmar",
    schedule: `${departureTime} - ${arrivalTime}`,
    departureTime,
    arrivalTime,
    departureDateLabel: departureDate ? `Ida ${formatDateCompact(departureDate)}` : "Horario por confirmar",
    arrivalDayOffset: departureDate && arrivalDate ? Math.max(0, diffDaysIso(departureDate, arrivalDate)) : 0,
  }
}

function offerDateSummary(offer: CanonicalOffer) {
  const departureDate = isoDatePart(offer.departureDate) || isoDatePart(primarySegmentForOffer(offer)?.departureAt)
  const returnDate = isoDatePart(offer.returnDate)
  const primary = returnDate
    ? `${formatDateCompact(departureDate)} → ${formatDateCompact(returnDate)}`
    : formatDateCompact(departureDate)

  return {
    primary,
    secondary: "",
    title: primary,
  }
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

  if (providerId === "costamar") {
    return {
      label: "Costamar",
      shortLabel: "CO",
      icon: "/assets/provider-icons/costamar-128.png",
    }
  }

  if (providerId === "agil-local") {
    return {
      label: "Agil",
      shortLabel: "AG",
      icon: "/assets/provider-icons/agilsmart-128.png",
    }
  }

  const label = candidates[0] || "Proveedor"
  return {
    label,
    shortLabel: label.slice(0, 2).toUpperCase(),
    icon: "",
  }
}

function timeOfIso(value?: string) {
  if (!value) return ""
  if (value.includes("T") && value.length >= 16) return value.slice(11, 16)

  const parsed = new Date(value)
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
