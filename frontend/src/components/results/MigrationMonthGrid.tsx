import type { CSSProperties, ReactNode } from "react"
import { Spinner } from "@/components/ui/spinner"
import { buildResultCardModel, providerBadgeForId } from "@/components/results/result-card-model"
import { cn } from "@/lib/utils"
import { formatDayMonthNumeric, formatMoney, formatWeekdayDay } from "@/lib/format"
import {
  isMonthSearching,
  monthWarningLine,
  type DisplayMonth,
} from "@/components/results/migration-month-model"
import type { CanonicalOffer } from "@/types"

/*
 * Plates 1i (desktop) and 2f (mobile) — Migratorio. A month sells its lowest
 * price; the bar puts it in scale against the dearest month, and under it is
 * the flight that achieves it. A month with no fare keeps its slot (06 §3).
 */
export function MigrationMonthGrid({
  months,
  passengerCount,
  selectedOfferId,
  onSelectOffer,
  onOpenMonth,
}: {
  months: DisplayMonth[]
  passengerCount: number
  selectedOfferId?: string
  onSelectOffer: (offerId: string) => void
  /** 06 §1.3: a month opens as the normal list of that month. */
  onOpenMonth?: (month: DisplayMonth) => void
}) {
  const prices = months
    .map((month) => month.offer?.price?.total?.amount)
    .filter((amount): amount is number => typeof amount === "number" && Number.isFinite(amount))
  const cheapest = prices.length > 0 ? Math.min(...prices) : 0
  const dearest = prices.length > 0 ? Math.max(...prices) : 0

  return (
    <div className="fd-month-scroller fd-scrollbar-hidden">
      <div className="fd-month-grid">
        {months.map((month, index) => (
          month.offer ? (
            <MonthCard
              key={month.key}
              month={month}
              offer={month.offer}
              index={index}
              passengerCount={passengerCount}
              selected={selectedOfferId === month.offer.id}
              cheapest={cheapest}
              dearest={dearest}
              pricedMonthCount={prices.length}
              onSelectOffer={onSelectOffer}
              onOpen={onOpenMonth}
            />
          ) : (
            <EmptyMonthCard key={month.key} month={month} index={index} />
          )
        ))}
      </div>
    </div>
  )
}

function MonthCard({
  month,
  offer,
  index,
  passengerCount,
  selected,
  cheapest,
  dearest,
  pricedMonthCount,
  onSelectOffer,
  onOpen,
}: {
  month: DisplayMonth
  offer: CanonicalOffer
  index: number
  passengerCount: number
  selected: boolean
  cheapest: number
  dearest: number
  pricedMonthCount: number
  onSelectOffer: (offerId: string) => void
  onOpen?: (month: DisplayMonth) => void
}) {
  const model = buildResultCardModel(offer, passengerCount)
  const provider = providerBadgeForId(offer.providerSource)
  const outbound = model.legs[0]
  const price = offer.price?.total?.amount ?? 0
  const nextFares = nextFaresForMonth(month, offer)
  const coverage = monthFareCoverage(month)
  /* Only against something: a single priced month is not a minimum. */
  const isCheapest = pricedMonthCount > 1 && price > 0 && price === cheapest

  return (
    /* Selecting reads the month in the detail; opening it leaves this screen,
       so it is a control of its own. A button cannot hold a button, hence the
       full-bleed hit button under the content, as on the result card. */
    <div
      className={cn("fd-month-card", selected && "is-selected", isCheapest && "is-cheapest")}
      style={monthRowStyle(index)}
      data-testid="migration-month-card"
      data-offer-id={offer.id}
    >
      <button
        type="button"
        className="fd-month-card__hit fd-focus-ring"
        aria-pressed={selected}
        aria-label={`${month.label}: ${model.price.label} con ${model.carrier.name}`}
        onClick={() => onSelectOffer(offer.id)}
      />
      <span className="fd-month-head">
        <span className="fd-month-label">{month.label}</span>
        {isCheapest && <span className="fd-month-badge">Más bajo</span>}
        {month.status === "partial" && (
          <span className="fd-month-badge fd-month-badge--quiet">
            <Spinner size={12} />
            Actualizando
          </span>
        )}
      </span>

      <span className="fd-month-hero">
        <span className="fd-type-display fd-month-price">{model.price.label}</span>
        {model.carrier.logo
          ? <img src={model.carrier.logo} alt="" className="fd-month-logo" decoding="async" loading="lazy" />
          : <span className="fd-month-logo fd-month-logo--absent" />}
      </span>

      <span className="fd-month-bar" aria-hidden="true">
        <span
          className="fd-month-bar-fill"
          style={{ width: `${comparisonWidth(price, cheapest, dearest)}%` }}
        />
      </span>

      <span className="fd-month-flight">
        <span className="fd-month-flight-lead">
          <span className="fd-month-flight-title">
            {dayLabel(offer.departureDate)} · {model.carrier.name}
          </span>
          {provider.icon && (
            <img src={provider.icon} alt="" className="fd-month-provider" decoding="async" />
          )}
        </span>
        {outbound && (
          <span className="fd-month-schedule">
            {outbound.departureTime} → {outbound.arrivalTime}
            {outbound.dayOffset && ` ${outbound.dayOffset}`} · {outbound.duration}
          </span>
        )}
        <span className="fd-month-meta">
          {[outbound?.stopsShortLabel, model.baggage.label].filter(Boolean).join(" · ")}
        </span>
      </span>

      <span className="fd-month-spacer" />

      <span className="fd-month-foot">
        {nextFares.map((fare) => (
          <span key={fare.id} className="fd-month-alt">
            <span className="fd-month-alt-label">{fare.label}</span>
            <span className="fd-month-alt-price">{fare.price}</span>
          </span>
        ))}
        {coverage && (
          <span className="fd-month-days">
            <MonthCoverage coverage={coverage} />
          </span>
        )}
      </span>

      {onOpen && (
        <button
          type="button"
          className="fd-month-open fd-focus-ring"
          onClick={() => onOpen(month)}
          title={`Abrir ${month.label} en una pestaña nueva`}
        >
          Abrir mes
        </button>
      )}
    </div>
  )
}

/** The month's next two fares, from offers already fetched for it. */
function nextFaresForMonth(month: DisplayMonth, shownOffer: CanonicalOffer) {
  return (month.offers ?? [])
    .filter((offer) => offer.id !== shownOffer.id && Number.isFinite(offer.price?.total?.amount))
    .sort((left, right) => left.price.total.amount - right.price.total.amount)
    .slice(0, 2)
    .map((offer) => ({
      id: offer.id,
      label: `${dayLabel(offer.departureDate)} · ${buildResultCardModel(offer, 1).carrier.name}`,
      price: offer.price?.total ? formatMoney(offer.price.total, 0) : "—",
    }))
}

type MonthFareCoverage = { faredDays: number; queriedDays: number }

/* One line on purpose: breaking the JSX drops the spaces between figures and words. */
function MonthCoverage({ coverage }: { coverage: MonthFareCoverage }) {
  return (
    <>
      <span className="fd-count">{coverage.faredDays}</span> de <span className="fd-count">{coverage.queriedDays}</span> días con tarifa
    </>
  )
}

function monthFareCoverage(month: DisplayMonth): MonthFareCoverage | null {
  const { faredDays, queriedDays } = month
  if (typeof faredDays !== "number" || typeof queriedDays !== "number") return null
  if (!Number.isFinite(faredDays) || !Number.isFinite(queriedDays) || queriedDays <= 0) return null

  return { faredDays, queriedDays }
}

/* The same card with the data switched off, so a month with no fare keeps its
   place in what is a calendar, not a list of offers (06 §3). */
function EmptyMonthCard({ month, index }: { month: DisplayMonth; index: number }) {
  const searching = isMonthSearching(month)
  const warning = monthWarningLine(month)
  const lead = searching
    ? "Consultando cada día del mes"
    : month.status === "error"
      ? warning ?? "La consulta de este mes no pudo completarse"
      : month.status === "cancelled"
        ? warning ?? "Búsqueda detenida antes de este mes"
        : month.filtered
          ? "Sin tarifa con estos filtros"
          : warning ?? "Sin tarifa disponible"
  const coverage = monthFareCoverage(month)
  const days: ReactNode = searching
    ? "consultando el mes"
    : month.filtered
      ? "descartado por filtros"
      : coverage
        ? <MonthCoverage coverage={coverage} />
        : month.status === "error" || month.status === "cancelled"
          ? "sin consultar"
          : "sin tarifa en el mes"

  return (
    <div
      className="fd-month-card fd-month-card--empty"
      style={monthRowStyle(index)}
      data-testid="migration-month-card"
    >
      <span className="fd-month-head">
        <span className="fd-month-label">{month.label}</span>
        {searching && (
          <span className="fd-month-badge fd-month-badge--quiet">
            <Spinner size={12} />
            Buscando
          </span>
        )}
      </span>

      <span className="fd-month-hero">
        <span className="fd-type-display fd-month-price">{searching ? "···" : "—"}</span>
        <span className="fd-month-logo fd-month-logo--absent" />
      </span>

      {/* The empty track keeps the rows aligned; a bar at zero would read as «cheap». */}
      <span className="fd-month-bar" aria-hidden="true" />

      <span className="fd-month-flight">
        <span className="fd-month-flight-lead">
          <span className="fd-month-flight-title">{lead}</span>
        </span>
        <span className="fd-month-meta">{dateRangeLabel(month.departureStart, month.departureEnd)}</span>
      </span>

      <span className="fd-month-spacer" />

      <span className="fd-month-foot">
        <span className="fd-month-days">{days}</span>
      </span>
    </div>
  )
}

/* 06 §5: the bars grow once, when the month's data lands, 40ms apart. */
function monthRowStyle(index: number): CSSProperties {
  return { "--i": String(index) } as CSSProperties
}

/* The cheapest month keeps a 26% stub (1i): an empty bar reads as «no data». */
const MIN_BAR_PERCENT = 26

function comparisonWidth(price: number, cheapest: number, dearest: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0
  if (dearest <= cheapest) return MIN_BAR_PERCENT

  const ratio = (price - cheapest) / (dearest - cheapest)
  return Math.round(MIN_BAR_PERCENT + ratio * (100 - MIN_BAR_PERCENT))
}

function dayLabel(isoDate?: string): string {
  return formatWeekdayDay(isoDate ?? "") || "Fecha por confirmar"
}

function dateRangeLabel(start?: string, end?: string): string {
  const left = formatDayMonthNumeric(start ?? "")
  const right = formatDayMonthNumeric(end ?? "")
  if (!left && !right) return "Fechas por confirmar"
  if (left && right && left !== right) return `${left} – ${right}`
  return left || right
}
