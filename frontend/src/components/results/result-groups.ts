import type { CanonicalOffer } from "@/types"
import { buildResultCardModel, type ResultJourneySummary } from "./result-card-model"

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

    const visibleOffers = orderVisibleGroupOffers(bucket.offers)
    if (visibleOffers.length <= 1) {
      const visibleOffer = visibleOffers[0] ?? offer
      return [{ type: "offer", id: visibleOffer.id, offer: visibleOffer, offerCount: 1 }]
    }

    return [{
      type: "group",
      id: bucket.id,
      offerCount: visibleOffers.length,
      group: {
        id: bucket.id,
        key: bucket.key,
        providerLabel: bucket.providerLabel,
        offers: visibleOffers,
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
      providerLabel: "Click and Book Plus",
      nativeId: costamarRecommendationBase(recommendationId),
    }
  }

  const pos = rawRefString(rawRefs?.pos)
  if (pos && isCostamarOffer(offer)) {
    return {
      providerKey: "costamar",
      providerLabel: "Click and Book Plus",
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

function orderVisibleGroupOffers(offers: CanonicalOffer[]): CanonicalOffer[] {
  const visibleOffers = uniqueVisibleGroupOffers(sortGroupOffersByBestOption(offers))
  const primary = visibleOffers[0]
  if (!primary || visibleOffers.length <= 2) return visibleOffers

  return [
    primary,
    ...sortGroupVariantOffers(primary, visibleOffers.slice(1)),
  ]
}

function sortGroupOffersByBestOption(offers: CanonicalOffer[]): CanonicalOffer[] {
  if (offers.length <= 1) return offers

  return offers
    .map((offer, index) => ({ offer, index }))
    .sort((left, right) => {
      return compareGroupOfferRank(left.offer, right.offer)
        || left.index - right.index
    })
    .map((item) => item.offer)
}

function sortGroupVariantOffers(primary: CanonicalOffer, offers: CanonicalOffer[]): CanonicalOffer[] {
  if (offers.length <= 1) return offers

  return offers
    .map((offer, index) => ({ offer, index }))
    .sort((left, right) => {
      return compareNumber(offerTotalDurationMinutes(left.offer), offerTotalDurationMinutes(right.offer))
        || compareNumber(offerVariantDifferenceCount(primary, left.offer), offerVariantDifferenceCount(primary, right.offer))
        || compareScheduleSignature(left.offer, right.offer)
        || left.index - right.index
    })
    .map((item) => item.offer)
}

function compareGroupOfferRank(left: CanonicalOffer, right: CanonicalOffer): number {
  return compareNumber(offerTotalDurationMinutes(left), offerTotalDurationMinutes(right))
    || compareScheduleSignature(left, right)
}

function uniqueVisibleGroupOffers(offers: CanonicalOffer[]): CanonicalOffer[] {
  const seen = new Set<string>()
  const visibleOffers: CanonicalOffer[] = []

  for (const offer of offers) {
    const signature = offerVisibleVariantSignature(offer)
    if (seen.has(signature)) continue

    seen.add(signature)
    visibleOffers.push(offer)
  }

  return visibleOffers
}

function offerVisibleVariantSignature(offer: CanonicalOffer): string {
  const model = buildResultCardModel(offer, 1)
  return [
    model.journeys.map(journeyVisibleScheduleSignature).join(";"),
    model.duration,
    model.stops.label,
    model.stops.layoverLabel,
  ].join("|")
}

function journeyVisibleScheduleSignature(journey: ResultJourneySummary): string {
  return [
    journey.label,
    journey.hasKnownSchedule,
    journey.departureTime,
    journey.arrivalTime,
    journey.arrivalDayOffset,
  ].join(":")
}

function offerVariantDifferenceCount(primary: CanonicalOffer, variant: CanonicalOffer): number {
  const primaryModel = buildResultCardModel(primary, 1)
  const variantModel = buildResultCardModel(variant, 1)
  const maxJourneys = Math.max(primaryModel.journeys.length, variantModel.journeys.length)
  let count = 0

  for (let index = 0; index < maxJourneys; index += 1) {
    const primaryJourney = primaryModel.journeys[index]
    const variantJourney = variantModel.journeys[index]
    if (!primaryJourney || !variantJourney) {
      count += 1
      continue
    }

    if (
      primaryJourney.hasKnownSchedule !== variantJourney.hasKnownSchedule
      || primaryJourney.departureTime !== variantJourney.departureTime
      || primaryJourney.arrivalTime !== variantJourney.arrivalTime
      || primaryJourney.arrivalDayOffset !== variantJourney.arrivalDayOffset
    ) {
      count += 1
    }
  }

  if (primaryModel.duration !== variantModel.duration) count += 1
  if (primaryModel.stops.label !== variantModel.stops.label) count += 1
  if (primaryModel.stops.layoverLabel !== variantModel.stops.layoverLabel) count += 1

  return count
}

function offerTotalDurationMinutes(offer: CanonicalOffer): number {
  const metricDuration = finiteNumber(offer.comparisonMetrics?.totalDurationMinutes)
  if (metricDuration !== null) return metricDuration

  const itineraryDuration = (offer.itineraries ?? [])
    .map((itinerary) => finiteNumber(itinerary.durationMinutes) ?? 0)
    .reduce((sum, minutes) => sum + minutes, 0)
  if (itineraryDuration > 0) return itineraryDuration

  return Number.POSITIVE_INFINITY
}

function finiteNumber(value: unknown): number | null {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}

function compareNumber(left: number, right: number): number {
  if (left === right) return 0
  return left < right ? -1 : 1
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
