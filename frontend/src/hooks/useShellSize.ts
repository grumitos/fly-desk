import { useLayoutEffect, useState, type RefObject } from "react"

export type ShellSize = "A" | "B" | "C"

/**
 * Where the detail surface lives at this width.
 *
 * `column` is armazón A's third column; `side` is the 380px sheet armazón B
 * overlays the workspace with; `bottom` is the phone's full sheet.
 */
export type DetailPlacement = "column" | "side" | "bottom"

function shellSizeForWidth(width: number): ShellSize {
  if (width >= 1100) return "A"
  if (width >= 720) return "B"
  return "C"
}

/*
 * What the three-column shell costs the list, from `.fd-results` and its stage:
 * 16px of screen padding on each side, the 248px filter column, the 316px
 * detail column, the two 10px gaps between them, and the list card's own 1px
 * border on each side — 618px before a single result is drawn. The stage is
 * capped at `--fd-app-max-width` first.
 *
 * Kept here rather than read off the DOM on purpose: the answer decides whether
 * the detail column is built, and measuring the list to decide whether to
 * shrink it is a loop that oscillates.
 */
const APP_MAX_WIDTH_PX = 1760
const SHELL_PADDING_PX = 16
const FILTER_COLUMN_PX = 248
const DETAIL_COLUMN_PX = 316
const RESULTS_COLUMN_GAP_PX = 10
const LIST_BORDER_PX = 1

/* The narrowest list the result card can wear the desk anatomy in, from the
   `@container fdlist` threshold in result-card.css: below it the card is the
   stacked phone row, whatever the shell around it is doing. */
const CARD_DESK_MIN_LIST_PX = 819

function listWidthWithDetailColumn(shellWidth: number): number {
  return Math.min(shellWidth, APP_MAX_WIDTH_PX)
    - SHELL_PADDING_PX * 2
    - FILTER_COLUMN_PX
    - DETAIL_COLUMN_PX
    - RESULTS_COLUMN_GAP_PX * 2
    - LIST_BORDER_PX * 2
}

/**
 * The detail column is not free, and the list is what pays for it.
 *
 * 02 §1 hands the detail a third column «from 1100» and a side sheet below,
 * which reads as a statement about the shell. It is not: 1100 is the width the
 * *form* needs for its six mínimos in one row, and the results region inherited
 * it. Measured, the detail column costs the list 326px, so from 1100 to 1436
 * the list was 482–818 — under the card's own 819 — and every result on a
 * 1366 laptop wore the phone anatomy inside a three-column desk. Worse, the
 * list was *wider* one pixel below 1100 (807) than one pixel above it (482):
 * widening the window collapsed the cards.
 *
 * So the two mechanical changes armazón B makes to A are separated, each on the
 * threshold that constrains it. The form still reflows at 1100. The detail
 * leaves the grid as soon as keeping it would take the list below the width the
 * card needs to stay a desk card — the same sheet, the same scrim, 336px
 * earlier. The filter column never yields; that is what still separates this
 * from mobile.
 */
function detailPlacementForWidth(width: number, shellSize: ShellSize): DetailPlacement {
  if (shellSize === "C") return "bottom"
  if (shellSize === "B") return "side"
  return listWidthWithDetailColumn(width) >= CARD_DESK_MIN_LIST_PX ? "column" : "side"
}

export function useShellSize(shellRef: RefObject<HTMLElement | null>): {
  shellSize: ShellSize
  detailPlacement: DetailPlacement
} {
  const [layout, setLayout] = useState<{ shellSize: ShellSize; detailPlacement: DetailPlacement }>({
    shellSize: "A",
    detailPlacement: "column",
  })

  useLayoutEffect(() => {
    const shell = shellRef.current
    if (!shell) return

    const update = (width: number) => {
      setLayout((current) => {
        const shellSize = shellSizeForWidth(width)
        const detailPlacement = detailPlacementForWidth(width, shellSize)
        return current.shellSize === shellSize && current.detailPlacement === detailPlacement
          ? current
          : { shellSize, detailPlacement }
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
