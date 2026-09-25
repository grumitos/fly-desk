import type { CanonicalOffer, SearchJobResponse } from "@/types"
import { providerDisplayName } from "@/lib/providers"
import { resultLegModels, type ResultLegModel } from "./result-card-model"

export type ResultListItem =
  | { type: "offer"; id: string; offer: CanonicalOffer; offerCount: 1 }
  | { type: "group"; id: string; group: ResultOfferGroup; offerCount: number }

export interface ResultOfferGroup {
  id: string
  key: string
  providerLabel: string
  offers: CanonicalOffer[]
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
  const registeredGroups: ResultOfferGroup[] = []

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

    // A group the filters left with one offer is that offer, drawn on its own.
    if (memberOffers.length <= 1) continue

    const id = `result-group:${scheduleGroup.id}`
    const group: ResultOfferGroup = {
      id,
      key: scheduleGroup.id,
      providerLabel: providerDisplayName(scheduleGroup.providerSource),
      offers: memberOffers,
    }

    registeredGroupIds.add(scheduleGroup.id)
    registeredGroups.push(group)
    for (const offer of memberOffers) {
      assignedOfferIds.add(offer.id)
      groupByOfferId.set(offer.id, group)
    }
  }

  absorbOffersAlreadyInsideAGroup(offers, registeredGroups, assignedOfferIds, groupByOfferId)

  for (const group of registeredGroups) {
    group.offers = orderVisibleGroupOffers(group.offers)
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

/**
 * The same flight arriving twice — a `truncated` group, or one schedule quoted
 * under two offer ids — joins the group that already shows it, so the list does
 * not repeat a schedule the agent just read in the group above.
 *
 * Identity is the canonical flight signature plus the fare, the bar
 * `offer-schedule-groups.ts::groupKeyForOffer` groups on: two prices on one
 * schedule are two things to sell and stay two cards. It reads the filtered
 * offers, so a member the filters removed cannot come back this way.
 */
function absorbOffersAlreadyInsideAGroup(
  offers: CanonicalOffer[],
  groups: ResultOfferGroup[],
  assignedOfferIds: Set<string>,
  groupByOfferId: Map<string, ResultOfferGroup>,
): void {
  if (groups.length === 0) return

  const groupBySignature = new Map<string, ResultOfferGroup>()
  for (const group of groups) {
    for (const offer of group.offers) {
      const signature = offerCanonicalSignature(offer)
      if (!signature || groupBySignature.has(signature)) continue
      groupBySignature.set(signature, group)
    }
  }

  for (const offer of offers) {
    if (assignedOfferIds.has(offer.id)) continue

    const signature = offerCanonicalSignature(offer)
    const group = signature ? groupBySignature.get(signature) : undefined
    if (!group) continue

    assignedOfferIds.add(offer.id)
    groupByOfferId.set(offer.id, group)
    group.offers.push(offer)
  }
}

/*
 * `buildOfferSignature`'s field list and order plus `commercialTermsSignature`'s,
 * transcribed because the core functions take the full core offer. No
 * itinerary or no price means no signature: a missed fold costs a repeated
 * card, a wrong one hides a fare.
 */
function offerCanonicalSignature(offer: CanonicalOffer): string | null {
  const itineraries = offer.itineraries ?? []
  const amount = offer.price?.total?.amount
  const currencyCode = offer.price?.total?.currencyCode?.trim().toUpperCase()
  if (itineraries.length === 0 || !Number.isFinite(amount) || !currencyCode) return null

  const legs = itineraries
    .map((itinerary) => (itinerary.segments ?? [])
      .map((segment) => [
        segment.marketingCarrier ?? "",
        segment.flightNumber ?? "",
        segment.origin,
        segment.destination,
        segment.departureAt,
        segment.arrivalAt,
      ].join("|"))
      .join("~"))
    .join("||")

  return [
    offer.tripType ?? "",
    offer.origin ?? "",
    offer.destination ?? "",
    legs,
    offer.validatingCarrier ?? "",
    currencyCode,
    amount,
    offer.baggage?.carryOnIncluded ?? null,
    offer.baggage?.checkedIncluded ?? null,
    offer.baggage?.checkedBags ?? null,
    offer.baggage?.description ?? null,
  ].join("::")
}

export function resultListItemContainsOffer(item: ResultListItem, offerId: string): boolean {
  return item.type === "offer"
    ? item.offer.id === offerId
    : item.group.offers.some((offer) => offer.id === offerId)
}

/*
 * A group row in plain-row slots: the 52px fare band plus the 39px strip of
 * alternatives, with the row's hairline — 92 over 52. `result-card.css` owns
 * the geometry; `ResultsPanel` divides by this to recover the plain-row unit.
 */
export const RESULT_GROUP_CARD_WEIGHT = 1.77

/** How many leading items it takes to cover `capacity` plain-card slots. */
export function resultItemsFillingCapacity(items: ResultListItem[], capacity: number): number {
  const target = Math.max(1, capacity)
  let weight = 0

  for (let index = 0; index < items.length; index += 1) {
    weight += items[index]!.type === "offer" ? 1 : RESULT_GROUP_CARD_WEIGHT
    if (weight >= target) return index + 1
  }

  return items.length
}

type RankedGroupOffer = {
  offer: CanonicalOffer
  index: number
  duration: number
  schedule: string[]
}

function rankedGroupOffers(offers: CanonicalOffer[]): RankedGroupOffer[] {
  return offers.map((offer, index) => ({
    offer,
    index,
    duration: offerTotalDurationMinutes(offer),
    schedule: offerScheduleSignature(offer),
  }))
}

/* The shortest schedule leads; the rest follow by duration, then by how much
   of the lead's schedule they change. Keys are computed once per offer. */
function orderVisibleGroupOffers(offers: CanonicalOffer[]): CanonicalOffer[] {
  const ranked = rankedGroupOffers(offers).sort((left, right) => (
    compareNumber(left.duration, right.duration)
      || compareSchedule(left.schedule, right.schedule)
      || left.index - right.index
  ))
  const visible = uniqueVisibleGroupOffers(ranked)
  const primary = visible[0]
  if (!primary || visible.length <= 2) return visible.map((entry) => entry.offer)

  const primaryLegs = resultLegModels(primary.offer)
  const variants = visible.slice(1).map((entry) => ({
    ...entry,
    differences: offerVariantDifferenceCount(primaryLegs, resultLegModels(entry.offer)),
  }))
  variants.sort((left, right) => (
    compareNumber(left.duration, right.duration)
      || compareNumber(left.differences, right.differences)
      || compareSchedule(left.schedule, right.schedule)
      || left.index - right.index
  ))

  return [primary.offer, ...variants.map((entry) => entry.offer)]
}

/* Two offers that differ only in a total the card no longer draws are the same
   choice here. */
function uniqueVisibleGroupOffers(ranked: RankedGroupOffer[]): RankedGroupOffer[] {
  const seen = new Set<string>()
  return ranked.filter((entry) => {
    const signature = resultLegModels(entry.offer)
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
    if (seen.has(signature)) return false
    seen.add(signature)
    return true
  })
}

function offerVariantDifferenceCount(primaryLegs: ResultLegModel[], variantLegs: ResultLegModel[]): number {
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
  const metricDuration = Number(offer.comparisonMetrics?.totalDurationMinutes)
  if (Number.isFinite(metricDuration)) return metricDuration

  const itineraryDuration = (offer.itineraries ?? [])
    .map((itinerary) => {
      const minutes = Number(itinerary.durationMinutes)
      return Number.isFinite(minutes) ? minutes : 0
    })
    .reduce((sum, minutes) => sum + minutes, 0)

  return itineraryDuration > 0 ? itineraryDuration : Number.POSITIVE_INFINITY
}

function compareNumber(left: number, right: number): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function compareSchedule(left: string[], right: string[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const compared = (left[index] ?? "").localeCompare(right[index] ?? "")
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
