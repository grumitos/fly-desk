import { useState, type ReactNode } from "react"
import { AlertTriangle, ArrowUpDown, Briefcase, ChevronDown, ChevronUp, Clock, ExternalLink, Plane } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { CanonicalOffer, SearchJobResponse, SortMode } from "@/types"

interface ResultsPanelProps {
  results: SearchJobResponse | null
  loading: boolean
  sort: SortMode
  onSort: (s: SortMode) => void
  onSelectOffer: (offer: CanonicalOffer) => void
  selectedOfferId?: string
}

export function ResultsPanel({
  results,
  loading,
  sort,
  onSort,
  onSelectOffer,
  selectedOfferId,
}: ResultsPanelProps) {
  const offers = results?.offers ?? []
  const meta = results?.searchMeta
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const routeLabel = results?.request ? `${results.request.origin} -> ${results.request.destination}` : "Sin consulta"
  const warnings = uniqueWarnings([...(results?.warnings ?? []), ...(meta?.warnings ?? [])])

  return (
    <section className="fd-panel flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border bg-secondary/60 px-3 py-3">
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
                Duración
              </SortChip>
            </Segmented>
          </div>
        </div>
        {warnings.length > 0 && (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-2 text-xs text-warning-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <p className="line-clamp-2">{warnings.join(" ")}</p>
          </div>
        )}
      </div>

      {renderBody({
        loading,
        results,
        offers,
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
  selectedOfferId,
  expandedId,
  setExpandedId,
  onSelectOffer,
}: {
  loading: boolean
  results: SearchJobResponse | null
  offers: CanonicalOffer[]
  selectedOfferId?: string
  expandedId: string | null
  setExpandedId: (id: string | null) => void
  onSelectOffer: (offer: CanonicalOffer) => void
}) {
  if (loading && offers.length === 0) {
    return (
      <div className="flex-1 space-y-2 overflow-auto p-3">
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
        body="Ingresa origen, destino y fechas. La lista priorizará precio, duración, escalas, equipaje y proveedor."
      />
    )
  }

  if (!loading && results && offers.length === 0) {
    return (
      <EmptyState
        icon={<ArrowUpDown className="h-7 w-7" />}
        title="Sin resultados para esta consulta"
        body="Ajusta fechas, escalas, equipaje o aerolíneas para ampliar la cobertura."
      />
    )
  }

  return (
    <div className="flex-1 overflow-auto p-3">
      <div className="hidden grid-cols-[minmax(130px,1.1fr)_88px_88px_minmax(120px,1fr)_82px_64px_82px_86px_112px] gap-2 px-3 pb-2 text-[10px] font-bold uppercase text-muted-foreground lg:grid">
        <div>Aerolínea</div>
        <div>Salida</div>
        <div>Llegada</div>
        <div>Ruta</div>
        <div>Duración</div>
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
                      <div className="truncate text-sm font-bold">{offer.airline || "Aerolínea"}</div>
                      <div className="text-[11px] text-muted-foreground">{offer.providerSource}</div>
                    </div>
                  </div>

                  <DataPoint label="Salida" value={fmtTime(offer.departureDate)} />
                  <DataPoint label="Llegada" value={fmtTime(offer.arrivalDate)} />
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
                    {offer.baggageLabel || "-"}
                  </div>
                  <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                    {offer.purchasePaths?.length ? <ExternalLink className="h-3.5 w-3.5 text-primary" /> : null}
                    <span className="truncate">{offer.providerSource}</span>
                  </div>
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
                  <Detail label="Llegada" value={offer.arrivalDate || "-"} />
                  <Detail label="Regreso" value={offer.returnDate || "No aplica"} />
                  <Detail label="Duración" value={offer.duration || "-"} />
                  <Detail label="Equipaje" value={offer.baggageLabel || "Consultar"} />
                  <Detail label="Estado" value={offer.priceStatus || "Sin verificar"} />
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
    <div className="grid h-full min-h-[360px] place-items-center p-6 text-center">
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

function uniqueWarnings(messages: string[]) {
  return Array.from(new Set(messages.map((message) => message.trim()).filter(Boolean)))
}
