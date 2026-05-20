import { CanonicalOffer, SearchFilters, Segment } from "./types";
import { maxStopsAcrossItineraries, totalDuration } from "./ranking";

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

function computeLayoverMinutes(itinerary: CanonicalOffer["itineraries"][number], index: number): number | null {
  const direct = itinerary?.layoverMinutes?.[index];
  if (typeof direct === "number" && direct > 0) {
    return direct;
  }

  const current = itinerary?.segments?.[index];
  const next = itinerary?.segments?.[index + 1];
  if (!current?.arrivalAt || !next?.departureAt) {
    return null;
  }

  const currentMs = new Date(current.arrivalAt).getTime();
  const nextMs = new Date(next.departureAt).getTime();
  if (!Number.isFinite(currentMs) || !Number.isFinite(nextMs) || nextMs <= currentMs) {
    return null;
  }

  return Math.round((nextMs - currentMs) / 60000);
}

function maxLayoverMinutes(offer: CanonicalOffer): number {
  let max = 0;

  for (const itinerary of offer.itineraries) {
    const segments = itinerary?.segments ?? [];
    for (let index = 0; index < segments.length - 1; index += 1) {
      const minutes = computeLayoverMinutes(itinerary, index);
      if (typeof minutes === "number" && minutes > max) {
        max = minutes;
      }
    }
  }

  return max;
}

export function applySearchFilters(
  offers: CanonicalOffer[],
  filters: SearchFilters,
): CanonicalOffer[] {
  return offers.filter((offer) => {
    const mainCarrier = offer.mainCarrier ?? offer.validatingCarrier ?? "";
    const maxStops = typeof filters.maxStops === "number" ? Math.max(0, filters.maxStops) : undefined;
    const maxOfferStops = maxStopsAcrossItineraries(offer.itineraries);

    if (typeof maxStops === "number" && maxOfferStops > maxStops) {
      return false;
    }

    if (filters.nonStop && maxOfferStops > 0) {
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

    if (
      typeof filters.maxLayoverMinutes === "number" &&
      maxLayoverMinutes(offer) > filters.maxLayoverMinutes
    ) {
      return false;
    }

    if (filters.carryOnRequired && offer.baggage?.carryOnIncluded !== true) {
      return false;
    }

    if ((filters.checkedBaggageRequired || filters.baggageRequired) && offer.baggage?.checkedIncluded !== true) {
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
