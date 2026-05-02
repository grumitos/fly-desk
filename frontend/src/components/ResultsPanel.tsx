import { memo, type ReactNode } from "react"
import { ResultCard } from "@/components/results/ResultCard"
import { AppIcon } from "@/components/ui/app-icon"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { CanonicalOffer, MigrationMonthSummary, SearchJobResponse, SortMode } from "@/types"

interface ResultsPanelProps {
  results: SearchJobResponse | null
  loading: boolean
  sort: SortMode
  onSort: (s: SortMode) => void
  onSelectOffer: (offer: CanonicalOffer) => void
  selectedOfferId?: string
}

function ResultsPanelBase({
  results,
  loading,
  sort,
  onSort,
  onSelectOffer,
  selectedOfferId,
}: ResultsPanelProps) {
  const offers = results?.offers ?? []
  const meta = results?.searchMeta
  const isMigration = results?.request.searchMode === "month-view" || Boolean(results?.migrationMonths?.length)
  const routeLabel = results?.request ? `${results.request.origin} -> ${results.request.destination}` : "Sin consulta"
  const warnings = uniqueWarnings([...(results?.warnings ?? []), ...(meta?.warnings ?? [])])
  const summaryLabel = isMigration
    ? `${results?.migrationMonths?.length ?? 8} meses · ${offers.length} con tarifa`
    : `${offers.length} oferta${offers.length === 1 ? "" : "s"}`

  return (
    <section className="fd-panel flex h-full min-h-0 min-w-0 flex-col overflow-hidden" aria-busy={loading}>
      <div className="shrink-0 border-b border-border bg-secondary/60 px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-bold">Resultados</h2>
              {loading && <Badge variant="warning">Actualizando</Badge>}
              {meta?.partial && !loading && <Badge variant="warning">Parcial</Badge>}
            </div>
            <p className="text-xs text-muted-foreground">
              {routeLabel} · {summaryLabel}
            </p>
          </div>

          <ToggleGroup
            type="single"
            value={sort}
            onValueChange={(value) => {
              if (value) onSort(value as SortMode)
            }}
            className="bg-card"
          >
            <ToggleGroupItem value="best-value" aria-label="Ordenar por mejor valor">
              Mejor valor
            </ToggleGroupItem>
            <ToggleGroupItem value="cheapest" aria-label="Ordenar por precio">
              Precio
            </ToggleGroupItem>
            <ToggleGroupItem value="fastest" aria-label="Ordenar por duración">
              Duración
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        {warnings.length > 0 && (
          <div className="fd-alert fd-alert-warning mt-2 flex min-h-9 items-start gap-2 text-xs font-medium">
            <AppIcon name="alert" className="mt-0.5" />
            <div className="min-w-0 space-y-1">
              {warnings.map((warning, index) => (
                <p key={`${warning}-${index}`}>{warning}</p>
              ))}
            </div>
          </div>
        )}
      </div>

      {renderBody({
        loading,
        results,
        offers,
        selectedOfferId,
        onSelectOffer,
      })}
    </section>
  )
}

function renderBody({
  loading,
  results,
  offers,
  selectedOfferId,
  onSelectOffer,
}: {
  loading: boolean
  results: SearchJobResponse | null
  offers: CanonicalOffer[]
  selectedOfferId?: string
  onSelectOffer: (offer: CanonicalOffer) => void
}) {
  if (loading && offers.length === 0) {
    return (
      <div className="fd-scrollbar flex-1 space-y-2.5 overflow-auto p-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-[104px] w-full" />
        ))}
      </div>
    )
  }

  if (!results && !loading) {
    return (
      <EmptyState
        icon={<AppIcon name="flight" />}
        title="Busca vuelos para comparar"
        body="Ingresa origen, destino y fechas. La lista priorizará precio, duración, escalas, equipaje y proveedor."
      />
    )
  }

  if (results?.request.searchMode === "month-view" || results?.migrationMonths?.length) {
    return (
      <MigrationMonthGrid
        months={migrationMonthsForDisplay(results, offers)}
        passengerCount={passengerCountForRequest(results.request)}
        selectedOfferId={selectedOfferId}
        onSelectOffer={onSelectOffer}
      />
    )
  }

  if (!loading && results && offers.length === 0) {
    return (
      <EmptyState
        icon={<AppIcon name="bestValue" />}
        title="Sin resultados para esta consulta"
        body="Ajusta fechas, escalas, equipaje o aerolíneas para ampliar la cobertura."
      />
    )
  }

  return (
    <div className="fd-scrollbar flex-1 overflow-auto p-2.5">
      <div className="fd-results-list space-y-2.5 pt-1">
        {offers.map((offer) => (
          <ResultCard
            key={offer.id}
            offer={offer}
            selected={selectedOfferId === offer.id}
            passengerCount={passengerCountForRequest(results?.request)}
            onSelect={onSelectOffer}
          />
        ))}
      </div>
    </div>
  )
}

function MigrationMonthGrid({
  months,
  passengerCount,
  selectedOfferId,
  onSelectOffer,
}: {
  months: DisplayMigrationMonth[]
  passengerCount: number
  selectedOfferId?: string
  onSelectOffer: (offer: CanonicalOffer) => void
}) {
  return (
    <div className="fd-scrollbar fd-migration-grid-shell flex-1 overflow-auto p-2.5">
      <div className="fd-migration-grid pt-1">
        {months.map((month) => (
          month.offer ? (
            <ResultCard
              key={month.key}
              offer={month.offer}
              selected={selectedOfferId === month.offer.id}
              passengerCount={passengerCount}
              onSelect={onSelectOffer}
              variant="compact"
              eyebrow={month.label}
            />
          ) : (
            <MigrationEmptyMonthCard key={month.key} month={month} />
          )
        ))}
      </div>
    </div>
  )
}

function MigrationEmptyMonthCard({ month }: { month: DisplayMigrationMonth }) {
  return (
    <article className="fd-migration-month-card" data-testid="migration-month-card">
      <span className="fd-result-card__eyebrow">{month.label}</span>
      <div>
        <p className="fd-migration-month-card__title">
          {month.filtered ? "Sin tarifa con filtros" : "Sin tarifa disponible"}
        </p>
        <p className="fd-migration-month-card__meta">
          {formatDateRange(month.departureStart, month.departureEnd)}
        </p>
      </div>
      <p className="fd-migration-month-card__body">
        {month.filtered
          ? "Ajusta directo, equipaje o aerolínea para volver a incluir este mes."
          : month.warnings?.[0] ?? "No hubo una oferta disponible para este mes."}
      </p>
    </article>
  )
}

function EmptyState({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="grid h-full min-h-[320px] place-items-center p-6 text-center">
      <div>
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-secondary text-muted-foreground">{icon}</div>
        <h3 className="text-base font-bold">{title}</h3>
        <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted-foreground">{body}</p>
      </div>
    </div>
  )
}

export const ResultsPanel = memo(ResultsPanelBase)

type DisplayMigrationMonth = MigrationMonthSummary & {
  filtered?: boolean
}

function uniqueWarnings(messages: string[]) {
  return Array.from(new Set(messages.map((message) => message.trim()).filter(Boolean)))
}

function passengerCountForRequest(request: SearchJobResponse["request"] | undefined) {
  if (!request) return 1
  return Math.max(1, request.adults + request.children + request.infants)
}

function migrationMonthsForDisplay(results: SearchJobResponse, offers: CanonicalOffer[]): DisplayMigrationMonth[] {
  if (!results.migrationMonths?.length) {
    return offers.map((offer) => ({
      key: offer.id,
      label: migrationLabelFromOffer(offer),
      departureStart: offer.departureDate,
      departureEnd: offer.departureDate,
      offer,
      status: "available",
    }))
  }

  const visibleOfferIds = new Set(offers.map((offer) => offer.id))
  return results.migrationMonths.map((month) => {
    if (!month.offer || visibleOfferIds.has(month.offer.id)) {
      return month
    }

    return {
      ...month,
      offer: undefined,
      filtered: true,
    }
  })
}

function migrationLabelFromOffer(offer: CanonicalOffer) {
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

function formatDateRange(start?: string, end?: string) {
  const left = formatShortDate(start)
  const right = formatShortDate(end)
  if (!left && !right) return "Fechas por confirmar"
  if (left && right && left !== right) return `${left} - ${right}`
  return left || right
}

function formatShortDate(value?: string) {
  if (!value) return ""
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return value
  return `${match[3]}/${match[2]}`
}
