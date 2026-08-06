import {
  CanonicalOffer,
  FlexibleRoundTripMode,
  SearchLeg,
  SearchRequest,
} from "./types";

export interface NightBounds {
  minNights: number;
  maxNights: number;
}

export interface UsefulRoundTripPair {
  departureDate: string;
  returnDate: string;
  stayNights: number;
}

export type FlexibleRoundTripResolutionMode =
  | FlexibleRoundTripMode
  | "legacy-night-range";

export interface FlexibleRoundTripAxes {
  departureDates: string[];
  returnDates: string[];
}

export const MAX_FLEXIBLE_STAY_NIGHTS = 90;

interface ResolvedRoundTripFlexibleSpec {
  mode: FlexibleRoundTripResolutionMode;
  departureStart: string;
  departureEnd: string;
  returnStart: string;
  returnEnd: string;
  stayNights?: number;
  nightBounds?: NightBounds;
}

function hasFiniteNumber(value: number | undefined): value is number {
  return Number.isFinite(value);
}

function resolveExactStayReturnBounds(leg: SearchLeg): Pick<ResolvedRoundTripFlexibleSpec, "returnStart" | "returnEnd"> {
  const stayNights = resolveExactStayNights(leg);
  if (leg.returnStart && leg.returnEnd) {
    return {
      returnStart: leg.returnStart,
      returnEnd: leg.returnEnd,
    };
  }

  if (stayNights !== undefined && leg.departureStart && leg.departureEnd) {
    return {
      returnStart: addDays(leg.departureStart, stayNights),
      returnEnd: addDays(leg.departureEnd, stayNights),
    };
  }

  return {
    returnStart: leg.returnStart || leg.departureStart || "",
    returnEnd: leg.returnEnd || leg.departureEnd || "",
  };
}

export function normalizeNightValue(
  value: number | undefined,
  fallback?: number,
): number | undefined {
  if (!hasFiniteNumber(value)) {
    return fallback;
  }

  return Math.max(1, Math.trunc(value));
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
  const minNights = normalizeNightValue(leg.minNights, 1) ?? 1;
  const rawMaxNights = normalizeNightValue(leg.maxNights, minNights) ?? minNights;

  return {
    minNights,
    maxNights: Math.max(minNights, rawMaxNights),
  };
}

export function resolveExactStayNights(leg: SearchLeg): number | undefined {
  if (hasFiniteNumber(leg.stayNights)) {
    return normalizeNightValue(leg.stayNights);
  }

  if (
    hasFiniteNumber(leg.minNights)
    && hasFiniteNumber(leg.maxNights)
    && Math.trunc(leg.minNights) === Math.trunc(leg.maxNights)
  ) {
    return normalizeNightValue(leg.minNights);
  }

  return undefined;
}

function hasLegacyNightRangeConstraints(leg: SearchLeg): boolean {
  if (!hasFiniteNumber(leg.minNights) && !hasFiniteNumber(leg.maxNights)) {
    return false;
  }

  const exactStayNights = resolveExactStayNights(leg);
  if (exactStayNights === undefined) {
    return true;
  }

  return normalizeNightValue(leg.minNights) !== exactStayNights
    || normalizeNightValue(leg.maxNights) !== exactStayNights;
}

export function resolveFlexibleRoundTripMode(
  request: Pick<SearchRequest, "tripType" | "searchMode" | "flexibleMode" | "legs">,
): FlexibleRoundTripResolutionMode | undefined {
  if (request.tripType !== "round-trip" || request.searchMode !== "roundtrip-grid") {
    return undefined;
  }

  const leg = request.legs[0];
  const hasDepartureWindow = Boolean(leg?.departureStart && leg?.departureEnd);
  const hasReturnWindow = Boolean(leg?.returnStart && leg?.returnEnd);

  if (request.flexibleMode === "exact-stay" || request.flexibleMode === "fixed-ranges") {
    return request.flexibleMode;
  }

  if (resolveExactStayNights(leg) !== undefined) {
    return "exact-stay";
  }

  if (hasDepartureWindow && hasReturnWindow && !hasLegacyNightRangeConstraints(leg)) {
    return "fixed-ranges";
  }

  if (hasLegacyNightRangeConstraints(leg)) {
    return "legacy-night-range";
  }

  return hasDepartureWindow && hasReturnWindow
    ? "fixed-ranges"
    : undefined;
}

export function normalizeFlexibleRoundTripRequest(request: SearchRequest): SearchRequest {
  const resolvedMode = resolveFlexibleRoundTripMode(request);
  if (request.tripType !== "round-trip" || request.searchMode !== "roundtrip-grid") {
    return request;
  }

  const leg = request.legs[0];
  if (!resolvedMode) {
    return request;
  }

  if (resolvedMode === "exact-stay") {
    const { returnStart, returnEnd } = resolveExactStayReturnBounds(leg);
    return {
      ...request,
      flexibleMode: "exact-stay",
      legs: [
        {
          ...leg,
          returnStart,
          returnEnd,
          stayNights: resolveExactStayNights(leg),
          minNights: undefined,
          maxNights: undefined,
        },
      ],
    };
  }

  if (resolvedMode === "fixed-ranges") {
    return {
      ...request,
      flexibleMode: "fixed-ranges",
      legs: [
        {
          ...leg,
          stayNights: undefined,
          minNights: undefined,
          maxNights: undefined,
        },
      ],
    };
  }

  return {
    ...request,
    flexibleMode: undefined,
    legs: [
      {
        ...leg,
        stayNights: undefined,
      },
    ],
  };
}

function resolveRoundTripFlexibleSpec(request: SearchRequest): ResolvedRoundTripFlexibleSpec {
  const leg = request.legs[0];
  if (!leg.departureStart || !leg.departureEnd) {
    throw new Error("Round-trip flexible search requires departureStart and departureEnd.");
  }

  const mode = resolveFlexibleRoundTripMode(request);
  if (mode === "exact-stay") {
    const { returnStart, returnEnd } = resolveExactStayReturnBounds(leg);
    return {
      mode,
      departureStart: leg.departureStart,
      departureEnd: leg.departureEnd,
      returnStart,
      returnEnd,
      stayNights: resolveExactStayNights(leg),
    };
  }

  if (!leg.returnStart || !leg.returnEnd) {
    throw new Error("Round-trip flexible search requires returnStart and returnEnd.");
  }

  if (mode === "fixed-ranges") {
    return {
      mode,
      departureStart: leg.departureStart,
      departureEnd: leg.departureEnd,
      returnStart: leg.returnStart,
      returnEnd: leg.returnEnd,
    };
  }

  return {
    mode: "legacy-night-range",
    departureStart: leg.departureStart,
    departureEnd: leg.departureEnd,
    returnStart: leg.returnStart,
    returnEnd: leg.returnEnd,
    nightBounds: resolveNightBounds(leg),
  };
}

export function enumerateRoundTripFlexibleAxes(
  request: SearchRequest,
  pairs = enumerateUsefulRoundTripPairs(request),
): FlexibleRoundTripAxes {
  const spec = resolveRoundTripFlexibleSpec(request);
  if (spec.mode === "exact-stay") {
    return {
      departureDates: [...new Set(pairs.map((pair) => pair.departureDate))],
      returnDates: [...new Set(pairs.map((pair) => pair.returnDate))],
    };
  }

  return {
    departureDates: enumerateRange(spec.departureStart, spec.departureEnd),
    returnDates: enumerateRange(spec.returnStart, spec.returnEnd),
  };
}

export function isUsefulRoundTripCombination(
  request: SearchRequest,
  departureDate: string,
  returnDate: string,
): boolean {
  if (returnDate <= departureDate) {
    return false;
  }

  try {
    const spec = resolveRoundTripFlexibleSpec(request);
    if (
      departureDate < spec.departureStart
      || departureDate > spec.departureEnd
      || returnDate < spec.returnStart
      || returnDate > spec.returnEnd
    ) {
      return false;
    }

    const stayNights = diffDays(departureDate, returnDate);
    if (spec.mode === "exact-stay") {
      return stayNights === spec.stayNights;
    }

    if (spec.mode === "fixed-ranges") {
      return stayNights <= MAX_FLEXIBLE_STAY_NIGHTS;
    }

    return stayNights >= (spec.nightBounds?.minNights ?? 1)
      && stayNights <= (spec.nightBounds?.maxNights ?? stayNights);
  } catch {
    return false;
  }
}

export function enumerateUsefulRoundTripPairs(request: SearchRequest): UsefulRoundTripPair[] {
  const spec = resolveRoundTripFlexibleSpec(request);
  const departures = enumerateRange(spec.departureStart, spec.departureEnd);

  if (spec.mode === "exact-stay") {
    const stayNights = spec.stayNights;
    if (!hasFiniteNumber(stayNights)) {
      throw new Error("Round-trip exact-stay flexible search requires stayNights.");
    }

    return departures.flatMap((departureDate) => {
      const returnDate = addDays(departureDate, stayNights);
      return returnDate >= spec.returnStart
        && returnDate <= spec.returnEnd
        && returnDate > departureDate
        ? [{
            departureDate,
            returnDate,
            stayNights,
          }]
        : [];
    });
  }

  const returns = enumerateRange(spec.returnStart, spec.returnEnd);
  return departures.flatMap((departureDate) =>
    returns.flatMap((returnDate) =>
      isUsefulRoundTripCombination(request, departureDate, returnDate)
        ? [{
            departureDate,
            returnDate,
            stayNights: diffDays(departureDate, returnDate),
          }]
        : [],
    ),
  );
}

function buildExactLeg(
  leg: SearchLeg,
  departureDate: string,
  returnDate?: string,
): SearchLeg {
  return {
    origin: leg.origin,
    destination: leg.destination,
    originLabel: leg.originLabel,
    destinationLabel: leg.destinationLabel,
    departureDate,
    returnDate,
  };
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
    flexibleMode: undefined,
    legs: [
      buildExactLeg(leg, departureDate, returnDate),
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
    flexibleMode: undefined,
    legs: [
      buildExactLeg(leg, departureDate),
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
    flexibleMode: undefined,
    legs: [
      buildExactLeg(baseRequest.legs[0], departureDate, returnDate),
    ],
  };
}
