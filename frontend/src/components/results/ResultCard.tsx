import { Backpack, Luggage } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
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
  const providerLabel = providerActions.map((action) => action.badge.label).join(" / ") || model.provider.label
  const rowLabel = [
    selected ? "Oferta seleccionada" : "Seleccionar oferta",
    eyebrow,
    model.carrier.display,
    model.carrier.operatedBy,
    ...model.journeys.flatMap((journey) => [
      `${journey.label}: ${journey.schedule}`,
      journey.departureDateLabel,
    ]),
    model.route,
    `Equipaje: ${baggageLabel(offer)}`,
    model.duration,
    model.stops.label,
    model.stops.layoverLabel,
    providerLabel,
    model.costamarRedirect?.label,
    model.price.combinedLabel,
  ]
    .filter(Boolean)
    .join(" - ")

  const handleProviderOpen = (action: ProviderAction) => {
    window.open(
      action.url,
      action.path.requiresNewTab ? "_blank" : "_self",
      "noopener,noreferrer",
    )
  }

  return (
    <article
      data-testid={variant === "compact" ? "migration-month-card" : "result-card"}
      className={cn(
        "fd-result-card",
        variant === "compact" && "fd-result-card--compact",
        selected && "is-selected",
      )}
    >
      <button
        type="button"
        className="fd-result-card__select-action"
        aria-label={rowLabel}
        aria-pressed={selected}
        title={rowLabel}
        onClick={() => onSelect(offer)}
      />

      {eyebrow && <span className="fd-result-card__eyebrow" aria-hidden="true">{eyebrow}</span>}

      <AirlineLogo carrier={model.carrier} />

      <div className="fd-result-card__airline" aria-hidden="true">
        <span className="fd-result-card__airline-name" title={model.carrier.display}>{model.carrier.display}</span>
        {model.carrier.operatedBy && <span className="fd-result-card__meta">{model.carrier.operatedBy}</span>}
      </div>

      <div className="fd-result-card__schedules" data-trip-type={model.tripType} aria-hidden="true">
        {model.journeys.map((journey) => (
          <ItinerarySchedule key={journey.label} summary={journey} />
        ))}
      </div>

      <div className="fd-result-card__route" aria-hidden="true">
        <span className="fd-result-card__route-main" title={model.route}>{model.route}</span>
        <span className="fd-result-card__route-baggage">
          <span className="fd-result-card__micro-label">Equipaje</span>
          <BaggageIcons offer={offer} />
        </span>
      </div>

      <div className="fd-result-card__journey" aria-hidden="true">
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

      <div className="fd-result-card__price" aria-hidden="true">
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
            <Tooltip key={`${action.path.provider}-${action.path.type}-${action.url}`}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={purchaseActionLabel(action)}
                  className="fd-result-card__provider-action h-auto w-auto rounded-none p-0 hover:bg-transparent focus-visible:ring-0 active:scale-100"
                  onClick={() => handleProviderOpen(action)}
                >
                  <ProviderBadge provider={action.badge} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">{purchaseActionTitle(action)}</TooltipContent>
            </Tooltip>
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

function AirlineLogo({ carrier }: { carrier: ResultCardModel["carrier"] }) {
  return (
    <div className="fd-result-card__airline-logo" title={carrier.display} aria-hidden="true">
      {carrier.logo ? (
        <img src={carrier.logo} alt="" aria-hidden="true" decoding="async" loading="lazy" />
      ) : (
        <span>{carrier.code || carrier.display.slice(0, 2).toUpperCase()}</span>
      )}
    </div>
  )
}

function BaggageIcons({ offer }: { offer: CanonicalOffer }) {
  const carryOn = offer.baggage?.carryOnIncluded === true
  const checked = offer.baggage?.checkedIncluded === true
  const label = baggageLabel(offer)

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

function baggageLabel(offer: CanonicalOffer): string {
  return [
    `Cabina ${offer.baggage?.carryOnIncluded === true ? "incluida" : "no incluida"}`,
    `Bodega ${offer.baggage?.checkedIncluded === true ? "incluida" : "no incluida"}`,
  ].join(", ")
}
