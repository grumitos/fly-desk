import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ResultCard } from "@/components/results/ResultCard"
import { AppIcon } from "@/components/ui/app-icon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SegmentButton, SegmentedControl } from "@/components/ui/segmented-control"
import { Skeleton } from "@/components/ui/skeleton"
import type { CanonicalOffer, MigrationMonthSummary, SearchJobResponse, SortMode } from "@/types"

const RUNNING_WARNING_DELAY_MS = 12000
const CACHED_WARNING_DELAY_MS = 18000
const RESULTS_PAGE_SIZE_FALLBACK = 4
const RESULTS_PAGE_SIZE_MAX = 12
const RESULTS_CARD_HEIGHT_ESTIMATE_PX = 126
const RESULTS_CARD_GAP_PX = 10
const RESULTS_LIST_TOP_INSET_PX = 4
const RESULTS_EXTRA_ROW_MIN_BLANK_PX = 28

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
  const isCancelled = results?.searchStatus === "cancelled"
  const routeLabel = results?.request ? `${results.request.origin} -> ${results.request.destination}` : "Sin consulta"
  const warnings = uniqueWarnings([...(results?.warnings ?? []), ...(meta?.warnings ?? [])])
  const noFlightIssues = useMemo(() => providerNoFlightIssues(warnings), [warnings])
  const warningDelayElapsed = useWarningDelayElapsed(results, loading)
  const displayedWarnings = shouldDelayWarnings(results, loading, noFlightIssues.length)
    ? warningDelayElapsed ? warnings : []
    : warnings
  const warningSummary = displayedWarnings.length > 0
    ? warningSummaryLabel(displayedWarnings, noFlightIssues)
    : null
  const isRevalidatingCachedSearch = meta?.searchState === "search_cached"
  const pendingMigrationMonths = results?.migrationMonths?.filter((month) => month.status === "loading" || month.status === "partial").length ?? 0
  const summaryLabel = isMigration
    ? `${results?.migrationMonths?.length ?? 8} meses · ${offers.length} con tarifa${pendingMigrationMonths ? ` · ${pendingMigrationMonths} buscando` : ""}`
    : `${offers.length} oferta${offers.length === 1 ? "" : "s"}`

  return (
    <section className="fd-panel flex h-full min-h-0 min-w-0 flex-col overflow-hidden" aria-busy={loading}>
      <div className="shrink-0 border-b border-border bg-secondary/60 px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-bold">{isMigration ? "Vuelo migratorio" : "Resultados"}</h2>
              {isRevalidatingCachedSearch && <Badge variant="warning">Cache revalidando</Badge>}
              {loading && <Badge variant="warning">Actualizando</Badge>}
              {isCancelled && !loading && <Badge variant="warning">Detenida</Badge>}
              {meta?.partial && !loading && <Badge variant="warning">Parcial</Badge>}
              {warningSummary && (
                <Badge variant="warning" title={displayedWarnings.join("\n")}>
                  {warningSummary}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {routeLabel} · {summaryLabel}
            </p>
          </div>

          {!isMigration && (
            <SegmentedControl aria-label="Orden de resultados">
              <SegmentButton
                active={sort === "best-value"}
                aria-label="Ordenar por mejor valor"
                onClick={() => onSort("best-value")}
              >
                Mejor valor
              </SegmentButton>
              <SegmentButton
                active={sort === "cheapest"}
                aria-label="Ordenar por precio"
                onClick={() => onSort("cheapest")}
              >
                Precio
              </SegmentButton>
              <SegmentButton
                active={sort === "fastest"}
                aria-label="Ordenar por duración"
                onClick={() => onSort("fastest")}
              >
                Duración
              </SegmentButton>
            </SegmentedControl>
          )}
        </div>

      </div>

      {renderBody({
        loading,
        results,
        offers,
        isCancelled,
        noFlightIssues,
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
  noFlightIssues,
  isCancelled,
  selectedOfferId,
  onSelectOffer,
}: {
  loading: boolean
  results: SearchJobResponse | null
  offers: CanonicalOffer[]
  isCancelled: boolean
  noFlightIssues: ProviderNoFlightIssue[]
  selectedOfferId?: string
  onSelectOffer: (offer: CanonicalOffer) => void
}) {
  if (!results && !loading) {
    return (
      <EmptyState
        icon={<AppIcon name="flight" />}
        title="Busca vuelos para comparar"
        body="Ingresa origen, destino y fechas. La lista priorizará precio, duración, escalas, equipaje y proveedor."
      />
    )
  }

  if (isCancelled && offers.length === 0) {
    return (
      <EmptyState
        icon={<AppIcon name="x" />}
        title="Búsqueda detenida"
        body="Ajusta origen, destino, fechas o pasajeros y vuelve a buscar cuando esté listo."
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

  if (loading && offers.length === 0) {
    return (
      <div className="flex-1 space-y-2.5 overflow-hidden p-3">
        {Array.from({ length: RESULTS_PAGE_SIZE_FALLBACK }).map((_, index) => (
          <Skeleton key={index} className="h-[104px] w-full" />
        ))}
      </div>
    )
  }

  if (!loading && results && offers.length === 0) {
    const emptyModel = emptySearchModel(noFlightIssues)

    return (
      <EmptyState
        icon={<AppIcon name="bestValue" />}
        title={emptyModel.title}
        body={emptyModel.body}
      />
    )
  }

  return (
    <PaginatedResultsList
      offers={offers}
      passengerCount={passengerCountForRequest(results?.request)}
      selectedOfferId={selectedOfferId}
      onSelectOffer={onSelectOffer}
    />
  )
}

function PaginatedResultsList({
  offers,
  passengerCount,
  selectedOfferId,
  onSelectOffer,
}: {
  offers: CanonicalOffer[]
  passengerCount: number
  selectedOfferId?: string
  onSelectOffer: (offer: CanonicalOffer) => void
}) {
  const { pageSize, viewportRef } = useAdaptiveResultsPageSize(offers.length)
  const pageKey = useMemo(() => offerPaginationKey(offers), [offers])
  const [pageState, setPageState] = useState({ key: "", index: 0 })
  const pageCount = Math.max(1, Math.ceil(offers.length / pageSize))
  const selectedPageIndex = useMemo(() => {
    if (!selectedOfferId) return

    const selectedIndex = offers.findIndex((offer) => offer.id === selectedOfferId)
    if (selectedIndex < 0) return

    return Math.floor(selectedIndex / pageSize)
  }, [offers, pageSize, selectedOfferId])

  const requestedPageIndex = pageState.key === pageKey
    ? pageState.index
    : selectedPageIndex ?? 0
  const safePageIndex = Math.max(0, Math.min(requestedPageIndex, pageCount - 1))
  const startIndex = safePageIndex * pageSize
  const pageOffers = offers.slice(startIndex, startIndex + pageSize)
  const endIndex = startIndex + pageOffers.length
  const handlePageChange = (nextPageIndex: number) => {
    setPageState({
      key: pageKey,
      index: Math.max(0, Math.min(nextPageIndex, pageCount - 1)),
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-2.5" data-testid="results-page-shell">
      <div ref={viewportRef} className="fd-scrollbar-hidden min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain" data-testid="results-page-body">
        <div className="fd-results-list grid content-start gap-2.5 pt-1">
          {pageOffers.map((offer) => (
            <ResultCard
              key={offer.id}
              offer={offer}
              selected={selectedOfferId === offer.id}
              passengerCount={passengerCount}
              onSelect={onSelectOffer}
            />
          ))}
        </div>
      </div>

      {pageCount > 1 && (
        <ResultsPagination
          endIndex={endIndex}
          pageCount={pageCount}
          pageIndex={safePageIndex}
          startIndex={startIndex}
          totalCount={offers.length}
          onPageChange={handlePageChange}
        />
      )}
    </div>
  )
}

function ResultsPagination({
  endIndex,
  pageCount,
  pageIndex,
  startIndex,
  totalCount,
  onPageChange,
}: {
  endIndex: number
  pageCount: number
  pageIndex: number
  startIndex: number
  totalCount: number
  onPageChange: (pageIndex: number) => void
}) {
  const firstDisabled = pageIndex <= 0
  const lastDisabled = pageIndex >= pageCount - 1

  return (
    <nav
      aria-label="Paginación de resultados"
      className="mt-2 flex shrink-0 items-center justify-between gap-2 border-t border-border/80 px-1 pb-0.5 pt-2"
      data-testid="results-pagination"
    >
      <p className="min-w-[6.25rem] pl-1 text-xs font-semibold text-muted-foreground">
        {startIndex + 1}-{endIndex} de {totalCount}
      </p>
      <div className="flex min-w-0 items-center justify-end gap-1">
        <Button
          aria-label="Primera página"
          className="h-7 w-7 rounded-md"
          disabled={firstDisabled}
          size="icon"
          type="button"
          variant="ghost"
          onClick={() => onPageChange(0)}
        >
          <AppIcon name="chevronsLeft" className="h-3.5 w-3.5" />
        </Button>
        <Button
          aria-label="Página anterior"
          className="h-7 w-7 rounded-md"
          disabled={firstDisabled}
          size="icon"
          type="button"
          variant="ghost"
          onClick={() => onPageChange(pageIndex - 1)}
        >
          <AppIcon name="chevronLeft" className="h-3.5 w-3.5" />
        </Button>

        {paginationItems(pageIndex, pageCount).map((item) => (
          typeof item === "number" ? (
            <Button
              key={item}
              aria-current={item === pageIndex ? "page" : undefined}
              aria-label={`Página ${item + 1}`}
              className="h-7 min-w-7 rounded-md px-2 text-xs"
              size="sm"
              type="button"
              variant={item === pageIndex ? "secondary" : "ghost"}
              onClick={() => onPageChange(item)}
            >
              {item + 1}
            </Button>
          ) : (
            <span
              key={item}
              aria-hidden="true"
              className="grid h-7 min-w-5 place-items-center text-xs font-bold text-muted-foreground"
            >
              ...
            </span>
          )
        ))}

        <Button
          aria-label="Página siguiente"
          className="h-7 w-7 rounded-md"
          disabled={lastDisabled}
          size="icon"
          type="button"
          variant="ghost"
          onClick={() => onPageChange(pageIndex + 1)}
        >
          <AppIcon name="chevronRight" className="h-3.5 w-3.5" />
        </Button>
        <Button
          aria-label="Última página"
          className="h-7 w-7 rounded-md"
          disabled={lastDisabled}
          size="icon"
          type="button"
          variant="ghost"
          onClick={() => onPageChange(pageCount - 1)}
        >
          <AppIcon name="chevronsRight" className="h-3.5 w-3.5" />
        </Button>
      </div>
    </nav>
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
            <div key={month.key} className="relative min-w-0">
              <ResultCard
                offer={month.offer}
                selected={selectedOfferId === month.offer.id}
                passengerCount={passengerCount}
                onSelect={onSelectOffer}
                variant="compact"
                eyebrow={month.label}
              />
              {month.status === "partial" && (
                <span className="fd-migration-month-card__status">Actualizando</span>
              )}
            </div>
          ) : (
            <MigrationEmptyMonthCard key={month.key} month={month} />
          )
        ))}
      </div>
    </div>
  )
}

function MigrationEmptyMonthCard({ month }: { month: DisplayMigrationMonth }) {
  const loading = month.status === "loading"
  const error = month.status === "error"

  return (
    <article
      className={`fd-migration-month-card${loading ? " fd-migration-month-card--loading" : ""}${error ? " fd-migration-month-card--error" : ""}`}
      data-testid="migration-month-card"
    >
      <span className="fd-result-card__eyebrow">{month.label}</span>
      <div>
        <p className="fd-migration-month-card__title">
          {loading
            ? "Buscando..."
            : month.filtered ? "Sin tarifa con filtros" : "Sin tarifa disponible"}
        </p>
        <p className="fd-migration-month-card__meta">
          {formatDateRange(month.departureStart, month.departureEnd)}
        </p>
      </div>
      <p className="fd-migration-month-card__body">
        {loading
          ? "Consultando el precio más bajo disponible para este mes."
          : month.filtered
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

function useWarningDelayElapsed(results: SearchJobResponse | null, loading: boolean) {
  const [elapsedKey, setElapsedKey] = useState<string | null>(null)
  const jobId = results?.searchJobId
  const searchState = results?.searchMeta?.searchState
  const delayMs = searchState === "search_cached" ? CACHED_WARNING_DELAY_MS : RUNNING_WARNING_DELAY_MS
  const delayKey = jobId && loading && !results?.searchComplete
    ? `${jobId}:${searchState ?? "unknown"}`
    : null

  useEffect(() => {
    if (!delayKey) return

    const timer = window.setTimeout(() => setElapsedKey(delayKey), delayMs)
    return () => window.clearTimeout(timer)
  }, [delayKey, delayMs])

  return !delayKey || elapsedKey === delayKey
}

function shouldDelayWarnings(
  results: SearchJobResponse | null,
  loading: boolean,
  noFlightIssueCount: number,
) {
  if (!results || !loading || results.searchComplete) return false
  if (noFlightIssueCount > 0 && results.offers.length === 0) return false
  return true
}

type ProviderNoFlightIssue = {
  provider: "Agil" | "Costamar"
  warning: string
}

function providerNoFlightIssues(warnings: string[]): ProviderNoFlightIssue[] {
  const issues: ProviderNoFlightIssue[] = []
  const seen = new Set<string>()

  for (const warning of warnings) {
    const normalized = warning.toLowerCase()
    const provider = normalized.includes("agil no devolvió")
      ? "Agil"
      : normalized.includes("costamar no devolvió")
        ? "Costamar"
        : null

    if (!provider || seen.has(provider)) continue
    seen.add(provider)
    issues.push({ provider, warning })
  }

  return issues
}

function emptySearchModel(noFlightIssues: ProviderNoFlightIssue[]) {
  if (noFlightIssues.length > 0) {
    const providers = providerSentence(noFlightIssues.map((issue) => issue.provider))
    return {
      title: noFlightIssues.length === 1
        ? `${providers} no devolvió vuelos`
        : `${providers} no devolvieron vuelos`,
      body: noFlightIssues.length === 1
        ? `${noFlightIssues[0].warning} Ajusta fechas, escalas o equipaje para ampliar la búsqueda.`
        : "Los proveedores consultados informaron que no hay vuelos para esta combinación. Ajusta fechas, escalas o equipaje para ampliar la búsqueda.",
    }
  }

  return {
    title: "Sin resultados para esta consulta",
    body: "Ajusta fechas, escalas, equipaje o aerolíneas para ampliar la cobertura.",
  }
}

function providerSentence(providers: string[]) {
  if (providers.length === 0) return "Los proveedores"
  if (providers.length === 1) return providers[0]
  return `${providers.slice(0, -1).join(", ")} y ${providers[providers.length - 1]}`
}

function warningSummaryLabel(warnings: string[], noFlightIssues: ProviderNoFlightIssue[]) {
  if (noFlightIssues.length > 0) {
    return noFlightIssues.length === 1
      ? `${noFlightIssues[0].provider} sin vuelos`
      : "Agil y Costamar sin vuelos"
  }

  return warnings.length === 1 ? "1 aviso" : `${warnings.length} avisos`
}

function useAdaptiveResultsPageSize(itemCount: number) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [pageSize, setPageSize] = useState(RESULTS_PAGE_SIZE_FALLBACK)
  const rowHeightRef = useRef(RESULTS_CARD_HEIGHT_ESTIMATE_PX)

  useLayoutEffect(() => {
    const node = viewportRef.current
    if (!node || itemCount <= 0) return

    let frame = 0
    const update = () => {
      const list = node.querySelector<HTMLElement>(".fd-results-list")
      const availableHeight = Math.max(0, node.clientHeight - RESULTS_LIST_TOP_INSET_PX)
      const measuredCards = list
        ? Array.from(list.querySelectorAll<HTMLElement>(".fd-result-card"))
        : []
      const listStyle = list ? window.getComputedStyle(list) : null
      const measuredGap = listStyle
        ? Number.parseFloat(listStyle.rowGap || listStyle.gap || `${RESULTS_CARD_GAP_PX}`)
        : RESULTS_CARD_GAP_PX
      const gap = Number.isFinite(measuredGap) ? measuredGap : RESULTS_CARD_GAP_PX
      const measuredCardHeight = measuredCards.reduce((maxHeight, card) => {
        return Math.max(maxHeight, card.getBoundingClientRect().height)
      }, 0)
      if (measuredCardHeight > 0 && Math.abs(measuredCardHeight - rowHeightRef.current) > 1) {
        rowHeightRef.current = measuredCardHeight
      }

      const rowHeight = rowHeightRef.current
      const fullyVisibleRows = Math.max(1, Math.floor((availableHeight + gap) / (rowHeight + gap)))
      const usedHeight = fullyVisibleRows * rowHeight + Math.max(0, fullyVisibleRows - 1) * gap
      const blankHeight = availableHeight - usedHeight
      const shouldAddOverflowRow = blankHeight >= RESULTS_EXTRA_ROW_MIN_BLANK_PX && fullyVisibleRows < itemCount
      const nextPageSize = Math.max(
        1,
        Math.min(itemCount, RESULTS_PAGE_SIZE_MAX, fullyVisibleRows + (shouldAddOverflowRow ? 1 : 0)),
      )

      setPageSize((current) => current === nextPageSize ? current : nextPageSize)
    }
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(update)
    }

    scheduleUpdate()

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", scheduleUpdate)
      return () => {
        window.cancelAnimationFrame(frame)
        window.removeEventListener("resize", scheduleUpdate)
      }
    }

    const observer = new ResizeObserver(scheduleUpdate)
    observer.observe(node)

    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [itemCount])

  return { pageSize, viewportRef }
}

function offerPaginationKey(offers: CanonicalOffer[]) {
  if (offers.length === 0) return "empty"
  if (offers.length <= 6) return offers.map((offer) => offer.id).join("|")

  const middleIndex = Math.floor(offers.length / 2)
  return [
    offers.length,
    offers[0]?.id,
    offers[1]?.id,
    offers[middleIndex]?.id,
    offers[offers.length - 1]?.id,
  ].join("|")
}

type PaginationItem = number | "ellipsis-left" | "ellipsis-right"

function paginationItems(pageIndex: number, pageCount: number): PaginationItem[] {
  if (pageCount <= 5) {
    return Array.from({ length: pageCount }, (_, index) => index)
  }

  if (pageIndex <= 2) {
    return [0, 1, 2, 3, "ellipsis-right", pageCount - 1]
  }

  if (pageIndex >= pageCount - 3) {
    return [0, "ellipsis-left", pageCount - 4, pageCount - 3, pageCount - 2, pageCount - 1]
  }

  return [0, "ellipsis-left", pageIndex - 1, pageIndex, pageIndex + 1, "ellipsis-right", pageCount - 1]
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
