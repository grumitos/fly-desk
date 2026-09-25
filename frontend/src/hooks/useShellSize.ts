import { useLayoutEffect, useState, type RefObject } from "react"

/** A ≥ 1100 (three columns), B 720–1099 (form on two rows), C phone. */
export type ShellSize = "A" | "B" | "C"

/**
 * Where the detail lives: A's third column, the 380px side sheet over the
 * workspace, or the phone's full sheet.
 */
export type DetailPlacement = "column" | "side" | "bottom"

/*
 * A phone stays on the phone layout in landscape. Keyed on the screen rather
 * than the viewport, so an on-screen keyboard that shortens a tablet's viewport
 * never swaps the layout under the field being typed into.
 */
function isHandheld(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  if (!window.matchMedia("(pointer: coarse)").matches) return false
  return Math.min(window.screen.width, window.screen.height) <= 500
}

function shellSizeForWidth(width: number): ShellSize {
  if (width < 720 || isHandheld()) return "C"
  return width >= 1100 ? "A" : "B"
}

/* The three-column desk, from `.fd-results` and the stage around it. */
const APP_MAX_WIDTH_PX = 1760
const SHELL_PADDING_PX = 16
const FILTER_COLUMN_PX = 248
const DETAIL_COLUMN_PX = 316
const RESULTS_COLUMN_GAP_PX = 10

/*
 * The result row's geometry, from `result-card.css`: the fixed lanes of the row
 * (428) and of a leg (284), and the stops label at two stops («2 escalas · BOG,
 * PTY», 112 at the row's 11px).
 */
const RESULT_ROW_FIXED_PX = 428
const RESULT_LEG_FIXED_PX = 284
const STOPS_TWO_STOPS_PX = 112

/*
 * The detail column is only built while the list beside it keeps a desk row
 * wide enough to name two stops. Measured, not observed: reading the list's
 * width to decide whether to shrink it would oscillate.
 */
const DETAIL_COLUMN_MIN_LIST_PX = RESULT_ROW_FIXED_PX + RESULT_LEG_FIXED_PX + STOPS_TWO_STOPS_PX

function listWidthWithDetailColumn(shellWidth: number): number {
  return Math.min(shellWidth, APP_MAX_WIDTH_PX)
    - SHELL_PADDING_PX * 2
    - FILTER_COLUMN_PX
    - DETAIL_COLUMN_PX
    - RESULTS_COLUMN_GAP_PX * 2
}

function detailPlacementForWidth(width: number, shellSize: ShellSize): DetailPlacement {
  if (shellSize === "C") return "bottom"
  if (shellSize === "B") return "side"
  return listWidthWithDetailColumn(width) >= DETAIL_COLUMN_MIN_LIST_PX ? "column" : "side"
}

type ShellLayout = { shellSize: ShellSize; detailPlacement: DetailPlacement }

function layoutForWidth(width: number): ShellLayout {
  const shellSize = shellSizeForWidth(width)
  return { shellSize, detailPlacement: detailPlacementForWidth(width, shellSize) }
}

export function useShellSize(shellRef: RefObject<HTMLElement | null>): ShellLayout {
  /* The shell spans the page, so before it exists the page's width is its
     width: a phone's first render is already the phone's, and no desk is built
     only to be replaced. */
  const [layout, setLayout] = useState<ShellLayout>(() => layoutForWidth(document.documentElement.clientWidth))

  useLayoutEffect(() => {
    const shell = shellRef.current
    if (!shell) return

    const update = (width: number) => {
      setLayout((current) => {
        const next = layoutForWidth(width)
        return current.shellSize === next.shellSize && current.detailPlacement === next.detailPlacement
          ? current
          : next
      })
    }

    update(shell.getBoundingClientRect().width)
    const observer = new ResizeObserver(([entry]) => {
      if (entry) update(entry.contentRect.width)
    })
    observer.observe(shell)
    return () => observer.disconnect()
  }, [shellRef])

  return layout
}
