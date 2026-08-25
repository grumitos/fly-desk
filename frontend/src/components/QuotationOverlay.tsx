import { useCallback, useEffect, useRef } from "react"
import { createPortal } from "react-dom"
import { AppIcon } from "@/components/ui/app-icon"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { useOverlayHistory } from "@/hooks/useOverlayHistory"
import { isTopOverlay, popOverlay, pushOverlay } from "@/lib/overlay-stack"
import { QUOTATION_FARE_STALE_MINUTES } from "../../../src/core/quotation"

/*
 * Plate 1h — "Cotización lista para pegar".
 *
 * This text used to render inside the 316px detail column, which meant reading
 * a commercial quote through a 40-character channel. It now comes out to a 620px
 * panel over the workspace, with:
 *
 *   · the route and the passengers in the header, to verify before pasting;
 *   · the "Paquete migratorio" switch next to the text it rewrites (6a shows
 *     both outputs line by line);
 *   · the age of the fare in plain sight, because a stale fare is the fastest
 *     way to quote wrong.
 *
 * There is no error state here. Plate 3c resolves a failed quotation in the
 * detail panel's footer, where the button that asked for it lives, and this
 * panel only ever opens over a fare the provider confirmed.
 *
 * On mobile there is no panel at all: "Cotizar" copies and confirms in one line,
 * because a quote is not edited on a phone.
 */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",")

export type QuotationOverlayState = {
  text: string
  /** Backend timestamp used for the visible fare age; verified quotes use priceVerifiedAt. */
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
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  const close = useCallback(() => onCloseRef.current(), [])

  /*
   * The gesture plate counts this layer among the two that pushed no history.
   * It opens over the view, and the system back — Android's button, the edge
   * gesture that drives it, the browser's own — took the agent out of the
   * application with the quotation open, in the middle of a call. Now it pushes
   * its entry and consumes it on the way out, and the cross and the scrim leave
   * down that same road: the tap does what the gesture does.
   */
  const { requestClose } = useOverlayHistory(true, close, "fd-quote")

  /*
   * 01 §8: `Esc` closes the most recent layer. In armazón B and C this panel
   * sits on top of the detail sheet, and both listened on `document` — one
   * keypress closed the quotation *and* the offer underneath it, so the agent
   * lost their place. The shared stack decides which of the two answers.
   *
   * 02 §7 asks every modal surface for the other half of the same contract, and
   * this one declared `aria-modal` without honouring it: Tab walked straight
   * out into the list behind the veil, and closing dropped the focus on
   * `<body>`. The trap and the return live here, next to the key handler, so
   * the three cannot drift apart.
   */
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
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => !element.hasAttribute("disabled") && element.offsetParent !== null)
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
      const first = panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
      ;(first ?? panel)?.focus()
    })

    return () => {
      popOverlay(layer)
      document.removeEventListener("keydown", handleKeyDown)
      openerRef.current?.focus({ preventScroll: true })
    }
  }, [requestClose])

  const fareAge = fareAgeLabel(state.preparedAt)

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
              {/* The route and the passengers, so the agent verifies the quote is
                  the one they meant before it leaves for a customer. */}
              <p className="fd-quote-subtitle">{subtitle}</p>
            </div>
          </div>

          <div className="fd-quote-header-actions">
            {/* The two modes of `core/quotation.ts` are commercial and migration
                package, and this is the control that swaps them (1h, 6a): the
                text is rewritten in place, never animated character by
                character. */}
            <label className="fd-quote-migration" title="Cambia el texto al paquete migratorio">
              <Switch
                className="fd-quote-migration-switch"
                checked={migrationPlan}
                aria-label="Paquete migratorio"
                onCheckedChange={onToggleMigrationPlan}
              />
              {/* The same word the detail footer writes; the switch keeps the
                  long form as its accessible name, which contains it. */}
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
          {/* Exactly as it will be pasted: no re-wrapping, no highlighting. The
              agent recognises the shape of this text at a glance, and any
              reformatting breaks that recognition. */}
          <pre data-testid="quotation-text" className="fd-quote-text">{state.text}</pre>
        </div>

        <div className="fd-quote-footer">
          <span className="fd-quote-age">{fareAge}</span>
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
 * How old the fare is, and the rule for when to stop trusting it. Saying
 * "hace 2 min · vuelve a cotizar si pasa de 15" puts the decision in the agent's
 * hands; a bare timestamp makes them do the arithmetic mid-call.
 */
function fareAgeLabel(preparedAt?: string): string {
  if (!preparedAt) return `Vuelve a cotizar si la tarifa pasa de ${QUOTATION_FARE_STALE_MINUTES} min`

  const prepared = Date.parse(preparedAt)
  if (Number.isNaN(prepared)) return `Vuelve a cotizar si la tarifa pasa de ${QUOTATION_FARE_STALE_MINUTES} min`

  const minutes = Math.max(0, Math.round((Date.now() - prepared) / 60_000))
  const age = minutes < 1 ? "hace menos de 1 min" : `hace ${minutes} min`

  return minutes >= QUOTATION_FARE_STALE_MINUTES
    ? `Tarifa preparada ${age} · vuelve a cotizar antes de pegar`
    : `Tarifa preparada ${age} · vuelve a cotizar si pasa de ${QUOTATION_FARE_STALE_MINUTES}`
}
