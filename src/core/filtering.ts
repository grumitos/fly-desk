import type { SearchFilters } from "./types";
import { maxStopsAcrossItineraries, totalDuration, type RankableItinerary, type RankableOffer } from "./ranking";

/*
 * The fields a filter reads. Structural for the same reason as `RankableOffer`:
 * the browser filters the offers it holds with this implementation, so the
 * rail and the backend cannot disagree about what a constraint keeps.
 */
interface FilterableSegment {
  departureAt?: string;
  arrivalAt?: string;
}

interface FilterableItinerary extends RankableItinerary {
  layoverMinutes?: readonly number[];
  segments?: readonly FilterableSegment[];
}

interface FilterableOffer extends RankableOffer {
  mainCarrier?: string;
  validatingCarrier?: string;
  itineraries?: readonly FilterableItinerary[];
  baggage?: { carryOnIncluded?: boolean; checkedIncluded?: boolean };
  purchasePaths?: ReadonlyArray<{ precision?: string }>;
}

/** `minStops` is the rail's «2+», a floor the backend request has no field for. */
export type OfferFilters = SearchFilters & { minStops?: number };

/** The code an airline filter matches: one airline per offer, the one that sells it. */
export function offerAirlineCode(offer: Pick<FilterableOffer, "mainCarrier" | "validatingCarrier">): string {
  return offer.mainCarrier ?? offer.validatingCarrier ?? "";
}

function toMinutes(iso: string): number {
  const date = new Date(iso);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function firstSegment(offer: FilterableOffer): FilterableSegment | undefined {
  return offer.itineraries?.[0]?.segments?.[0];
}

function lastSegment(offer: FilterableOffer): FilterableSegment | undefined {
  const itineraries = offer.itineraries ?? [];
  const segments = itineraries[itineraries.length - 1]?.segments ?? [];
  return segments[segments.length - 1];
}

function computeLayoverMinutes(itinerary: FilterableItinerary, index: number): number | null {
  const direct = itinerary.layoverMinutes?.[index];
  if (typeof direct === "number" && direct > 0) {
    return direct;
  }

  const current = itinerary.segments?.[index];
  const next = itinerary.segments?.[index + 1];
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

function maxLayoverMinutes(offer: FilterableOffer): number {
  let max = 0;

  for (const itinerary of offer.itineraries ?? []) {
    const segments = itinerary.segments ?? [];
    for (let index = 0; index < segments.length - 1; index += 1) {
      const minutes = computeLayoverMinutes(itinerary, index);
      if (typeof minutes === "number" && minutes > max) {
        max = minutes;
      }
    }
  }

  return max;
}

export function offerMatchesFilters(offer: FilterableOffer, filters: OfferFilters): boolean {
  const mainCarrier = offerAirlineCode(offer);
  const maxStops = typeof filters.maxStops === "number" ? Math.max(0, filters.maxStops) : undefined;
  const maxOfferStops = maxStopsAcrossItineraries(offer.itineraries ?? []);

  if (typeof maxStops === "number" && maxOfferStops > maxStops) {
    return false;
  }

  if (typeof filters.minStops === "number" && maxOfferStops < filters.minStops) {
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
    !(offer.purchasePaths ?? []).some((path) => path.precision === "exact-offer")
  ) {
    return false;
  }

  const first = firstSegment(offer);
  const last = lastSegment(offer);

  if (first?.departureAt && typeof filters.minDepartureMinutes === "number") {
    if (toMinutes(first.departureAt) < filters.minDepartureMinutes) {
      return false;
    }
  }

  if (first?.departureAt && typeof filters.maxDepartureMinutes === "number") {
    if (toMinutes(first.departureAt) > filters.maxDepartureMinutes) {
      return false;
    }
  }

  if (last?.arrivalAt && typeof filters.minArrivalMinutes === "number") {
    if (toMinutes(last.arrivalAt) < filters.minArrivalMinutes) {
      return false;
    }
  }

  if (last?.arrivalAt && typeof filters.maxArrivalMinutes === "number") {
    if (toMinutes(last.arrivalAt) > filters.maxArrivalMinutes) {
      return false;
    }
  }

  return true;
}

export function applySearchFilters<T extends FilterableOffer>(offers: readonly T[], filters: OfferFilters): T[] {
  return offers.filter((offer) => offerMatchesFilters(offer, filters));
}
