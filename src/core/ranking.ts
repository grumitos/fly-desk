import { wallClockMs } from "./flight-duration";
import type { CanonicalOffer, PurchasePath, SortMode } from "./types";

/* The fields an order reads, structural so the browser re-sorts its offers
   with this same comparator and cannot disagree with the backend. */
export interface RankableItinerary {
  direction?: string;
  durationMinutes?: number;
  stops?: number;
  segments?: ReadonlyArray<{ departureAt?: string }>;
}

export interface RankableOffer {
  id: string;
  price: { total: { amount: number } };
  itineraries?: readonly RankableItinerary[];
}

function itineraryStops(itinerary: RankableItinerary): number {
  return itinerary.stops ?? Math.max(0, (itinerary.segments?.length ?? 1) - 1);
}

export function totalDuration(offer: RankableOffer): number {
  return (offer.itineraries ?? []).reduce(
    (sum: number, itinerary: RankableItinerary) => sum + (itinerary.durationMinutes ?? 0),
    0,
  );
}

export function totalStops(offer: RankableOffer): number {
  return (offer.itineraries ?? []).reduce(
    (sum: number, itinerary: RankableItinerary) => sum + itineraryStops(itinerary),
    0,
  );
}

export function maxStopsAcrossItineraries(itineraries: readonly RankableItinerary[]): number {
  return itineraries.reduce(
    (max: number, itinerary: RankableItinerary) => Math.max(max, itineraryStops(itinerary)),
    0,
  );
}

function outboundItinerary(offer: RankableOffer): RankableItinerary | undefined {
  const itineraries = offer.itineraries ?? [];
  return itineraries.find((itinerary) => itinerary.direction === "outbound") ?? itineraries[0];
}

function offerTravelDates(offer: RankableOffer): { departureDate: string; returnDate: string } {
  const inbound = offer.itineraries?.find((itinerary) => itinerary.direction === "inbound");

  return {
    departureDate: outboundItinerary(offer)?.segments?.[0]?.departureAt?.slice(0, 10) ?? "",
    returnDate: inbound?.segments?.[0]?.departureAt?.slice(0, 10) ?? "",
  };
}

function compareOffersByDate(left: RankableOffer, right: RankableOffer): number {
  const leftDates = offerTravelDates(left);
  const rightDates = offerTravelDates(right);

  if (leftDates.departureDate !== rightDates.departureDate) {
    return leftDates.departureDate.localeCompare(rightDates.departureDate);
  }

  if (leftDates.returnDate !== rightDates.returnDate) {
    return leftDates.returnDate.localeCompare(rightDates.returnDate);
  }

  return left.id.localeCompare(right.id);
}

/*
 * The outbound's first departure, as the wall clock the card shows: providers
 * stamp offsets inconsistently (Agil none, Click and Book Plus -05:00), so the
 * instant would order differently. An unreadable departure sinks to the end.
 */
function offerDepartureTimestamp(offer: RankableOffer): number {
  return wallClockMs(outboundItinerary(offer)?.segments?.[0]?.departureAt) ?? Number.POSITIVE_INFINITY;
}

/* Not subtraction: `Infinity - Infinity` is `NaN`, which breaks the sort. */
function compareNumbers(left: number, right: number): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

function purchasePathScore(offer: CanonicalOffer): number {
  if (offer.purchasePaths.some((path: PurchasePath) => path.precision === "exact-offer")) {
    return 3;
  }

  if (offer.purchasePaths.some((path: PurchasePath) => path.type === "search-redirect")) {
    return 2;
  }

  if (offer.purchasePaths.some((path: PurchasePath) => path.type === "manual-reference")) {
    return 1;
  }

  return 0;
}

function baggageScore(offer: CanonicalOffer): number {
  if (offer.baggage?.checkedIncluded) {
    return 2;
  }

  if (offer.baggage?.carryOnIncluded) {
    return 1;
  }

  return 0;
}

export function enrichComparisonMetrics(offers: CanonicalOffer[]): CanonicalOffer[] {
  return offers.map((offer) => ({
    ...offer,
    comparisonMetrics: {
      totalDurationMinutes: totalDuration(offer),
      totalStops: totalStops(offer),
      baggageScore: baggageScore(offer),
      purchasePathScore: purchasePathScore(offer),
    },
  }));
}

/* Every order ends in a total key (price, then dates and the offer id): two
   providers answer in parallel, so arrival order differs between runs. */
export function compareOffers(mode: SortMode): (left: RankableOffer, right: RankableOffer) => number {
  switch (mode) {
    case "cheapest":
      return (a, b) => {
        const priceDiff = a.price.total.amount - b.price.total.amount;
        return priceDiff !== 0 ? priceDiff : compareOffersByDate(a, b);
      };
    case "fastest":
      return (a, b) => {
        const durationDiff = totalDuration(a) - totalDuration(b);
        return durationDiff !== 0 ? durationDiff : compareOffersByDate(a, b);
      };
    case "departure":
      return (a, b) => {
        const departureDiff = compareNumbers(offerDepartureTimestamp(a), offerDepartureTimestamp(b));
        if (departureDiff !== 0) {
          return departureDiff;
        }

        const priceDiff = compareNumbers(a.price.total.amount, b.price.total.amount);
        return priceDiff !== 0 ? priceDiff : compareOffersByDate(a, b);
      };
    case "stops":
      return (a, b) => {
        const stopsDiff = compareNumbers(totalStops(a), totalStops(b));
        if (stopsDiff !== 0) {
          return stopsDiff;
        }

        const priceDiff = compareNumbers(a.price.total.amount, b.price.total.amount);
        return priceDiff !== 0 ? priceDiff : compareOffersByDate(a, b);
      };
    default:
      return () => 0;
  }
}

export function sortOffers<T extends RankableOffer>(offers: readonly T[], mode: SortMode): T[] {
  return [...offers].sort(compareOffers(mode));
}
