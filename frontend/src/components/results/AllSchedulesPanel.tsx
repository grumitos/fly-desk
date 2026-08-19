import { useEffect, useRef } from "react"
import { AppIcon } from "@/components/ui/app-icon"
import { buildResultCardModel } from "@/components/results/result-card-model"
import { cn } from "@/lib/utils"
import type { CanonicalOffer } from "@/types"

/*
 * Plate 3b — what the "+n" on the alternative-schedules strip opens.
 *
 * Same columns as the card. Each row is a complete provider offer, and choosing
 * one repaints the card and the detail panel.
 *
 * The rows tile instead of stacking: a schedule is 240px of fixed lanes plus a
 * stops label, and the panel is as wide as the card — one row per line left two
 * thirds of a 1142px panel empty and pushed the tenth schedule out of a 19rem
 * box that could have held them all.
 *
 * The price column the plate drew is gone. A schedule group refuses to hold two
 * offers whose currency, amount and baggage differ, so every row here carries
 * the price the card already states: the column could only ever say «mismo
 * precio». Which row is the one on the card is said by its tint and by
 * `aria-current`, not by a word in a lane of its own.
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

      <div className="fd-scrollbar-hidden fd-schedule-grid max-h-[15.5rem] overflow-y-auto p-1.5">
        {offers.map((offer) => {
          const model = buildResultCardModel(offer, passengerCount)
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
            </button>
          )
        })}
      </div>
    </div>
  )
}
