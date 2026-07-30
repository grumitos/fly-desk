import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { DetailPanel } from "@/components/DetailPanel"
import { ProviderRail } from "@/components/ProviderRail"
import { ResultsPanel, type ActiveFilterChip } from "@/components/ResultsPanel"
import { SearchShell } from "@/components/SearchShell"
import { TopBar } from "@/components/TopBar"
import { AppIcon } from "@/components/ui/app-icon"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { SegmentButton, SegmentedControl } from "@/components/ui/segmented-control"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useSearch } from "@/hooks/useSearch"
import { resolveAirlineDisplayName } from "@/lib/airline-names"
import { airlineLogoAssetPath } from "../../src/core/airline-assets"
import {
  readSharedSearchFromText,
  readSharedSearchFromUrl,
  writeSharedSearchToClipboard,
  writeSharedSearchToUrl,
  type SharedSearchState,
} from "@/lib/search-share"
import type { CanonicalOffer, SearchJobResponse, SearchRequest, Segment, SortMode } from "@/types"

type Filters = {
  nonStop?: boolean
  maxStopsFilter?: string
  maxLayoverMinutes?: string
  carryOnRequired?: boolean
  checkedBaggageRequired?: boolean
}

type AirlineFilterOption = {
  id: string
  label: string
  code: string
  logo: string
  codes: string[]
  count: number
}

type StopFilterValue = "any" | "direct" | "1" | "2+"
type LayoverFilterValue = "any" | "120" | "240" | "360"
type BaggageFilterValue = "any" | "carry" | "checked"

const DEFAULT_SORT_MODE: SortMode = "cheapest"

/*
 * Plate 1b closes the filter panel: three of the four groups are the same
 * segmented control with no separator between them, and the separator appears
 * only before Aerolíneas because that is a different kind of filter — a list of
 * things you include, not a constraint you tighten.
 *
 * The sliders these replaced implied a continuum. "Directo · 1 · 2+" is not a
 * continuum; it is four choices, and a segmented control says so.
 */
const STOP_SEGMENTS: Array<{ value: StopFilterValue; label: string; chip?: string }> = [
  { value: "any", label: "Todos" },
  { value: "direct", label: "Directo", chip: "Directo" },
  { value: "1", label: "1", chip: "Hasta 1 escala" },
  { value: "2+", label: "2+", chip: "2+ escalas" },
]
const LAYOVER_SEGMENTS: Array<{ value: LayoverFilterValue; label: string; chip?: string }> = [
  { value: "any", label: "Todos" },
  { value: "120", label: "≤2h", chip: "Escala ≤ 2 h" },
  { value: "240", label: "≤4h", chip: "Escala ≤ 4 h" },
  { value: "360", label: "≤6h", chip: "Escala ≤ 6 h" },
]
const BAGGAGE_SEGMENTS: Array<{ value: BaggageFilterValue; label: string; icon?: "backpack" | "luggage"; chip?: string }> = [
  { value: "any", label: "Todos" },
  { value: "carry", label: "Mano", icon: "backpack", chip: "Mano incluida" },
  { value: "checked", label: "Bodega", icon: "luggage", chip: "Bodega incluida" },
]

export default function App() {
  const { results, loading, error, statusMessage, diagnosticLog, runSearch, cancel } = useSearch()
  const [initialSharedSearch] = useState<SharedSearchState | null>(() => readInitialSharedSearch())
  const initialSharedRequest = initialSharedSearch?.request ?? null
  const [sortMode, setSortMode] = useState<SortMode>(() => initialSharedSearch?.sortMode ?? DEFAULT_SORT_MODE)
  const [selectedOfferId, setSelectedOfferId] = useState<string | null>(null)
  const [lastRequest, setLastRequest] = useState<SearchRequest | null>(null)
  const [workspaceReady, setWorkspaceReady] = useState(false)
  const [filters, setFilters] = useState<Filters>(() => filtersFromRequest(initialSharedSearch?.request))
  const [selectedAirlines, setSelectedAirlines] = useState<string[]>(() => initialSharedSearch?.request.includedAirlineCodes ?? [])
  const [mobilePanel, setMobilePanel] = useState<"results" | "filters" | "detail">("results")
  const [plainLogView, setPlainLogView] = useState(false)
  const [clipboardError, setClipboardError] = useState<string | null>(null)
  /* The notice is dismissible and does not come back within the same search, so
     what we remember is the exact text that was dismissed. */
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null)
  const [searchDraft, setSearchDraft] = useState<SearchRequest | null>(initialSharedRequest)
  const filtersRef = useRef(filters)
  const selectedAirlinesRef = useRef(selectedAirlines)
  const sortModeRef = useRef(sortMode)
  const searchFrameRef = useRef<HTMLDivElement | null>(null)
  const pendingSearchFrameRectRef = useRef<DOMRect | null>(null)
  const searchLayoutAnimationRef = useRef<Animation | null>(null)

  useEffect(() => {
    filtersRef.current = filters
  }, [filters])

  useEffect(() => {
    selectedAirlinesRef.current = selectedAirlines
  }, [selectedAirlines])

  useEffect(() => {
    sortModeRef.current = sortMode
  }, [sortMode])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey || event.key.toLowerCase() !== "l") return
      event.preventDefault()
      setPlainLogView((active) => !active)
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [])

  const candidateOffers = useMemo(() => {
    const sourceOffers = results && isMigrationResults(results) && results.allOffers?.length
      ? results.allOffers
      : results?.offers ?? []
    return sortOffersForDisplay(sourceOffers, sortMode)
  }, [results, sortMode])
  const allAirlines = useMemo(() => {
    const options = new Map<string, AirlineFilterOption>()
    candidateOffers.forEach((offer) => {
      const label = airlineFilterLabel(offer)
      const codes = airlineFilterCodes(offer)
      const id = label.toLocaleUpperCase("es-PE")
      const code = airlineFilterCode(offer)
      const current = options.get(id) ?? { id, label, code, logo: "", codes: [], count: 0 }
      const mergedCodes = new Set([...current.codes, ...codes])
      const resolvedCode = current.code || code
      options.set(id, {
        ...current,
        code: resolvedCode,
        // The 18px logo in the row is the fastest way to find an airline in a
        // list of seven; the name is the confirmation, not the target.
        logo: resolvedCode ? airlineLogoAssetPath(resolvedCode) : "",
        codes: Array.from(mergedCodes),
        count: current.count + 1,
      })
    })
    return Array.from(options.values())
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  }, [candidateOffers])

  const filteredCandidateOffers = useMemo(
    () => applyClientFilters(candidateOffers, filters, selectedAirlines),
    [candidateOffers, filters, selectedAirlines],
  )
  const quotationUsdToPenRate = useMemo(
    () => candidateOffers.map((offer) => offer.usdToPenRate).find(isUsableUsdToPenRate),
    [candidateOffers],
  )

  const filteredResults = useMemo(() => {
    if (!results) return null
    if (isMigrationResults(results)) {
      return applyMigrationFilters(results, filteredCandidateOffers, sortMode)
    }

    return { ...results, offers: filteredCandidateOffers, sortMode }
  }, [results, filteredCandidateOffers, sortMode])

  const visibleSelectedOffer = useMemo(() => {
    if (!filteredResults) return null
    if (selectedOfferId) {
      const currentOffer = filteredResults.offers.find((offer) => offer.id === selectedOfferId)
      if (currentOffer) return currentOffer
    }

    return isMigrationResults(filteredResults) ? filteredResults.offers[0] ?? null : null
  }, [filteredResults, selectedOfferId])

  const handleSearch = useCallback(
    (request: SearchRequest, sort?: SortMode) => {
      pendingSearchFrameRectRef.current = searchFrameRef.current?.getBoundingClientRect() ?? null
      const merged = {
        ...request,
        ...filtersRef.current,
        baggageRequired: undefined,
        includedAirlineCodes: selectedAirlinesRef.current,
      }
      const nextSort = sort ?? defaultSortForRequest()
      setClipboardError(null)
      setSelectedOfferId(null)
      setSortMode(nextSort)
      setWorkspaceReady(false)
      setSearchDraft(merged)
      setLastRequest(merged)
      writeSharedSearchToUrl(merged, nextSort)
      void runSearch(merged, nextSort).then((started) => {
        if (started) {
          setWorkspaceReady(true)
        }
      })
    },
    [runSearch]
  )

  const handlePasteSearchConfig = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      const sharedSearch = readSharedSearchFromText(text)
      if (!sharedSearch) {
        setClipboardError("No se encontró una configuración de búsqueda válida en el portapapeles.")
        return
      }

      const nextFilters = filtersFromRequest(sharedSearch.request)
      filtersRef.current = nextFilters
      selectedAirlinesRef.current = sharedSearch.request.includedAirlineCodes ?? []
      sortModeRef.current = sharedSearch.sortMode
      setClipboardError(null)
      setSelectedOfferId(null)
      setWorkspaceReady(false)
      setSortMode(sharedSearch.sortMode)
      setFilters(nextFilters)
      setSelectedAirlines(sharedSearch.request.includedAirlineCodes ?? [])
      setLastRequest(sharedSearch.request)
      setSearchDraft(sharedSearch.request)
      writeSharedSearchToUrl(sharedSearch.request, sharedSearch.sortMode)
    } catch {
      setClipboardError("No se pudo leer el portapapeles. Revisa el permiso del navegador e intenta nuevamente.")
    }
  }, [])

  const handleSelectOffer = useCallback((offer: CanonicalOffer) => {
    setSelectedOfferId(offer.id)
    setMobilePanel("detail")
  }, [])

  const handleCopySearchConfig = useCallback(async () => {
    const draft = searchDraft ?? lastRequest ?? initialSharedRequest
    if (!draft) return

    const request = {
      ...draft,
      ...filtersRef.current,
      baggageRequired: undefined,
      includedAirlineCodes: selectedAirlinesRef.current.length ? selectedAirlinesRef.current : undefined,
    }

    try {
      await writeSharedSearchToClipboard(request, sortModeRef.current)
      setClipboardError(null)
    } catch {
      setClipboardError("No se pudo copiar la configuración. Revisa el permiso del navegador e intenta nuevamente.")
    }
  }, [initialSharedRequest, lastRequest, searchDraft])

  const handleSort = useCallback(
    (sort: SortMode) => {
      sortModeRef.current = sort
      setSortMode(sort)
      if (lastRequest) {
        const nextRequest = { ...lastRequest, sortMode: sort }
        setLastRequest(nextRequest)
        writeSharedSearchToUrl(nextRequest, sort)
      }
    },
    [lastRequest]
  )

  const handleFilterChange = useCallback(
    (next: Partial<Filters>) => {
      const merged = { ...filters, ...next }
      filtersRef.current = merged
      setFilters(merged)
      if (lastRequest) {
        const nextRequest = { ...lastRequest, ...merged, baggageRequired: undefined, includedAirlineCodes: selectedAirlines }
        setLastRequest(nextRequest)
        writeSharedSearchToUrl(nextRequest, sortMode)
      }
    },
    [filters, lastRequest, selectedAirlines, sortMode]
  )

  const handleClearFilters = useCallback(() => {
    filtersRef.current = {}
    selectedAirlinesRef.current = []
    setFilters({})
    setSelectedAirlines([])
    if (lastRequest) {
      const nextRequest = {
        ...lastRequest,
        nonStop: undefined,
        maxStopsFilter: undefined,
        maxLayoverMinutes: undefined,
        carryOnRequired: undefined,
        checkedBaggageRequired: undefined,
        baggageRequired: undefined,
        includedAirlineCodes: undefined,
      }
      setLastRequest(nextRequest)
      writeSharedSearchToUrl(nextRequest, sortMode)
    }
  }, [lastRequest, sortMode])

  const toggleAirline = useCallback((airline: AirlineFilterOption) => {
    const tokens = airline.codes.length > 0 ? airline.codes : [airline.label]
    const current = new Set(selectedAirlines)
    const selected = tokens.every((token) => current.has(token))
    tokens.forEach((token) => {
      if (selected) {
        current.delete(token)
      } else {
        current.add(token)
      }
    })
    const nextAirlines = Array.from(current)
    selectedAirlinesRef.current = nextAirlines
    setSelectedAirlines(nextAirlines)
    if (lastRequest) {
      const nextRequest = { ...lastRequest, ...filters, baggageRequired: undefined, includedAirlineCodes: nextAirlines }
      setLastRequest(nextRequest)
      writeSharedSearchToUrl(nextRequest, sortMode)
    }
  }, [filters, lastRequest, selectedAirlines, sortMode])

  const activeFilterChips = useMemo(
    () => buildActiveFilterChips(filters, selectedAirlines, allAirlines),
    [allAirlines, filters, selectedAirlines],
  )
  const hiddenByFiltersCount = Math.max(0, candidateOffers.length - filteredCandidateOffers.length)
  const shouldShowWorkspace = workspaceReady || Boolean(results) || loading
  const isSearchIdle = !shouldShowWorkspace
  const loadingLabel = "Buscando"

  const handleRemoveFilterChip = useCallback((id: string) => {
    if (id === "stops") {
      handleFilterChange({ nonStop: undefined, maxStopsFilter: undefined })
      return
    }
    if (id === "layover") {
      handleFilterChange({ maxLayoverMinutes: undefined })
      return
    }
    if (id === "baggage") {
      handleFilterChange({ carryOnRequired: undefined, checkedBaggageRequired: undefined })
      return
    }

    const airlineId = id.startsWith("airline:") ? id.slice("airline:".length) : null
    const airline = airlineId ? allAirlines.find((option) => option.id === airlineId) : undefined
    if (airline) toggleAirline(airline)
  }, [allAirlines, handleFilterChange, toggleAirline])

  useLayoutEffect(() => {
    const frame = searchFrameRef.current
    if (!frame) return

    if (isSearchIdle) {
      searchLayoutAnimationRef.current?.cancel()
      searchLayoutAnimationRef.current = null
      pendingSearchFrameRectRef.current = null
      return
    }

    const previousRect = pendingSearchFrameRectRef.current
    pendingSearchFrameRectRef.current = null
    if (!previousRect) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return

    const nextRect = frame.getBoundingClientRect()
    const deltaX = previousRect.left - nextRect.left
    const deltaY = previousRect.top - nextRect.top
    if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return

    searchLayoutAnimationRef.current?.cancel()
    searchLayoutAnimationRef.current = frame.animate(
      [
        { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)`, width: `${previousRect.width}px` },
        { transform: "translate3d(0, 0, 0)", width: `${nextRect.width}px` },
      ],
      {
        duration: 180,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      }
    )
  }, [isSearchIdle])

  /* One fact — "does the desk know a search configuration?" — behind both
     capsule cells: Copy is disabled by it, Paste is only dimmed by it. */
  const hasSearchConfig = Boolean(searchDraft || lastRequest || initialSharedRequest)

  const mobileTabs = [
    { id: "results" as const, label: "Resultados", icon: <AppIcon name="list" /> },
    { id: "filters" as const, label: "Filtros", icon: <AppIcon name="filters" /> },
    { id: "detail" as const, label: "Oferta", icon: <AppIcon name="detail" /> },
  ]

  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <TopBar
        copySearchDisabled={!hasSearchConfig}
        pasteSearchDimmed={!hasSearchConfig}
        onCopySearchConfig={handleCopySearchConfig}
        onPasteSearchConfig={handlePasteSearchConfig}
      />

      {plainLogView ? (
        <PlainLogView lines={diagnosticLog} />
      ) : (
        <main
          className={`fd-search-stage fd-app-width mx-auto min-h-0 w-full flex-1 px-2.5 sm:px-4 ${
            isSearchIdle ? "fd-search-stage-idle" : "fd-search-stage-active"
          }`}
        >
          {/* Plate 1a spaces the idle screen with two unequal spacers — 1 above
              the form, 1.3 below — which is what leaves the form slightly above
              centre and the rail on the bottom edge. */}
          {isSearchIdle && <div className="fd-search-stage-spacer-top" aria-hidden="true" />}

          <div
            ref={searchFrameRef}
            data-testid="search-shell-frame"
            className="fd-search-frame"
          >
            <SearchShell
              onSearch={handleSearch}
              loading={loading}
              loadingLabel={loadingLabel}
              onCancelSearch={cancel}
              controlsPlacement={shouldShowWorkspace ? "topbar" : "inline"}
              showLocationUsageSuggestions={isSearchIdle}
              syncedRequest={lastRequest ?? initialSharedRequest}
              onSearchConfigDraftChange={setSearchDraft}
            />

            <SearchNotice
              message={clipboardError || error || statusMessage || ""}
              tone={clipboardError || error ? "error" : "warning"}
              onDismiss={() => {
                setClipboardError(null)
                setDismissedNotice(clipboardError || error || statusMessage || "")
              }}
              dismissed={dismissedNotice}
            />
          </div>

          {isSearchIdle && <div className="fd-search-stage-spacer-bottom" aria-hidden="true" />}
          {isSearchIdle && <ProviderRail />}

          {shouldShowWorkspace && (
            <Tabs
              value={mobilePanel}
              onValueChange={(value) => setMobilePanel(value as "results" | "filters" | "detail")}
              className="fd-shell-workspace min-h-0 gap-2.5"
            >
              <TabsList className="grid grid-cols-3 xl:hidden">
                {mobileTabs.map((tab) => (
                  <TabsTrigger
                    key={tab.id}
                    value={tab.id}
                  >
                    {tab.icon}
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>

              <div className="fd-workspace-enter grid min-h-0 flex-1 grid-cols-1 gap-2.5 overflow-hidden xl:grid-cols-[232px_minmax(0,1fr)_324px]">
                <div className={`${mobilePanel === "filters" ? "block" : "hidden"} min-h-0 xl:block`}>
                  <FiltersPanel
                    activeFilterCount={activeFilterChips.length}
                    filters={filters}
                    allAirlines={allAirlines}
                    selectedAirlines={selectedAirlines}
                    onClear={handleClearFilters}
                    onFilterChange={handleFilterChange}
                    onToggleAirline={toggleAirline}
                  />
                </div>

                <div className={`${mobilePanel === "results" ? "block" : "hidden"} min-h-0 xl:block`}>
                  <ResultsPanel
                    results={filteredResults}
                    unfilteredOfferCount={candidateOffers.length}
                    loading={loading}
                    sort={sortMode}
                    onSort={handleSort}
                    onSelectOffer={handleSelectOffer}
                    selectedOfferId={visibleSelectedOffer?.id}
                    activeFilterChips={activeFilterChips}
                    hiddenByFiltersCount={hiddenByFiltersCount}
                    onRemoveFilter={handleRemoveFilterChip}
                    onClearFilters={handleClearFilters}
                  />
                </div>

                <div className={`${mobilePanel === "detail" ? "block" : "hidden"} min-h-0 xl:block`}>
                  <DetailPanel
                    offer={visibleSelectedOffer}
                    request={filteredResults?.request}
                    searchJobId={results?.searchJobId}
                    usdToPenRate={quotationUsdToPenRate}
                  />
                </div>
              </div>
            </Tabs>
          )}
        </main>
      )}
    </div>
  )
}

/**
 * Plate 1b — one notice, one line.
 *
 * This replaced a chain of technical warnings that stacked up and pushed the
 * results down. It appears only when the search actually failed, states the
 * reason, and can be dismissed; once dismissed it does not return within the
 * same search, because an agent who has read it does not need it again.
 */
function SearchNotice({
  message,
  tone,
  dismissed,
  onDismiss,
}: {
  message: string
  tone: "warning" | "error"
  dismissed: string | null
  onDismiss: () => void
}) {
  if (!message || message === dismissed) return null

  const [headline, ...rest] = formatAlertLines(message)
  const detail = rest.join(" · ")

  return (
    <div
      className={`fd-alert-line fd-motion-emergente mt-2 ${tone === "error" ? "fd-alert-line-error" : ""}`}
      role="status"
    >
      <AppIcon name="alert" />
      <span className="fd-alert-line-text" title={message}>
        <span className="font-bold">{headline}</span>
        {detail && (
          <>
            <span className="mx-[7px] opacity-50">·</span>
            <span>{detail}</span>
          </>
        )}
      </span>
      <button
        type="button"
        className="fd-alert-line-dismiss fd-focus-ring"
        aria-label="Descartar el aviso"
        onClick={onDismiss}
      >
        <AppIcon name="x" size={14} />
      </button>
    </div>
  )
}

function PlainLogView({ lines }: { lines: string[] }) {
  const text = lines.length > 0
    ? lines.join("\n")
    : "Sin logs para copiar. Ejecuta una búsqueda y vuelve a esta vista."

  return (
    <main className="min-h-0 flex-1 bg-background">
      <Textarea
        aria-label="Registro de búsqueda"
        readOnly
        spellCheck={false}
        value={text}
        className="fd-scrollbar h-full min-h-0 w-full resize-none rounded-none border-0 bg-background p-4 font-mono text-xs leading-5 text-foreground shadow-none outline-none focus-visible:ring-0"
      />
    </main>
  )
}

const FiltersPanel = memo(function FiltersPanel({
  activeFilterCount,
  filters,
  allAirlines,
  selectedAirlines,
  onClear,
  onFilterChange,
  onToggleAirline,
}: {
  activeFilterCount: number
  filters: Filters
  allAirlines: AirlineFilterOption[]
  selectedAirlines: string[]
  onClear: () => void
  onFilterChange: (next: Partial<Filters>) => void
  onToggleAirline: (airline: AirlineFilterOption) => void
}) {
  const stopValue = stopFilterValue(filters)
  const layoverValue = layoverFilterValue(filters)
  const baggageValue = baggageFilterValue(filters)

  return (
    <aside className="fd-panel flex h-full min-h-0 flex-col overflow-hidden">
      <div className="fd-panel-header flex min-w-0 items-center justify-between gap-2 !px-3 !py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="fd-panel-title">Filtros</h2>
          {activeFilterCount > 0 && (
            <span className="fd-status-pill fd-status-pill-count">{activeFilterCount}</span>
          )}
        </div>
        {activeFilterCount > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="chip"
            onClick={onClear}
            className="shrink-0 !px-2 text-xs font-bold text-primary"
            aria-label="Limpiar filtros"
          >
            <AppIcon name="x" size={14} />
            Limpiar
          </Button>
        )}
      </div>

      <div className="fd-scrollbar-hidden min-h-0 flex-1 overflow-auto p-3">
        {/* Three constraints, one control, no separators between them. */}
        <FilterGroup label="Escalas" used={stopValue !== "any"}>
          <SegmentedControl
            aria-label="Escalas"
            value={stopValue}
            className="!w-full"
            onValueChange={(value) => onFilterChange({
              nonStop: value === "direct" ? true : undefined,
              maxStopsFilter: value === "1" || value === "2+" ? value : undefined,
            })}
          >
            {STOP_SEGMENTS.map((segment) => (
              <SegmentButton key={segment.value} value={segment.value} className="!flex-1 !px-0">
                {segment.label}
              </SegmentButton>
            ))}
          </SegmentedControl>
        </FilterGroup>

        <FilterGroup label="Escala máxima" used={layoverValue !== "any"}>
          <SegmentedControl
            aria-label="Escala máxima"
            value={layoverValue}
            className="!w-full"
            onValueChange={(value) => onFilterChange({
              maxLayoverMinutes: value === "any" ? undefined : value,
            })}
          >
            {LAYOVER_SEGMENTS.map((segment) => (
              <SegmentButton key={segment.value} value={segment.value} className="!flex-1 !px-0">
                {segment.label}
              </SegmentButton>
            ))}
          </SegmentedControl>
        </FilterGroup>

        <FilterGroup label="Equipaje incluido" used={baggageValue !== "any"}>
          <SegmentedControl
            aria-label="Equipaje incluido"
            value={baggageValue}
            className="!w-full"
            onValueChange={(value) => onFilterChange({
              carryOnRequired: value === "carry" || value === "checked" ? true : undefined,
              checkedBaggageRequired: value === "checked" ? true : undefined,
            })}
          >
            {BAGGAGE_SEGMENTS.map((segment) => (
              <SegmentButton key={segment.value} value={segment.value} className="!flex-1 !px-0">
                {segment.icon && <AppIcon name={segment.icon} size={14} />}
                {segment.label}
              </SegmentButton>
            ))}
          </SegmentedControl>
        </FilterGroup>

        {/* The separator goes here and nowhere else: this is a different kind of
            filter, and the rule is a cheaper signal than a heading change. */}
        {allAirlines.length > 0 && (
          <div className="fd-filter-divider">
            <div className="fd-filter-group-head mb-2">
              <span className="fd-type-micro">Aerolíneas</span>
              <span className="fd-mono text-xs font-semibold text-muted-foreground">
                {selectedAirlines.length > 0
                  ? `${countSelectedAirlines(allAirlines, selectedAirlines)} / ${allAirlines.length}`
                  : allAirlines.length}
              </span>
            </div>
            <div className="fd-scrollbar-hidden grid max-h-72 gap-0.5 overflow-auto">
              {allAirlines.map((airline) => (
                <label key={airline.id} className="fd-airline-row">
                  <Checkbox
                    checked={isAirlineFilterSelected(airline, selectedAirlines)}
                    onCheckedChange={() => onToggleAirline(airline)}
                    aria-label={airline.label}
                  />
                  {airline.logo && (
                    <img
                      src={airline.logo}
                      alt=""
                      className="fd-airline-row-logo"
                      decoding="async"
                      loading="lazy"
                    />
                  )}
                  <span className="fd-airline-row-name" title={airline.label}>{airline.label}</span>
                  <span className="fd-airline-row-count">{airline.count}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  )
})

/**
 * A group nobody has touched sits at 72% opacity and says "sin usar". Greying it
 * out is what lets the agent see, without reading, which constraints are on —
 * and an untouched group at full contrast is indistinguishable from one set to
 * its widest value, which is the same picture with a different meaning.
 */
function FilterGroup({
  label,
  used,
  children,
}: {
  label: string
  used: boolean
  children: React.ReactNode
}) {
  return (
    <div className="fd-filter-group" data-used={used}>
      <div className="fd-filter-group-head">
        <span className="fd-type-micro">{label}</span>
        {!used && <span className="fd-filter-group-unused">sin usar</span>}
      </div>
      {children}
    </div>
  )
}

function countSelectedAirlines(allAirlines: AirlineFilterOption[], selectedAirlines: string[]): number {
  return allAirlines.filter((airline) => isAirlineFilterSelected(airline, selectedAirlines)).length
}

/**
 * The chips above the list, and the way back out of each one. Every active
 * constraint gets exactly one chip, so removing them one at a time is possible
 * without opening the panel.
 */
function buildActiveFilterChips(
  filters: Filters,
  selectedAirlines: string[],
  allAirlines: AirlineFilterOption[],
): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = []

  const stopValue = stopFilterValue(filters)
  const stopSegment = STOP_SEGMENTS.find((segment) => segment.value === stopValue)
  if (stopSegment?.chip) chips.push({ id: "stops", label: stopSegment.chip })

  const layoverValue = layoverFilterValue(filters)
  const layoverSegment = LAYOVER_SEGMENTS.find((segment) => segment.value === layoverValue)
  if (layoverSegment?.chip) chips.push({ id: "layover", label: layoverSegment.chip })

  const baggageValue = baggageFilterValue(filters)
  const baggageSegment = BAGGAGE_SEGMENTS.find((segment) => segment.value === baggageValue)
  if (baggageSegment?.chip) chips.push({ id: "baggage", label: baggageSegment.chip })

  allAirlines
    .filter((airline) => isAirlineFilterSelected(airline, selectedAirlines))
    .forEach((airline) => chips.push({ id: `airline:${airline.id}`, label: airline.label }))

  return chips
}

function stopFilterValue(filters: Filters): StopFilterValue {
  if (filters.nonStop) return "direct"
  if (filters.maxStopsFilter === "1" || filters.maxStopsFilter === "2+") return filters.maxStopsFilter
  return "any"
}

function layoverFilterValue(filters: Filters): LayoverFilterValue {
  if (
    filters.maxLayoverMinutes === "120" ||
    filters.maxLayoverMinutes === "240" ||
    filters.maxLayoverMinutes === "360"
  ) {
    return filters.maxLayoverMinutes
  }

  return "any"
}

function baggageFilterValue(filters: Filters): BaggageFilterValue {
  if (filters.checkedBaggageRequired) return "checked"
  if (filters.carryOnRequired) return "carry"
  return "any"
}

function airlineToken(value: unknown): string {
  return String(value ?? "").trim().toUpperCase()
}

function airlineFilterCode(offer: CanonicalOffer): string {
  return String(offer.mainCarrier ?? offer.validatingCarrier ?? "").trim()
}

function airlineFilterLabel(offer: CanonicalOffer): string {
  const code = airlineFilterCode(offer)
  const codeToken = airlineToken(code)
  const segments = (offer.itineraries ?? []).flatMap((itinerary) => itinerary.segments ?? [])
  const segment = airlineNameSegmentForCode(segments, codeToken)
    ?? segments.find((candidate) => candidate.marketingCarrierName || candidate.operatingCarrierName)
  return resolveAirlineDisplayName({
    names: [
      segment?.marketingCarrier && airlineToken(segment.marketingCarrier) === codeToken
        ? segment.marketingCarrierName
        : undefined,
      segment?.operatingCarrier && airlineToken(segment.operatingCarrier) === codeToken
        ? segment.operatingCarrierName
        : undefined,
      segment?.marketingCarrierName,
      offer.airline,
      segment?.operatingCarrierName,
    ],
    codes: [
      code,
      offer.validatingCarrier,
      segment?.marketingCarrier,
      segment?.operatingCarrier,
    ],
    fallback: "Aerolínea",
  })
}

function airlineNameSegmentForCode(segments: Segment[], codeToken: string): Segment | undefined {
  if (!codeToken) return undefined

  return segments.find((segment) => (
    (airlineToken(segment.marketingCarrier) === codeToken && Boolean(segment.marketingCarrierName?.trim())) ||
    (airlineToken(segment.operatingCarrier) === codeToken && Boolean(segment.operatingCarrierName?.trim()))
  ))
}

function airlineFilterCodes(offer: CanonicalOffer): string[] {
  return Array.from(new Set([
    airlineFilterCode(offer),
    String(offer.validatingCarrier ?? "").trim(),
    !airlineFilterCode(offer) ? String(offer.airline ?? "").trim() : "",
  ].filter(Boolean)))
}

function isAirlineFilterSelected(airline: AirlineFilterOption, selectedAirlines: string[]): boolean {
  const tokens = airline.codes.length > 0 ? airline.codes : [airline.label]
  return tokens.every((token) => selectedAirlines.includes(token))
}

function offerMatchesSelectedAirlines(offer: CanonicalOffer, selectedAirlines: string[]): boolean {
  if (selectedAirlines.length === 0) return true

  const tokens = new Set([
    ...airlineFilterCodes(offer),
    String(offer.airline ?? "").trim(),
  ].filter(Boolean))
  return selectedAirlines.some((airline) => tokens.has(airline))
}

function maxLayoverForOffer(offer: CanonicalOffer): number {
  return (offer.itineraries ?? [])
    .flatMap((itinerary) => itinerary.layoverMinutes ?? [])
    .reduce((max, minutes) => Math.max(max, minutes), 0)
}

function isUsableUsdToPenRate(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 2 && value <= 8
}

function applyClientFilters(offers: CanonicalOffer[], filters: Filters, selectedAirlines: string[]) {
  let list = offers
  if (filters.nonStop) list = list.filter((offer) => maxStopsForFilter(offer) === 0)
  if (filters.maxStopsFilter === "1") list = list.filter((offer) => maxStopsForFilter(offer) <= 1)
  if (filters.maxStopsFilter === "2+") list = list.filter((offer) => maxStopsForFilter(offer) >= 2)
  if (filters.maxLayoverMinutes) {
    const maxMinutes = Number(filters.maxLayoverMinutes)
    list = list.filter((offer) => maxLayoverForOffer(offer) <= maxMinutes)
  }
  if (filters.carryOnRequired) list = list.filter((offer) => offer.baggage?.carryOnIncluded === true)
  if (filters.checkedBaggageRequired) list = list.filter((offer) => offer.baggage?.checkedIncluded === true)
  if (selectedAirlines.length > 0) list = list.filter((offer) => offerMatchesSelectedAirlines(offer, selectedAirlines))
  return list
}

function isMigrationResults(results: { migrationMonths?: unknown[]; request: SearchRequest }) {
  return results.request.searchMode === "month-view" || Boolean(results.migrationMonths?.length)
}

function applyMigrationFilters(results: SearchJobResponse, filteredOffers: CanonicalOffer[], sortMode: SortMode) {
  const visibleOfferIds = new Set(filteredOffers.map((offer) => offer.id))
  const migrationMonths = (results.migrationMonths ?? []).map((month) => {
    const monthOffers = month.offers?.length
      ? month.offers
      : month.offer ? [month.offer] : []
    const visibleMonthOffers = monthOffers.filter((offer) => visibleOfferIds.has(offer.id))
    const selectedOffer = cheapestOfferForMonth(visibleMonthOffers)

    return {
      ...month,
      offer: selectedOffer,
      filtered: !selectedOffer && monthOffers.length > 0 && month.status !== "loading",
    }
  })
  const offers = migrationMonths.flatMap((month) => month.offer ? [month.offer] : [])

  return {
    ...results,
    offers,
    migrationMonths,
    sortMode,
  }
}

function defaultSortForRequest(): SortMode {
  return DEFAULT_SORT_MODE
}

function cheapestOfferForMonth(offers: CanonicalOffer[]) {
  return offers.reduce<CanonicalOffer | undefined>((best, offer) => {
    if (!best) return offer
    const compared = compareNumber(priceAmount(offer), priceAmount(best))
      || compareNumber(totalDurationForDisplay(offer), totalDurationForDisplay(best))
    return compared < 0 ? offer : best
  }, undefined)
}

function sortOffersForDisplay(offers: CanonicalOffer[], sortMode: SortMode): CanonicalOffer[] {
  if (offers.length <= 1) return offers

  return offers
    .map((offer, index) => ({ offer, index }))
    .sort((left, right) => {
      const compared = compareOffersForDisplay(left.offer, right.offer, sortMode)
      return compared !== 0 ? compared : left.index - right.index
    })
    .map((item) => item.offer)
}

function compareOffersForDisplay(left: CanonicalOffer, right: CanonicalOffer, sortMode: SortMode): number {
  if (sortMode === "cheapest") {
    return compareNumber(priceAmount(left), priceAmount(right))
      || compareNumber(totalDurationForDisplay(left), totalDurationForDisplay(right))
  }

  if (sortMode === "fastest") {
    return compareNumber(totalDurationForDisplay(left), totalDurationForDisplay(right))
      || compareNumber(priceAmount(left), priceAmount(right))
  }

  return 0
}

function compareNumber(left: number, right: number): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function priceAmount(offer: CanonicalOffer): number {
  return normalizedNumber(offer.price?.total?.amount) ?? Number.POSITIVE_INFINITY
}

function totalDurationForDisplay(offer: CanonicalOffer): number {
  const metricDuration = normalizedNumber(offer.comparisonMetrics?.totalDurationMinutes)
  if (metricDuration !== null) return metricDuration

  const itineraryDuration = (offer.itineraries ?? [])
    .map((itinerary) => normalizedNumber(itinerary.durationMinutes) ?? 0)
    .reduce((sum, minutes) => sum + minutes, 0)

  return itineraryDuration > 0 ? itineraryDuration : Number.POSITIVE_INFINITY
}

function normalizedNumber(value: unknown): number | null {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}

function maxStopsForFilter(offer: CanonicalOffer): number {
  const itineraryStops = (offer.itineraries ?? [])
    .map((itinerary) => {
      if (typeof itinerary.stops === "number" && Number.isFinite(itinerary.stops)) {
        return itinerary.stops
      }

      return Math.max(0, (itinerary.segments?.length ?? 1) - 1)
    })
    .filter((stops) => Number.isFinite(stops))

  return itineraryStops.length > 0
    ? Math.max(...itineraryStops)
    : offer.stops
}

function formatAlertLines(message: string) {
  return message
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function readInitialSharedSearch(): SharedSearchState | null {
  try {
    return readSharedSearchFromUrl(new URL(window.location.href))
  } catch {
    return null
  }
}

function filtersFromRequest(request: SearchRequest | null | undefined): Filters {
  if (!request) return {}

  return {
    nonStop: request.nonStop,
    maxStopsFilter: request.maxStopsFilter,
    maxLayoverMinutes: request.maxLayoverMinutes,
    carryOnRequired: request.carryOnRequired,
    checkedBaggageRequired: request.checkedBaggageRequired ?? request.baggageRequired,
  }
}
