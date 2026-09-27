import { TIME_OF_DAY_PERIODS, type SearchFilters, type TimeOfDayPeriod } from "./types";
import { wallClockMs } from "./flight-duration";
import { maxStopsAcrossItineraries, totalDuration, type RankableItinerary, type RankableOffer } from "./ranking";

/* The fields a filter reads, structural so the browser's rail keeps exactly
   what the backend would. */
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

/**
 * The airline that controls an offer, one per offer: the one that tickets it
 * (the provider's validating carrier), else the first flight's marketer. A
 * partner that only markets or operates a leg does not. The airline filter,
 * its options and the card's name and logo all read this code.
 */
export function offerAirlineCode(offer: Pick<FilterableOffer, "mainCarrier" | "validatingCarrier">): string {
  return offer.validatingCarrier?.trim() || offer.mainCarrier?.trim() || "";
}

/** The parts of the day a request, a link or a stored view names, in catalogue order; anything else is dropped. */
export function readTimeOfDayPeriods(input: unknown): TimeOfDayPeriod[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }

  const periods = TIME_OF_DAY_PERIODS.filter((period) => input.includes(period));
  return periods.length > 0 ? periods : undefined;
}

/*
 * Whether a time is in one of `periods`, read as the card reads it: the
 * airport's wall clock, whatever offset the provider stamped on it (Click and
 * Book Plus writes `-05:00` on Madrid). A time that cannot be read is in none.
 */
function inPeriods(at: string | undefined, periods: readonly TimeOfDayPeriod[] | undefined): boolean {
  if (!periods?.length) {
    return true;
  }

  const wall = wallClockMs(at);
  if (wall === undefined) {
    return false;
  }

  const minutes = Math.floor(wall / 60_000) % 1440;
  const period: TimeOfDayPeriod = minutes >= 300 && minutes < 720
    ? "morning"
    : minutes >= 720 && minutes < 1080
      ? "afternoon"
      : "night";
  return periods.includes(period);
}

function outboundSegments(offer: FilterableOffer): readonly FilterableSegment[] {
  const itineraries = offer.itineraries ?? [];
  return (itineraries.find((itinerary) => itinerary.direction === "outbound") ?? itineraries[0])?.segments ?? [];
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

  /* Within a group the parts of the day add up; the groups narrow each other. */
  const outbound = outboundSegments(offer);
  if (!inPeriods(outbound[0]?.departureAt, filters.departurePeriods)) {
    return false;
  }

  if (!inPeriods(outbound[outbound.length - 1]?.arrivalAt, filters.arrivalPeriods)) {
    return false;
  }

  return true;
}
