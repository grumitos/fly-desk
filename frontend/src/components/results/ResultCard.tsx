import type { MouseEvent } from "react"
import { Backpack, Luggage } from "lucide-react"
import { cn } from "@/lib/utils"
import { bestPurchasePath, normalizeSafePurchaseUrl } from "@/lib/purchase-path"
import type { CanonicalOffer } from "@/types"
import {
  buildResultCardModel,
  type ResultCardModel,
  type ResultJourneySummary,
} from "./result-card-model"
import "./result-card.css"

interface ResultCardProps {
  offer: CanonicalOffer
  selected: boolean
  passengerCount: number
  onSelect: (offer: CanonicalOffer) => void
  variant?: "regular" | "compact"
  eyebrow?: string
}

export function ResultCard({
  offer,
  selected,
  passengerCount,
  onSelect,
  variant = "regular",
  eyebrow,
}: ResultCardProps) {
  const model = buildResultCardModel(offer, passengerCount)
  const providerPurchasePath = bestPurchasePath(offer)
  const providerPurchaseUrl = providerPurchasePath?.url
    ? normalizeSafePurchaseUrl(providerPurchasePath.url)
    : undefined
  const rowLabel = [
    selected ? "Oferta seleccionada" : "Seleccionar oferta",
    model.carrier.display,
    ...model.journeys.map((journey) => journey.schedule),
    model.route,
    model.duration,
    model.price.combinedLabel,
  ]
    .filter(Boolean)
    .join(" - ")
  const providerOpenLabel = `Abrir ${model.provider.label}`

  const handleProviderOpen = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (!providerPurchasePath || !providerPurchaseUrl) return
    window.open(
      providerPurchaseUrl,
      providerPurchasePath.requiresNewTab ? "_blank" : "_self",
      "noopener,noreferrer",
    )
  }

  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={rowLabel}
      aria-pressed={selected}
      data-testid={variant === "compact" ? "migration-month-card" : "result-card"}
      className={cn(
        "fd-result-card",
        variant === "compact" && "fd-result-card--compact",
        selected && "is-selected",
      )}
      onClick={() => onSelect(offer)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onSelect(offer)
        }
      }}
    >
      {eyebrow && <span className="fd-result-card__eyebrow">{eyebrow}</span>}

      <div className="fd-result-card__airline">
        <span className="fd-result-card__airline-name" title={model.carrier.display}>{model.carrier.display}</span>
        <span className="fd-result-card__meta" title={model.flightCodes || offer.providerSource || undefined}>
          {model.flightCodes || offer.providerSource || "Vuelo por confirmar"}
        </span>
        {model.carrier.operatedBy && <span className="fd-result-card__meta fd-result-card__meta--muted">{model.carrier.operatedBy}</span>}
      </div>

      <div className="fd-result-card__schedules" data-trip-type={model.tripType}>
        {model.journeys.map((journey) => (
          <ItinerarySchedule key={journey.label} summary={journey} />
        ))}
      </div>

      <div className="fd-result-card__route">
        <span className="fd-result-card__route-main" title={model.route}>{model.route}</span>
        <span className="fd-result-card__route-baggage">
          <span className="fd-result-card__micro-label">Equipaje</span>
          <BaggageIcons offer={offer} />
        </span>
      </div>

      <div className="fd-result-card__journey">
        <span className="fd-result-card__journey-main">{model.duration}</span>
        <span
          className={cn(
            "fd-result-card__stops",
            model.stops.tone === "direct" && "fd-result-card__stops--direct",
            model.stops.tone === "warning" && "fd-result-card__stops--warning",
            model.stops.tone === "danger" && "fd-result-card__stops--danger",
          )}
          title={model.stops.title}
        >
          {model.stops.label}
        </span>
        {model.stops.layoverLabel && <span className="fd-result-card__layover">{model.stops.layoverLabel}</span>}
      </div>

      <div className="fd-result-card__price">
        <span className="fd-result-card__price-total" title={model.price.totalLabel}>{model.price.totalLabel}</span>
        {model.price.perPersonLabel && <span className="fd-result-card__price-meta">{model.price.perPersonLabel} por persona</span>}
      </div>

      <div className="fd-result-card__provider" title={model.provider.label}>
        {providerPurchaseUrl ? (
          <button
            type="button"
            aria-label={providerOpenLabel}
            className="fd-result-card__provider-action"
            title={providerOpenLabel}
            onClick={handleProviderOpen}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <ProviderBadge provider={model.provider} />
          </button>
        ) : (
          <ProviderBadge provider={model.provider} />
        )}
      </div>
    </article>
  )
}

function ItinerarySchedule({ summary }: { summary: ResultJourneySummary }) {
  return (
    <div className="fd-result-card__schedule">
      <div className="fd-result-card__schedule-main">
        {summary.hasKnownSchedule ? (
          <>
            <span>{summary.departureTime}</span>
            <span className="fd-result-card__schedule-separator">-</span>
            <span>{summary.arrivalTime}</span>
            {summary.arrivalDayOffset > 0 && (
              <span className="fd-result-card__schedule-offset">+{summary.arrivalDayOffset}</span>
            )}
          </>
        ) : (
          <span className="fd-result-card__schedule-unknown">Horario por confirmar</span>
        )}
      </div>
      <span className="fd-result-card__meta">{summary.departureDateLabel}</span>
    </div>
  )
}

function ProviderBadge({ provider }: { provider: ResultCardModel["provider"] }) {
  return provider.icon ? (
    <img src={provider.icon} alt="" aria-hidden="true" decoding="async" />
  ) : (
    <span>{provider.shortLabel}</span>
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
