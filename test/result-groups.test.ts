import { test } from "bun:test"
import assert from "node:assert/strict"
import {
  buildResultListItems,
  countOffersInResultItems,
  resultListItemContainsOffer,
} from "../frontend/src/components/results/result-groups"
import type { CanonicalOffer } from "../frontend/src/types"

function offer({
  id,
  providerSource = "agil-local",
  amount = 500,
  rawRefs,
  purchaseProviders = [providerSource],
}: {
  id: string
  providerSource?: CanonicalOffer["providerSource"]
  amount?: number
  rawRefs?: Record<string, unknown>
  purchaseProviders?: string[]
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
    offer({ id: "agil-pm", rawRefs: { agilGroupId: "G-100" } }),
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
    }),
  ])

  assert.equal(items.length, 1)
  assert.equal(items[0]?.type, "group")
  if (items[0]?.type !== "group") throw new Error("Expected Costamar variants to be grouped")

  assert.equal(items[0].group.providerLabel, "Costamar")
  assert.deepEqual(items[0].group.offers.map((item) => item.id), ["costamar-1", "costamar-2"])
})

test("keeps native variants with different prices as separate offers", () => {
  const items = buildResultListItems([
    offer({ id: "fare-500", rawRefs: { agilGroupId: "G-300" }, amount: 500 }),
    offer({ id: "fare-540", rawRefs: { agilGroupId: "G-300" }, amount: 540 }),
  ])

  assert.deepEqual(items.map((item) => item.type), ["offer", "offer"])
})

test("keeps exact provider matches inside the native schedule group", () => {
  const items = buildResultListItems([
    offer({
      id: "merged-exact",
      rawRefs: { agilGroupId: "G-400" },
      purchaseProviders: ["agil-local", "costamar"],
    }),
    offer({ id: "agil-later", rawRefs: { agilGroupId: "G-400" } }),
  ])

  assert.equal(items.length, 1)
  assert.equal(items[0]?.type, "group")
  if (items[0]?.type !== "group") throw new Error("Expected merged exact offer to remain grouped")

  assert.deepEqual(
    items[0].group.offers[0]?.purchasePaths?.map((path) => path.provider),
    ["agil-local", "costamar"],
  )
})
