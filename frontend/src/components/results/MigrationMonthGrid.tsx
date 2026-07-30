import { AppIcon } from "@/components/ui/app-icon"
import { buildResultCardModel, providerBadgeForId } from "@/components/results/result-card-model"
import { cn } from "@/lib/utils"
import type { CanonicalOffer, MigrationMonthSummary, SearchJobResponse } from "@/types"

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

type DisplayMonth = MigrationMonthSummary & { filtered?: boolean }

export function MigrationMonthGrid({
  results,
  offers,
  passengerCount,
  selectedOfferId,
  onSelectOffer,
}: {
  results: SearchJobResponse
  offers: CanonicalOffer[]
  passengerCount: number
  selectedOfferId?: string
  onSelectOffer: (offer: CanonicalOffer) => void
}) {
  const months = monthsForDisplay(results, offers)
  const prices = months
    .map((month) => month.offer?.price?.total?.amount)
    .filter((amount): amount is number => typeof amount === "number" && Number.isFinite(amount))
  const cheapest = prices.length > 0 ? Math.min(...prices) : 0
  const dearest = prices.length > 0 ? Math.max(...prices) : 0
  const searching = months.filter((month) => month.status === "loading" || month.status === "partial").length
  const priced = months.filter((month) => month.offer).length

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-3 px-3 pt-[7px] pb-1">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="fd-panel-count">
            {priced} de {months.length} {months.length === 1 ? "mes" : "meses"} con tarifa
          </span>
          {searching > 0 && (
            <span className="fd-status-pill">
              <AppIcon name="loading" size={12} spin />
              {searching} buscando
            </span>
          )}
        </div>
        <span className="flex shrink-0 items-baseline gap-2">
          <span className="fd-type-micro">Rango</span>
          <span className="fd-mono text-[13px] font-semibold">{monthRangeLabel(months)}</span>
        </span>
      </div>

      <div className="fd-scrollbar-hidden min-h-0 flex-1 overflow-y-auto p-3 pt-1.5" style={{ containerType: "inline-size" }}>
        <div className="fd-month-grid">
          {months.map((month) => (
            month.offer ? (
              <MonthCard
                key={month.key}
                month={month}
                offer={month.offer}
                passengerCount={passengerCount}
                selected={selectedOfferId === month.offer.id}
                cheapest={cheapest}
                dearest={dearest}
                onSelect={onSelectOffer}
              />
            ) : (
              <EmptyMonthCard key={month.key} month={month} />
            )
          ))}
        </div>
      </div>
    </div>
  )
}

function MonthCard({
  month,
  offer,
  passengerCount,
  selected,
  cheapest,
  dearest,
  onSelect,
}: {
  month: DisplayMonth
  offer: CanonicalOffer
  passengerCount: number
  selected: boolean
  cheapest: number
  dearest: number
  onSelect: (offer: CanonicalOffer) => void
}) {
  const model = buildResultCardModel(offer, passengerCount)
  const provider = providerBadgeForId(offer.providerSource)
  const outbound = model.legs[0]
  const price = offer.price?.total?.amount ?? 0
  const nextFares = nextFaresForMonth(month, offer)
  const coverage = monthFareCoverage(month)

  return (
    <button
      type="button"
      className={cn("fd-month-card fd-focus-ring", selected && "is-selected")}
      data-testid="migration-month-card"
      aria-pressed={selected}
      aria-label={`${month.label}: ${model.price.label} con ${model.carrier.name}`}
      onClick={() => onSelect(offer)}
    >
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate text-[13px] font-bold">{month.label}</span>
        {month.status === "partial" && (
          <span className="fd-status-pill shrink-0">
            <AppIcon name="loading" size={12} spin />
            Act.
          </span>
        )}
      </span>

      {/* The month's one job. 22px mono 800 — the only display body in the
          system — with the airline logo at its right: the datum that identifies
          the fare, at the size of the datum that sells it. */}
      <span className="mt-[11px] grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5">
        <span className="fd-type-display whitespace-nowrap">{model.price.label}</span>
        {model.carrier.logo && (
          <img src={model.carrier.logo} alt="" className="size-7 shrink-0 object-contain" decoding="async" loading="lazy" />
        )}
      </span>

      <span className="fd-month-bar mt-[11px]" aria-hidden="true">
        <span
          className="fd-month-bar-fill"
          style={{ width: `${comparisonWidth(price, cheapest, dearest)}%` }}
        />
      </span>

      <span className="mt-[13px] grid min-w-0 gap-1">
        <span className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <span className="truncate text-xs font-semibold leading-[1.3]">
            {dayLabel(offer.departureDate)} · {model.carrier.name}
          </span>
          {provider.icon && (
            <img src={provider.icon} alt="" className="size-[18px] shrink-0 object-contain" decoding="async" />
          )}
        </span>
        {outbound && (
          <span className="fd-mono truncate text-[11px] leading-[1.3]">
            {outbound.departureTime} → {outbound.arrivalTime} · {outbound.duration}
          </span>
        )}
        <span className="truncate text-[11px] leading-[1.3] text-muted-foreground">
          {[outbound?.stopsLabel, model.baggage.label].filter(Boolean).join(" · ")}
        </span>
      </span>

      <span />

      <span className="fd-month-foot">
        {nextFares.map((fare) => (
          <span key={fare.id} className="fd-month-alt">
            <span className="fd-month-alt-label">{fare.label}</span>
            <span className="fd-month-alt-price">{fare.price}</span>
          </span>
        ))}
        {coverage && (
          <span className="truncate text-[10px] font-semibold text-muted-foreground">
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

function EmptyMonthCard({ month }: { month: DisplayMonth }) {
  const loading = month.status === "loading"
  const title = loading
    ? "Buscando…"
    : month.status === "error"
      ? "Error al consultar"
      : month.status === "cancelled"
        ? "No consultado"
        : month.filtered ? "Sin tarifa con filtros" : "Sin tarifa"
  const body = loading
    ? "Consultando el precio más bajo del mes."
    : month.status === "error"
      ? month.warnings?.[0] ?? "La consulta de este mes no pudo completarse."
      : month.filtered
        ? "Ajusta directo, equipaje o aerolínea para volver a incluirlo."
        : month.status === "cancelled"
          ? month.warnings?.[0] ?? "Búsqueda detenida antes de consultar este mes."
          : month.warnings?.[0] ?? "No hubo una oferta disponible."

  return (
    <div className="fd-month-card fd-month-card-empty" data-testid="migration-month-card">
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate text-[13px] font-bold text-muted-foreground">{month.label}</span>
        {loading && (
          <span className="fd-status-pill shrink-0">
            <AppIcon name="loading" size={12} spin />
            Buscando
          </span>
        )}
      </span>
      <span className="mt-[11px] text-[13px] font-semibold">{title}</span>
      <span />
      <span className="mt-[13px] text-[11px] leading-4 text-muted-foreground">{body}</span>
      <span />
      <span className="fd-month-foot">
        <span className="truncate text-[10px] font-semibold text-muted-foreground">
          {dateRangeLabel(month.departureStart, month.departureEnd)}
        </span>
      </span>
    </div>
  )
}

/**
 * How full the comparison bar is. The cheapest month keeps a visible stub rather
 * than an empty bar: a bar at zero reads as "no data", which is a different card
 * state entirely.
 */
function comparisonWidth(price: number, cheapest: number, dearest: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0
  if (dearest <= cheapest) return 100

  const ratio = (price - cheapest) / (dearest - cheapest)
  return Math.round(18 + ratio * 82)
}

function monthsForDisplay(results: SearchJobResponse, offers: CanonicalOffer[]): DisplayMonth[] {
  if (!results.migrationMonths?.length) {
    return offers.map((offer) => ({
      key: offer.id,
      label: monthLabelFromOffer(offer),
      departureStart: offer.departureDate,
      departureEnd: offer.departureDate,
      offer,
      status: "available",
    }))
  }

  const visibleOfferIds = new Set(offers.map((offer) => offer.id))
  return results.migrationMonths.map((month) => {
    if (!month.offer || visibleOfferIds.has(month.offer.id)) return month
    return { ...month, offer: undefined, filtered: true }
  })
}

/** The live range in the header — the same "ago 2026 → mar 2027" the picker shows. */
function monthRangeLabel(months: DisplayMonth[]): string {
  if (months.length === 0) return "—"

  const first = months[0]
  const last = months[months.length - 1]
  if (months.length === 1) return first.label

  return `${first.label} – ${last.label}`
}

function monthLabelFromOffer(offer: CanonicalOffer): string {
  const tag = offer.tags?.find((item) => item && item !== "Migratorio")
  if (tag) return tag

  const value = offer.departureDate?.slice(0, 7)
  if (!value || !/^\d{4}-\d{2}$/.test(value)) return "Mes"

  const label = new Intl.DateTimeFormat("es-PE", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}-01T00:00:00Z`))
  return label.charAt(0).toUpperCase() + label.slice(1)
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
