import { useCallback, useEffect, useId, useMemo, useRef, useState, type MutableRefObject } from "react"
import { buildResultCardModel, providerBadgeForId } from "@/components/results/result-card-model"
import { QuotationOverlay } from "@/components/QuotationOverlay"
import { Button } from "@/components/ui/button"
import { AppIcon } from "@/components/ui/app-icon"
import { Switch } from "@/components/ui/switch"
import { Kbd } from "@/components/ui/kbd"
import { ShortcutTooltip } from "@/components/ui/tooltip"
import { requestQuotation, toBackendPayload } from "@/lib/api"
import { writeClipboardText } from "@/lib/clipboard"
import { formatDayMonth } from "@/lib/format"
import { openInNewTab } from "@/lib/new-tab"
import { diffDays } from "@/lib/iso-date"
import { formatJourneyDuration, formatOfferDate, isoDatePart, stationPlaceName, timeOfIso } from "@/lib/offer-display"
import { passengerCount } from "@/lib/passengers"
import { bestPurchasePath, normalizeSafePurchaseUrl } from "@/lib/purchase-path"
import { motionToken } from "@/lib/reduced-motion"
import { cn } from "@/lib/utils"
import type { CanonicalOffer, Itinerary, SearchRequest, Segment } from "@/types"
import { buildCommercialQuotation } from "../../../src/core/quotation"
import { normalizeQuotationOfferSnapshot, normalizeQuotationRequestSnapshot } from "../../../src/http-quotation-snapshot"

/*
 * Plates 1b, 8a, 1f, 1h and 3c: one component in three containers, told apart
 * by container queries (02 §2). The quote error lives here, beside the button
 * that asked for it, not in the page notice (11 §4).
 */

const MIGRATION_PLAN_SESSION_KEY = "fly-desk:migration-plan:v1"
/* The copy confirmation holds for `--fd-hold-confirmacion`, which reduced
   motion does not zero (it is reading time), and leaves in
   `--fd-dur-exit-confirmacion`, which it does. */
function confirmationHold(): number {
  return motionToken("--fd-hold-confirmacion")
}

function confirmationExit(): number {
  return motionToken("--fd-dur-exit-confirmacion")
}
/* Plate 3c: the long pair on a desk, the short one where the notice shares its
   row with the retry; a container query picks. */
const QUOTATION_ERROR_TITLE = "No se pudo confirmar la tarifa"
const QUOTATION_ERROR_DETAIL = "El proveedor no respondió. El texto no se copió."
const QUOTATION_ERROR_TITLE_SHORT = "No se copió"
const QUOTATION_ERROR_DETAIL_SHORT = "El proveedor no confirmó la tarifa."

interface DetailPanelProps {
  offer: CanonicalOffer | null
  request?: SearchRequest
  searchJobId?: string
  /** A confirmed fare on its way up to the list, which draws it instead. */
  onOfferRevalidated?: (offer: CanonicalOffer) => void
  embedded?: boolean
  mobileDirect?: boolean
  /** The sheets' own way out; the desk column has none. */
  onClose?: () => void
  /** Filled only while the offer can be quoted, so `C` never starts a quote the button would refuse. */
  quotationShortcutRef?: MutableRefObject<(() => void) | null>
}

type QuotationState = {
  key: string
  text: string
  error?: boolean
}

type VerifiedQuotation = {
  quoteKey: string
  migrationPlan: boolean
  offer: CanonicalOffer
  commercialText: string
}

type CopyConfirmation = { key: string; closing: boolean }

export function DetailPanel({
  offer,
  request,
  searchJobId,
  onOfferRevalidated,
  embedded = false,
  mobileDirect = false,
  onClose,
  quotationShortcutRef,
}: DetailPanelProps) {
  const migrationSwitchId = useId()
  const [visibleQuotationKey, setVisibleQuotationKey] = useState<string | null>(null)
  const [migrationPlanChoice, setMigrationPlanChoiceState] = useState<boolean | null>(() => readMigrationPlanChoice())
  const [confirmation, setConfirmation] = useState<CopyConfirmation | null>(null)
  const [verifiedQuotation, setVerifiedQuotation] = useState<VerifiedQuotation | null>(null)
  const [quotationFailureKey, setQuotationFailureKey] = useState<string | null>(null)
  const [loadingQuotationKey, setLoadingQuotationKey] = useState<string | null>(null)
  const [pathFeedback, setPathFeedback] = useState<{ offerId: string; message: string } | null>(null)
  const confirmationTimers = useRef<number[]>([])
  const migrationPlan = migrationPlanChoice ?? (request?.searchMode === "month-view")

  const quotationSessionId = offer?.sourceSearchJobId ?? searchJobId
  const quotationOfferId = offer?.sourceOfferId ?? offer?.id
  const quoteKey = offer && request
    ? `${quotationSessionId ?? "snapshot"}:${quotationOfferId}:${request.origin}:${request.destination}:${request.departureDate ?? request.departureStart ?? ""}:${request.returnDate ?? request.returnStart ?? ""}`
    : undefined
  const copyKey = quoteKey ? `${quoteKey}:${migrationPlan ? "migration" : "standard"}` : undefined
  const preparedQuotation = useMemo<QuotationState | null>(() => {
    return offer && request && copyKey
      ? composeQuotation(offer, request, copyKey, migrationPlan)
      : null
  }, [copyKey, migrationPlan, offer, request])
  const verifiedQuotationState = useMemo<QuotationState | null>(() => {
    if (!request || !copyKey || !verifiedQuotation || verifiedQuotation.quoteKey !== quoteKey) return null
    if (verifiedQuotation.migrationPlan === migrationPlan) {
      return { key: copyKey, text: verifiedQuotation.commercialText }
    }

    /* 05 §5: the toggle rewrites the text live, from the confirmed offer and
       the rate that came with it, never from another offer's rate. */
    return composeQuotation(verifiedQuotation.offer, request, copyKey, migrationPlan)
  }, [copyKey, migrationPlan, quoteKey, request, verifiedQuotation])
  const displayOffer = verifiedQuotation && verifiedQuotation.quoteKey === quoteKey
    ? verifiedQuotation.offer
    : offer
  /* An unconfirmed quotation is never shown or copied: a fare that does not
     exist reaches the customer as a price the agency must honour. */
  const quotationFailed = Boolean(quoteKey) && quotationFailureKey === quoteKey
  const activeQuotation = visibleQuotationKey === quoteKey && !quotationFailed
    ? verifiedQuotationState
    : null
  const copied = Boolean(copyKey) && confirmation?.key === copyKey
  const activeQuotationPreparedAt = verifiedQuotation && verifiedQuotation.quoteKey === quoteKey
    ? verifiedQuotation.offer.priceVerifiedAt ?? offer?.quotationPreparedAt
    : offer?.quotationPreparedAt
  const purchasePath = displayOffer ? bestPurchasePath(displayOffer) : undefined
  const activePathFeedback = pathFeedback && pathFeedback.offerId === offer?.id ? pathFeedback.message : null
  const isQuoting = loadingQuotationKey === quoteKey
  const canQuote = Boolean(
    offer?.quotationPreparedAt
    && request
    && quoteKey
    && quotationSessionId
    && quotationOfferId
    && preparedQuotation
    && !preparedQuotation.error
    && !isQuoting,
  )
  const quotationActionTitle = !offer?.quotationPreparedAt
    ? "Esperando una tarifa actualizada del proveedor"
    : !quotationSessionId || !quotationOfferId
      ? "La oferta no está asociada a una búsqueda que pueda revalidarse"
    : preparedQuotation?.error
      ? "La oferta no contiene todos los datos necesarios para cotizar"
      : isQuoting
        ? "Validando la tarifa con el proveedor"
        : "Cotizar y copiar"

  const clearConfirmationTimers = useCallback(() => {
    confirmationTimers.current.forEach((timer) => window.clearTimeout(timer))
    confirmationTimers.current = []
  }, [])

  useEffect(() => clearConfirmationTimers, [clearConfirmationTimers])

  const markCopied = useCallback((key: string) => {
    clearConfirmationTimers()
    setConfirmation({ key, closing: false })
    confirmationTimers.current.push(window.setTimeout(() => {
      setConfirmation((current) => (current?.key === key ? { key, closing: true } : current))
      confirmationTimers.current.push(window.setTimeout(() => {
        setConfirmation((current) => (current?.key === key ? null : current))
      }, confirmationExit()))
    }, confirmationHold()))
  }, [clearConfirmationTimers])

  const setMigrationPlanChoice = useCallback((nextChoice: boolean) => {
    setMigrationPlanChoiceState(nextChoice)
    try {
      sessionStorage.setItem(MIGRATION_PLAN_SESSION_KEY, nextChoice ? "1" : "0")
    } catch {
      // Quotation stays usable when session storage is unavailable.
    }
  }, [])

  const copyQuotationText = useCallback(async (key: string, text: string) => {
    if (await writeClipboardText(text)) markCopied(key)
  }, [markCopied])

  const handleQuotation = async () => {
    if (
      !quoteKey
      || !copyKey
      || !quotationSessionId
      || !quotationOfferId
      || !preparedQuotation
      || preparedQuotation.error
      || loadingQuotationKey === quoteKey
    ) return

    /* 05 §6: Safari and Firefox drop clipboard access when the user activation
       ends, which the confirming round trip outlasts, so the write is claimed
       inside the gesture and fed once the fare is confirmed. */
    const deferredCopy = beginDeferredCopy()
    setQuotationFailureKey(null)
    setLoadingQuotationKey(quoteKey)
    try {
      const response = await requestQuotation({
        searchSessionId: quotationSessionId,
        offerId: quotationOfferId,
        migrationPlan,
      })
      setVerifiedQuotation({
        quoteKey,
        migrationPlan,
        offer: response.offer,
        commercialText: response.commercialText,
      })
      onOfferRevalidated?.(response.offer)
      setVisibleQuotationKey(quoteKey)
      deferredCopy.settle(response.commercialText)
      const copiedAhead = deferredCopy.written ? await deferredCopy.written : false
      if (copiedAhead || await writeClipboardText(response.commercialText)) markCopied(copyKey)
    } catch {
      deferredCopy.abandon()
      setQuotationFailureKey(quoteKey)
      setVisibleQuotationKey(quoteKey)
    } finally {
      setLoadingQuotationKey((current) => (current === quoteKey ? null : current))
    }
  }

  /* Refreshed on every render so `C` never runs a stale closure; a detail
     leaving the screen clears only its own. */
  useEffect(() => {
    if (!quotationShortcutRef) return
    const quote = canQuote ? () => { void handleQuotation() } : null
    quotationShortcutRef.current = quote
    return () => {
      if (quotationShortcutRef.current === quote) quotationShortcutRef.current = null
    }
  })

  const handlePurchasePath = async () => {
    if (!offer || !purchasePath) return
    setPathFeedback(null)

    if (purchasePath.url) {
      const safeUrl = normalizeSafePurchaseUrl(purchasePath.url)
      if (!safeUrl) {
        setPathFeedback({ offerId: offer.id, message: "El enlace del proveedor no es válido o no usa HTTPS/HTTP." })
        return
      }

      if (!openProviderUrl(safeUrl, purchasePath.requiresNewTab)) {
        setPathFeedback({
          offerId: offer.id,
          message: "El navegador bloqueó la ventana del proveedor. Permite las ventanas emergentes de Fly Desk e intenta nuevamente.",
        })
      }
      return
    }

    if (purchasePath.referenceText) {
      const copiedReference = await writeClipboardText(purchasePath.referenceText)
      setPathFeedback({ offerId: offer.id, message: copiedReference ? "Referencia copiada." : "No se pudo copiar la referencia." })
      return
    }

    setPathFeedback({ offerId: offer.id, message: "Esta oferta no tiene enlace de proveedor disponible." })
  }

  if (!offer) {
    return (
      <section className={cn("fd-detail-panel flex h-full min-h-0 flex-col overflow-hidden", embedded && "fd-detail-panel--embedded")}>
        {!embedded && <div className="fd-detail-header">
          <h2 className="fd-detail-title">Oferta</h2>
          <p className="fd-detail-provider">Sin selección</p>
        </div>}
        <p className="fd-detail-empty">Selecciona una oferta para ver su detalle.</p>
      </section>
    )
  }

  /* Everything stated about the fare comes from the offer last confirmed. */
  const shown = displayOffer ?? offer
  const model = buildResultCardModel(shown, passengerCount(request))
  const provider = providerBadgeForId(shown.providerSource)
  const legs = itineraryLegs(shown)
  const conditions = conditionPairs(shown, model.baggage.label)

  return (
    <section
      /* Keyed so the panel arrives again for every offer (05 §8). */
      key={offer.id}
      className={cn("fd-detail-panel flex h-full min-h-0 flex-col overflow-hidden", embedded && "fd-detail-panel--embedded")}
      data-quote-error={quotationFailed || undefined}
    >
      {/* One close, two shapes: a cross on a desk sheet, a back chevron on a
          phone, chosen by container query under one accessible name. */}
      <div className="fd-detail-header">
        {onClose && (
          <button
            type="button"
            className="fd-detail-close fd-focus-ring"
            aria-label="Cerrar oferta"
            onClick={onClose}
          >
            <AppIcon name="chevronLeft" size={18} className="fd-detail-close-back" />
            <AppIcon name="x" size={16} className="fd-detail-close-cross" />
          </button>
        )}
        <h2 className="fd-detail-title">Oferta</h2>
        <p className="fd-detail-provider">
          {provider.icon && (
            <img src={provider.icon} alt="" className="fd-detail-provider-icon" decoding="async" />
          )}
          <span className="truncate">{provider.label}</span>
        </p>
      </div>

      <div className="fd-detail-hero">
        <div className="fd-detail-hero-lead">
          <span className="fd-detail-carrier" title={model.carrier.name}>{model.carrier.name}</span>
          <span className="fd-detail-price">{model.price.label}</span>
          <span className="fd-detail-pax">{passengerSummary(request)}</span>
        </div>
        {model.carrier.logo && (
          <img src={model.carrier.logo} alt="" className="fd-detail-logo" decoding="async" />
        )}
      </div>

      <div className="fd-detail-body fd-scrollbar-hidden min-h-0 flex-1 overflow-y-auto" data-testid="detail-panel-body">
        {legs.map((leg, index) => (
          <div key={leg.key} className={cn(index > 0 && "fd-detail-section")}>
            <div className="fd-leg-head">
              <span className="fd-type-micro">{leg.title}</span>
              <span className="fd-leg-summary">{leg.summary}</span>
            </div>
            <div className="fd-rail">
              {leg.rows.map((row, rowIndex) => (
                <RailRow key={rowIndex} row={row} />
              ))}
            </div>
          </div>
        ))}

        {conditions.length > 0 && (
          <div className="fd-detail-section">
            <span className="fd-type-micro fd-condition-heading">Condiciones y tarifa</span>
            <div className="fd-condition-list">
              {conditions.map((pair) => (
                <div key={pair.label} className="fd-condition-row">
                  <span className="fd-condition-label">{pair.label}</span>
                  <span className={cn("fd-condition-value", pair.figure && "fd-condition-value--figure")}>
                    {pair.label === "Equipaje" && (
                      <span className="fd-condition-bags" aria-hidden="true">
                        <AppIcon
                          name="cabinBag"
                          size={16}
                          className={cn(model.baggage.carryOnIncluded === false && "fd-condition-bag--absent")}
                        />
                        <AppIcon
                          name="holdBag"
                          size={16}
                          className={cn(model.baggage.checkedIncluded === false && "fd-condition-bag--absent")}
                        />
                      </span>
                    )}
                    {pair.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {shown.warnings && shown.warnings.length > 0 && (
          <div className="fd-motion-emergente mt-3.5 grid gap-1.5">
            {shown.warnings.map((warning, index) => (
              <p
                key={`${warning}-${index}`}
                className="rounded-lg border border-warning/45 bg-warning-soft px-2.5 py-2 text-xs leading-5 text-warning-soft-foreground"
              >
                {warning}
              </p>
            ))}
          </div>
        )}

      </div>

      {/* The quote opens as the 620px panel of 1h; a phone has none (05 §6). */}
      {activeQuotation && !mobileDirect && (
        <QuotationOverlay
          state={{
            text: activeQuotation.text,
            preparedAt: activeQuotationPreparedAt,
          }}
          headline={`Cotización · ${model.carrier.name}`}
          subtitle={quotationSubtitle(shown, request)}
          carrierLogo={model.carrier.logo}
          migrationPlan={migrationPlan}
          copied={copied}
          canOpenProvider={Boolean(purchasePath)}
          onToggleMigrationPlan={setMigrationPlanChoice}
          onCopy={() => copyQuotationText(activeQuotation.key, activeQuotation.text)}
          onOpenProvider={() => void handlePurchasePath()}
          onClose={() => setVisibleQuotationKey(null)}
        />
      )}

      {mobileDirect && copied && (
        <p className="fd-detail-copy-confirm" role="status" data-closing={confirmation?.closing || undefined}>
          <AppIcon name="check" size={16} />
          Cotización copiada
        </p>
      )}

      {/* 3c: the failure takes the place of the row that produced it and stays
          until a retry, another offer or its dismiss (05 §7). */}
      {quotationFailed && (
        <div className="fd-detail-quote-error" role="alert">
          <p className="fd-detail-quote-error-message">
            <AppIcon name="alert" size={16} className="fd-detail-quote-error-icon" />
            <span className="fd-detail-quote-error-copy">
              <strong className="fd-detail-quote-error-full">{QUOTATION_ERROR_TITLE}</strong>
              <strong className="fd-detail-quote-error-short">{QUOTATION_ERROR_TITLE_SHORT}</strong>
              <br />
              <span className="fd-detail-quote-error-detail fd-detail-quote-error-full">
                {QUOTATION_ERROR_DETAIL}
              </span>
              <span className="fd-detail-quote-error-detail fd-detail-quote-error-short">
                {QUOTATION_ERROR_DETAIL_SHORT}
              </span>
            </span>
            <button
              type="button"
              className="fd-detail-quote-error-dismiss fd-focus-ring"
              aria-label="Descartar el aviso de cotización"
              onClick={() => {
                setQuotationFailureKey(null)
                setVisibleQuotationKey(null)
              }}
            >
              <AppIcon name="x" size={14} />
            </button>
          </p>
          <div className="fd-detail-quote-error-exits">
            {purchasePath && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="fd-detail-quote-error-open"
                onClick={() => void handlePurchasePath()}
              >
                <AppIcon name="externalLink" size={14} />
                Abrir proveedor
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              className="fd-detail-quote-error-retry"
              onClick={() => void handleQuotation()}
            >
              {isQuoting
                ? <AppIcon name="loading" size={14} spin />
                : <AppIcon name="rotateCcw" size={14} />}
              Reintentar
            </Button>
          </div>
        </div>
      )}

      <div className="fd-detail-footer" data-quote-error={quotationFailed || undefined}>
        {activePathFeedback && (
          <p className="fd-motion-emergente mb-2 rounded-lg border border-border bg-card px-2.5 py-2 text-xs text-muted-foreground" role="status">
            {activePathFeedback}
          </p>
        )}
        <div className="fd-detail-action-row">
          {/* The accessible name contains the visible word (WCAG 2.5.3). */}
          <label htmlFor={migrationSwitchId} className="fd-detail-migration">
            <Switch
              id={migrationSwitchId}
              className="fd-detail-migration-switch"
              checked={migrationPlan}
              aria-label="Paquete migratorio"
              onCheckedChange={setMigrationPlanChoice}
            />
            <span>Migratorio</span>
          </label>
          <div className="fd-detail-action-group">
            {purchasePath && (
              <Button
                size="sm"
                variant="secondary"
                className="fd-detail-provider-action"
                title={purchasePathTitle(purchasePath.type)}
                onClick={handlePurchasePath}
              >
                <AppIcon name="externalLink" size={14} />
                <span className="fd-detail-provider-action-label">
                  {purchasePath.type === "search-redirect" ? "Buscar" : "Abrir"}
                </span>
              </Button>
            )}
            <ShortcutTooltip
              label={quotationActionTitle}
              shortcut={canQuote ? <Kbd>C</Kbd> : null}
              disabled={!canQuote}
            >
            <Button
              size="sm"
              className="fd-detail-quote-action"
              onClick={handleQuotation}
              disabled={!canQuote}
            >
              {isQuoting
                ? <AppIcon name="loading" size={14} spin />
                : copied
                  ? <AppIcon name="check" size={14} />
                  : <AppIcon name="clipboard" size={14} />}
              {isQuoting ? "Validando" : copied ? "Copiado" : "Cotizar"}
            </Button>
            </ShortcutTooltip>
          </div>
        </div>
      </div>
    </section>
  )
}

function openProviderUrl(url: string, newTab: boolean): boolean {
  if (newTab) return openInNewTab(url)
  window.location.assign(url)
  return true
}

/**
 * A clipboard write claimed inside the gesture and fed once the fare is
 * confirmed. Where `ClipboardItem` cannot take a promise the caller writes
 * after the await instead.
 */
function beginDeferredCopy(): {
  settle: (text: string) => void
  abandon: () => void
  written: Promise<boolean> | null
} {
  let settle: (text: string) => void = () => {}
  let abandon: () => void = () => {}
  const pending = new Promise<string>((resolve, reject) => {
    settle = resolve
    abandon = () => reject(new Error("La tarifa no se confirmó"))
  })
  pending.catch(() => {})

  const clipboard = navigator.clipboard
  if (typeof clipboard?.write !== "function" || typeof ClipboardItem !== "function") {
    return { settle, abandon, written: null }
  }

  try {
    /* The derived promise carries its own rejection and needs its own guard. */
    const payload = pending.then((text) => new Blob([text], { type: "text/plain" }))
    payload.catch(() => {})
    const item = new ClipboardItem({ "text/plain": payload })
    return { settle, abandon, written: clipboard.write([item]).then(() => true, () => false) }
  } catch {
    return { settle, abandon, written: null }
  }
}

function composeQuotation(
  offer: CanonicalOffer,
  request: SearchRequest,
  key: string,
  migrationPlan: boolean,
): QuotationState {
  try {
    const normalizedRequest = normalizeQuotationRequestSnapshot(toBackendPayload(request, "cheapest").request, offer)
    const normalizedOffer = normalizedRequest && normalizeQuotationOfferSnapshot(offer, normalizedRequest)
    if (!normalizedRequest || !normalizedOffer) throw new Error("Incomplete quotation snapshot")

    return {
      key,
      /* Only this offer's own rate: an offer the backend did not price in
         soles is not given a rate borrowed from another. */
      text: buildCommercialQuotation(normalizedOffer, normalizedRequest, {
        migrationPlan,
        usdToPenRate: normalizedOffer.usdToPenRate,
      }),
    }
  } catch {
    return {
      key,
      text: "No se pudo generar la cotización con los datos de esta oferta.",
      error: true,
    }
  }
}

function readMigrationPlanChoice(): boolean | null {
  try {
    const value = sessionStorage.getItem(MIGRATION_PLAN_SESSION_KEY)
    if (value === "1") return true
    if (value === "0") return false
  } catch {
    // The request decides when session storage is unavailable.
  }

  return null
}

/** "LIM – MIA · 12 set – 19 set · 1 adulto" — the header line that gets verified. */
function quotationSubtitle(offer: CanonicalOffer, request?: SearchRequest): string {
  const route = [
    request?.origin || offer.origin,
    request?.destination || offer.destination,
  ].filter(Boolean).join(" – ")
  const dates = [offer.departureDate, offer.returnDate]
    .map((value) => formatDayMonth(value ?? ""))
    .filter(Boolean)
    .join(" – ")

  return [route, dates, passengerSummary(request).replace(" · total", "")].filter(Boolean).join(" · ")
}

type RailRow = {
  time: string
  kind: "first" | "stop" | "last" | "flight" | "layover"
  text: string
  /** "+1" on a stop reached after midnight, in a leaf of its own. */
  dayOffset?: string
}

function RailRow({ row }: { row: RailRow }) {
  const isStop = row.kind === "first" || row.kind === "stop" || row.kind === "last"

  return (
    <>
      <span className="fd-rail-time">{row.time}</span>
      <span className="fd-rail-track" data-kind={row.kind}>
        {isStop && <span className="fd-rail-dot" />}
      </span>
      <span className={isStop ? "fd-rail-stop" : "fd-rail-leg"}>
        {row.text}
        {row.dayOffset ? <> <span className="fd-rail-day">{row.dayOffset}</span></> : null}
      </span>
    </>
  )
}

type DetailLeg = {
  key: string
  title: string
  summary: string
  rows: RailRow[]
}

function itineraryLegs(offer: CanonicalOffer): DetailLeg[] {
  const itineraries = offer.itineraries ?? []
  const outbound = itineraries.find((item) => item.direction === "outbound") ?? itineraries[0]
  const inbound = itineraries.find((item) => item.direction === "inbound")

  return [
    outbound ? detailLeg(outbound, "Ida") : null,
    inbound ? detailLeg(inbound, "Vuelta") : null,
  ].filter((leg): leg is DetailLeg => Boolean(leg))
}

function detailLeg(itinerary: Itinerary, label: string): DetailLeg {
  const segments = itinerary.segments ?? []
  const first = segments[0]
  const departureDate = first?.departureAt?.slice(0, 10)
  const stops = typeof itinerary.stops === "number" ? itinerary.stops : Math.max(0, segments.length - 1)
  const duration = typeof itinerary.durationMinutes === "number" && itinerary.durationMinutes > 0
    ? formatJourneyDuration(itinerary.durationMinutes)
    : ""
  const rows: RailRow[] = []

  segments.forEach((segment, index) => {
    rows.push({
      time: timeOfIso(segment.departureAt),
      kind: index === 0 ? "first" : "stop",
      text: stationLabel(segment.origin, segment.originName),
      dayOffset: dayOffsetOf(departureDate, segment.departureAt),
    })
    rows.push({
      time: "",
      kind: "flight",
      text: flightLabel(segment),
    })

    const nextSegment = segments[index + 1]
    if (!nextSegment) {
      rows.push({
        time: timeOfIso(segment.arrivalAt),
        kind: "last",
        text: stationLabel(segment.destination, segment.destinationName),
        dayOffset: dayOffsetOf(departureDate, segment.arrivalAt),
      })
      return
    }

    // A stop: when the plane lands, then how long the passenger waits.
    rows.push({
      time: timeOfIso(segment.arrivalAt),
      kind: "stop",
      text: stationLabel(segment.destination, segment.destinationName),
      dayOffset: dayOffsetOf(departureDate, segment.arrivalAt),
    })
    rows.push({
      time: "",
      kind: "layover",
      text: layoverLabel(itinerary, index, segment.destination),
    })
  })

  return {
    key: `${itinerary.direction}-${label}`,
    title: label,
    summary: [
      departureDate ? formatDayMonth(departureDate) : "",
      duration,
      stops === 0 ? "directo" : stops === 1 ? "1 escala" : `${stops} escalas`,
    ]
      .filter(Boolean)
      .join(" · "),
    rows,
  }
}

function dayOffsetOf(legDate: string | undefined, at?: string): string {
  const stopDate = isoDatePart(at)
  if (!legDate || !stopDate) return ""
  const days = diffDays(legDate, stopDate)
  return days > 0 ? `+${days}` : ""
}

function stationLabel(code?: string, name?: string): string {
  const iata = String(code ?? "").trim().toUpperCase()
  const place = stationPlaceName(iata, name)
  return iata && place ? `${iata} · ${place}` : iata || place || "Estación por confirmar"
}

/* «5h 50m · LATAM 8062»: how long this aeroplane flies, then which one it is,
   named, since the airline is spelled out everywhere else on the panel. */
function flightLabel(segment: Segment): string {
  const carrier = String(segment.marketingCarrier ?? "").trim().toUpperCase()
  const carrierName = segment.marketingCarrierName?.trim() ?? ""
  const number = String(segment.flightNumber ?? "").trim().toUpperCase().replace(/\s+/g, "")
  const bareNumber = carrier && number.startsWith(carrier) ? number.slice(carrier.length) : number
  const flight = carrierName
    ? `${carrierName} ${bareNumber}`.trim()
    : `${carrier}${bareNumber}` || carrier
  const duration = typeof segment.durationMinutes === "number" && segment.durationMinutes > 0
    ? formatJourneyDuration(segment.durationMinutes)
    : ""
  const operator = segment.operatingCarrierName?.trim() && segment.operatingCarrier !== segment.marketingCarrier
    ? `op. ${segment.operatingCarrierName.trim()}`
    : ""

  return [duration, flight, operator].filter(Boolean).join(" · ") || "Vuelo"
}

/* «Escala 2h 10m», without the airport the rows either side already name. */
function layoverLabel(itinerary: Itinerary, segmentIndex: number, destination?: string): string {
  const minutes = itinerary.layoverMinutes?.[segmentIndex]
  const station = String(destination ?? "").trim().toUpperCase()
  const wait = typeof minutes === "number" && minutes > 0 ? formatJourneyDuration(minutes) : ""

  if (wait) return `Escala ${wait}`
  return station ? `Escala en ${station}` : "Escala"
}

/*
 * Only what a provider confirms. No seat count (Click and Book Plus never
 * sends one and Agil sends 0 on live fares) and no confidence word.
 */
function conditionPairs(offer: CanonicalOffer, baggageLabel: string) {
  return [
    { label: "Equipaje", value: baggageLabel, figure: false },
    { label: "Cambios", value: permissionLabel(offer.fareMeta?.changeable), figure: false },
    { label: "Reembolso", value: permissionLabel(offer.fareMeta?.refundable), figure: false },
    {
      label: "Emisión",
      value: offer.fareMeta?.lastTicketingDate ? formatOfferDate(offer.fareMeta.lastTicketingDate) : "",
      figure: true,
    },
  ].filter((pair) => Boolean(pair.value))
}

function permissionLabel(value?: boolean): string {
  if (value === true) return "Permitido"
  if (value === false) return "No permitido"
  return ""
}

function purchasePathTitle(type: string): string {
  return type === "search-redirect"
    ? "Abre la búsqueda equivalente del proveedor; la disponibilidad puede variar."
    : "Abrir proveedor"
}

function passengerSummary(request?: SearchRequest): string {
  const count = passengerCount(request)
  const adults = request?.adults ?? 1
  if (count === 1) return "1 adulto · total"
  if (count === adults) return `${adults} adultos · total`
  return `${count} pasajeros · total`
}
