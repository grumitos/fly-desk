import { formatAmount } from "@/lib/format"
import type { CanonicalOffer, MigrationMonthSummary } from "@/types"

/* The sweep as data, read by the grid and by the list header above it. */

export type DisplayMonth = MigrationMonthSummary & { filtered?: boolean }

/* The router's first answer for a month is a partial draft, so `partial` with
   no fare is still a month being queried. */
export function isMonthSearching(month: DisplayMonth): boolean {
  return month.status === "loading" || month.status === "partial"
}

/** The router appends the real reason last. */
export function monthWarningLine(month: DisplayMonth): string | undefined {
  return month.warnings?.at(-1)
}

/**
 * The two facts the header states about the sweep: months with a fare, and
 * the range of their prices (06 §6). A single priced month has no range.
 */
export function migrationSweepSummary(months: DisplayMonth[]) {
  const pricedOffers = months
    .map((month) => month.offer)
    .filter((offer): offer is CanonicalOffer => Boolean(offer?.price?.total))
    .sort((left, right) => left.price.total.amount - right.price.total.amount)
  const low = pricedOffers[0]?.price.total
  const high = pricedOffers[pricedOffers.length - 1]?.price.total

  return {
    monthCount: months.length,
    priced: months.filter((month) => month.offer).length,
    searching: months.filter(isMonthSearching).length,
    range: low && high
      ? low.amount === high.amount
        ? `${low.currencyCode || "USD"} ${formatAmount(low.amount)}`
        : `${low.currencyCode || "USD"} ${formatAmount(low.amount)} – ${formatAmount(high.amount)}`
      : "—",
    rangeShort: low && high
      ? low.amount === high.amount
        ? formatAmount(low.amount, 0)
        : `${formatAmount(low.amount, 0)} – ${formatAmount(high.amount, 0)}`
      : "—",
  }
}
