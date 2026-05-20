import type { CanonicalOffer } from "@/types"

export type ResultListItem =
  | { type: "offer"; id: string; offer: CanonicalOffer; offerCount: 1 }
  | { type: "group"; id: string; group: ResultOfferGroup; offerCount: number }

export interface ResultOfferGroup {
  id: string
  key: string
  providerLabel: string
  offers: CanonicalOffer[]
}

type GroupBucket = ResultOfferGroup & {
  firstIndex: number
}

type NativeGroupDescriptor = {
  providerKey: "agil" | "costamar"
  providerLabel: string
  nativeId: string
}

export function buildResultListItems(offers: CanonicalOffer[]): ResultListItem[] {
  const buckets = new Map<string, GroupBucket>()
  const offerKeys = new Map<string, string>()

  offers.forEach((offer, index) => {
    const key = offerNaturalGroupKey(offer)
    if (!key) return

    offerKeys.set(offer.id, key)
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.offers.push(offer)
      return
    }

    const descriptor = nativeGroupDescriptor(offer)
    if (!descriptor) return

    buckets.set(key, {
      id: `result-group:${key}`,
      key,
      providerLabel: descriptor.providerLabel,
      offers: [offer],
      firstIndex: index,
    })
  })

  const groupedKeys = new Set(
    Array.from(buckets)
      .filter(([, bucket]) => bucket.offers.length > 1)
      .sort((left, right) => left[1].firstIndex - right[1].firstIndex)
      .map(([key]) => key),
  )
  const emittedGroups = new Set<string>()

  return offers.flatMap((offer): ResultListItem[] => {
    const key = offerKeys.get(offer.id)
    if (!key || !groupedKeys.has(key)) {
      return [{ type: "offer", id: offer.id, offer, offerCount: 1 }]
    }

    if (emittedGroups.has(key)) return []
    emittedGroups.add(key)

    const bucket = buckets.get(key)
    if (!bucket) return [{ type: "offer", id: offer.id, offer, offerCount: 1 }]

    return [{
      type: "group",
      id: bucket.id,
      offerCount: bucket.offers.length,
      group: {
        id: bucket.id,
        key: bucket.key,
        providerLabel: bucket.providerLabel,
        offers: bucket.offers,
      },
    }]
  })
}

export function resultListItemContainsOffer(item: ResultListItem, offerId: string): boolean {
  return item.type === "offer"
    ? item.offer.id === offerId
    : item.group.offers.some((offer) => offer.id === offerId)
}

export function countOffersInResultItems(items: ResultListItem[]): number {
  return items.reduce((total, item) => total + item.offerCount, 0)
}

function offerNaturalGroupKey(offer: CanonicalOffer): string | null {
  const descriptor = nativeGroupDescriptor(offer)
  if (!descriptor) return null

  const price = moneySignature(offer.price?.total)
  if (!price) return null

  return [
    descriptor.providerKey,
    descriptor.nativeId,
    price,
    baggageSignature(offer),
  ].join("|")
}

function nativeGroupDescriptor(offer: CanonicalOffer): NativeGroupDescriptor | null {
  const rawRefs = offer.rawRefs
  const agilGroupId = rawRefString(rawRefs?.agilGroupId)
  if (agilGroupId) {
    return {
      providerKey: "agil",
      providerLabel: "Agilsmart",
      nativeId: agilGroupId,
    }
  }

  const recommendationId = rawRefString(rawRefs?.recommendationId)
  if (recommendationId) {
    return {
      providerKey: "costamar",
      providerLabel: "Costamar",
      nativeId: costamarRecommendationBase(recommendationId),
    }
  }

  const pos = rawRefString(rawRefs?.pos)
  if (pos && isCostamarOffer(offer)) {
    return {
      providerKey: "costamar",
      providerLabel: "Costamar",
      nativeId: `pos:${pos}`,
    }
  }

  return null
}

function isCostamarOffer(offer: CanonicalOffer): boolean {
  return offer.providerSource === "costamar"
    || offer.purchasePaths?.some((path) => path.provider === "costamar") === true
}

function costamarRecommendationBase(value: string): string {
  return value.split(":")[0]?.trim() || value
}

function rawRefString(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null

  const text = String(value).trim()
  return text ? text : null
}

function moneySignature(money: CanonicalOffer["price"]["total"] | undefined): string | null {
  if (!money || !Number.isFinite(money.amount)) return null

  return `${money.currencyCode}:${Math.round(money.amount * 100)}`
}

function baggageSignature(offer: CanonicalOffer): string {
  const baggage = offer.baggage
  if (!baggage) return "bag:unknown"

  return [
    baggage.carryOnIncluded === true ? "carry:yes" : baggage.carryOnIncluded === false ? "carry:no" : "carry:unknown",
    baggage.checkedIncluded === true ? "checked:yes" : baggage.checkedIncluded === false ? "checked:no" : "checked:unknown",
    `checkedBags:${baggage.checkedBags ?? "unknown"}`,
  ].join(";")
}
