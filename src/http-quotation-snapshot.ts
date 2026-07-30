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

function normalizeProviderSource(value: unknown): ProviderId | undefined {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized.includes("costamar")) return "costamar";
  if (normalized.includes("agil")) return "agil-local";
  return undefined;
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
        originCountryCode: quotationStringValue(rawLeg.originCountryCode)?.toUpperCase(),
        destinationCountryCode: quotationStringValue(rawLeg.destinationCountryCode)?.toUpperCase(),
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

function normalizeQuotationSegment(input: unknown, idSeed: string): Segment | undefined {
  const raw = quotationObjectRecord(input);
  const origin = quotationStringValue(raw?.origin);
  const destination = quotationStringValue(raw?.destination);
  const departureAt = quotationStringValue(raw?.departureAt);
  const arrivalAt = quotationStringValue(raw?.arrivalAt);
  if (!raw || !origin || !destination || !departureAt || !arrivalAt) {
    return undefined;
  }

  return {
    id: quotationStringValue(raw.id) ?? idSeed,
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

function normalizeQuotationItineraries(input: unknown, request: SearchRequest): Itinerary[] {
  if (!Array.isArray(input) || input.length === 0) return [];

  const normalized = input.map((item, index): Itinerary | undefined => {
    const raw = quotationObjectRecord(item);
    if (!raw) return undefined;

    const direction = raw.direction === "outbound" || raw.direction === "inbound" || raw.direction === "multi"
      ? raw.direction
      : undefined;
    const rawSegments = Array.isArray(raw.segments) ? raw.segments : [];
    if (!direction || rawSegments.length === 0) return undefined;

    const segments = rawSegments.map((segment, segmentIndex) =>
      normalizeQuotationSegment(segment, `itinerary-${index}-segment-${segmentIndex}`));
    if (segments.some((segment) => !segment)) return undefined;
    const completeSegments = segments as Segment[];

    return {
      id: quotationStringValue(raw.id) ?? `itinerary-${index}`,
      direction,
      durationMinutes: Math.max(0, Math.round(quotationNumberValue(raw.durationMinutes) ?? 0)),
      stops: Math.max(0, Math.round(quotationNumberValue(raw.stops) ?? Math.max(0, completeSegments.length - 1))),
      layoverMinutes: Array.isArray(raw.layoverMinutes)
        ? raw.layoverMinutes.map((value) => Math.max(0, Math.round(quotationNumberValue(value) ?? 0)))
        : [],
      segments: completeSegments,
    };
  });

  if (normalized.some((itinerary) => !itinerary)) return [];
  const complete = normalized as Itinerary[];
  if (request.tripType === "one-way") {
    return complete.some((itinerary) => itinerary.direction === "outbound") ? complete : [];
  }
  if (request.tripType === "round-trip") {
    return complete.some((itinerary) => itinerary.direction === "outbound")
      && complete.some((itinerary) => itinerary.direction === "inbound")
      ? complete
      : [];
  }
  return complete;
}

export function normalizeQuotationOfferSnapshot(input: unknown, request: SearchRequest): CanonicalOffer | undefined {
  const offer = quotationObjectRecord(input);
  if (!offer) {
    return undefined;
  }

  const rawPrice = quotationObjectRecord(offer.price);
  const rawTotal = quotationObjectRecord(rawPrice?.total) ?? rawPrice;
  const amount = quotationNumberValue(rawTotal?.amount);
  const currencyCode = quotationStringValue(rawTotal?.currencyCode);
  const offerId = quotationStringValue(offer.sourceOfferId) ?? quotationStringValue(offer.id);
  const providerSource = normalizeProviderSource(offer.providerSource);
  const itineraries = normalizeQuotationItineraries(offer.itineraries, request);
  if (amount === undefined || amount <= 0 || !currencyCode || !offerId || !providerSource || itineraries.length === 0) {
    return undefined;
  }

  const mainCarrier = quotationStringValue(offer.mainCarrier)
    ?? quotationStringValue(offer.validatingCarrier)
    ?? quotationStringValue(offer.airline)
    ?? "";
  const rawBaggage = quotationObjectRecord(offer.baggage);
  const rawFareMeta = quotationObjectRecord(offer.fareMeta);
  const rawMetrics = quotationObjectRecord(offer.comparisonMetrics);
  const totalStops = itineraries.reduce((sum, itinerary) => sum + itinerary.stops, 0);
  const outbound = itineraries.find((itinerary) => itinerary.direction === "outbound") ?? itineraries[0];
  const firstSegment = outbound.segments[0];
  const lastSegment = outbound.segments[outbound.segments.length - 1];

  return {
    id: offerId,
    signature: quotationStringValue(offer.signature) ?? offerId,
    providerSource,
    providerOfferRef: quotationStringValue(offer.providerOfferRef) ?? offerId,
    tripType: request.tripType,
    validatingCarrier: quotationStringValue(offer.validatingCarrier) ?? mainCarrier,
    mainCarrier,
    origin: quotationStringValue(offer.origin) ?? firstSegment.origin,
    destination: quotationStringValue(offer.destination) ?? lastSegment.destination,
    itineraries,
    price: {
      total: {
        amount,
        currencyCode,
      },
      base: quotationObjectRecord(rawPrice?.base)
        && quotationNumberValue(quotationObjectRecord(rawPrice?.base)?.amount) !== undefined
        ? {
            amount: quotationNumberValue(quotationObjectRecord(rawPrice?.base)?.amount)!,
            currencyCode: quotationStringValue(quotationObjectRecord(rawPrice?.base)?.currencyCode) ?? currencyCode,
          }
        : undefined,
      taxes: quotationObjectRecord(rawPrice?.taxes)
        && quotationNumberValue(quotationObjectRecord(rawPrice?.taxes)?.amount) !== undefined
        ? {
            amount: quotationNumberValue(quotationObjectRecord(rawPrice?.taxes)?.amount)!,
            currencyCode: quotationStringValue(quotationObjectRecord(rawPrice?.taxes)?.currencyCode) ?? currencyCode,
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
      totalStops,
      baggageScore: Math.max(0, Math.round(quotationNumberValue(rawMetrics?.baggageScore) ?? 0)),
      purchasePathScore: Math.max(0, Math.round(quotationNumberValue(rawMetrics?.purchasePathScore) ?? 0)),
    },
    tags: quotationStringArrayValue(offer.tags),
    warnings: quotationStringArrayValue(offer.warnings),
    rawRefs: quotationObjectRecord(offer.rawRefs),
  };
}
