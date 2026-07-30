import { cn } from "@/lib/utils"

/*
 * Plate 4a — the skeleton system.
 *
 * A skeleton is not a grey rectangle: it is the same component with the same
 * grid and blocks at the exact height of the line they are standing in for, so
 * that when the data arrives nothing moves. Widths vary as percentages;
 * heights and columns never vary.
 *
 * Block heights follow the line they replace: 12–14 for a price, 10 for a title
 * or a time, 8 for anything secondary.
 */

const MAX_SKELETON_ROWS = 12

/* Deterministic widths, so the skeleton does not shimmer differently on every
   render — a skeleton that reshuffles reads as data arriving. */
const CARRIER_WIDTHS = ["72%", "58%", "66%", "54%", "70%", "62%"]
const STOPS_WIDTHS = ["48%", "62%", "40%", "56%", "44%", "58%"]
const PRICE_WIDTHS = ["78%", "64%", "72%", "58%", "82%", "68%"]

export function ResultsSkeleton({
  rows = 7,
  inline = false,
  startDelayIndex = 0,
}: {
  rows?: number
  /** Rendered inside an existing list (partial search) rather than alone. */
  inline?: boolean
  /** Continues the 120ms pulse offset from the last real row. */
  startDelayIndex?: number
}) {
  const rowCount = Math.max(1, Math.min(rows, MAX_SKELETON_ROWS))
  const skeletonRows = Array.from({ length: rowCount }, (_, index) => (
    <SkeletonRow key={index} index={index + startDelayIndex} />
  ))

  if (inline) return <>{skeletonRows}</>

  return (
    <div className="min-h-0 flex-1 overflow-hidden p-3 pt-[7px]" aria-hidden="true" data-testid="results-loading-skeleton">
      <div className="fd-results-list grid content-start gap-1.5 pt-1">{skeletonRows}</div>
    </div>
  )
}

function SkeletonRow({ index }: { index: number }) {
  // The pulse is offset 120ms per row so the list reads as one wave rather than
  // as twelve independent things blinking.
  const delay = { animationDelay: `${(index % 8) * 120}ms` }
  const carrierWidth = CARRIER_WIDTHS[index % CARRIER_WIDTHS.length]
  const stopsWidth = STOPS_WIDTHS[index % STOPS_WIDTHS.length]
  const priceWidth = PRICE_WIDTHS[index % PRICE_WIDTHS.length]

  return (
    <article className="fd-card fd-card--skeleton">
      <span className="fd-skeleton-block size-8 !rounded-md" style={delay} />

      <div className="fd-card__carrier">
        <span className="fd-skeleton-block fd-skeleton-title" style={{ ...delay, width: carrierWidth }} />
        <span className="fd-skeleton-block fd-skeleton-secondary" style={{ ...delay, width: "44%" }} />
      </div>

      <div className="fd-card__legs">
        {[0, 1].map((leg) => (
          <div key={leg} className="fd-card__leg">
            <span className="fd-skeleton-block fd-skeleton-secondary" style={{ ...delay, width: "38px" }} />
            <span className="fd-skeleton-block fd-skeleton-title" style={{ ...delay, width: "104px" }} />
            <span className="fd-skeleton-block fd-skeleton-secondary" style={{ ...delay, width: "40px" }} />
            <span className="fd-skeleton-block fd-skeleton-secondary" style={{ ...delay, width: stopsWidth }} />
          </div>
        ))}
      </div>

      <div className="fd-card__price">
        <span className="fd-skeleton-block fd-skeleton-price" style={{ ...delay, width: priceWidth }} />
        <span className="fd-skeleton-block fd-skeleton-secondary" style={{ ...delay, width: "52%" }} />
      </div>

      <span className={cn("fd-skeleton-block size-[26px] !rounded-md justify-self-end")} style={delay} />
    </article>
  )
}
