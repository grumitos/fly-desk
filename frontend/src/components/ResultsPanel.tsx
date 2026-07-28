import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import { ResultCard, ResultScheduleTime } from "@/components/results/ResultCard"
import { buildResultCardModel, type ResultCardModel, type ResultJourneySummary } from "@/components/results/result-card-model"
import {
  buildResultListItems,
  paginateResultListItems,
  resultListItemContainsOffer,
  type ResultListItem,
  type ResultOfferGroup,
} from "@/components/results/result-groups"
import { AppIcon } from "@/components/ui/app-icon"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
} from "@/components/ui/pagination"
import { SegmentButton, SegmentedControl } from "@/components/ui/segmented-control"
import { Skeleton } from "@/components/ui/skeleton"
import { getResultsLayout, saveResultsLayout } from "@/lib/api"
import { resultsLayoutEditorEnabledFromUrl, resultsLayoutPersistenceEnabled } from "@/lib/results-layout-editor"
import { cn } from "@/lib/utils"
import type {
  CanonicalOffer,
  MigrationMonthSummary,
  ResultsColumnLayout,
  ResultsLayoutColumnKey,
  SearchJobResponse,
  SortMode,
} from "@/types"

const RUNNING_WARNING_DELAY_MS = 12000
const CACHED_WARNING_DELAY_MS = 18000
const RESULTS_PAGE_SIZE_FALLBACK = 4
const RESULTS_PAGE_SIZE_MAX = 12
const RESULTS_CARD_HEIGHT_ESTIMATE_PX = 126
const RESULTS_CARD_GAP_PX = 10
const RESULTS_LIST_TOP_INSET_PX = 4
const RESULTS_EXTRA_ROW_MIN_BLANK_PX = 28
const RESULTS_LAYOUT_FILE_HINT = "config/results-layout.json"
const RESULTS_LAYOUT_RESIZE_STEP_PX = 8
const RESULTS_COLUMN_DEFINITIONS = [
  { key: "carrier", label: "Aerolínea", defaultWidth: 139 },
  { key: "dates", label: "Fechas", defaultWidth: 371 },
  { key: "duration", label: "Duración", defaultWidth: 205 },
  { key: "stops", label: "Escalas", defaultWidth: 140 },
  { key: "price", label: "Precio", defaultWidth: 130 },
  { key: "links", label: "Proveedor", defaultWidth: 54 },
] as const satisfies ReadonlyArray<{
  key: ResultsLayoutColumnKey
  label: string
  defaultWidth: number
}>
const DEFAULT_RESULTS_COLUMN_LAYOUT = Object.fromEntries(
  RESULTS_COLUMN_DEFINITIONS.map((column) => [column.key, column.defaultWidth]),
) as ResultsColumnLayout
const RESULTS_LAYOUT_TARGET_TOTAL = RESULTS_COLUMN_DEFINITIONS.reduce(
  (sum, column) => sum + column.defaultWidth,
  0,
)

interface ResultsPanelProps {
  results: SearchJobResponse | null
  unfilteredOfferCount: number
  loading: boolean
  sort: SortMode
  onSort: (s: SortMode) => void
  onSelectOffer: (offer: CanonicalOffer) => void
  selectedOfferId?: string
}

type ResultStatusItem = {
  key: string
  label: string
  icon: ReactNode
  title?: string
  tone?: "muted" | "warning"
}

function ResultsPanelBase({
  results,
  unfilteredOfferCount,
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
  const warnings = useMemo(
    () => uniqueWarnings([...(results?.warnings ?? []), ...(meta?.warnings ?? [])]),
    [results?.warnings, meta?.warnings],
  )
  const actionableWarnings = useMemo(() => warnings.filter(isActionableWarning), [warnings])
  const displayableWarnings = useMemo(
    () => loading && !results?.searchComplete
      ? actionableWarnings.filter((warning) => !isGenericOperationFailureWarning(warning))
      : actionableWarnings,
    [actionableWarnings, loading, results?.searchComplete],
  )
  const noFlightIssues = useMemo(() => providerNoFlightIssues(actionableWarnings), [actionableWarnings])
  const filteredEmpty = isFilteredEmptyState(results, offers, unfilteredOfferCount)
  const emphasizedNoFlightIssues = filteredEmpty ? [] : noFlightIssues
  const warningDelayElapsed = useWarningDelayElapsed(results, loading)
  const displayedWarnings = shouldDelayWarnings(results, loading, noFlightIssues.length)
    ? warningDelayElapsed ? displayableWarnings : []
    : displayableWarnings
  const warningSummary = displayedWarnings.length > 0
    ? warningSummaryLabel(displayedWarnings, emphasizedNoFlightIssues)
    : null
  const isRevalidatingCachedSearch = meta?.searchState === "search_cached"
  const hasUsableOffers = offers.length > 0
  const pendingMigrationMonths = results?.migrationMonths?.filter((month) => month.status === "loading" || month.status === "partial").length ?? 0
  const summaryLabel = isMigration
    ? `${results?.migrationMonths?.length ?? 8} meses · ${offers.length} con tarifa${pendingMigrationMonths ? ` · ${pendingMigrationMonths} buscando` : ""}`
    : resultsSummaryLabel(offers.length, loading, Boolean(results))
  const loadingStatusLabel = isMigration && hasUsableOffers
    ? "Parcial"
    : hasUsableOffers ? "Actualizando" : "Buscando"
  const maybeStatusItems: Array<ResultStatusItem | null> = [
    isRevalidatingCachedSearch
      ? { key: "cache", label: "Cache revalidando", icon: <AppIcon name="clock" className="h-3.5 w-3.5" /> }
      : null,
    loading
      ? { key: "loading", label: loadingStatusLabel, icon: <AppIcon name="loading" spin className="h-3.5 w-3.5" /> }
      : null,
    isCancelled && !loading
      ? { key: "cancelled", label: "Detenida", icon: <AppIcon name="x" className="h-3.5 w-3.5" /> }
      : null,
    meta?.partial && !loading
      ? { key: "partial", label: "Parcial", icon: <AppIcon name="clock" className="h-3.5 w-3.5" /> }
      : null,
    warningSummary
      ? {
        key: "warnings",
        label: warningSummary,
        icon: <AppIcon name="alert" className="h-3.5 w-3.5" />,
        title: displayedWarnings.join("\n"),
        tone: "warning",
      }
      : null,
  ]
  const statusItems = maybeStatusItems.filter((item): item is ResultStatusItem => Boolean(item))
  const layoutPersistenceEnabled = useMemo(() => resultsLayoutPersistenceEnabled(), [])
  const layoutEditor = useResultsLayoutEditor()
  const savedResultsLayout = useSavedResultsLayout(!layoutEditor.enabled && layoutPersistenceEnabled)
  const activeResultsLayout = layoutEditor.enabled
    ? layoutEditor.initialized ? layoutEditor.columns : null
    : savedResultsLayout.columns ?? DEFAULT_RESULTS_COLUMN_LAYOUT
  const resultsLayoutLoading = layoutEditor.enabled ? layoutEditor.loading : savedResultsLayout.loading

  return (
    <section className="fd-panel flex h-full min-h-0 min-w-0 flex-col overflow-hidden" aria-busy={loading}>
      <div className="fd-panel-header">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div>
              <h2 className="fd-panel-title">{isMigration ? "Vuelo migratorio" : "Resultados"}</h2>
            </div>
            <ResultMetaLine summary={summaryLabel} items={statusItems} />
          </div>

          {!isMigration && (
            <SegmentedControl
              aria-label="Orden de resultados"
              value={sort}
              onValueChange={(value) => {
                if (value === "cheapest" || value === "fastest") onSort(value)
              }}
            >
              <SegmentButton
                value="cheapest"
                aria-label="Ordenar por precio"
              >
                Precio
              </SegmentButton>
              <SegmentButton
                value="fastest"
                aria-label="Ordenar por duración"
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
        noFlightIssues: emphasizedNoFlightIssues,
        filteredEmpty,
        selectedOfferId,
        onSelectOffer,
        layoutEditorEnabled: layoutEditor.enabled,
        layoutEditorReady: layoutEditor.initialized,
        layoutEditorSaving: layoutEditor.saving,
        layoutEditorError: layoutEditor.error,
        layoutEditorLoading: layoutEditor.loading,
        layoutEditorSavedAt: layoutEditor.savedAt,
        layoutColumns: layoutEditor.columns,
        onLayoutBoundaryResize: layoutEditor.resizeColumnBoundary,
        onLayoutColumnsMeasured: layoutEditor.initializeFromMeasuredColumns,
        onLayoutReset: layoutEditor.reset,
        onLayoutSave: layoutEditor.save,
        resultsLayout: activeResultsLayout,
        resultsLayoutLoading,
        cached: isRevalidatingCachedSearch,
      })}
    </section>
  )
}

function ResultMetaLine({ summary, items }: { summary: string; items: ResultStatusItem[] }) {
  if (!summary && items.length === 0) return null

  const warningItems = items.filter((item) => item.key === "warnings")
  const statusItems = items.filter((item) => item.key !== "warnings")

  return (
    <div
      aria-live="polite"
      className="fd-panel-subtitle mt-0.5 flex min-w-0 max-w-full items-center gap-2 overflow-hidden"
    >
      {statusItems.map((item, index) => (
        <span
          key={item.key}
          title={item.title}
          className={cn(
            "inline-flex min-w-0 items-center gap-1",
            index > 0 && "before:text-muted-foreground before:content-['·']",
            item.tone === "warning" && "text-warning-soft-foreground",
          )}
        >
          {item.icon}
          <span className="truncate">{item.label}</span>
        </span>
      ))}
      {summary && (
        <span className={cn("shrink-0", statusItems.length > 0 && "before:mr-2 before:text-muted-foreground before:content-['·']")}>
          {summary}
        </span>
      )}
      {warningItems.map((item) => (
        <span
          key={item.key}
          title={item.title}
          className={cn(
            "inline-flex min-w-0 items-center gap-1",
            (summary || statusItems.length > 0) && "before:text-muted-foreground before:content-['·']",
            item.tone === "warning" && "text-warning-soft-foreground",
          )}
        >
          {item.icon}
          <span className="truncate">{item.label}</span>
        </span>
      ))}
    </div>
  )
}

function renderBody({
  loading,
  results,
  offers,
  noFlightIssues,
  filteredEmpty,
  isCancelled,
  selectedOfferId,
  onSelectOffer,
  layoutEditorEnabled,
  layoutEditorReady,
  layoutEditorSaving,
  layoutEditorError,
  layoutEditorLoading,
  layoutEditorSavedAt,
  layoutColumns,
  onLayoutBoundaryResize,
  onLayoutColumnsMeasured,
  onLayoutReset,
  onLayoutSave,
  resultsLayout,
  resultsLayoutLoading,
  cached,
}: {
  loading: boolean
  results: SearchJobResponse | null
  offers: CanonicalOffer[]
  isCancelled: boolean
  noFlightIssues: ProviderNoFlightIssue[]
  filteredEmpty: boolean
  selectedOfferId?: string
  onSelectOffer: (offer: CanonicalOffer) => void
  layoutEditorEnabled: boolean
  layoutEditorReady: boolean
  layoutEditorSaving: boolean
  layoutEditorError: string
  layoutEditorLoading: boolean
  layoutEditorSavedAt: string
  layoutColumns: ResultsColumnLayout
  onLayoutBoundaryResize: (leftKey: ResultsLayoutColumnKey, rightKey: ResultsLayoutColumnKey, delta: number) => void
  onLayoutColumnsMeasured: (columns: ResultsColumnLayout) => void
  onLayoutReset: () => void
  onLayoutSave: () => void
  resultsLayout: ResultsColumnLayout | null
  resultsLayoutLoading: boolean
  cached: boolean
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

  if (resultsLayoutLoading && offers.length > 0) {
    return <ResultsLoadingSkeleton rows={Math.max(offers.length, RESULTS_PAGE_SIZE_FALLBACK)} />
  }

  if (loading && offers.length === 0) {
    return <ResultsLoadingSkeleton />
  }

  if (!loading && results && offers.length === 0) {
    const emptyModel = emptySearchModel(noFlightIssues, filteredEmpty)

    return (
      <EmptyState
        icon={<AppIcon name="sort" />}
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
      layoutEditorEnabled={layoutEditorEnabled}
      layoutEditorReady={layoutEditorReady}
      layoutEditorSaving={layoutEditorSaving}
      layoutEditorError={layoutEditorError}
      layoutEditorLoading={layoutEditorLoading}
      layoutEditorSavedAt={layoutEditorSavedAt}
      layoutColumns={layoutColumns}
      onLayoutBoundaryResize={onLayoutBoundaryResize}
      onLayoutColumnsMeasured={onLayoutColumnsMeasured}
      onLayoutReset={onLayoutReset}
      onLayoutSave={onLayoutSave}
      resultsLayout={resultsLayout}
      cached={cached}
    />
  )
}

function ResultsLoadingSkeleton({ rows = RESULTS_PAGE_SIZE_MAX }: { rows?: number }) {
  const rowCount = Math.max(1, Math.min(rows, RESULTS_PAGE_SIZE_MAX))

  return (
    <div className="min-h-0 flex-1 overflow-hidden p-3" aria-hidden="true" data-testid="results-loading-skeleton">
      <div className="grid h-full auto-rows-[104px] gap-2.5 overflow-hidden">
        {Array.from({ length: rowCount }).map((_, index) => (
          <Skeleton key={index} className="h-full w-full" />
        ))}
      </div>
    </div>
  )
}

function PaginatedResultsList({
  offers,
  passengerCount,
  selectedOfferId,
  onSelectOffer,
  layoutEditorEnabled,
  layoutEditorReady,
  layoutEditorSaving,
  layoutEditorError,
  layoutEditorLoading,
  layoutEditorSavedAt,
  layoutColumns,
  onLayoutBoundaryResize,
  onLayoutColumnsMeasured,
  onLayoutReset,
  onLayoutSave,
  resultsLayout,
  cached,
}: {
  offers: CanonicalOffer[]
  passengerCount: number
  selectedOfferId?: string
  onSelectOffer: (offer: CanonicalOffer) => void
  layoutEditorEnabled: boolean
  layoutEditorReady: boolean
  layoutEditorSaving: boolean
  layoutEditorError: string
  layoutEditorLoading: boolean
  layoutEditorSavedAt: string
  layoutColumns: ResultsColumnLayout
  onLayoutBoundaryResize: (leftKey: ResultsLayoutColumnKey, rightKey: ResultsLayoutColumnKey, delta: number) => void
  onLayoutColumnsMeasured: (columns: ResultsColumnLayout) => void
  onLayoutReset: () => void
  onLayoutSave: () => void
  resultsLayout: ResultsColumnLayout | null
  cached: boolean
}) {
  const resultItems = useMemo(() => buildResultListItems(offers), [offers])
  const layoutGuideVisible = layoutEditorEnabled && layoutEditorReady
  const { pageCapacity, viewportRef } = useAdaptiveResultsPageCapacity(
    resultItems.length + (layoutGuideVisible ? 1 : 0),
  )
  const resultPageCapacity = Math.max(1, pageCapacity - (layoutGuideVisible ? 1 : 0))
  const listRef = useRef<HTMLDivElement | null>(null)
  const layoutStyle = useMemo(() => (
    resultsLayout ? resultsLayoutStyleVars(resultsLayout) : undefined
  ), [resultsLayout])
  const pageKey = useMemo(() => resultItemsPaginationKey(resultItems), [resultItems])
  const [pageState, setPageState] = useState({ key: "", index: 0 })
  const pages = useMemo(
    () => paginateResultListItems(resultItems, resultPageCapacity),
    [resultItems, resultPageCapacity],
  )
  const pageCount = Math.max(1, pages.length)
  const selectedPageIndex = useMemo(() => {
    if (!selectedOfferId) return

    const selectedIndex = resultItems.findIndex((item) => resultListItemContainsOffer(item, selectedOfferId))
    if (selectedIndex < 0) return

    return pages.findIndex((page) => page.items.some((item) => resultListItemContainsOffer(item, selectedOfferId)))
  }, [pages, resultItems, selectedOfferId])

  const requestedPageIndex = pageState.key === pageKey
    ? pageState.index
    : selectedPageIndex ?? 0
  const safePageIndex = Math.max(0, Math.min(requestedPageIndex, pageCount - 1))
  const currentPage = pages[safePageIndex] ?? pages[0] ?? {
    items: [],
    startOfferIndex: 0,
    endOfferIndex: 0,
    displayWeight: 0,
  }
  const pageItems = currentPage.items
  const offersBeforePage = currentPage.startOfferIndex
  const endIndex = currentPage.endOfferIndex
  const handlePageChange = (nextPageIndex: number) => {
    setPageState({
      key: pageKey,
      index: Math.max(0, Math.min(nextPageIndex, pageCount - 1)),
    })
  }

  useLayoutEffect(() => {
    if (!layoutEditorEnabled || resultsLayout || pageItems.length === 0) return

    const measured = measureCurrentResultCardColumns(listRef.current)
    if (measured) {
      onLayoutColumnsMeasured(measured)
    }
  }, [layoutEditorEnabled, onLayoutColumnsMeasured, pageItems.length, resultsLayout])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-2.5" data-testid="results-page-shell">
      <div
        ref={viewportRef}
        className={cn(
          "fd-scrollbar-hidden min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain",
        )}
        data-testid="results-page-body"
      >
        <div
          ref={listRef}
          className={cn(
            "fd-results-list grid content-start gap-2.5 pt-1",
            resultsLayout && "fd-results-list--fixed-layout",
            cached && "fd-results-list--cached",
          )}
          style={layoutStyle}
        >
          {layoutGuideVisible && (
            <ResultsLayoutGuideCard
              columns={layoutColumns}
              error={layoutEditorError}
              loading={layoutEditorLoading}
              ready={layoutEditorReady}
              savedAt={layoutEditorSavedAt}
              saving={layoutEditorSaving}
              onBoundaryResize={onLayoutBoundaryResize}
              onReset={onLayoutReset}
              onSave={onLayoutSave}
            />
          )}
          {pageItems.map((item) => (
            item.type === "group" ? (
              <ResultOfferGroupCard
                key={item.id}
                group={item.group}
                selectedOfferId={selectedOfferId}
                passengerCount={passengerCount}
                onSelectOffer={onSelectOffer}
              />
            ) : (
              <ResultCard
                key={item.id}
                offer={item.offer}
                selected={selectedOfferId === item.offer.id}
                passengerCount={passengerCount}
                onSelect={onSelectOffer}
              />
            )
          ))}
        </div>
      </div>

      {pageCount > 1 && (
        <ResultsPagination
          endIndex={endIndex}
          pageCount={pageCount}
          pageIndex={safePageIndex}
          startIndex={offersBeforePage}
          totalCount={offers.length}
          onPageChange={handlePageChange}
        />
      )}
    </div>
  )
}

function ResultOfferGroupCard({
  group,
  selectedOfferId,
  passengerCount,
  onSelectOffer,
}: {
  group: ResultOfferGroup
  selectedOfferId?: string
  passengerCount: number
  onSelectOffer: (offer: CanonicalOffer) => void
}) {
  const primaryOffer = group.offers[0]
  const variantOffers = group.offers.slice(1)
  const primaryModel = primaryOffer ? buildResultCardModel(primaryOffer, passengerCount) : null
  const visibleVariantOffers = primaryModel
    ? variantOffers.filter((offer) => hasVisibleVariantDifference(primaryModel, buildResultCardModel(offer, passengerCount)))
    : []
  const groupSelected = group.offers.some((offer) => offer.id === selectedOfferId)

  if (!primaryOffer || !primaryModel) return null

  if (visibleVariantOffers.length === 0) {
    return (
      <ResultCard
        offer={primaryOffer}
        selected={selectedOfferId === primaryOffer.id}
        passengerCount={passengerCount}
        onSelect={onSelectOffer}
      />
    )
  }

  return (
    <section
      className={cn("fd-result-group", groupSelected && "is-selected")}
      aria-label={`${group.providerLabel}: ${resultGroupTitle(visibleVariantOffers.length + 1)}`}
      data-testid="result-offer-group"
    >
      <div className="fd-result-group__header">
        <span className="fd-result-group__title">{resultGroupTitle(visibleVariantOffers.length + 1)}</span>
        <span className="fd-result-group__meta">{group.providerLabel}</span>
      </div>
      <div className="fd-result-group__stack">
        <ResultCard
          offer={primaryOffer}
          selected={selectedOfferId === primaryOffer.id}
          passengerCount={passengerCount}
          onSelect={onSelectOffer}
        />
        <div className="fd-result-group__variants" aria-label="Horarios alternativos">
          {visibleVariantOffers.map((offer) => (
            <ResultVariantCard
              key={offer.id}
              offer={offer}
              primaryModel={primaryModel}
              selected={selectedOfferId === offer.id}
              passengerCount={passengerCount}
              onSelect={onSelectOffer}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

function ResultVariantCard({
  offer,
  primaryModel,
  selected,
  passengerCount,
  onSelect,
}: {
  offer: CanonicalOffer
  primaryModel: ResultCardModel
  selected: boolean
  passengerCount: number
  onSelect: (offer: CanonicalOffer) => void
}) {
  const model = buildResultCardModel(offer, passengerCount)
  const scheduleCells = variantScheduleCells(primaryModel, model)
  const durationChanged = model.duration !== primaryModel.duration
  const stopsChanged = variantStopsSignature(model) !== variantStopsSignature(primaryModel)
  const label = [
    selected ? "Horario seleccionado" : "Seleccionar horario",
    ...scheduleCells
      .filter((cell) => cell.changed)
      .map((cell) => `${cell.journey.label} ${journeyScheduleValue(cell.journey)}`),
    durationChanged ? `Duracion ${model.duration}` : undefined,
    stopsChanged ? `Escalas ${model.stops.label}` : undefined,
  ]
    .filter(Boolean)
    .join(" - ")

  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={selected}
      className={cn("fd-result-variant-card", selected && "is-selected")}
      data-testid="result-variant-card"
      onClick={() => onSelect(offer)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onSelect(offer)
        }
      }}
    >
      <span className="fd-result-variant-card__empty" aria-hidden="true" />
      <span className="fd-result-variant-card__empty" aria-hidden="true" />
      <div className="fd-result-variant-card__schedules" data-trip-type={model.tripType}>
        {scheduleCells.map((cell) => (
          <VariantSchedule key={cell.journey.label} summary={cell.journey} visible={cell.changed} />
        ))}
      </div>
      <span className="fd-result-variant-card__empty" aria-hidden="true" />
      <div className="fd-result-variant-card__journey">
        {durationChanged && (
          <span className="fd-result-card__journey-main">{model.duration}</span>
        )}
        {stopsChanged && (
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
        )}
        {stopsChanged && model.stops.layoverLabel && <span className="fd-result-card__layover">{model.stops.layoverLabel}</span>}
      </div>
      <span className="fd-result-variant-card__empty" aria-hidden="true" />
      <span className="fd-result-variant-card__empty" aria-hidden="true" />
    </article>
  )
}

function resultGroupTitle(count: number) {
  return count === 1
    ? "1 horario"
    : `${count} horarios`
}

function hasVisibleVariantDifference(primary: ResultCardModel, variant: ResultCardModel): boolean {
  return variantScheduleCells(primary, variant).some((cell) => cell.changed)
    || variant.duration !== primary.duration
    || variantStopsSignature(variant) !== variantStopsSignature(primary)
}

function variantScheduleCells(primary: ResultCardModel, variant: ResultCardModel) {
  const primaryJourneys = new Map(primary.journeys.map((journey) => [journey.label, journey]))
  return variant.journeys.map((journey) => {
    const primaryJourney = primaryJourneys.get(journey.label)
    return {
      journey,
      changed: !primaryJourney || journeyScheduleSignature(primaryJourney) !== journeyScheduleSignature(journey),
    }
  })
}

function journeyScheduleSignature(journey: ResultJourneySummary) {
  return [
    journey.hasKnownSchedule,
    journey.departureTime,
    journey.arrivalTime,
    journey.arrivalDayOffset,
  ].join("|")
}

function journeyScheduleValue(journey: ResultJourneySummary) {
  if (!journey.hasKnownSchedule) return "por confirmar"

  const offset = journey.arrivalDayOffset > 0 ? `+${journey.arrivalDayOffset}` : ""
  return `${journey.departureTime} - ${journey.arrivalTime}${offset}`
}

function variantStopsSignature(model: ResultCardModel) {
  return [model.stops.label, model.stops.layoverLabel].join("|")
}

function VariantSchedule({ summary, visible }: { summary: ResultJourneySummary; visible: boolean }) {
  return (
    <div className={cn("fd-result-variant-card__schedule", !visible && "is-empty")} aria-hidden={!visible}>
      {visible && <ResultScheduleTime summary={summary} />}
    </div>
  )
}

function ResultsLayoutGuideCard({
  columns,
  error,
  loading,
  ready,
  savedAt,
  saving,
  onBoundaryResize,
  onReset,
  onSave,
}: {
  columns: ResultsColumnLayout
  error: string
  loading: boolean
  ready: boolean
  savedAt: string
  saving: boolean
  onBoundaryResize: (leftKey: ResultsLayoutColumnKey, rightKey: ResultsLayoutColumnKey, delta: number) => void
  onReset: () => void
  onSave: () => void
}) {
  const dragRef = useRef<{
    leftKey: ResultsLayoutColumnKey
    lastX: number
    pointerId: number
  } | null>(null)

  const handleResizePointerDown = useCallback((
    event: ReactPointerEvent<HTMLButtonElement>,
    leftKey: ResultsLayoutColumnKey,
  ) => {
    if (saving) return

    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      leftKey,
      lastX: event.clientX,
      pointerId: event.pointerId,
    }
  }, [saving])

  const handleResizePointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return

    const rightKey = nextResultsLayoutColumnKey(drag.leftKey)
    if (!rightKey) return

    event.preventDefault()
    onBoundaryResize(drag.leftKey, rightKey, event.clientX - drag.lastX)
    drag.lastX = event.clientX
  }, [onBoundaryResize])

  const handleResizePointerEnd = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    dragRef.current = null
  }, [])

  const handleResizeKeyDown = useCallback((
    event: ReactKeyboardEvent<HTMLButtonElement>,
    leftKey: ResultsLayoutColumnKey,
  ) => {
    if (saving) return
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return

    const rightKey = nextResultsLayoutColumnKey(leftKey)
    if (!rightKey) return

    event.preventDefault()
    onBoundaryResize(
      leftKey,
      rightKey,
      event.key === "ArrowRight" ? RESULTS_LAYOUT_RESIZE_STEP_PX : -RESULTS_LAYOUT_RESIZE_STEP_PX,
    )
  }, [onBoundaryResize, saving])

  return (
    <article
      className="fd-result-card fd-result-card--layout-guide"
      aria-label="Tarjeta guia para ajustar columnas"
      data-testid="results-layout-guide"
      style={resultsLayoutStyleVars(columns)}
    >
      <div className="fd-results-layout-guide__header">
        <div className="min-w-0">
          <h3 className="fd-results-layout-editor__title">Columnas</h3>
          <p className="fd-results-layout-editor__status">
            {resultsLayoutStatus({ error, loading, ready, savedAt, saving })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            aria-label="Restaurar anchos"
            className="h-8 rounded-md"
            disabled={!ready || saving}
            size="sm"
            type="button"
            variant="secondary"
            onClick={onReset}
          >
            Restaurar
          </Button>
          <Button
            aria-label="Guardar layout"
            className="h-8 rounded-md"
            disabled={!ready || loading || saving}
            size="sm"
            type="button"
            onClick={onSave}
          >
            {saving && <AppIcon name="loading" className="h-3.5 w-3.5 animate-spin" />}
            Guardar
          </Button>
        </div>
      </div>
      <div className="fd-results-layout-column-spacer" aria-hidden="true" />
      {RESULTS_COLUMN_DEFINITIONS.map((column, index) => {
        const nextColumn = RESULTS_COLUMN_DEFINITIONS[index + 1]

        return (
          <div
            key={column.key}
            className="fd-results-layout-column"
            data-column={column.key}
          >
            <div className="fd-results-layout-column__header">
              <span>{column.label}</span>
              <span>{resultsLayoutColumnShareLabel(columns, column.key)}</span>
            </div>
            <div className="fd-results-layout-column__skeleton" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            {nextColumn && (
              <button
                aria-label={`Mover separador entre ${column.label} y ${nextColumn.label}`}
                aria-orientation="vertical"
                aria-valuenow={Math.round(columns[column.key])}
                className="fd-results-layout-column__handle"
                disabled={saving}
                role="separator"
                type="button"
                onKeyDown={(event) => handleResizeKeyDown(event, column.key)}
                onPointerCancel={handleResizePointerEnd}
                onPointerDown={(event) => handleResizePointerDown(event, column.key)}
                onPointerMove={handleResizePointerMove}
                onPointerUp={handleResizePointerEnd}
              />
            )}
          </div>
        )
      })}
    </article>
  )
}

function useResultsLayoutEditor() {
  const enabled = useMemo(() => resultsLayoutEditorEnabledFromUrl(), [])
  const [columns, setColumns] = useState<ResultsColumnLayout>(DEFAULT_RESULTS_COLUMN_LAYOUT)
  const [baselineColumns, setBaselineColumns] = useState<ResultsColumnLayout>(DEFAULT_RESULTS_COLUMN_LAYOUT)
  const [initialized, setInitialized] = useState(false)
  const [savedAt, setSavedAt] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(enabled)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!enabled) return

    const controller = new AbortController()

    void getResultsLayout({ signal: controller.signal })
      .then((layout) => {
        if (controller.signal.aborted) return

        const nextColumns = normalizeResultsLayoutColumns(layout?.columns ?? DEFAULT_RESULTS_COLUMN_LAYOUT)
        setBaselineColumns(nextColumns)
        setColumns(nextColumns)
        setInitialized(true)
        setSavedAt(layout?.savedAt ?? "")
        setError("")
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return

        setBaselineColumns(DEFAULT_RESULTS_COLUMN_LAYOUT)
        setColumns(DEFAULT_RESULTS_COLUMN_LAYOUT)
        setInitialized(true)
        setSavedAt("")
        setError(errorMessage(caught))
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false)
        }
      })

    return () => controller.abort()
  }, [enabled])

  const initializeFromMeasuredColumns = useCallback((measuredColumns: ResultsColumnLayout) => {
    if (!enabled || initialized) return

    const nextColumns = normalizeResultsLayoutColumns(measuredColumns)
    setBaselineColumns(nextColumns)
    setColumns(nextColumns)
    setInitialized(true)
    setSavedAt("")
    setError("")
  }, [enabled, initialized])

  const resizeColumnBoundary = useCallback((
    leftKey: ResultsLayoutColumnKey,
    rightKey: ResultsLayoutColumnKey,
    delta: number,
  ) => {
    setColumns((current) => {
      const leftStart = current[leftKey]
      const rightStart = current[rightKey]
      const boundedDelta = clamp(
        Math.round(delta),
        -leftStart,
        rightStart,
      )

      if (boundedDelta === 0) return current

      return {
        ...current,
        [leftKey]: leftStart + boundedDelta,
        [rightKey]: rightStart - boundedDelta,
      }
    })
    setInitialized(true)
    setSavedAt("")
    setError("")
  }, [])

  const reset = useCallback(() => {
    setColumns(baselineColumns)
    setInitialized(true)
    setSavedAt("")
    setError("")
  }, [baselineColumns])

  const save = useCallback(() => {
    if (saving) return

    const savedColumns = normalizeResultsLayoutColumns(columns)
    setSaving(true)
    setError("")
    void saveResultsLayout(savedColumns)
      .then((layout) => {
        setColumns(savedColumns)
        setBaselineColumns(savedColumns)
        setSavedAt(layout.savedAt)
      })
      .catch((caught: unknown) => setError(errorMessage(caught)))
      .finally(() => setSaving(false))
  }, [columns, saving])

  return {
    enabled,
    columns,
    error,
    initialized,
    initializeFromMeasuredColumns,
    loading,
    savedAt,
    saving,
    reset,
    save,
    resizeColumnBoundary,
  }
}

function useSavedResultsLayout(enabled: boolean) {
  const [columns, setColumns] = useState<ResultsColumnLayout | null>(null)
  const [loading, setLoading] = useState(enabled)

  useEffect(() => {
    if (!enabled) {
      return
    }

    const controller = new AbortController()

    void getResultsLayout({ signal: controller.signal })
      .then((layout) => {
        if (controller.signal.aborted) return

        setColumns(layout?.columns ? normalizeResultsLayoutColumns(layout.columns) : null)
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return

        console.warn("No se pudo cargar el layout de resultados.", caught)
        setColumns(null)
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false)
        }
      })

    return () => controller.abort()
  }, [enabled])

  return { columns, loading }
}

function normalizeResultsLayoutColumn(
  definition: (typeof RESULTS_COLUMN_DEFINITIONS)[number],
  value: number,
) {
  const numeric = Number.isFinite(value) ? value : definition.defaultWidth
  return Math.max(0, Math.round(numeric))
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function nextResultsLayoutColumnKey(key: ResultsLayoutColumnKey): ResultsLayoutColumnKey | null {
  const index = RESULTS_COLUMN_DEFINITIONS.findIndex((column) => column.key === key)
  return RESULTS_COLUMN_DEFINITIONS[index + 1]?.key ?? null
}

function normalizeResultsLayoutColumns(columns: ResultsColumnLayout): ResultsColumnLayout {
  const rawColumns = Object.fromEntries(
    RESULTS_COLUMN_DEFINITIONS.map((definition) => [
      definition.key,
      normalizeResultsLayoutColumn(definition, columns[definition.key]),
    ]),
  ) as ResultsColumnLayout

  return scaleResultsLayoutColumns(rawColumns)
}

function scaleResultsLayoutColumns(columns: ResultsColumnLayout): ResultsColumnLayout {
  const total = RESULTS_COLUMN_DEFINITIONS.reduce((sum, column) => (
    sum + Math.max(0, columns[column.key])
  ), 0)
  if (total <= 0) return DEFAULT_RESULTS_COLUMN_LAYOUT

  const scaled = RESULTS_COLUMN_DEFINITIONS.map((column) => {
    const exact = Math.max(0, columns[column.key]) / total * RESULTS_LAYOUT_TARGET_TOTAL
    const floor = Math.floor(exact)
    return {
      key: column.key,
      floor,
      fraction: exact - floor,
    }
  })
  let remainder = RESULTS_LAYOUT_TARGET_TOTAL - scaled.reduce((sum, entry) => sum + entry.floor, 0)
  const byFraction = [...scaled].sort((left, right) => right.fraction - left.fraction)
  for (const entry of byFraction) {
    if (remainder <= 0) break
    entry.floor += 1
    remainder -= 1
  }

  return Object.fromEntries(scaled.map((entry) => [entry.key, entry.floor])) as ResultsColumnLayout
}

function measureCurrentResultCardColumns(list: HTMLDivElement | null): ResultsColumnLayout | null {
  const card = list?.querySelector<HTMLElement>(".fd-result-card:not(.fd-result-card--compact)")
  if (!card) return null

  const trackWidths = getComputedStyle(card).gridTemplateColumns
    .split(/\s+/)
    .map((track) => Number.parseFloat(track))
    .filter((value) => Number.isFinite(value) && value > 0)

  if (trackWidths.length < RESULTS_COLUMN_DEFINITIONS.length) return null

  const editableTrackWidths = trackWidths.slice(trackWidths.length - RESULTS_COLUMN_DEFINITIONS.length)

  return Object.fromEntries(
    RESULTS_COLUMN_DEFINITIONS.map((definition, index) => [
      definition.key,
      Math.round(editableTrackWidths[index]),
    ]),
  ) as ResultsColumnLayout
}

function resultsLayoutStyleVars(columns: ResultsColumnLayout): CSSProperties {
  const style: Record<string, string> = {}
  RESULTS_COLUMN_DEFINITIONS.forEach((column) => {
    style[`--fd-results-col-${column.key}`] = `${Math.max(0, Math.round(columns[column.key]))}fr`
  })
  return style as CSSProperties
}

function resultsLayoutColumnShareLabel(
  columns: ResultsColumnLayout,
  key: ResultsLayoutColumnKey,
) {
  const total = RESULTS_COLUMN_DEFINITIONS.reduce((sum, column) => (
    sum + Math.max(0, columns[column.key])
  ), 0)
  if (total <= 0) return "0%"

  const share = Math.max(0, columns[key]) / total * 100
  return `${share >= 10 ? Math.round(share) : share.toFixed(1)}%`
}

function resultsLayoutStatus({
  error,
  loading,
  ready,
  savedAt,
  saving,
}: {
  error: string
  loading: boolean
  ready: boolean
  savedAt: string
  saving: boolean
}) {
  if (saving) return `Guardando en ${RESULTS_LAYOUT_FILE_HINT}`
  if (loading) return `Cargando ${RESULTS_LAYOUT_FILE_HINT}`
  if (error) return error
  if (!ready) return "Esperando una card para medir el layout actual"
  if (savedAt) return `Guardado ${formatLayoutSavedAt(savedAt)}`
  return `Sin guardar en ${RESULTS_LAYOUT_FILE_HINT}`
}

function formatLayoutSavedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("es-PE", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "No se pudo completar la acción."
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
    <Pagination
      aria-label="Paginación de resultados"
      className="mt-2 grid shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-t border-border/80 px-1 pb-0.5 pt-2"
      data-testid="results-pagination"
    >
      <p className="col-start-2 min-w-0 text-center text-xs font-semibold text-muted-foreground">
        {startIndex + 1}-{endIndex} de {totalCount}
      </p>
      <PaginationContent className="col-start-3 justify-end">
        <PaginationItem>
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
        </PaginationItem>
        <PaginationItem>
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
        </PaginationItem>

        {paginationItems(pageIndex, pageCount).map((item) => (
          typeof item === "number" ? (
            <PaginationItem key={item}>
              <Button
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
            </PaginationItem>
          ) : (
            <PaginationItem key={item}>
              <PaginationEllipsis className="h-7 min-w-5 text-xs text-muted-foreground" />
            </PaginationItem>
          )
        ))}

        <PaginationItem>
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
        </PaginationItem>
        <PaginationItem>
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
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  )
}

function resultsSummaryLabel(totalCount: number, loading: boolean, hasResults: boolean) {
  if (totalCount > 0) return resultsTotalLabel(totalCount)
  if (loading) return ""
  return hasResults ? "Sin vuelos visibles" : "Sin consulta"
}

function resultsTotalLabel(totalCount: number) {
  return `${totalCount} vuelo${totalCount === 1 ? "" : "s"}`
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
            <div key={month.key} className={`relative min-w-0${month.status === "partial" ? " fd-migration-month-card--updating" : ""}`}>
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
  const cancelled = month.status === "cancelled"
  const title = loading
    ? "Buscando..."
    : error
      ? "Error al consultar"
      : cancelled
        ? "No consultado"
        : month.filtered ? "Sin tarifa con filtros" : "Sin tarifa disponible"
  const body = loading
    ? "Consultando el precio más bajo disponible para este mes."
    : error
      ? month.warnings?.[0] ?? "La consulta de este mes no pudo completarse. Vuelve a intentarlo."
      : month.filtered
        ? "Ajusta directo, equipaje o aerolínea para volver a incluir este mes."
        : cancelled
          ? month.warnings?.[0] ?? "Búsqueda detenida antes de consultar este mes."
          : month.warnings?.[0] ?? "No hubo una oferta disponible para este mes."

  return (
    <article
      className={`fd-migration-month-card${loading ? " fd-migration-month-card--loading" : ""}${error ? " fd-migration-month-card--error" : ""}${cancelled ? " fd-migration-month-card--cancelled" : ""}`}
      data-testid="migration-month-card"
    >
      <span className="fd-result-card__eyebrow">{month.label}</span>
      <div>
        <p className="fd-migration-month-card__title">{title}</p>
        <p className="fd-migration-month-card__meta">
          {formatDateRange(month.departureStart, month.departureEnd)}
        </p>
      </div>
      <p className="fd-migration-month-card__body">{body}</p>
    </article>
  )
}

function EmptyState({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <Empty className="grid h-full min-h-[320px] place-items-center gap-0 rounded-none border-0 bg-transparent p-6 text-center md:p-6">
      <EmptyHeader className="max-w-md gap-0">
        <EmptyMedia className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
          {icon}
        </EmptyMedia>
        <EmptyTitle className="text-base font-bold" role="heading" aria-level={3}>{title}</EmptyTitle>
        <EmptyDescription className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted-foreground">
          {body}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

export const ResultsPanel = memo(ResultsPanelBase)

type DisplayMigrationMonth = MigrationMonthSummary & {
  filtered?: boolean
}

function uniqueWarnings(messages: string[]) {
  return Array.from(new Set(messages.map((message) => message.trim()).filter(Boolean)))
}

function isActionableWarning(message: string) {
  return !isOperationalWarning(message)
}

function isGenericOperationFailureWarning(message: string) {
  const normalized = normalizeWarningText(message)
    .replace(/[.!]+/g, "")
    .trim()
  return normalized === "no se pudo completar la operacion"
    || normalized === "no se pudo completar la operacion intenta nuevamente"
}

function isOperationalWarning(message: string) {
  const normalized = normalizeWarningText(message)

  if (normalized.includes("resultados cacheados") && normalized.includes("actualiz")) return true
  if (normalized.includes("consultando") && normalized.includes("resultados se iran agregando")) return true
  if (normalized.includes("matrix loading") && normalized.includes("parallel")) return true
  if (normalized.includes("search cancelled by user")) return true
  if (normalized.includes("busqueda detenida por el usuario")) return true
  if (normalized.includes("search stopped because the page was refreshed")) return true

  return false
}

function normalizeWarningText(message: string) {
  return message
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
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
  provider: "Agilsmart" | "Click and Book Plus"
  warning: string
}

function providerNoFlightIssues(warnings: string[]): ProviderNoFlightIssue[] {
  const issues: ProviderNoFlightIssue[] = []
  const seen = new Set<string>()

  for (const warning of warnings) {
    const normalized = warning.toLowerCase()
    const provider = normalized.includes("agil no devolvió")
      ? "Agilsmart"
      : normalized.includes("costamar no devolvió") || normalized.includes("click and book plus no devolvió")
        ? "Click and Book Plus"
        : null

    if (!provider || seen.has(provider)) continue
    seen.add(provider)
    issues.push({ provider, warning })
  }

  return issues
}

function emptySearchModel(noFlightIssues: ProviderNoFlightIssue[], filteredEmpty: boolean) {
  if (filteredEmpty) {
    return {
      title: "No hay búsquedas que coincidan",
      body: "Ajusta filtros de equipaje, escalas o aerolíneas para volver a incluir resultados.",
    }
  }

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

function isFilteredEmptyState(
  results: SearchJobResponse | null,
  offers: CanonicalOffer[],
  unfilteredOfferCount: number,
) {
  if (!results || offers.length > 0) return false

  const retainedOfferCount = results.allOffers?.length ?? 0
  return unfilteredOfferCount > 0 || retainedOfferCount > 0
}

function warningSummaryLabel(warnings: string[], noFlightIssues: ProviderNoFlightIssue[]) {
  if (noFlightIssues.length > 0) {
    return noFlightIssues.length === 1
      ? `${noFlightIssues[0].provider} sin vuelos`
      : "Agilsmart y Click and Book Plus sin vuelos"
  }

  return warnings.length === 1 ? "1 aviso" : `${warnings.length} avisos`
}

function useAdaptiveResultsPageCapacity(itemCount: number) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [pageCapacity, setPageCapacity] = useState(RESULTS_PAGE_SIZE_FALLBACK)
  const rowHeightRef = useRef(RESULTS_CARD_HEIGHT_ESTIMATE_PX)

  useLayoutEffect(() => {
    const node = viewportRef.current
    if (!node || itemCount <= 0) return

    let frame = 0
    const update = () => {
      const list = node.querySelector<HTMLElement>(".fd-results-list")
      const availableHeight = Math.max(0, node.clientHeight - RESULTS_LIST_TOP_INSET_PX)
      const measuredCards = list
        ? Array.from(list.querySelectorAll<HTMLElement>(".fd-result-card:not(.fd-result-card--compact):not(.fd-result-card--layout-guide)"))
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
      const nextPageCapacity = Math.max(
        1,
        Math.min(itemCount, RESULTS_PAGE_SIZE_MAX, fullyVisibleRows + (shouldAddOverflowRow ? 1 : 0)),
      )

      setPageCapacity((current) => current === nextPageCapacity ? current : nextPageCapacity)
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

  return { pageCapacity, viewportRef }
}

function resultItemsPaginationKey(items: ResultListItem[]) {
  if (items.length === 0) return "empty"
  if (items.length <= 6) return items.map((item) => item.id).join("|")

  const middleIndex = Math.floor(items.length / 2)
  return [
    items.length,
    items[0]?.id,
    items[1]?.id,
    items[middleIndex]?.id,
    items[items.length - 1]?.id,
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
