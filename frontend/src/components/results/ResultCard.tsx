import { memo, useLayoutEffect, useRef, useState, type RefObject } from "react"
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
 * Plate 1b — the result row: logo, «who flies», the two legs, baggage, price
 * and provider. Every track is derived in `result-card.css`. Alternative
 * schedules are one strip inside the row that owns them.
 */

export type AlternateSchedule = {
  offer: CanonicalOffer
  /** The leg that differs from the schedule currently shown. */
  legAriaLabel: string
  /** The departure time of the leg this chip would change. */
  time: string
  meta: string
}

interface ResultCardProps {
  offer: CanonicalOffer
  selected: boolean
  passengerCount: number
  showPerPerson?: boolean
  onSelect: (offerId: string) => void
  alternates?: AlternateSchedule[]
  onSelectAlternate?: (offerId: string) => void
  onShowAllAlternates?: () => void
  /** True once a chip has been used and before the fare is quoted or dropped. */
  scheduleChanged?: boolean
}

export const ResultCard = memo(function ResultCard({
  offer,
  selected,
  passengerCount,
  showPerPerson = true,
  onSelect,
  alternates = [],
  onSelectAlternate,
  onShowAllAlternates,
  scheduleChanged = false,
}: ResultCardProps) {
  const model = buildResultCardModel(offer, passengerCount, { showPerPerson })
  const stripRef = useRef<HTMLSpanElement>(null)
  const fittingAlternates = useChipsThatFit(stripRef, alternates.length)
  const alternateCount = alternates.length
  const hiddenAlternateCount = Math.max(0, alternateCount - fittingAlternates)
  const cardLabel = [
    selected ? "Oferta seleccionada" : "Seleccionar oferta",
    model.carrier.name,
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
      data-offer-id={offer.id}
      className={cn(
        "fd-card",
        selected && "is-selected",
        scheduleChanged && "is-schedule-changed",
      )}
    >
      {/* The whole card is the target; the provider icon is the only thing
          inside that needs its own. */}
      <button
        type="button"
        className="fd-card__hit fd-focus-ring"
        aria-label={cardLabel}
        aria-pressed={selected}
        onClick={() => onSelect(offer.id)}
      />

      <CarrierLogo carrier={model.carrier} />

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

      {/* Keyed on the offer so choosing another schedule cross-fades the legs
          alone (04 §5). */}
      <div key={offer.id} className="fd-card__legs fd-motion-crossfade" aria-hidden="true">
        {model.legs.map((leg) => (
          <LegRow key={leg.label} leg={leg} />
        ))}
      </div>

      {model.baggage.shown && (
        <span className="fd-card__baggage" title={model.baggage.title} aria-hidden="true">
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
                  index >= fittingAlternates && "is-hidden",
                )}
                aria-hidden={index >= fittingAlternates || undefined}
                tabIndex={index >= fittingAlternates ? -1 : undefined}
                aria-label={`Cambiar la ${alternate.legAriaLabel.toLocaleLowerCase("es-PE")} a las ${alternate.time}, ${alternate.meta}`}
                onClick={() => onSelectAlternate(alternate.offer.id)}
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
              <AppIcon name="chevronDown" size={12} />
            </button>
          )}
        </div>
      )}
    </article>
  )
})

/*
 * How many chips the strip holds, measured. Chips past the fit stay in the DOM
 * out of flow (`is-hidden`), so every pass measures fresh widths; the «+n»
 * sibling only ever takes chips away, so the observer settles in one pass.
 */
function useChipsThatFit(stripRef: RefObject<HTMLElement | null>, count: number): number {
  const [visible, setVisible] = useState(count)

  useLayoutEffect(() => {
    const strip = stripRef.current
    if (!strip || count === 0) return

    const measure = () => {
      const chips = Array.from(strip.children) as HTMLElement[]
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

      /* One chip always: a strip labelled «N horarios más» with nothing in it
         says less than a tight one. */
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
          <span className="fd-card__leg-arrow"><AppIcon name="oneWay" size={12} /></span>
          <span className="fd-card__leg-time">{leg.arrivalTime}</span>
          <span className="fd-card__leg-offset">{leg.dayOffset}</span>
        </span>
      ) : (
        <span className="fd-card__leg-unknown">Horario por confirmar</span>
      )}

      <span className="fd-card__leg-duration">{leg.duration}</span>
      {/* Both wordings ride along and the stylesheet picks one by measure. */}
      <span className="fd-card__leg-stops" data-stops={leg.stopsTone} title={leg.stopsTitle}>
        <span className="fd-card__leg-stops-long">
          <span className="fd-card__leg-stops-count">{leg.stopsCountLabel}</span>
          <span className="fd-card__leg-stops-codes">{leg.stopsCodesLabel}</span>
        </span>
        <span className="fd-card__leg-stops-short">{leg.stopsShortLabel}</span>
      </span>
    </div>
  )
}

/* A carrier with no artwork answers 404 and draws its two letters. The failed
   source is remembered, so a recycled row with another carrier starts over. */
function CarrierLogo({ carrier }: { carrier: ResultCardModel["carrier"] }) {
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
