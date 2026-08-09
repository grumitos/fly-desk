import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react"
import { buildResultCardModel } from "@/components/results/result-card-model"
import { QuotationOverlay } from "@/components/QuotationOverlay"
import { Button } from "@/components/ui/button"
import { AppIcon } from "@/components/ui/app-icon"
import { Switch } from "@/components/ui/switch"
import { Kbd } from "@/components/ui/kbd"
import { ShortcutTooltip } from "@/components/ui/tooltip"
import { requestQuotation, toBackendPayload } from "@/lib/api"
import { diffDaysIso, formatJourneyDuration, formatOfferDate, isoDatePart, stationDisplayName } from "@/lib/offer-display"
import { bestPurchasePath, normalizeSafePurchaseUrl } from "@/lib/purchase-path"
import { providerBadgeForId } from "@/components/results/result-card-model"
import { cn } from "@/lib/utils"
import type { CanonicalOffer, Itinerary, SearchRequest, Segment } from "@/types"
import { buildCommercialQuotation } from "../../../src/core/quotation"
import { normalizeQuotationOfferSnapshot, normalizeQuotationRequestSnapshot } from "../../../src/http-quotation-snapshot"

/*
 * Plate 1b (detail column of 316), 8a (the same panel as the 380 side sheet),
 * 1f (edge-to-edge sheet), 1h (the 620 quotation panel) and 3c (the error).
 *
 * One component, three containers. Nothing here asks how wide the window is:
 * the column, the side sheet and the full sheet differ only in the container
 * query that `components.css` answers (02 §2).
 *
 * The itinerary is a rail: a 1.5px line, a filled dot at every stop, and the
 * layover leg dotted with its text in primary at 80%. It replaced a list of
 * label/value pairs because an itinerary is a sequence, and a sequence drawn as
 * a table makes the agent reconstruct the order in their head.
 *
 * The quote error is the only error resolved *inside* this panel rather than in
 * the notice at the top of the page (11 §4): it is the one failure that happens
 * with the work already done, so the way out has to be where the work is. Plate
 * 3c draws it in the footer, taking the place of the row that produced it.
 */

const LEG_DATE_FORMATTER = new Intl.DateTimeFormat("es-PE", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
})
const MIGRATION_PLAN_SESSION_KEY = "fly-desk:migration-plan:v1"
/* 07 §4 row 6 / 05 §6: the copy confirmation enters in 180 ms, stays 2.4 s and
   leaves in 140 ms. The two waits live here because they are timers; the two
   animations live on `--fd-dur-confirmacion` / `--fd-dur-exit-confirmacion`. */
const CONFIRMATION_HOLD_MS = 2400
const CONFIRMATION_EXIT_MS = 140
/* Plate 3c: the two facts an agent needs, in the order they need them, and it
   is *about* the quotation — never *instead of* it (11 §4). The phone gets the
   shorter pair because the notice shares its row with the retry. Which one
   shows is a container query, so the two cannot drift apart. */
const QUOTATION_ERROR_TITLE = "No se pudo confirmar la tarifa"
const QUOTATION_ERROR_DETAIL = "El proveedor no respondió. El texto no se copió."
const QUOTATION_ERROR_TITLE_SHORT = "No se copió"
const QUOTATION_ERROR_DETAIL_SHORT = "El proveedor no confirmó la tarifa."

interface DetailPanelProps {
  offer: CanonicalOffer | null
  request?: SearchRequest
  searchJobId?: string
  /**
   * The offer the provider has just confirmed, on its way up to the list.
   *
   * Revalidation is allowed to come back with a different fare — that is what
   * it is for. What was not allowed is for the card and this header to keep the
   * old figure while the copied text carries the new one, with nothing on
   * screen saying which is which.
   */
  onOfferRevalidated?: (offer: CanonicalOffer) => void
  embedded?: boolean
  mobileDirect?: boolean
  /**
   * Present when the panel is the whole surface and owns its own way out —
   * the armazón B side sheet (8a) and the armazón C full sheet (1f), whose
   * header is this one. The control's shape is decided in CSS: a 32px cross on
   * the right on a desk, a 44px back chevron on the left on a phone.
   */
  onClose?: () => void
  /**
   * Where the panel leaves its «Cotizar» action for the shell's `C` shortcut
   * (11 §7). It is filled only while the offer on screen can actually be
   * quoted, so a keypress can never start a quotation the button would have
   * refused.
   */
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

/** The confirmation of 1f while it is on screen, and again while it leaves. */
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

    /* 05 §5: the toggle rewrites the text live. It rewrites it from the offer
       the provider confirmed and from the rate that came with it — never from a
       rate borrowed off some other offer in the list, which is how a confirmed
       «S/ 361 por adulto» used to become «USD 100 por adulto». */
    return composeQuotation(verifiedQuotation.offer, request, copyKey, migrationPlan)
  }, [copyKey, migrationPlan, quoteKey, request, verifiedQuotation])
  /* Once the provider has confirmed a fare, that is the offer this panel is
     about: price, confidence and conditions all come from it. */
  const displayOffer = verifiedQuotation && verifiedQuotation.quoteKey === quoteKey
    ? verifiedQuotation.offer
    : offer
  /*
   * 11 §4 asks the failure to stay in the panel with a retry, and 05 §7 offers
   * «copiar sin tarifa confirmada» as a second exit. This repository holds a
   * stronger rule and keeps it on both surfaces: a locally composed quotation
   * that the provider has not confirmed is never shown and never copied
   * (`docs/REDESIGN_CONTRACT.md`, covered by a test). A fare that
   * turns out not to exist reaches a customer as a price the agency has to
   * honour, so the failure never opens the 620 panel and the draft does not
   * survive it.
   */
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
      }, CONFIRMATION_EXIT_MS))
    }, CONFIRMATION_HOLD_MS))
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

    /* 05 §6: «Cotizar» copies first and confirms second. The write has to be
       issued inside the gesture that asked for it — Safari and Firefox drop the
       clipboard permission the moment the user-activation window closes, and
       the round trip that confirms the fare is longer than that window. So the
       write is claimed now and fed later, which is exactly what `ClipboardItem`
       takes a promise for. What must never happen is the confirmation of 1f
       over an empty clipboard, so it is only shown once a write reports back. */
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

  /* No dependency array on purpose: `handleQuotation` closes over state that
     changes every render, and the shell must never be holding last render's
     version of it. Publishing a fresh closure each commit is cheaper than
     memoising a handler with eight dependencies. */
  useEffect(() => {
    if (!quotationShortcutRef) return
    quotationShortcutRef.current = canQuote ? () => { void handleQuotation() } : null
    return () => {
      quotationShortcutRef.current = null
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
      <section className={cn("fd-panel flex h-full min-h-0 flex-col overflow-hidden", embedded && "fd-panel--embedded")}>
        {!embedded && <div className="fd-panel-header">
          <h2 className="fd-panel-title">Oferta</h2>
          <p className="fd-panel-subtitle">Sin selección</p>
        </div>}
        <div className="grid min-h-0 flex-1 place-items-center p-6 text-center">
          <div>
            <span className="mx-auto mb-3 grid size-12 place-items-center rounded-xl bg-secondary text-muted-foreground">
              <AppIcon name="detail" size={18} />
            </span>
            <h3 className="fd-type-card">Selecciona una oferta</h3>
            <p className="mt-1 text-[13px] leading-6 text-muted-foreground">
              El detalle mostrará el itinerario, las condiciones y la cotización lista para pegar.
            </p>
          </div>
        </div>
      </section>
    )
  }

  /* Everything the panel states about the fare comes from the offer the
     provider last confirmed, so the header cannot go on showing the figure the
     list was drawing while the copied text carries a different one. */
  const shown = displayOffer ?? offer
  const model = buildResultCardModel(shown, passengerCountForRequest(request))
  const provider = providerBadgeForId(shown.providerSource)
  const legs = itineraryLegs(shown)
  const conditions = conditionPairs(shown, model.baggage.label)

  return (
    <section
      /* 05 §8 row 1: on a desk the panel arrives with `estructura`, 8px from the
         right. The key is what makes it arrive again for the next offer — the
         column is always mounted, so without it the animation would play once
         in the life of the page and never for a selection. */
      key={offer.id}
      className={cn("fd-panel flex h-full min-h-0 flex-col overflow-hidden", embedded && "fd-panel--embedded")}
      /* 3c dims the conditions while the failure is up: the work is still
         there, it just is not the thing to read right now. */
      data-quote-error={quotationFailed || undefined}
    >
      <div className="fd-detail-header">
        {/* One close, two shapes. 8a draws a 32px cross to the right of the
            price; 1f draws a 44px back chevron at the head of the row. Which
            glyph shows is a container query, so the accessible name — and the
            gesture the sheet answers — stay the same on every surface. */}
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
        {embedded && model.carrier.logo && (
          <img src={model.carrier.logo} alt="" className="fd-detail-logo" decoding="async" />
        )}
        <div className="fd-detail-head">
          <h2 className="fd-detail-title">{model.carrier.name}</h2>
          <span className="fd-detail-price">{model.price.label}</span>
          <p className="fd-detail-provider">
            {provider.icon && (
              <img src={provider.icon} alt="" className="fd-detail-provider-icon" decoding="async" />
            )}
            <span className="truncate">{provider.label}</span>
          </p>
          <span className="fd-detail-pax">{passengerSummary(request)}</span>
        </div>
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
                    {/* 8a and 1f put the two bags in front of the words, dimmed
                        when the fare does not include them (02 §6). */}
                    {pair.label === "Equipaje" && (
                      <span className="fd-condition-bags" aria-hidden="true">
                        <AppIcon
                          name="backpack"
                          size={16}
                          className={cn(model.baggage.carryOnIncluded === false && "fd-condition-bag--absent")}
                        />
                        <AppIcon
                          name="luggage"
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

      {/* The quote leaves this 316px column and opens as a 620px panel (1h).
          On a phone there is no panel at all (05 §6). */}
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

      {/* 1f: the confirmation is a line of its own between the body and the
          anchored actions, not a row inside them. 3c puts the failure in that
          same slot on a phone — «ocupa el sitio de la confirmación» — so both
          live here, and on a desk the failure joins the footer surface from
          above instead (the footer drops its own top border for it). */}
      {mobileDirect && copied && (
        <p className="fd-detail-copy-confirm" role="status" data-closing={confirmation?.closing || undefined}>
          <AppIcon name="check" size={16} />
          Cotización copiada
        </p>
      )}

      {/* 3c: the failure takes the place of the row that produced it, and it
          does not leave on its own — a retry or another offer closes it. */}
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
            {/* 3c draws no dismiss, but 05 §7 names two ways out — «se cierra
                al reintentar o al descartar» — and without the second one a
                provider that stays down leaves the footer stuck on the
                error. It still never leaves on its own (08 §1). */}
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
          <p className="fd-motion-emergente mb-2 rounded-lg border border-border bg-card px-2.5 py-2 text-xs text-muted-foreground">
            {activePathFeedback}
          </p>
        )}
        <div className="fd-detail-action-row">
          {/* The switch is not decorative: turning it on rebuilds the text as the
              migration package, live. */}
          <label htmlFor="migration-plan" className="fd-detail-migration">
            <Switch
              id="migration-plan"
              className="fd-detail-migration-switch"
              checked={migrationPlan}
              aria-label="Paquete migratorio"
              onCheckedChange={setMigrationPlanChoice}
            />
            {/* 1b spells it «Migratorio» in the 316 column; 8a and 1f spell it in
                full where the row has the width for it. Which one shows is a
                container query, and the switch keeps the full name either way. */}
            <span className="fd-detail-migration-short">Migratorio</span>
            <span className="fd-detail-migration-full">Paquete migratorio</span>
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

/**
 * A clipboard write claimed inside the gesture and fed once the provider has
 * confirmed the fare (05 §6). Where `ClipboardItem` cannot take a promise the
 * caller falls back to writing after the await, which is what the browser
 * allowed before and still works wherever the permission survives.
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
  /* The clipboard is the only consumer; without this an abandoned quote would
     surface as an unhandled rejection on the page. */
  pending.catch(() => {})

  const clipboard = navigator.clipboard
  if (typeof clipboard?.write !== "function" || typeof ClipboardItem !== "function") {
    return { settle, abandon, written: null }
  }

  try {
    /* `ClipboardItem` needs the derived promise, and a derived promise carries
       its own rejection: guarding `pending` alone left this one unhandled, so a
       provider that failed printed an error on the page for a copy nobody had
       asked to keep. */
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
      /* Only this offer's own rate. The backend already shares one rate across
         a search (`prepareOffersForQuotation`) and attaches it to whatever it
         confirms, so an offer that reaches here without one is an offer the
         backend declined to price in soles — and inventing a rate for it is
         exactly the unconfirmed figure the repository rule forbids. */
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
    // Use the request-derived default when session storage is unavailable.
  }

  return null
}

/** "LIM – MIA · 12 – 19 set · 1 adulto" — the header line that gets verified. */
function quotationSubtitle(offer: CanonicalOffer, request?: SearchRequest): string {
  const route = [
    request?.origin || offer.origin,
    request?.destination || offer.destination,
  ].filter(Boolean).join(" – ")
  const dates = [offer.departureDate, offer.returnDate]
    .filter((value): value is string => Boolean(value))
    .map((value) => LEG_DATE_FORMATTER.format(new Date(`${value.slice(0, 10)}T00:00:00Z`)))
    .join(" – ")

  return [route, dates, passengerSummary(request).replace(" · total", "")].filter(Boolean).join(" · ")
}

type RailRow = {
  time: string
  kind: "first" | "stop" | "last" | "flight" | "layover"
  text: string
}

/*
 * Three kinds of row, three treatments. The layover tint used to reach the
 * flight rows too, which painted a plain segment's number and duration as if
 * the passenger were waiting in a terminal.
 */
function RailRow({ row }: { row: RailRow }) {
  const isStop = row.kind === "first" || row.kind === "stop" || row.kind === "last"

  return (
    <>
      <span className="fd-rail-time">{row.time}</span>
      <span className="fd-rail-track" data-kind={row.kind}>
        {isStop && <span className="fd-rail-dot" />}
      </span>
      <span
        className={cn(
          isStop ? "fd-rail-stop" : "fd-rail-leg",
          row.kind === "layover" && "fd-rail-leg--layover",
        )}
      >
        {row.text}
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
    const isFirst = index === 0
    rows.push({
      time: timeOf(segment.departureAt),
      kind: isFirst ? "first" : "stop",
      text: stationLabel(segment.origin, segment.originName, dayOffsetOf(departureDate, segment.departureAt)),
    })
    rows.push({
      time: "",
      kind: "flight",
      text: flightLabel(segment),
    })

    const nextSegment = segments[index + 1]
    if (!nextSegment) {
      rows.push({
        time: timeOf(segment.arrivalAt),
        kind: "last",
        text: stationLabel(segment.destination, segment.destinationName, dayOffsetOf(departureDate, segment.arrivalAt)),
      })
      return
    }

    // A stop is one dot with two things attached: when the plane lands, and how
    // long the passenger waits before the next one leaves.
    rows.push({
      time: timeOf(segment.arrivalAt),
      kind: "stop",
      text: stationLabel(segment.destination, segment.destinationName, dayOffsetOf(departureDate, segment.arrivalAt)),
    })
    rows.push({
      time: "",
      kind: "layover",
      text: layoverLabel(itinerary, index, segment.destination),
    })
  })

  return {
    key: `${itinerary.direction}-${label}`,
    title: departureDate ? `${label} · ${LEG_DATE_FORMATTER.format(new Date(`${departureDate}T00:00:00Z`))}` : label,
    summary: [duration, stops === 0 ? "directo" : stops === 1 ? "1 escala" : `${stops} escalas`]
      .filter(Boolean)
      .join(" · "),
    rows,
  }
}

/** "+1" on the stops that happen after midnight, as 1f draws them. */
function dayOffsetOf(legDate: string | undefined, at?: string): string {
  const stopDate = isoDatePart(at)
  if (!legDate || !stopDate) return ""
  const days = diffDaysIso(legDate, stopDate)
  return days > 0 ? `+${days}` : ""
}

function stationLabel(code?: string, name?: string, dayOffset = ""): string {
  const iata = String(code ?? "").trim().toUpperCase()
  const place = stationDisplayName(name)
  const station = iata && place ? `${iata} · ${place}` : iata || place || "Estación por confirmar"
  return dayOffset ? `${station} ${dayOffset}` : station
}

function flightLabel(segment: Segment): string {
  const carrier = String(segment.marketingCarrier ?? "").trim().toUpperCase()
  const number = String(segment.flightNumber ?? "").trim().toUpperCase().replace(/\s+/g, "")
  const code = number ? (carrier && !number.startsWith(carrier) ? `${carrier}${number}` : number) : ""
  const duration = typeof segment.durationMinutes === "number" && segment.durationMinutes > 0
    ? formatJourneyDuration(segment.durationMinutes)
    : ""
  const operator = segment.operatingCarrierName?.trim() && segment.operatingCarrier !== segment.marketingCarrier
    ? `op. ${segment.operatingCarrierName.trim()}`
    : ""

  return [code, duration, operator].filter(Boolean).join(" · ") || "Vuelo"
}

/** "Escala en PTY · 2h 05m", the wording plate 8a settles on. */
function layoverLabel(itinerary: Itinerary, segmentIndex: number, destination?: string): string {
  const minutes = itinerary.layoverMinutes?.[segmentIndex]
  const station = String(destination ?? "").trim().toUpperCase()
  const wait = typeof minutes === "number" && minutes > 0 ? formatJourneyDuration(minutes) : ""

  if (station && wait) return `Escala en ${station} · ${wait}`
  if (station) return `Escala en ${station}`
  return wait ? `Escala · ${wait}` : "Escala"
}

/*
 * Only what a provider actually confirms.
 *
 * «Asientos» and «Tarifa» are gone by decision. Neither Agil nor Click and Book
 * Plus reports a seat count natively — CB+ never sends one and Agil sent
 * «Asientos 0» on a live LATAM fare, which reads as a sold-out flight that is
 * on sale. And the confidence word said «En vivo» on every unquoted offer,
 * which is the provider's internal state, not a fact about the fare. A panel
 * that an agent quotes from states what was confirmed and stays quiet about the
 * rest; a row that is always there and never means anything trains them to stop
 * reading the ones that do.
 */
function conditionPairs(offer: CanonicalOffer, baggageLabel: string) {
  return [
    { label: "Equipaje", value: baggageLabel, figure: false },
    { label: "Cambios", value: permissionLabel(offer.fareMeta?.changeable), figure: false },
    { label: "Reembolso", value: permissionLabel(offer.fareMeta?.refundable), figure: false },
    // A ticketing date is a hard figure, so it goes mono (the one typography
    // rule that holds everywhere).
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

function timeOf(value?: string): string {
  const match = String(value ?? "").match(/T(\d{2}):(\d{2})/)
  return match ? `${match[1]}:${match[2]}` : ""
}

function passengerSummary(request?: SearchRequest): string {
  const count = passengerCountForRequest(request)
  const adults = request?.adults ?? 1
  if (count === 1) return "1 adulto · total"
  if (count === adults) return `${adults} adultos · total`
  return `${count} pasajeros · total`
}

function passengerCountForRequest(request: SearchRequest | undefined) {
  if (!request) return 1
  const adults = Number.isFinite(request.adults) ? request.adults : 1
  const children = Number.isFinite(request.children) ? request.children : 0
  const infants = Number.isFinite(request.infants) ? request.infants : 0
  return Math.max(1, adults + children + infants)
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
