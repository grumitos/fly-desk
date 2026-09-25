import { wallClockMs } from "./flight-duration";
import { CanonicalOffer, Itinerary, PurchasePath, SortMode } from "./types";

export function totalDuration(offer: CanonicalOffer): number {
  return offer.itineraries.reduce(
    (sum: number, itinerary: Itinerary) => sum + itinerary.durationMinutes,
    0,
  );
}

export function totalStops(offer: CanonicalOffer): number {
  return offer.itineraries.reduce(
    (sum: number, itinerary: Itinerary) => sum + itinerary.stops,
    0,
  );
}

export function maxStopsAcrossItineraries(itineraries: Itinerary[]): number {
  return itineraries.reduce(
    (max: number, itinerary: Itinerary) => Math.max(max, itinerary.stops),
    0,
  );
}

function offerTravelDates(offer: CanonicalOffer): { departureDate: string; returnDate: string } {
  const outbound = offer.itineraries.find((itinerary: Itinerary) => itinerary.direction === "outbound") ?? offer.itineraries[0];
  const inbound = offer.itineraries.find((itinerary: Itinerary) => itinerary.direction === "inbound");

  return {
    departureDate: outbound?.segments[0]?.departureAt?.slice(0, 10) ?? "",
    returnDate: inbound?.segments[0]?.departureAt?.slice(0, 10) ?? "",
  };
}

function compareOffersByDate(left: CanonicalOffer, right: CanonicalOffer): number {
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
 * Departure order is the outbound's first departure: on a round trip the return
 * is weeks later and is not what the agent is choosing. It is compared as the
 * wall clock the card shows, because providers stamp offsets inconsistently (an
 * Agil time has none, a Click and Book Plus time always says -05:00), so the
 * instant would order the server and the browser differently. A departure that
 * cannot be read sinks to the end instead of leading as a 0 would.
 */
export function offerDepartureTimestamp(offer: CanonicalOffer): number {
  const outbound = offer.itineraries.find((itinerary: Itinerary) => itinerary.direction === "outbound")
    ?? offer.itineraries[0];
  return wallClockMs(outbound?.segments[0]?.departureAt) ?? Number.POSITIVE_INFINITY;
}

/*
 * Not subtraction: `Infinity - Infinity` is `NaN`, and a comparator that
 * returns `NaN` leaves the order to whatever the engine feels like. Comparing
 * with `<` keeps the total order `sort` needs even when both sides are the
 * same infinity.
 */
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

/*
 * Every order ends in a total key (price, then the offer id through
 * `compareOffersByDate`), because two providers answer in parallel and "arrival
 * order" differs between two runs of one search.
 */
export function sortOffers(
  offers: CanonicalOffer[],
  mode: SortMode,
): CanonicalOffer[] {
  const cloned = [...offers];

  switch (mode) {
    case "cheapest":
      return cloned.sort((a, b) => {
        const priceDiff = a.price.total.amount - b.price.total.amount;
        return priceDiff !== 0 ? priceDiff : compareOffersByDate(a, b);
      });
    case "fastest":
      return cloned.sort((a, b) => {
        const durationDiff = totalDuration(a) - totalDuration(b);
        return durationDiff !== 0 ? durationDiff : compareOffersByDate(a, b);
      });
    case "departure":
      return cloned.sort((a, b) => {
        const departureDiff = compareNumbers(offerDepartureTimestamp(a), offerDepartureTimestamp(b));
        if (departureDiff !== 0) {
          return departureDiff;
        }

        const priceDiff = compareNumbers(a.price.total.amount, b.price.total.amount);
        return priceDiff !== 0 ? priceDiff : compareOffersByDate(a, b);
      });
    case "stops":
      return cloned.sort((a, b) => {
        const stopsDiff = compareNumbers(totalStops(a), totalStops(b));
        if (stopsDiff !== 0) {
          return stopsDiff;
        }

        const priceDiff = compareNumbers(a.price.total.amount, b.price.total.amount);
        return priceDiff !== 0 ? priceDiff : compareOffersByDate(a, b);
      });
    default:
      return cloned;
  }
}
