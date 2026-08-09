import { useEffect, useRef } from "react"
import { AppIcon } from "@/components/ui/app-icon"
import { buildResultCardModel } from "@/components/results/result-card-model"
import { cn } from "@/lib/utils"
import type { CanonicalOffer } from "@/types"

/*
 * Plate 3b — what the "+n" on the alternative-schedules strip opens.
 *
 * Same columns as the card, plus the one column the card has no room for: the
 * price difference against the schedule currently shown. Each row is a complete
 * provider offer, and choosing one repaints the card and the detail panel.
 */

export function AllSchedulesPanel({
  offers,
  currentOfferId,
  passengerCount,
  providerLabel,
  onChoose,
  onClose,
}: {
  offers: CanonicalOffer[]
  currentOfferId: string
  passengerCount: number
  providerLabel: string
  onChoose: (offer: CanonicalOffer) => void
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const currentPrice = offers.find((offer) => offer.id === currentOfferId)?.price?.total?.amount ?? 0

  // Esc closes, and a click anywhere else does too: this opens in place over the
  // list, so leaving it open while the agent works elsewhere would hide rows.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        onClose()
      }
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) onClose()
    }

    document.addEventListener("keydown", handleKeyDown)
    document.addEventListener("pointerdown", handlePointerDown)
    return () => {
      document.removeEventListener("keydown", handleKeyDown)
      document.removeEventListener("pointerdown", handlePointerDown)
    }
  }, [onClose])

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={`Todos los horarios de ${providerLabel}`}
      className="fd-motion-emergente absolute inset-x-0 top-full z-30 mt-1.5 max-h-[19rem] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-[var(--fd-shadow-emergente)]"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border bg-secondary/60 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <h3 className="fd-type-base font-bold">Todos los horarios</h3>
          <span className="fd-panel-count">{offers.length}</span>
        </div>
        <button
          type="button"
          className="fd-alert-line-dismiss fd-focus-ring"
          aria-label="Cerrar la lista de horarios"
          onClick={onClose}
        >
          <AppIcon name="x" size={14} />
        </button>
      </div>

      <div className="fd-scrollbar-hidden max-h-[15.5rem] overflow-y-auto p-1.5">
        {offers.map((offer) => {
          const model = buildResultCardModel(offer, passengerCount)
          const delta = (offer.price?.total?.amount ?? 0) - currentPrice
          const isCurrent = offer.id === currentOfferId

          return (
            <button
              key={offer.id}
              type="button"
              className={cn(
                "fd-schedule-row fd-focus-ring",
                isCurrent && "is-current",
              )}
              aria-current={isCurrent || undefined}
              onClick={() => onChoose(offer)}
            >
              <span className="grid gap-1">
                {model.legs.map((leg) => (
                  <span key={leg.label} className="fd-schedule-row__leg">
                    <span className="fd-card__leg-label">{leg.label}</span>
                    <span className="fd-card__leg-schedule">
                      <span className="fd-card__leg-time">{leg.departureTime}</span>
                      <span className="fd-card__leg-arrow"><AppIcon name="oneWay" size={12} /></span>
                      <span className="fd-card__leg-time">{leg.arrivalTime}</span>
                      <span className="fd-card__leg-offset">{leg.dayOffset}</span>
                    </span>
                    <span className="fd-card__leg-duration">{leg.duration}</span>
                    <span className="fd-card__leg-stops">{leg.stopsLabel}</span>
                  </span>
                ))}
              </span>

              <span className="fd-schedule-row__delta">
                {isCurrent
                  ? <span className="fd-status-pill">Actual</span>
                  : <PriceDelta delta={delta} />}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** The difference, not the price: the card already shows the price. */
function PriceDelta({ delta }: { delta: number }) {
  if (Math.abs(delta) < 0.01) {
    return <span className="fd-schedule-row__delta-same">mismo precio</span>
  }

  const amount = Math.abs(delta).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return (
    <span className={cn("fd-schedule-row__delta-value", delta > 0 ? "is-up" : "is-down")}>
      {delta > 0 ? "+" : "−"}{amount}
    </span>
  )
}
