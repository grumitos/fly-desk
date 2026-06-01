import {
  diffDays,
  normalizeFlexibleRoundTripRequest,
  resolveFlexibleRoundTripMode,
} from "./core/flexible-search";
import {
  Cabin,
  FlexibleRoundTripMode,
  ProviderConfigInput,
  ProviderContext,
  ProviderId,
  SearchMode,
  SearchRequest,
  TripType,
} from "./core/types";
import { getSearchDatePolicy, validateSearchDateInPolicy } from "./search-date-policy";

export type SortMode = "cheapest" | "fastest";

export interface SearchPayload {
  // Backward-compatible ignored input: public flight searches always aggregate both providers.
  providerId?: ProviderId;
  providerConfig?: ProviderConfigInput;
  request?: Partial<SearchRequest> & {
    legs?: Array<Record<string, unknown>>;
    passengers?: Record<string, unknown>;
    filters?: Record<string, unknown>;
  };
  sortMode?: SortMode;
}

export interface PreparedSearchContract {
  providerIds: ProviderId[];
  request: SearchRequest;
}

const MAX_STAY_NIGHTS = 90;
const MAX_ROUNDTRIP_GRID_COMBINATIONS = 5000;

const DAY_IN_MS = 24 * 60 * 60 * 1000;

function parseIsoDateToUtcDay(dateValue: string): number | undefined {
  const value = Date.parse(`${dateValue}T00:00:00.000Z`);
  return Number.isFinite(value) ? Math.floor(value / DAY_IN_MS) : undefined;
}

function estimateRoundTripGridCombinations(
  departureStart: string,
  departureEnd: string,
  returnStart: string,
  returnEnd: string,
): number | undefined {
  const departureStartDay = parseIsoDateToUtcDay(departureStart);
  const departureEndDay = parseIsoDateToUtcDay(departureEnd);
  const returnStartDay = parseIsoDateToUtcDay(returnStart);
  const returnEndDay = parseIsoDateToUtcDay(returnEnd);

  if (
    departureStartDay === undefined
    || departureEndDay === undefined
    || returnStartDay === undefined
    || returnEndDay === undefined
  ) {
    return undefined;
  }

  if (departureEndDay < departureStartDay || returnEndDay < returnStartDay) {
    return 0;
  }

  let combinations = 0;
  for (let departureDay = departureStartDay; departureDay <= departureEndDay; departureDay += 1) {
    const minReturnDay = Math.max(returnStartDay, departureDay + 1);
    if (minReturnDay <= returnEndDay) {
      combinations += (returnEndDay - minReturnDay) + 1;
    }
  }

  return combinations;
}

function stringValue(input: unknown, fallback = ""): string {
  return typeof input === "string" ? input.trim() : fallback;
}

function numberValue(input: unknown, fallback?: number): number | undefined {
  if (input === undefined || input === null || input === "") {
    return fallback;
  }

  const value = typeof input === "number" ? input : Number(input);
  return Number.isFinite(value) ? value : fallback;
}

function booleanValue(input: unknown, fallback = false): boolean {
  return typeof input === "boolean" ? input : fallback;
}

function stringList(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }

  const values = input
    .map((entry) => typeof entry === "string" ? entry.trim().toUpperCase() : "")
    .filter(Boolean);

  return values.length > 0 ? values : undefined;
}

function normalizeTripType(input: unknown): TripType {
  if (input === "one-way" || input === "multi-city") {
    return input;
  }
  return "round-trip";
}

function normalizeSearchMode(input: unknown): SearchMode {
  if (input === "stay-range" || input === "roundtrip-grid" || input === "month-view") {
    return input;
  }
  return "exact";
}

function normalizeFlexibleMode(input: unknown): FlexibleRoundTripMode | undefined {
  return input === "fixed-ranges" || input === "exact-stay"
    ? input
    : undefined;
}

function normalizeCabin(input: unknown): Cabin {
  return input === "PREMIUM_ECONOMY" || input === "BUSINESS" || input === "FIRST"
    ? input
    : "ECONOMY";
}

function normalizeRequest(
  input: SearchPayload["request"] | undefined,
): SearchRequest {
  const tripType = normalizeTripType(input?.tripType);
  const searchMode = normalizeSearchMode(input?.searchMode);
  const flexibleMode = normalizeFlexibleMode(input?.flexibleMode);
  const leg: Record<string, unknown> = input?.legs?.[0] ?? {};
  const filters = input?.filters ?? {};

  const request: SearchRequest = {
    tripType,
    searchMode,
    flexibleMode,
    legs: [
      {
        origin: stringValue(leg.origin).toUpperCase(),
        destination: stringValue(leg.destination).toUpperCase(),
        originLabel: stringValue(leg.originLabel),
        destinationLabel: stringValue(leg.destinationLabel),
        departureDate: stringValue(leg.departureDate),
        departureStart: stringValue(leg.departureStart),
        departureEnd: stringValue(leg.departureEnd),
        returnDate: stringValue(leg.returnDate),
        returnStart: stringValue(leg.returnStart),
        returnEnd: stringValue(leg.returnEnd),
        stayNights: numberValue(leg.stayNights),
        minNights: numberValue(leg.minNights),
        maxNights: numberValue(leg.maxNights),
      },
    ],
    passengers: {
      adults: numberValue(input?.passengers?.adults, 1) ?? 1,
      children: numberValue(input?.passengers?.children, 0) ?? 0,
      infants: numberValue(input?.passengers?.infants, 0) ?? 0,
    },
    cabin: normalizeCabin(input?.cabin),
    filters: {
      nonStop: booleanValue(filters.nonStop, false),
      includedAirlineCodes: stringList(filters.includedAirlineCodes),
      excludedAirlineCodes: stringList(filters.excludedAirlineCodes),
      maxPrice: numberValue(filters.maxPrice),
      maxTotalDurationMinutes: numberValue(filters.maxTotalDurationMinutes),
      maxLayoverMinutes: numberValue(filters.maxLayoverMinutes),
      maxStops: numberValue(filters.maxStops),
      minDepartureMinutes: numberValue(filters.minDepartureMinutes),
      maxDepartureMinutes: numberValue(filters.maxDepartureMinutes),
      minArrivalMinutes: numberValue(filters.minArrivalMinutes),
      maxArrivalMinutes: numberValue(filters.maxArrivalMinutes),
      carryOnRequired: booleanValue(filters.carryOnRequired, false),
      checkedBaggageRequired: booleanValue(filters.checkedBaggageRequired, false),
      baggageRequired: booleanValue(filters.baggageRequired, false),
      verifiedOnly: booleanValue(filters.verifiedOnly, false),
      exactPurchasePathOnly: booleanValue(filters.exactPurchasePathOnly, false),
      exhaustiveResults: tripType === "one-way" && searchMode === "stay-range" ? true : undefined,
    },
    coverageMode: input?.coverageMode === "extended" ? "extended" : "core",
    redirectMode: input?.redirectMode === "none" || input?.redirectMode === "strict"
      ? input.redirectMode
      : "best-effort",
      currencyCode: stringValue(input?.currencyCode, "USD").toUpperCase(),
      locale: stringValue(input?.locale, "es-PE"),
      market: stringValue(input?.market, "PE"),
  };

  return normalizeFlexibleRoundTripRequest(request);
}

function validateRequest(request: SearchRequest): string[] {
  const leg = request.legs[0];
  const errors: string[] = [];
  const datePolicy = getSearchDatePolicy();
  const flexibleRoundTripMode = resolveFlexibleRoundTripMode(request);
  const dateFields: Array<[string, string | undefined]> = [
    ["Departure date", leg.departureDate],
    ["Return date", leg.returnDate],
    ["Departure start", leg.departureStart],
    ["Departure end", leg.departureEnd],
    ["Return start", leg.returnStart],
    ["Return end", leg.returnEnd],
  ];

  if (!leg.origin || leg.origin.length < 3) {
    errors.push("Origin is required and must be an IATA-like code.");
  }

  if (!leg.destination || leg.destination.length < 3) {
    errors.push("Destination is required and must be an IATA-like code.");
  }

  if (leg.origin && leg.destination && leg.origin === leg.destination) {
    errors.push("Origin and destination must be different.");
  }

  if (request.tripType === "multi-city") {
    errors.push("Multi-city search is not supported.");
  }

  if (!Number.isInteger(request.passengers.adults) || request.passengers.adults < 0) {
    errors.push("Adults must be a non-negative integer.");
  }

  if (!Number.isInteger(request.passengers.children) || request.passengers.children < 0) {
    errors.push("Children must be a non-negative integer.");
  }

  if (!Number.isInteger(request.passengers.infants) || request.passengers.infants < 0) {
    errors.push("Infants must be a non-negative integer.");
  }

  if (request.passengers.adults < 1) {
    errors.push("At least one adult is required.");
  }

  if (request.passengers.infants > request.passengers.adults) {
    errors.push("Infants cannot exceed adults.");
  }

  if (
    request.passengers.adults + request.passengers.children + request.passengers.infants > 9
  ) {
    errors.push("Passenger count cannot exceed 9.");
  }

  if (request.searchMode === "exact") {
    if (!leg.departureDate) {
      errors.push("Departure date is required for exact search.");
    }

    if (request.tripType === "round-trip" && !leg.returnDate) {
      errors.push("Return date is required for round-trip exact search.");
    }

    if (
      request.tripType === "round-trip"
      && leg.departureDate
      && leg.returnDate
      && leg.returnDate <= leg.departureDate
    ) {
      errors.push("Return date must be after departure date.");
    }

    if (
      request.tripType === "round-trip"
      && leg.departureDate
      && leg.returnDate
      && diffDays(leg.departureDate, leg.returnDate) > MAX_STAY_NIGHTS
    ) {
      errors.push(`Stay length cannot exceed ${MAX_STAY_NIGHTS} nights.`);
    }
  }

  if (request.searchMode === "roundtrip-grid") {
    if (!leg.departureStart || !leg.departureEnd) {
      errors.push("Departure range is required for matrix search.");
    }

    if (
      request.tripType === "round-trip" &&
      flexibleRoundTripMode !== "exact-stay" &&
      (!leg.returnStart || !leg.returnEnd)
    ) {
      errors.push("Return range is required for round-trip matrix search.");
    }

    if (
      request.tripType === "round-trip"
      && flexibleRoundTripMode === "exact-stay"
      && !Number.isFinite(leg.stayNights)
    ) {
      errors.push("Stay nights is required for exact-stay matrix search.");
    }

    if (
      request.tripType === "round-trip"
      && flexibleRoundTripMode === "exact-stay"
      && Number.isFinite(leg.stayNights)
      && (leg.stayNights as number) > MAX_STAY_NIGHTS
    ) {
      errors.push(`Stay length cannot exceed ${MAX_STAY_NIGHTS} nights.`);
    }

    if (
      request.tripType === "round-trip"
      && flexibleRoundTripMode === "fixed-ranges"
      && leg.departureStart
      && leg.departureEnd
      && leg.returnStart
      && leg.returnEnd
    ) {
      const estimatedCombinations = estimateRoundTripGridCombinations(
        leg.departureStart,
        leg.departureEnd,
        leg.returnStart,
        leg.returnEnd,
      );
      if (
        typeof estimatedCombinations === "number"
        && estimatedCombinations > MAX_ROUNDTRIP_GRID_COMBINATIONS
      ) {
        errors.push(
          `Round-trip matrix search cannot exceed ${MAX_ROUNDTRIP_GRID_COMBINATIONS} combinations. Narrow the departure or return ranges.`,
        );
      }
    }
  }

  if (request.searchMode === "stay-range") {
    if (!leg.departureStart || !leg.departureEnd) {
      errors.push("Departure range is required for range search.");
    }

    if (
      request.tripType === "round-trip" &&
      (!leg.returnStart || !leg.returnEnd)
    ) {
      errors.push("Return range is required for round-trip range search.");
    }
  }

  if (leg.departureStart && leg.departureEnd && leg.departureEnd < leg.departureStart) {
    errors.push("Departure range end must be on or after departure range start.");
  }

  if (leg.returnStart && leg.returnEnd && leg.returnEnd < leg.returnStart) {
    errors.push("Return range end must be on or after return range start.");
  }

  dateFields.forEach(([label, value]) => {
    errors.push(...validateSearchDateInPolicy(label, value, datePolicy));
  });

  return errors;
}


export function resolveSearchProviderIds(): ProviderId[] {
  return ["agil-local", "costamar"];
}

export function prepareSearchContract(
  payload: SearchPayload | undefined,
  options?: { forceRoundTripGrid?: boolean },
): PreparedSearchContract {
  const providerIds = resolveSearchProviderIds();
  const normalizedRequest = normalizeRequest(payload?.request);
  const request = options?.forceRoundTripGrid
    ? normalizeFlexibleRoundTripRequest({
      ...normalizedRequest,
      searchMode: "roundtrip-grid",
    })
    : normalizedRequest;

  return {
    providerIds,
    request,
  };
}

export function validateSearchContract(
  contract: PreparedSearchContract,
  _providerContext: ProviderContext | undefined,
  _options?: { skipProviderContext?: boolean },
): string[] {
  return validateRequest(contract.request);
}

export function resolveSortMode(mode: unknown): SortMode {
  if (mode === "cheapest" || mode === "fastest") {
    return mode;
  }

  return "cheapest";
}
