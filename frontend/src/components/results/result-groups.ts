import type { CanonicalOffer, SearchJobResponse } from "@/types"
import { providerDisplayName } from "@/lib/providers"
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

    // A partially filtered or stale group is not a group in the visible list.
    // Its one remaining offer stays selectable as the complete backend offer.
    // Checked here, on the combinations alone: the absorption below only ever
    // adds a schedule the group is already showing, so it can never turn a
    // group the filters emptied back into one.
    if (memberOffers.length <= 1) continue

    const id = `result-group:${scheduleGroup.id}`
    const group: ResultOfferGroup = {
      id,
      key: scheduleGroup.id,
      providerLabel: providerLabelForScheduleGroup(scheduleGroup.providerSource),
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
 * The same flight, arriving twice.
 *
 * Membership used to be `combinations[].offerId` and nothing else, which trusts
 * the provider to have listed every offer its own group covers. Two things
 * break that trust, and both were reported from the desk as «uno que ya está en
 * otro grupo se muestra como independiente repitiendo los horarios ya antes
 * mostrados»: a `truncated` group, where the provider stopped enumerating
 * combinations while the family kept its offers, and the same physical schedule
 * quoted under two offer ids — a second fare on one flight. Either way the list
 * drew a card whose two legs the agent had just read inside the panel above it,
 * and the pager counted it as a further result.
 *
 * So an offer is inside a group when its itinerary is, not only when its id is.
 * The key is the canonical flight signature — every leg, its flight numbers,
 * airports and times — which is the identity
 * `src/core/offer-signature.ts::buildOfferSignature` demands when a quotation is
 * revalidated, and for the same reason: it is what makes two rows the same
 * flight rather than two flights that resemble each other.
 *
 * The fare rides along with it, and that is the edge worth stating. Two offers
 * on one schedule at two prices are two things to sell, and folding the second
 * away would hide a price from the agent — so it stays an independent card even
 * though its times repeat. This is not a new opinion: a group is already
 * defined that way upstream, where `offer-schedule-groups.ts::groupKeyForOffer`
 * refuses to put two offers in one group unless their currency, amount and
 * baggage all match. The browser folds on exactly the bar the provider grouped
 * on, and never on a looser one.
 *
 * It reads the already-filtered offers, so a member the filters removed cannot
 * come back through this door.
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

/**
 * Every leg of the trip to the flight number and the minute, and the fare it is
 * sold at.
 *
 * The itinerary half is `buildOfferSignature`'s field list and order,
 * transcribed rather than imported because the browser's `CanonicalOffer` is the
 * partial facade of the core type and the core function asks for the whole
 * thing. The commercial half is `commercialTermsSignature`'s, for the same
 * reason. An offer with no itinerary, or with no price to compare, has no
 * signature at all and is never folded into anything: silence here costs one
 * repeated card, and a wrong match costs a fare the agent never sees.
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

function providerLabelForScheduleGroup(providerSource: ScheduleGroup["providerSource"]): string {
  /* The two names the desk shows come from `providerDisplayName`, so the group
     heading and the card badge cannot drift apart. An id that helper does not
     know is still shown verbatim here rather than as its «Proveedor» stand-in:
     inside a group heading a bare id is a legible symptom, a placeholder is not. */
  return providerSource === "costamar" || providerSource === "agil-local"
    ? providerDisplayName(providerSource)
    : providerSource
}

export function resultListItemContainsOffer(item: ResultListItem, offerId: string): boolean {
  return item.type === "offer"
    ? item.offer.id === offerId
    : item.group.offers.some((offer) => offer.id === offerId)
}

/**
 * What a group row costs, in plain-row slots.
 *
 * A group used to cost one card per alternative schedule. Plate 1b folds them
 * into a single strip inside the row that owns them, so the whole group is now
 * one row and part of another — regardless of how many alternatives it holds,
 * because the strip scrolls sideways instead of growing.
 *
 * A row that carries the strip has no vertical padding to give back — the row
 * never had any — so it is the fare row plus the strip. Measured in the running
 * app, the two grid rows are 38 and 45: 38 is the legs block, the tallest thing
 * on a fare row and the reason a group row is shorter than the 52 a plain one
 * is held at; 45 is the strip's 8px of margin plus its own 37 (a 1px rule, 8
 * above the chips, the 26px chip, 2 below it). With the row's hairline that is
 * 84 against the plain row's 52, and with the list's gap now 0 a slot is 52 and
 * a group is 84, which is 1.62.
 *
 * It was 1.67 (107 over 64) while the row was a 58px card with a 6px gap under
 * it. Left alone, the column would have been measured with a group counted 3%
 * heavier than it is, and a list that opens on a measured number opens short.
 *
 * Exported because `ResultsPanel` divides a measured row height by the same
 * number to recover the plain-row unit from a column that holds nothing but
 * groups. It restated the literal instead, which left the two one edit apart
 * from disagreeing about what a group costs.
 */
export const RESULT_GROUP_CARD_WEIGHT = 1.62

/* Module-private: the window below is the only thing that weighs an item now.
   It was exported for the paginator, which is gone. */
function resultListItemDisplayWeight(item: ResultListItem): number {
  return item.type === "offer" ? 1 : RESULT_GROUP_CARD_WEIGHT
}

/**
 * How many leading items it takes to cover `capacity` plain-card slots.
 *
 * The list scrolls now, so the first window is not a page to be fitted exactly
 * — it is the part of the list that has to be on screen before the reader can
 * scroll at all. Counting items would get that wrong in the one case the
 * weights exist for: five items that happen to be groups are eight slots, and
 * five that are flights are five. Reaching the capacity is what matters, so a
 * window overshoots by at most the last item rather than opening a column with
 * a gap under the cards.
 */
export function resultItemsFillingCapacity(items: ResultListItem[], capacity: number): number {
  const target = Math.max(1, capacity)
  let weight = 0

  for (let index = 0; index < items.length; index += 1) {
    weight += resultListItemDisplayWeight(items[index]!)
    if (weight >= target) return index + 1
  }

  return items.length
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
