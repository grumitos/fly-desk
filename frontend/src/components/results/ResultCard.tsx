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
 * Grid: 32 / 142 / 1fr / auto / 116 / 26. The logo, «who flies», the two legs,
 * the baggage, the price with its per-person line, and the provider icon.
 * Baggage holds a track of its own because it is a property of the fare and not
 * of the airline; the lane it cost was taken out of «who flies», which fell from
 * 186 to 142, and not out of the result cell.
 *
 * Past 1073px of list the legs stop stacking inside their track: each becomes a
 * plate with `flex: 1 1 0`, so a pair splits the one elastic track between them
 * and a one way fills it alone — no lane is left sized for a leg that is not
 * there. Every number above is derived in `result-card.css`.
 *
 * The alternative schedules used to be N further rows, each repeating a carrier
 * and a price that had not changed. They are now a single strip inside the card
 * that owns them, so the list stays one row per fare.
 */

export type AlternateSchedule = {
  offer: CanonicalOffer
  /** The leg that differs from the schedule currently shown. */
  legAriaLabel: string
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
  showPerPerson?: boolean
  onSelect: (offer: CanonicalOffer) => void
  /** Up to three chips inline; the rest live behind "+n". */
  alternates?: AlternateSchedule[]
  alternateCount?: number
  onSelectAlternate?: (offer: CanonicalOffer) => void
  onShowAllAlternates?: () => void
  /** True once a chip has been used and before the fare is quoted or dropped. */
  scheduleChanged?: boolean
}

export function ResultCard({
  offer,
  selected,
  passengerCount,
  showPerPerson = true,
  onSelect,
  alternates = [],
  alternateCount = 0,
  onSelectAlternate,
  onShowAllAlternates,
  scheduleChanged = false,
}: ResultCardProps) {
  const model = buildResultCardModel(offer, passengerCount, { showPerPerson })
  const inlineAlternates = alternates.slice(0, 3)
  const hiddenAlternateCount = Math.max(0, alternateCount - inlineAlternates.length)
  const cardLabel = [
    selected ? "Oferta seleccionada" : "Seleccionar oferta",
    model.carrier.name,
    model.carrier.operatedBy,
    ...model.legs.map((leg) => `${leg.ariaLabel}: ${legAriaSchedule(leg)}, ${leg.duration}, ${leg.stopsLabel}`),
    model.baggage.ariaLabel,
    model.price.ariaLabel,
    model.provider.label,
    model.costamarRedirect?.label,
  ]
    .filter(Boolean)
    .join(". ")

  return (
    <article
      data-testid="result-card"
      className={cn(
        "fd-card",
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

      <CarrierLogo carrier={model.carrier} />

      {/* Column 2 is «who flies»: the airline, and under it whoever actually
          operates the metal. The baggage icons used to sit on that second line
          and push the codeshare out of the card entirely — which is the one
          thing an agent has to know before the passenger reaches the counter.
          Baggage is a property of the fare, so it now travels with the price. */}
      <div className="fd-card__carrier" aria-hidden="true">
        <span className="fd-card__carrier-line">
          <span className="fd-card__carrier-name" title={model.carrier.name}>{model.carrier.name}</span>
        </span>
        {model.carrier.operatedBy && (
          <span className="fd-card__carrier-operator" title={model.carrier.operatedBy}>
            {model.carrier.operatedBy}
          </span>
        )}
      </div>

      {/* 04 §5: choosing an alternate schedule cross-fades the leg over 140ms.
          Keyed on the offer, so swapping the schedule remounts exactly the rows
          whose numbers changed — the price, the carrier and the card frame stay
          put, which is what makes it read as a repaint and not a new card. */}
      <div key={offer.id} className="fd-card__legs fd-motion-crossfade" aria-hidden="true">
        {model.legs.map((leg) => (
          <LegRow key={leg.label} leg={leg} />
        ))}
      </div>

      {model.baggage.label && (
        <span className="fd-card__baggage" title={model.baggage.label} aria-hidden="true">
          {model.baggage.carryOnIncluded !== undefined && (
            <span className={cn("fd-card__bag", model.baggage.carryOnIncluded ? "is-included" : "is-missing")}>
              <Backpack aria-hidden="true" />
            </span>
          )}
          {model.baggage.checkedIncluded !== undefined && (
            <span className={cn("fd-card__bag", model.baggage.checkedIncluded ? "is-included" : "is-missing")}>
              <Luggage aria-hidden="true" />
            </span>
          )}
        </span>
      )}

      <div className="fd-card__price" aria-hidden="true">
        <span className="fd-card__price-figure">{model.price.label}</span>
        {/* The seat count used to take this slot when it was four or fewer.
            Neither provider confirms it natively, so the price-per-person line
            gets the space back permanently. */}
        {model.price.perPersonLabel ? (
          <span className="fd-card__price-meta">{model.price.perPersonLabel} p/p</span>
        ) : null}
      </div>

      <ProviderMark provider={model.provider} />
      <AppIcon name="chevronRight" size={16} className="fd-card__chevron" aria-hidden="true" />

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
                aria-label={`Cambiar la ${alternate.legAriaLabel.toLocaleLowerCase("es-PE")} a las ${alternate.time}, ${alternate.meta}`}
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
      {/* Both wordings ride along and the container query picks one: the
          stacked card's stops lane is 57px, which fits "1 esc · BOG" and not
          "1 escala · BOG" (02 §6). From two stops the short form is the bare
          count, because no arrangement of «2 esc · BOG, PTY» fits 57. Neither
          is spoken — the card's label is built from the long form. */}
      <span className="fd-card__leg-stops" title={leg.stopsTitle}>
        <span className="fd-card__leg-stops-long">{leg.stopsLabel}</span>
        <span className="fd-card__leg-stops-short">{leg.stopsShortLabel}</span>
        {/* The layover, drawn only where the disposition has room to spare: a
            single leg on a wide list, which is the one case where the plate
            would otherwise stretch a line of four values across 700px. The CSS
            owns that decision — this only offers the words. */}
        {leg.waitLabel && <span className="fd-card__leg-wait"> · {leg.waitLabel}</span>}
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
