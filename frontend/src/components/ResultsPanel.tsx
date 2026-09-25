import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react"
import { ResultCard, type AlternateSchedule } from "@/components/results/ResultCard"
import { buildAlternateScheduleModel } from "@/components/results/result-card-model"
import {
  RESULT_GROUP_CARD_WEIGHT,
  buildResultListItems,
  resultItemsFillingCapacity,
  resultListItemContainsOffer,
  type ResultListItem,
  type ResultOfferGroup,
} from "@/components/results/result-groups"
import { AllSchedulesPanel } from "@/components/results/AllSchedulesPanel"
import { MigrationMonthGrid } from "@/components/results/MigrationMonthGrid"
import { migrationSweepSummary, type DisplayMonth } from "@/components/results/migration-month-model"
import { ResultsSkeleton } from "@/components/results/ResultsSkeleton"
import { AppIcon } from "@/components/ui/app-icon"
import { Spinner } from "@/components/ui/spinner"
import { Kbd } from "@/components/ui/kbd"
import { ShortcutTooltip } from "@/components/ui/tooltip"
import { formatCount } from "@/lib/format"
import { passengerCount as countPassengers, showsPerPersonPrice } from "@/lib/passengers"
import { failureSentences, type SearchOutcome } from "@/lib/search-outcome"
import { cn } from "@/lib/utils"
import { SORT_MODES, type CanonicalOffer, type SearchJobResponse, type SortMode } from "@/types"

/*
 * Plates 1b (active desktop), 2g (list states), 3b (all schedules), 4a
 * (skeletons) and 1i (migration grid): one header, one column header and one
 * list that grows as it is scrolled.
 */

/* A guard against a pathological viewport: a 1440-tall column fits 19 rows. */
const RESULTS_COLUMN_ROWS_MAX = 20
const RESULTS_COLUMN_ROWS_FALLBACK = 4
/* The window opens on what the column fits and grows by two columns, so a
   flick of the thumb never reaches the sentinel; this is the floor. */
const RESULTS_WINDOW_MIN_BATCH = 12
/* A batch is a render, not a fetch: one column of slack covers its frame. */
const RESULTS_WINDOW_PREFETCH_PX = 900
/* The plain row of plate 1b; the first frame measures the real one. */
const RESULTS_CARD_HEIGHT_ESTIMATE_PX = 52
const RESULTS_CARD_GAP_PX = 0
const RESULTS_LIST_TOP_INSET_PX = 4
/* 02 §9: the way back to the top appears past 300px of list scroll. */
const BACK_TO_TOP_AFTER_PX = 300

export type ActiveFilterChip = {
  id: string
  label: string
}

/** What ↑/↓ reach: the offer one row away from the selection, drawn and in view. */
export type ResultsNavigation = {
  step: (direction: 1 | -1) => string | undefined
}

/** Plate 2g: the filter to blame and the way to relax it, when they can be told. */
export type EmptyByFiltersCopy = {
  culpritSentence?: string
  relax?: { label: string; onClick: () => void }
}

interface ResultsPanelProps {
  results: SearchJobResponse | null
  /** What the list draws: the search filtered by the rail and in the chosen order. */
  offers: CanonicalOffer[]
  /** The sweep's months after the filters; `null` when the search is not a sweep. */
  months: DisplayMonth[] | null
  outcome: SearchOutcome
  unfilteredOfferCount: number
  loading: boolean
  sort: SortMode
  onSort: (sort: SortMode) => void
  onSelectOffer: (offerId: string) => void
  selectedOfferId?: string
  activeFilterChips: ActiveFilterChip[]
  hiddenByFiltersCount: number
  onClearFilters: () => void
  emptyByFilters?: EmptyByFiltersCopy
  /** 04 §8's exit for «vacío por búsqueda»: back to editing the search. */
  onEditSearch: () => void
  onOpenMigrationMonth: (month: DisplayMonth) => void
  /** Armazón C: the status row carries the filters and the list retracts the tools. */
  phone: boolean
  onOpenFilters: () => void
  mobileToolsCollapsed: boolean
  onMobileToolsCollapsedChange: (collapsed: boolean) => void
  navigationRef: RefObject<ResultsNavigation | null>
}

function ResultsPanelBase({
  results,
  offers,
  months,
  outcome,
  unfilteredOfferCount,
  loading,
  sort,
  onSort,
  onSelectOffer,
  selectedOfferId,
  activeFilterChips,
  hiddenByFiltersCount,
  onClearFilters,
  emptyByFilters,
  onEditSearch,
  onOpenMigrationMonth,
  phone,
  onOpenFilters,
  mobileToolsCollapsed,
  onMobileToolsCollapsedChange,
  navigationRef,
}: ResultsPanelProps) {
  const sectionRef = useRef<HTMLElement | null>(null)
  const listNavigationRef = useRef<ResultsNavigation | null>(null)
  /* The month a key moved to, scrolled into view once it is the selection. */
  const monthRevealRef = useRef<string | null>(null)
  const meta = results?.searchMeta
  const isCancelled = results?.searchStatus === "cancelled"
  /* 11 §3: the pill reports progress and lives as long as the search does;
     `partial` stays true after a provider failure, which the notice reports. */
  const isPartial = loading && (Boolean(meta?.partial) || offers.length > 0)
  const sweep = useMemo(() => (months ? migrationSweepSummary(months) : null), [months])

  /* What the agent asked to see: a filter or a sort, values included, and not
     the offers a progressive search appends. The list scrolls to its top and
     cross-fades on this and nothing else. */
  const viewKey = useMemo(
    () => [sort, ...activeFilterChips.map((chip) => `${chip.id}=${chip.label}`)].join("|"),
    [activeFilterChips, sort],
  )

  useImperativeHandle(navigationRef, () => ({
    step(direction) {
      if (!months) return listNavigationRef.current?.step(direction)
      const monthOfferIds = months.flatMap((month) => (month.offer ? [month.offer.id] : []))
      const next = stepThrough(monthOfferIds, selectedOfferId, direction)
      monthRevealRef.current = next ?? null
      return next
    },
  }), [months, selectedOfferId])

  useLayoutEffect(() => {
    const offerId = monthRevealRef.current
    if (!offerId || offerId !== selectedOfferId) return
    monthRevealRef.current = null
    revealOffer(sectionRef.current, offerId)
  }, [selectedOfferId])

  return (
    <section ref={sectionRef} className="fd-list-shell" aria-busy={loading}>
      <div className="fd-list-header">
        <div className="fd-list-header-lead">
          <h2 className="fd-list-title">{months ? "Vuelo migratorio" : "Resultados"}</h2>
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
              hiddenByFilters={phone ? 0 : hiddenByFiltersCount}
            />
          )}
          {sweep && sweep.searching > 0 && (
            <span className="fd-status-pill">
              <Spinner size={12} />
              {/* One element: the pill is `inline-flex` and would drop the space. */}
              <span>
                <span className="fd-count">{sweep.searching}</span> buscando
              </span>
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

        {sweep && (
          <div className="fd-list-header-trail">
            <span className="fd-result-sort-label fd-type-micro">Rango</span>
            <span className="fd-month-range">{sweep.range}</span>
            <span className="fd-month-range fd-month-range--short">{sweep.rangeShort}</span>
          </div>
        )}

        {!months && (
          <div className="fd-list-header-trail">
            {/* The desk sorts from the column header; a phone has none. */}
            <SortCompactButton sort={sort} onSort={onSort} />
            {phone && (
              <ShortcutTooltip label="Abrir filtros" shortcut={<Kbd>F</Kbd>}>
                <button
                  type="button"
                  className="fd-status-row-filters fd-focus-ring"
                  data-collapsed={mobileToolsCollapsed}
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

      <ResultsBody
        sort={sort}
        onSort={onSort}
        results={results}
        offers={offers}
        months={months}
        outcome={outcome}
        loading={loading}
        isCancelled={isCancelled}
        unfilteredOfferCount={unfilteredOfferCount}
        selectedOfferId={selectedOfferId}
        onSelectOffer={onSelectOffer}
        onClearFilters={onClearFilters}
        emptyByFilters={emptyByFilters}
        onEditSearch={onEditSearch}
        onOpenMigrationMonth={onOpenMigrationMonth}
        activeFilterCount={activeFilterChips.length}
        viewKey={viewKey}
        onMobileToolsCollapsedChange={onMobileToolsCollapsedChange}
        phone={phone}
        navigationRef={listNavigationRef}
      />
    </section>
  )
}

/*
 * The phone's order control names the order in force and moves to the next of
 * `SORT_MODES` when pressed; its accessible name says what pressing does.
 */
const SORT_COMPACT_LABELS: Record<SortMode, string> = {
  cheapest: "Precio",
  fastest: "Duración",
  departure: "Salida",
  stops: "Escalas",
}

const SORT_CRITERIA: Record<SortMode, string> = {
  cheapest: "precio",
  fastest: "duración",
  departure: "hora de salida",
  stops: "número de escalas",
}

function SortCompactButton({ sort, onSort }: { sort: SortMode; onSort: (sort: SortMode) => void }) {
  const next = SORT_MODES[(SORT_MODES.indexOf(sort) + 1) % SORT_MODES.length] ?? "cheapest"
  return (
    <button
      type="button"
      className="fd-result-sort-compact fd-focus-ring"
      aria-label={`Ordenar por ${SORT_CRITERIA[next]}`}
      onClick={() => onSort(next)}
    >
      <AppIcon name="sort" size={14} />
      {SORT_COMPACT_LABELS[sort]}
    </button>
  )
}

/* The sortable columns in the order the header draws them. */
const HEAD_SORT_ORDER: SortMode[] = ["departure", "fastest", "stops", "cheapest"]

/**
 * The column header, carrying `.fd-card` so its lanes are the row's. The four
 * sortable columns are the radios of the order: one tab stop, arrows move and
 * choose, like every segmented control. The lanes that do not sort stay labels.
 */
const ResultsColumnHead = memo(function ResultsColumnHead({ sort, onSort }: { sort: SortMode; onSort: (sort: SortMode) => void }) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown"
      ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? -1
        : 0
    if (step === 0) return

    event.preventDefault()
    const current = HEAD_SORT_ORDER.indexOf(sort)
    const next = HEAD_SORT_ORDER[(current + step + HEAD_SORT_ORDER.length) % HEAD_SORT_ORDER.length]!
    onSort(next)
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-segment="${next}"]`)?.focus()
  }

  return (
    <div
      className="fd-card fd-card--head"
      role="radiogroup"
      aria-label="Orden de resultados"
      data-testid="results-column-head"
      onKeyDown={handleKeyDown}
    >
      <span aria-hidden="true" />
      <span className="fd-card__head-label">Aerolínea</span>
      <div className="fd-card__legs">
        <div className="fd-card__leg">
          <span className="fd-card__head-label">Tramo</span>
          <SortableColumnHead sort={sort} onSort={onSort} mode="departure" label="Horario" />
          <SortableColumnHead sort={sort} onSort={onSort} mode="fastest" label="Duración" align="end" />
          <SortableColumnHead sort={sort} onSort={onSort} mode="stops" label="Escalas" />
        </div>
      </div>
      <span className="fd-card__head-label fd-card__head-label--center">Eq.</span>
      <SortableColumnHead sort={sort} onSort={onSort} mode="cheapest" label="Precio" align="end" />
      <span className="fd-card__head-label fd-card__head-label--end">Prov.</span>
    </div>
  )
})

/*
 * The arrow on the ordering column costs 15px, which «Duración» cannot pay out
 * of its 66px lane: it overflows 5.89px into the 12px gap that follows rather
 * than widen the lane, which would move the 824px detail-column threshold a
 * 1440 desk sits on (`hooks/useShellSize.ts`).
 */
function SortableColumnHead({
  sort,
  onSort,
  mode,
  label,
  align,
}: {
  sort: SortMode
  onSort: (sort: SortMode) => void
  mode: SortMode
  label: string
  align?: "end"
}) {
  const active = sort === mode
  return (
    <button
      type="button"
      role="radio"
      data-segment={mode}
      aria-checked={active}
      aria-label={`Ordenar por ${SORT_CRITERIA[mode]}`}
      tabIndex={active ? 0 : -1}
      className={cn(
        "fd-card__head-label fd-card__head-sort fd-focus-ring",
        align === "end" && "fd-card__head-label--end",
      )}
      onClick={() => onSort(mode)}
    >
      {label}
      {active && <AppIcon name="arrowUp" size={12} />}
    </button>
  )
}

function ResultCount({
  visible,
  total,
  loading,
  hasResults,
  searchFailed,
  hiddenByFilters,
}: {
  visible: number
  total: number
  loading: boolean
  hasResults: boolean
  searchFailed: boolean
  /** Only where the phone's chip strip is not there to say it. */
  hiddenByFilters: number
}) {
  if (visible === 0) {
    if (loading || searchFailed) return null
    return <span className="fd-panel-count">{hasResults ? "sin vuelos visibles" : "sin consulta"}</span>
  }

  const label = total > visible
    ? `${formatCount(visible)} de ${formatCount(total)}`
    : formatCount(visible)

  return (
    <>
      <span className="fd-panel-count">{label}</span>
      {hiddenByFilters > 0 && (
        <span className="fd-list-hidden-count">
          {hiddenByFilters === 1
            ? "· 1 vuelo oculto por filtros"
            : `· ${formatCount(hiddenByFilters)} vuelos ocultos por filtros`}
        </span>
      )}
    </>
  )
}

function ResultsBody({
  sort,
  onSort,
  results,
  offers,
  months,
  outcome,
  loading,
  isCancelled,
  unfilteredOfferCount,
  selectedOfferId,
  onSelectOffer,
  onClearFilters,
  emptyByFilters,
  onEditSearch,
  onOpenMigrationMonth,
  activeFilterCount,
  viewKey,
  onMobileToolsCollapsedChange,
  phone,
  navigationRef,
}: {
  sort: SortMode
  onSort: (sort: SortMode) => void
  results: SearchJobResponse | null
  offers: CanonicalOffer[]
  months: DisplayMonth[] | null
  outcome: SearchOutcome
  loading: boolean
  isCancelled: boolean
  unfilteredOfferCount: number
  selectedOfferId?: string
  onSelectOffer: (offerId: string) => void
  onClearFilters: () => void
  emptyByFilters?: EmptyByFiltersCopy
  onEditSearch: () => void
  onOpenMigrationMonth: (month: DisplayMonth) => void
  activeFilterCount: number
  viewKey: string
  onMobileToolsCollapsedChange: (collapsed: boolean) => void
  phone: boolean
  navigationRef: RefObject<ResultsNavigation | null>
}) {
  /* One measurement for the list and the skeleton that stands in for it:
     both are drawn in this column and must hold the same number of rows. */
  const resultItems = useMemo(
    () => buildResultListItems(offers, results?.scheduleGroups),
    [offers, results?.scheduleGroups],
  )
  const { columnRows, viewportRef, attachViewport } = useResultsColumnCapacity()
  /* Stamped on the list for the stylesheet: in Exacto the dates are on the
     search bar, so the stacked leg drops them. Exacto is also what the
     skeleton stands in for before a request exists. */
  const mode = results?.request.searchMode ?? "exact"
  const passengerCount = countPassengers(results?.request)
  const showPerPerson = showsPerPersonPrice(results?.request)
  /* Built above the branch: the header is part of the box the rows are
     counted into, and it must not appear with the data (04 §7). */
  const head = <ResultsColumnHead sort={sort} onSort={onSort} />

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

  if (months && results) {
    return (
      <MigrationMonthGrid
        months={months}
        passengerCount={passengerCount}
        selectedOfferId={selectedOfferId}
        onSelectOffer={onSelectOffer}
        onOpenMonth={onOpenMigrationMonth}
      />
    )
  }

  /* 04 §7: with nothing to show yet, the skeleton stands for as long as the
     search is alive; only failure speaks, in the states below. */
  if (loading && offers.length === 0) {
    return <ResultsSkeleton rows={columnRows} mode={mode} head={head} attachViewport={attachViewport} />
  }

  if (offers.length === 0 && results) {
    if (unfilteredOfferCount > 0) {
      return (
        <EmptyState
          icon="filtersOff"
          title={activeFilterCount === 1
            ? "Ningún vuelo cumple el filtro"
            : `Ningún vuelo cumple los ${spellOutCount(activeFilterCount)} filtros`}
          body={filteredEmptyBody(unfilteredOfferCount, emptyByFilters?.culpritSentence)}
          action={{
            label: activeFilterCount === 1 ? "Quitar el filtro" : `Quitar los ${activeFilterCount} filtros`,
            onClick: onClearFilters,
          }}
          secondaryAction={emptyByFilters?.relax}
        />
      )
    }

    /* Nobody answered: asking to widen a search that never ran is the wrong exit. */
    if (outcome.allFailed || (outcome.jobFailed && outcome.failed.length > 0)) {
      return (
        <EmptyState
          icon="alert"
          title="No se pudo consultar a los proveedores"
          body={`${failureSentences(outcome).join(" ")} La búsqueda no llegó a ejecutarse, así que esta ruta puede tener vuelos.`}
          action={{ label: "Volver a editar la búsqueda", onClick: onEditSearch, icon: "search" }}
        />
      )
    }

    if (outcome.jobFailed && results.error) {
      return (
        <EmptyState
          icon="alert"
          title="La búsqueda no se pudo completar"
          body={results.error}
          action={{ label: "Volver a editar la búsqueda", onClick: onEditSearch, icon: "search" }}
        />
      )
    }

    return (
      <EmptyState
        icon="sort"
        title="Sin resultados para esta consulta"
        body="Ajusta fechas, escalas, equipaje o aerolíneas para ampliar la cobertura."
        action={{ label: "Volver a editar la búsqueda", onClick: onEditSearch, icon: "search" }}
      />
    )
  }

  return (
    <ResultsList
      resultItems={resultItems}
      jobKey={results?.searchJobId ?? ""}
      mode={mode}
      head={head}
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
      phone={phone}
      navigationRef={navigationRef}
    />
  )
}

/* The culprit sentence is omitted rather than guessed. */
function filteredEmptyBody(totalCount: number, culpritSentence?: string): string {
  const held = `Hay ${formatCount(totalCount)} ${totalCount === 1 ? "resultado" : "resultados"} en esta búsqueda.`
  return culpritSentence ? `${held} ${culpritSentence}` : held
}

/** Plate 2g writes the count as a word in the title and as a figure in the button. */
const COUNT_WORDS = ["cero", "un", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve"]

function spellOutCount(count: number): string {
  return COUNT_WORDS[count] ?? String(count)
}

type ScheduleState = {
  key: string
  choice: Record<string, string>
  expandedGroupId: string | null
}

const NO_SCHEDULE_CHOICE: Record<string, string> = {}

function ResultsList({
  resultItems,
  jobKey,
  mode,
  head,
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
  phone,
  navigationRef,
}: {
  resultItems: ResultListItem[]
  /** The search these items belong to: per-job state is stamped with it. */
  jobKey: string
  mode: string
  head: ReactNode
  columnRows: number
  viewportRef: RefObject<HTMLDivElement | null>
  attachViewport: (node: HTMLDivElement | null) => void
  passengerCount: number
  showPerPerson: boolean
  selectedOfferId?: string
  onSelectOffer: (offerId: string) => void
  partial: boolean
  viewKey: string
  onMobileToolsCollapsedChange: (collapsed: boolean) => void
  phone: boolean
  navigationRef: RefObject<ResultsNavigation | null>
}) {
  /* Which schedule each group shows and which group has its full list open,
     stamped with the job so a new search drops them in the same render. */
  const [scheduleState, setScheduleState] = useState<ScheduleState>({ key: "", choice: {}, expandedGroupId: null })
  const scheduleChoice = scheduleState.key === jobKey ? scheduleState.choice : NO_SCHEDULE_CHOICE
  const expandedGroupId = scheduleState.key === jobKey ? scheduleState.expandedGroupId : null
  const batchSize = Math.max(RESULTS_WINDOW_MIN_BATCH, columnRows * 2)
  const firstWindowSize = useMemo(
    () => resultItemsFillingCapacity(resultItems, columnRows),
    [columnRows, resultItems],
  )

  /* A shared link arrives with an offer selected, and the first view opens far
     enough to show it. Only once: past arrival the reader's scrolling owns the
     window, and a filter and its undo are not an arrival. */
  const [firstViewKey] = useState(viewKey)
  const [leftFirstView, setLeftFirstView] = useState(false)
  const isFirstView = !leftFirstView && firstViewKey === viewKey
  const selectedItemIndex = useMemo(() => {
    if (!selectedOfferId) return -1
    return resultItems.findIndex((item) => resultListItemContainsOffer(item, selectedOfferId))
  }, [resultItems, selectedOfferId])

  const [windowState, setWindowState] = useState({ key: "", size: 0 })
  const requestedWindowSize = windowState.key === viewKey ? windowState.size : 0
  const visibleCount = Math.min(
    resultItems.length,
    Math.max(
      firstWindowSize,
      requestedWindowSize,
      isFirstView && selectedItemIndex >= 0 ? selectedItemIndex + 1 : 0,
    ),
  )
  const visibleItems = useMemo(() => resultItems.slice(0, visibleCount), [resultItems, visibleCount])
  const hasMore = visibleCount < resultItems.length

  const showMore = useCallback(() => {
    setWindowState((current) => {
      const base = current.key === viewKey ? current.size : 0
      return { key: viewKey, size: Math.max(base, visibleCount) + batchSize }
    })
  }, [batchSize, viewKey, visibleCount])

  /* A key can move past the drawn rows: the window grows to the target, and
     the row is scrolled into view once it is the selection. */
  const revealRef = useRef<string | null>(null)
  useImperativeHandle(navigationRef, () => ({
    step(direction) {
      const current = selectedOfferId
        ? resultItems.findIndex((item) => resultListItemContainsOffer(item, selectedOfferId))
        : -1
      const index = current < 0
        ? (direction === 1 ? 0 : resultItems.length - 1)
        : Math.min(resultItems.length - 1, Math.max(0, current + direction))
      const item = resultItems[index]
      if (!item) return undefined

      const offerId = item.type === "offer"
        ? item.offer.id
        : (item.group.offers.find((offer) => offer.id === scheduleChoice[item.id]) ?? item.group.offers[0])?.id
      if (!offerId) return undefined
      if (index >= visibleCount) {
        setWindowState({ key: viewKey, size: Math.max(index + 1, visibleCount + batchSize) })
      }
      if (offerId === selectedOfferId) {
        revealOffer(viewportRef.current, offerId)
      } else {
        revealRef.current = offerId
      }
      return offerId
    },
  }), [batchSize, resultItems, scheduleChoice, selectedOfferId, viewKey, viewportRef, visibleCount])

  useLayoutEffect(() => {
    const offerId = revealRef.current
    if (!offerId || offerId !== selectedOfferId) return
    revealRef.current = null
    revealOffer(viewportRef.current, offerId)
  }, [selectedOfferId, viewportRef, visibleCount])

  const handleChooseSchedule = useCallback((groupId: string, offerId: string) => {
    setScheduleState((current) => ({
      key: jobKey,
      choice: { ...(current.key === jobKey ? current.choice : {}), [groupId]: offerId },
      expandedGroupId: current.key === jobKey ? current.expandedGroupId : null,
    }))
    onSelectOffer(offerId)
  }, [jobKey, onSelectOffer])

  const handleToggleExpanded = useCallback((groupId: string) => {
    setScheduleState((current) => ({
      key: jobKey,
      choice: current.key === jobKey ? current.choice : {},
      expandedGroupId: current.key === jobKey && current.expandedGroupId === groupId ? null : groupId,
    }))
  }, [jobKey])

  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const scrollStateRef = useRef({
    lastTop: 0,
    accumulated: 0,
    direction: 0,
    lockedUntil: 0,
    collapsed: false,
  })
  const [backToTopVisible, setBackToTopVisible] = useState(false)

  const resetScrollState = useCallback(() => {
    scrollStateRef.current = { lastTop: 0, accumulated: 0, direction: 0, lockedUntil: 0, collapsed: false }
    onMobileToolsCollapsedChange(false)
  }, [onMobileToolsCollapsedChange])

  /* A filter or a sort is a new list, read from its first row, without an
     animated scroll (02 §11). */
  const viewKeyRef = useRef(viewKey)
  useEffect(() => {
    if (viewKeyRef.current === viewKey) return
    viewKeyRef.current = viewKey
    setLeftFirstView(true)
    viewportRef.current?.scrollTo({ top: 0 })
    setBackToTopVisible(false)
    resetScrollState()
  }, [resetScrollState, viewKey, viewportRef])

  useEffect(() => {
    resetScrollState()
  }, [jobKey, resetScrollState])

  const handleBackToTop = useCallback(() => {
    viewportRef.current?.scrollTo({ top: 0 })
    setBackToTopVisible(false)
  }, [viewportRef])

  /* 02 §9: on a phone, 88px of scroll in one direction retracts or restores
     the tools block, with 300ms of hysteresis after each change. */
  const handleResultsScroll = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport || !phone) return
    const top = viewport.scrollTop
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
  }, [onMobileToolsCollapsedChange, phone, viewportRef])

  /* The window grows when its end comes within a column of the viewport. The
     observer is rebuilt whenever the window moves, so one crossing adds one
     batch; without `IntersectionObserver` the list opens at the column size. */
  useEffect(() => {
    const sentinel = sentinelRef.current
    const viewport = viewportRef.current
    if (!sentinel || !viewport || typeof IntersectionObserver === "undefined") return

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) showMore()
    }, {
      root: viewport,
      rootMargin: `0px 0px ${RESULTS_WINDOW_PREFETCH_PX}px 0px`,
    })
    observer.observe(sentinel)

    return () => observer.disconnect()
  }, [hasMore, showMore, viewportRef])

  return (
    <div className="fd-list-body" data-testid="results-list-shell">
      {head}
      <div
        ref={attachViewport}
        onScroll={handleResultsScroll}
        className="fd-list-viewport"
        data-testid="results-list-body"
      >
        {/* Keyed on the requested view: a filter or a sort cross-fades, and the
            arrival cascade (04 §9) plays only on a search's first view. */}
        <div
          key={viewKey}
          className="fd-results-list fd-motion-crossfade"
          data-mode={mode}
          data-cascade={isFirstView}
        >
          {visibleItems.map((item) => (
            item.type === "group" ? (
              <GroupCard
                key={item.id}
                group={item.group}
                passengerCount={passengerCount}
                showPerPerson={showPerPerson}
                selectedOfferId={selectedOfferId && resultListItemContainsOffer(item, selectedOfferId) ? selectedOfferId : undefined}
                chosenOfferId={scheduleChoice[item.id]}
                expanded={expandedGroupId === item.id}
                onChooseSchedule={handleChooseSchedule}
                onToggleExpanded={handleToggleExpanded}
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

          {/* In a partial search the bones fill only the rows still missing,
              and only while the list is shorter than the column. */}
          {partial && !hasMore && visibleItems.length > 0 && visibleItems.length < columnRows && (
            <ResultsSkeleton
              rows={columnRows - visibleItems.length}
              inline
              startDelayIndex={visibleItems.length}
            />
          )}
        </div>

        {/* Reaching it asks for the next batch; it says nothing itself. */}
        {hasMore && (
          <div
            ref={sentinelRef}
            className="fd-list-sentinel"
            data-testid="results-more-sentinel"
            aria-hidden="true"
          />
        )}
      </div>

      {phone && backToTopVisible && (
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
    </div>
  )
}

const GroupCard = memo(function GroupCard({
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
  /** Set only when the selection is one of this group's offers. */
  selectedOfferId?: string
  chosenOfferId?: string
  expanded: boolean
  onChooseSchedule: (groupId: string, offerId: string) => void
  onToggleExpanded: (groupId: string) => void
  onSelectOffer: (offerId: string) => void
}) {
  const defaultOffer = group.offers[0]
  const shownOffer = group.offers.find((offer) => offer.id === chosenOfferId) ?? defaultOffer
  if (!shownOffer || !defaultOffer) return null

  const alternates = group.offers
    .filter((offer) => offer.id !== shownOffer.id)
    .map((offer) => alternateChip(offer, shownOffer))
  const chooseSchedule = (offerId: string) => onChooseSchedule(group.id, offerId)
  const toggleExpanded = () => onToggleExpanded(group.id)

  return (
    /* The 3b panel opens `absolute` over the rows below, so the row lifts
       itself above its siblings while it is open. */
    <div className={cn("relative min-w-0", expanded && "z-30")}>
      <ResultCard
        offer={shownOffer}
        selected={selectedOfferId === shownOffer.id}
        passengerCount={passengerCount}
        showPerPerson={showPerPerson}
        onSelect={onSelectOffer}
        alternates={alternates}
        onSelectAlternate={chooseSchedule}
        onShowAllAlternates={toggleExpanded}
        scheduleChanged={Boolean(chosenOfferId) && chosenOfferId !== defaultOffer.id}
      />

      {expanded && (
        <AllSchedulesPanel
          offers={group.offers}
          currentOfferId={shownOffer.id}
          providerLabel={group.providerLabel}
          onChoose={(offerId) => {
            chooseSchedule(offerId)
            toggleExpanded()
          }}
          onClose={toggleExpanded}
        />
      )}
    </div>
  )
})

function alternateChip(offer: CanonicalOffer, currentOffer: CanonicalOffer): AlternateSchedule {
  return { offer, ...buildAlternateScheduleModel(offer, currentOffer) }
}

function stepThrough(ids: string[], current: string | undefined, direction: 1 | -1): string | undefined {
  if (ids.length === 0) return undefined
  const index = current ? ids.indexOf(current) : -1
  /* From no selection, ↓ takes the first and ↑ the last. */
  if (index < 0) return direction === 1 ? ids[0] : ids[ids.length - 1]
  return ids[Math.min(ids.length - 1, Math.max(0, index + direction))]
}

/* The card comes into view; when the list already had the focus, it moves there. */
function revealOffer(container: HTMLElement | null, offerId: string) {
  const card = container?.querySelector<HTMLElement>(`[data-offer-id="${CSS.escape(offerId)}"]`)
  if (!card) return
  card.scrollIntoView({ block: "nearest" })
  if (container?.contains(document.activeElement)) {
    card.querySelector<HTMLElement>(".fd-card__hit, .fd-month-card__hit")?.focus({ preventScroll: true })
  }
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
  /** Removing filters carries the `x`; going back to the search carries its glyph. */
  action?: EmptyStateAction
  /** Relaxing the one filter to blame (plate 2g). */
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
 * How many plain cards the column holds — what the skeleton draws and what the
 * list opens on. A group row counts `RESULT_GROUP_CARD_WEIGHT` plain rows.
 * The viewport is a callback ref because the skeleton owns it first and the
 * list takes it over, and each owner needs a measurement.
 */
function useResultsColumnCapacity() {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [viewportNode, setViewportNode] = useState<HTMLDivElement | null>(null)
  const attachViewport = useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node
    setViewportNode(node)
  }, [])
  const [columnRows, setColumnRows] = useState(RESULTS_COLUMN_ROWS_FALLBACK)
  const rowHeightRef = useRef(RESULTS_CARD_HEIGHT_ESTIMATE_PX)

  useLayoutEffect(() => {
    const node = viewportNode
    if (!node) return

    let frame = 0
    const update = () => {
      const list = node.querySelector<HTMLElement>(".fd-results-list")
      const availableHeight = Math.max(0, node.clientHeight - RESULTS_LIST_TOP_INSET_PX)
      /* Real cards when there are any, bones otherwise: they share a height. */
      const realCards = list ? Array.from(list.querySelectorAll<HTMLElement>(".fd-card:not(.fd-card--skeleton)")) : []
      const cards = realCards.length > 0
        ? realCards
        : list ? Array.from(list.querySelectorAll<HTMLElement>(".fd-card")) : []
      const listStyle = list ? window.getComputedStyle(list) : null
      const measuredGap = listStyle
        ? Number.parseFloat(listStyle.rowGap || listStyle.gap || `${RESULTS_CARD_GAP_PX}`)
        : RESULTS_CARD_GAP_PX
      const gap = Number.isFinite(measuredGap) ? measuredGap : RESULTS_CARD_GAP_PX
      /* The unit is the plain card; a column of groups divides back to it. */
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
      /* Whole rows only: a bone cut in half is the jump 04 §7 forbids. */
      const rows = Math.floor((availableHeight + gap) / (rowHeight + gap) + 0.01)
      const next = Math.max(1, Math.min(RESULTS_COLUMN_ROWS_MAX, rows))

      setColumnRows((current) => (current === next ? current : next))
    }
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(update)
    }

    /* Now, not on the next frame: the first paint must hold the real count. */
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
  }, [viewportNode])

  return { columnRows, viewportRef, attachViewport }
}

export const ResultsPanel = memo(ResultsPanelBase)
