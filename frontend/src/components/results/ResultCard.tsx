import { useLayoutEffect, useRef, useState, type RefObject } from "react"
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
 * Plate 1b — the result row.
 *
 * Grid: 28 / 142‥170 / 359‥427 / 36 / 116‥135 / 26. The logo, «who flies», the
 * two legs, the baggage, the price with its per-person line, and the provider
 * icon. Baggage holds a track of its own because it is a property of the fare
 * and not of the airline; the lane it cost was taken out of «who flies», which
 * fell from 186 to 142, and not out of the result cell.
 *
 * Three of the six tracks grow with the desk, each stopping at the widest
 * string it can be handed; what a desk has past that is spacing, split evenly
 * between the columns rather than piled into one of them. Every number is
 * derived in `result-card.css`.
 *
 * Same lanes, same type, same order as the card this used to be — what changed
 * is the recipient: a border, a radius and a shadow per fare became one rule
 * under each, and a header above the list that names the lanes. Nothing in this
 * file decides that; every number is derived in `result-card.css`.
 *
 * The alternative schedules used to be N further rows, each repeating a carrier
 * and a price that had not changed. They are now a single strip inside the row
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
  /** As many chips as the strip fits; the rest live behind "+n". */
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
  const stripRef = useRef<HTMLSpanElement>(null)
  const fittingAlternates = useChipsThatFit(stripRef, alternates.length)
  const hiddenAlternateCount = Math.max(0, alternateCount - fittingAlternates)
  const cardLabel = [
    selected ? "Oferta seleccionada" : "Seleccionar oferta",
    model.carrier.name,
    /* The prefix the two dispositions draw in CSS, said in full here: a reader
       hears one list and has no line break or middle dot to tell it that the
       second name is the operator. */
    model.carrier.operatedBy && `Operado por ${model.carrier.operatedBy}`,
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

      {model.baggage.shown && (
        <span className="fd-card__baggage" title={model.baggage.title} aria-hidden="true">
          {/* Through the registry, so the pair is the same two marks the filter
              and the detail panel draw — and so the size comes from the closed
              catalogue instead of from the stylesheet reaching into the svg. */}
          {model.baggage.carryOnIncluded !== undefined && (
            <span className={cn("fd-card__bag", model.baggage.carryOnIncluded ? "is-included" : "is-missing")}>
              <AppIcon name="cabinBag" size={14} />
            </span>
          )}
          {model.baggage.checkedIncluded !== undefined && (
            <span className={cn("fd-card__bag", model.baggage.checkedIncluded ? "is-included" : "is-missing")}>
              <AppIcon name="holdBag" size={14} />
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

      {alternates.length > 0 && onSelectAlternate && (
        <div className="fd-card__alts">
          <span className="fd-type-micro fd-card__alts-label">
            {alternateCount === 1 ? "1 horario más" : `${alternateCount} horarios más`}
          </span>
          <span ref={stripRef} className="fd-card__alts-strip">
            {alternates.map((alternate, index) => (
              <button
                key={alternate.offer.id}
                type="button"
                className={cn(
                  "fd-card__alt-chip fd-focus-ring",
                  alternate.selected && "is-selected",
                  index >= fittingAlternates && "is-hidden",
                )}
                aria-pressed={alternate.selected}
                aria-hidden={index >= fittingAlternates || undefined}
                tabIndex={index >= fittingAlternates ? -1 : undefined}
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

/**
 * How many chips the strip can hold, measured rather than assumed.
 *
 * This was three, whatever the width: on a 1142px list the strip has room for
 * six and drew half of them, and the «+n» beside it counted schedules the card
 * had space to show.
 *
 * Every chip stays in the DOM and the ones past the fit are taken out of flow
 * (`is-hidden` below) rather than out of the tree. That is what keeps the
 * measurement honest through a resize and through a schedule swap: an
 * out-of-flow chip still measures its own content, so the widths are read fresh
 * on every pass and there is no cached geometry to go stale — and no state to
 * reset when the strip is handed a different set of alternatives.
 *
 * The «+n» button is a sibling of the strip, so its appearance narrows the
 * strip and the observer runs again. That settles in one pass and cannot
 * oscillate: it only ever takes chips away, and it stays for as long as one is
 * hidden.
 */
function useChipsThatFit(stripRef: RefObject<HTMLElement | null>, count: number): number {
  const [visible, setVisible] = useState(count)

  useLayoutEffect(() => {
    const strip = stripRef.current
    if (!strip || count === 0) return

    const measure = () => {
      const chips = Array.from(strip.children) as HTMLElement[]
      /* The gap is read from the element so this arithmetic cannot drift from
         the stylesheet that owns it. */
      const gap = Number.parseFloat(window.getComputedStyle(strip).columnGap) || 0
      const available = strip.clientWidth
      let used = 0
      let fits = 0

      for (const chip of chips) {
        const width = chip.getBoundingClientRect().width
        const next = fits === 0 ? width : used + gap + width
        if (next > available) break
        used = next
        fits += 1
      }

      /* One chip always, even where it does not fit: a strip labelled «N
         horarios más» with nothing in it says less than a tight one. */
      setVisible(Math.min(chips.length, Math.max(1, fits)))
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [stripRef, count])

  return Math.min(visible, count)
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
      {/* Both wordings ride along and the stylesheet picks one by measure. The
          stop count comes with them, because the choice depends on it: from
          two stops the short form is the bare count, and there is no width at
          which the long one can be had on a phone. Neither is spoken — the
          row's label is built from the long form. */}
      <span className="fd-card__leg-stops" data-stops={leg.stopsTone} title={leg.stopsTitle}>
        {/* Two lanes on a desk, one string on a phone. The count and the
            airports are separate cells so the row's grid can give the count a
            track of its own, shared by both legs — see the stylesheet. */}
        <span className="fd-card__leg-stops-long">
          <span className="fd-card__leg-stops-count">{leg.stopsCountLabel}</span>
          <span className="fd-card__leg-stops-codes">{leg.stopsCodesLabel}</span>
        </span>
        <span className="fd-card__leg-stops-short">{leg.stopsShortLabel}</span>
      </span>
    </div>
  )
}

function CarrierLogo({ carrier }: { carrier: ResultCardModel["carrier"] }) {
  /* The card asks for a mark for every carrier now, and the server fetches one
     the release does not carry. A code with no artwork anywhere answers 404,
     and the two letters are what stands in — decided by the image failing
     rather than by a list this component would have to be told about.
     What is remembered is the source that failed, not that one did: a
     different carrier in a recycled row is a different source and starts over
     without anything having to reset it. */
  const source = carrier.logo
  const [failedSource, setFailedSource] = useState<string | null>(null)
  const failed = Boolean(source) && failedSource === source

  return (
    <div className="fd-card__logo" title={carrier.name} aria-hidden="true">
      {source && !failed
        ? (
          <img
            src={source}
            alt=""
            decoding="async"
            loading="lazy"
            onError={() => setFailedSource(source)}
          />
        )
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
