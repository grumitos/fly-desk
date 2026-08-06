import { useCallback, useMemo, useState } from "react"
import { buildResultCardModel, type ResultCardModel, type ResultJourneySummary } from "@/components/results/result-card-model"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { AppIcon } from "@/components/ui/app-icon"
import { PanelSection, PanelSectionStack } from "@/components/ui/panel-section"
import { Switch } from "@/components/ui/switch"
import { toBackendPayload } from "@/lib/api"
import { buildOfferDetailSummary, formatOfferDate, type OfferDetailSummary } from "@/lib/offer-display"
import { bestPurchasePath, normalizeSafePurchaseUrl } from "@/lib/purchase-path"
import { providerDisplayName } from "@/lib/providers"
import type { CanonicalOffer, SearchRequest, Segment } from "@/types"
import { buildCommercialQuotation } from "../../../src/core/quotation"
import { normalizeQuotationOfferSnapshot, normalizeQuotationRequestSnapshot } from "../../../src/http-quotation-snapshot"

interface DetailPanelProps {
  offer: CanonicalOffer | null
  request?: SearchRequest
  searchJobId?: string
  usdToPenRate?: number
}

type QuotationState = {
  key: string
  text: string
  error?: boolean
}

export function DetailPanel({ offer, request, searchJobId, usdToPenRate }: DetailPanelProps) {
  const [visibleQuotationKey, setVisibleQuotationKey] = useState<string | null>(null)
  const [migrationPlan, setMigrationPlan] = useState(false)
  const [copiedOfferKey, setCopiedOfferKey] = useState<string | null>(null)
  const [pathFeedback, setPathFeedback] = useState<{ offerId: string; message: string } | null>(null)

  const quoteKey = offer && request
    ? `${offer.sourceSearchJobId ?? searchJobId ?? "snapshot"}:${offer.sourceOfferId ?? offer.id}:${request.origin}:${request.destination}:${request.departureDate ?? request.departureStart ?? ""}:${request.returnDate ?? request.returnStart ?? ""}`
    : undefined
  const copyKey = quoteKey ? `${quoteKey}:${migrationPlan ? "migration" : "standard"}` : undefined
  const preparedQuotation = useMemo<QuotationState | null>(() => {
    if (!offer || !request || !copyKey) return null

    try {
      const normalizedRequest = normalizeQuotationRequestSnapshot(toBackendPayload(request, "cheapest").request, offer)
      const normalizedOffer = normalizedRequest && normalizeQuotationOfferSnapshot(offer, normalizedRequest)
      if (!normalizedRequest || !normalizedOffer) throw new Error("Incomplete quotation snapshot")

      return {
        key: copyKey,
        text: buildCommercialQuotation(normalizedOffer, normalizedRequest, {
          migrationPlan,
          usdToPenRate: normalizedOffer.usdToPenRate ?? usdToPenRate,
        }),
      }
    } catch {
      return {
        key: copyKey,
        text: "No se pudo generar la cotización con los datos de esta oferta.",
        error: true,
      }
    }
  }, [copyKey, migrationPlan, offer, request, usdToPenRate])
  const activeQuotation = visibleQuotationKey === quoteKey ? preparedQuotation : null
  const copied = copiedOfferKey === copyKey
  const purchasePath = offer ? bestPurchasePath(offer) : undefined
  const flightCodes = offer ? offerFlightCodes(offer) : []
  const activePathFeedback = pathFeedback && pathFeedback.offerId === offer?.id ? pathFeedback.message : null
  const canQuote = Boolean(offer?.quotationPreparedAt && request && quoteKey && preparedQuotation && !preparedQuotation.error)
  const quotationActionTitle = !offer?.quotationPreparedAt
    ? "Esperando una tarifa actualizada del proveedor"
    : preparedQuotation?.error
      ? "La oferta no contiene todos los datos necesarios para cotizar"
      : "Cotizar y copiar"
  const purchasePathActionLabel = purchasePath?.type === "search-redirect" ? "Buscar" : "Abrir"
  const purchasePathActionTitle = purchasePath?.type === "search-redirect"
    ? "Abre la busqueda equivalente del proveedor; la disponibilidad puede variar."
    : "Abrir proveedor"
  const detail = offer ? buildOfferDetailSummary(offer) : null
  const resultModel = offer ? buildResultCardModel(offer, passengerCountForRequest(request)) : null
  const infoTiles = offer && detail && resultModel ? offerInfoTiles(offer, detail, resultModel) : []
  const conditionRows = offer && detail && resultModel ? offerConditionRows(offer, detail, resultModel) : []

  const markCopied = useCallback((key: string) => {
    setCopiedOfferKey(key)
    window.setTimeout(() => {
      setCopiedOfferKey((current) => (current === key ? null : current))
    }, 2000)
  }, [])

  const copyQuotationText = useCallback(async (key: string, text: string) => {
    const copiedToClipboard = await writeClipboardText(text)
    if (copiedToClipboard) {
      markCopied(key)
    }
  }, [markCopied])

  const handleQuotation = async () => {
    if (!quoteKey || !preparedQuotation) return
    setVisibleQuotationKey(quoteKey)

    if (!preparedQuotation.error) {
      await copyQuotationText(preparedQuotation.key, preparedQuotation.text)
    }
  }

  const copyToClipboard = async () => {
    if (!offer || !activeQuotation || activeQuotation.error) return
    await copyQuotationText(activeQuotation.key, activeQuotation.text)
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
            <p className="fd-panel-subtitle">{resultModel?.carrier.display ?? offer.airline}</p>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3" data-testid="detail-panel-body">
        <PanelSectionStack className="shrink-0" data-testid="offer-detail-info">
          <PanelSection title="Precio">
            <div className="fd-offer-detail-price">
              {resultModel?.price.totalLabel ?? "-"}
            </div>
            <div className="fd-offer-detail-meta">
              {resultModel?.price.perPersonLabel ? `${resultModel.price.perPersonLabel} por persona` : "Tarifa por adulto según proveedor"}
              {offer.priceConfidence ? ` · ${priceConfidenceLabel(offer.priceConfidence)}` : ""}
              {resultModel?.costamarRedirect ? ` · ${resultModel.costamarRedirect.label}` : ""}
            </div>
          </PanelSection>

          {resultModel && resultModel.journeys.length > 0 && (
            <PanelSection title="Horario" contentClassName="space-y-1.5">
              {resultModel.journeys.map((journey) => (
                <div key={journey.label} className="fd-offer-detail-row">
                  <span className="fd-label">{journey.label}</span>
                  <div className="flex min-w-0 items-baseline justify-between gap-2">
                    <span className="fd-offer-detail-data fd-offer-detail-data--mono">{offerScheduleLabel(journey)}</span>
                    <span className="fd-offer-detail-meta shrink-0">{offerScheduleDateLabel(journey)}</span>
                  </div>
                </div>
              ))}
            </PanelSection>
          )}

          {flightCodes.length > 0 && (
            <PanelSection title="Números de vuelo" contentClassName="flex flex-wrap gap-1.5" aria-label="Números de vuelo">
              {flightCodes.map((code) => (
                <span
                  key={code}
                  className="fd-offer-flight-code"
                >
                  {code}
                </span>
              ))}
            </PanelSection>
          )}

          {infoTiles.length > 0 && (
            <PanelSection contentClassName="fd-offer-info-grid">
              {infoTiles.map((item) => (
                <InfoTile key={item.label} label={item.label} value={item.value} />
              ))}
            </PanelSection>
          )}

          {conditionRows.length > 0 && (
            <PanelSection title="Condiciones" contentClassName="space-y-1">
              {conditionRows.map((item) => (
                <p key={item.label} className="fd-offer-condition-row">
                  {item.label}: <span className="font-semibold text-foreground">{item.value}</span>
                </p>
              ))}
            </PanelSection>
          )}

          {offer.warnings && offer.warnings.length > 0 && (
            <PanelSection className="fd-popover-enter">
              <Alert className="fd-alert fd-alert-warning text-xs font-medium">
                <AlertTitle className="mb-1 flex items-center gap-2 font-bold">
                  <AppIcon name="alert" />
                  Advertencias
                </AlertTitle>
                <AlertDescription className="space-y-1 text-current">
                  {offer.warnings.map((warning, index) => (
                    <p key={`${warning}-${index}`}>{warning}</p>
                  ))}
                </AlertDescription>
              </Alert>
            </PanelSection>
          )}
        </PanelSectionStack>

        {activeQuotation && (
          <PanelSection
            title="Cotización"
            action={(
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={copyToClipboard}
                disabled={Boolean(activeQuotation.error)}
                className="h-5 px-1.5 text-[11px] leading-none text-primary"
              >
                {copied ? <AppIcon name="check" /> : <AppIcon name="copy" />}
                {copied ? "Copiado" : "Copiar"}
              </Button>
            )}
            className="fd-popover-enter flex min-h-0 flex-1 flex-col border-t border-border"
            contentClassName="flex min-h-0 flex-1 flex-col"
            data-testid="quotation-section"
          >
            <pre
              data-testid="quotation-text"
              className={`fd-scrollbar min-h-0 flex-1 overflow-auto rounded-xl border p-3 whitespace-pre-wrap font-mono text-xs leading-relaxed ${
                activeQuotation.error
                  ? "border-destructive/50 bg-destructive-soft text-destructive-soft-foreground"
                  : "border-border bg-secondary/70 text-foreground"
              }`}
            >
              {activeQuotation.text}
            </pre>
          </PanelSection>
        )}
      </div>

      <div className="fd-panel-footer">
        {activePathFeedback && (
          <div className="fd-popover-enter mb-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
            {activePathFeedback}
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <label
            htmlFor="migration-plan"
            className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-1.5 text-xs font-semibold text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Switch
              id="migration-plan"
              checked={migrationPlan}
              aria-label="Paquete migratorio"
              onCheckedChange={setMigrationPlan}
            />
            <span>Migratorio</span>
          </label>
          <div className="flex items-center gap-1.5">
            {purchasePath && (
              <Button size="sm" variant="secondary" title={purchasePathActionTitle} onClick={handlePurchasePath}>
                <AppIcon name="externalLink" />
                {purchasePathActionLabel}
              </Button>
            )}
            <Button
              size="sm"
              title={quotationActionTitle}
              onClick={handleQuotation}
              disabled={!canQuote}
            >
              {copied ? <AppIcon name="check" /> : <AppIcon name="clipboard" />}
              {copied ? "Copiado" : "Cotizar"}
            </Button>
          </div>
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

function passengerCountForRequest(request: SearchRequest | undefined) {
  if (!request) return 1
  const adults = Number.isFinite(request.adults) ? request.adults : 1
  const children = Number.isFinite(request.children) ? request.children : 0
  const infants = Number.isFinite(request.infants) ? request.infants : 0
  return Math.max(1, adults + children + infants)
}

function offerInfoTiles(
  offer: CanonicalOffer,
  detail: OfferDetailSummary,
  model: ResultCardModel,
) {
  return [
    { label: "Proveedor", value: providerDisplayName(offer.providerSource) },
    { label: "Ruta", value: model.route || detail.routeLabel },
    { label: "Duración", value: model.duration },
    model.carrier.operatedBy
      ? { label: "Operado por", value: model.carrier.operatedBy.replace(/^\+\s*/, "") }
      : null,
    offer.fareMeta?.seatsRemaining
      ? { label: "Asientos", value: `${offer.fareMeta.seatsRemaining}` }
      : null,
    offer.fareMeta?.lastTicketingDate
      ? { label: "Emisión", value: formatOfferDate(offer.fareMeta.lastTicketingDate) }
      : null,
  ].filter((item): item is { label: string; value: string } => Boolean(item?.value && item.value !== "-"))
}

function offerConditionRows(
  offer: CanonicalOffer,
  detail: OfferDetailSummary,
  model: ResultCardModel,
) {
  const changeLabel = booleanLabel(offer.fareMeta?.changeable)
  const refundLabel = booleanLabel(offer.fareMeta?.refundable)

  return [
    { label: "Escalas", value: detail.stopsLabel || model.stops.label },
    model.stops.layoverLabel ? { label: "Escala máxima", value: model.stops.layoverLabel } : null,
    detail.baggageLabel && detail.baggageLabel !== "Consultar"
      ? { label: "Equipaje", value: detail.baggageLabel }
      : null,
    changeLabel ? { label: "Cambios", value: changeLabel } : null,
    refundLabel ? { label: "Reembolso", value: refundLabel } : null,
  ].filter((item): item is { label: string; value: string } => Boolean(item?.value))
}

function offerScheduleLabel(journey: ResultJourneySummary) {
  if (!journey.hasKnownSchedule) return journey.schedule
  const arrivalOffset = journey.arrivalDayOffset > 0 ? ` +${journey.arrivalDayOffset}` : ""
  return `${journey.departureTime} - ${journey.arrivalTime}${arrivalOffset}`
}

function offerScheduleDateLabel(journey: ResultJourneySummary) {
  const prefix = `${journey.label} `
  return journey.departureDateLabel.startsWith(prefix)
    ? journey.departureDateLabel.slice(prefix.length)
    : journey.departureDateLabel
}

async function writeClipboardText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return fallbackCopyText(text)
  }
}

function fallbackCopyText(text: string) {
  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.setAttribute("readonly", "")
  textarea.style.position = "fixed"
  textarea.style.left = "-9999px"
  textarea.style.top = "0"
  document.body.append(textarea)
  textarea.focus()
  textarea.select()

  try {
    return document.execCommand("copy")
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="fd-offer-info-tile">
      <div className="fd-label mb-1">{label}</div>
      <div className="fd-offer-detail-data" title={value}>{value}</div>
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
  return ""
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
