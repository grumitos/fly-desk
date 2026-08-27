import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import "./results-scrollbar.css"

/*
 * The results list's scrollbar, drawn.
 *
 * The native scroller is still what scrolls: `.fd-list-viewport` keeps its
 * `overflow-y: auto`, its `overscroll-behavior`, its wheel, its space bar and
 * its arrows. What is replaced is the *drawing* — the browser's own bar has
 * been off since that element took `scrollbar-width: none`, so until now the
 * column said nowhere how much was left to read.
 *
 * Why the viewport is measured instead of the list being counted
 * -------------------------------------------------------------
 * The tempting version is `visible rows / total rows`, and in this list it
 * lies in both directions:
 *
 * - a group card weighs 1.77 plain cards (`RESULT_GROUP_CARD_WEIGHT`) and
 *   stands at 92px against 52, so ten rows can be two screens or five
 *   depending on how many of them are groups;
 * - the window grows itself by batches as it is scrolled, and a partial
 *   search's skeleton takes real height while being no offer at all.
 *
 * `scrollHeight` / `clientHeight` / `scrollTop` have none of that problem:
 * they are the height there is, the height on screen and where the reader is,
 * with groups, with bones, and with whatever comes after. Hence the sources
 * are the scroll event and a `ResizeObserver`, not the list's props.
 *
 * The consequence, said out loud: the thumb measures the list that is *built*,
 * not the 2,500 offers the search has behind it, so it shrinks every time the
 * window appends a batch. That is the right answer — it measures what can be
 * scrolled, which is what a bar promises — and it is what every infinite list
 * does; the alternative would be faking a total height no card occupies yet
 * and leaving the reader at the end of the list with the thumb half way down.
 *
 * What the `ResizeObserver` watches
 * ---------------------------------
 * The viewport, which gives `clientHeight`, and its children, which give
 * `scrollHeight`: an appended batch grows the list without changing the
 * viewport's own box and without firing a resize. The children are swapped
 * underneath — `.fd-results-list` is keyed on the view and remounts on every
 * filter and every sort, and the sentinel comes and goes — so a
 * `MutationObserver` on the `childList` re-subscribes the set instead of
 * leaving the bar measuring a node that is no longer in the tree.
 *
 * Keyboard and focus
 * ------------------
 * It stays out of the tab order and goes `aria-hidden`. It is the visual
 * duplicate of a mechanism that already exists: a reader on the keyboard
 * scrolls the scroller, and a `tabindex` here would only add a stop that leads
 * nowhere between the list and whatever follows it. Dragging does not touch
 * focus either — the pointer is captured on the thumb, which is not focusable.
 */

/*
 * The thumb never goes below this, however long the list gets. At 2,500 offers
 * the true proportion is under 3px, which can be neither seen nor grabbed;
 * past here the thumb stops being proportional and becomes a handle, which is
 * what every system scrollbar does.
 */
const SCROLLBAR_MIN_THUMB_PX = 28

/*
 * A click on the track, off the thumb, jumps one screen that way — less an
 * overlap, so the row that was at the edge is still on screen and the reader
 * does not lose the thread. It is what `Page Down` does.
 */
const SCROLLBAR_PAGE_OVERLAP_PX = 40

interface ScrollbarMetrics {
  /** The track's height, which is the viewport's: the bar covers what is seen. */
  trackTop: number
  trackHeight: number
  thumbTop: number
  thumbHeight: number
  /** How much is left to scroll. Zero means there is nothing to draw. */
  maxScroll: number
}

const HIDDEN_METRICS: ScrollbarMetrics = {
  trackTop: 0,
  trackHeight: 0,
  thumbTop: 0,
  thumbHeight: 0,
  maxScroll: 0,
}

function measure(viewport: HTMLElement): ScrollbarMetrics {
  const trackHeight = viewport.clientHeight
  const maxScroll = viewport.scrollHeight - trackHeight

  /* One pixel of slack: a fractional `scrollHeight` against a rounded
     `clientHeight` leaves half a pixel over in columns that scroll nothing,
     and the bar was appearing over lists of three cards. */
  if (maxScroll <= 1 || trackHeight <= 0) {
    return HIDDEN_METRICS
  }

  const thumbHeight = Math.max(
    SCROLLBAR_MIN_THUMB_PX,
    Math.round(trackHeight * (trackHeight / viewport.scrollHeight)),
  )
  const travel = Math.max(0, trackHeight - thumbHeight)
  const progress = Math.min(1, Math.max(0, viewport.scrollTop / maxScroll))

  return {
    trackTop: viewport.offsetTop,
    trackHeight,
    thumbTop: Math.round(progress * travel),
    thumbHeight,
    maxScroll,
  }
}

function sameMetrics(left: ScrollbarMetrics, right: ScrollbarMetrics): boolean {
  return left.trackTop === right.trackTop
    && left.trackHeight === right.trackHeight
    && left.thumbTop === right.thumbTop
    && left.thumbHeight === right.thumbHeight
    && left.maxScroll === right.maxScroll
}

export function ResultsScrollbar({ viewportRef }: { viewportRef: RefObject<HTMLDivElement | null> }) {
  const [metrics, setMetrics] = useState<ScrollbarMetrics>(HIDDEN_METRICS)
  const [dragging, setDragging] = useState(false)
  /* The latest measurement, readable from a pointer handler without waiting
     for the render that paints it: a drag needs the thumb's travel in the same
     event, not on the next frame. It is written in `sync`, which only runs
     from effects and handlers, never during render. */
  const metricsRef = useRef(metrics)

  const sync = useCallback(() => {
    const viewport = viewportRef.current
    const next = viewport ? measure(viewport) : HIDDEN_METRICS
    metricsRef.current = next
    setMetrics((current) => (sameMetrics(current, next) ? current : next))
  }, [viewportRef])

  /*
   * In the layout phase, not a passive effect: the viewport is mounted and
   * laid out by the time this runs — React attaches a child's ref before a
   * parent's layout effects — so the bar comes up with the first paint instead
   * of appearing a frame late over a list that is already drawn.
   */
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    let frame = 0
    const schedule = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(sync)
    }

    sync()
    viewport.addEventListener("scroll", schedule, { passive: true })

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", schedule)
      return () => {
        window.cancelAnimationFrame(frame)
        viewport.removeEventListener("scroll", schedule)
        window.removeEventListener("resize", schedule)
      }
    }

    /* The viewport gives the visible height; its children give the total one.
       Without the children an appended batch goes unnoticed: the viewport's
       own box does not move. */
    const resizeObserver = new ResizeObserver(schedule)
    const observeContents = () => {
      resizeObserver.disconnect()
      resizeObserver.observe(viewport)
      for (const child of Array.from(viewport.children)) {
        resizeObserver.observe(child)
      }
      schedule()
    }
    observeContents()

    const mutationObserver = typeof MutationObserver === "undefined"
      ? undefined
      : new MutationObserver(observeContents)
    mutationObserver?.observe(viewport, { childList: true })

    return () => {
      window.cancelAnimationFrame(frame)
      viewport.removeEventListener("scroll", schedule)
      resizeObserver.disconnect()
      mutationObserver?.disconnect()
    }
  }, [sync, viewportRef])

  /*
   * Dragging: the thumb's travel is the track less the thumb itself, so one
   * pixel of thumb is worth `maxScroll / travel` pixels of list. With the
   * thumb at its floor that ratio stops being the proportional one and is
   * still the correct one — it is what makes letting go at the bottom of the
   * track leave the list at the bottom of the list.
   *
   * `setPointerCapture` rather than listening on `window`: the pointer stays
   * the thumb's even when the gesture wanders off the bar, which is how a
   * diagonal drag goes, and it is released only if the browser cancels.
   */
  const dragRef = useRef({ pointerY: 0, scrollTop: 0 })

  const handleThumbPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current
    if (!viewport || event.button !== 0) return

    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { pointerY: event.clientY, scrollTop: viewport.scrollTop }
    setDragging(true)
  }, [viewportRef])

  const handleThumbPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current
    if (!viewport || !event.currentTarget.hasPointerCapture(event.pointerId)) return

    const { trackHeight, thumbHeight, maxScroll } = metricsRef.current
    const travel = trackHeight - thumbHeight
    if (travel <= 0 || maxScroll <= 0) return

    const moved = event.clientY - dragRef.current.pointerY
    viewport.scrollTop = dragRef.current.scrollTop + (moved * maxScroll) / travel
  }, [viewportRef])

  const handleThumbPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setDragging(false)
  }, [])

  const handleTrackPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current
    if (!viewport || event.button !== 0) return

    /* The thumb's own event bubbles up here too, and there is no jump to make
       there: if the point falls inside the thumb this is not a click on the
       track, it is the start of a drag. */
    const { thumbTop, thumbHeight } = metricsRef.current
    const pointerWithinTrack = event.clientY - event.currentTarget.getBoundingClientRect().top
    const direction = pointerWithinTrack < thumbTop
      ? -1
      : pointerWithinTrack > thumbTop + thumbHeight ? 1 : 0
    if (direction === 0) return

    const page = Math.max(1, viewport.clientHeight - SCROLLBAR_PAGE_OVERLAP_PX)

    event.preventDefault()
    viewport.scrollTop += direction * page
  }, [viewportRef])

  /* While the drag is on, the document stops selecting text: without this the
     gesture paints half the list blue on the way past. */
  useEffect(() => {
    if (!dragging) return
    const previous = document.body.style.userSelect
    document.body.style.userSelect = "none"
    return () => {
      document.body.style.userSelect = previous
    }
  }, [dragging])

  if (metrics.maxScroll <= 0) return null

  return (
    <div
      className="fd-list-scrollbar"
      data-dragging={dragging || undefined}
      data-testid="results-scrollbar"
      aria-hidden="true"
      style={{ top: `${metrics.trackTop}px`, height: `${metrics.trackHeight}px` }}
      onPointerDown={handleTrackPointerDown}
    >
      <div
        className="fd-list-scrollbar-thumb"
        data-testid="results-scrollbar-thumb"
        style={{ transform: `translateY(${metrics.thumbTop}px)`, height: `${metrics.thumbHeight}px` }}
        onPointerDown={handleThumbPointerDown}
        onPointerMove={handleThumbPointerMove}
        onPointerUp={handleThumbPointerUp}
        onPointerCancel={handleThumbPointerUp}
      />
    </div>
  )
}
