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
 * What "departure" sorts against on a round trip: the first leg.
 *
 * An itinerary has two departures and only one of them is what the passenger
 * is choosing when they ask for departure order — the outbound, the one that
 * decides what time they leave the house. The return happens weeks later, and
 * ordering by it would put a trip that starts next month at the top. It is the
 * same leg `offerTravelDates` already picks to date an offer, and the same one
 * `minDepartureMinutes` / `maxDepartureMinutes` filter in `filtering.ts`, so
 * sorting and filtering by departure talk about the same flight.
 *
 * The whole instant, not the time of day: in a flexible search the offers fall
 * on different dates, and "07:00" on two different days are not comparable. A
 * departure that cannot be read sinks to the end (+Infinity) rather than
 * leading the list as a 0 would, and price and id break the tie down there.
 */
export function offerDepartureTimestamp(offer: CanonicalOffer): number {
  const outbound = offer.itineraries.find((itinerary: Itinerary) => itinerary.direction === "outbound")
    ?? offer.itineraries[0];
  const departureAt = outbound?.segments[0]?.departureAt;
  const parsed = departureAt ? Date.parse(departureAt) : Number.NaN;

  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
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
 * The tie-breaks, decided here rather than left to whichever provider answered
 * first.
 *
 * `Array.prototype.sort` has been stable since ES2019, so two offers that tie
 * on everything keep the order they arrived in — but "the order they arrived
 * in" is two providers answering in parallel, which changes between runs of
 * the same search. That is why every criterion ends in a total key instead of
 * leaning on stability: `compareOffersByDate` ends at the offer id, which is
 * unique, and with it one search gives one list every time.
 *
 * Price is the second key in both new orders:
 *
 * - **Stops** ties constantly — on an ordinary route half the results are
 *   direct — and with no tie-break the whole block would come out in provider
 *   order. Between two direct flights the agent sells the cheap one, which is
 *   what `cheapestOfferForMonth` already does when it picks a month's offer.
 * - **Departure** ties less, but it ties: two airlines leaving at the same
 *   hour, or two fares of the same flight, which is the frequent case.
 *
 * `cheapest` and `fastest` stay as they were: their second key was already
 * `compareOffersByDate`, and changing it would move lists nobody is disputing.
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
