import { useCallback, useMemo, useState, type ReactNode } from "react"
import { Briefcase, Filter, Plane, ShieldCheck, Sparkles, X } from "lucide-react"
import { DetailPanel } from "@/components/DetailPanel"
import { ResultsPanel } from "@/components/ResultsPanel"
import { SearchShell } from "@/components/SearchShell"
import { TopBar, type WorkspaceSection } from "@/components/TopBar"
import { Badge } from "@/components/ui/badge"
import { useSearch } from "@/hooks/useSearch"
import type { CanonicalOffer, SearchRequest, SortMode, ViewMode } from "@/types"

type Filters = {
  nonStop?: boolean
  maxStopsFilter?: string
  baggageRequired?: boolean
}

export default function App() {
  const { results, loading, error, runSearch } = useSearch()
  const [activeSection, setActiveSection] = useState<WorkspaceSection>("search")
  const [sortMode, setSortMode] = useState<SortMode>("best-value")
  const [viewMode, setViewMode] = useState<ViewMode>("list")
  const [selectedOffer, setSelectedOffer] = useState<CanonicalOffer | null>(null)
  const [lastRequest, setLastRequest] = useState<SearchRequest | null>(null)
  const [filters, setFilters] = useState<Filters>({})
  const [selectedAirlines, setSelectedAirlines] = useState<string[]>([])

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
    if (filters.baggageRequired) list = list.filter((offer) => offer.baggage && offer.baggage !== "—")
    if (selectedAirlines.length > 0) list = list.filter((offer) => selectedAirlines.includes(offer.airline))
    return list
  }, [allOffers, filters, selectedAirlines])

  const filteredResults = useMemo(() => {
    if (!results) return null
    return { ...results, offers: filteredOffers }
  }, [results, filteredOffers])

  const handleSearch = useCallback(
    (request: SearchRequest, sort?: SortMode) => {
      const merged = { ...request, ...filters }
      const nextSort = sort ?? "best-value"
      setLastRequest(merged)
      setSelectedOffer(null)
      setActiveSection("search")
      setSortMode(nextSort)
      runSearch(merged, nextSort)
    },
    [filters, runSearch]
  )

  const handleSort = useCallback(
    (sort: SortMode) => {
      setSortMode(sort)
      if (lastRequest) {
        runSearch({ ...lastRequest, sortMode: sort }, sort)
      }
    },
    [lastRequest, runSearch]
  )

  const handleFilterChange = useCallback(
    (next: Partial<Filters>) => {
      setFilters((previous) => {
        const merged = { ...previous, ...next }
        if (lastRequest) {
          runSearch({ ...lastRequest, ...merged }, sortMode)
        }
        return merged
      })
    },
    [lastRequest, runSearch, sortMode]
  )

  const handleClearFilters = useCallback(() => {
    setFilters({})
    setSelectedAirlines([])
    if (lastRequest) {
      runSearch({ ...lastRequest, nonStop: undefined, maxStopsFilter: undefined, baggageRequired: undefined }, sortMode)
    }
  }, [lastRequest, runSearch, sortMode])

  const toggleAirline = useCallback((airline: string) => {
    setSelectedAirlines((previous) =>
      previous.includes(airline) ? previous.filter((item) => item !== airline) : [...previous, airline]
    )
  }, [])

  const hasFilters =
    Boolean(filters.nonStop) || Boolean(filters.maxStopsFilter) || Boolean(filters.baggageRequired) || selectedAirlines.length > 0

  return (
    <div className="min-h-screen bg-background text-foreground">
      <TopBar
        activeSection={activeSection}
        onSectionChange={setActiveSection}
        loading={loading}
        resultCount={filteredOffers.length}
      />

      <main className="mx-auto max-w-[1440px] space-y-3 px-3 py-3 sm:px-4">
        {activeSection === "search" ? (
          <>
            <SearchShell onSearch={handleSearch} loading={loading} />

            {error && (
              <div className="rounded-xl border border-destructive/25 bg-destructive/10 p-3 text-sm font-medium text-destructive">
                {error}
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 xl:grid-cols-[240px_minmax(0,1fr)_336px]">
              <FiltersPanel
                hasFilters={hasFilters}
                filters={filters}
                allAirlines={allAirlines}
                selectedAirlines={selectedAirlines}
                onClear={handleClearFilters}
                onFilterChange={handleFilterChange}
                onToggleAirline={toggleAirline}
              />

              <ResultsPanel
                results={filteredResults}
                loading={loading}
                sort={sortMode}
                onSort={handleSort}
                view={viewMode}
                onView={setViewMode}
                onSelectOffer={setSelectedOffer}
                selectedOfferId={selectedOffer?.id}
              />

              <DetailPanel offer={selectedOffer} searchJobId={results?.searchJobId} />
            </div>
          </>
        ) : (
          <MigratoryPanel />
        )}
      </main>
    </div>
  )
}

function FiltersPanel({
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
    <aside className="fd-panel h-fit p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
            <Filter className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold">Filtros</h2>
            <p className="text-xs text-muted-foreground">Refina la consulta</p>
          </div>
        </div>
        {hasFilters && (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-semibold text-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-3.5 w-3.5" />
            Limpiar
          </button>
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
            Apareceran al tener resultados.
          </div>
        ) : (
          <div className="max-h-64 space-y-1 overflow-auto pr-1">
            {allAirlines.map((airline) => (
              <label
                key={airline.name}
                className="flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-muted"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                      selectedAirlines.includes(airline.name)
                        ? "border-primary bg-primary"
                        : "border-input bg-card"
                    }`}
                  >
                    {selectedAirlines.includes(airline.name) && <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />}
                  </span>
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={selectedAirlines.includes(airline.name)}
                    onChange={() => onToggleAirline(airline.name)}
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
}

function FilterGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-border py-3 first:border-t-0 first:pt-0 last:pb-0">
      <h3 className="fd-label mb-2">{title}</h3>
      <div className="space-y-1.5">{children}</div>
    </section>
  )
}

function SwitchRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-muted">
      <span>{label}</span>
      <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${checked ? "bg-primary" : "bg-input"}`}>
        <input type="checkbox" className="sr-only" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        <span className={`block h-4 w-4 rounded-full bg-card shadow-sm transition-transform ${checked ? "translate-x-4" : "translate-x-0.5"}`} />
      </span>
    </label>
  )
}

function ChoiceRow({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        active ? "bg-primary/10 text-primary" : "hover:bg-muted"
      }`}
    >
      {label}
      <span className={`h-2 w-2 rounded-full ${active ? "bg-primary" : "bg-border"}`} />
    </button>
  )
}

function MigratoryPanel() {
  return (
    <section className="fd-panel min-h-[520px] overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary text-primary">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-base font-bold">Migratorio</h1>
              <p className="text-sm text-muted-foreground">Seccion preparada para requisitos, alertas y validaciones por destino.</p>
            </div>
          </div>
          <Badge variant="warning">Preparado</Badge>
        </div>
      </div>

      <div className="grid gap-0 px-4 py-2 lg:grid-cols-3">
        <FutureSection icon={<Plane className="h-4 w-4" />} title="Destino y nacionalidad">
          Base para mostrar reglas por pais, pasaporte, visa y escalas sensibles.
        </FutureSection>
        <FutureSection icon={<Briefcase className="h-4 w-4" />} title="Documentos">
          Espacio para checklists de vigencia, menores, permisos y requisitos operativos.
        </FutureSection>
        <FutureSection icon={<Sparkles className="h-4 w-4" />} title="Alertas">
          Preparado para advertencias por ruta sin inventar comportamiento backend.
        </FutureSection>
      </div>
    </section>
  )
}

function FutureSection({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="border-b border-border py-4 lg:border-b-0 lg:border-r lg:px-4 lg:last:border-r-0">
      <div className="mb-2 flex items-center gap-2">
        <div className="text-primary">{icon}</div>
        <h2 className="text-sm font-bold">{title}</h2>
      </div>
      <p className="text-sm leading-6 text-muted-foreground">{children}</p>
    </div>
  )
}
