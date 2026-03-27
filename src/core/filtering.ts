import { CanonicalOffer, SearchFilters, Segment } from "./types";
import { totalDuration, totalStops } from "./ranking";

function toMinutes(iso: string): number {
  const date = new Date(iso);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function firstSegment(offer: CanonicalOffer): Segment | undefined {
  return offer.itineraries[0]?.segments[0];
}

function lastSegment(offer: CanonicalOffer): Segment | undefined {
  const itinerary = offer.itineraries[offer.itineraries.length - 1];
  return itinerary?.segments[itinerary.segments.length - 1];
}

export function applySearchFilters(
  offers: CanonicalOffer[],
  filters: SearchFilters,
): CanonicalOffer[] {
  return offers.filter((offer) => {
    const mainCarrier = offer.mainCarrier ?? offer.validatingCarrier ?? "";
    const maxStops = typeof filters.maxStops === "number" ? Math.max(0, filters.maxStops) : 1;

    if (totalStops(offer) > maxStops) {
      return false;
    }

    if (filters.nonStop && totalStops(offer) > 0) {
      return false;
    }

    if (typeof filters.maxPrice === "number" && offer.price.total.amount > filters.maxPrice) {
      return false;
    }

    if (
      filters.includedAirlineCodes &&
      filters.includedAirlineCodes.length > 0 &&
      !filters.includedAirlineCodes.includes(mainCarrier)
    ) {
      return false;
    }

    if (
      filters.excludedAirlineCodes &&
      filters.excludedAirlineCodes.length > 0 &&
      filters.excludedAirlineCodes.includes(mainCarrier)
    ) {
      return false;
    }

    if (
      typeof filters.maxTotalDurationMinutes === "number" &&
      totalDuration(offer) > filters.maxTotalDurationMinutes
    ) {
      return false;
    }

    if (filters.baggageRequired && !offer.baggage?.checkedIncluded) {
      return false;
    }

    if (filters.verifiedOnly && offer.priceConfidence !== "validated") {
      return false;
    }

    if (
      filters.exactPurchasePathOnly &&
      !offer.purchasePaths.some((path) => path.precision === "exact-offer")
    ) {
      return false;
    }

    const first = firstSegment(offer);
    const last = lastSegment(offer);

    if (first && typeof filters.minDepartureMinutes === "number") {
      if (toMinutes(first.departureAt) < filters.minDepartureMinutes) {
        return false;
      }
    }

    if (first && typeof filters.maxDepartureMinutes === "number") {
      if (toMinutes(first.departureAt) > filters.maxDepartureMinutes) {
        return false;
      }
    }

    if (last && typeof filters.minArrivalMinutes === "number") {
      if (toMinutes(last.arrivalAt) < filters.minArrivalMinutes) {
        return false;
      }
    }

    if (last && typeof filters.maxArrivalMinutes === "number") {
      if (toMinutes(last.arrivalAt) > filters.maxArrivalMinutes) {
        return false;
      }
    }

    return true;
  });
}
