import type { CSSProperties } from "react"

/*
 * Plates 2g and 4a — the skeleton system.
 *
 * A skeleton is not a grey rectangle: it is the result card itself with the
 * data switched off. It carries `.fd-card` and the card's own element classes,
 * so the grid, the paddings, the fixed leg lanes and the stacked layout all
 * come from the component — if the two disagreed on a single column, every
 * value would jump when the data landed, which is the one thing 04 §7 forbids.
 *
 * Everything deterministic — block heights, the three fixed lanes of a leg,
 * the squares — is written in result-card.css. The only thing this file owns is
 * the rhythm: the widths that change from row to row.
 */

/* The pulse is offset 120ms per row (`--fd-stagger-skeleton`) so the list reads
   as one wave rather than as twelve independent things blinking. It wraps
   before a full 1.4s cycle so no row waits a whole breath before it starts. */
const PULSE_WRAP = 8

type SkeletonRowShape = {
  /** Airline name, then operator and baggage. */
  carrier: [string, string]
  /** The elastic lane of each of the two legs. */
  stops: [string, string]
  price: string
  /** The per-person line under the price, which only a multi-passenger fare has. */
  priceMeta: string | null
}

/*
 * Plate 2g draws three rows and the list repeats them. Deterministic on
 * purpose: a skeleton that reshuffles its widths on every render reads as data
 * arriving. What varies inside the card's fixed lanes is drawn in %; what the
 * lane itself sizes to — the price — is drawn in px, because the price column
 * is `auto` in the stacked layout and a percentage there resolves to nothing.
 */
const SKELETON_ROW_RHYTHM: SkeletonRowShape[] = [
  { carrier: ["74%", "46%"], stops: ["62%", "48%"], price: "88px", priceMeta: "44px" },
  { carrier: ["58%", "40%"], stops: ["34%", "54%"], price: "74px", priceMeta: null },
  { carrier: ["80%", "52%"], stops: ["70%", "40%"], price: "92px", priceMeta: "38px" },
]

export function ResultsSkeleton({
  rows,
  inline = false,
  startDelayIndex = 0,
  attachViewport,
}: {
  /**
   * How many rows to draw. 4a asks for «never more rows than the real list»,
   * and what the real list opens on is whatever the column fits — so the count
   * arrives already measured, from the same hook that opens the list this
   * skeleton is standing in for. There is no default: a constant here is what
   * painted seven bones into a column that held eleven.

   * The two columns are the same column now that neither ends in a pager: the
   * viewport the bones are counted into is the viewport the cards land in,
   * with nothing reserved below either of them.
   */
  rows: number
  /** Rendered inside an existing list (partial search) rather than alone. */
  inline?: boolean
  /** Continues the 120ms pulse offset from the last real row. */
  startDelayIndex?: number
  /** The viewport the row count is measured against, when standing alone. */
  attachViewport?: (node: HTMLDivElement | null) => void
}) {
  const rowCount = Math.max(1, Math.round(rows))
  const skeletonRows = Array.from({ length: rowCount }, (_, index) => (
    <SkeletonRow key={index} index={index + startDelayIndex} />
  ))

  if (inline) return <>{skeletonRows}</>

  /* Alone, the skeleton is the list: the same body, viewport and list element
     the real list uses, so the rows do not slide sideways when they are
     replaced.

     The status line that used to stand above the bones is gone with the timer
     that raised it: «tarda más de lo habitual» is the ordinary shape of a
     search here, and the bones already say one is running. */
  return (
    <div className="fd-list-body" data-testid="results-loading-skeleton">
      <div ref={attachViewport} className="fd-list-viewport" aria-hidden="true">
        <div className="fd-results-list fd-results-list--skeleton">{skeletonRows}</div>
      </div>
    </div>
  )
}

function SkeletonRow({ index }: { index: number }) {
  const shape = SKELETON_ROW_RHYTHM[index % SKELETON_ROW_RHYTHM.length]
  const rowStyle = { "--fd-skeleton-row": String(index % PULSE_WRAP) } as CSSProperties

  return (
    <article className="fd-card fd-card--skeleton" style={rowStyle} aria-hidden="true">
      <span className="fd-card__logo fd-skeleton-block" />

      <div className="fd-card__carrier">
        <span className="fd-skeleton-block fd-skeleton-title" style={{ width: shape.carrier[0] }} />
        <span className="fd-skeleton-block fd-skeleton-secondary" style={{ width: shape.carrier[1] }} />
      </div>

      <div className="fd-card__legs">
        {shape.stops.map((stopsWidth, leg) => (
          <div key={leg} className="fd-card__leg">
            <span className="fd-skeleton-block fd-skeleton-secondary" />
            <span className="fd-skeleton-block fd-skeleton-title" />
            <span className="fd-skeleton-block fd-skeleton-secondary" />
            <span className="fd-skeleton-block fd-skeleton-secondary" style={{ width: stopsWidth }} />
          </div>
        ))}
      </div>

      <div className="fd-card__price">
        <span className="fd-skeleton-block fd-skeleton-price" style={{ width: shape.price }} />
        {shape.priceMeta && (
          <span className="fd-skeleton-block fd-skeleton-secondary" style={{ width: shape.priceMeta }} />
        )}
      </div>

      {/* The provider square on a desk, the chevron on a phone: the card hides
          whichever of the two does not belong to the layout in force. */}
      <span className="fd-card__provider fd-skeleton-block" />
      <span className="fd-card__chevron" />
    </article>
  )
}
