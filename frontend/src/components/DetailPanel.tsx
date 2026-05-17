import { useState } from "react"
import { Button } from "@/components/ui/button"
import { AppIcon } from "@/components/ui/app-icon"
import { fetchQuotation } from "@/lib/api"
import { buildOfferDetailSummary, formatOfferDate } from "@/lib/offer-display"
import { bestPurchasePath, normalizeSafePurchaseUrl } from "@/lib/purchase-path"
import { providerDisplayName } from "@/lib/providers"
import type { CanonicalOffer, SearchRequest, Segment } from "@/types"

interface DetailPanelProps {
  offer: CanonicalOffer | null
  request?: SearchRequest
  searchJobId?: string
}

export function DetailPanel({ offer, request, searchJobId }: DetailPanelProps) {
  const [quotation, setQuotation] = useState<{ key: string; text: string; error?: boolean } | null>(null)
  const [loadingKey, setLoadingKey] = useState<string | null>(null)
  const [copiedOfferKey, setCopiedOfferKey] = useState<string | null>(null)
  const [pathFeedback, setPathFeedback] = useState<{ offerId: string; message: string } | null>(null)

  const quoteSearchJobId = offer?.sourceSearchJobId ?? searchJobId
  const quoteOfferId = offer?.sourceOfferId ?? offer?.id
  const quoteKey = offer && request
    ? `${quoteSearchJobId ?? "snapshot"}:${quoteOfferId ?? offer.id}:${request.origin}:${request.destination}:${request.departureDate ?? request.departureStart ?? ""}:${request.returnDate ?? request.returnStart ?? ""}`
    : undefined
  const activeQuotation = quotation && quotation.key === quoteKey ? quotation : null
  const copied = copiedOfferKey === quoteKey
  const purchasePath = offer ? bestPurchasePath(offer) : undefined
  const flightCodes = offer ? offerFlightCodes(offer) : []
  const activePathFeedback = pathFeedback && pathFeedback.offerId === offer?.id ? pathFeedback.message : null
  const loading = Boolean(quoteKey && loadingKey === quoteKey)
  const canQuote = Boolean(offer && request && quoteKey)
  const purchasePathActionLabel = purchasePath?.type === "search-redirect" ? "Buscar" : "Abrir"
  const purchasePathActionTitle = purchasePath?.type === "search-redirect"
    ? "Abre la busqueda equivalente del proveedor; la disponibilidad puede variar."
    : "Abrir proveedor"
  const detail = offer ? buildOfferDetailSummary(offer) : null

  const handleQuotation = async () => {
    if (!offer || !request || !quoteKey) return
    setLoadingKey(quoteKey)
    try {
      const result = await fetchQuotation({
        searchSessionId: quoteSearchJobId,
        offerId: quoteOfferId,
        offer,
        request,
      })
      setQuotation({ key: quoteKey, text: result.commercialText })
    } catch {
      setQuotation({ key: quoteKey, text: "No se pudo generar la cotización. Revisa la oferta o intenta nuevamente.", error: true })
    } finally {
      setLoadingKey((current) => (current === quoteKey ? null : current))
    }
  }

  const copyToClipboard = async () => {
    if (!offer || !activeQuotation || activeQuotation.error) return
    try {
      await navigator.clipboard.writeText(activeQuotation.text)
      setCopiedOfferKey(quoteKey ?? null)
      setTimeout(() => {
        setCopiedOfferKey((current) => (current === quoteKey ? null : current))
      }, 2000)
    } catch {
      return
    }
  }

  const handlePurchasePath = async () => {
    if (!offer || !purchasePath) return
    setPathFeedback(null)

    if (purchasePath.url) {
      const safeUrl = normalizeSafePurchaseUrl(purchasePath.url)
      if (!safeUrl) {
        setPathFeedback({ offerId: offer.id, message: "El enlace del proveedor no es válido o no usa HTTPS/HTTP." })
        return
      }

      window.open(safeUrl, purchasePath.requiresNewTab ? "_blank" : "_self", "noopener,noreferrer")
      return
    }

    if (purchasePath.referenceText) {
      try {
        await navigator.clipboard.writeText(purchasePath.referenceText)
        setPathFeedback({ offerId: offer.id, message: "Referencia copiada." })
      } catch {
        setPathFeedback({ offerId: offer.id, message: "No se pudo copiar la referencia." })
      }
      return
    }

    setPathFeedback({ offerId: offer.id, message: "Esta oferta no tiene enlace de proveedor disponible." })
  }

  if (!offer) {
    return (
      <section className="fd-panel flex h-full min-h-0 flex-col overflow-hidden">
        <PanelHeader title="Oferta" subtitle="Sin selección" />
        <div className="grid min-h-0 flex-1 place-items-center p-6 text-center">
          <div>
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
              <AppIcon name="externalLink" />
            </div>
            <h2 className="text-sm font-bold">Selecciona una oferta</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              El detalle mostrará precio, condiciones y la cotización lista para copiar.
            </p>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="fd-panel flex h-full min-h-0 flex-col overflow-hidden">
      <div className="fd-panel-header">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="fd-panel-title">Oferta seleccionada</h2>
            <p className="fd-panel-subtitle">{offer.airline}</p>
          </div>
        </div>
      </div>

      <div className="fd-scrollbar min-h-0 flex-1 space-y-3 overflow-auto p-3">
        <section>
          <div className="fd-label mb-1">Precio</div>
          <div className="font-mono text-xl font-bold">
            {offer.price?.total?.currencyCode || "USD"}{" "}
            {offer.price?.total?.amount?.toLocaleString("es-PE", { minimumFractionDigits: 2 }) || "-"}
          </div>
          <div className="text-xs text-muted-foreground">
            Tarifa por adulto según proveedor
            {offer.priceConfidence ? ` · ${priceConfidenceLabel(offer.priceConfidence)}` : ""}
          </div>
        </section>

        {flightCodes.length > 0 && (
          <section className="border-b border-border pb-3">
            <div className="fd-label mb-2">Numeros de vuelo</div>
            <div className="flex flex-wrap gap-1.5" aria-label="Numeros de vuelo">
              {flightCodes.map((code) => (
                <span
                  key={code}
                  className="rounded-md border border-border bg-secondary px-2 py-1 font-mono text-xs font-bold text-foreground"
                >
                  {code}
                </span>
              ))}
            </div>
          </section>
        )}

        <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 border-y border-border py-3">
          <InfoTile label="Proveedor" value={providerDisplayName(offer.providerSource)} />
          <InfoTile label="Duración" value={offer.duration || "-"} />
          <InfoTile label="Salida" value={detail?.departureDateTime ?? "-"} />
          <InfoTile label="Regreso" value={detail?.returnDateTime ?? "No aplica"} />
          <InfoTile label="Asientos" value={offer.fareMeta?.seatsRemaining ? `${offer.fareMeta.seatsRemaining}` : "Consultar"} />
          <InfoTile label="Emisión" value={offer.fareMeta?.lastTicketingDate ? formatOfferDate(offer.fareMeta.lastTicketingDate) : "Consultar"} />
        </div>

        <section className="border-b border-border pb-3">
          <div className="mb-2">
            <span className="text-sm font-bold">Condiciones</span>
          </div>
          <div className="space-y-1 text-sm text-muted-foreground">
            <p>Escalas: <span className="font-medium text-foreground">{detail?.stopsLabel ?? "Consultar"}</span></p>
            <p>Equipaje: <span className="font-medium text-foreground">{detail?.baggageLabel ?? "Consultar"}</span></p>
            <p>Cambios: <span className="font-medium text-foreground">{booleanLabel(offer.fareMeta?.changeable)}</span></p>
            <p>Reembolso: <span className="font-medium text-foreground">{booleanLabel(offer.fareMeta?.refundable)}</span></p>
            <p>Ruta: <span className="font-medium text-foreground">{detail?.routeLabel ?? offer.stopMeta ?? "Consultar"}</span></p>
          </div>
        </section>

        {offer.warnings && offer.warnings.length > 0 && (
          <section className="fd-popover-enter fd-alert fd-alert-warning text-xs font-medium">
            <div className="mb-1 flex items-center gap-2 font-bold">
              <AppIcon name="alert" />
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
          <section className="fd-popover-enter space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="fd-label">Cotización</div>
                <p className="text-xs text-muted-foreground">Listo para copiar</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={copyToClipboard}
                disabled={Boolean(activeQuotation.error)}
                className="h-8 px-2 text-xs text-primary"
              >
                {copied ? <AppIcon name="check" /> : <AppIcon name="copy" />}
                {copied ? "Copiado" : "Copiar"}
              </Button>
            </div>
            <pre
              className={`fd-scrollbar max-h-64 overflow-auto rounded-xl border p-3 whitespace-pre-wrap font-mono text-xs leading-relaxed ${
                activeQuotation.error
                  ? "border-destructive/50 bg-destructive-soft text-destructive-soft-foreground"
                  : "border-border bg-secondary/70 text-foreground"
              }`}
            >
              {activeQuotation.text}
            </pre>
          </section>
        )}
      </div>

      <div className="fd-panel-footer">
        {activePathFeedback && (
          <div className="fd-popover-enter mb-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
            {activePathFeedback}
          </div>
        )}
        <div className="flex items-center justify-end gap-1.5">
          {purchasePath && (
            <Button size="sm" variant="secondary" title={purchasePathActionTitle} onClick={handlePurchasePath}>
              <AppIcon name="externalLink" />
              {purchasePathActionLabel}
            </Button>
          )}
          <Button size="sm" onClick={handleQuotation} disabled={loading || !canQuote}>
            {loading ? <AppIcon name="loading" spin /> : <AppIcon name="clipboard" />}
            {loading ? "Generando" : "Cotizar"}
          </Button>
        </div>
      </div>
    </section>
  )
}

function PanelHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="fd-panel-header">
      <h2 className="fd-panel-title">{title}</h2>
      <p className="fd-panel-subtitle">{subtitle}</p>
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

function offerFlightCodes(offer: CanonicalOffer): string[] {
  const tokens = (offer.itineraries ?? [])
    .flatMap((itinerary) => itinerary.segments)
    .map((segment) => flightCodeLabel(segment))
    .filter(Boolean)

  return Array.from(new Set(tokens))
}

function flightCodeLabel(segment: Segment) {
  const carrier = String(segment.marketingCarrier ?? "").trim().toUpperCase()
  const flightNumber = typeof segment.flightNumber === "string"
    ? segment.flightNumber.trim().toUpperCase().replace(/\s+/g, "")
    : ""

  if (!flightNumber) return ""
  if (carrier && !flightNumber.startsWith(carrier)) return `${carrier}${flightNumber}`
  return flightNumber
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
