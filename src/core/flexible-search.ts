import { CanonicalOffer, SearchLeg, SearchRequest } from "./types";

export interface NightBounds {
  minNights: number;
  maxNights: number;
}

export interface UsefulRoundTripPair {
  departureDate: string;
  returnDate: string;
  stayNights: number;
}

function normalizeNightValue(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.trunc(value as number));
}

export function addDays(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function diffDays(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00Z`).getTime();
  const to = new Date(`${toIso}T00:00:00Z`).getTime();
  return Math.round((to - from) / 86400000);
}

export function enumerateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  let current = start;

  while (current <= end) {
    dates.push(current);
    current = addDays(current, 1);
  }

  return dates;
}

export function resolveNightBounds(leg: SearchLeg): NightBounds {
  const minNights = normalizeNightValue(leg.minNights, 1);
  const rawMaxNights = normalizeNightValue(leg.maxNights, minNights);

  return {
    minNights,
    maxNights: Math.max(minNights, rawMaxNights),
  };
}

export function isUsefulRoundTripCombination(
  leg: SearchLeg,
  departureDate: string,
  returnDate: string,
): boolean {
  if (returnDate <= departureDate) {
    return false;
  }

  const stayNights = diffDays(departureDate, returnDate);
  const bounds = resolveNightBounds(leg);
  return stayNights >= bounds.minNights && stayNights <= bounds.maxNights;
}

export function enumerateUsefulRoundTripPairs(request: SearchRequest): UsefulRoundTripPair[] {
  const leg = request.legs[0];
  if (!leg.departureStart || !leg.departureEnd || !leg.returnStart || !leg.returnEnd) {
    throw new Error("Round-trip flexible search requires departure and return ranges.");
  }

  const departures = enumerateRange(leg.departureStart, leg.departureEnd);
  const returns = enumerateRange(leg.returnStart, leg.returnEnd);

  return departures.flatMap((departureDate) =>
    returns.flatMap((returnDate) =>
      isUsefulRoundTripCombination(leg, departureDate, returnDate)
        ? [{
            departureDate,
            returnDate,
            stayNights: diffDays(departureDate, returnDate),
          }]
        : [],
    ),
  );
}

export function buildDerivedRequest(
  baseRequest: SearchRequest,
  departureDate: string,
  returnDate: string,
): SearchRequest {
  const leg = baseRequest.legs[0];
  return {
    ...baseRequest,
    searchMode: "exact",
    legs: [
      {
        ...leg,
        departureDate,
        returnDate,
      },
    ],
  };
}

export function buildDerivedOneWayRequest(
  baseRequest: SearchRequest,
  departureDate: string,
): SearchRequest {
  const leg = baseRequest.legs[0];
  return {
    ...baseRequest,
    tripType: "one-way",
    searchMode: "exact",
    legs: [
      {
        ...leg,
        departureDate,
        returnDate: undefined,
      },
    ],
  };
}

export function enumerateUsefulFlexibleRequests(request: SearchRequest): SearchRequest[] {
  const leg = request.legs[0];
  if (!leg.departureStart || !leg.departureEnd) {
    throw new Error("Flexible search requires departureStart and departureEnd.");
  }

  const departures = enumerateRange(leg.departureStart, leg.departureEnd);
  if (request.tripType === "one-way") {
    return departures.map((departureDate) => buildDerivedOneWayRequest(request, departureDate));
  }

  return enumerateUsefulRoundTripPairs(request).map((pair) =>
    buildDerivedRequest(request, pair.departureDate, pair.returnDate),
  );
}

export function buildExactRequestFromOffer(
  offer: CanonicalOffer,
  baseRequest: SearchRequest,
): SearchRequest {
  const outbound = offer.itineraries.find((itinerary) => itinerary.direction === "outbound") ?? offer.itineraries[0];
  const inbound = offer.itineraries.find((itinerary) => itinerary.direction === "inbound");
  const departureDate = outbound?.segments[0]?.departureAt?.slice(0, 10);
  const returnDate = inbound?.segments[0]?.departureAt?.slice(0, 10);

  if (!departureDate) {
    throw new Error("Offer is missing outbound departure date.");
  }

  return {
    ...baseRequest,
    tripType: inbound ? "round-trip" : "one-way",
    searchMode: "exact",
    legs: [
      {
        origin: offer.origin,
        destination: offer.destination,
        originLabel: baseRequest.legs[0]?.originLabel,
        destinationLabel: baseRequest.legs[0]?.destinationLabel,
        departureDate,
        returnDate,
      },
    ],
  };
}
