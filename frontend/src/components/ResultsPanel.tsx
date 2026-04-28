import { memo, type ReactNode } from "react"
import { ResultCard } from "@/components/results/ResultCard"
import { AppIcon } from "@/components/ui/app-icon"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { CanonicalOffer, SearchJobResponse, SortMode } from "@/types"

interface ResultsPanelProps {
  results: SearchJobResponse | null
  loading: boolean
  sort: SortMode
  onSort: (s: SortMode) => void
  onSelectOffer: (offer: CanonicalOffer) => void
  selectedOfferId?: string
}

function ResultsPanelBase({
  results,
  loading,
  sort,
  onSort,
  onSelectOffer,
  selectedOfferId,
}: ResultsPanelProps) {
  const offers = results?.offers ?? []
  const meta = results?.searchMeta
  const routeLabel = results?.request ? `${results.request.origin} -> ${results.request.destination}` : "Sin consulta"
  const warnings = uniqueWarnings([...(results?.warnings ?? []), ...(meta?.warnings ?? [])])

  return (
    <section className="fd-panel flex h-full min-h-0 min-w-0 flex-col overflow-hidden" aria-busy={loading}>
      <div className="shrink-0 border-b border-border bg-secondary/60 px-3 py-2.5">
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

          <ToggleGroup
            type="single"
            value={sort}
            onValueChange={(value) => {
              if (value) onSort(value as SortMode)
            }}
            className="bg-card"
          >
            <ToggleGroupItem value="best-value" aria-label="Ordenar por mejor valor">
              Mejor valor
            </ToggleGroupItem>
            <ToggleGroupItem value="cheapest" aria-label="Ordenar por precio">
              Precio
            </ToggleGroupItem>
            <ToggleGroupItem value="fastest" aria-label="Ordenar por duración">
              Duración
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        {warnings.length > 0 && (
          <div className="fd-alert fd-alert-warning mt-2 flex min-h-9 items-start gap-2 text-xs font-medium">
            <AppIcon name="alert" className="mt-0.5" />
            <div className="min-w-0 space-y-1">
              {warnings.map((warning, index) => (
                <p key={`${warning}-${index}`}>{warning}</p>
              ))}
            </div>
          </div>
        )}
      </div>

      {renderBody({
        loading,
        results,
        offers,
        selectedOfferId,
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
  onSelectOffer,
}: {
  loading: boolean
  results: SearchJobResponse | null
  offers: CanonicalOffer[]
  selectedOfferId?: string
  onSelectOffer: (offer: CanonicalOffer) => void
}) {
  if (loading && offers.length === 0) {
    return (
      <div className="fd-scrollbar flex-1 space-y-2.5 overflow-auto p-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-[104px] w-full" />
        ))}
      </div>
    )
  }

  if (!results && !loading) {
    return (
      <EmptyState
        icon={<AppIcon name="flight" />}
        title="Busca vuelos para comparar"
        body="Ingresa origen, destino y fechas. La lista priorizará precio, duración, escalas, equipaje y proveedor."
      />
    )
  }

  if (!loading && results && offers.length === 0) {
    return (
      <EmptyState
        icon={<AppIcon name="bestValue" />}
        title="Sin resultados para esta consulta"
        body="Ajusta fechas, escalas, equipaje o aerolíneas para ampliar la cobertura."
      />
    )
  }

  return (
    <div className="fd-scrollbar flex-1 overflow-auto p-2.5">
      <div className="fd-results-list space-y-2.5 pt-1">
        {offers.map((offer) => (
          <ResultCard
            key={offer.id}
            offer={offer}
            selected={selectedOfferId === offer.id}
            passengerCount={passengerCountForRequest(results?.request)}
            onSelect={onSelectOffer}
          />
        ))}
      </div>
    </div>
  )
}

function EmptyState({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="grid h-full min-h-[320px] place-items-center p-6 text-center">
      <div>
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-secondary text-muted-foreground">{icon}</div>
        <h3 className="text-base font-bold">{title}</h3>
        <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted-foreground">{body}</p>
      </div>
    </div>
  )
}

export const ResultsPanel = memo(ResultsPanelBase)

function uniqueWarnings(messages: string[]) {
  return Array.from(new Set(messages.map((message) => message.trim()).filter(Boolean)))
}

function passengerCountForRequest(request: SearchJobResponse["request"] | undefined) {
  if (!request) return 1
  return Math.max(1, request.adults + request.children + request.infants)
}
