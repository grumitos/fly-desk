import type { MouseEvent } from "react"
import { Backpack, Luggage } from "lucide-react"
import { cn } from "@/lib/utils"
import { bestPurchasePathsByProvider, normalizeSafePurchaseUrl } from "@/lib/purchase-path"
import type { CanonicalOffer, PurchasePath } from "@/types"
import {
  buildResultCardModel,
  providerBadgeForId,
  type ResultCardModel,
  type ResultJourneySummary,
  type ResultProviderBadge,
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
  const providerActions = providerPurchaseActions(offer)
  const rowLabel = [
    selected ? "Oferta seleccionada" : "Seleccionar oferta",
    model.carrier.display,
    ...model.journeys.map((journey) => journey.schedule),
    model.route,
    model.duration,
    model.costamarRedirect?.label,
    model.price.combinedLabel,
  ]
    .filter(Boolean)
    .join(" - ")

  const handleProviderOpen = (event: MouseEvent<HTMLButtonElement>, action: ProviderAction) => {
    event.stopPropagation()
    window.open(
      action.url,
      action.path.requiresNewTab ? "_blank" : "_self",
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
        {model.carrier.operatedBy && <span className="fd-result-card__meta">{model.carrier.operatedBy}</span>}
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
        {model.costamarRedirect && (
          <span
            className={cn(
              "fd-result-card__redirect-status",
              `fd-result-card__redirect-status--${model.costamarRedirect.tone}`,
            )}
            title={model.costamarRedirect.title}
          >
            {model.costamarRedirect.label}
          </span>
        )}
      </div>

      <div
        className={cn(
          "fd-result-card__provider",
          providerActions.length > 1 && "fd-result-card__provider--stacked",
        )}
        title={providerActions.length > 0 ? providerActions.map((action) => action.badge.label).join(" / ") : model.provider.label}
      >
        {providerActions.length > 0 ? (
          providerActions.map((action) => (
            <button
              key={`${action.path.provider}-${action.path.type}-${action.url}`}
              type="button"
              aria-label={purchaseActionLabel(action)}
              className="fd-result-card__provider-action"
              title={purchaseActionTitle(action)}
              onClick={(event) => handleProviderOpen(event, action)}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <ProviderBadge provider={action.badge} />
            </button>
          ))
        ) : (
          <ProviderBadge provider={model.provider} />
        )}
      </div>
    </article>
  )
}

interface ProviderAction {
  path: PurchasePath
  url: string
  badge: ResultProviderBadge
}

function providerPurchaseActions(offer: CanonicalOffer): ProviderAction[] {
  return bestPurchasePathsByProvider(offer).flatMap((path) => {
    const url = path.url ? normalizeSafePurchaseUrl(path.url) : undefined
    if (!url) return []

    return [{
      path,
      url,
      badge: providerBadgeForId(path.provider),
    }]
  })
}

function purchaseActionLabel(action: ProviderAction): string {
  return action.path.type === "search-redirect"
    ? `Buscar en ${action.badge.label}`
    : `Abrir ${action.badge.label}`
}

function purchaseActionTitle(action: ProviderAction): string {
  return action.path.type === "search-redirect"
    ? `Buscar en ${action.badge.label}: abre la busqueda equivalente y puede mostrar disponibilidad actualizada.`
    : `Abrir ${action.badge.label}`
}

function ItinerarySchedule({ summary }: { summary: ResultJourneySummary }) {
  return (
    <div className="fd-result-card__schedule">
      <ResultScheduleTime summary={summary} />
      <span className="fd-result-card__meta">{summary.departureDateLabel}</span>
    </div>
  )
}

export function ResultScheduleTime({ summary }: { summary: ResultJourneySummary }) {
  return (
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
