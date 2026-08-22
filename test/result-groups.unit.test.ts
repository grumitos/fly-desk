import { test } from "bun:test"
import assert from "node:assert/strict"
import {
  buildResultListItems,
  resultItemsFillingCapacity,
  resultListItemContainsOffer,
} from "../frontend/src/components/results/result-groups"
import type { CanonicalOffer, SearchJobResponse } from "../frontend/src/types"

type ScheduleGroup = NonNullable<SearchJobResponse["scheduleGroups"]>[number]

function scheduleGroup({
  id,
  providerSource = "agil-local",
  offerIds,
}: {
  id: string
  providerSource?: ScheduleGroup["providerSource"]
  offerIds: string[]
}): ScheduleGroup {
  return {
    id,
    providerSource,
    outboundOptions: [],
    inboundOptions: [],
    combinations: offerIds.map((offerId, index) => ({
      outboundOptionId: `outbound-${index}`,
      inboundOptionId: `inbound-${index}`,
      offerId,
    })),
    truncated: false,
  }
}

function offer({
  id,
  providerSource = "agil-local",
  amount = 500,
  rawRefs,
  purchaseProviders = [providerSource],
  outboundDeparture = "2026-06-15T10:00:00-05:00",
  outboundArrival = "2026-06-15T16:00:00-05:00",
  inboundDeparture = "2026-06-20T09:00:00-05:00",
  inboundArrival = "2026-06-20T15:00:00-05:00",
  totalDurationMinutes,
}: {
  id: string
  providerSource?: CanonicalOffer["providerSource"]
  amount?: number
  rawRefs?: Record<string, unknown>
  purchaseProviders?: string[]
  outboundDeparture?: string
  outboundArrival?: string
  inboundDeparture?: string
  inboundArrival?: string
  totalDurationMinutes?: number
}): CanonicalOffer {
  return {
    id,
    providerSource,
    airline: "LATAM Airlines",
    mainCarrier: "LA",
    origin: "LIM",
    destination: "MIA",
    departureDate: "2026-06-15T10:00:00-05:00",
    duration: "6h",
    stops: 0,
    baggage: {
      carryOnIncluded: true,
      checkedIncluded: true,
      checkedBags: 1,
    },
    price: {
      total: { amount, currencyCode: "USD" },
    },
    comparisonMetrics: totalDurationMinutes !== undefined
      ? { totalDurationMinutes, totalStops: 0 }
      : undefined,
    itineraries: [
      {
        direction: "outbound",
        durationMinutes: 360,
        stops: 0,
        segments: [
          {
            flightNumber: "LA 100",
            marketingCarrier: "LA",
            origin: "LIM",
            destination: "MIA",
            departureAt: outboundDeparture,
            arrivalAt: outboundArrival,
          },
        ],
      },
      {
        direction: "inbound",
        durationMinutes: 360,
        stops: 0,
        segments: [
          {
            flightNumber: "LA 200",
            marketingCarrier: "LA",
            origin: "MIA",
            destination: "LIM",
            departureAt: inboundDeparture,
            arrivalAt: inboundArrival,
          },
        ],
      },
    ],
    rawRefs,
    purchasePaths: purchaseProviders.map((provider, index) => ({
      id: `${id}-path-${index}`,
      provider,
      type: "search-redirect",
      label: `Abrir ${provider}`,
      url: `https://example.test/${provider}/${id}`,
      precision: "search-equivalent",
      state: "available",
      commercialMode: "provider",
    })),
  } as CanonicalOffer
}

test("does not infer schedule groups from reused provider raw references", () => {
  const offers = [
    offer({ id: "same-ref-day-one", rawRefs: { agilGroupId: "REUSED" } }),
    offer({
      id: "same-ref-day-two",
      rawRefs: { agilGroupId: "REUSED" },
      outboundDeparture: "2026-06-16T10:00:00-05:00",
      outboundArrival: "2026-06-16T16:00:00-05:00",
    }),
  ]

  const items = buildResultListItems(offers, [])

  assert.deepEqual(items.map((item) => item.type), ["offer", "offer"])
  assert.deepEqual(items.map((item) => item.id), ["same-ref-day-one", "same-ref-day-two"])
})

test("uses backend combination offer ids as the only schedule-group membership", () => {
  const first = offer({ id: "first", rawRefs: { agilGroupId: "MISLEADING" } })
  const unrelated = offer({
    id: "unrelated",
    rawRefs: { agilGroupId: "MISLEADING" },
    inboundDeparture: "2026-06-20T11:00:00-05:00",
  })
  const second = offer({
    id: "second",
    rawRefs: { agilGroupId: "OTHER" },
    inboundDeparture: "2026-06-20T13:00:00-05:00",
  })

  const items = buildResultListItems(
    [first, unrelated, second],
    [scheduleGroup({ id: "authoritative", offerIds: [first.id, second.id] })],
  )

  assert.equal(items.length, 2)
  assert.equal(items[0]?.type, "group")
  if (items[0]?.type !== "group") throw new Error("Expected backend-defined group")

  assert.deepEqual(items[0].group.offers.map((item) => item.id), [first.id, second.id])
  assert.strictEqual(items[0].group.offers[0], first)
  assert.strictEqual(items[0].group.offers[1], second)
  assert.equal(items[1]?.id, unrelated.id)
})

test("ignores stale and filtered-out combination ids without synthesizing an offer", () => {
  const visible = offer({ id: "visible", rawRefs: { agilGroupId: "REUSED" } })
  const otherVisible = offer({
    id: "other-visible",
    rawRefs: { agilGroupId: "REUSED" },
    inboundDeparture: "2026-06-20T13:00:00-05:00",
  })

  const items = buildResultListItems(
    [visible, otherVisible],
    [scheduleGroup({ id: "partially-visible", offerIds: [visible.id, "filtered-out", "missing"] })],
  )

  assert.deepEqual(items.map((item) => item.type), ["offer", "offer"])
  assert.deepEqual(items.map((item) => item.id), [visible.id, otherVisible.id])
})

test("groups native Agil variants with the same fare", () => {
  const items = buildResultListItems([
    offer({ id: "agil-am", rawRefs: { agilGroupId: "G-100" } }),
    offer({
      id: "agil-pm",
      rawRefs: { agilGroupId: "G-100" },
      inboundDeparture: "2026-06-20T13:05:00-05:00",
      inboundArrival: "2026-06-20T21:10:00-05:00",
    }),
    /* Its own flight, not merely its own `agilGroupId`. The fixture used to
       reuse the default schedule, which made "solo" the same metal at the same
       times for the same money as `agil-am` — a duplicate the list now folds
       into the group it repeats. The distinction this case is about has never
       been the raw reference: the UI is forbidden from reading those (see the
       first case in this file), so a lone offer has to be lone on the facts the
       card shows. */
    offer({
      id: "solo",
      rawRefs: { agilGroupId: "G-200" },
      outboundDeparture: "2026-06-15T18:40:00-05:00",
      outboundArrival: "2026-06-16T00:40:00-05:00",
    }),
  ], [scheduleGroup({ id: "G-100", offerIds: ["agil-am", "agil-pm"] })])

  assert.equal(items.length, 2)
  assert.equal(items[0]?.type, "group")
  if (items[0]?.type !== "group") throw new Error("Expected first item to be a group")

  assert.equal(items[0].group.providerLabel, "Agilsmart")
  assert.deepEqual(items[0].group.offers.map((item) => item.id), ["agil-am", "agil-pm"])
  assert.equal(items[0].offerCount, 2)
  assert.equal(resultListItemContainsOffer(items[0], "agil-pm"), true)
})

test("orders grouped native variants by their changing schedules", () => {
  const items = buildResultListItems([
    offer({
      id: "late-return",
      rawRefs: { agilGroupId: "G-150" },
      inboundDeparture: "2026-06-20T20:30:00-05:00",
      inboundArrival: "2026-06-21T15:25:00-05:00",
    }),
    offer({
      id: "early-return",
      rawRefs: { agilGroupId: "G-150" },
      inboundDeparture: "2026-06-20T06:00:00-05:00",
      inboundArrival: "2026-06-20T15:25:00-05:00",
    }),
    offer({
      id: "mid-return",
      rawRefs: { agilGroupId: "G-150" },
      inboundDeparture: "2026-06-20T13:05:00-05:00",
      inboundArrival: "2026-06-21T15:25:00-05:00",
    }),
  ], [scheduleGroup({
    id: "G-150",
    offerIds: ["late-return", "early-return", "mid-return"],
  })])

  assert.equal(items.length, 1)
  assert.equal(items[0]?.type, "group")
  if (items[0]?.type !== "group") throw new Error("Expected variants to be grouped")

  assert.deepEqual(
    items[0].group.offers.map((item) => item.id),
    ["early-return", "mid-return", "late-return"],
  )
})

test("promotes the shortest grouped schedule as primary and sorts variants by duration", () => {
  const items = buildResultListItems([
    offer({
      id: "early-slow",
      rawRefs: { agilGroupId: "G-175" },
      outboundDeparture: "2026-06-15T11:00:00-05:00",
      outboundArrival: "2026-06-16T05:40:00+02:00",
      inboundDeparture: "2026-06-20T00:05:00+02:00",
      inboundArrival: "2026-06-20T05:30:00-05:00",
      totalDurationMinutes: 1445,
    }),
    offer({
      id: "early-mid",
      rawRefs: { agilGroupId: "G-175" },
      outboundDeparture: "2026-06-15T11:00:00-05:00",
      outboundArrival: "2026-06-16T05:40:00+02:00",
      inboundDeparture: "2026-06-20T01:45:00+02:00",
      inboundArrival: "2026-06-20T06:30:00-05:00",
      totalDurationMinutes: 1405,
    }),
    offer({
      id: "late-fastest",
      rawRefs: { agilGroupId: "G-175" },
      outboundDeparture: "2026-06-15T20:00:00-05:00",
      outboundArrival: "2026-06-16T14:20:00+02:00",
      inboundDeparture: "2026-06-20T01:45:00+02:00",
      inboundArrival: "2026-06-20T06:30:00-05:00",
      totalDurationMinutes: 1385,
    }),
    offer({
      id: "late-second",
      rawRefs: { agilGroupId: "G-175" },
      outboundDeparture: "2026-06-15T20:00:00-05:00",
      outboundArrival: "2026-06-16T14:20:00+02:00",
      inboundDeparture: "2026-06-20T13:20:00+02:00",
      inboundArrival: "2026-06-20T18:20:00-05:00",
      totalDurationMinutes: 1400,
    }),
  ], [scheduleGroup({
    id: "G-175",
    offerIds: ["early-slow", "early-mid", "late-fastest", "late-second"],
  })])

  assert.equal(items.length, 1)
  assert.equal(items[0]?.type, "group")
  if (items[0]?.type !== "group") throw new Error("Expected variants to be grouped")

  assert.deepEqual(
    items[0].group.offers.map((item) => item.id),
    ["late-fastest", "late-second", "early-mid", "early-slow"],
  )
})

test("groups Costamar recommendation variants by recommendation base", () => {
  const items = buildResultListItems([
    offer({
      id: "costamar-1",
      providerSource: "costamar",
      rawRefs: { recommendationId: "REC-7:0" },
    }),
    offer({
      id: "costamar-2",
      providerSource: "costamar",
      rawRefs: { recommendationId: "REC-7:1" },
      inboundDeparture: "2026-06-20T13:05:00-05:00",
      inboundArrival: "2026-06-20T21:10:00-05:00",
    }),
  ], [scheduleGroup({
    id: "REC-7",
    providerSource: "costamar",
    offerIds: ["costamar-1", "costamar-2"],
  })])

  assert.equal(items.length, 1)
  assert.equal(items[0]?.type, "group")
  if (items[0]?.type !== "group") throw new Error("Expected Costamar variants to be grouped")

  assert.equal(items[0].group.providerLabel, "Click and Book Plus")
  assert.deepEqual(items[0].group.offers.map((item) => item.id), ["costamar-1", "costamar-2"])
})

test("keeps offers separate when backend does not publish a schedule group", () => {
  const items = buildResultListItems([
    offer({ id: "fare-500", rawRefs: { agilGroupId: "G-300" }, amount: 500 }),
    offer({ id: "fare-540", rawRefs: { agilGroupId: "G-300" }, amount: 540 }),
  ])

  assert.deepEqual(items.map((item) => item.type), ["offer", "offer"])
})

test("collapses native variants with no visible differences", () => {
  const items = buildResultListItems([
    offer({ id: "duplicate-1", rawRefs: { agilGroupId: "G-350" } }),
    offer({ id: "duplicate-2", rawRefs: { agilGroupId: "G-350" } }),
  ], [scheduleGroup({ id: "G-350", offerIds: ["duplicate-1", "duplicate-2"] })])

  assert.equal(items.length, 1)
  assert.equal(items[0]?.type, "offer")
  assert.equal(items[0]?.id, "duplicate-1")
})

test("keeps exact provider matches inside the native schedule group", () => {
  const items = buildResultListItems([
    offer({
      id: "merged-exact",
      rawRefs: { agilGroupId: "G-400" },
      purchaseProviders: ["agil-local", "costamar"],
    }),
    offer({
      id: "agil-later",
      rawRefs: { agilGroupId: "G-400" },
      inboundDeparture: "2026-06-20T13:05:00-05:00",
      inboundArrival: "2026-06-20T21:10:00-05:00",
    }),
  ], [scheduleGroup({ id: "G-400", offerIds: ["merged-exact", "agil-later"] })])

  assert.equal(items.length, 1)
  assert.equal(items[0]?.type, "group")
  if (items[0]?.type !== "group") throw new Error("Expected merged exact offer to remain grouped")

  assert.deepEqual(
    items[0].group.offers[0]?.purchasePaths?.map((path) => path.provider),
    ["agil-local", "costamar"],
  )
})

test("opens the list on visual weight instead of raw item count", () => {
  const items = buildResultListItems([
    offer({ id: "group-3", rawRefs: { agilGroupId: "G-500" } }),
    offer({
      id: "group-1",
      rawRefs: { agilGroupId: "G-500" },
      inboundDeparture: "2026-06-20T13:05:00-05:00",
      inboundArrival: "2026-06-20T20:10:00-05:00",
    }),
    offer({
      id: "group-2",
      rawRefs: { agilGroupId: "G-500" },
      inboundDeparture: "2026-06-20T09:15:00-05:00",
      inboundArrival: "2026-06-20T18:30:00-05:00",
    }),
    offer({ id: "solo-1", rawRefs: { agilGroupId: "G-501" }, amount: 510 }),
    offer({ id: "solo-2", rawRefs: { agilGroupId: "G-502" }, amount: 520 }),
    offer({ id: "solo-3", rawRefs: { agilGroupId: "G-503" }, amount: 530 }),
    offer({ id: "solo-4", rawRefs: { agilGroupId: "G-504" }, amount: 540 }),
  ], [scheduleGroup({ id: "G-500", offerIds: ["group-3", "group-1", "group-2"] })])

  /* Four plain-card slots against a group (1.67) and three flights: the third
     flight is what reaches four, so the window opens on four items and not on
     the four *cards* a count would have asked for. */
  assert.deepEqual(items.map((item) => item.type), ["group", "offer", "offer", "offer", "offer"])
  assert.equal(resultItemsFillingCapacity(items, 4), 4)
  /* One card of the column is one item, however heavy that item is. */
  assert.equal(resultItemsFillingCapacity(items, 1), 1)
  /* A column nothing can fill is the whole list, not an endless window. */
  assert.equal(resultItemsFillingCapacity(items, 99), items.length)
  assert.equal(resultItemsFillingCapacity([], 4), 0)
})

test("folds an offer the truncated group never listed back into the group it repeats", () => {
  /*
   * Leak (a) of «uno que ya está en otro grupo se muestra como independiente
   * repitiendo los horarios ya antes mostrados». The provider stopped
   * enumerating combinations — `truncated` — while its family kept the offers,
   * so an offer whose legs the group already draws arrived with no combination
   * pointing at it and became a card of its own.
   */
  const first = offer({ id: "listed-am", rawRefs: { agilGroupId: "G-700" } })
  const second = offer({
    id: "listed-pm",
    rawRefs: { agilGroupId: "G-700" },
    inboundDeparture: "2026-06-20T13:05:00-05:00",
    inboundArrival: "2026-06-20T21:10:00-05:00",
  })
  // The same flight as `listed-pm`, to the minute and to the fare.
  const unlisted = offer({
    id: "unlisted-pm",
    rawRefs: { agilGroupId: "G-700" },
    inboundDeparture: "2026-06-20T13:05:00-05:00",
    inboundArrival: "2026-06-20T21:10:00-05:00",
  })

  const items = buildResultListItems(
    [first, second, unlisted],
    [{ ...scheduleGroup({ id: "G-700", offerIds: [first.id, second.id] }), truncated: true }],
  )

  assert.deepEqual(items.map((item) => item.type), ["group"])
  if (items[0]?.type !== "group") throw new Error("Expected a single group")
  // Two schedules, not three rows drawing two schedules. The unlisted offer is
  // folded in and then collapses onto the schedule it repeats, which is the
  // same thing that has always happened to a duplicate the provider *did*
  // list — it leaves no card and no row of its own.
  assert.deepEqual(items[0].group.offers.map((item) => item.id), ["listed-am", "listed-pm"])
  assert.equal(items.some((item) => resultListItemContainsOffer(item, "unlisted-pm")), false)
})

test("folds a second offer id for one physical flight into the group holding it", () => {
  /* Leak (b): the same schedule quoted twice, once inside the group and once
     outside it. Nothing the card draws tells the two apart. */
  const grouped = offer({ id: "grouped", rawRefs: { agilGroupId: "G-710" } })
  const groupedLate = offer({
    id: "grouped-late",
    rawRefs: { agilGroupId: "G-710" },
    inboundDeparture: "2026-06-20T18:05:00-05:00",
    inboundArrival: "2026-06-21T02:10:00-05:00",
  })
  const twin = offer({ id: "grouped-twin", rawRefs: { agilGroupId: "G-711" } })

  const items = buildResultListItems(
    [grouped, groupedLate, twin],
    [scheduleGroup({ id: "G-710", offerIds: [grouped.id, groupedLate.id] })],
  )

  assert.deepEqual(items.map((item) => item.type), ["group"])
  if (items[0]?.type !== "group") throw new Error("Expected a single group")
  assert.deepEqual(items[0].group.offers.map((item) => item.id), ["grouped", "grouped-late"])
})

test("keeps a different fare on the same schedule as an offer of its own", () => {
  /*
   * The edge the fold stops at. Two prices for one flight are two things to
   * sell, and folding the second away would take a price off the screen —
   * so the browser folds on the bar the provider grouped on and no looser one
   * (`offer-schedule-groups.ts::groupKeyForOffer` wants currency, amount and
   * baggage to match before two offers are one group).
   */
  const grouped = offer({ id: "fare-base", rawRefs: { agilGroupId: "G-720" } })
  const groupedLate = offer({
    id: "fare-late",
    rawRefs: { agilGroupId: "G-720" },
    inboundDeparture: "2026-06-20T18:05:00-05:00",
    inboundArrival: "2026-06-21T02:10:00-05:00",
  })
  const cheaper = offer({ id: "fare-cheaper", rawRefs: { agilGroupId: "G-721" }, amount: 421 })

  const items = buildResultListItems(
    [grouped, groupedLate, cheaper],
    [scheduleGroup({ id: "G-720", offerIds: [grouped.id, groupedLate.id] })],
  )

  assert.deepEqual(items.map((item) => item.type), ["group", "offer"])
  assert.equal(items[1]?.id, "fare-cheaper")
  assert.equal(items.reduce((total, item) => total + item.offerCount, 0), 3)
})

test("a member the filters removed does not come back through the fold", () => {
  /*
   * The fold reads the offers that survived the filters, so it can only ever
   * point an offer at a schedule that is still on screen. A group the filters
   * emptied to one is still not a group — that rule is applied to the
   * combinations, before any folding, so an absorbed twin cannot revive it.
   */
  const survivor = offer({ id: "survivor", rawRefs: { agilGroupId: "G-730" } })
  const twin = offer({ id: "survivor-twin", rawRefs: { agilGroupId: "G-731" } })

  const items = buildResultListItems(
    // `filtered-out` is in the group's combinations and not in the offers.
    [survivor, twin],
    [scheduleGroup({ id: "G-730", offerIds: [survivor.id, "filtered-out"] })],
  )

  assert.deepEqual(items.map((item) => item.type), ["offer", "offer"])
  assert.deepEqual(items.map((item) => item.id), ["survivor", "survivor-twin"])
})
