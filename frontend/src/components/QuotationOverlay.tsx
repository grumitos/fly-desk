import { useEffect } from "react"
import { createPortal } from "react-dom"
import { AppIcon } from "@/components/ui/app-icon"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

/*
 * Plate 1h — "Cotización lista para pegar", and plate 3c — the error.
 *
 * This text used to render inside the 324px detail column, which meant reading
 * a commercial quote through a 40-character channel. It now comes out to a 620px
 * panel over the workspace, with:
 *
 *   · the route and the passengers in the header, to verify before pasting;
 *   · the "Paquete migratorio" switch next to the text it rewrites (6a shows
 *     both outputs line by line);
 *   · the age of the fare in plain sight, because a stale fare is the fastest
 *     way to quote wrong.
 *
 * On mobile there is no panel at all: "Cotizar" copies and confirms in one line,
 * because a quote is not edited on a phone.
 */

/* Past this, the fare has been sitting long enough that it should be re-quoted
   rather than pasted. The plate writes the rule on screen instead of hiding it. */
const FARE_STALE_MINUTES = 15

export type QuotationOverlayState = {
  text: string
  error: boolean
  /** When the provider confirmed the fare, for the age line in the footer. */
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
  onRetry,
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
  onRetry: () => void
  onClose: () => void
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [onClose])

  const fareAge = fareAgeLabel(state.preparedAt)

  return createPortal(
    <div
      className="fixed inset-0 z-[120] grid place-items-center p-4"
      style={{ background: "color-mix(in srgb, var(--color-foreground) 35%, transparent)" }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Cotización lista para pegar"
        className="fd-motion-emergente flex h-[min(768px,calc(100vh-2rem))] w-[min(620px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-[0_26px_60px_color-mix(in_srgb,var(--color-foreground)_22%,transparent)]"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3.5 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {carrierLogo && (
              <img src={carrierLogo} alt="" className="size-[26px] shrink-0 object-contain" decoding="async" />
            )}
            <div className="min-w-0">
              <div className="truncate text-sm font-bold leading-tight">{headline}</div>
              {/* The route and the passengers, so the agent verifies the quote is
                  the one they meant before it leaves for a customer. */}
              <div className="truncate text-xs leading-tight text-muted-foreground">{subtitle}</div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <label
              className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-1.5 text-xs font-semibold text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Cambia el texto al paquete migratorio"
            >
              <Switch
                checked={migrationPlan}
                aria-label="Paquete migratorio"
                onCheckedChange={onToggleMigrationPlan}
              />
              <span>Paquete migratorio</span>
            </label>
            <button
              type="button"
              className="fd-control-quiet fd-focus-ring grid size-8 place-items-center !rounded-lg"
              aria-label="Cerrar la cotización"
              onClick={onClose}
            >
              <AppIcon name="x" />
            </button>
          </div>
        </div>

        <div className="fd-scrollbar-hidden min-h-0 flex-1 overflow-y-auto p-3.5">
          {/* Exactly as it will be pasted: no re-wrapping, no highlighting. The
              agent recognises the shape of this text at a glance, and any
              reformatting breaks that recognition. */}
          <pre
            data-testid="quotation-text"
            className={cn(
              "m-0 whitespace-pre-wrap rounded-xl border p-3.5 font-mono text-xs leading-[1.55]",
              state.error
                ? "border-destructive/50 bg-destructive-soft text-destructive-soft-foreground"
                : "border-border bg-secondary/70 text-foreground",
            )}
          >
            {state.text}
          </pre>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2.5 border-t border-border bg-secondary/60 px-3.5 py-3">
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {state.error
              ? "La tarifa no pudo confirmarse con el proveedor"
              : fareAge}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            {state.error ? (
              <>
                <Button type="button" size="sm" variant="secondary" onClick={() => void onCopy()}>
                  <AppIcon name="copy" size={14} />
                  Copiar sin tarifa confirmada
                </Button>
                <Button type="button" size="sm" onClick={onRetry}>
                  <AppIcon name="loading" size={14} />
                  Reintentar
                </Button>
              </>
            ) : (
              <>
                {canOpenProvider && (
                  <Button type="button" size="sm" variant="secondary" onClick={onOpenProvider}>
                    <AppIcon name="externalLink" size={14} />
                    Abrir proveedor
                  </Button>
                )}
                <Button type="button" size="sm" onClick={() => void onCopy()}>
                  {copied ? <AppIcon name="check" size={14} /> : <AppIcon name="copy" size={14} />}
                  {copied ? "Copiado" : "Copiar"}
                </Button>
              </>
            )}
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
  if (!preparedAt) return `Vuelve a cotizar si la tarifa pasa de ${FARE_STALE_MINUTES} min`

  const prepared = Date.parse(preparedAt)
  if (Number.isNaN(prepared)) return `Vuelve a cotizar si la tarifa pasa de ${FARE_STALE_MINUTES} min`

  const minutes = Math.max(0, Math.round((Date.now() - prepared) / 60_000))
  const age = minutes < 1 ? "hace menos de 1 min" : `hace ${minutes} min`

  return minutes >= FARE_STALE_MINUTES
    ? `Tarifa preparada ${age} · vuelve a cotizar antes de pegar`
    : `Tarifa preparada ${age} · vuelve a cotizar si pasa de ${FARE_STALE_MINUTES}`
}
