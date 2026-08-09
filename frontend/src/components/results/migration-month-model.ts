import type { CanonicalOffer, MigrationMonthSummary, SearchJobResponse } from "@/types"

/*
 * What the Migratorio sweep is, as data: one entry per month of the range,
 * whether or not that month came back with a fare, plus the two facts the
 * header states about the sweep as a whole (1i, 2f).
 *
 * It lives beside `MigrationMonthGrid` rather than inside it because the header
 * is drawn by `ResultsPanel` — one header above the grid, not a second one
 * inside it — and both have to be reading the same months.
 */

export type DisplayMonth = MigrationMonthSummary & { filtered?: boolean }

/**
 * Whether this month is still being queried.
 *
 * The first response of every month is the router's draft — `partial: true`
 * with no offers yet — so a month that has only just been asked arrives here as
 * `partial`, not `loading`. Recognising only `loading` painted it as a dead
 * month: grey, price `—`, no spinner and «sin tarifa en el mes», while the
 * header above counted it under «N buscando». The grid and its own header now
 * read the same predicate.
 */
export function isMonthSearching(month: DisplayMonth): boolean {
  return month.status === "loading" || month.status === "partial"
}

/**
 * The line a month with an error should show. The router appends the real
 * reason to the end of the array; reading `[0]` returned whatever progress
 * notice happened to be recorded first.
 */
export function monthWarningLine(month: DisplayMonth): string | undefined {
  return month.warnings?.at(-1)
}

/**
 * The months to draw. A month whose best offer the filters have hidden keeps
 * its slot and loses its fare: «un mes sin datos no se oculta» (06 §3).
 */
export function monthsForDisplay(results: SearchJobResponse, offers: CanonicalOffer[]): DisplayMonth[] {
  if (!results.migrationMonths?.length) {
    return offers.map((offer) => ({
      key: offer.id,
      label: monthLabelFromOffer(offer),
      departureStart: offer.departureDate,
      departureEnd: offer.departureDate,
      offer,
      status: "available",
    }))
  }

  const visibleOfferIds = new Set(offers.map((offer) => offer.id))
  return results.migrationMonths.map((month) => {
    if (!month.offer || visibleOfferIds.has(month.offer.id)) return month
    return { ...month, offer: undefined, filtered: true }
  })
}

/**
 * The header line of 1i and the status row of 2f carry the same two facts about
 * the sweep: how many months came back with a fare, and the range of prices it
 * spans.
 *
 * «Rango» is the sweep's minimum and maximum *price* (06 §6), the same pair the
 * comparison bars are drawn against — not the months, which the search summary
 * above already says.
 */
export function migrationSweepSummary(results: SearchJobResponse, offers: CanonicalOffer[]) {
  const months = monthsForDisplay(results, offers)
  const priced = months.filter((month) => month.offer).length
  const searching = months.filter(isMonthSearching).length
  const pricedOffers = months
    .map((month) => month.offer)
    .filter((offer): offer is CanonicalOffer => Boolean(offer?.price?.total))
    .sort((left, right) => amountOf(left) - amountOf(right))
  const low = pricedOffers[0]?.price?.total
  const high = pricedOffers[pricedOffers.length - 1]?.price?.total

  return {
    monthCount: months.length,
    priced,
    searching,
    /* "USD 668.90 – 1,132.05" on a desk; 2f drops the currency and the cents,
       because at 390 that row also carries the counter and the state pill.
       A single priced month — the common case at the start of a sweep — has no
       range at all, and «USD 700.00 – 700.00» reads as two figures that happen
       to coincide rather than as one. */
    range: low && high
      ? low.amount === high.amount
        ? `${low.currencyCode || "USD"} ${money(low.amount, 2)}`
        : `${low.currencyCode || "USD"} ${money(low.amount, 2)} – ${money(high.amount, 2)}`
      : "—",
    rangeShort: low && high
      ? low.amount === high.amount
        ? money(low.amount, 0)
        : `${money(low.amount, 0)} – ${money(high.amount, 0)}`
      : "—",
  }
}

function amountOf(offer: CanonicalOffer): number {
  return offer.price?.total?.amount ?? Number.POSITIVE_INFINITY
}

function money(amount: number, digits: number): string {
  return amount.toLocaleString("es-PE", { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function monthLabelFromOffer(offer: CanonicalOffer): string {
  const tag = offer.tags?.find((item) => item && item !== "Migratorio")
  if (tag) return tag

  const value = offer.departureDate?.slice(0, 7)
  if (!value || !/^\d{4}-\d{2}$/.test(value)) return "Mes"

  const label = new Intl.DateTimeFormat("es-PE", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}-01T00:00:00Z`))
  return label.charAt(0).toUpperCase() + label.slice(1)
}
