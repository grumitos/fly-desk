import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type TouchEvent,
} from "react"
import { createPortal } from "react-dom"
import { AppIcon } from "@/components/ui/app-icon"
import { isTopOverlay, popOverlay, pushOverlay } from "@/lib/overlay-stack"
import { prefersReducedMotion } from "@/lib/reduced-motion"
import { cn } from "@/lib/utils"

/**
 * 02 §7: «sale en la mitad del tiempo»; 07 §3 puts the number at 160 ms, and
 * §4 row 7 says the exit is opacity plus displacement only. The node has to
 * outlive `open` by exactly that long, which is why the sheet keeps a phase of
 * its own instead of rendering straight off the prop.
 */
const SHEET_EXIT_MS = 160

type SheetPhase = "closed" | "open" | "closing"

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",")

type SheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  meta?: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: "partial" | "full"
  placement?: "bottom" | "side" | "modal"
  className?: string
  /**
   * Where the sheet mounts. Defaults to the shell, so the `fdshell` container
   * query still reaches everything inside it — a sheet portalled to `<body>`
   * sits outside the container and silently loses every mobile rule.
   *
   * Armazón B passes the results region instead: plate 8a puts the 380px side
   * sheet and its scrim over the results, not over the whole window, because
   * the form above stays usable.
   */
  container?: HTMLElement | null
  /**
   * Whether the sheet draws its own handle and title bar. Plate 8a's side sheet
   * does not: the detail arrives with its own header — carrier, provider, price
   * and close — and a generic "Oferta" bar above it would be a second header
   * saying less than the first. The dialog keeps its accessible name either way.
   */
  chrome?: boolean
}

export function Sheet({
  open,
  onOpenChange,
  title,
  meta,
  children,
  footer,
  size = "full",
  placement = "bottom",
  className,
  container,
  chrome = true,
}: SheetProps) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const touchStartYRef = useRef<number | null>(null)
  const dragOffsetRef = useRef(0)
  const onOpenChangeRef = useRef(onOpenChange)
  const historyToken = `fd-sheet-${titleId}`
  /* absent → never dragged, so the entry animation still owns `transform`;
     `active` → the finger owns it; `settle` → the finger let go short of the
     threshold and the sheet springs back. Once a drag has happened the entry
     animation must stay off, or releasing would replay it. */
  const [drag, setDrag] = useState<"active" | "settle" | null>(null)
  const [closing, setClosing] = useState(false)
  const [previousOpen, setPreviousOpen] = useState(open)

  /* Adjusting state while rendering, which is the sanctioned way to react to a
     prop change: `open` going false starts the exit, and the timer below is the
     only thing that ends it. */
  if (previousOpen !== open) {
    setPreviousOpen(open)
    setClosing(!open)
    if (open) setDrag(null)
  }

  const phase: SheetPhase = open ? "open" : closing ? "closing" : "closed"

  useEffect(() => {
    onOpenChangeRef.current = onOpenChange
  }, [onOpenChange])

  useEffect(() => {
    if (!closing) return
    const timer = window.setTimeout(
      () => {
        setClosing(false)
        setDrag(null)
      },
      prefersReducedMotion() ? 0 : SHEET_EXIT_MS,
    )
    return () => window.clearTimeout(timer)
  }, [closing])

  const close = useCallback(() => {
    onOpenChangeRef.current(false)
  }, [])

  const requestClose = useCallback(() => {
    if (window.history.state?.fdSheet === historyToken) {
      window.history.back()
      return
    }
    close()
  }, [close, historyToken])

  useEffect(() => {
    if (!open) return

    openerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"

    const layer = pushOverlay(`sheet:${title}`)
    const token = historyToken
    window.history.pushState({ ...window.history.state, fdSheet: token }, "")
    const handlePopState = () => close()
    window.addEventListener("popstate", handlePopState)

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Only the most recent layer answers Esc (01 §8).
        if (!isTopOverlay(layer)) return
        event.preventDefault()
        requestClose()
        return
      }
      if (event.key !== "Tab") return

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
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener("keydown", handleKeyDown)

    requestAnimationFrame(() => {
      const panel = panelRef.current
      const first = panel?.querySelector<HTMLElement>("[data-sheet-autofocus]")
        ?? panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
      ;(first ?? panel)?.focus()
    })

    return () => {
      popOverlay(layer)
      document.body.style.overflow = previousOverflow
      window.removeEventListener("popstate", handlePopState)
      document.removeEventListener("keydown", handleKeyDown)
      if (window.history.state?.fdSheet === token) window.history.back()
      openerRef.current?.focus({ preventScroll: true })
    }
  }, [close, historyToken, open, requestClose, title])

  /*
   * 11 §6: the sheet follows the finger 1:1 and falls if the release is past a
   * third of its height. A fixed 80px release with nothing moving under the
   * finger read as a control that had not noticed the gesture.
   *
   * The gesture lives on the handle, not the body: the body is the one thing
   * that scrolls (02 §7), and a drag that started there would have to guess
   * which of the two the agent meant.
   */
  const handleTouchStart = (event: TouchEvent) => {
    touchStartYRef.current = event.touches[0]?.clientY ?? null
    dragOffsetRef.current = 0
    setDrag("active")
  }

  const handleTouchMove = (event: TouchEvent) => {
    const startY = touchStartYRef.current
    const currentY = event.touches[0]?.clientY
    if (startY === null || currentY === undefined) return
    // Downwards only: dragging up would open a gap above a sheet that is
    // already anchored to the bottom edge.
    const offset = Math.max(0, currentY - startY)
    dragOffsetRef.current = offset
    const panel = panelRef.current
    if (panel) panel.style.transform = `translateY(${offset}px)`
  }

  const handleTouchEnd = () => {
    const panel = panelRef.current
    const offset = dragOffsetRef.current
    touchStartYRef.current = null
    dragOffsetRef.current = 0
    if (panel) panel.style.transform = ""
    setDrag("settle")
    if (panel && offset > panel.getBoundingClientRect().height / 3) requestClose()
  }

  if (phase === "closed") return null

  const mount = container
    ?? document.querySelector<HTMLElement>("[data-fd-sheet-root]")
    ?? document.body

  return createPortal(
    <div
      className={cn(
        "fd-sheet-layer",
        `fd-sheet-layer--${placement}`,
      )}
      data-closing={phase === "closing"}
    >
      <button
        type="button"
        className="fd-sheet-scrim"
        aria-label={`Cerrar ${title.toLocaleLowerCase("es-PE")}`}
        onClick={requestClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={chrome ? titleId : undefined}
        aria-label={chrome ? undefined : title}
        tabIndex={-1}
        className={cn(
          "fd-sheet",
          `fd-sheet--${placement}`,
          `fd-sheet--${size}`,
          className,
        )}
        data-drag={drag ?? undefined}
      >
        {chrome && placement === "bottom" && (
          <div
            className="fd-sheet-handle-zone"
            aria-hidden="true"
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            <span className="fd-sheet-handle" />
          </div>
        )}
        {chrome && (
          <header className="fd-sheet-header">
            <div className="fd-sheet-heading">
              <h2 id={titleId}>{title}</h2>
              {meta && <span className="fd-sheet-meta">{meta}</span>}
            </div>
            <button
              type="button"
              className="fd-sheet-close fd-focus-ring"
              aria-label={`Cerrar ${title.toLocaleLowerCase("es-PE")}`}
              onClick={requestClose}
            >
              <AppIcon name="x" size={18} />
            </button>
          </header>
        )}
        <div className="fd-sheet-body">{children}</div>
        {footer && <footer className="fd-sheet-footer">{footer}</footer>}
      </div>
    </div>,
    mount,
  )
}
