import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { ResultCard, type AlternateSchedule } from "@/components/results/ResultCard"
import { buildAlternateScheduleModel } from "@/components/results/result-card-model"
import {
  buildResultListItems,
  paginateResultListItems,
  resultListItemContainsOffer,
  type ResultListItem,
  type ResultOfferGroup,
} from "@/components/results/result-groups"
import { AllSchedulesPanel } from "@/components/results/AllSchedulesPanel"
import { MigrationMonthGrid } from "@/components/results/MigrationMonthGrid"
import { ResultsSkeleton } from "@/components/results/ResultsSkeleton"
import { AppIcon } from "@/components/ui/app-icon"
import { Button } from "@/components/ui/button"
import { SegmentButton, SegmentedControl } from "@/components/ui/segmented-control"
import type { CanonicalOffer, SearchJobResponse, SortMode } from "@/types"

/*
 * Plates 1b (active desktop), 2g (list states), 3b (all schedules), 4a
 * (skeletons) and 1i (migration grid).
 *
 * The panel is one header, one strip of active filters, one page of cards and
 * one pager. The column-width editor that used to live here is gone: plate 1b
 * closes the card grid at 32 / 186 / 1fr / 116 / 26, so there is nothing left
 * for it to tune.
 */

const RESULTS_PAGE_SIZE_MAX = 12
const RESULTS_PAGE_SIZE_FALLBACK = 4
/* Dropping the "Ruta" column took the card from 81px to 68px, which is what
   turns 4 visible results into 7. */
const RESULTS_CARD_HEIGHT_ESTIMATE_PX = 68
const RESULTS_CARD_GAP_PX = 6
const RESULTS_LIST_TOP_INSET_PX = 4
const RESULTS_EXTRA_ROW_MIN_BLANK_PX = 28
/* A skeleton that never stops is a skeleton that lies. At eight seconds it
   yields the floor to the incomplete-search notice. */
const SKELETON_GIVE_UP_MS = 8000

export type ActiveFilterChip = {
  id: string
  label: string
}

interface ResultsPanelProps {
  results: SearchJobResponse | null
  unfilteredOfferCount: number
  loading: boolean
  sort: SortMode
  onSort: (sort: SortMode) => void
  onSelectOffer: (offer: CanonicalOffer) => void
  selectedOfferId?: string
  activeFilterChips?: ActiveFilterChip[]
  hiddenByFiltersCount?: number
  onRemoveFilter?: (id: string) => void
  onClearFilters?: () => void
}

function ResultsPanelBase({
  results,
  unfilteredOfferCount,
  loading,
  sort,
  onSort,
  onSelectOffer,
  selectedOfferId,
  activeFilterChips = [],
  hiddenByFiltersCount = 0,
  onRemoveFilter,
  onClearFilters,
}: ResultsPanelProps) {
  const offers = results?.offers ?? []
  const meta = results?.searchMeta
  const isMigration = results?.request.searchMode === "month-view" || Boolean(results?.migrationMonths?.length)
  const isCancelled = results?.searchStatus === "cancelled"
  const isPartial = Boolean(meta?.partial) || (loading && offers.length > 0)
  const passengerCount = passengerCountForRequest(results?.request)
  const showPerPerson = canShowPerPersonForRequest(results?.request)

  return (
    <section className="fd-panel flex h-full min-h-0 min-w-0 flex-col overflow-hidden" aria-busy={loading}>
      <div className="fd-panel-header !px-3 !py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <h2 className="fd-panel-title shrink-0">{isMigration ? "Vuelo migratorio" : "Resultados"}</h2>
            <ResultCount
              visible={offers.length}
              total={unfilteredOfferCount}
              loading={loading}
              hasResults={Boolean(results)}
            />
            {isPartial && (
              <span className="fd-status-pill">
                <AppIcon name="loading" size={12} spin={loading} />
                Parcial
              </span>
            )}
            {isCancelled && !loading && (
              <span className="fd-status-pill">
                <AppIcon name="x" size={12} />
                Detenida
              </span>
            )}
          </div>

          {!isMigration && (
            <div className="flex shrink-0 items-center gap-2">
              <span className="fd-type-micro">Ordenar</span>
              <SegmentedControl
                aria-label="Orden de resultados"
                value={sort}
                onValueChange={(value) => {
                  if (value === "cheapest" || value === "fastest") onSort(value)
                }}
              >
                <SegmentButton value="cheapest" aria-label="Ordenar por precio">Precio</SegmentButton>
                <SegmentButton value="fastest" aria-label="Ordenar por duración">Duración</SegmentButton>
              </SegmentedControl>
            </div>
          )}
        </div>
      </div>

      {(activeFilterChips.length > 0 || hiddenByFiltersCount > 0) && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-3 pt-[7px]">
          {activeFilterChips.map((chip) => (
            <span key={chip.id} className="fd-active-chip fd-motion-emergente">
              {chip.label}
              {onRemoveFilter && (
                <button
                  type="button"
                  className="fd-active-chip-remove fd-focus-ring rounded-sm"
                  aria-label={`Quitar filtro ${chip.label}`}
                  onClick={() => onRemoveFilter(chip.id)}
                >
                  <AppIcon name="x" size={12} />
                </button>
              )}
            </span>
          ))}
          {hiddenByFiltersCount > 0 && (
            <span className="ml-auto text-xs text-muted-foreground">
              {hiddenByFiltersCount === 1
                ? "1 vuelo oculto por filtros"
                : `${hiddenByFiltersCount.toLocaleString("es-PE")} vuelos ocultos por filtros`}
            </span>
          )}
        </div>
      )}

      <ResultsBody
        results={results}
        offers={offers}
        loading={loading}
        isCancelled={isCancelled}
        isMigration={isMigration}
        unfilteredOfferCount={unfilteredOfferCount}
        passengerCount={passengerCount}
        showPerPerson={showPerPerson}
        selectedOfferId={selectedOfferId}
        onSelectOffer={onSelectOffer}
        onClearFilters={onClearFilters}
        activeFilterChips={activeFilterChips}
      />
    </section>
  )
}

function ResultCount({
  visible,
  total,
  loading,
  hasResults,
}: {
  visible: number
  total: number
  loading: boolean
  hasResults: boolean
}) {
  if (visible === 0) {
    if (loading) return null
    return <span className="fd-panel-count">{hasResults ? "sin vuelos visibles" : "sin consulta"}</span>
  }

  // "386 de 1,240" only when filters are actually hiding something; otherwise
  // the second number is the first number and says nothing.
  const label = total > visible
    ? `${visible.toLocaleString("es-PE")} de ${total.toLocaleString("es-PE")}`
    : visible.toLocaleString("es-PE")

  return <span className="fd-panel-count">{label}</span>
}

function ResultsBody({
  results,
  offers,
  loading,
  isCancelled,
  isMigration,
  unfilteredOfferCount,
  passengerCount,
  showPerPerson,
  selectedOfferId,
  onSelectOffer,
  onClearFilters,
  activeFilterChips,
}: {
  results: SearchJobResponse | null
  offers: CanonicalOffer[]
  loading: boolean
  isCancelled: boolean
  isMigration: boolean
  unfilteredOfferCount: number
  passengerCount: number
  showPerPerson: boolean
  selectedOfferId?: string
  onSelectOffer: (offer: CanonicalOffer) => void
  onClearFilters?: () => void
  activeFilterChips: ActiveFilterChip[]
}) {
  const skeletonExpired = useSkeletonTimeout(
    loading && offers.length === 0,
    results?.searchJobId ?? "pending",
  )

  if (!results && !loading) {
    return (
      <EmptyState
        icon="flight"
        title="Busca vuelos para comparar"
        body="Ingresa origen, destino y fechas. La lista prioriza precio, duración, escalas, equipaje y proveedor."
      />
    )
  }

  if (isCancelled && offers.length === 0) {
    return (
      <EmptyState
        icon="x"
        title="Búsqueda detenida"
        body="Ajusta origen, destino, fechas o pasajeros y vuelve a buscar cuando esté listo."
      />
    )
  }

  if (isMigration && results) {
    return (
      <MigrationMonthGrid
        results={results}
        offers={offers}
        passengerCount={passengerCount}
        selectedOfferId={selectedOfferId}
        onSelectOffer={onSelectOffer}
      />
    )
  }

  if (loading && offers.length === 0 && !skeletonExpired) {
    return <ResultsSkeleton />
  }

  if (offers.length === 0 && results) {
    // Plate 2g: an empty list caused by filters names the filter to blame and
    // offers two ways out. An empty list with no filters on is a different
    // problem and gets different words.
    const filteredEmpty = unfilteredOfferCount > 0 || (results.allOffers?.length ?? 0) > 0

    if (filteredEmpty) {
      return (
        <EmptyState
          icon="filters"
          title="Ningún vuelo pasa los filtros"
          body={filteredEmptyBody(activeFilterChips)}
          action={onClearFilters
            ? { label: "Quitar los filtros", onClick: onClearFilters }
            : undefined}
        />
      )
    }

    return (
      <EmptyState
        icon="sort"
        title="Sin resultados para esta consulta"
        body="Ajusta fechas, escalas, equipaje o aerolíneas para ampliar la cobertura."
      />
    )
  }

  return (
    <ResultsPage
      offers={offers}
      scheduleGroups={results?.scheduleGroups}
      passengerCount={passengerCount}
      showPerPerson={showPerPerson}
      selectedOfferId={selectedOfferId}
      onSelectOffer={onSelectOffer}
      partial={loading}
    />
  )
}

/** Names the filter most likely to blame, so the way out is one click away. */
function filteredEmptyBody(chips: ActiveFilterChip[]): string {
  if (chips.length === 0) {
    return "Quita algún filtro para volver a incluir resultados."
  }

  if (chips.length === 1) {
    return `«${chips[0].label}» dejó la lista vacía. Quítalo o amplía la búsqueda.`
  }

  return `Los filtros activos (${chips.map((chip) => chip.label).join(", ")}) dejaron la lista vacía.`
}

function ResultsPage({
  offers,
  scheduleGroups,
  passengerCount,
  showPerPerson,
  selectedOfferId,
  onSelectOffer,
  partial,
}: {
  offers: CanonicalOffer[]
  scheduleGroups: SearchJobResponse["scheduleGroups"]
  passengerCount: number
  showPerPerson: boolean
  selectedOfferId?: string
  onSelectOffer: (offer: CanonicalOffer) => void
  partial: boolean
}) {
  const resultItems = useMemo(
    () => buildResultListItems(offers, scheduleGroups),
    [offers, scheduleGroups],
  )
  const { pageCapacity, viewportRef } = useAdaptiveResultsPageCapacity(resultItems.length)
  const pageKey = useMemo(() => resultItemsPaginationKey(resultItems), [resultItems])
  /* Which schedule each group is currently showing, and which group has its full
     list open. Both are stamped with the result set they belong to, so a new
     search drops them in the same render instead of briefly pinning a stale
     schedule onto a group id that has been reused for different offers. */
  const [scheduleState, setScheduleState] = useState<{
    key: string
    choice: Record<string, string>
    expandedGroupId: string | null
  }>({ key: "", choice: {}, expandedGroupId: null })
  const scheduleChoice = scheduleState.key === pageKey ? scheduleState.choice : {}
  const expandedGroupId = scheduleState.key === pageKey ? scheduleState.expandedGroupId : null
  const [pageState, setPageState] = useState({ key: "", index: 0 })
  const pages = useMemo(
    () => paginateResultListItems(resultItems, pageCapacity),
    [resultItems, pageCapacity],
  )
  const pageCount = Math.max(1, pages.length)
  const selectedPageIndex = useMemo(() => {
    if (!selectedOfferId) return
    const index = pages.findIndex((page) => page.items.some((item) => resultListItemContainsOffer(item, selectedOfferId)))
    return index >= 0 ? index : undefined
  }, [pages, selectedOfferId])

  const requestedPageIndex = pageState.key === pageKey ? pageState.index : selectedPageIndex ?? 0
  const safePageIndex = Math.max(0, Math.min(requestedPageIndex, pageCount - 1))
  const currentPage = pages[safePageIndex] ?? pages[0] ?? { items: [], startOfferIndex: 0, endOfferIndex: 0, displayWeight: 0 }

  const handlePageChange = useCallback((nextPageIndex: number) => {
    setPageState({ key: pageKey, index: Math.max(0, Math.min(nextPageIndex, pageCount - 1)) })
  }, [pageCount, pageKey])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3 pt-[7px]" data-testid="results-page-shell">
      <div
        ref={viewportRef}
        className="fd-scrollbar-hidden min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
        data-testid="results-page-body"
      >
        {/* Keyed on the page so a page change is a 140ms cross-fade rather than
            an animated height (rule 2). */}
        <div key={safePageIndex} className="fd-results-list fd-motion-crossfade grid content-start gap-1.5 pt-1">
          {currentPage.items.map((item) => (
            item.type === "group" ? (
              <GroupCard
                key={item.id}
                group={item.group}
                passengerCount={passengerCount}
                showPerPerson={showPerPerson}
                selectedOfferId={selectedOfferId}
                chosenOfferId={scheduleChoice[item.id]}
                expanded={expandedGroupId === item.id}
                onChooseSchedule={(offer) => {
                  setScheduleState((current) => ({
                    key: pageKey,
                    choice: { ...(current.key === pageKey ? current.choice : {}), [item.id]: offer.id },
                    expandedGroupId: current.key === pageKey ? current.expandedGroupId : null,
                  }))
                  onSelectOffer(offer)
                }}
                onToggleExpanded={() => setScheduleState((current) => ({
                  key: pageKey,
                  choice: current.key === pageKey ? current.choice : {},
                  expandedGroupId: current.key === pageKey && current.expandedGroupId === item.id ? null : item.id,
                }))}
                onSelectOffer={onSelectOffer}
              />
            ) : (
              <ResultCard
                key={item.id}
                offer={item.offer}
                selected={selectedOfferId === item.offer.id}
                passengerCount={passengerCount}
                showPerPerson={showPerPerson}
                onSelect={onSelectOffer}
              />
            )
          ))}

          {/* In a partial search the skeleton fills only the rows still missing,
              and it fills them at the end. */}
          {partial && currentPage.items.length > 0 && currentPage.items.length < pageCapacity && (
            <ResultsSkeleton
              rows={pageCapacity - currentPage.items.length}
              inline
              startDelayIndex={currentPage.items.length}
            />
          )}
        </div>
      </div>

      {pageCount > 1 && (
        <ResultsPager
          pageIndex={safePageIndex}
          pageCount={pageCount}
          startIndex={currentPage.startOfferIndex}
          endIndex={currentPage.endOfferIndex}
          totalCount={offers.length}
          onPageChange={handlePageChange}
        />
      )}
    </div>
  )
}

function GroupCard({
  group,
  passengerCount,
  showPerPerson,
  selectedOfferId,
  chosenOfferId,
  expanded,
  onChooseSchedule,
  onToggleExpanded,
  onSelectOffer,
}: {
  group: ResultOfferGroup
  passengerCount: number
  showPerPerson: boolean
  selectedOfferId?: string
  chosenOfferId?: string
  expanded: boolean
  onChooseSchedule: (offer: CanonicalOffer) => void
  onToggleExpanded: () => void
  onSelectOffer: (offer: CanonicalOffer) => void
}) {
  const defaultOffer = group.offers[0]
  const shownOffer = group.offers.find((offer) => offer.id === chosenOfferId) ?? defaultOffer
  if (!shownOffer) return null

  const alternates = group.offers.filter((offer) => offer.id !== shownOffer.id)

  return (
    <div className="relative min-w-0">
      <ResultCard
        offer={shownOffer}
        selected={selectedOfferId === shownOffer.id}
        passengerCount={passengerCount}
        showPerPerson={showPerPerson}
        onSelect={onSelectOffer}
        alternates={alternates.map((offer) => alternateChip(offer, shownOffer))}
        alternateCount={alternates.length}
        onSelectAlternate={onChooseSchedule}
        onShowAllAlternates={onToggleExpanded}
        scheduleChanged={Boolean(chosenOfferId) && chosenOfferId !== defaultOffer.id}
      />

      {expanded && (
        <AllSchedulesPanel
          offers={group.offers}
          currentOfferId={shownOffer.id}
          passengerCount={passengerCount}
          providerLabel={group.providerLabel}
          onChoose={(offer) => {
            onChooseSchedule(offer)
            onToggleExpanded()
          }}
          onClose={onToggleExpanded}
        />
      )}
    </div>
  )
}

/**
 * A chip carries the departure time it would switch to, and — because the fare
 * is the reason to hesitate — the price difference against what is on the card.
 * When the fare is identical the chip shows the duration instead, which is the
 * next thing that decides it.
 */
function alternateChip(offer: CanonicalOffer, currentOffer: CanonicalOffer): AlternateSchedule {
  const model = buildAlternateScheduleModel(offer, currentOffer)

  return {
    offer,
    legAriaLabel: model.legAriaLabel,
    time: model.time,
    meta: model.meta,
    selected: false,
  }
}

function ResultsPager({
  pageIndex,
  pageCount,
  startIndex,
  endIndex,
  totalCount,
  onPageChange,
}: {
  pageIndex: number
  pageCount: number
  startIndex: number
  endIndex: number
  totalCount: number
  onPageChange: (index: number) => void
}) {
  return (
    <nav className="fd-pager" aria-label="Paginación de resultados" data-testid="results-pagination">
      <p className="fd-pager-range">
        {startIndex + 1}–{endIndex} de {totalCount.toLocaleString("es-PE")}
      </p>
      <span className="fd-pager-divider" aria-hidden="true" />
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          className="fd-pager-cell fd-focus-ring"
          aria-label="Página anterior"
          disabled={pageIndex <= 0}
          onClick={() => onPageChange(pageIndex - 1)}
        >
          <AppIcon name="chevronLeft" />
        </button>

        {pagerCells(pageIndex, pageCount).map((cell) => (
          typeof cell === "number" ? (
            <button
              key={cell}
              type="button"
              className="fd-pager-cell fd-focus-ring"
              aria-label={`Página ${cell + 1}`}
              aria-current={cell === pageIndex ? "page" : undefined}
              onClick={() => onPageChange(cell)}
            >
              {cell + 1}
            </button>
          ) : (
            <span key={cell} className="fd-pager-gap" aria-hidden="true">…</span>
          )
        ))}

        <button
          type="button"
          className="fd-pager-cell fd-focus-ring"
          aria-label="Página siguiente"
          disabled={pageIndex >= pageCount - 1}
          onClick={() => onPageChange(pageIndex + 1)}
        >
          <AppIcon name="chevronRight" />
        </button>
      </div>
    </nav>
  )
}

/** `1 … 5 6 7 … 56` — first and last always reachable, three around current. */
function pagerCells(pageIndex: number, pageCount: number): Array<number | "gap-left" | "gap-right"> {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, index) => index)
  }

  if (pageIndex <= 2) {
    return [0, 1, 2, 3, "gap-right", pageCount - 1]
  }

  if (pageIndex >= pageCount - 3) {
    return [0, "gap-left", pageCount - 4, pageCount - 3, pageCount - 2, pageCount - 1]
  }

  return [0, "gap-left", pageIndex - 1, pageIndex, pageIndex + 1, "gap-right", pageCount - 1]
}

function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: "flight" | "x" | "sort" | "filters"
  title: string
  body: string
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div className="grid min-h-[280px] flex-1 place-items-center p-6 text-center">
      <div className="max-w-md">
        <span className="mx-auto mb-3 grid size-12 place-items-center rounded-xl bg-secondary text-muted-foreground">
          <AppIcon name={icon} size={18} />
        </span>
        <h3 className="fd-type-card">{title}</h3>
        <p className="mt-1 text-[13px] leading-6 text-muted-foreground">{body}</p>
        {action && (
          <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={action.onClick}>
            <AppIcon name="x" size={14} />
            {action.label}
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * True once the skeleton has been up long enough to stop claiming progress.
 *
 * The flag is stamped with the search it belongs to, so the next search starts
 * fresh without an effect having to clear it first — a stale `true` would skip
 * the skeleton entirely on the following search.
 */
function useSkeletonTimeout(active: boolean, searchKey: string) {
  const [expiredKey, setExpiredKey] = useState<string | null>(null)

  useEffect(() => {
    if (!active) return

    const timer = window.setTimeout(() => setExpiredKey(searchKey), SKELETON_GIVE_UP_MS)
    return () => window.clearTimeout(timer)
  }, [active, searchKey])

  return active && expiredKey === searchKey
}

/**
 * How many cards fit without cutting one in half. A page that ends mid-card
 * makes the agent scroll to find out whether there was anything there.
 */
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
      const cards = list ? Array.from(list.querySelectorAll<HTMLElement>(".fd-card:not(.fd-card--skeleton)")) : []
      const listStyle = list ? window.getComputedStyle(list) : null
      const measuredGap = listStyle
        ? Number.parseFloat(listStyle.rowGap || listStyle.gap || `${RESULTS_CARD_GAP_PX}`)
        : RESULTS_CARD_GAP_PX
      const gap = Number.isFinite(measuredGap) ? measuredGap : RESULTS_CARD_GAP_PX
      const measuredHeight = cards.reduce((max, card) => Math.max(max, card.getBoundingClientRect().height), 0)
      if (measuredHeight > 0 && Math.abs(measuredHeight - rowHeightRef.current) > 1) {
        rowHeightRef.current = measuredHeight
      }

      const rowHeight = rowHeightRef.current
      const fullRows = Math.max(1, Math.floor((availableHeight + gap) / (rowHeight + gap)))
      const usedHeight = fullRows * rowHeight + Math.max(0, fullRows - 1) * gap
      const blank = availableHeight - usedHeight
      const addOverflowRow = blank >= RESULTS_EXTRA_ROW_MIN_BLANK_PX && fullRows < itemCount
      const next = Math.max(1, Math.min(itemCount, RESULTS_PAGE_SIZE_MAX, fullRows + (addOverflowRow ? 1 : 0)))

      setPageCapacity((current) => current === next ? current : next)
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

function passengerCountForRequest(request: SearchJobResponse["request"] | undefined) {
  if (!request) return 1
  return Math.max(1, request.adults + request.children + request.infants)
}

function canShowPerPersonForRequest(request: SearchJobResponse["request"] | undefined) {
  return Boolean(request && request.children === 0 && request.infants === 0)
}

export const ResultsPanel = memo(ResultsPanelBase)
