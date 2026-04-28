import { memo, useCallback, useMemo, useState, type ReactNode } from "react"
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
import type { CanonicalOffer, SearchRequest, SortMode } from "@/types"

type Filters = {
  nonStop?: boolean
  maxStopsFilter?: string
  maxLayoverMinutes?: string
  baggageRequired?: boolean
}

export default function App() {
  const { results, loading, error, diagnosticLog, runSearch } = useSearch()
  const [sortMode, setSortMode] = useState<SortMode>("best-value")
  const [selectedOffer, setSelectedOffer] = useState<CanonicalOffer | null>(null)
  const [lastRequest, setLastRequest] = useState<SearchRequest | null>(null)
  const [workspaceReady, setWorkspaceReady] = useState(false)
  const [filters, setFilters] = useState<Filters>({})
  const [selectedAirlines, setSelectedAirlines] = useState<string[]>([])
  const [mobilePanel, setMobilePanel] = useState<"results" | "filters" | "detail">("results")
  const [plainLogView, setPlainLogView] = useState(false)

  const allOffers = useMemo(() => results?.offers ?? [], [results?.offers])
  const allAirlines = useMemo(() => {
    const counts = new Map<string, number>()
    allOffers.forEach((offer) => counts.set(offer.airline, (counts.get(offer.airline) ?? 0) + 1))
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [allOffers])

  const filteredOffers = useMemo(() => {
    let list = allOffers
    if (filters.nonStop) list = list.filter((offer) => offer.stops === 0)
    if (filters.maxStopsFilter === "1") list = list.filter((offer) => offer.stops <= 1)
    if (filters.maxStopsFilter === "2+") list = list.filter((offer) => offer.stops >= 2)
    if (filters.maxLayoverMinutes) {
      const maxMinutes = Number(filters.maxLayoverMinutes)
      list = list.filter((offer) => maxLayoverForOffer(offer) <= maxMinutes)
    }
    if (filters.baggageRequired) list = list.filter((offer) => offer.hasCheckedBaggage)
    if (selectedAirlines.length > 0) list = list.filter((offer) => selectedAirlines.includes(offer.airline))
    return list
  }, [allOffers, filters, selectedAirlines])

  const filteredResults = useMemo(() => {
    if (!results) return null
    return { ...results, offers: filteredOffers }
  }, [results, filteredOffers])

  const handleSearch = useCallback(
    (request: SearchRequest, sort?: SortMode) => {
      const merged = { ...request, ...filters, includedAirlineCodes: selectedAirlines }
      const nextSort = sort ?? "best-value"
      setSelectedOffer(null)
      setSortMode(nextSort)
      setWorkspaceReady(false)
      void runSearch(merged, nextSort).then((started) => {
        if (started) {
          setLastRequest(merged)
          setWorkspaceReady(true)
        }
      })
    },
    [filters, runSearch, selectedAirlines]
  )

  const handleSort = useCallback(
    (sort: SortMode) => {
      setSortMode(sort)
      if (lastRequest) {
        runSearch({ ...lastRequest, sortMode: sort }, sort, { keepPreviousResults: true })
      }
    },
    [lastRequest, runSearch]
  )

  const handleFilterChange = useCallback(
    (next: Partial<Filters>) => {
      const merged = { ...filters, ...next }
      setFilters(merged)
      if (lastRequest) {
        runSearch({ ...lastRequest, ...merged, includedAirlineCodes: selectedAirlines }, sortMode, {
          keepPreviousResults: true,
        })
      }
    },
    [filters, lastRequest, runSearch, selectedAirlines, sortMode]
  )

  const handleClearFilters = useCallback(() => {
    setFilters({})
    setSelectedAirlines([])
    if (lastRequest) {
      runSearch(
        {
          ...lastRequest,
          nonStop: undefined,
          maxStopsFilter: undefined,
          maxLayoverMinutes: undefined,
          baggageRequired: undefined,
          includedAirlineCodes: undefined,
        },
        sortMode,
        { keepPreviousResults: true }
      )
    }
  }, [lastRequest, runSearch, sortMode])

  const toggleAirline = useCallback((airline: string) => {
    const nextAirlines = selectedAirlines.includes(airline)
      ? selectedAirlines.filter((item) => item !== airline)
      : [...selectedAirlines, airline]
    setSelectedAirlines(nextAirlines)
    if (lastRequest) {
      runSearch({ ...lastRequest, ...filters, includedAirlineCodes: nextAirlines }, sortMode, { keepPreviousResults: true })
    }
  }, [filters, lastRequest, runSearch, selectedAirlines, sortMode])

  const hasFilters =
    Boolean(filters.nonStop) ||
    Boolean(filters.maxStopsFilter) ||
    Boolean(filters.maxLayoverMinutes) ||
    Boolean(filters.baggageRequired) ||
    selectedAirlines.length > 0
  const shouldShowWorkspace = workspaceReady || Boolean(results) || loading
  const isSearchIdle = !shouldShowWorkspace
  const mobileTabs = [
    { id: "results" as const, label: "Resultados", icon: <AppIcon name="list" /> },
    { id: "filters" as const, label: "Filtros", icon: <AppIcon name="filters" /> },
    { id: "detail" as const, label: "Oferta", icon: <AppIcon name="detail" /> },
  ]

  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <TopBar
        logViewActive={plainLogView}
        onLogViewToggle={() => setPlainLogView((active) => !active)}
      />

      {plainLogView ? (
        <PlainLogView lines={diagnosticLog} />
      ) : (
        <main
          className={`mx-auto flex min-h-0 w-full max-w-[1560px] flex-1 flex-col gap-2.5 px-2.5 sm:px-4 ${
            isSearchIdle ? "justify-center pb-[10vh] pt-2.5 sm:pt-3" : "py-2.5 sm:py-3"
          }`}
        >
          <div
            className={`w-full transform-gpu transition-[transform,opacity] duration-200 ease-out ${
              isSearchIdle ? "mx-auto -translate-y-6" : "translate-y-0"
            }`}
          >
            <SearchShell onSearch={handleSearch} loading={loading} />

            {error && (
              <div
                role="alert"
                className="fd-popover-enter fd-alert fd-alert-error mt-2 flex items-start gap-2 font-medium"
              >
                <AppIcon name="alert" className="mt-0.5" />
                <div className="min-w-0 space-y-1">
                  {formatAlertLines(error).map((line, index) => (
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
              className="min-h-0 flex-1 gap-2.5"
            >
              <TabsList className="grid grid-cols-3 gap-1 xl:hidden">
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
                    selectedOfferId={selectedOffer?.id}
                  />
                </div>

                <div className={`${mobilePanel === "detail" ? "block" : "hidden"} min-h-0 xl:block`}>
                  <DetailPanel offer={selectedOffer} searchJobId={results?.searchJobId} />
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
    <aside className="fd-panel fd-scrollbar h-full overflow-auto p-2.5">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div>
            <h2 className="text-sm font-bold">Filtros</h2>
            <p className="text-xs text-muted-foreground">Refina sin perder contexto</p>
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
          <div className="fd-scrollbar max-h-64 space-y-1 overflow-auto pr-1">
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

function formatAlertLines(message: string) {
  return message
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
}
