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

export interface ResultListPage {
  items: ResultListItem[]
  startOfferIndex: number
  endOfferIndex: number
  displayWeight: number
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
        offers: sortGroupOffersBySchedule(bucket.offers),
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

export function paginateResultListItems(
  items: ResultListItem[],
  pageCapacity: number,
): ResultListPage[] {
  if (items.length === 0) {
    return [{
      items: [],
      startOfferIndex: 0,
      endOfferIndex: 0,
      displayWeight: 0,
    }]
  }

  const safeCapacity = Math.max(1, pageCapacity)
  const pages: ResultListPage[] = []
  let pageItems: ResultListItem[] = []
  let pageWeight = 0
  let offerCursor = 0
  let pageStartOfferIndex = 0

  for (const item of items) {
    const itemWeight = resultListItemDisplayWeight(item)
    const shouldStartNextPage = pageItems.length > 0 && pageWeight + itemWeight > safeCapacity

    if (shouldStartNextPage) {
      const offerCount = countOffersInResultItems(pageItems)
      pages.push({
        items: pageItems,
        startOfferIndex: pageStartOfferIndex,
        endOfferIndex: pageStartOfferIndex + offerCount,
        displayWeight: pageWeight,
      })
      pageStartOfferIndex = offerCursor
      pageItems = []
      pageWeight = 0
    }

    pageItems.push(item)
    pageWeight += itemWeight
    offerCursor += item.offerCount
  }

  if (pageItems.length > 0) {
    const offerCount = countOffersInResultItems(pageItems)
    pages.push({
      items: pageItems,
      startOfferIndex: pageStartOfferIndex,
      endOfferIndex: pageStartOfferIndex + offerCount,
      displayWeight: pageWeight,
    })
  }

  return pages
}

export function resultListItemDisplayWeight(item: ResultListItem): number {
  if (item.type === "offer") return 1

  const variantCount = Math.max(0, item.offerCount - 1)
  return 1 + variantCount * 0.42
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

function sortGroupOffersBySchedule(offers: CanonicalOffer[]): CanonicalOffer[] {
  if (offers.length <= 1) return offers

  return offers
    .map((offer, index) => ({ offer, index }))
    .sort((left, right) => {
      const compared = compareScheduleSignature(left.offer, right.offer)
      return compared !== 0 ? compared : left.index - right.index
    })
    .map((item) => item.offer)
}

function compareScheduleSignature(left: CanonicalOffer, right: CanonicalOffer): number {
  const leftSignature = offerScheduleSignature(left)
  const rightSignature = offerScheduleSignature(right)

  for (let index = 0; index < Math.max(leftSignature.length, rightSignature.length); index += 1) {
    const leftPart = leftSignature[index] ?? ""
    const rightPart = rightSignature[index] ?? ""
    const compared = leftPart.localeCompare(rightPart)
    if (compared !== 0) return compared
  }

  return 0
}

function offerScheduleSignature(offer: CanonicalOffer): string[] {
  const itineraries = offer.itineraries ?? []

  return ["outbound", "inbound"].flatMap((direction) => {
    const itinerary = itineraries.find((item) => item.direction === direction)
    const segments = itinerary?.segments ?? []
    const first = segments[0]
    const last = segments[segments.length - 1]

    return [
      first?.departureAt ?? (direction === "outbound" ? offer.departureDate : offer.returnDate) ?? "",
      last?.arrivalAt ?? "",
    ]
  })
}
