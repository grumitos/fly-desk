import type { CSSProperties, ReactNode } from "react"

/*
 * Plates 2g and 4a — the result card with the data switched off. It carries
 * `.fd-card` and the card's element classes so the lanes come from the same
 * stylesheet and nothing jumps when the data lands (04 §7). This file owns
 * only the widths that vary from row to row.
 */

/* The pulse is offset 120ms per row and wraps before a full 1.4s cycle. */
const PULSE_WRAP = 8

type SkeletonRowShape = {
  carrier: [string, string]
  stops: [string, string]
  /* In px: the price lane is `auto` in the stacked layout, where a percentage resolves to nothing. */
  price: string
  priceMeta: string | null
}

const SKELETON_ROW_RHYTHM: SkeletonRowShape[] = [
  { carrier: ["74%", "46%"], stops: ["62%", "48%"], price: "88px", priceMeta: "44px" },
  { carrier: ["58%", "40%"], stops: ["34%", "54%"], price: "74px", priceMeta: null },
  { carrier: ["80%", "52%"], stops: ["70%", "40%"], price: "92px", priceMeta: "38px" },
]

export function ResultsSkeleton({
  rows,
  mode,
  head,
  inline = false,
  startDelayIndex = 0,
  attachViewport,
}: {
  /** What the column fits, measured by the hook that also opens the list. */
  rows: number
  /** Stamped like the real list: the stacked leg's label lane depends on it. */
  mode?: string
  head?: ReactNode
  /** Rendered inside an existing list (partial search) rather than alone. */
  inline?: boolean
  startDelayIndex?: number
  attachViewport?: (node: HTMLDivElement | null) => void
}) {
  const rowCount = Math.max(1, Math.round(rows))
  const skeletonRows = Array.from({ length: rowCount }, (_, index) => (
    <SkeletonRow key={index} index={index + startDelayIndex} />
  ))

  if (inline) return <>{skeletonRows}</>

  return (
    <div className="fd-list-body" data-testid="results-loading-skeleton">
      {head}
      <div ref={attachViewport} className="fd-list-viewport" aria-hidden="true">
        <div className="fd-results-list fd-results-list--skeleton" data-mode={mode}>{skeletonRows}</div>
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

      <span className="fd-card__provider fd-skeleton-block" />
    </article>
  )
}
