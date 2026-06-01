import { normalizeAirlineDisplayName } from "./core/airline-names";
import type {
  CanonicalOffer,
  Itinerary,
  ProviderId,
  SearchRequest,
  Segment,
} from "./core/types";

function quotationObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function quotationStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function quotationNumberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function quotationBoolValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function quotationStringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
}

function normalizeProviderSource(value: unknown): ProviderId {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized.includes("costamar") ? "costamar" : "agil-local";
}

function normalizeTripType(value: unknown): SearchRequest["tripType"] {
  return value === "one-way" || value === "multi-city" ? value : "round-trip";
}

function normalizeSearchMode(value: unknown): SearchRequest["searchMode"] {
  return value === "stay-range" || value === "roundtrip-grid" || value === "month-view"
    ? value
    : "exact";
}

function normalizeCabin(value: unknown): SearchRequest["cabin"] {
  return value === "PREMIUM_ECONOMY" || value === "BUSINESS" || value === "FIRST"
    ? value
    : "ECONOMY";
}

export function normalizeQuotationRequestSnapshot(input: unknown, offerInput?: unknown): SearchRequest | undefined {
  const payload = quotationObjectRecord(input);
  const offer = quotationObjectRecord(offerInput);
  const rawLegs = Array.isArray(payload?.legs) ? payload.legs : [];
  const rawLeg = quotationObjectRecord(rawLegs[0]) ?? {};
  const origin = quotationStringValue(rawLeg.origin) ?? quotationStringValue(offer?.origin);
  const destination = quotationStringValue(rawLeg.destination) ?? quotationStringValue(offer?.destination);

  if (!origin || !destination) {
    return undefined;
  }

  const rawPassengers = quotationObjectRecord(payload?.passengers);
  const rawFilters = quotationObjectRecord(payload?.filters);
  const tripType = normalizeTripType(payload?.tripType);

  return {
    providerId: payload?.providerId ? normalizeProviderSource(payload.providerId) : undefined,
    tripType,
    searchMode: normalizeSearchMode(payload?.searchMode),
    flexibleMode: payload?.flexibleMode === "exact-stay" || payload?.flexibleMode === "fixed-ranges"
      ? payload.flexibleMode
      : undefined,
    legs: [
      {
        origin,
        destination,
        originLabel: quotationStringValue(rawLeg.originLabel),
        destinationLabel: quotationStringValue(rawLeg.destinationLabel),
        departureDate: quotationStringValue(rawLeg.departureDate) ?? quotationStringValue(offer?.departureDate)?.slice(0, 10),
        departureStart: quotationStringValue(rawLeg.departureStart),
        departureEnd: quotationStringValue(rawLeg.departureEnd),
        returnDate: tripType === "round-trip"
          ? quotationStringValue(rawLeg.returnDate) ?? quotationStringValue(offer?.returnDate)?.slice(0, 10)
          : undefined,
        returnStart: quotationStringValue(rawLeg.returnStart),
        returnEnd: quotationStringValue(rawLeg.returnEnd),
        stayNights: quotationNumberValue(rawLeg.stayNights),
        minNights: quotationNumberValue(rawLeg.minNights),
        maxNights: quotationNumberValue(rawLeg.maxNights),
      },
    ],
    passengers: {
      adults: Math.max(1, Math.round(quotationNumberValue(rawPassengers?.adults) ?? 1)),
      children: Math.max(0, Math.round(quotationNumberValue(rawPassengers?.children) ?? 0)),
      infants: Math.max(0, Math.round(quotationNumberValue(rawPassengers?.infants) ?? 0)),
    },
    cabin: normalizeCabin(payload?.cabin),
    filters: {
      nonStop: quotationBoolValue(rawFilters?.nonStop),
      maxStops: quotationNumberValue(rawFilters?.maxStops),
      includedAirlineCodes: quotationStringArrayValue(rawFilters?.includedAirlineCodes),
      excludedAirlineCodes: quotationStringArrayValue(rawFilters?.excludedAirlineCodes),
      maxPrice: quotationNumberValue(rawFilters?.maxPrice),
      currencyCode: quotationStringValue(rawFilters?.currencyCode),
      maxResults: quotationNumberValue(rawFilters?.maxResults),
      compactAllOffers: quotationBoolValue(rawFilters?.compactAllOffers),
      exhaustiveResults: quotationBoolValue(rawFilters?.exhaustiveResults),
      maxTotalDurationMinutes: quotationNumberValue(rawFilters?.maxTotalDurationMinutes),
      maxLayoverMinutes: quotationNumberValue(rawFilters?.maxLayoverMinutes),
      minDepartureMinutes: quotationNumberValue(rawFilters?.minDepartureMinutes),
      maxDepartureMinutes: quotationNumberValue(rawFilters?.maxDepartureMinutes),
      minArrivalMinutes: quotationNumberValue(rawFilters?.minArrivalMinutes),
      maxArrivalMinutes: quotationNumberValue(rawFilters?.maxArrivalMinutes),
      carryOnRequired: quotationBoolValue(rawFilters?.carryOnRequired),
      checkedBaggageRequired: quotationBoolValue(rawFilters?.checkedBaggageRequired),
      baggageRequired: quotationBoolValue(rawFilters?.baggageRequired),
      verifiedOnly: quotationBoolValue(rawFilters?.verifiedOnly),
      exactPurchasePathOnly: quotationBoolValue(rawFilters?.exactPurchasePathOnly),
    },
    coverageMode: payload?.coverageMode === "extended" ? "extended" : "core",
    redirectMode: payload?.redirectMode === "strict" || payload?.redirectMode === "best-effort"
      ? payload.redirectMode
      : "none",
    currencyCode: quotationStringValue(payload?.currencyCode) ?? "USD",
    locale: quotationStringValue(payload?.locale) ?? "es-PE",
    market: quotationStringValue(payload?.market) ?? "PE",
  };
}

function normalizeQuotationSegment(input: unknown, fallback: {
  direction: "outbound" | "inbound";
  origin: string;
  destination: string;
  departureAt?: string;
}): Segment {
  const raw = quotationObjectRecord(input) ?? {};
  const origin = quotationStringValue(raw.origin) ?? fallback.origin;
  const destination = quotationStringValue(raw.destination) ?? fallback.destination;
  const departureAt = quotationStringValue(raw.departureAt) ?? fallback.departureAt ?? "";
  const arrivalAt = quotationStringValue(raw.arrivalAt) ?? departureAt;

  return {
    id: quotationStringValue(raw.id) ?? `${fallback.direction}-segment`,
    marketingCarrier: quotationStringValue(raw.marketingCarrier) ?? "",
    marketingCarrierName: normalizeAirlineDisplayName(raw.marketingCarrierName) || undefined,
    operatingCarrier: quotationStringValue(raw.operatingCarrier),
    operatingCarrierName: normalizeAirlineDisplayName(raw.operatingCarrierName) || undefined,
    flightNumber: quotationStringValue(raw.flightNumber) ?? "",
    origin,
    originName: quotationStringValue(raw.originName),
    destination,
    destinationName: quotationStringValue(raw.destinationName),
    departureAt,
    arrivalAt,
    durationMinutes: Math.max(0, Math.round(quotationNumberValue(raw.durationMinutes) ?? 0)),
    originTerminal: quotationStringValue(raw.originTerminal),
    destinationTerminal: quotationStringValue(raw.destinationTerminal),
  };
}

function normalizeQuotationItineraries(input: unknown, request: SearchRequest, offer: Record<string, unknown>): Itinerary[] {
  const leg = request.legs[0];
  const rawItineraries = Array.isArray(input) ? input : [];
  const normalized = rawItineraries.flatMap((item, index): Itinerary[] => {
    const raw = quotationObjectRecord(item);
    if (!raw) {
      return [];
    }

    const direction = raw.direction === "inbound" || raw.direction === "multi" ? raw.direction : "outbound";
    const rawSegments = Array.isArray(raw.segments) ? raw.segments : [];
    const fallback = {
      direction: direction === "inbound" ? "inbound" as const : "outbound" as const,
      origin: direction === "inbound" ? leg.destination : leg.origin,
      destination: direction === "inbound" ? leg.origin : leg.destination,
      departureAt: direction === "inbound"
        ? quotationStringValue(offer.returnDate) ?? leg.returnDate
        : quotationStringValue(offer.departureDate) ?? leg.departureDate,
    };
    const segments = rawSegments.length > 0
      ? rawSegments.map((segment) => normalizeQuotationSegment(segment, fallback))
      : [normalizeQuotationSegment(undefined, fallback)];

    return [{
      id: quotationStringValue(raw.id) ?? `itinerary-${index}`,
      direction,
      durationMinutes: Math.max(0, Math.round(quotationNumberValue(raw.durationMinutes) ?? 0)),
      stops: Math.max(0, Math.round(quotationNumberValue(raw.stops) ?? Math.max(0, segments.length - 1))),
      layoverMinutes: Array.isArray(raw.layoverMinutes)
        ? raw.layoverMinutes.map((value) => Math.max(0, Math.round(quotationNumberValue(value) ?? 0)))
        : [],
      segments,
    }];
  });

  if (normalized.length > 0) {
    return normalized;
  }

  const outboundDeparture = quotationStringValue(offer.departureDate) ?? leg.departureDate ?? leg.departureStart ?? "";
  const outbound = normalizeQuotationSegment(undefined, {
    direction: "outbound",
    origin: leg.origin,
    destination: leg.destination,
    departureAt: outboundDeparture,
  });
  const itineraries: Itinerary[] = [{
    id: "outbound",
    direction: "outbound",
    durationMinutes: 0,
    stops: 0,
    layoverMinutes: [],
    segments: [outbound],
  }];

  const returnDeparture = quotationStringValue(offer.returnDate) ?? leg.returnDate ?? leg.returnStart;
  if (request.tripType === "round-trip" && returnDeparture) {
    const inbound = normalizeQuotationSegment(undefined, {
      direction: "inbound",
      origin: leg.destination,
      destination: leg.origin,
      departureAt: returnDeparture,
    });
    itineraries.push({
      id: "inbound",
      direction: "inbound",
      durationMinutes: 0,
      stops: 0,
      layoverMinutes: [],
      segments: [inbound],
    });
  }

  return itineraries;
}

export function normalizeQuotationOfferSnapshot(input: unknown, request: SearchRequest): CanonicalOffer | undefined {
  const offer = quotationObjectRecord(input);
  if (!offer) {
    return undefined;
  }

  const rawPrice = quotationObjectRecord(offer.price);
  const rawTotal = quotationObjectRecord(rawPrice?.total) ?? rawPrice;
  const amount = quotationNumberValue(rawTotal?.amount);
  if (amount === undefined) {
    return undefined;
  }

  const providerSource = normalizeProviderSource(offer.providerSource);
  const mainCarrier = quotationStringValue(offer.mainCarrier)
    ?? quotationStringValue(offer.validatingCarrier)
    ?? quotationStringValue(offer.airline)
    ?? "";
  const itineraries = normalizeQuotationItineraries(offer.itineraries, request, offer);
  const rawBaggage = quotationObjectRecord(offer.baggage);
  const rawFareMeta = quotationObjectRecord(offer.fareMeta);
  const rawMetrics = quotationObjectRecord(offer.comparisonMetrics);
  const totalStops = quotationNumberValue(rawMetrics?.totalStops) ?? quotationNumberValue(offer.stops) ?? 0;

  return {
    id: quotationStringValue(offer.sourceOfferId) ?? quotationStringValue(offer.id) ?? "selected-offer",
    signature: quotationStringValue(offer.signature) ?? quotationStringValue(offer.id) ?? "selected-offer",
    providerSource,
    providerOfferRef: quotationStringValue(offer.providerOfferRef) ?? quotationStringValue(offer.id) ?? "selected-offer",
    tripType: request.tripType,
    validatingCarrier: quotationStringValue(offer.validatingCarrier) ?? mainCarrier,
    mainCarrier,
    origin: quotationStringValue(offer.origin) ?? request.legs[0].origin,
    destination: quotationStringValue(offer.destination) ?? request.legs[0].destination,
    itineraries,
    price: {
      total: {
        amount,
        currencyCode: quotationStringValue(rawTotal?.currencyCode) ?? request.currencyCode ?? "USD",
      },
      base: quotationObjectRecord(rawPrice?.base)
        ? {
            amount: quotationNumberValue(quotationObjectRecord(rawPrice?.base)?.amount) ?? amount,
            currencyCode: quotationStringValue(quotationObjectRecord(rawPrice?.base)?.currencyCode) ?? quotationStringValue(rawTotal?.currencyCode) ?? "USD",
          }
        : undefined,
      taxes: quotationObjectRecord(rawPrice?.taxes)
        ? {
            amount: quotationNumberValue(quotationObjectRecord(rawPrice?.taxes)?.amount) ?? 0,
            currencyCode: quotationStringValue(quotationObjectRecord(rawPrice?.taxes)?.currencyCode) ?? quotationStringValue(rawTotal?.currencyCode) ?? "USD",
          }
        : undefined,
    },
    usdToPenRate: quotationNumberValue(offer.usdToPenRate),
    baggage: rawBaggage
      ? {
          carryOnIncluded: quotationBoolValue(rawBaggage.carryOnIncluded),
          checkedIncluded: quotationBoolValue(rawBaggage.checkedIncluded),
          checkedBags: quotationNumberValue(rawBaggage.checkedBags),
          description: quotationStringValue(rawBaggage.description),
        }
      : undefined,
    fareMeta: rawFareMeta
      ? {
          lastTicketingDate: quotationStringValue(rawFareMeta.lastTicketingDate),
          seatsRemaining: quotationNumberValue(rawFareMeta.seatsRemaining),
          refundable: quotationBoolValue(rawFareMeta.refundable),
          changeable: quotationBoolValue(rawFareMeta.changeable),
          co2Kg: quotationNumberValue(rawFareMeta.co2Kg),
        }
      : undefined,
    priceConfidence: offer.priceConfidence === "indicative"
      || offer.priceConfidence === "validated"
      || offer.priceConfidence === "landing-page"
      || offer.priceConfidence === "stale"
      ? offer.priceConfidence
      : "live",
    priceStatus: offer.priceStatus === "verified" || offer.priceStatus === "stale" ? offer.priceStatus : "unverified",
    priceVerifiedAt: quotationStringValue(offer.priceVerifiedAt),
    purchasePaths: [],
    comparisonMetrics: {
      totalDurationMinutes: Math.max(0, Math.round(quotationNumberValue(rawMetrics?.totalDurationMinutes) ?? 0)),
      totalStops: Math.max(0, Math.round(totalStops)),
      baggageScore: Math.max(0, Math.round(quotationNumberValue(rawMetrics?.baggageScore) ?? 0)),
      purchasePathScore: Math.max(0, Math.round(quotationNumberValue(rawMetrics?.purchasePathScore) ?? 0)),
    },
    tags: quotationStringArrayValue(offer.tags),
    warnings: quotationStringArrayValue(offer.warnings),
    rawRefs: quotationObjectRecord(offer.rawRefs),
  };
}
