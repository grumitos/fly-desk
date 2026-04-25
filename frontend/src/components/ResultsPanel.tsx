import { useState, type ReactNode } from "react"
import { ArrowUpDown, Briefcase, CalendarDays, ChevronDown, ChevronUp, Clock, Plane, Rows3, Table2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { CanonicalOffer, SearchJobResponse, SortMode, ViewMode } from "@/types"

interface ResultsPanelProps {
  results: SearchJobResponse | null
  loading: boolean
  sort: SortMode
  onSort: (s: SortMode) => void
  view: ViewMode
  onView: (v: ViewMode) => void
  onSelectOffer: (offer: CanonicalOffer) => void
  selectedOfferId?: string
}

export function ResultsPanel({
  results,
  loading,
  sort,
  onSort,
  view,
  onView,
  onSelectOffer,
  selectedOfferId,
}: ResultsPanelProps) {
  const offers = results?.offers ?? []
  const meta = results?.searchMeta
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const routeLabel = results?.request ? `${results.request.origin} -> ${results.request.destination}` : "Sin consulta"

  return (
    <section className="fd-panel min-w-0 overflow-hidden">
      <div className="border-b border-border bg-secondary/60 px-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-bold">Resultados</h2>
              {loading && <Badge variant="warning">Actualizando</Badge>}
              {meta?.partial && !loading && <Badge variant="warning">Parcial</Badge>}
            </div>
            <p className="text-xs text-muted-foreground">
              {routeLabel} · {offers.length} oferta{offers.length === 1 ? "" : "s"}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Segmented>
              <SortChip active={sort === "best-value"} onClick={() => onSort("best-value")}>
                Mejor valor
              </SortChip>
              <SortChip active={sort === "cheapest"} onClick={() => onSort("cheapest")}>
                Precio
              </SortChip>
              <SortChip active={sort === "fastest"} onClick={() => onSort("fastest")}>
                Duracion
              </SortChip>
            </Segmented>
            <Segmented>
              <IconChip active={view === "list"} label="Lista" onClick={() => onView("list")}>
                <Rows3 className="h-3.5 w-3.5" />
              </IconChip>
              <IconChip active={view === "calendar"} label="Calendario" onClick={() => onView("calendar")}>
                <CalendarDays className="h-3.5 w-3.5" />
              </IconChip>
            </Segmented>
          </div>
        </div>
      </div>

      {renderBody({
        loading,
        results,
        offers,
        view,
        selectedOfferId,
        expandedId,
        setExpandedId,
        onSelectOffer,
      })}
    </section>
  )
}

function renderBody({
  loading,
  results,
  offers,
  view,
  selectedOfferId,
  expandedId,
  setExpandedId,
  onSelectOffer,
}: {
  loading: boolean
  results: SearchJobResponse | null
  offers: CanonicalOffer[]
  view: ViewMode
  selectedOfferId?: string
  expandedId: string | null
  setExpandedId: (id: string | null) => void
  onSelectOffer: (offer: CanonicalOffer) => void
}) {
  if (loading && offers.length === 0) {
    return (
      <div className="space-y-2 p-3">
        {Array.from({ length: 7 }).map((_, index) => (
          <div key={index} className="h-[74px] w-full animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
    )
  }

  if (!results && !loading) {
    return (
      <EmptyState
        icon={<Plane className="h-7 w-7" />}
        title="Busca vuelos para comparar"
        body="Ingresa origen, destino y fechas. La lista priorizara precio, duracion, escalas, equipaje y proveedor."
      />
    )
  }

  if (!loading && results && offers.length === 0) {
    return (
      <EmptyState
        icon={<ArrowUpDown className="h-7 w-7" />}
        title="Sin resultados para esta consulta"
        body="Ajusta fechas, escalas, equipaje o aerolineas para ampliar la cobertura."
      />
    )
  }

  if (view === "calendar") {
    return (
      <div className="p-3">
        <div className="rounded-xl border border-dashed border-border bg-secondary/50 p-8 text-center">
          <Table2 className="mx-auto mb-3 h-8 w-8 text-primary" />
          <h3 className="text-sm font-bold">Calendario preparado</h3>
          <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted-foreground">
            La vista calendario queda reservada para matriz de fechas y celdas comparables cuando la consulta flexible entregue cobertura.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-3">
      <div className="hidden grid-cols-[minmax(130px,1.1fr)_88px_88px_minmax(120px,1fr)_82px_64px_82px_86px_112px] gap-2 px-3 pb-2 text-[10px] font-bold uppercase text-muted-foreground lg:grid">
        <div>Aerolinea</div>
        <div>Salida</div>
        <div>Llegada</div>
        <div>Ruta</div>
        <div>Duracion</div>
        <div>Esc.</div>
        <div>Equipaje</div>
        <div>Proveedor</div>
        <div className="text-right">Precio</div>
      </div>
      <div className="space-y-2">
        {offers.map((offer) => {
          const selected = selectedOfferId === offer.id
          const expanded = expandedId === offer.id
          return (
            <article
              key={offer.id}
              className={`overflow-hidden rounded-xl border transition-colors ${
                selected ? "border-primary/50 bg-primary/5" : "border-border bg-card hover:border-primary/30"
              }`}
            >
              <button type="button" onClick={() => onSelectOffer(offer)} className="w-full text-left">
                <div className="grid gap-2 px-3 py-3 lg:grid-cols-[minmax(130px,1.1fr)_88px_88px_minmax(120px,1fr)_82px_64px_82px_86px_112px] lg:items-center">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary">
                      <Plane className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-bold">{offer.airline || "Aerolinea"}</div>
                      <div className="text-[11px] text-muted-foreground">{offer.providerSource}</div>
                    </div>
                  </div>

                  <DataPoint label="Salida" value={fmtTime(offer.departureDate)} />
                  <DataPoint label="Llegada" value={fmtTime(offer.returnDate)} />
                  <div className="min-w-0 text-xs text-muted-foreground">
                    <div className="truncate font-medium text-foreground">{offer.stopMeta || "Ruta principal"}</div>
                    <div className="truncate">Comparar condiciones antes de cotizar</div>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3.5 w-3.5" />
                    {offer.duration || "-"}
                  </div>
                  <div>
                    {offer.stops === 0 ? (
                      <Badge variant="success" className="h-5 rounded-md px-1.5 text-[10px]">
                        Directo
                      </Badge>
                    ) : (
                      <Badge variant={offer.stops === 1 ? "warning" : "secondary"} className="h-5 rounded-md px-1.5 text-[10px]">
                        {offer.stops}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Briefcase className="h-3.5 w-3.5" />
                    {offer.baggage || "-"}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{offer.providerSource}</div>
                  <div className="text-right">
                    <div className="font-mono text-base font-bold text-foreground">
                      {offer.price?.total?.currencyCode || "USD"} {offer.price?.total?.amount?.toLocaleString("es-PE") || "-"}
                    </div>
                    <div className="text-[10px] text-muted-foreground">por adulto</div>
                  </div>
                </div>
              </button>

              <div className="flex items-center justify-between border-t border-border/70 px-3 py-2">
                <div className="flex items-center gap-2">
                  {selected && <Badge className="h-5 rounded-md px-1.5 text-[10px]">Seleccionado</Badge>}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={(event) => {
                    event.stopPropagation()
                    setExpandedId(expanded ? null : offer.id)
                  }}
                >
                  {expanded ? "Menos" : "Detalle"}
                  {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </Button>
              </div>

              {expanded && (
                <div className="grid gap-3 border-t border-border bg-secondary/40 px-3 py-3 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                  <Detail label="Salida completa" value={offer.departureDate || "-"} />
                  <Detail label="Regreso" value={offer.returnDate || "No aplica"} />
                  <Detail label="Duracion" value={offer.duration || "-"} />
                  <Detail label="Equipaje" value={offer.baggage || "Consultar"} />
                </div>
              )}
            </article>
          )
        })}
      </div>
    </div>
  )
}

function EmptyState({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="grid min-h-[360px] place-items-center p-6 text-center">
      <div>
        <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-xl bg-secondary text-primary">{icon}</div>
        <h3 className="text-base font-bold">{title}</h3>
        <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted-foreground">{body}</p>
      </div>
    </div>
  )
}

function Segmented({ children }: { children: ReactNode }) {
  return <div className="inline-flex items-center rounded-lg border border-input bg-card p-0.5">{children}</div>
}

function SortChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-7 rounded-md px-2.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        active ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-accent hover:text-foreground"
      }`}
    >
      {children}
    </button>
  )
}

function IconChip({ active, onClick, label, children }: { active: boolean; onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`inline-flex h-7 w-8 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        active ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-accent hover:text-foreground"
      }`}
    >
      {children}
    </button>
  )
}

function DataPoint({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-sm font-bold">{value}</div>
      <div className="text-[11px] text-muted-foreground lg:hidden">{label}</div>
    </div>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-bold uppercase text-muted-foreground">{label}</div>
      <div className="text-foreground">{value}</div>
    </div>
  )
}

function fmtTime(dateStr?: string) {
  if (!dateStr) return "-"
  try {
    const date = new Date(dateStr)
    return date.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", hour12: false })
  } catch {
    return dateStr
  }
}
