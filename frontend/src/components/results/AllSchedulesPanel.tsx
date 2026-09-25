import { useEffect, useRef } from "react"
import { AppIcon } from "@/components/ui/app-icon"
import { resultLegModels } from "@/components/results/result-card-model"
import { useOverlayHistory } from "@/hooks/useOverlayHistory"
import { cn } from "@/lib/utils"
import type { CanonicalOffer } from "@/types"

/*
 * Plate 3b — what the "+n" of the schedules strip opens: every offer of the
 * group, tiled in the card's lanes. There is no price column: a group only
 * holds offers at one price. The row on the card is marked by `aria-current`.
 */
export function AllSchedulesPanel({
  offers,
  currentOfferId,
  providerLabel,
  onChoose,
  onClose,
}: {
  offers: CanonicalOffer[]
  currentOfferId: string
  providerLabel: string
  onChoose: (offerId: string) => void
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const { requestClose } = useOverlayHistory(true, onClose, "fd-schedules")

  /* It opens in place over the list, so `Esc` and any click outside close it. */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        event.preventDefault()
        requestClose()
      }
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) requestClose()
    }

    document.addEventListener("keydown", handleKeyDown)
    document.addEventListener("pointerdown", handlePointerDown)
    return () => {
      document.removeEventListener("keydown", handleKeyDown)
      document.removeEventListener("pointerdown", handlePointerDown)
    }
  }, [requestClose])

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={`Todos los horarios de ${providerLabel}`}
      className="fd-motion-emergente absolute inset-x-0 top-full z-30 mt-1.5 max-h-[19rem] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-[var(--fd-shadow-emergente)]"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border bg-surface-sunken px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <h3 className="fd-type-base">Todos los horarios</h3>
          <span className="fd-panel-count">{offers.length}</span>
        </div>
        <button
          type="button"
          className="fd-alert-line-dismiss fd-focus-ring"
          aria-label="Cerrar la lista de horarios"
          onClick={requestClose}
        >
          <AppIcon name="x" size={14} />
        </button>
      </div>

      <div className="fd-scrollbar-hidden fd-schedule-grid max-h-[15.5rem] overflow-y-auto p-1.5">
        {offers.map((offer) => {
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
              onClick={() => onChoose(offer.id)}
            >
              <span className="grid gap-1">
                {resultLegModels(offer).map((leg) => (
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
