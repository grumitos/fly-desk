import { test } from "bun:test"
import assert from "node:assert/strict"
import {
  isMonthSearching,
  migrationSweepSummary,
  monthsForDisplay,
  monthWarningLine,
} from "../frontend/src/components/results/migration-month-model"
import type { CanonicalOffer, MigrationMonthSummary, SearchJobResponse } from "../frontend/src/types"

/*
 * The Migratorio sweep as data.
 *
 * One header above the grid and one card per month read this module, so the
 * count in «N buscando» and the state drawn on the card cannot come from two
 * different predicates — which is exactly the bug that made a month the router
 * had only just been asked about arrive as `partial` and be painted grey, with
 * price «—» and «sin tarifa en el mes», while the header counted it as still
 * searching.
 *
 * `test/ui/flexible.playwright.ts` drives the grid for the searching/finished
 * pair. The counting, the price range and the month a filter has emptied are
 * arithmetic and belong here.
 */

function offer(id: string, amount?: number): CanonicalOffer {
  return {
    id,
    price: amount === undefined ? undefined : { total: { amount, currencyCode: "USD" } },
  } as unknown as CanonicalOffer
}

function month(overrides: Partial<MigrationMonthSummary> & { key: string }): MigrationMonthSummary {
  return {
    label: overrides.key,
    departureStart: `${overrides.key}-01`,
    departureEnd: `${overrides.key}-28`,
    status: "available",
    ...overrides,
  }
}

function results(months: MigrationMonthSummary[]): SearchJobResponse {
  return { migrationMonths: months } as unknown as SearchJobResponse
}

test("a month that has only just been asked about is still searching", () => {
  /* The router's first answer for every month is a draft — `partial`, no offers
     yet. Recognising only `loading` drew that month as a dead one. */
  assert.equal(isMonthSearching(month({ key: "2026-06", status: "loading" })), true)
  assert.equal(isMonthSearching(month({ key: "2026-07", status: "partial" })), true)

  assert.equal(isMonthSearching(month({ key: "2026-08", status: "available" })), false)
  assert.equal(isMonthSearching(month({ key: "2026-09", status: "empty" })), false)
  assert.equal(isMonthSearching(month({ key: "2026-10", status: "error" })), false)
  assert.equal(isMonthSearching(month({ key: "2026-11", status: "cancelled" })), false)
})

test("the line a failed month shows is the reason, not the first progress notice", () => {
  /* The router appends the real cause to the end of the array; `[0]` returned
     whatever was recorded first, which is a progress line. */
  assert.equal(
    monthWarningLine(month({
      key: "2026-06",
      status: "error",
      warnings: ["Consultando Agil y Click and Book Plus.", "Agilsmart no respondió a tiempo."],
    })),
    "Agilsmart no respondió a tiempo.",
  )
  assert.equal(monthWarningLine(month({ key: "2026-07", warnings: [] })), undefined)
  assert.equal(monthWarningLine(month({ key: "2026-08" })), undefined)
})

test("a month whose fare the filters hid keeps its slot and loses the fare", () => {
  // 06 §3: «un mes sin datos no se oculta».
  const visible = offer("june")
  const hidden = offer("july")
  const displayed = monthsForDisplay(
    results([
      month({ key: "2026-06", offer: visible }),
      month({ key: "2026-07", offer: hidden }),
      month({ key: "2026-08", status: "empty" }),
    ]),
    [visible],
  )

  assert.deepEqual(displayed.map((entry) => entry.key), ["2026-06", "2026-07", "2026-08"])
  assert.equal(displayed[0].offer?.id, "june")
  assert.equal(displayed[0].filtered, undefined)
  assert.equal(displayed[1].offer, undefined)
  assert.equal(displayed[1].filtered, true)
  // A month that never had a fare is not marked as one a filter took away.
  assert.equal(displayed[2].filtered, undefined)
})

test("without months from the backend the offers themselves are the months", () => {
  const displayed = monthsForDisplay(
    { migrationMonths: [] } as unknown as SearchJobResponse,
    [
      { ...offer("a", 500), departureDate: "2026-06-14", tags: ["Migratorio"] } as unknown as CanonicalOffer,
      { ...offer("b", 700), departureDate: "2026-07-02", tags: ["Migratorio", "Julio 2026"] } as unknown as CanonicalOffer,
    ],
  )

  assert.deepEqual(displayed.map((entry) => entry.key), ["a", "b"])
  // The label is derived from the departure when the only tag is the mode's own.
  assert.equal(displayed[0].label, "Junio de 2026")
  // And a tag that names the month is preferred over deriving one.
  assert.equal(displayed[1].label, "Julio 2026")
})

test("the sweep header counts the months that answered and the ones still out", () => {
  const june = offer("june", 700)
  const july = offer("july", 900)
  const summary = migrationSweepSummary(
    results([
      month({ key: "2026-06", offer: june }),
      month({ key: "2026-07", offer: july }),
      month({ key: "2026-08", status: "partial" }),
      month({ key: "2026-09", status: "loading" }),
      month({ key: "2026-10", status: "empty" }),
    ]),
    [june, july],
  )

  assert.equal(summary.monthCount, 5)
  assert.equal(summary.priced, 2)
  assert.equal(summary.searching, 2)
})

test("a month the filters emptied stops counting as priced", () => {
  const june = offer("june", 700)
  const july = offer("july", 900)
  const summary = migrationSweepSummary(
    results([month({ key: "2026-06", offer: june }), month({ key: "2026-07", offer: july })]),
    [june],
  )

  assert.equal(summary.monthCount, 2)
  assert.equal(summary.priced, 1)
  assert.equal(summary.range, "USD 700.00")
})

test("«Rango» is the sweep's cheapest and dearest fare, in that order", () => {
  const dear = offer("dear", 1132.05)
  const cheap = offer("cheap", 668.9)
  const middle = offer("middle", 900)
  // Deliberately out of price order: the range is not the order of the months.
  const summary = migrationSweepSummary(
    results([
      month({ key: "2026-06", offer: dear }),
      month({ key: "2026-07", offer: cheap }),
      month({ key: "2026-08", offer: middle }),
    ]),
    [dear, cheap, middle],
  )

  assert.equal(summary.range, "USD 668.90 – 1,132.05")
  // 2f drops the currency and the cents: at 390 that row also carries the
  // counter and the state pill.
  assert.equal(summary.rangeShort, "669 – 1,132")
})

test("one priced month is one figure, not a range that repeats itself", () => {
  const only = offer("only", 700)
  const summary = migrationSweepSummary(
    results([month({ key: "2026-06", offer: only }), month({ key: "2026-07", status: "loading" })]),
    [only],
  )

  assert.equal(summary.range, "USD 700.00")
  assert.equal(summary.rangeShort, "700")
})

test("a sweep with nothing priced yet says so with a dash", () => {
  const summary = migrationSweepSummary(
    results([month({ key: "2026-06", status: "loading" }), month({ key: "2026-07", status: "partial" })]),
    [],
  )

  assert.equal(summary.priced, 0)
  assert.equal(summary.searching, 2)
  assert.equal(summary.range, "—")
  assert.equal(summary.rangeShort, "—")
})
