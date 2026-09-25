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
import { useOverlayHistory } from "@/hooks/useOverlayHistory"
import { isTopOverlay, popOverlay, pushOverlay } from "@/lib/overlay-stack"
import { motionToken } from "@/lib/reduced-motion"
import { cn } from "@/lib/utils"

/* The sheet outlives `open` by its exit, read from the motion tokens so reduced
   motion (which zeroes them) drops it at once. */
function sheetExitDuration(): number {
  return motionToken("--fd-dur-exit-hoja")
}

/* A vertical drag from the grabber closes a bottom sheet; a horizontal one
   closes a `backSwipe` sheet toward its edge. The axis locks in the first
   pixels and the rest stays native scroll (`touch-action: pan-y`). */

/** Pixels of movement before the gesture is given to one axis or the other. */
const AXIS_LOCK_PX = 8
/** The share of the sheet's own measure a drag has to cover to dismiss it. */
const DISMISS_FRACTION = 1 / 3
/** px/ms: a short, fast throw dismisses too… */
const DISMISS_VELOCITY = 0.5
/** …if it travelled this far, so an unsteady tap does not count. */
const DISMISS_VELOCITY_MIN_PX = 24
/** One frame: below it a velocity is noise. */
const VELOCITY_SAMPLE_MS = 16

type SheetPhase = "closed" | "open" | "closing"
type DragAxis = "x" | "y"
type DragState = "active" | "settle" | null

type Gesture = {
  startX: number
  startY: number
  /* `null` until it is decided; `"scroll"` once the gesture has been handed
     back and there is nothing left to watch until the next finger. */
  axis: DragAxis | "scroll" | null
  fromGrabber: boolean
  offset: number
  lastX: number
  lastAt: number
  velocity: number
}

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
   * Where the sheet mounts. Defaults to the shell, whose phone rules have to
   * reach it; the side sheet passes the results region, so the form above it
   * stays usable.
   */
  container?: HTMLElement | null
  /** Whether the sheet draws its own title bar (the detail brings its own). */
  chrome?: boolean
  /** Whether a sideways swipe towards the edge it came from dismisses it. */
  backSwipe?: boolean
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
  backSwipe = false,
}: SheetProps) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const onOpenChangeRef = useRef(onOpenChange)
  /* `active`: the finger owns `transform`; `settle`: released short of the
     threshold, springing back. Once dragged, the entrance stays off so it
     cannot replay. */
  const [drag, setDrag] = useState<DragState>(null)
  /* Set only by a swipe dismissal; placements otherwise leave by their own
     edge. */
  const [dismissAxis, setDismissAxis] = useState<"swipe" | null>(null)
  const [closing, setClosing] = useState(false)
  const [previousOpen, setPreviousOpen] = useState(open)

  /* `open` going false starts the exit; the timer below ends it. */
  if (previousOpen !== open) {
    setPreviousOpen(open)
    setClosing(!open)
    if (open) {
      setDrag(null)
      setDismissAxis(null)
    }
  }

  const phase: SheetPhase = open ? "open" : closing ? "closing" : "closed"

  useEffect(() => {
    onOpenChangeRef.current = onOpenChange
  }, [onOpenChange])

  useEffect(() => {
    if (!closing) return
    const timer = window.setTimeout(() => {
      setClosing(false)
      setDrag(null)
      setDismissAxis(null)
    }, sheetExitDuration())
    return () => window.clearTimeout(timer)
  }, [closing])

  const close = useCallback(() => {
    onOpenChangeRef.current(false)
  }, [])

  /* The system back, the cross and the scrim all close through the history
     entry, so they behave the same. */
  const { requestClose } = useOverlayHistory(open, close, "fd-sheet")

  useEffect(() => {
    if (!open) return

    openerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"

    const layer = pushOverlay(`sheet:${title}`)

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Only the top layer answers Esc.
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
      document.removeEventListener("keydown", handleKeyDown)
      openerRef.current?.focus({ preventScroll: true })
    }
  }, [open, requestClose, title])

  /* One recogniser for the whole sheet; the grabber only marks where the
     touch started. */
  const handleTouchStart = (event: TouchEvent<HTMLElement>) => {
    const touch = event.touches[0]
    const panel = panelRef.current
    if (!touch || !panel) return

    const fromGrabber = event.target instanceof Element
      && Boolean(event.target.closest("[data-sheet-grabber]"))

    panel.style.removeProperty("--fd-sheet-drag-x")
    gestureRef.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      axis: null,
      fromGrabber,
      offset: 0,
      lastX: touch.clientX,
      lastAt: performance.now(),
      velocity: 0,
    }

    /* From the body a touch waits to see its axis, so scrolling is untouched. */
    if (fromGrabber) setDrag("active")
  }

  const handleTouchMove = (event: TouchEvent<HTMLElement>) => {
    const gesture = gestureRef.current
    const touch = event.touches[0]
    const panel = panelRef.current
    if (!gesture || !touch || !panel || gesture.axis === "scroll") return

    const deltaX = touch.clientX - gesture.startX
    const deltaY = touch.clientY - gesture.startY

    if (gesture.axis === null) {
      if (Math.abs(deltaX) < AXIS_LOCK_PX && Math.abs(deltaY) < AXIS_LOCK_PX) return
      const horizontal = Math.abs(deltaX) > Math.abs(deltaY)
      /* Horizontal only where asked for, vertical only from the grabber;
         anything else is the scroller's. */
      if (horizontal && backSwipe) {
        gesture.axis = "x"
        /* Written directly too: the entrance must be off in the frame the
           first transform lands, before React commits. */
        panel.dataset.drag = "active"
        setDrag("active")
      } else if (!horizontal && gesture.fromGrabber) {
        gesture.axis = "y"
      } else {
        gesture.axis = "scroll"
        if (gesture.fromGrabber) setDrag(null)
        return
      }
    }

    if (gesture.axis === "x") {
      /* `performance.now()`, not React's event timestamp: one clock. */
      const now = performance.now()
      if (now - gesture.lastAt >= VELOCITY_SAMPLE_MS) {
        gesture.velocity = (touch.clientX - gesture.lastX) / (now - gesture.lastAt)
        gesture.lastX = touch.clientX
        gesture.lastAt = now
      }

      /* Only towards the edge it came from. */
      gesture.offset = Math.max(0, deltaX)
      panel.style.transform = `translateX(${gesture.offset}px)`
      return
    }

    // Downwards only.
    gesture.offset = Math.max(0, deltaY)
    panel.style.transform = `translateY(${gesture.offset}px)`
  }

  const handleTouchEnd = () => {
    const gesture = gestureRef.current
    const panel = panelRef.current
    gestureRef.current = null
    if (!gesture || !panel) return
    if (gesture.axis === null || gesture.axis === "scroll") {
      if (gesture.fromGrabber) setDrag(null)
      return
    }

    const box = panel.getBoundingClientRect()
    const horizontal = gesture.axis === "x"
    const travelled = gesture.offset
    const reach = (horizontal ? box.width : box.height) * DISMISS_FRACTION
    /* Distance or, sideways, velocity: a quick throw dismisses too. */
    const thrown = horizontal
      && gesture.velocity >= DISMISS_VELOCITY
      && travelled >= DISMISS_VELOCITY_MIN_PX
    const dismiss = travelled > reach || thrown

    panel.style.transform = ""
    if (!dismiss) {
      setDrag("settle")
      return
    }

    if (horizontal) {
      /* The exit starts where the finger left it (`fd-exit-swipe`). */
      panel.style.setProperty("--fd-sheet-drag-x", `${travelled}px`)
      setDismissAxis("swipe")
    }
    setDrag(null)
    requestClose()
  }

  if (phase === "closed") return null

  const mount = container
    ?? document.querySelector<HTMLElement>("[data-fd-sheet-root]")
    ?? document.body

  /* Every bottom sheet has a grabber, chrome or not. */
  const grabber = placement === "bottom"

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
        data-dismiss={dismissAxis ?? undefined}
        data-back-swipe={backSwipe || undefined}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        {grabber && (
          <div className="fd-sheet-handle-zone" data-sheet-grabber="true" aria-hidden="true">
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
