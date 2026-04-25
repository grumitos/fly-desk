import { useState } from "react"
import { Check, Clipboard, Copy, ExternalLink, Loader2 } from "lucide-react"
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

  const activeQuotation = quotation && quotation.offerId === offer?.id ? quotation : null
  const copied = copiedOfferId === offer?.id

  const handleQuotation = async () => {
    if (!offer || !searchJobId) return
    setLoading(true)
    try {
      const result = await fetchQuotation(searchJobId, offer.id)
      setQuotation({ offerId: offer.id, text: result.commercialText })
    } catch {
      setQuotation({ offerId: offer.id, text: "No se pudo generar la cotizacion. Revisa la oferta o intenta nuevamente.", error: true })
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

  if (!offer) {
    return (
      <Card className="h-fit min-h-[360px] rounded-xl">
        <PanelHeader title="Oferta" subtitle="Sin seleccion" />
        <div className="grid min-h-[280px] place-items-center p-6 text-center">
          <div>
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-lg bg-secondary text-primary">
              <ExternalLink className="h-6 w-6" />
            </div>
            <h2 className="text-sm font-bold">Selecciona una oferta</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              El detalle mostrara precio, condiciones y la cotizacion lista para copiar.
            </p>
          </div>
        </div>
      </Card>
    )
  }

  return (
    <Card className="h-fit rounded-xl">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-bold">Oferta seleccionada</h2>
            <p className="truncate text-xs text-muted-foreground">{offer.airline}</p>
          </div>
          <Button size="sm" onClick={handleQuotation} disabled={loading || !searchJobId}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clipboard className="h-3.5 w-3.5" />}
            {loading ? "Generando" : "Cotizar"}
          </Button>
        </div>
      </div>

      <div className="space-y-4 p-4">
        <section>
          <div className="fd-label mb-1">Precio</div>
          <div className="font-mono text-2xl font-bold">
            {offer.price?.total?.currencyCode || "USD"}{" "}
            {offer.price?.total?.amount?.toLocaleString("es-PE", { minimumFractionDigits: 2 }) || "-"}
          </div>
          <div className="text-xs text-muted-foreground">Tarifa por adulto segun proveedor</div>
        </section>

        <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-y border-border py-3">
          <InfoTile label="Proveedor" value={offer.providerSource || "-"} />
          <InfoTile label="Duracion" value={offer.duration || "-"} />
          <InfoTile label="Salida" value={fmtDateTime(offer.departureDate)} />
          <InfoTile label="Regreso" value={offer.returnDate ? fmtDateTime(offer.returnDate) : "No aplica"} />
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
            <p>Equipaje: <span className="font-medium text-foreground">{offer.baggage || "Consultar"}</span></p>
            {offer.stopMeta && <p>Ruta: <span className="font-medium text-foreground">{offer.stopMeta}</span></p>}
          </div>
        </section>

        {activeQuotation && (
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="fd-label">Cotizacion</div>
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
