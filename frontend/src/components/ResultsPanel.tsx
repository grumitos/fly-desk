import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react"
import { ResultCard, type AlternateSchedule } from "@/components/results/ResultCard"
import { buildAlternateScheduleModel } from "@/components/results/result-card-model"
import {
  RESULT_GROUP_CARD_WEIGHT,
  buildResultListItems,
  paginateResultListItems,
  resultListItemContainsOffer,
  resultListItemDisplayWeight,
  type ResultListItem,
  type ResultOfferGroup,
} from "@/components/results/result-groups"
import { AllSchedulesPanel } from "@/components/results/AllSchedulesPanel"
import { MigrationMonthGrid } from "@/components/results/MigrationMonthGrid"
import { migrationSweepSummary, type DisplayMonth } from "@/components/results/migration-month-model"
import { ResultsSkeleton } from "@/components/results/ResultsSkeleton"
import { ActiveFilterChips } from "@/components/results/ActiveFilterChips"
import { AppIcon } from "@/components/ui/app-icon"
import { SegmentedControl, SegmentedOption } from "@/components/ui/segmented-control"
import { Spinner } from "@/components/ui/spinner"
import { Kbd } from "@/components/ui/kbd"
import { ShortcutTooltip } from "@/components/ui/tooltip"
import {
  describeSearchOutcome,
  failureSentences,
  stillSearchingBody,
  type SearchOutcome,
} from "@/lib/search-outcome"
import { cn } from "@/lib/utils"
import type { CanonicalOffer, SearchJobResponse, SortMode } from "@/types"

/*
 * Plates 1b (active desktop), 2g (list states), 3b (all schedules), 4a
 * (skeletons) and 1i (migration grid).
 *
 * The panel is one header, one strip of active filters, one page of cards and
 * one pager. The column-width editor that used to live here is gone: plate 1b
 * closes the card grid at 32 / 142 / 1fr / auto / 116 / 26 — the baggage in a
 * track of its own, and past 1073px of list the two legs as plates that split
 * the single elastic track — so there is nothing left for it to tune.
 */

/*
 * The ceiling is a guard against a pathological viewport, not a page size. 12
 * was the fit of a 1440-tall desk when it was written and became a cap the
 * moment screens grew past it: a 1920×1080 column fits 13 plain rows and a
 * 1440-tall one fits 19, so the page stopped one and seven rows short of the
 * space it had just measured — the same half-empty column the skeleton was
 * reported with. 20 is that 19 plus a row of slack; past it the wins are
 * hypothetical and the cost of building the cards is not.
 */
const RESULTS_PAGE_SIZE_MAX = 20
const RESULTS_PAGE_SIZE_FALLBACK = 4
/* The plain card of plate 8c, which is the unit a display weight of 1 means.
   The measurement below replaces this on the first frame. */
const RESULTS_CARD_HEIGHT_ESTIMATE_PX = 58
const RESULTS_CARD_GAP_PX = 6
const RESULTS_LIST_TOP_INSET_PX = 4
/*
 * When a search stops being a search that is merely starting.
 *
 * This used to be the moment the skeleton was taken down and replaced by the
 * «La búsqueda sigue en curso» notice, on the reasoning that a skeleton which
 * never stops is a skeleton that lies. The premise was wrong about the clock,
 * not about the lie: a real search takes 15–40s and more — the production
 * smoke's fastest case lands around 15 — so eight seconds is not where a search
 * becomes doubtful, it is where an ordinary one is still working. Every real
 * search died into a sparse clock screen and the agent watched a stopped page
 * for the thirty seconds that mattered.
 *
 * The skeleton is not what claims progress; the search's own lifecycle does,
 * and it is bounded — `loading` ends when the job does, and the admission
 * timeout bounds that at 120s. So the bones stay for as long as the search is
 * alive, and eight seconds is when the words join them (11 §3's «tarda»,
 * naming the provider that is slow) rather than when they replace them.
 */
const SKELETON_GIVE_UP_MS = 8000
/* 02 §9: the way back to the top appears past 300px of list scroll. */
const BACK_TO_TOP_AFTER_PX = 300

export type ActiveFilterChip = {
  id: string
  label: string
}

/**
 * Plate 2g: what an empty-by-filters list needs to say. The count comes from
 * the search; the culprit and the way to relax it can only be worked out where
 * the filters are applied, so they arrive from above — and both are optional,
 * because a list that cannot tell which filter is to blame says so by staying
 * quiet rather than by guessing.
 */
export type EmptyByFiltersCopy = {
  /** "El filtro de directo es el que descarta más." */
  culpritSentence?: string
  /** "Permitir 1 escala" — relaxes only the culprit. */
  relax?: { label: string; onClick: () => void }
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
  onOpenFilters?: () => void
  /** Plate 2g's second exit, supplied by whoever applies the filters. */
  emptyByFilters?: EmptyByFiltersCopy
  /** 04 §8's exit for «vacío por búsqueda»: back to editing the search. */
  onEditSearch?: () => void
  /** 06 §1.3: choosing a month of the sweep opens that month's normal list. */
  onOpenMigrationMonth?: (month: DisplayMonth) => void
  onMobileToolsCollapsedChange?: (collapsed: boolean) => void
  mobileCollapseEnabled?: boolean
  /**
   * Where the strip of active filters mounts. On a desk it belongs to the list
   * header; in armazón C it is the middle band of the retractable tools block,
   * which the shell owns because the search summary above it retracts with it
   * as one piece (plate 1d, 02 §9).
   */
  chipsPlacement?: "list" | "external"
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
  onOpenFilters,
  emptyByFilters,
  onEditSearch,
  onOpenMigrationMonth,
  onMobileToolsCollapsedChange,
  mobileCollapseEnabled = false,
  chipsPlacement = "list",
}: ResultsPanelProps) {
  const [mobileToolsCollapsed, setMobileToolsCollapsed] = useState(false)
  const offers = results?.offers ?? []
  const meta = results?.searchMeta
  const isMigration = results?.request.searchMode === "month-view" || Boolean(results?.migrationMonths?.length)
  const isCancelled = results?.searchStatus === "cancelled"
  /*
   * 11 §3 separates «tarda» from «falla»: the first is a pill that goes away,
   * the second is a line of text. Keyed on `meta.partial` alone the pill spun
   * for ever whenever a provider fell over, because `partial` stays true after
   * the job completes — the search was said to be in progress long after it had
   * stopped. Progress is what the pill reports, so it lives exactly as long as
   * the search does, and the failure is left to the notice above.
   */
  const isPartial = loading && (Boolean(meta?.partial) || offers.length > 0)
  /* What became of the providers, read once here so the count, the column and
     the still-searching copy cannot tell three different stories. */
  const outcome = useMemo(() => describeSearchOutcome(results), [results])
  const passengerCount = passengerCountForRequest(results?.request)
  const showPerPerson = canShowPerPersonForRequest(results?.request)

  const visibleMobileToolsCollapsed = mobileCollapseEnabled && mobileToolsCollapsed
  /* 1i and 2f give the sweep its own two facts in the header — months with a
     fare, and the range of prices. Computed once here so the grid below has one
     header above it instead of a second one of its own. */
  const sweep = isMigration && results ? migrationSweepSummary(results, offers) : null

  /*
   * What the agent asked to see, as opposed to what the providers have sent so
   * far. Only a gesture changes it — a filter, a sort — so it is what the list
   * cross-fades on and what returns the pager to page 1 (04 §2/§6, 11 §3).
   *
   * Deriving that from the offers instead was a real defect: a progressive
   * search appends offers, which would have re-keyed the list and rebuilt every
   * card the agent was already reading.
   */
  const viewKey = useMemo(
    () => [sort, ...activeFilterChips.map((chip) => chip.id)].join("|"),
    [activeFilterChips, sort],
  )

  useEffect(() => {
    onMobileToolsCollapsedChange?.(visibleMobileToolsCollapsed)
  }, [onMobileToolsCollapsedChange, visibleMobileToolsCollapsed])

  /*
   * Plate 8a: the list column is not a card. Filters and detail are panels
   * because they sit beside the list; the list itself is the page, so wrapping
   * it in a second card put a border between the agent and the results.
   *
   * The header has two shapes and one job. On a desk (04 §3) it is title +
   * count + state pill on the left and the order on the right. On a phone it
   * collapses to the 32px status row of plate 1d — no title, because there is
   * nothing else on screen to tell it apart from — and that row is the one
   * thing that never retracts.
   */
  return (
    <section className="fd-list-shell" aria-busy={loading}>
      <div className="fd-list-header">
        <div className="fd-list-header-lead">
          <h2 className="fd-list-title">{isMigration ? "Vuelo migratorio" : "Resultados"}</h2>
          {sweep ? (
            <span className="fd-panel-count">
              {sweep.priced} de {sweep.monthCount} {sweep.monthCount === 1 ? "mes" : "meses"}
              <span className="fd-month-count-tail"> con tarifa</span>
            </span>
          ) : (
            <ResultCount
              visible={offers.length}
              total={unfilteredOfferCount}
              loading={loading}
              hasResults={Boolean(results)}
              searchFailed={outcome.allFailed || outcome.jobFailed}
            />
          )}
          {/* A sweep says how many months are still out rather than that it is
              «Parcial»: on this view the unit of progress is the month (1i). */}
          {sweep && sweep.searching > 0 && (
            <span className="fd-status-pill">
              <Spinner size={12} />
              {sweep.searching} buscando
            </span>
          )}
          {isPartial && !sweep && (
            <span className="fd-status-pill">
              <Spinner size={12} />
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

        {/* 1i puts the sweep's price range where an ordinary list puts the
            order — there is nothing to sort here, every month is one fare. On a
            phone 2f keeps it in the same row, which is what this already is. */}
        {sweep && (
          <div className="fd-list-header-trail">
            <span className="fd-result-sort-label fd-type-micro">Rango</span>
            <span className="fd-month-range">{sweep.range}</span>
            <span className="fd-month-range fd-month-range--short">{sweep.rangeShort}</span>
          </div>
        )}

        {!isMigration && (
          <div className="fd-list-header-trail">
            <span className="fd-result-sort-label fd-type-micro">Ordenar</span>
            <SegmentedControl
              aria-label="Orden de resultados"
              value={sort}
              className="fd-result-sort-segmented"
              onValueChange={(value) => {
                if (value === "cheapest" || value === "fastest") onSort(value)
              }}
            >
              <SegmentedOption value="cheapest" aria-label="Ordenar por precio">Precio</SegmentedOption>
              <SegmentedOption value="fastest" aria-label="Ordenar por duración">Duración</SegmentedOption>
            </SegmentedControl>
            {/* Plate 1d: a 32px status row has no space for a segmented, so the
                two modes collapse into whichever is on and tapping swaps them.
                The order never disappears on a phone — 02 §5 lists what may,
                and this is not on the list. */}
            <button
              type="button"
              className="fd-result-sort-compact fd-focus-ring"
              aria-label={`Ordenar por ${sort === "cheapest" ? "duración" : "precio"}`}
              onClick={() => onSort(sort === "cheapest" ? "fastest" : "cheapest")}
            >
              <AppIcon name="sort" size={14} />
              {sort === "cheapest" ? "Precio" : "Duración"}
            </button>
            {/* 02 §9 step 6: once the tools retract, the status row grows a
                26px filter button so the filters are never out of reach. */}
            {onOpenFilters && (
              <ShortcutTooltip label="Abrir filtros" shortcut={<Kbd>F</Kbd>}>
                <button
                  type="button"
                  className="fd-status-row-filters fd-focus-ring"
                  data-collapsed={visibleMobileToolsCollapsed}
                  aria-label="Abrir filtros"
                  onClick={onOpenFilters}
                >
                  <AppIcon name="filters" size={14} />
                </button>
              </ShortcutTooltip>
            )}
          </div>
        )}
      </div>

      {chipsPlacement === "list" && (
        <ActiveFilterChips
          chips={activeFilterChips}
          activeFilterCount={activeFilterChips.length}
          hiddenByFiltersCount={hiddenByFiltersCount}
          onRemoveFilter={onRemoveFilter}
        />
      )}

      <ResultsBody
        results={results}
        outcome={outcome}
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
        emptyByFilters={emptyByFilters}
        onEditSearch={onEditSearch}
        onOpenMigrationMonth={onOpenMigrationMonth}
        activeFilterChips={activeFilterChips}
        viewKey={viewKey}
        onMobileToolsCollapsedChange={setMobileToolsCollapsed}
        mobileCollapseEnabled={mobileCollapseEnabled}
      />
    </section>
  )
}

function ResultCount({
  visible,
  total,
  loading,
  hasResults,
  searchFailed,
}: {
  visible: number
  total: number
  loading: boolean
  hasResults: boolean
  /** Nothing was searched, so there is no count to state — only a notice. */
  searchFailed: boolean
}) {
  if (visible === 0) {
    if (loading || searchFailed) return null
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
  outcome,
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
  emptyByFilters,
  onEditSearch,
  onOpenMigrationMonth,
  activeFilterChips,
  viewKey,
  onMobileToolsCollapsedChange,
  mobileCollapseEnabled,
}: {
  results: SearchJobResponse | null
  outcome: SearchOutcome
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
  emptyByFilters?: EmptyByFiltersCopy
  onEditSearch?: () => void
  onOpenMigrationMonth?: (month: DisplayMonth) => void
  activeFilterChips: ActiveFilterChip[]
  viewKey: string
  onMobileToolsCollapsedChange: (collapsed: boolean) => void
  mobileCollapseEnabled: boolean
}) {
  const stillSearching = useSkeletonTimeout(
    loading && offers.length === 0,
    results?.searchJobId ?? "pending",
  )
  const reducedMotion = usePrefersReducedMotion()
  /*
   * One measurement, two consumers. The page of results and the skeleton that
   * stands in for it are drawn in the same column and have to hold the same
   * number of rows, so the count is taken once here — above the branch that
   * chooses between them — rather than by each of them separately. The skeleton
   * is what proves it matters: it renders before a single result exists, and
   * for as long as it carried a constant of its own it filled half a column its
   * own results were about to fill.
   */
  const resultItems = useMemo(
    () => buildResultListItems(offers, results?.scheduleGroups),
    [offers, results?.scheduleGroups],
  )
  /* Capacity is measured in card-heights, so what bounds it is the list's total
     *weight*, not how many items it has: a group card costs 1.67. */
  const totalDisplayWeight = useMemo(
    () => resultItems.reduce((total, item) => total + resultListItemDisplayWeight(item), 0),
    [resultItems],
  )
  const { pageBudget, columnRows, viewportRef, attachViewport } = useAdaptiveResultsPageCapacity(
    totalDisplayWeight,
    mobileCollapseEnabled,
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
        onOpenMonth={onOpenMigrationMonth}
      />
    )
  }

  /*
   * 04 §7 and 11 §3: a search with nothing to show yet is the skeleton, and at
   * eight seconds the state is *also* said with words — a status line above the
   * bones, not instead of them. The words come from the diagnostics rather than
   * from the timer that raised them: the old copy asserted in the plural that
   * «los proveedores están tardando», which was simply false when one of the
   * two had already failed.
   *
   * The one case that still belongs to words alone is a reader who has asked
   * for no movement. 04 §7's skeleton is a *pulse*: reduced motion stops it
   * (rule 5 of the movement system), and a field of grey blocks that does not
   * breathe says nothing about progress — it reads as a page that failed to
   * paint. There the notice is the whole message, so it takes the column.
   */
  if (loading && offers.length === 0) {
    if (stillSearching && reducedMotion) {
      return (
        <EmptyState
          icon="clock"
          title="La búsqueda sigue en curso"
          body={stillSearchingBody(outcome)}
        />
      )
    }

    return (
      <ResultsSkeleton
        rows={columnRows}
        attachViewport={attachViewport}
        searchingNotice={stillSearching ? stillSearchingBody(outcome) : undefined}
      />
    )
  }

  if (offers.length === 0 && results) {
    // Plate 2g: an empty list caused by filters names the filter to blame and
    // offers two ways out. An empty list with no filters on is a different
    // problem and gets different words.
    const filteredEmpty = unfilteredOfferCount > 0 || (results.allOffers?.length ?? 0) > 0

    if (filteredEmpty) {
      const count = activeFilterChips.length
      return (
        <EmptyState
          icon="filtersOff"
          title={count === 1
            ? "Ningún vuelo cumple el filtro"
            : `Ningún vuelo cumple los ${spellOutCount(count)} filtros`}
          body={filteredEmptyBody(unfilteredOfferCount, emptyByFilters?.culpritSentence)}
          action={onClearFilters
            ? {
                label: count === 1 ? "Quitar el filtro" : `Quitar los ${count} filtros`,
                onClick: onClearFilters,
              }
            : undefined}
          secondaryAction={emptyByFilters?.relax}
        />
      )
    }

    /*
     * Nobody answered. 04 §8 keeps the reason in the one-line notice above, but
     * the column underneath still has to say something, and «Sin resultados
     * para esta consulta · Ajusta fechas, escalas, equipaje o aerolíneas» was
     * the wrong something: it asks the agent to widen a search that never ran.
     */
    if (outcome.allFailed || (outcome.jobFailed && outcome.failed.length > 0)) {
      return (
        <EmptyState
          icon="alert"
          title="No se pudo consultar a los proveedores"
          body={`${failureSentences(outcome).join(" ")} La búsqueda no llegó a ejecutarse, así que esta ruta puede tener vuelos.`}
          action={onEditSearch ? { label: "Volver a editar la búsqueda", onClick: onEditSearch, icon: "search" } : undefined}
        />
      )
    }

    if (outcome.jobFailed && results.error) {
      return (
        <EmptyState
          icon="alert"
          title="La búsqueda no se pudo completar"
          body={results.error}
          action={onEditSearch ? { label: "Volver a editar la búsqueda", onClick: onEditSearch, icon: "search" } : undefined}
        />
      )
    }

    // 04 §8, «vacío por búsqueda»: mensaje + volver a editar la búsqueda.
    return (
      <EmptyState
        icon="sort"
        title="Sin resultados para esta consulta"
        body="Ajusta fechas, escalas, equipaje o aerolíneas para ampliar la cobertura."
        action={onEditSearch ? { label: "Volver a editar la búsqueda", onClick: onEditSearch, icon: "search" } : undefined}
      />
    )
  }

  return (
    <ResultsPage
      offers={offers}
      resultItems={resultItems}
      pageBudget={pageBudget}
      columnRows={columnRows}
      viewportRef={viewportRef}
      attachViewport={attachViewport}
      passengerCount={passengerCount}
      showPerPerson={showPerPerson}
      selectedOfferId={selectedOfferId}
      onSelectOffer={onSelectOffer}
      partial={loading}
      viewKey={viewKey}
      onMobileToolsCollapsedChange={onMobileToolsCollapsedChange}
      mobileCollapseEnabled={mobileCollapseEnabled}
    />
  )
}

/**
 * How many results the search *does* hold, and — when it can be worked out —
 * which filter is throwing most of them away. The second sentence is omitted
 * rather than guessed: naming the wrong culprit sends the agent to undo a
 * filter that was not the problem.
 */
function filteredEmptyBody(totalCount: number, culpritSentence?: string): string {
  const held = `Hay ${totalCount.toLocaleString("es-PE")} ${totalCount === 1 ? "resultado" : "resultados"} en esta búsqueda.`
  return culpritSentence ? `${held} ${culpritSentence}` : held
}

/** Plate 2g writes the count as a word in the title and as a figure in the button. */
const COUNT_WORDS = ["cero", "un", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve"]

function spellOutCount(count: number): string {
  return COUNT_WORDS[count] ?? String(count)
}

function ResultsPage({
  offers,
  resultItems,
  pageBudget,
  columnRows,
  viewportRef,
  attachViewport,
  passengerCount,
  showPerPerson,
  selectedOfferId,
  onSelectOffer,
  partial,
  viewKey,
  onMobileToolsCollapsedChange,
  mobileCollapseEnabled,
}: {
  offers: CanonicalOffer[]
  /** Built above, so the skeleton and the page weigh the same list. */
  resultItems: ResultListItem[]
  /** Fractional: a group costs 1.67 of it, so flooring here withholds cards. */
  pageBudget: number
  /** Whole rows, for the things that draw rows rather than fill a column. */
  columnRows: number
  viewportRef: RefObject<HTMLDivElement | null>
  attachViewport: (node: HTMLDivElement | null) => void
  passengerCount: number
  showPerPerson: boolean
  selectedOfferId?: string
  onSelectOffer: (offer: CanonicalOffer) => void
  partial: boolean
  viewKey: string
  onMobileToolsCollapsedChange: (collapsed: boolean) => void
  mobileCollapseEnabled: boolean
}) {
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
    () => paginateResultListItems(resultItems, pageBudget),
    [resultItems, pageBudget],
  )
  const pageCount = Math.max(1, pages.length)
  const selectedPageIndex = useMemo(() => {
    if (!selectedOfferId) return
    const index = pages.findIndex((page) => page.items.some((item) => resultListItemContainsOffer(item, selectedOfferId)))
    return index >= 0 ? index : undefined
  }, [pages, selectedOfferId])

  /*
   * 11 §3: every filter and sort gesture returns the list to page 1 — but a
   * provider answering does not. Keyed on `viewKey` rather than on the offers,
   * so a progressive batch leaves the page where the agent left it.
   *
   * The exception is the first view: a shared link arrives with an offer
   * already selected, and opening on page 1 would hide the flight the link was
   * sent about.
   */
  const [firstViewKey] = useState(viewKey)
  const isFirstView = firstViewKey === viewKey

  const requestedPageIndex = pageState.key === viewKey
    ? pageState.index
    : isFirstView
      ? selectedPageIndex ?? 0
      : 0
  const safePageIndex = Math.max(0, Math.min(requestedPageIndex, pageCount - 1))
  const currentPage = pages[safePageIndex] ?? pages[0] ?? { items: [], startOfferIndex: 0, endOfferIndex: 0, displayWeight: 0 }
  const scrollStateRef = useRef({
    lastTop: 0,
    accumulated: 0,
    direction: 0,
    lockedUntil: 0,
    collapsed: false,
  })
  /* 02 §9, last paragraph: past 300px of list scroll a way back to the top
     appears. It belongs to the same mobile block as the retraction — on a desk
     the list is short enough and the wheel is fast enough that it would be one
     more thing floating over the results. */
  const [backToTopVisible, setBackToTopVisible] = useState(false)

  const handlePageChange = useCallback((nextPageIndex: number) => {
    setPageState({ key: viewKey, index: Math.max(0, Math.min(nextPageIndex, pageCount - 1)) })
    // 02 §11: back to the top with no animated scroll (07 §0 rule 2).
    viewportRef.current?.scrollTo({ top: 0 })
    scrollStateRef.current = {
      lastTop: 0,
      accumulated: 0,
      direction: 0,
      lockedUntil: 0,
      collapsed: false,
    }
    setBackToTopVisible(false)
    onMobileToolsCollapsedChange(false)
  }, [onMobileToolsCollapsedChange, pageCount, viewKey, viewportRef])

  const handleBackToTop = useCallback(() => {
    viewportRef.current?.scrollTo({ top: 0 })
    setBackToTopVisible(false)
  }, [viewportRef])

  const handleResultsScroll = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const top = viewport.scrollTop
    if (!mobileCollapseEnabled) return
    setBackToTopVisible(top > BACK_TO_TOP_AFTER_PX)
    const state = scrollStateRef.current
    const now = performance.now()
    const delta = top - state.lastTop
    state.lastTop = top

    if (top <= 0) {
      state.accumulated = 0
      state.direction = 0
      if (state.collapsed) {
        state.collapsed = false
        state.lockedUntil = now + 300
        onMobileToolsCollapsedChange(false)
      }
      return
    }
    if (now < state.lockedUntil || Math.abs(delta) < 1) return

    const direction = delta > 0 ? 1 : -1
    if (direction !== state.direction) {
      state.direction = direction
      state.accumulated = 0
    }
    state.accumulated += Math.abs(delta)
    if (state.accumulated < 88) return

    const nextCollapsed = direction > 0
    state.accumulated = 0
    if (nextCollapsed === state.collapsed) return
    state.collapsed = nextCollapsed
    state.lockedUntil = now + 300
    onMobileToolsCollapsedChange(nextCollapsed)
  }, [mobileCollapseEnabled, onMobileToolsCollapsedChange, viewportRef])

  useEffect(() => {
    scrollStateRef.current = {
      lastTop: 0,
      accumulated: 0,
      direction: 0,
      lockedUntil: 0,
      collapsed: false,
    }
    onMobileToolsCollapsedChange(false)
  }, [onMobileToolsCollapsedChange, pageKey])

  return (
    <div className="fd-list-body" data-testid="results-page-shell">
      <div
        ref={attachViewport}
        onScroll={handleResultsScroll}
        className="fd-list-viewport"
        data-testid="results-page-body"
      >
        {/* Keyed on the requested view *and* the page, so a filter, a sort
            and a page change each cross-fade in 140ms rather than animating a
            height (rule 2). Keyed on the page alone, applying a filter swapped
            the cards with no transition at all, because the page index usually
            stays at 0 (04 §2).

            The cascade of 04 §9 belongs to *arrival* — the first page of a new
            search. A filter, a sort and a page change are repaints, and 04 §2
            and §6 give those the cross-fade alone; replaying seven staggered
            entries on every filter click turns a refinement into an event. */}
        <div
          key={`${viewKey}:${safePageIndex}`}
          className="fd-results-list fd-motion-crossfade"
          data-cascade={isFirstView && safePageIndex === 0}
        >
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
          {partial && currentPage.items.length > 0 && currentPage.items.length < columnRows && (
            <ResultsSkeleton
              rows={columnRows - currentPage.items.length}
              inline
              startDelayIndex={currentPage.items.length}
            />
          )}
        </div>
      </div>

      {mobileCollapseEnabled && backToTopVisible && (
        <button
          type="button"
          className="fd-back-to-top fd-motion-emergente fd-focus-ring"
          aria-label="Volver al inicio de la lista"
          data-testid="results-back-to-top"
          onClick={handleBackToTop}
        >
          <AppIcon name="chevronUp" size={18} />
        </button>
      )}

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
    /* The panel of 3b opens `absolute` out of this row and has to cover the
       cards below it. Its own `z-30` only orders it inside this row, so the row
       has to win against its siblings too — while any of them is a stacking
       context (the entrance cascade makes every row one for the length of its
       movement, and progressive results can start a fresh one over an open
       panel), a row at `z-index: auto` loses to whatever comes after it in the
       list. Only while open: a permanent z-index would order the whole list
       against itself for a panel that is not there. */
    <div className={cn("relative min-w-0", expanded && "z-30")}>
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
    /* Never on, by construction. 04 §5's «el chip elegido queda activo» lands
       in the full list (`3b`), which draws every schedule including the current
       one; the strip on the card is labelled «N horarios más» and holds only
       the ones the card is not showing, so the chosen schedule is the card
       itself. A chip marked active here would be a fourth schedule that does
       not exist. */
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
      {/* Two modes, one component (04 §6). The nested control needs room for
          seven 26px cells and two ellipses; a phone has neither the room nor a
          finger fine enough for a 26px target, so below the list threshold it
          is replaced by ‹ · 6/65 · › at the touch minimum. Both are always in
          the DOM: which one shows is a container query, so the choice follows
          the width of the list and not a guess about the device. */}
      <div className="fd-pager-nested">
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

      <div className="fd-pager-compact" data-testid="results-pagination-compact">
        <button
          type="button"
          className="fd-pager-step fd-focus-ring"
          aria-label="Página anterior"
          disabled={pageIndex <= 0}
          onClick={() => onPageChange(pageIndex - 1)}
        >
          <AppIcon name="chevronLeft" size={18} />
        </button>
        <span className="fd-pager-position" aria-current="page">
          {pageIndex + 1} / {pageCount}
        </span>
        <button
          type="button"
          className="fd-pager-step fd-focus-ring"
          aria-label="Página siguiente"
          disabled={pageIndex >= pageCount - 1}
          onClick={() => onPageChange(pageIndex + 1)}
        >
          <AppIcon name="chevronRight" size={18} />
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

type EmptyStateAction = { label: string; onClick: () => void; icon?: "x" | "search" }

function EmptyState({
  icon,
  title,
  body,
  action,
  secondaryAction,
}: {
  icon: "flight" | "x" | "sort" | "filtersOff" | "clock" | "alert"
  title: string
  body: string
  /**
   * The whole way out. Dropping every filter carries the `x`, like every
   * remove; going back to edit the search (04 §8) is not a removal, so it
   * carries the search glyph instead.
   */
  action?: EmptyStateAction
  /** The lesser way out: relax the one filter to blame (plate 2g). */
  secondaryAction?: EmptyStateAction
}) {
  return (
    <div className="fd-list-empty">
      <div className="fd-list-empty-inner">
        <span className="fd-list-empty-icon">
          <AppIcon name={icon} size={18} />
        </span>
        <h3 className="fd-list-empty-title">{title}</h3>
        <p className="fd-list-empty-body">{body}</p>
        {(action || secondaryAction) && (
          <div className="fd-list-empty-actions">
            {action && (
              <button type="button" className="fd-list-empty-action fd-focus-ring" onClick={action.onClick}>
                <AppIcon name={action.icon ?? "x"} size={14} />
                {action.label}
              </button>
            )}
            {secondaryAction && (
              <button
                type="button"
                className="fd-list-empty-action fd-list-empty-action--secondary fd-focus-ring"
                onClick={secondaryAction.onClick}
              >
                {secondaryAction.label}
              </button>
            )}
          </div>
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
 * Whether the reader has asked for no movement.
 *
 * 07 §0 rule 5 stops the skeleton's pulse under this preference, which leaves a
 * field of static grey blocks — a drawing of a list, not a claim that one is
 * arriving. It is the one state where the words carry the whole message, so it
 * is the one state where they take the column instead of standing above it.
 */
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

function subscribeToReducedMotion(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined

  const query = window.matchMedia(REDUCED_MOTION_QUERY)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

function readReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION_QUERY).matches
}

function usePrefersReducedMotion(): boolean {
  /* The preference is external state, not a render of ours: subscribing to it
     is what `useSyncExternalStore` is for, and it reads the media query on the
     first render rather than a frame later — which for this branch would be a
     frame of skeleton under a preference that asked for none. */
  return useSyncExternalStore(subscribeToReducedMotion, readReducedMotion, () => false)
}

/**
 * How many cards fit without cutting one in half. A page that ends mid-card
 * makes the agent scroll to find out whether there was anything there.
 */
/**
 * How many results a page holds.
 *
 * On a desk it is whatever fits: plates 1b and 8a draw the list ending on the
 * pager with no scroll, and the measurement agrees — 11 cards at 1440 leave 1px
 * of slack. A phone is the opposite. Plate `1d` is annotated «interactiva:
 * desliza la lista», 02 §9 retracts the tools after **88px** of travel and 11 §6
 * raises the back-to-top button after **300px**. Fitted to the viewport the
 * mobile list had 43px of travel in total (6 cards of 94px in 583px), so both
 * of those were unreachable outside a test that injected a spacer. A page that
 * is longer than the screen is what makes that whole section of the handoff
 * exist; the pager (`‹ 6/65 ›`, 04 §6) is unchanged either way.
 */
function useAdaptiveResultsPageCapacity(totalDisplayWeight: number, scrollableList: boolean) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  /*
   * The column is measured through a callback ref rather than read off
   * `viewportRef.current` alone, because the element the count belongs to is
   * swapped under this hook: the skeleton owns it first and the page takes it
   * over. Keyed on the weight, a search that starts from an empty column — no
   * results, then bones, both weighing nothing — would attach a new viewport
   * without ever re-running the measurement and the page would keep the
   * fallback of four. The node is state, so a new one is a new measurement.
   */
  const [viewportNode, setViewportNode] = useState<HTMLDivElement | null>(null)
  const attachViewport = useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node
    setViewportNode(node)
  }, [])
  const [pageBudget, setPageBudget] = useState(RESULTS_PAGE_SIZE_FALLBACK)
  const rowHeightRef = useRef(RESULTS_CARD_HEIGHT_ESTIMATE_PX)

  useLayoutEffect(() => {
    /* Nothing to measure when the page is deliberately taller than the screen:
       the answer is the ceiling, and it is returned below rather than stored,
       so a phone never pays for a measurement it does not use. */
    if (scrollableList) return

    const node = viewportNode
    if (!node) return

    let frame = 0
    const update = () => {
      const list = node.querySelector<HTMLElement>(".fd-results-list")
      const availableHeight = Math.max(0, node.clientHeight - RESULTS_LIST_TOP_INSET_PX)
      /*
       * Real cards when there are any, skeleton rows when there are not. The
       * skeleton is this card with the data switched off and stands at the same
       * height by construction, which is what lets the count survive the
       * handover: the column the bones were counted into is the column the
       * results land in.
       */
      const realCards = list ? Array.from(list.querySelectorAll<HTMLElement>(".fd-card:not(.fd-card--skeleton)")) : []
      const cards = realCards.length > 0
        ? realCards
        : list ? Array.from(list.querySelectorAll<HTMLElement>(".fd-card")) : []
      const listStyle = list ? window.getComputedStyle(list) : null
      const measuredGap = listStyle
        ? Number.parseFloat(listStyle.rowGap || listStyle.gap || `${RESULTS_CARD_GAP_PX}`)
        : RESULTS_CARD_GAP_PX
      const gap = Number.isFinite(measuredGap) ? measuredGap : RESULTS_CARD_GAP_PX
      /*
       * The unit is the plain card, because that is what a weight of 1 means.
       * Taking the tallest card instead made one group card — 101px against 58
       * — the row height for the whole page: capacity fell from eleven rows to
       * six and the list stopped less than two thirds of the way down the
       * column, which is exactly the empty space the desk was reported with.
       * A page of nothing but groups is rare, and dividing by the group weight
       * recovers the same unit from it.
       */
      const plainCards = cards.filter((card) => !card.querySelector(".fd-card__alts"))
      const measuredHeight = plainCards.length > 0
        ? Math.min(...plainCards.map((card) => card.getBoundingClientRect().height))
        : cards.reduce(
          (min, card) => Math.min(min, card.getBoundingClientRect().height / RESULT_GROUP_CARD_WEIGHT),
          Number.POSITIVE_INFINITY,
        )
      if (Number.isFinite(measuredHeight) && measuredHeight > 0
        && Math.abs(measuredHeight - rowHeightRef.current) > 1) {
        rowHeightRef.current = measuredHeight
      }

      const rowHeight = rowHeightRef.current
      /*
       * The budget is fractional, and the floor that used to be here was a
       * defect with a group on the page.
       *
       * `fullRows` is a count of *plain* rows, so flooring it is only harmless
       * when every row is plain. A column of 687 holds 10.76 plain rows; floored
       * to 10 it can pay for one group (1.67) and eight flights (9.67 of 10) and
       * refuses a ninth at 10.67 — while in pixels that ninth card had 80px of
       * empty column under it, more than the 64 it needed. Two roundings in a
       * row, each losing less than a row, together losing more than one.
       *
       * Kept whole, the same budget pays for the group and nine flights (10.67
       * of 10.76) and the column closes with 16px to spare. Nothing else has to
       * change: weighing rows against a budget is what the weight system is
       * already for, and it was only ever handed an integer.
       */
      const columnBudget = Math.max(1, (availableHeight + gap) / (rowHeight + gap))
      /*
       * Never claim more room than the list needs — but «what the list needs»
       * is its weight, not its length. Clamping to the item count split a page
       * of one flight and one group of thirteen across two pages: two items,
       * capacity two, weight 2.34. A real LIM–MIA search showed one card and
       * eleven empty rows.
       *
       * A search with nothing in it yet needs *everything* the column holds:
       * that is the skeleton, and it has no weight to be clamped by.
       */
      const needed = totalDisplayWeight > 0 ? totalDisplayWeight : RESULTS_PAGE_SIZE_MAX
      const next = Math.max(1, Math.min(needed, RESULTS_PAGE_SIZE_MAX, columnBudget))

      setPageBudget((current) => Math.abs(current - next) < 0.01 ? current : next)
    }
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(update)
    }

    /*
     * Measured now, not on the next frame. The rAF was the whole of the live
     * defect: on the skeleton's first mount, and again when the arriving
     * `searchJobId` re-keys this panel, the column was painted at
     * `RESULTS_PAGE_SIZE_FALLBACK` and only corrected a frame later — four
     * bones in a column that holds eleven, and a page of three cards under a
     * pager that had counted twelve offers. Inside a layout effect the DOM is
     * laid out and `clientHeight` is final, so the first answer is available
     * before the first paint; the frame is only needed to coalesce the
     * observer's later ones.
     */
    update()

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
  }, [scrollableList, totalDisplayWeight, viewportNode])

  /*
   * Two answers from one measurement, because they are two different questions.
   * Pagination fills a column and asks for the whole budget; the skeleton and
   * the partial-search filler draw rows and can only ask for whole ones.
   */
  const budget = scrollableList ? RESULTS_PAGE_SIZE_MAX : pageBudget

  return {
    pageBudget: budget,
    columnRows: Math.max(1, Math.floor(budget + 0.01)),
    viewportRef,
    attachViewport,
  }
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
