import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { DetailPanel } from "@/components/DetailPanel"
import { ResultsPanel } from "@/components/ResultsPanel"
import { SearchShell } from "@/components/SearchShell"
import { TopBar } from "@/components/TopBar"
import { AppIcon } from "@/components/ui/app-icon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useSearch } from "@/hooks/useSearch"
import {
  readSharedSearchFromText,
  readSharedSearchFromUrl,
  writeSharedSearchToClipboard,
  writeSharedSearchToUrl,
  type SharedSearchState,
} from "@/lib/search-share"
import type { CanonicalOffer, SearchJobResponse, SearchRequest, SortMode } from "@/types"

type Filters = {
  nonStop?: boolean
  maxStopsFilter?: string
  maxLayoverMinutes?: string
  baggageRequired?: boolean
}

export default function App() {
  const { results, loading, error, statusMessage, diagnosticLog, runSearch, cancel } = useSearch()
  const [initialSharedSearch] = useState<SharedSearchState | null>(() => readInitialSharedSearch())
  const initialSharedRequest = initialSharedSearch?.request ?? null
  const [sortMode, setSortMode] = useState<SortMode>(() => initialSharedSearch?.sortMode ?? "best-value")
  const [selectedOffer, setSelectedOffer] = useState<CanonicalOffer | null>(null)
  const [lastRequest, setLastRequest] = useState<SearchRequest | null>(null)
  const [workspaceReady, setWorkspaceReady] = useState(false)
  const [filters, setFilters] = useState<Filters>(() => filtersFromRequest(initialSharedSearch?.request))
  const [selectedAirlines, setSelectedAirlines] = useState<string[]>(() => initialSharedSearch?.request.includedAirlineCodes ?? [])
  const [mobilePanel, setMobilePanel] = useState<"results" | "filters" | "detail">("results")
  const [plainLogView, setPlainLogView] = useState(false)
  const [clipboardError, setClipboardError] = useState<string | null>(null)
  const [searchDraft, setSearchDraft] = useState<SearchRequest | null>(initialSharedRequest)
  const [resultsLayoutEditorActive] = useState(() => resultsLayoutEditorEnabledFromUrl())
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
    const counts = new Map<string, number>()
    candidateOffers.forEach((offer) => counts.set(offer.airline, (counts.get(offer.airline) ?? 0) + 1))
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [candidateOffers])

  const filteredCandidateOffers = useMemo(
    () => applyClientFilters(candidateOffers, filters, selectedAirlines),
    [candidateOffers, filters, selectedAirlines],
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
    if (selectedOffer && filteredResults.offers.some((offer) => offer.id === selectedOffer.id)) {
      return selectedOffer
    }

    return isMigrationResults(filteredResults) ? filteredResults.offers[0] ?? null : null
  }, [filteredResults, selectedOffer])

  const handleSearch = useCallback(
    (request: SearchRequest, sort?: SortMode) => {
      pendingSearchFrameRectRef.current = searchFrameRef.current?.getBoundingClientRect() ?? null
      const merged = { ...request, ...filtersRef.current, includedAirlineCodes: selectedAirlinesRef.current }
      const nextSort = sort ?? sortModeRef.current
      setClipboardError(null)
      setSelectedOffer(null)
      setSortMode(nextSort)
      setWorkspaceReady(false)
      setSearchDraft(merged)
      void runSearch(merged, nextSort).then((started) => {
        if (started) {
          setLastRequest(merged)
          setWorkspaceReady(true)
          writeSharedSearchToUrl(merged, nextSort)
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
      setSelectedOffer(null)
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

  const handleCopySearchConfig = useCallback(async () => {
    const draft = searchDraft ?? lastRequest ?? initialSharedRequest
    if (!draft) return

    const request = {
      ...draft,
      ...filtersRef.current,
      includedAirlineCodes: selectedAirlinesRef.current.length ? selectedAirlinesRef.current : undefined,
    }

    try {
      setClipboardError(null)
      await writeSharedSearchToClipboard(request, sortModeRef.current)
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
        const nextRequest = { ...lastRequest, ...merged, includedAirlineCodes: selectedAirlines }
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
        baggageRequired: undefined,
        includedAirlineCodes: undefined,
      }
      setLastRequest(nextRequest)
      writeSharedSearchToUrl(nextRequest, sortMode)
    }
  }, [lastRequest, sortMode])

  const toggleAirline = useCallback((airline: string) => {
    const nextAirlines = selectedAirlines.includes(airline)
      ? selectedAirlines.filter((item) => item !== airline)
      : [...selectedAirlines, airline]
    selectedAirlinesRef.current = nextAirlines
    setSelectedAirlines(nextAirlines)
    if (lastRequest) {
      const nextRequest = { ...lastRequest, ...filters, includedAirlineCodes: nextAirlines }
      setLastRequest(nextRequest)
      writeSharedSearchToUrl(nextRequest, sortMode)
    }
  }, [filters, lastRequest, selectedAirlines, sortMode])

  const hasFilters =
    Boolean(filters.nonStop) ||
    Boolean(filters.maxStopsFilter) ||
    Boolean(filters.maxLayoverMinutes) ||
    Boolean(filters.baggageRequired) ||
    selectedAirlines.length > 0
  const shouldShowWorkspace = workspaceReady || Boolean(results) || loading || resultsLayoutEditorActive
  const isSearchIdle = !shouldShowWorkspace

  useLayoutEffect(() => {
    const frame = searchFrameRef.current
    if (!frame) return

    const previousRect = pendingSearchFrameRectRef.current
    pendingSearchFrameRectRef.current = null
    if (!previousRect) return
    if (isSearchIdle) return
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
        duration: 240,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
      }
    )
  }, [isSearchIdle])

  const mobileTabs = [
    { id: "results" as const, label: "Resultados", icon: <AppIcon name="list" /> },
    { id: "filters" as const, label: "Filtros", icon: <AppIcon name="filters" /> },
    { id: "detail" as const, label: "Oferta", icon: <AppIcon name="detail" /> },
  ]

  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <TopBar
        copySearchDisabled={!searchDraft && !lastRequest && !initialSharedRequest}
        onCopySearchConfig={handleCopySearchConfig}
        onPasteSearchConfig={handlePasteSearchConfig}
      />

      {plainLogView ? (
        <PlainLogView lines={diagnosticLog} />
      ) : (
        <main
          className={`fd-search-stage mx-auto min-h-0 w-full max-w-[1560px] flex-1 px-2.5 sm:px-4 ${
            isSearchIdle ? "fd-search-stage-idle" : "fd-search-stage-active"
          }`}
        >
          <div
            ref={searchFrameRef}
            data-testid="search-shell-frame"
            className="fd-search-frame"
          >
            <SearchShell
              onSearch={handleSearch}
              loading={loading}
              onCancelSearch={cancel}
              controlsPlacement={shouldShowWorkspace ? "topbar" : "inline"}
              syncedRequest={lastRequest ?? initialSharedRequest}
              onSearchConfigDraftChange={setSearchDraft}
            />

            {(clipboardError || error || statusMessage) && (
              <div
                role="alert"
                className={`fd-popover-enter fd-alert mt-2 flex items-start gap-2 font-medium ${
                  clipboardError || error ? "fd-alert-error" : "fd-alert-warning"
                }`}
              >
                <AppIcon name="alert" className="mt-0.5" />
                <div className="min-w-0 space-y-1">
                  {formatAlertLines(clipboardError || error || statusMessage || "").map((line, index) => (
                    <p key={`${line}-${index}`} className={index === 0 ? "font-bold" : "text-xs leading-5"}>
                      {line}
                    </p>
                  ))}
                </div>
              </div>
            )}
          </div>

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
                    hasFilters={hasFilters}
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
                    loading={loading}
                    sort={sortMode}
                    onSort={handleSort}
                    onSelectOffer={(offer) => {
                      setSelectedOffer(offer)
                      setMobilePanel("detail")
                    }}
                    selectedOfferId={visibleSelectedOffer?.id}
                  />
                </div>

                <div className={`${mobilePanel === "detail" ? "block" : "hidden"} min-h-0 xl:block`}>
                  <DetailPanel offer={visibleSelectedOffer} request={filteredResults?.request} searchJobId={results?.searchJobId} />
                </div>
              </div>
            </Tabs>
          )}
        </main>
      )}
    </div>
  )
}

function PlainLogView({ lines }: { lines: string[] }) {
  const text = lines.length > 0
    ? lines.join("\n")
    : "Sin logs para copiar. Ejecuta una búsqueda y vuelve a esta vista."

  return (
    <main className="min-h-0 flex-1 bg-background">
      <textarea
        aria-label="Registro de búsqueda"
        readOnly
        spellCheck={false}
        value={text}
        className="fd-scrollbar h-full w-full resize-none border-0 bg-background p-4 font-mono text-xs leading-5 text-foreground outline-none"
      />
    </main>
  )
}

const FiltersPanel = memo(function FiltersPanel({
  hasFilters,
  filters,
  allAirlines,
  selectedAirlines,
  onClear,
  onFilterChange,
  onToggleAirline,
}: {
  hasFilters: boolean
  filters: Filters
  allAirlines: { name: string; count: number }[]
  selectedAirlines: string[]
  onClear: () => void
  onFilterChange: (next: Partial<Filters>) => void
  onToggleAirline: (airline: string) => void
}) {
  return (
    <aside className="fd-panel flex h-full min-h-0 flex-col overflow-hidden">
      <div className="fd-panel-header flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div>
            <h2 className="fd-panel-title">Filtros</h2>
            <p className="fd-panel-subtitle">Refina sin perder contexto</p>
          </div>
        </div>
        {hasFilters && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClear}
            className="h-7 px-2 text-xs text-primary"
          >
            <AppIcon name="x" />
            Limpiar
          </Button>
        )}
      </div>

      <div className="fd-scrollbar min-h-0 flex-1 overflow-auto p-2.5">
        <FilterGroup title="Escalas">
          <SwitchRow
            label="Solo directos"
            checked={Boolean(filters.nonStop)}
            onChange={(checked) => onFilterChange({ nonStop: checked ? true : undefined, maxStopsFilter: undefined })}
          />
          <ChoiceRow
            label="Hasta 1 escala"
            active={filters.maxStopsFilter === "1"}
            onClick={() => onFilterChange({ maxStopsFilter: filters.maxStopsFilter === "1" ? undefined : "1", nonStop: undefined })}
          />
          <ChoiceRow
            label="2+ escalas"
            active={filters.maxStopsFilter === "2+"}
            onClick={() => onFilterChange({ maxStopsFilter: filters.maxStopsFilter === "2+" ? undefined : "2+", nonStop: undefined })}
          />
        </FilterGroup>

        <FilterGroup title="Tiempo de escala">
          <ChoiceRow
            label="Hasta 2 h"
            active={filters.maxLayoverMinutes === "120"}
            onClick={() => onFilterChange({ maxLayoverMinutes: filters.maxLayoverMinutes === "120" ? undefined : "120" })}
          />
          <ChoiceRow
            label="Hasta 4 h"
            active={filters.maxLayoverMinutes === "240"}
            onClick={() => onFilterChange({ maxLayoverMinutes: filters.maxLayoverMinutes === "240" ? undefined : "240" })}
          />
          <ChoiceRow
            label="Hasta 6 h"
            active={filters.maxLayoverMinutes === "360"}
            onClick={() => onFilterChange({ maxLayoverMinutes: filters.maxLayoverMinutes === "360" ? undefined : "360" })}
          />
        </FilterGroup>

        <FilterGroup title="Equipaje">
          <SwitchRow
            label="Incluye equipaje"
            checked={Boolean(filters.baggageRequired)}
            onChange={(checked) => onFilterChange({ baggageRequired: checked ? true : undefined })}
          />
        </FilterGroup>

        <FilterGroup title="Aerolíneas">
          {allAirlines.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-secondary/60 px-3 py-4 text-center text-xs text-muted-foreground">
              Aparecerán al tener resultados.
            </div>
          ) : (
            <div className="fd-scrollbar-hidden max-h-64 space-y-1 overflow-auto pr-1">
              {allAirlines.map((airline) => (
                <label
                  key={airline.name}
                  className="flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm transition-[background-color,transform] duration-150 hover:bg-muted active:scale-[0.995]"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Checkbox
                      checked={selectedAirlines.includes(airline.name)}
                      onCheckedChange={() => onToggleAirline(airline.name)}
                      aria-label={airline.name}
                    />
                    <span className="truncate">{airline.name}</span>
                  </span>
                  <Badge variant="secondary" className="h-5 rounded-md px-1.5 text-[10px]">
                    {airline.count}
                  </Badge>
                </label>
              ))}
            </div>
          )}
        </FilterGroup>
      </div>
    </aside>
  )
})

function FilterGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-border py-2.5 first:border-t-0 first:pt-0 last:pb-0">
      <h3 className="fd-label mb-2">{title}</h3>
      <div className="space-y-1.5">{children}</div>
    </section>
  )
}

function SwitchRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm transition-colors duration-150 hover:bg-muted">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  )
}

function ChoiceRow({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      aria-pressed={active}
      className={`flex w-full transform-gpu items-center justify-between rounded-lg px-2 py-1.5 text-sm transition-[background-color,color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.995] ${
        active ? "fd-selected-passive" : "hover:bg-muted"
      }`}
    >
      {label}
      <span className={`h-2 w-2 rounded-full ${active ? "bg-foreground" : "bg-border"}`} />
    </Button>
  )
}

function maxLayoverForOffer(offer: CanonicalOffer): number {
  return (offer.itineraries ?? [])
    .flatMap((itinerary) => itinerary.layoverMinutes ?? [])
    .reduce((max, minutes) => Math.max(max, minutes), 0)
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
  if (filters.baggageRequired) list = list.filter((offer) => offer.hasCheckedBaggage)
  if (selectedAirlines.length > 0) list = list.filter((offer) => selectedAirlines.includes(offer.airline))
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

function cheapestOfferForMonth(offers: CanonicalOffer[]) {
  return [...offers].sort((left, right) =>
    compareNumber(priceAmount(left), priceAmount(right))
      || compareNumber(totalDurationForDisplay(left), totalDurationForDisplay(right)),
  )[0]
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

  const leftScore = normalizedNumber(left.valueScore)
  const rightScore = normalizedNumber(right.valueScore)
  if (leftScore !== null || rightScore !== null) {
    return compareNumber(leftScore ?? Number.POSITIVE_INFINITY, rightScore ?? Number.POSITIVE_INFINITY)
      || compareNumber(priceAmount(left), priceAmount(right))
      || compareNumber(totalDurationForDisplay(left), totalDurationForDisplay(right))
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

function resultsLayoutEditorEnabledFromUrl() {
  const params = new URLSearchParams(window.location.search)
  const raw = String(params.get("layoutEditor") || params.get("layout") || "").trim().toLowerCase()
  return raw === "1" || raw === "true" || raw === "editor"
}

function filtersFromRequest(request: SearchRequest | null | undefined): Filters {
  if (!request) return {}

  return {
    nonStop: request.nonStop,
    maxStopsFilter: request.maxStopsFilter,
    maxLayoverMinutes: request.maxLayoverMinutes,
    baggageRequired: request.baggageRequired,
  }
}
