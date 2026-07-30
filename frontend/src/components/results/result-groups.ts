import type { CanonicalOffer, SearchJobResponse } from "@/types"
import { buildResultCardModel } from "./result-card-model"

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

type ScheduleGroup = NonNullable<SearchJobResponse["scheduleGroups"]>[number]

export function buildResultListItems(
  offers: CanonicalOffer[],
  scheduleGroups: readonly ScheduleGroup[] = [],
): ResultListItem[] {
  const offersById = new Map(offers.map((offer) => [offer.id, offer]))
  const groupByOfferId = new Map<string, ResultOfferGroup>()
  const assignedOfferIds = new Set<string>()
  const registeredGroupIds = new Set<string>()

  for (const scheduleGroup of scheduleGroups) {
    if (registeredGroupIds.has(scheduleGroup.id)) continue

    const memberOffers: CanonicalOffer[] = []
    const memberOfferIds = new Set<string>()
    for (const combination of scheduleGroup.combinations) {
      if (memberOfferIds.has(combination.offerId) || assignedOfferIds.has(combination.offerId)) continue

      const offer = offersById.get(combination.offerId)
      if (!offer) continue

      memberOfferIds.add(offer.id)
      memberOffers.push(offer)
    }

    // A partially filtered or stale group is not a group in the visible list.
    // Its one remaining offer stays selectable as the complete backend offer.
    if (memberOffers.length <= 1) continue

    const id = `result-group:${scheduleGroup.id}`
    const group: ResultOfferGroup = {
      id,
      key: scheduleGroup.id,
      providerLabel: providerLabelForScheduleGroup(scheduleGroup.providerSource),
      offers: orderVisibleGroupOffers(memberOffers),
    }

    registeredGroupIds.add(scheduleGroup.id)
    for (const offer of memberOffers) {
      assignedOfferIds.add(offer.id)
      groupByOfferId.set(offer.id, group)
    }
  }

  const emittedGroups = new Set<string>()

  return offers.flatMap((offer): ResultListItem[] => {
    const group = groupByOfferId.get(offer.id)
    if (!group) {
      return [{ type: "offer", id: offer.id, offer, offerCount: 1 }]
    }

    if (emittedGroups.has(group.id)) return []
    emittedGroups.add(group.id)

    if (group.offers.length <= 1) {
      const visibleOffer = group.offers[0] ?? offer
      return [{ type: "offer", id: visibleOffer.id, offer: visibleOffer, offerCount: 1 }]
    }

    return [{
      type: "group",
      id: group.id,
      offerCount: group.offers.length,
      group,
    }]
  })
}

function providerLabelForScheduleGroup(providerSource: ScheduleGroup["providerSource"]): string {
  if (providerSource === "costamar") return "Click and Book Plus"
  if (providerSource === "agil-local") return "Agilsmart"
  return providerSource
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

/**
 * How much vertical room an item asks for, in card-heights.
 *
 * A group used to cost one card per alternative schedule. Plate 1b folds them
 * into a single strip inside the card that owns them, so the whole group is now
 * one card plus roughly a third of one — regardless of how many alternatives it
 * holds, because the strip scrolls sideways instead of growing.
 */
export function resultListItemDisplayWeight(item: ResultListItem): number {
  return item.type === "offer" ? 1 : 1.34
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

/**
 * What makes two offers in the same bucket worth showing separately. Duration
 * and stops are per leg now (plate 1b), so the signature is too — two offers
 * that differ only in a total we no longer display are the same offer here.
 */
function offerVisibleVariantSignature(offer: CanonicalOffer): string {
  return buildResultCardModel(offer, 1).legs
    .map((leg) => [
      leg.label,
      leg.hasKnownSchedule,
      leg.departureTime,
      leg.arrivalTime,
      leg.dayOffset,
      leg.duration,
      leg.stopsLabel,
    ].join(":"))
    .join(";")
}

function offerVariantDifferenceCount(primary: CanonicalOffer, variant: CanonicalOffer): number {
  const primaryLegs = buildResultCardModel(primary, 1).legs
  const variantLegs = buildResultCardModel(variant, 1).legs
  let count = 0

  for (let index = 0; index < Math.max(primaryLegs.length, variantLegs.length); index += 1) {
    const primaryLeg = primaryLegs[index]
    const variantLeg = variantLegs[index]
    if (!primaryLeg || !variantLeg) {
      count += 1
      continue
    }

    if (
      primaryLeg.hasKnownSchedule !== variantLeg.hasKnownSchedule
      || primaryLeg.departureTime !== variantLeg.departureTime
      || primaryLeg.arrivalTime !== variantLeg.arrivalTime
      || primaryLeg.dayOffset !== variantLeg.dayOffset
    ) {
      count += 1
      continue
    }

    if (primaryLeg.duration !== variantLeg.duration) count += 1
    if (primaryLeg.stopsLabel !== variantLeg.stopsLabel) count += 1
  }

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
