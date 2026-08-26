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
 * detail column and the two 10px gaps between them — 616px before a single
 * result is drawn. The stage is capped at `--fd-app-max-width` first.
 *
 * `LIST_BORDER_PX` is gone rather than kept as slack, and it is worth saying
 * why, because the two pixels decide something. It was the list card's own
 * border, and the list has not been a card since #45 removed the frame; the
 * subtraction survived as a two-pixel margin nobody had derived. Kept, a 1440
 * desk measures 822 against the 824 the row below asks for and loses its third
 * column — the commonest desk there is, dropping to a side sheet because of a
 * border that is not drawn. Slack has to be measured too, or it is just a
 * number that happens to be there.
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

/*
 * The row's fixed measure — everything the list spends that is not the elastic
 * legs track. 28 + 142 + 36 + 116 + 26 of lanes, five 12px gaps, and 10px on
 * each side of the row: 428. It was 436 while the row was a card, whose 13px
 * padding and 1px border it also had to carry.
 *
 * The two tens are no longer the same kind of thing, and it does not change the
 * sum: the left one is still the row's padding, the right one is the drawn
 * scrollbar's channel, reserved on `.fd-list-body` so the header reserves it
 * with the rows. The row gave up its right padding to pay for it, so the number
 * here, the `@container fdlist` threshold and every lane's position are
 * untouched — which is the reason the channel is ten and not the fourteen the
 * bar was drawn at. See `results-scrollbar.css`.
 */
const RESULT_ROW_FIXED_PX = 428

/*
 * And the leg's, inside that track: 56 + 126 + 66 with three 12px gaps.
 */
const RESULT_LEG_FIXED_PX = 284

/*
 * The two labels the elastic lane is sized against, measured against the loaded
 * face at the 11px the desk row draws them in.
 *
 * The floor is the one-stop long form, which 02 §5 says may not lose its
 * airport code. The comfortable case is the widest label the row can be asked
 * to draw while still naming every airport in it — from three stops the label
 * gives up and writes `+n`, so it is not a width anything can be sized to.
 */
const STOPS_ONE_STOP_PX = 75
const STOPS_TWO_STOPS_PX = 112

/* The narrowest list the result row can wear the desk anatomy in, and the same
   arithmetic as the `@container fdlist` threshold in result-card.css: below it
   the row is the stacked phone card, whatever the shell around it is doing. */
const CARD_DESK_MIN_LIST_PX = RESULT_ROW_FIXED_PX + RESULT_LEG_FIXED_PX + STOPS_ONE_STOP_PX

/*
 * The difference between the two labels, which is the margin the detail column
 * has to leave the list on top of the stacking floor.
 *
 * This used to be `RESULT_CELL_RESTORED_PX = 44` — the gap between the card's
 * fixed measure with the baggage lane charged to the result cell and with it
 * charged to «who flies». That accounting is over: the lane has been paid for
 * out of «who flies» for two changes now, so there is nothing left to restore
 * and the constant had become a number with a story instead of a derivation.
 *
 * What the margin is *for* has not changed. Admitting the column takes 326px
 * off the list in a single step, so the budget is measured with the result cell
 * at the width it is meant to have rather than at the width the stacking rule
 * will merely tolerate. Measured, that is the same row with its elastic lane
 * holding the widest stops label it draws instead of the narrowest one it must:
 * 112 − 75 = 37. Derived straight from the 787 row instead, the column would
 * enter at a 1403 shell and take 326px off every list between 1403 and 1439 —
 * a narrowing, which is the defect this exists to prevent.
 */
const RESULT_CELL_COMFORTABLE_PX = STOPS_TWO_STOPS_PX - STOPS_ONE_STOP_PX

/* What the detail column has to leave behind, which is not the same question as
   whether the row survives. */
const DETAIL_COLUMN_MIN_LIST_PX = CARD_DESK_MIN_LIST_PX + RESULT_CELL_COMFORTABLE_PX

function listWidthWithDetailColumn(shellWidth: number): number {
  return Math.min(shellWidth, APP_MAX_WIDTH_PX)
    - SHELL_PADDING_PX * 2
    - FILTER_COLUMN_PX
    - DETAIL_COLUMN_PX
    - RESULTS_COLUMN_GAP_PX * 2
}

/**
 * The detail column is not free, and the list is what pays for it.
 *
 * 02 §1 hands the detail a third column «from 1100» and a side sheet below,
 * which reads as a statement about the shell. It is not: 1100 is the width the
 * *form* needs for its six mínimos in one row, and the results region inherited
 * it. Measured, the detail column costs the list 326px, so from 1100 to 1439
 * the list is 484–823 — under what the row needs — and every result on a 1366
 * laptop wore the phone anatomy inside a three-column desk. Worse, the list was
 * *wider* one pixel below 1100 (809) than one pixel above it (484): widening
 * the window collapsed the cards.
 *
 * So the two mechanical changes armazón B makes to A are separated, each on the
 * threshold that constrains it. The form still reflows at 1100. The detail
 * leaves the grid as soon as keeping it would take the list below the width the
 * row needs to stay a desk row — the same sheet, the same scrim, 340px earlier.
 * The filter column never yields; that is what still separates this from
 * mobile.
 */
function detailPlacementForWidth(width: number, shellSize: ShellSize): DetailPlacement {
  if (shellSize === "C") return "bottom"
  if (shellSize === "B") return "side"
  return listWidthWithDetailColumn(width) >= DETAIL_COLUMN_MIN_LIST_PX ? "column" : "side"
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
