export type TripType = "one-way" | "round-trip" | "multi-city";
export type SearchMode = "exact" | "stay-range" | "roundtrip-grid" | "month-view";
export type FlexibleRoundTripMode = "exact-stay" | "fixed-ranges";
export type Cabin =
  | "ECONOMY"
  | "PREMIUM_ECONOMY"
  | "BUSINESS"
  | "FIRST";

export type ProviderId = "agil-local" | "costamar";

export type SearchState =
  | "search_live"
  | "search_cached"
  | "search_partial"
  | "search_cancelled"
  | "search_failed";

export type PriceConfidence =
  | "indicative"
  | "live"
  | "validated"
  | "landing-page"
  | "stale";

export type OfferPriceStatus =
  | "unverified"
  | "verified"
  | "stale";

export type PurchasePathType =
  | "api-booking"
  | "deeplink"
  | "search-redirect"
  | "calendar-redirect"
  | "manual-reference"
  | "gds-command";

export type PurchasePathState =
  | "none"
  | "manual"
  | "search_redirect"
  | "deeplink_exact"
  | "api_bookable";

export interface PassengerMix {
  adults: number;
  children: number;
  infants: number;
}

export type BookingPassengerKind = "adult" | "child" | "infant_without_seat";
export type BookingPassengerTitle = "mr" | "mrs" | "ms" | "miss" | "mx";
export type BookingPassengerGender = "m" | "f" | "x";

export interface BookingContact {
  email: string;
  phoneNumber: string;
}

export interface BookingPassengerInput {
  kind: BookingPassengerKind;
  givenName: string;
  familyName: string;
  bornOn: string;
  title: BookingPassengerTitle;
  gender: BookingPassengerGender;
  email?: string;
  phoneNumber?: string;
  infantResponsibleAdultIndex?: number;
}

export interface CreateOrderInput {
  type: "instant" | "hold";
  contact: BookingContact;
  passengers: BookingPassengerInput[];
}

export interface OrderResult {
  orderId: string;
  bookingReference?: string;
  type: "instant" | "hold";
  liveMode?: boolean;
  totalAmount?: string;
  totalCurrency?: string;
  paymentStatus?: string;
  paymentRequiredBy?: string;
  ownerName?: string;
  passengerNames: string[];
  raw: Record<string, unknown>;
}

export interface SearchLeg {
  origin: string;
  destination: string;
  originLabel?: string;
  destinationLabel?: string;
  departureDate?: string;
  departureStart?: string;
  departureEnd?: string;
  returnDate?: string;
  returnStart?: string;
  returnEnd?: string;
  stayNights?: number;
  minNights?: number;
  maxNights?: number;
}

export interface SearchFilters {
  nonStop?: boolean;
  maxStops?: number;
  includedAirlineCodes?: string[];
  excludedAirlineCodes?: string[];
  maxPrice?: number;
  currencyCode?: string;
  maxResults?: number;
  compactAllOffers?: boolean;
  maxTotalDurationMinutes?: number;
  maxLayoverMinutes?: number;
  minDepartureMinutes?: number;
  maxDepartureMinutes?: number;
  minArrivalMinutes?: number;
  maxArrivalMinutes?: number;
  baggageRequired?: boolean;
  verifiedOnly?: boolean;
  exactPurchasePathOnly?: boolean;
}

export interface CostamarProviderConfigInput {
  terminalId?: string;
  token?: string;
  lang?: string;
}

export interface ProviderConfigInput {
  costamar?: CostamarProviderConfigInput;
}

export interface CostamarProviderContext {
  apiBaseUrl: string;
  brandBaseUrl: string;
  terminalId: string;
  token: string;
  lang: string;
}

export interface ProviderContext {
  costamar?: CostamarProviderContext;
}

export interface LocationSuggestion {
  code: string;
  city: string;
  country: string;
  countryCode?: string;
  cityCode?: string;
  searchType?: string;
  label: string;
}

export interface SearchRequest {
  providerId?: ProviderId;
  tripType: TripType;
  searchMode: SearchMode;
  flexibleMode?: FlexibleRoundTripMode;
  legs: SearchLeg[];
  passengers: PassengerMix;
  cabin: Cabin;
  filters: SearchFilters;
  coverageMode: "core" | "extended";
  redirectMode: "none" | "best-effort" | "strict";
  currencyCode: string;
  locale?: string;
  market?: string;
}

export interface Money {
  amount: number;
  currencyCode: string;
}

export interface Segment {
  id: string;
  marketingCarrier: string;
  marketingCarrierName?: string;
  operatingCarrier?: string;
  operatingCarrierName?: string;
  flightNumber: string;
  origin: string;
  originName?: string;
  destination: string;
  destinationName?: string;
  departureAt: string;
  arrivalAt: string;
  durationMinutes: number;
  originTerminal?: string;
  destinationTerminal?: string;
}

export interface Itinerary {
  id: string;
  direction: "outbound" | "inbound" | "multi";
  durationMinutes: number;
  stops: number;
  layoverMinutes: number[];
  segments: Segment[];
}

export interface BaggageSummary {
  carryOnIncluded?: boolean;
  checkedIncluded?: boolean;
  checkedBags?: number;
  description?: string;
}

export interface FareMeta {
  lastTicketingDate?: string;
  seatsRemaining?: number;
  refundable?: boolean;
  changeable?: boolean;
  co2Kg?: number;
}

export interface ComparisonMetrics {
  totalDurationMinutes: number;
  totalStops: number;
  baggageScore: number;
  purchasePathScore: number;
}

export interface PurchasePath {
  id: string;
  type: PurchasePathType;
  provider: ProviderId;
  label: string;
  url?: string;
  precision: "exact-offer" | "exact-search" | "broad-search" | "manual";
  score: number;
  requiresNewTab: boolean;
  commercialMode: "internal" | "affiliate" | "provider" | "manual";
  state: PurchasePathState;
  referenceText?: string;
  expiresAt?: string;
}

export interface CanonicalOffer {
  id: string;
  signature: string;
  providerSource: ProviderId;
  providerOfferRef: string;
  tripType: TripType;
  validatingCarrier?: string;
  mainCarrier?: string;
  origin: string;
  destination: string;
  itineraries: Itinerary[];
  price: {
    total: Money;
    base?: Money;
    taxes?: Money;
  };
  usdToPenRate?: number;
  baggage?: BaggageSummary;
  fareMeta?: FareMeta;
  priceConfidence: PriceConfidence;
  priceStatus: OfferPriceStatus;
  priceVerifiedAt?: string;
  purchasePaths: PurchasePath[];
  comparisonMetrics: ComparisonMetrics;
  tags: string[];
  warnings: string[];
  rawRefs?: Record<string, unknown>;
  valueScore: number;
}

export interface MatrixCell {
  key: string;
  departureDate: string;
  returnDate?: string;
  stayNights?: number;
  price?: Money;
  variantKey?: string;
  confidence: PriceConfidence | "loading" | "empty" | "unavailable";
  providerSource: ProviderId;
  selectable: boolean;
  requiresRequery: boolean;
  stateCode: "ind" | "live" | "ok" | "chg" | "emp";
  tooltip?: string;
  derivedRequest?: SearchRequest;
  purchasePaths?: PurchasePath[];
}

export interface SearchMeta {
  requestedAt: string;
  completedAt: string;
  providersUsed: ProviderId[];
  warnings: string[];
  partial: boolean;
  searchState: SearchState;
  searchSessionId?: string;
}

export interface ProviderMeta {
  exactProvider: ProviderId;
  redirectProvider?: ProviderId;
  coverageMode: SearchRequest["coverageMode"];
}

export interface SearchResponse {
  offers: CanonicalOffer[];
  allOffers?: CanonicalOffer[];
  matrix?: MatrixCell[];
  searchMeta: SearchMeta;
  providerMeta: ProviderMeta;
  warnings: string[];
}

export interface MatrixResponse {
  cells: MatrixCell[];
  axes: {
    departureDates: string[];
    returnDates: string[];
  };
  confidenceSummary: Record<string, number>;
  recommendations: string[];
  searchMeta: SearchMeta;
  providerMeta: ProviderMeta;
  warnings: string[];
}
