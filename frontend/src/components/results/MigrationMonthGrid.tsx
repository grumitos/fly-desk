import type { CSSProperties } from "react"
import { Spinner } from "@/components/ui/spinner"
import { buildResultCardModel, providerBadgeForId } from "@/components/results/result-card-model"
import { cn } from "@/lib/utils"
import {
  isMonthSearching,
  monthsForDisplay,
  monthWarningLine,
  type DisplayMonth,
} from "@/components/results/migration-month-model"
import type { CanonicalOffer, SearchJobResponse } from "@/types"

/*
 * Plates 1i (desktop) and 2f (mobile) — Migratorio.
 *
 * The old grid reused the result card in a compact variant: every month spent
 * 172px on data that is not being compared in this view, and still left half the
 * height empty.
 *
 * Here a month sells one thing — the lowest price — and the 6px bar puts it in
 * scale against the dearest month, so the year reads in one sweep without
 * comparing figures. Under it, the flight that achieves that price with
 * everything the agent weighs before quoting: day, airline, provider, schedule
 * with duration, stops, baggage. At the foot, the month's next two fares, so the
 * decision is not staked on a single flight.
 *
 * Months with no fare, an error, or filtered out keep their slot in grey — a
 * sweep with holes in it is not a sweep.
 */

export function MigrationMonthGrid({
  results,
  offers,
  passengerCount,
  selectedOfferId,
  onSelectOffer,
  onOpenMonth,
}: {
  results: SearchJobResponse
  offers: CanonicalOffer[]
  passengerCount: number
  selectedOfferId?: string
  onSelectOffer: (offer: CanonicalOffer) => void
  /**
   * 06 §1.3 and 11 §5: «al elegir un mes se entra en la lista normal de ese
   * mes», with its dates already in the form. Falls back to selecting the
   * month's best offer where the shell cannot run a search.
   */
  onOpenMonth?: (month: DisplayMonth) => void
}) {
  const months = monthsForDisplay(results, offers)
  const prices = months
    .map((month) => month.offer?.price?.total?.amount)
    .filter((amount): amount is number => typeof amount === "number" && Number.isFinite(amount))
  const cheapest = prices.length > 0 ? Math.min(...prices) : 0
  const dearest = prices.length > 0 ? Math.max(...prices) : 0
  const priced = months.filter((month) => month.offer).length

  return (
    /* No container of its own. 02 §2 sanctions exactly two — `fdshell` and
       `fdlist` — and a third one here, with three thresholds no plate draws,
       is what kept the mandated four columns from ever appearing: at a 1440
       viewport this scroller is 800px wide, so the 900px rule dropped it to
       three across the whole 1100–1540 band. The grid asks `fdlist`, like the
       card does. */
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
              pricedMonthCount={priced}
              onSelect={onOpenMonth ? () => onOpenMonth(month) : () => onSelectOffer(month.offer!)}
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
  onSelect,
}: {
  month: DisplayMonth
  offer: CanonicalOffer
  index: number
  passengerCount: number
  selected: boolean
  cheapest: number
  dearest: number
  pricedMonthCount: number
  onSelect: () => void
}) {
  const model = buildResultCardModel(offer, passengerCount)
  const provider = providerBadgeForId(offer.providerSource)
  const outbound = model.legs[0]
  const price = offer.price?.total?.amount ?? 0
  const nextFares = nextFaresForMonth(month, offer)
  const coverage = monthFareCoverage(month)
  const isCheapest = pricedMonthCount > 1 && price > 0 && price === cheapest

  return (
    <button
      type="button"
      className={cn("fd-month-card fd-focus-ring", selected && "is-selected", isCheapest && "is-cheapest")}
      style={monthRowStyle(index)}
      data-testid="migration-month-card"
      aria-pressed={selected}
      aria-label={`${month.label}: ${model.price.label} con ${model.carrier.name}`}
      onClick={onSelect}
    >
      <span className="fd-month-head">
        <span className="fd-month-label">{month.label}</span>
        {/* 06 §2/§3: the month holding the minimum of the sweep says so. It is
            the one thing the grid exists to find, and reading it off twelve
            bars is work the card can do instead. Only when there is something
            to compare against — a single priced month is not a minimum. */}
        {isCheapest && <span className="fd-month-badge">Más bajo</span>}
        {month.status === "partial" && (
          <span className="fd-month-badge fd-month-badge--quiet">
            <Spinner size={12} />
            Act.
          </span>
        )}
      </span>

      {/* The month's one job. 22px mono 800 — the only display body in the
          system — with the airline logo at its right: the datum that identifies
          the fare, at the size of the datum that sells it. */}
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
            {coverage.faredDays} de {coverage.queriedDays} días con tarifa
          </span>
        )}
      </span>
    </button>
  )
}

/**
 * The month's next two fares after the one on the hero line. They come from the
 * offers already fetched for that month, so this needs no extra request — and it
 * is what stops the agent from quoting a month on the strength of one flight.
 */
function nextFaresForMonth(month: DisplayMonth, shownOffer: CanonicalOffer) {
  return (month.offers ?? [])
    .filter((offer) => offer.id !== shownOffer.id)
    .map((offer) => ({ offer, amount: offer.price?.total?.amount ?? Number.POSITIVE_INFINITY }))
    .filter((entry) => Number.isFinite(entry.amount))
    .sort((left, right) => left.amount - right.amount)
    .slice(0, 2)
    .map((entry) => ({
      id: entry.offer.id,
      label: `${dayLabel(entry.offer.departureDate)} · ${buildResultCardModel(entry.offer, 1).carrier.name}`,
      price: formatCompactMoney(entry.offer),
    }))
}

type MonthFareCoverage = { faredDays: number; queriedDays: number }

/**
 * "12 de 30 días con tarifa" — how much of the month was actually priced, which
 * is what tells the agent whether a cheap month is genuinely cheap or merely
 * thinly sampled.
 *
 * `faredDays` / `queriedDays` are emitted only after a complete, non-partial
 * provider scan. The line degrades to nothing rather than to a guess: a
 * fabricated coverage figure would make a barely-sampled month look thoroughly
 * checked, which is worse than saying nothing.
 */
function monthFareCoverage(month: DisplayMonth): MonthFareCoverage | null {
  const candidate = month as DisplayMonth & Partial<MonthFareCoverage>
  const { faredDays, queriedDays } = candidate
  if (typeof faredDays !== "number" || typeof queriedDays !== "number") return null
  if (!Number.isFinite(faredDays) || !Number.isFinite(queriedDays) || queriedDays <= 0) return null

  return { faredDays, queriedDays }
}

/*
 * A month with no fare is the same card with the data switched off — same six
 * rows, same rhythm — because «la rejilla del barrido es un calendario, no una
 * lista de ofertas» (06 §3) and a hole in it would read as a month that does
 * not exist. What changes: a dashed border on `secondary`, the price as `···`
 * or `—`, the bar track with nothing in it, and a line that says which of the
 * four reasons this is.
 */
function EmptyMonthCard({ month, index }: { month: DisplayMonth; index: number }) {
  /* 06 §3's «buscando» state, which a month reaches on the router's draft
     response — `partial` with no offers — and not only on `loading`. */
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
  /* «0 de 30 días con tarifa» is the most informative thing a finished empty
     month can say — it separates «this month has no fares» from «this month was
     barely sampled» — and it used to be computed, correct, and never drawn,
     because the coverage line lived only on the card that has a fare. */
  const days = searching
    ? "consultando el mes"
    : month.filtered
      ? "descartado por filtros"
      : coverage
        ? `${coverage.faredDays} de ${coverage.queriedDays} días con tarifa`
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

      {/* The track stays and the fill does not: an empty rail keeps the six rows
          aligned across the sweep, and a bar at zero would read as «cheap». */}
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

/*
 * 06 §5: the bars grow in 420ms with 40ms between months, and only the first
 * time that month's data lands. The delay is the row's own, so it is written
 * here rather than in twelve CSS rules; the «only once» half is React's, and it
 * comes free from the card keeping its identity across a refilter — a CSS
 * animation plays on mount, and a month that was already on screen does not
 * mount again.
 */
function monthRowStyle(index: number): CSSProperties {
  return { "--fd-month-index": String(index) } as CSSProperties
}

/**
 * How full the comparison bar is. The cheapest month keeps a visible stub rather
 * than an empty bar: a bar at zero reads as "no data", which is a different card
 * state entirely. 1i sets that stub at 26%.
 */
const MIN_BAR_PERCENT = 26


function comparisonWidth(price: number, cheapest: number, dearest: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0
  /* Nothing to compare against — one priced month, or every month at the same
     fare. A full bar would draw the only month of the sweep as the dearest one
     possible, which at the start of a sweep is most of the time. The stub says
     «this is the floor», which is what it is. */
  if (dearest <= cheapest) return MIN_BAR_PERCENT

  const ratio = (price - cheapest) / (dearest - cheapest)
  return Math.round(MIN_BAR_PERCENT + ratio * (100 - MIN_BAR_PERCENT))
}

function dayLabel(isoDate?: string): string {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}/.test(isoDate)) return "Fecha s/c"
  return new Intl.DateTimeFormat("es-PE", {
    weekday: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${isoDate.slice(0, 10)}T00:00:00Z`))
}

function formatCompactMoney(offer: CanonicalOffer): string {
  const money = offer.price?.total
  if (!money) return "—"
  return `${money.currencyCode || "USD"} ${money.amount.toLocaleString("es-PE", { maximumFractionDigits: 0 })}`
}

function dateRangeLabel(start?: string, end?: string): string {
  const left = shortDate(start)
  const right = shortDate(end)
  if (!left && !right) return "Fechas por confirmar"
  if (left && right && left !== right) return `${left} – ${right}`
  return left || right
}

function shortDate(value?: string): string {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return match ? `${match[3]}/${match[2]}` : value ?? ""
}
