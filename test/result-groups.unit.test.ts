import { test } from "bun:test"
import assert from "node:assert/strict"
import {
  buildResultListItems,
  countOffersInResultItems,
  paginateResultListItems,
  resultListItemContainsOffer,
} from "../frontend/src/components/results/result-groups"
import type { CanonicalOffer } from "../frontend/src/types"

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

test("groups native Agil variants with the same fare", () => {
  const items = buildResultListItems([
    offer({ id: "agil-am", rawRefs: { agilGroupId: "G-100" } }),
    offer({
      id: "agil-pm",
      rawRefs: { agilGroupId: "G-100" },
      inboundDeparture: "2026-06-20T13:05:00-05:00",
      inboundArrival: "2026-06-20T21:10:00-05:00",
    }),
    offer({ id: "solo", rawRefs: { agilGroupId: "G-200" } }),
  ])

  assert.equal(items.length, 2)
  assert.equal(items[0]?.type, "group")
  if (items[0]?.type !== "group") throw new Error("Expected first item to be a group")

  assert.equal(items[0].group.providerLabel, "Agilsmart")
  assert.deepEqual(items[0].group.offers.map((item) => item.id), ["agil-am", "agil-pm"])
  assert.equal(countOffersInResultItems(items.slice(0, 1)), 2)
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
  ])

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
  ])

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
  ])

  assert.equal(items.length, 1)
  assert.equal(items[0]?.type, "group")
  if (items[0]?.type !== "group") throw new Error("Expected Costamar variants to be grouped")

  assert.equal(items[0].group.providerLabel, "Click and Book Plus")
  assert.deepEqual(items[0].group.offers.map((item) => item.id), ["costamar-1", "costamar-2"])
})

test("keeps native variants with different prices as separate offers", () => {
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
  ])

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
  ])

  assert.equal(items.length, 1)
  assert.equal(items[0]?.type, "group")
  if (items[0]?.type !== "group") throw new Error("Expected merged exact offer to remain grouped")

  assert.deepEqual(
    items[0].group.offers[0]?.purchasePaths?.map((path) => path.provider),
    ["agil-local", "costamar"],
  )
})

test("paginates compact groups by visual weight instead of raw grouped height", () => {
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
  ])

  const pages = paginateResultListItems(items, 4)

  assert.equal(pages.length, 2)
  assert.equal(pages[0]?.items.length, 3)
  assert.equal(pages[0]?.startOfferIndex, 0)
  assert.equal(pages[0]?.endOfferIndex, 5)
  assert.equal(pages[1]?.startOfferIndex, 5)
  assert.equal(pages[1]?.endOfferIndex, 7)
})
