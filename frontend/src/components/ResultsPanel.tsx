import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
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
import { ResultsScrollbar } from "@/components/results/ResultsScrollbar"
import { ActiveFilterChips } from "@/components/results/ActiveFilterChips"
import { AppIcon } from "@/components/ui/app-icon"
import { Spinner } from "@/components/ui/spinner"
import { Kbd } from "@/components/ui/kbd"
import { ShortcutTooltip } from "@/components/ui/tooltip"
import {
  describeSearchOutcome,
  failureSentences,
  type SearchOutcome,
} from "@/lib/search-outcome"
import { cn } from "@/lib/utils"
import { SORT_MODES, type CanonicalOffer, type SearchJobResponse, type SortMode } from "@/types"

/*
 * Plates 1b (active desktop), 2g (list states), 3b (all schedules), 4a
 * (skeletons) and 1i (migration grid).
 *
 * The panel is one header, one column header and one list of rows that grows as
 * it is scrolled. The strip of active filters left the desk with this change:
 * on a desk the filter column is on screen the whole time and the strip was
 * repeating it 250px away, so only its one original sentence — «N ocultos por
 * filtros» — survives, on the count line. On a phone the strip is the only
 * voice the filters have and it stays, mounted by the shell.
 *
 * The column-width editor that used to live here is gone: plate 1b closes the
 * row grid at 28 / 142 / 1fr / 36 / 116 / 26, with the baggage in a track of
 * its own and the duration lane fixed so the header above can name it, so there
 * is nothing left for it to tune.
 */

/*
 * The ceiling is a guard against a pathological viewport, not a window size. 12
 * was the fit of a 1440-tall desk when it was written and became a cap the
 * moment screens grew past it: a 1920×1080 column fits 13 plain rows and a
 * 1440-tall one fits 19, so the column stopped one and seven rows short of the
 * space it had just measured — the same half-empty column the skeleton was
 * reported with. 20 is that 19 plus a row of slack; past it the wins are
 * hypothetical and the cost of drawing the bones is not.
 */
const RESULTS_COLUMN_ROWS_MAX = 20
const RESULTS_COLUMN_ROWS_FALLBACK = 4
/*
 * What the list adds each time the reader reaches the end of it.
 *
 * A search here answers with hundreds of offers — 520 on a plain LIM–MIA, 2,500
 * on a week-long range — and building every card up front is the one thing an
 * infinite list must not do. The window opens at whatever fills the column and
 * grows by two columns at a time, which is the amount that keeps the sentinel
 * out of reach for a whole flick of the thumb; the floor covers the case where
 * the column has not been measured yet.
 */
const RESULTS_WINDOW_MIN_BATCH = 12
/*
 * How far below the last card the list starts building the next batch. A batch
 * is already in memory — this is a render, not a fetch — so the margin only has
 * to cover the frame it costs, and one column of slack does that at any scroll
 * speed a thumb produces.
 */
const RESULTS_WINDOW_PREFETCH_PX = 900
/* The plain row of plate 1b, which is the unit a display weight of 1 means:
   52 of row with its own hairline inside it, and nothing between one row and
   the next — the list's 6px gap went with the card frame the gap existed to
   separate. The measurement below replaces both on the first frame. */
const RESULTS_CARD_HEIGHT_ESTIMATE_PX = 52
const RESULTS_CARD_GAP_PX = 0
const RESULTS_LIST_TOP_INSET_PX = 4
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
   * Where the strip of active filters mounts — or whether it mounts at all.
   * In armazón C it is the middle band of the retractable tools block, which
   * the shell owns because the search summary above it retracts with it as one
   * piece (plate 1d, 02 §9). In A and B it is `"none"`: the filter column is
   * always on screen there, so the strip was saying a second time, in 35px of
   * list height, what the rail 250px to its left already said. `"list"` is the
   * third mount and the one nothing passes today; it is kept because the
   * component still supports it and the default has to be something.
   */
  chipsPlacement?: "list" | "external" | "none"
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
              hiddenByFilters={chipsPlacement === "none" ? hiddenByFiltersCount : 0}
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
            {/* The desk's «Ordenar · Precio | Duración» is gone from this row:
                a column header already sorts, in the place everybody looks for
                it, so the sortable columns became the control (see
                `ResultsColumnHead`). What is left here is the phone's, because
                a phone has no column header to put it in.

                Plate 1d: a 32px status row has no space for a segmented, so the
                order collapses into whichever criterion is on and tapping moves
                to the next. The order never disappears on a phone — 02 §5 lists
                what may, and this is not on the list.

                All four, not two. The desk reaches «Salida» and «Escalas»
                through the column header, and this surface has no header — so
                on a phone those two orders could only be arrived at by opening
                someone else's link, which is not reaching them. */}
            <SortCompactButton sort={sort} onSort={onSort} />
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
        sort={sort}
        onSort={onSort}
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

/**
 * The phone's order control: one button that names the order in force and
 * moves to the next one when it is pressed.
 *
 * The cycle is `SORT_MODES` itself rather than a list written out here, so the
 * button cannot come to offer fewer criteria than the backend serves — which
 * is what had already happened: the catalogue grew to four and this stayed a
 * two-way switch between price and duration.
 *
 * The words are the criterion's and not the desk column's — «Salida», not the
 * header's «Horario» — because the header labels name columns and this surface
 * draws none of them. The accessible name is the same sentence on both.
 *
 * That name says what pressing does, not what is on: the visible label is the
 * state and the label a screen reader hears is the action, which is the shape
 * plate 1d gives a control that is its own toggle.
 */
const SORT_COMPACT_LABELS: Record<SortMode, string> = {
  cheapest: "Precio",
  fastest: "Duración",
  departure: "Salida",
  stops: "Escalas",
}

const SORT_COMPACT_CRITERIA: Record<SortMode, string> = {
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
      data-sort={sort}
      aria-label={`Ordenar por ${SORT_COMPACT_CRITERIA[next]}`}
      onClick={() => onSort(next)}
    >
      <AppIcon name="sort" size={14} />
      {SORT_COMPACT_LABELS[sort]}
    </button>
  )
}

/**
 * The column header — plate 1b's answer to what the grey plinth was doing.
 *
 * It carries `.fd-card` so the lanes come from the row's own stylesheet rather
 * than from a copy of it, and the order lives in it: the sortable columns are
 * the radios of the same group the segmented used to be, with the same
 * accessible names, so what changed is the shape and not the semantics.
 *
 * Four of them, not two. «Salida» and «Escalas» arrived as two more options of
 * a segmented control that no longer exists — but they did not need controls of
 * their own: «Horario» and «Escalas» are already columns of this header, and
 * making a column sort is what the header of a table is for. So the group grew
 * where the data already is instead of growing a second control beside it, and
 * the four arrive in column order rather than in the segmented's.
 *
 * The lanes that do not sort stay labels. A header where everything is a
 * button says every column can be ordered, and «Aerolínea», «Tramo», «Eq.» and
 * «Prov.» cannot: the backend has four criteria and this group offers exactly
 * those four.
 */
function ResultsColumnHead({ sort, onSort }: { sort: SortMode; onSort: (sort: SortMode) => void }) {
  return (
    <div
      className="fd-card fd-card--head"
      role="radiogroup"
      aria-label="Orden de resultados"
      data-testid="results-column-head"
    >
      {/* The logo lane has no name: a mark is not a column of values. */}
      <span aria-hidden="true" />
      <span className="fd-card__head-label">Aerolínea</span>
      <div className="fd-card__legs">
        <div className="fd-card__leg">
          <span className="fd-card__head-label">Tramo</span>
          <SortableColumnHead
            sort={sort}
            onSort={onSort}
            mode="departure"
            label="Horario"
            criterion="hora de salida"
          />
          <SortableColumnHead
            sort={sort}
            onSort={onSort}
            mode="fastest"
            label="Duración"
            criterion="duración"
            align="end"
          />
          <SortableColumnHead
            sort={sort}
            onSort={onSort}
            mode="stops"
            label="Escalas"
            criterion="número de escalas"
          />
        </div>
      </div>
      <span className="fd-card__head-label fd-card__head-label--center">Eq.</span>
      <SortableColumnHead
        sort={sort}
        onSort={onSort}
        mode="cheapest"
        label="Precio"
        criterion="precio"
        align="end"
      />
      <span className="fd-card__head-label fd-card__head-label--end">Prov.</span>
    </div>
  )
}

/**
 * One sortable column of the header.
 *
 * The active mark is the arrow the redesign drew beside «Precio», and it is
 * drawn only on the column that is ordering — one arrow on screen, on the lane
 * the list is sorted by.
 *
 * It costs the cell 15px (12 of icon, 3 of gap) and one lane cannot pay it out
 * of its own track: «Duración» measures 56.89 in a lane of 66, so with the
 * arrow the cell is 71.89 and hangs 5.89px past its track. That is left as an
 * overflow rather than repaired, and the reason is that the alternatives are
 * worse: widening the duration lane moves `RESULT_LEG_FIXED_PX`, which moves
 * the 787 stacking threshold and the 824 the detail column asks for, and a
 * 1440 desk sits *on* 824 — the commonest desk there is would lose its third
 * column to a 12px arrow. The 5.89 falls into the 12px column gap that follows
 * the lane and reaches nothing; `test/ui/results.playwright.ts` measures it
 * against the neighbouring label rather than trusting the arithmetic.
 *
 * The label follows the lane it names: right over the figures, left over the
 * text, which is where the values under it already are.
 */
function SortableColumnHead({
  sort,
  onSort,
  mode,
  label,
  criterion,
  align,
}: {
  sort: SortMode
  onSort: (sort: SortMode) => void
  mode: SortMode
  label: string
  criterion: string
  align?: "end"
}) {
  const active = sort === mode
  return (
    <button
      type="button"
      role="radio"
      data-segment={mode}
      aria-checked={active}
      aria-label={`Ordenar por ${criterion}`}
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
  /** Nothing was searched, so there is no count to state — only a notice. */
  searchFailed: boolean
  /**
   * The one sentence the desk's chip strip said that the filter rail does not.
   * It moves here when the strip does not mount: a rail full of active filters
   * says which constraints are on, and nothing on the screen said what they
   * cost until this line did.
   */
  hiddenByFilters: number
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

  return (
    <>
      <span className="fd-panel-count">{label}</span>
      {hiddenByFilters > 0 && (
        /* Its own class, not a second `.fd-panel-count`: that one is the mono
           figure beside a heading, and this is a sentence. */
        <span className="fd-list-hidden-count">
          {hiddenByFilters === 1
            ? "· 1 vuelo oculto por filtros"
            : `· ${hiddenByFilters.toLocaleString("es-PE")} vuelos ocultos por filtros`}
        </span>
      )}
    </>
  )
}

function ResultsBody({
  sort,
  onSort,
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
  sort: SortMode
  onSort: (sort: SortMode) => void
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
  const { columnRows, viewportRef, attachViewport } = useResultsColumnCapacity()
  /*
   * The mode the rows are drawn in, stamped on the list for the stylesheet to
   * read. It decides one thing — whether the stacked leg keeps the date in its
   * rótulo — and it is an attribute rather than a prop threaded down to every
   * leg because that is a fact about the list, not about a row: in Exacto both
   * dates are already on the search bar above, and the rótulo would repeat them
   * twice per row for the length of the list.
   *
   * The default matters. A search that has not answered yet has no request, and
   * the skeleton is drawn in that gap; Exacto is what the app opens on and what
   * the overwhelming majority of searches are, so it is what the bones stand
   * in for.
   */
  const mode = results?.request.searchMode ?? "exact"
  /* Built here, above the branch, because the bones and the rows are drawn in
     the same box and the header is part of that box: a column that gains 27px
     of header when the data lands is the value jump 04 §7 forbids, and the row
     count both of them are measured into would change with it. */
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
   * 04 §7: a search with nothing to show yet is the skeleton, and the skeleton
   * stands for as long as the search is alive.
   *
   * It used to grow a line of words at eight seconds — «X está tardando más de
   * lo habitual» — and hand the whole column to those words for a reader who
   * had asked for no movement. Both are gone by decision: a real search here
   * takes fifteen to forty seconds and more, so «tarda» is the ordinary case
   * and a notice that announces it tells the agent nothing they can act on.
   * What still speaks is failure, and it speaks in the states below: a provider
   * that fell, or a search that reached nobody.
   */
  if (loading && offers.length === 0) {
    return <ResultsSkeleton rows={columnRows} mode={mode} head={head} attachViewport={attachViewport} />
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
  mobileCollapseEnabled,
}: {
  /** Built above, so the skeleton and the list weigh the same column. */
  resultItems: ResultListItem[]
  /**
   * The search these items belong to.
   *
   * What the per-job state below is stamped with. It used to be a digest of the
   * items themselves, which changes on every progressive batch — so a search
   * that answers in parts, which is every search now, dropped that state
   * several times while the reader was using it.
   */
  jobKey: string
  /** Which search this list is drawing, for the lanes that answer to it. */
  mode: string
  /** The column header, built above so the skeleton and the list share one. */
  head: ReactNode
  /** Whole rows: what the column fits, for the things that draw rows. */
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

  /* Which schedule each group is currently showing, and which group has its full
     list open. Both are stamped with the result set they belong to, so a new
     search drops them in the same render instead of briefly pinning a stale
     schedule onto a group id that has been reused for different offers. */
  const [scheduleState, setScheduleState] = useState<{
    key: string
    choice: Record<string, string>
    expandedGroupId: string | null
  }>({ key: "", choice: {}, expandedGroupId: null })
  const scheduleChoice = scheduleState.key === jobKey ? scheduleState.choice : {}
  const expandedGroupId = scheduleState.key === jobKey ? scheduleState.expandedGroupId : null
  /*
   * The first window is what the column holds; every flick of the thumb adds
   * two more. `batchSize` is whole cards because a batch is an amount to add,
   * not a column to fit — the fitting is the first window's job alone.
   */
  const batchSize = Math.max(RESULTS_WINDOW_MIN_BATCH, columnRows * 2)
  const firstWindowSize = useMemo(
    () => resultItemsFillingCapacity(resultItems, columnRows),
    [columnRows, resultItems],
  )

  /*
   * 11 §3: every filter and sort gesture returns the list to the top — but a
   * provider answering does not. Keyed on `viewKey` rather than on the offers,
   * so a progressive batch leaves the reader where they were and keeps whatever
   * they had already scrolled past.
   *
   * The exception is the first view: a shared link arrives with an offer
   * already selected, and opening one column short of it would hide the flight
   * the link was sent about.
   */
  /*
   * Once, on arrival — not "whenever the view happens to look like the one we
   * mounted with". Comparing keys made a filter and its undo, or a sort and its
   * undo, count as arriving again: the entrance cascade replayed on a plain
   * re-sort, and the selected-offer reveal below re-engaged, which on a set of
   * hundreds means building every card down to the selection a second time.
   */
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
      /* Only on arrival: past the first view the reader's own scrolling owns
         the window, and jumping it to a selection they made themselves would
         build hundreds of cards nobody asked to see. */
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

  const sentinelRef = useRef<HTMLDivElement | null>(null)
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

  /*
   * A filter or a sort is a new list, and the reader reads a new list from its
   * first row. The pager used to do this as a side effect of landing on page 1;
   * with one continuous list it is said outright — and only for `viewKey`, so
   * the progressive batches that re-render this list all the way through a
   * search never move anybody.
   *
   * 02 §11: back to the top with no animated scroll (07 §0 rule 2).
   */
  const viewKeyRef = useRef(viewKey)
  useEffect(() => {
    if (viewKeyRef.current === viewKey) return
    viewKeyRef.current = viewKey
    setLeftFirstView(true)
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
  }, [onMobileToolsCollapsedChange, viewKey, viewportRef])

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
  }, [onMobileToolsCollapsedChange, jobKey])

  /*
   * The window grows when the end of it comes within a column of the viewport.
   *
   * The observer is re-created whenever the sentinel is remounted or the batch
   * changes, and `showMore` is re-created whenever the window moves, so one
   * crossing adds exactly one batch: the sentinel is pushed a column further
   * down by the cards that batch renders, and only comes back into range when
   * the reader keeps going. Where there is no `IntersectionObserver` the list
   * still works — it just opens at the size of the column, which is the whole
   * list on every viewport small enough for that to be an issue.
   */
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
        {/* Keyed on the requested view, so a filter and a sort each cross-fade
            in 140ms rather than animating a height (rule 2), while the batches
            this list appends do not: they are the same view with more of it on
            screen.

            The cascade of 04 §9 belongs to *arrival* — the first cards of a new
            search. A filter and a sort are repaints, and 04 §2 and §6 give
            those the cross-fade alone; replaying seven staggered entries on
            every filter click turns a refinement into an event. An appended
            batch is left out of the cascade by its cap rather than by turning
            the cascade off — 04 §9 stops at seven cards on a desk and six on a
            phone, so a card appended past those positions is drawn the frame it
            exists, which is what a card the reader has scrolled to has to be. */}
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
                selectedOfferId={selectedOfferId}
                chosenOfferId={scheduleChoice[item.id]}
                expanded={expandedGroupId === item.id}
                onChooseSchedule={(offer) => {
                  setScheduleState((current) => ({
                    key: jobKey,
                    choice: { ...(current.key === jobKey ? current.choice : {}), [item.id]: offer.id },
                    expandedGroupId: current.key === jobKey ? current.expandedGroupId : null,
                  }))
                  onSelectOffer(offer)
                }}
                onToggleExpanded={() => setScheduleState((current) => ({
                  key: jobKey,
                  choice: current.key === jobKey ? current.choice : {},
                  expandedGroupId: current.key === jobKey && current.expandedGroupId === item.id ? null : item.id,
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
              and it fills them at the end. Only while the whole list is still
              shorter than the column: once it scrolls, the end of the list is
              wherever the reader is, and bones down there would be a promise
              about offers that have already arrived. */}
          {partial && !hasMore && visibleItems.length > 0 && visibleItems.length < columnRows && (
            <ResultsSkeleton
              rows={columnRows - visibleItems.length}
              inline
              startDelayIndex={visibleItems.length}
            />
          )}
        </div>

        {/* The end of the window, one column of slack above the end of the
            cards. Reaching it is what asks for the next batch — a scroll
            handler would ask on every frame of every flick instead, and asking
            is a state change. `aria-hidden` because it says nothing: what it
            does is already announced by the count in the header. */}
        {hasMore && (
          <div
            ref={sentinelRef}
            className="fd-list-sentinel"
            data-testid="results-more-sentinel"
            aria-hidden="true"
          />
        )}
      </div>

      <ResultsScrollbar viewportRef={viewportRef} />

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
 * How many plain cards the column holds.
 *
 * Two consumers, one measurement. The skeleton draws exactly this many bones,
 * so the column the reader waits in is the column the results land in; and the
 * list opens on exactly this much, so the first screen is full and nothing
 * below it has been built yet.
 *
 * It is a count of *plain* rows — a group row is 1.62 of one — because that
 * is the unit both consumers work in. The list is scrollable on every armazón
 * now, so unlike the page it replaces this is not a fit to be exact about: it
 * is the amount that has to exist before the reader can scroll at all.
 */
function useResultsColumnCapacity() {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  /*
   * The column is measured through a callback ref rather than read off
   * `viewportRef.current` alone, because the element the count belongs to is
   * swapped under this hook: the skeleton owns it first and the list takes it
   * over. The node is state, so a new one is a new measurement — read off the
   * ref alone, the handover happened without one and the column kept the
   * fallback of four.
   */
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
       * Taking the tallest row instead made one group row — 84px against 52 —
       * the row height for the whole column: capacity fell by a third and the
       * list opened well short of the bottom, which is exactly the empty space
       * the desk was reported with. A column of nothing but groups is rare, and
       * dividing by the group weight recovers the same unit from it.
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
      /* Whole rows, and never the one that would be cut in half: 04 §7 asks the
         skeleton for «never more rows than the real list», and a bone hanging
         off the bottom of the column is the value jump it forbids. The list
         opens on the same count and reaches the rest through the sentinel,
         which starts a column below the fold and so fires straight away on a
         column this exact. */
      const rows = Math.floor((availableHeight + gap) / (rowHeight + gap) + 0.01)
      const next = Math.max(1, Math.min(RESULTS_COLUMN_ROWS_MAX, rows))

      setColumnRows((current) => (current === next ? current : next))
    }
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(update)
    }

    /*
     * Measured now, not on the next frame. The rAF was the whole of the live
     * defect: on the skeleton's first mount, and again when the arriving
     * `searchJobId` re-keys this panel, the column was painted at
     * `RESULTS_COLUMN_ROWS_FALLBACK` and only corrected a frame later — four
     * bones in a column that holds eleven. Inside a layout effect the DOM is
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
  }, [viewportNode])

  return { columnRows, viewportRef, attachViewport }
}

function passengerCountForRequest(request: SearchJobResponse["request"] | undefined) {
  if (!request) return 1
  return Math.max(1, request.adults + request.children + request.infants)
}

function canShowPerPersonForRequest(request: SearchJobResponse["request"] | undefined) {
  return Boolean(request && request.children === 0 && request.infants === 0)
}

export const ResultsPanel = memo(ResultsPanelBase)
