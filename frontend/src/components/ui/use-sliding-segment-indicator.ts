import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react"

export type SlidingIndicatorStyle = CSSProperties & {
  "--fd-segment-x": string
  "--fd-segment-width": string
  "--fd-segment-opacity": number
}

const hiddenIndicatorStyle: SlidingIndicatorStyle = {
  "--fd-segment-x": "0px",
  "--fd-segment-width": "0px",
  "--fd-segment-opacity": 0,
}

const segmentItemSelector = "button:not(:disabled), [role='tab']:not([disabled]), [data-slot='toggle-group-item']:not([disabled])"
const activeSegmentSelector = [
  "button[aria-pressed='true']:not(:disabled)",
  "[data-state='active']:not([disabled])",
  "[data-state='on']:not([disabled])",
].join(",")

export function useSlidingSegmentIndicator<T extends HTMLElement>({
  trackActive = true,
}: {
  trackActive?: boolean
} = {}) {
  const containerRef = useRef<T | null>(null)
  const [indicatorStyle, setIndicatorStyle] = useState<SlidingIndicatorStyle>(hiddenIndicatorStyle)

  const moveToElement = useCallback((element: Element | null) => {
    const container = containerRef.current
    if (!container || !(element instanceof HTMLElement) || !container.contains(element)) {
      setIndicatorStyle(hiddenIndicatorStyle)
      return
    }

    const containerRect = container.getBoundingClientRect()
    const itemRect = element.getBoundingClientRect()
    const overlapPx = 1
    const left = Math.max(0, itemRect.left - containerRect.left - overlapPx)
    const right = Math.min(containerRect.width, itemRect.right - containerRect.left + overlapPx)

    setIndicatorStyle({
      "--fd-segment-x": `${left}px`,
      "--fd-segment-width": `${Math.max(0, right - left)}px`,
      "--fd-segment-opacity": 1,
    })
  }, [])

  const moveToActive = useCallback(() => {
    const activeElement = trackActive
      ? containerRef.current?.querySelector(activeSegmentSelector) ?? null
      : null
    moveToElement(activeElement)
  }, [moveToElement, trackActive])

  useLayoutEffect(() => {
    moveToActive()
  }, [moveToActive])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let frame = 0
    const scheduleActiveUpdate = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(moveToActive)
    }
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(scheduleActiveUpdate)
    resizeObserver?.observe(container)
    container.querySelectorAll(segmentItemSelector).forEach((item) => resizeObserver?.observe(item))

    const mutationObserver = new MutationObserver(scheduleActiveUpdate)
    mutationObserver.observe(container, {
      attributeFilter: ["aria-pressed", "data-state", "disabled"],
      attributes: true,
      subtree: true,
    })

    scheduleActiveUpdate()

    return () => {
      window.cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
      mutationObserver.disconnect()
    }
  }, [moveToActive, moveToElement])

  return { containerRef, indicatorStyle }
}
