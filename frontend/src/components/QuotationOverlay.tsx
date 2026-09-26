import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { AppIcon } from "@/components/ui/app-icon"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { useOverlayHistory } from "@/hooks/useOverlayHistory"
import { firstFocusable, focusableWithin } from "@/lib/focusable"
import { isTopOverlay, popOverlay, pushOverlay } from "@/lib/overlay-stack"
import { QUOTATION_FARE_STALE_MINUTES } from "../../../src/core/quotation"

/*
 * Plate 1h — "Cotización lista para pegar": the text exactly as it will be
 * pasted, the route and passengers to verify it against, the migration switch
 * next to the text it rewrites, and the age of the fare. It only ever opens
 * over a fare the provider confirmed; a phone has no panel (05 §6).
 */

/* The fare age is stated in minutes, so it is recomputed at half that. */
const FARE_AGE_TICK_MS = 30_000

type QuotationOverlayState = {
  text: string
  /** Backend timestamp for the fare age; verified quotes use `priceVerifiedAt`. */
  preparedAt?: string
}

export function QuotationOverlay({
  state,
  headline,
  subtitle,
  carrierLogo,
  migrationPlan,
  copied,
  canOpenProvider,
  onToggleMigrationPlan,
  onCopy,
  onOpenProvider,
  onClose,
}: {
  state: QuotationOverlayState
  headline: string
  subtitle: string
  carrierLogo?: string
  migrationPlan: boolean
  copied: boolean
  canOpenProvider: boolean
  onToggleMigrationPlan: (next: boolean) => void
  onCopy: () => void | Promise<void>
  onOpenProvider: () => void
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const { requestClose } = useOverlayHistory(true, onClose, "fd-quote")

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), FARE_AGE_TICK_MS)
    return () => window.clearInterval(timer)
  }, [])

  /* `Esc` closes the most recent layer only (01 §8): this panel sits over the
     detail sheet on B and C. Focus is trapped while open and returned to the
     opener on the way out (02 §7). */
  useEffect(() => {
    const layer = pushOverlay("quotation")
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!isTopOverlay(layer)) return
        event.preventDefault()
        requestClose()
        return
      }
      if (event.key !== "Tab" || !isTopOverlay(layer)) return

      const panel = panelRef.current
      if (!panel) return
      const focusable = focusableWithin(panel)
      if (focusable.length === 0) {
        event.preventDefault()
        panel.focus()
        return
      }

      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener("keydown", handleKeyDown)

    requestAnimationFrame(() => {
      const panel = panelRef.current
      ;(firstFocusable(panel) ?? panel)?.focus()
    })

    return () => {
      popOverlay(layer)
      document.removeEventListener("keydown", handleKeyDown)
      openerRef.current?.focus({ preventScroll: true })
    }
  }, [requestClose])

  const fareAge = fareAgePhrases(state.preparedAt, now)

  return createPortal(
    <div
      className="fd-quote-layer"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) requestClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Cotización lista para pegar"
        tabIndex={-1}
        className="fd-quote-panel fd-motion-emergente"
      >
        <div className="fd-quote-header">
          <div className="fd-quote-identity">
            {carrierLogo && <img src={carrierLogo} alt="" className="fd-quote-logo" decoding="async" />}
            <div className="fd-quote-titles">
              <p className="fd-quote-title">{headline}</p>
              <p className="fd-quote-subtitle">{subtitle}</p>
            </div>
          </div>

          <div className="fd-quote-header-actions">
            <label className="fd-quote-migration" title="Cambia el texto al paquete migratorio">
              <Switch
                className="fd-quote-migration-switch"
                checked={migrationPlan}
                aria-label="Paquete migratorio"
                onCheckedChange={onToggleMigrationPlan}
              />
              <span>Migratorio</span>
            </label>
            <button
              type="button"
              className="fd-quote-close fd-focus-ring"
              aria-label="Cerrar la cotización"
              onClick={requestClose}
            >
              <AppIcon name="x" size={16} />
            </button>
          </div>
        </div>

        <div className="fd-quote-body fd-scrollbar-hidden">
          {/* No re-wrapping and no highlighting: the agent recognises the shape. */}
          <pre data-testid="quotation-text" className="fd-quote-text">{state.text}</pre>
        </div>

        <div className="fd-quote-footer">
          <span className="fd-quote-age">
            {fareAge.age && <><span className="fd-quote-age-phrase">{fareAge.age}</span>{" "}</>}
            <span className="fd-quote-age-phrase">{fareAge.rule}</span>
          </span>
          <div className="fd-quote-actions">
            {canOpenProvider && (
              <Button type="button" size="sm" variant="secondary" className="fd-quote-open" onClick={onOpenProvider}>
                <AppIcon name="externalLink" size={14} />
                Abrir proveedor
              </Button>
            )}
            <Button type="button" size="sm" className="fd-quote-copy" onClick={() => void onCopy()}>
              {copied ? <AppIcon name="check" size={14} /> : <AppIcon name="copy" size={14} />}
              {copied ? "Copiado" : "Copiar"}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * The age of the fare and the rule for when to stop trusting it, one sentence
 * in two phrases: the foot breaks it between them, after the «·», and never
 * inside one.
 */
function fareAgePhrases(preparedAt: string | undefined, now: number): { age?: string; rule: string } {
  const prepared = preparedAt ? Date.parse(preparedAt) : Number.NaN
  if (Number.isNaN(prepared)) return { rule: `Vuelve a cotizar si la tarifa pasa de ${QUOTATION_FARE_STALE_MINUTES} min` }

  const minutes = Math.max(0, Math.round((now - prepared) / 60_000))
  return {
    age: `Tarifa preparada ${minutes < 1 ? "hace menos de 1 min" : `hace ${minutes} min`} ·`,
    rule: minutes >= QUOTATION_FARE_STALE_MINUTES
      ? "vuelve a cotizar antes de pegar"
      : `vuelve a cotizar si pasa de ${QUOTATION_FARE_STALE_MINUTES} min`,
  }
}
