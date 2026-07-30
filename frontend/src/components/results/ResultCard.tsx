import { Backpack, Luggage } from "lucide-react"
import { AppIcon } from "@/components/ui/app-icon"
import { cn } from "@/lib/utils"
import type { CanonicalOffer } from "@/types"
import {
  buildResultCardModel,
  type ResultCardModel,
  type ResultLegModel,
} from "./result-card-model"
import "./result-card.css"

/*
 * Plate 1b — the result card.
 *
 * Grid: 32 / 186 / 1fr / 116 / 26. The logo, the carrier with its baggage, the
 * two schedule rows, the price with its seat count, and the provider icon.
 *
 * The alternative schedules used to be N further rows, each repeating a carrier
 * and a price that had not changed. They are now a single strip inside the card
 * that owns them, so the list stays one row per fare.
 */

export type AlternateSchedule = {
  offer: CanonicalOffer
  /** The departure time of the leg this chip would change. */
  time: string
  /** Price delta against the current schedule, or the duration when equal. */
  meta: string
  selected: boolean
}

interface ResultCardProps {
  offer: CanonicalOffer
  selected: boolean
  passengerCount: number
  onSelect: (offer: CanonicalOffer) => void
  /** Up to three chips inline; the rest live behind "+n". */
  alternates?: AlternateSchedule[]
  alternateCount?: number
  onSelectAlternate?: (offer: CanonicalOffer) => void
  onShowAllAlternates?: () => void
  /** True once a chip has been used and before the fare is quoted or dropped. */
  scheduleChanged?: boolean
  variant?: "regular" | "compact"
  eyebrow?: string
}

export function ResultCard({
  offer,
  selected,
  passengerCount,
  onSelect,
  alternates = [],
  alternateCount = 0,
  onSelectAlternate,
  onShowAllAlternates,
  scheduleChanged = false,
  variant = "regular",
  eyebrow,
}: ResultCardProps) {
  const model = buildResultCardModel(offer, passengerCount)
  const inlineAlternates = alternates.slice(0, 3)
  const hiddenAlternateCount = Math.max(0, alternateCount - inlineAlternates.length)
  const cardLabel = [
    selected ? "Oferta seleccionada" : "Seleccionar oferta",
    eyebrow,
    model.carrier.name,
    model.carrier.operatedBy,
    ...model.legs.map((leg) => `${leg.ariaLabel}: ${legAriaSchedule(leg)}, ${leg.duration}, ${leg.stopsLabel}`),
    model.baggage.ariaLabel,
    model.price.ariaLabel,
    model.seats ? `Quedan ${model.seats.label}` : "",
    model.provider.label,
    model.costamarRedirect?.label,
  ]
    .filter(Boolean)
    .join(". ")

  return (
    <article
      data-testid={variant === "compact" ? "migration-month-card" : "result-card"}
      className={cn(
        "fd-card",
        variant === "compact" && "fd-card--compact",
        selected && "is-selected",
        scheduleChanged && "is-schedule-changed",
      )}
    >
      {/* The whole card is the target. A row of small hit areas is slower to
          use than one big one, and the provider icon is the only thing inside
          that needs its own. */}
      <button
        type="button"
        className="fd-card__hit fd-focus-ring"
        aria-label={cardLabel}
        aria-pressed={selected}
        onClick={() => onSelect(offer)}
      />

      {eyebrow && <span className="fd-card__eyebrow" aria-hidden="true">{eyebrow}</span>}

      <CarrierLogo carrier={model.carrier} />

      <div className="fd-card__carrier" aria-hidden="true">
        <span className="fd-card__carrier-line">
          <span className="fd-card__carrier-name" title={model.carrier.name}>{model.carrier.name}</span>
          {model.carrier.operatedBy && (
            <span className="fd-card__carrier-operator">{model.carrier.operatedBy}</span>
          )}
        </span>
        <span className="fd-card__baggage">
          <span className="fd-card__baggage-icons">
            <span className={cn("fd-card__bag", model.baggage.carryOnIncluded ? "is-included" : "is-missing")}>
              <Backpack aria-hidden="true" />
            </span>
            <span className={cn("fd-card__bag", model.baggage.checkedIncluded ? "is-included" : "is-missing")}>
              <Luggage aria-hidden="true" />
            </span>
          </span>
          <span className="fd-card__baggage-label">{model.baggage.label}</span>
        </span>
      </div>

      <div className="fd-card__legs" aria-hidden="true">
        {model.legs.map((leg) => (
          <LegRow key={leg.label} leg={leg} />
        ))}
      </div>

      <div className="fd-card__price" aria-hidden="true">
        <span className="fd-card__price-figure">{model.price.label}</span>
        {model.seats ? (
          <span className={cn("fd-card__seats", `is-${model.seats.urgency}`)}>
            Quedan {model.seats.label}
          </span>
        ) : model.price.perPersonLabel ? (
          <span className="fd-card__price-meta">{model.price.perPersonLabel} p/p</span>
        ) : null}
      </div>

      <ProviderMark provider={model.provider} />

      {inlineAlternates.length > 0 && onSelectAlternate && (
        <div className="fd-card__alts">
          <span className="fd-type-micro fd-card__alts-label">
            {alternateCount === 1 ? "1 horario más" : `${alternateCount} horarios más`}
          </span>
          <span className="fd-card__alts-strip">
            {inlineAlternates.map((alternate) => (
              <button
                key={alternate.offer.id}
                type="button"
                className={cn("fd-card__alt-chip fd-focus-ring", alternate.selected && "is-selected")}
                aria-pressed={alternate.selected}
                aria-label={`Cambiar a la salida de ${alternate.time}, ${alternate.meta}`}
                onClick={() => onSelectAlternate(alternate.offer)}
              >
                <span className="fd-card__alt-time">{alternate.time}</span>
                <span className="fd-card__alt-meta">{alternate.meta}</span>
              </button>
            ))}
          </span>
          {hiddenAlternateCount > 0 && onShowAllAlternates && (
            <button
              type="button"
              className="fd-card__alts-more fd-focus-ring"
              aria-label={`Ver los ${alternateCount} horarios`}
              onClick={onShowAllAlternates}
            >
              +{hiddenAlternateCount}
              {/* A chevron, because the full list opens in place. */}
              <AppIcon name="chevronDown" size={12} />
            </button>
          )}
        </div>
      )}
    </article>
  )
}

function LegRow({ leg }: { leg: ResultLegModel }) {
  return (
    <div className="fd-card__leg">
      <span className="fd-card__leg-label">
        {leg.label}{" "}
        {leg.dateLabel && <span className="fd-card__leg-date">{leg.dateLabel}</span>}
      </span>

      {leg.hasKnownSchedule ? (
        <span className="fd-card__leg-schedule">
          <span className="fd-card__leg-time">{leg.departureTime}</span>
          {/* An arrow: this is travel between two points, not a range. */}
          <span className="fd-card__leg-arrow"><AppIcon name="oneWay" size={12} /></span>
          <span className="fd-card__leg-time">{leg.arrivalTime}</span>
          {/* The day jump keeps its own lane so the arrival time never shifts
              left when a flight happens to land the next morning. */}
          <span className="fd-card__leg-offset">{leg.dayOffset}</span>
        </span>
      ) : (
        <span className="fd-card__leg-unknown">Horario por confirmar</span>
      )}

      <span className="fd-card__leg-duration">{leg.duration}</span>
      <span
        className={cn("fd-card__leg-stops", `is-${leg.stopsTone}`)}
        title={leg.stopsTitle}
      >
        {leg.stopsLabel}
      </span>
    </div>
  )
}

function CarrierLogo({ carrier }: { carrier: ResultCardModel["carrier"] }) {
  return (
    <div className="fd-card__logo" title={carrier.name} aria-hidden="true">
      {carrier.logo
        ? <img src={carrier.logo} alt="" decoding="async" loading="lazy" />
        : <span>{carrier.code || carrier.name.slice(0, 2).toUpperCase()}</span>}
    </div>
  )
}

function ProviderMark({ provider }: { provider: ResultCardModel["provider"] }) {
  return (
    <div className="fd-card__provider" title={provider.label} aria-hidden="true">
      {provider.icon
        ? <img src={provider.icon} alt="" decoding="async" />
        : <span>{provider.shortLabel}</span>}
    </div>
  )
}

function legAriaSchedule(leg: ResultLegModel): string {
  if (!leg.hasKnownSchedule) return "horario por confirmar"
  const offset = leg.dayOffset ? `, llega ${leg.dayOffset} día` : ""
  return `${leg.departureTime} a ${leg.arrivalTime}${offset}`
}
