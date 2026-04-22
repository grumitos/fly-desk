import { BaggageSummary, CanonicalOffer, Itinerary, Segment } from "./types";

interface VariantGroupKeyInput {
  mainCarrier?: string;
  validatingCarrier?: string;
  totalAmount?: number;
  currencyCode?: string;
  totalDurationMinutes?: number;
  totalStops?: number;
  baggage?: BaggageSummary;
  itineraries?: Itinerary[];
}

export interface FlexibleVariantGroupKeyInput {
  mainCarrier?: string;
  validatingCarrier?: string;
  totalAmount: number;
  currencyCode: string;
  itineraries: Itinerary[];
  baggage?: BaggageSummary;
  totalDurationMinutes?: number;
  totalStops?: number;
}

function normalizeToken(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeAmount(amount: unknown): string {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) {
    return "0.00";
  }

  return numeric.toFixed(2);
}

function timeOfIso(iso: unknown): string {
  return typeof iso === "string" ? iso.slice(11, 16) : "";
}

function segmentVariantPatternKey(segment: Segment): string {
  return [
    normalizeToken(segment.marketingCarrier),
    normalizeToken(segment.flightNumber).replace(/\s+/g, ""),
    normalizeToken(segment.origin),
    normalizeToken(segment.destination),
    timeOfIso(segment.departureAt),
    timeOfIso(segment.arrivalAt),
    String(segment.durationMinutes ?? ""),
  ].join("|");
}

function itineraryVariantPatternKey(itinerary: Itinerary): string {
  return [
    String(itinerary.direction ?? "").trim().toLowerCase(),
    String(itinerary.durationMinutes ?? ""),
    String(itinerary.stops ?? ""),
    (itinerary.segments ?? []).map((segment) => segmentVariantPatternKey(segment)).join("~"),
  ].join("::");
}

function totalDurationMinutesFromItineraries(itineraries: Itinerary[]): number {
  return itineraries.reduce((sum, itinerary) => sum + (Number(itinerary.durationMinutes) || 0), 0);
}

function totalStopsFromItineraries(itineraries: Itinerary[]): number {
  return itineraries.reduce((sum, itinerary) => sum + (Number(itinerary.stops) || 0), 0);
}

function baggageFlag(value: boolean | undefined): string {
  if (value === true) return "1";
  if (value === false) return "0";
  return "u";
}

function buildVariantGroupKey(input: VariantGroupKeyInput): string {
  const itineraries = input.itineraries ?? [];
  const duration = Number.isFinite(Number(input.totalDurationMinutes))
    ? Number(input.totalDurationMinutes)
    : totalDurationMinutesFromItineraries(itineraries);
  const stops = Number.isFinite(Number(input.totalStops))
    ? Number(input.totalStops)
    : totalStopsFromItineraries(itineraries);
  const itineraryPatterns = itineraries
    .map((itinerary) => itineraryVariantPatternKey(itinerary))
    .join("||");

  return [
    normalizeToken(input.mainCarrier || input.validatingCarrier),
    normalizeAmount(input.totalAmount),
    normalizeToken(input.currencyCode),
    String(duration),
    String(stops),
    baggageFlag(input.baggage?.carryOnIncluded),
    baggageFlag(input.baggage?.checkedIncluded),
    itineraryPatterns,
  ].join("##");
}

export function buildOfferVariantGroupKey(offer: CanonicalOffer): string {
  return buildVariantGroupKey({
    mainCarrier: offer.mainCarrier,
    validatingCarrier: offer.validatingCarrier,
    totalAmount: offer.price?.total?.amount,
    currencyCode: offer.price?.total?.currencyCode,
    totalDurationMinutes: offer.comparisonMetrics?.totalDurationMinutes,
    totalStops: offer.comparisonMetrics?.totalStops,
    baggage: offer.baggage,
    itineraries: offer.itineraries,
  });
}

export function buildFlexibleVariantGroupKey(input: FlexibleVariantGroupKeyInput): string {
  return buildVariantGroupKey({
    mainCarrier: input.mainCarrier,
    validatingCarrier: input.validatingCarrier,
    totalAmount: input.totalAmount,
    currencyCode: input.currencyCode,
    totalDurationMinutes: input.totalDurationMinutes,
    totalStops: input.totalStops,
    baggage: input.baggage,
    itineraries: input.itineraries,
  });
}
