import { useCallback, useEffect, useRef, useState } from "react"
import { buildResultCardModel, type ResultCardModel, type ResultJourneySummary } from "@/components/results/result-card-model"
import { Button } from "@/components/ui/button"
import { AppIcon } from "@/components/ui/app-icon"
import { PanelSection, PanelSectionStack } from "@/components/ui/panel-section"
import { fetchQuotation } from "@/lib/api"
import { buildOfferDetailSummary, formatOfferDate, type OfferDetailSummary } from "@/lib/offer-display"
import { bestPurchasePath, normalizeSafePurchaseUrl } from "@/lib/purchase-path"
import { providerDisplayName } from "@/lib/providers"
import type { CanonicalOffer, SearchRequest, Segment } from "@/types"

interface DetailPanelProps {
  offer: CanonicalOffer | null
  request?: SearchRequest
  searchJobId?: string
}

type QuotationState = {
  key: string
  text: string
  error?: boolean
}

export function DetailPanel({ offer, request, searchJobId }: DetailPanelProps) {
  const [quotation, setQuotation] = useState<QuotationState | null>(null)
  const [loadingKey, setLoadingKey] = useState<string | null>(null)
  const [copiedOfferKey, setCopiedOfferKey] = useState<string | null>(null)
  const [pathFeedback, setPathFeedback] = useState<{ offerId: string; message: string } | null>(null)
  const pendingQuotationRef = useRef<{ key: string; promise: Promise<QuotationState> } | null>(null)
  const preparedQuotationRef = useRef<QuotationState | null>(null)

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
  const canQuote = Boolean(offer && request && quoteKey && quoteSearchJobId && quoteOfferId)
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

  const requestQuotation = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!offer || !request || !quoteKey || !quoteSearchJobId || !quoteOfferId) return null
    if (quotation?.key === quoteKey && !quotation.error) return quotation

    const prepared = preparedQuotationRef.current
    if (prepared?.key === quoteKey && !prepared.error) {
      if (!options.silent) setQuotation(prepared)
      return prepared
    }

    const pending = pendingQuotationRef.current
    if (pending?.key === quoteKey) {
      if (!options.silent) setLoadingKey(quoteKey)
      try {
        const result = await pending.promise
        if (!result.error) {
          if (options.silent) {
            preparedQuotationRef.current = result
          } else {
            setQuotation(result)
          }
        } else if (!options.silent) {
          setQuotation(result)
        }
        return result
      } finally {
        if (!options.silent) {
          setLoadingKey((current) => (current === quoteKey ? null : current))
        }
      }
    }

    const promise = fetchQuotation({
      searchSessionId: quoteSearchJobId,
      offerId: quoteOfferId,
    })
      .then((result): QuotationState => ({ key: quoteKey, text: result.commercialText }))
      .catch((): QuotationState => ({
        key: quoteKey,
        text: "No se pudo generar la cotización. Revisa la oferta o intenta nuevamente.",
        error: true,
      }))
    pendingQuotationRef.current = { key: quoteKey, promise }
    if (!options.silent) setLoadingKey(quoteKey)

    try {
      const result = await promise
      if (!result.error && options.silent) {
        preparedQuotationRef.current = result
      } else if (!result.error || !options.silent) {
        setQuotation(result)
      }
      return result
    } finally {
      if (pendingQuotationRef.current?.key === quoteKey) {
        pendingQuotationRef.current = null
      }
      if (!options.silent) {
        setLoadingKey((current) => (current === quoteKey ? null : current))
      }
    }
  }, [offer, quoteKey, quoteOfferId, quoteSearchJobId, quotation, request])

  useEffect(() => {
    if (!canQuote || !quoteKey || activeQuotation || pendingQuotationRef.current?.key === quoteKey) return
    void requestQuotation({ silent: true })
  }, [activeQuotation, canQuote, quoteKey, requestQuotation])

  const handleQuotation = async () => {
    if (!quoteKey) return
    const result = activeQuotation && !activeQuotation.error
      ? activeQuotation
      : await requestQuotation()

    if (result && !result.error) {
      await copyQuotationText(result.key, result.text)
    }
  }

  const copyToClipboard = async () => {
    if (!offer || !activeQuotation || activeQuotation.error || !quoteKey) return
    await copyQuotationText(quoteKey, activeQuotation.text)
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
              <div className="fd-alert fd-alert-warning text-xs font-medium">
                <div className="mb-1 flex items-center gap-2 font-bold">
                  <AppIcon name="alert" />
                  Advertencias
                </div>
                <div className="space-y-1">
                  {offer.warnings.map((warning, index) => (
                    <p key={`${warning}-${index}`}>{warning}</p>
                  ))}
                </div>
              </div>
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
        <div className="flex items-center justify-end gap-1.5">
          {purchasePath && (
            <Button size="sm" variant="secondary" title={purchasePathActionTitle} onClick={handlePurchasePath}>
              <AppIcon name="externalLink" />
              {purchasePathActionLabel}
            </Button>
          )}
          <Button size="sm" onClick={handleQuotation} disabled={loading || !canQuote}>
            {loading ? <AppIcon name="loading" spin /> : copied ? <AppIcon name="check" /> : <AppIcon name="clipboard" />}
            {loading ? "Generando" : copied ? "Copiado" : "Cotizar"}
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
    { label: "Escalas", value: model.stops.label || detail.stopsLabel },
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
