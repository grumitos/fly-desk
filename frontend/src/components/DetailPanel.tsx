import { useState } from "react"
import { AlertTriangle, Check, Clipboard, Copy, ExternalLink, Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { fetchQuotation } from "@/lib/api"
import type { CanonicalOffer } from "@/types"

interface DetailPanelProps {
  offer: CanonicalOffer | null
  searchJobId?: string
}

export function DetailPanel({ offer, searchJobId }: DetailPanelProps) {
  const [quotation, setQuotation] = useState<{ offerId: string; text: string; error?: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const [copiedOfferId, setCopiedOfferId] = useState<string | null>(null)
  const [pathFeedback, setPathFeedback] = useState<string | null>(null)

  const activeQuotation = quotation && quotation.offerId === offer?.id ? quotation : null
  const copied = copiedOfferId === offer?.id
  const purchasePath = offer ? bestPurchasePath(offer) : undefined

  const handleQuotation = async () => {
    if (!offer || !searchJobId) return
    setLoading(true)
    try {
      const result = await fetchQuotation(searchJobId, offer.id)
      setQuotation({ offerId: offer.id, text: result.commercialText })
    } catch {
      setQuotation({ offerId: offer.id, text: "No se pudo generar la cotización. Revisa la oferta o intenta nuevamente.", error: true })
    } finally {
      setLoading(false)
    }
  }

  const copyToClipboard = async () => {
    if (!offer || !activeQuotation || activeQuotation.error) return
    try {
      await navigator.clipboard.writeText(activeQuotation.text)
      setCopiedOfferId(offer.id)
      setTimeout(() => {
        setCopiedOfferId((current) => (current === offer.id ? null : current))
      }, 2000)
    } catch {
      return
    }
  }

  const handlePurchasePath = async () => {
    if (!purchasePath) return
    setPathFeedback(null)

    if (purchasePath.url) {
      window.open(purchasePath.url, purchasePath.requiresNewTab ? "_blank" : "_self", "noopener,noreferrer")
      return
    }

    if (purchasePath.referenceText) {
      try {
        await navigator.clipboard.writeText(purchasePath.referenceText)
        setPathFeedback("Referencia copiada.")
      } catch {
        setPathFeedback("No se pudo copiar la referencia.")
      }
      return
    }

    setPathFeedback("Esta oferta no tiene enlace de proveedor disponible.")
  }

  if (!offer) {
    return (
      <Card className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl">
        <PanelHeader title="Oferta" subtitle="Sin selección" />
        <div className="grid min-h-0 flex-1 place-items-center p-6 text-center">
          <div>
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-lg bg-secondary text-primary">
              <ExternalLink className="h-6 w-6" />
            </div>
            <h2 className="text-sm font-bold">Selecciona una oferta</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              El detalle mostrará precio, condiciones y la cotización lista para copiar.
            </p>
          </div>
        </div>
      </Card>
    )
  }

  return (
    <Card className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl">
      <div className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-bold">Oferta seleccionada</h2>
            <p className="truncate text-xs text-muted-foreground">{offer.airline}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {purchasePath && (
              <Button size="sm" variant="secondary" onClick={handlePurchasePath}>
                <ExternalLink className="h-3.5 w-3.5" />
                Abrir
              </Button>
            )}
            <Button size="sm" onClick={handleQuotation} disabled={loading || !searchJobId}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clipboard className="h-3.5 w-3.5" />}
              {loading ? "Generando" : "Cotizar"}
            </Button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        <section>
          <div className="fd-label mb-1">Precio</div>
          <div className="font-mono text-2xl font-bold">
            {offer.price?.total?.currencyCode || "USD"}{" "}
            {offer.price?.total?.amount?.toLocaleString("es-PE", { minimumFractionDigits: 2 }) || "-"}
          </div>
          <div className="text-xs text-muted-foreground">
            Tarifa por adulto según proveedor
            {offer.priceConfidence ? ` · ${priceConfidenceLabel(offer.priceConfidence)}` : ""}
          </div>
        </section>

        <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-y border-border py-3">
          <InfoTile label="Proveedor" value={offer.providerSource || "-"} />
          <InfoTile label="Duración" value={offer.duration || "-"} />
          <InfoTile label="Salida" value={fmtDateTime(offer.departureDate)} />
          <InfoTile label="Regreso" value={offer.returnDate ? fmtDateTime(offer.returnDate) : "No aplica"} />
          <InfoTile label="Asientos" value={offer.fareMeta?.seatsRemaining ? `${offer.fareMeta.seatsRemaining}` : "Consultar"} />
          <InfoTile label="Emisión" value={offer.fareMeta?.lastTicketingDate ? fmtDate(offer.fareMeta.lastTicketingDate) : "Consultar"} />
        </div>

        <section className="border-b border-border pb-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold">Condiciones</span>
            </div>
            <Badge variant={offer.stops === 0 ? "success" : offer.stops === 1 ? "warning" : "secondary"}>
              {offer.stops === 0 ? "Directo" : `${offer.stops} escala${offer.stops > 1 ? "s" : ""}`}
            </Badge>
          </div>
          <div className="space-y-1 text-sm text-muted-foreground">
            <p>Equipaje: <span className="font-medium text-foreground">{offer.baggageLabel || "Consultar"}</span></p>
            <p>Cambios: <span className="font-medium text-foreground">{booleanLabel(offer.fareMeta?.changeable)}</span></p>
            <p>Reembolso: <span className="font-medium text-foreground">{booleanLabel(offer.fareMeta?.refundable)}</span></p>
            {offer.stopMeta && <p>Ruta: <span className="font-medium text-foreground">{offer.stopMeta}</span></p>}
          </div>
        </section>

        {pathFeedback && (
          <div className="rounded-lg border border-border bg-secondary/70 px-3 py-2 text-xs text-muted-foreground">
            {pathFeedback}
          </div>
        )}

        {offer.warnings && offer.warnings.length > 0 && (
          <section className="rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs text-warning-foreground">
            <div className="mb-1 flex items-center gap-2 font-bold">
              <AlertTriangle className="h-3.5 w-3.5" />
              Advertencias
            </div>
            <div className="space-y-1">
              {offer.warnings.map((warning, index) => (
                <p key={`${warning}-${index}`}>{warning}</p>
              ))}
            </div>
          </section>
        )}

        {activeQuotation && (
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="fd-label">Cotización</div>
                <p className="text-xs text-muted-foreground">Texto comercial para enviar al cliente</p>
              </div>
              <button
                type="button"
                onClick={copyToClipboard}
                disabled={Boolean(activeQuotation.error)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-primary transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copiado" : "Copiar"}
              </button>
            </div>
            <pre
              className={`max-h-64 overflow-auto rounded-xl border p-3 whitespace-pre-wrap font-mono text-xs leading-relaxed ${
                activeQuotation.error
                  ? "border-destructive/30 bg-destructive/10 text-destructive"
                  : "border-border bg-secondary/70 text-foreground"
              }`}
            >
              {activeQuotation.text}
            </pre>
          </section>
        )}
      </div>
    </Card>
  )
}

function PanelHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="border-b border-border px-4 py-3">
      <h2 className="text-sm font-bold">{title}</h2>
      <p className="text-xs text-muted-foreground">{subtitle}</p>
    </div>
  )
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="fd-label mb-1">{label}</div>
      <div className="truncate text-sm font-semibold">{value}</div>
    </div>
  )
}

function fmtDateTime(value?: string) {
  if (!value) return "-"
  try {
    return new Date(value).toLocaleString("es-PE", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
  } catch {
    return value
  }
}

function fmtDate(value?: string) {
  if (!value) return "-"
  try {
    return new Date(value).toLocaleDateString("es-PE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    })
  } catch {
    return value
  }
}

function booleanLabel(value?: boolean) {
  if (value === true) return "Permitido"
  if (value === false) return "No permitido"
  return "Consultar"
}

function priceConfidenceLabel(value: string) {
  const labels: Record<string, string> = {
    indicative: "indicativa",
    live: "en vivo",
    validated: "validada",
    "landing-page": "landing",
    stale: "desactualizada",
  }
  return labels[value] ?? value
}

function bestPurchasePath(offer: CanonicalOffer) {
  const paths = offer.purchasePaths ?? []
  return [...paths].sort((left, right) => purchasePathRank(right) - purchasePathRank(left))[0]
}

function purchasePathRank(path: NonNullable<CanonicalOffer["purchasePaths"]>[number]) {
  const precisionScore: Record<string, number> = {
    "exact-offer": 40,
    "exact-search": 30,
    "broad-search": 20,
    manual: 10,
  }
  const stateScore = path.state === "api_bookable" || path.state === "deeplink_exact" ? 20 : 0
  return (precisionScore[path.precision] ?? 0) + stateScore + (path.score ?? 0)
}
