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

/*
 * 02 §7: «sale en la mitad del tiempo»; 07 §3 puts the number at 160 ms, and
 * §4 row 7 says the exit is opacity plus displacement only. The node has to
 * outlive `open` by exactly that long, which is why the sheet keeps a phase of
 * its own instead of rendering straight off the prop.
 *
 * The number is no longer written here, it is read from `--fd-dur-exit-hoja`
 * where the catalog keeps it. A copy in JS of a row of the table is a row that
 * can fall behind — and the `prefers-reduced-motion` block already zeroes that
 * row, so reading it settles both things in one lookup and without a
 * `matchMedia` of its own.
 */
function sheetExitDuration(): number {
  return motionToken("--fd-dur-exit-hoja")
}

/*
 * 11 §6 and the gesture plate — the native vocabulary, not a new handler.
 *
 * Two axes, and which of the two keeps the finger is decided in the first few
 * pixels of the movement rather than before it:
 *
 *   · vertical, and only from the grabber. The body is the one thing that
 *     scrolls (02 §7), so a drag that starts there belongs to the scroller and
 *     to nothing else;
 *   · horizontal, on the sheets that ask for it. The sheet leaves by the edge
 *     it came in through, which is iOS's interactive back: on the desk the
 *     detail arrives and leaves from the right, and on a phone its only way out
 *     is a chevron already pointing left. Every part of the vocabulary said
 *     «atrás» except the gesture.
 *
 * `touch-action: pan-y` on the sheet is the half of this that is not in this
 * file: it leaves the vertical axis to the native scroller and takes the
 * horizontal one from the browser, which is exactly the split above. Without it
 * the split would need `preventDefault`, and React registers `touchmove` as
 * passive.
 */

/** Pixels of movement before the gesture is given to one axis or the other. */
const AXIS_LOCK_PX = 8
/** The share of the sheet's own measure a drag has to cover to dismiss it. */
const DISMISS_FRACTION = 1 / 3
/** px/ms. A short but fast throw dismisses it too… */
const DISMISS_VELOCITY = 0.5
/** …as long as it travelled this far, so an unsteady tap does not count. */
const DISMISS_VELOCITY_MIN_PX = 24
/**
 * The smallest window a velocity is measured over: one frame.
 *
 * A real finger produces a `touchmove` every 8–16 ms. Below that there is no
 * velocity to measure, only noise — or synthetic events — and dividing a
 * displacement by a fraction of a millisecond gives a figure large enough to
 * turn every short drag into a throw.
 */
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
  /**
   * Whether this sheet is dismissed by swiping towards the edge it came in
   * through.
   *
   * It goes where the rest of the vocabulary already says «atrás»: the detail.
   * The other bottom sheets arrive from below, close with a cross, and their
   * gesture is the grabber; giving them a sideways exit as well would invent a
   * direction nothing about them announces.
   */
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
  /* absent → never dragged, so the entry animation still owns `transform`;
     `active` → the finger owns it; `settle` → the finger let go short of the
     threshold and the sheet springs back. Once a drag has happened the entry
     animation stays off for the life of the sheet: turning it back on at
     release would replay it from the edge of the screen. */
  const [drag, setDrag] = useState<DragState>(null)
  /* Which edge it leaves by. Only the swipe dismissal writes it; the ordinary
     exit of each placement is already said by its class. */
  const [dismissAxis, setDismissAxis] = useState<"swipe" | null>(null)
  const [closing, setClosing] = useState(false)
  const [previousOpen, setPreviousOpen] = useState(open)

  /* Adjusting state while rendering, which is the sanctioned way to react to a
     prop change: `open` going false starts the exit, and the timer below is the
     only thing that ends it. */
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

  /* The system back closes the sheet, and the cross and the scrim close it the
     same way: `requestClose` consumes the history entry instead of closing by
     hand, so the gesture and the tap do literally the same thing. */
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
      document.removeEventListener("keydown", handleKeyDown)
      openerRef.current?.focus({ preventScroll: true })
    }
  }, [open, requestClose, title])

  /*
   * The grabber marks the start as its own. What follows — following the
   * finger, deciding the axis, and what a release means — is one recogniser for
   * the whole sheet: two nested ones would have to agree on which of them won,
   * and the browser settled that question with propagation already.
   */
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

    /* Only a start on the grabber is known to be a drag already; from the body
       it has to wait and see where it goes, and until then the sheet is not
       marked at all. That is what leaves the content's scroll untouched. */
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
      /* Horizontal only where it was asked for; vertical only from the
         grabber. Everything else belongs to the scroller and is handed back
         without having been touched. */
      if (horizontal && backSwipe) {
        gesture.axis = "x"
        /* The attribute is written by hand as well because it is what turns
           the entry animation off, and that has to be off in the same frame the
           first transform is written: `both` leaves the animation outranking
           the inline style until React commits. */
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
      /* The clock is `performance.now()` and not the event's: the `timeStamp`
         React hands over is React's own, not always the native event's, and a
         velocity computed across two different clocks is not a velocity. */
      const now = performance.now()
      if (now - gesture.lastAt >= VELOCITY_SAMPLE_MS) {
        gesture.velocity = (touch.clientX - gesture.lastX) / (now - gesture.lastAt)
        gesture.lastX = touch.clientX
        gesture.lastAt = now
      }

      /* Towards the edge it came in through and not the other way: dragging it
         backwards would open a gap along a side that is flush with the screen. */
      gesture.offset = Math.max(0, deltaX)
      panel.style.transform = `translateX(${gesture.offset}px)`
      return
    }

    // Downwards only: dragging up would open a gap above a sheet that is
    // already anchored to the bottom edge.
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
    /* Distance **or** velocity: a short fast throw is as unambiguous as a long
       slow drag, and asking both of them for the distance leaves the fast
       gesture — the one a thumb in a hurry makes — with no answer. Velocity is
       only consulted on the axis that measures it. */
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
      /* The exit starts where the finger left it instead of returning to zero
         to leave again: the first frame of `fd-exit-swipe` reads this property. */
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

  /* The grabber is the gesture, not the chrome. The detail sheet mounts without
     a title bar of its own — it arrives with one — and that left the sheet that
     opens most often as the only one a thumb could not dismiss. */
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
