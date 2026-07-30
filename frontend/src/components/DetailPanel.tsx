import { useCallback, useMemo, useState } from "react"
import { buildResultCardModel } from "@/components/results/result-card-model"
import { QuotationOverlay } from "@/components/QuotationOverlay"
import { Button } from "@/components/ui/button"
import { AppIcon } from "@/components/ui/app-icon"
import { Switch } from "@/components/ui/switch"
import { toBackendPayload } from "@/lib/api"
import { formatJourneyDuration, formatOfferDate } from "@/lib/offer-display"
import { bestPurchasePath, normalizeSafePurchaseUrl } from "@/lib/purchase-path"
import { providerBadgeForId } from "@/components/results/result-card-model"
import { cn } from "@/lib/utils"
import type { CanonicalOffer, Itinerary, SearchRequest, Segment } from "@/types"
import { buildCommercialQuotation } from "../../../src/core/quotation"
import { normalizeQuotationOfferSnapshot, normalizeQuotationRequestSnapshot } from "../../../src/http-quotation-snapshot"

/*
 * Plate 1b (detail column), 1h (quotation panel) and 3c (error while quoting).
 *
 * The itinerary is a rail: a 1.5px line, a filled dot at every stop, and the
 * layover leg dotted with its text in primary at 80%. It replaced a list of
 * label/value pairs because an itinerary is a sequence, and a sequence drawn as
 * a table makes the agent reconstruct the order in their head.
 *
 * The quote error is the only error resolved *inside* this panel rather than in
 * the notice at the top of the page: it is the one failure that happens with the
 * work already done, so the two ways out have to be where the work is.
 */

const LEG_DATE_FORMATTER = new Intl.DateTimeFormat("es-PE", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
})

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
  const activePathFeedback = pathFeedback && pathFeedback.offerId === offer?.id ? pathFeedback.message : null
  const canQuote = Boolean(offer?.quotationPreparedAt && request && quoteKey && preparedQuotation && !preparedQuotation.error)
  const quotationActionTitle = !offer?.quotationPreparedAt
    ? "Esperando una tarifa actualizada del proveedor"
    : preparedQuotation?.error
      ? "La oferta no contiene todos los datos necesarios para cotizar"
      : "Cotizar y copiar"

  const markCopied = useCallback((key: string) => {
    setCopiedOfferKey(key)
    window.setTimeout(() => {
      setCopiedOfferKey((current) => (current === key ? null : current))
    }, 2400)
  }, [])

  const copyQuotationText = useCallback(async (key: string, text: string) => {
    if (await writeClipboardText(text)) markCopied(key)
  }, [markCopied])

  const handleQuotation = async () => {
    if (!quoteKey || !preparedQuotation) return
    setVisibleQuotationKey(quoteKey)
    if (!preparedQuotation.error) {
      await copyQuotationText(preparedQuotation.key, preparedQuotation.text)
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
        <div className="fd-panel-header">
          <h2 className="fd-panel-title">Oferta</h2>
          <p className="fd-panel-subtitle">Sin selección</p>
        </div>
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

  const model = buildResultCardModel(offer, passengerCountForRequest(request))
  const provider = providerBadgeForId(offer.providerSource)
  const legs = itineraryLegs(offer)
  const conditions = conditionPairs(offer, model.baggage.label)

  return (
    <section className="fd-panel flex h-full min-h-0 flex-col overflow-hidden">
      <div className="fd-panel-header !px-3 !py-2.5">
        <div className="fd-detail-head">
          <h2 className="truncate text-sm font-bold leading-tight">{model.carrier.name}</h2>
          <span className="fd-detail-price">{model.price.label}</span>
          <p className="flex min-w-0 items-center gap-1.5 text-xs leading-tight text-muted-foreground">
            {provider.icon && (
              <img src={provider.icon} alt="" className="size-[13px] shrink-0 object-contain" decoding="async" />
            )}
            <span className="truncate">{provider.label}</span>
          </p>
          <span className="whitespace-nowrap text-right text-xs font-semibold leading-tight text-muted-foreground">
            {passengerSummary(request)}
          </span>
        </div>
      </div>

      <div className="fd-scrollbar-hidden min-h-0 flex-1 overflow-y-auto p-3" data-testid="detail-panel-body">
        {legs.map((leg, index) => (
          <div key={leg.key} className={cn(index > 0 && "mt-3.5 border-t border-border pt-3.5")}>
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
          <div className="mt-3.5 border-t border-border pt-3.5">
            <span className="fd-type-micro mb-2 block">Condiciones y tarifa</span>
            <div className="grid gap-1.5">
              {conditions.map((pair) => (
                <div key={pair.label} className="fd-condition-row">
                  <span className="fd-condition-label">{pair.label}</span>
                  <span className={cn("fd-condition-value", pair.figure && "fd-condition-value--figure")}>
                    {pair.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {offer.warnings && offer.warnings.length > 0 && (
          <div className="fd-motion-emergente mt-3.5 grid gap-1.5">
            {offer.warnings.map((warning, index) => (
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

      {/* The quote leaves this 324px column and opens as a 620px panel (1h). */}
      {activeQuotation && (
        <QuotationOverlay
          state={{
            text: activeQuotation.text,
            error: Boolean(activeQuotation.error),
            preparedAt: offer.quotationPreparedAt,
          }}
          headline={`Cotización · ${model.carrier.name}`}
          subtitle={quotationSubtitle(offer, request)}
          carrierLogo={model.carrier.logo}
          migrationPlan={migrationPlan}
          copied={copied}
          canOpenProvider={Boolean(purchasePath)}
          onToggleMigrationPlan={setMigrationPlan}
          onCopy={() => copyQuotationText(activeQuotation.key, activeQuotation.text)}
          onOpenProvider={() => void handlePurchasePath()}
          onRetry={() => {
            setVisibleQuotationKey(null)
            void handleQuotation()
          }}
          onClose={() => setVisibleQuotationKey(null)}
        />
      )}

      <div className="fd-panel-footer !px-3 !py-2.5">
        {activePathFeedback && (
          <p className="fd-motion-emergente mb-2 rounded-lg border border-border bg-card px-2.5 py-2 text-xs text-muted-foreground">
            {activePathFeedback}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          {/* The switch is not decorative: turning it on rebuilds the text as the
              migration package, live. */}
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
              <Button size="sm" variant="secondary" title={purchasePathTitle(purchasePath.type)} onClick={handlePurchasePath}>
                <AppIcon name="externalLink" size={14} />
                {purchasePath.type === "search-redirect" ? "Buscar" : "Abrir"}
              </Button>
            )}
            <Button size="sm" title={quotationActionTitle} onClick={handleQuotation} disabled={!canQuote}>
              {copied ? <AppIcon name="check" size={14} /> : <AppIcon name="clipboard" size={14} />}
              {copied ? "Copiado" : "Cotizar"}
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
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

function RailRow({ row }: { row: RailRow }) {
  const isStop = row.kind === "first" || row.kind === "stop" || row.kind === "last"

  return (
    <>
      <span className="fd-rail-time">{row.time}</span>
      <span className="fd-rail-track" data-kind={row.kind}>
        {isStop && <span className="fd-rail-dot" />}
      </span>
      <span className={cn(isStop ? "fd-rail-text" : "fd-rail-layover", "pb-1.5")}>{row.text}</span>
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
      text: stationLabel(segment.origin, segment.originName),
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
        text: stationLabel(segment.destination, segment.destinationName),
      })
      return
    }

    // A stop is one dot with two things attached: when the plane lands, and how
    // long the passenger waits before the next one leaves.
    rows.push({
      time: timeOf(segment.arrivalAt),
      kind: "stop",
      text: stationLabel(segment.destination, segment.destinationName),
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

function stationLabel(code?: string, name?: string): string {
  const iata = String(code ?? "").trim().toUpperCase()
  const place = String(name ?? "").trim()
  if (iata && place) return `${iata} · ${place}`
  return iata || place || "Estación por confirmar"
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

function layoverLabel(itinerary: Itinerary, segmentIndex: number, destination?: string): string {
  const minutes = itinerary.layoverMinutes?.[segmentIndex]
  const station = String(destination ?? "").trim().toUpperCase()
  const wait = typeof minutes === "number" && minutes > 0 ? formatJourneyDuration(minutes) : ""

  if (wait && station) return `${wait} de escala en ${station}`
  if (wait) return `${wait} de escala`
  return station ? `Escala en ${station}` : "Escala"
}

function conditionPairs(offer: CanonicalOffer, baggageLabel: string) {
  return [
    { label: "Equipaje", value: baggageLabel, figure: false },
    { label: "Cambios", value: permissionLabel(offer.fareMeta?.changeable), figure: false },
    { label: "Reembolso", value: permissionLabel(offer.fareMeta?.refundable), figure: false },
    // A seat count and a ticketing date are hard figures, so they go mono (the
    // one typography rule that holds everywhere).
    {
      label: "Asientos",
      value: typeof offer.fareMeta?.seatsRemaining === "number" ? `${offer.fareMeta.seatsRemaining}` : "",
      figure: true,
    },
    {
      label: "Emisión",
      value: offer.fareMeta?.lastTicketingDate ? formatOfferDate(offer.fareMeta.lastTicketingDate) : "",
      figure: true,
    },
    { label: "Tarifa", value: offer.priceConfidence ? priceConfidenceLabel(offer.priceConfidence) : "", figure: false },
  ].filter((pair) => Boolean(pair.value))
}

function permissionLabel(value?: boolean): string {
  if (value === true) return "Permitido"
  if (value === false) return "No permitido"
  return ""
}

function priceConfidenceLabel(value: string): string {
  const labels: Record<string, string> = {
    indicative: "Indicativa",
    live: "En vivo",
    validated: "Validada",
    "landing-page": "De landing",
    stale: "Desactualizada",
  }
  return labels[value] ?? value
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
