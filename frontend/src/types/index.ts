export interface LocationSuggestion {
  code: string
  city: string
  country: string
  countryCode?: string
  cityCode?: string
  searchType?: string
  providerId?: string
  providerIds?: string[]
  label: string
}

export interface SearchRequest {
  origin: string
  destination: string
  departureDate?: string
  departureStart?: string
  departureEnd?: string
  returnDate?: string
  returnStart?: string
  returnEnd?: string
  stayNights?: number
  tripType: "round-trip" | "one-way"
  adults: number
  children: number
  infants: number
  searchMode: "exact" | "stay-range" | "roundtrip-grid" | "month-view"
  flexibleMode?: "exact-stay" | "fixed-ranges"
  nonStop?: boolean
  maxStopsFilter?: string
  maxLayoverMinutes?: string
  baggageRequired?: boolean
  includedAirlineCodes?: string[]
  maxResults?: number
  compactAllOffers?: boolean
  sortMode?: string
}

export interface Segment {
  id?: string
  marketingCarrier?: string
  marketingCarrierName?: string
  operatingCarrier?: string
  operatingCarrierName?: string
  flightNumber?: string
  origin: string
  originName?: string
  destination: string
  destinationName?: string
  departureAt: string
  arrivalAt: string
  durationMinutes?: number
  originTerminal?: string
  destinationTerminal?: string
}

export interface Itinerary {
  id?: string
  direction: "outbound" | "inbound" | "multi"
  durationMinutes?: number
  stops?: number
  layoverMinutes?: number[]
  segments: Segment[]
}

export interface BaggageSummary {
  carryOnIncluded?: boolean
  checkedIncluded?: boolean
  checkedBags?: number
  description?: string
}

export interface FareMeta {
  lastTicketingDate?: string
  seatsRemaining?: number
  refundable?: boolean
  changeable?: boolean
  co2Kg?: number
}

export interface PurchasePath {
  id: string
  type: string
  provider: string
  label: string
  url?: string
  precision: "exact-offer" | "exact-search" | "broad-search" | "manual"
  score: number
  requiresNewTab: boolean
  commercialMode: string
  state: string
  referenceText?: string
  expiresAt?: string
  redirectVerification?: RedirectVerification
}

export interface RedirectVerification {
  provider: string
  state:
    | "missing"
    | "cached_unverified"
    | "near_expiry"
    | "refreshing"
    | "fresh_unverified"
    | "verified"
    | "refresh_failed"
    | "blocked"
  verified: boolean
  reason?: string
  checkedAt?: string
}

export interface ComparisonMetrics {
  totalDurationMinutes?: number
  totalStops?: number
  baggageScore?: number
  purchasePathScore?: number
}

export interface CanonicalOffer {
  id: string
  sourceOfferId?: string
  sourceSearchJobId?: string
  providerSource: string
  airline: string
  origin?: string
  destination?: string
  mainCarrier?: string
  validatingCarrier?: string
  providerOfferRef?: string
  itineraries?: Itinerary[]
  departureDate: string
  arrivalDate?: string
  returnDate?: string
  duration: string
  stops: number
  stopMeta?: string
  baggage?: BaggageSummary
  baggageLabel?: string
  hasCheckedBaggage?: boolean
  fareMeta?: FareMeta
  priceConfidence?: string
  priceStatus?: string
  purchasePaths?: PurchasePath[]
  redirectVerification?: RedirectVerification
  comparisonMetrics?: ComparisonMetrics
  tags?: string[]
  warnings?: string[]
  price: {
    total: { amount: number; currencyCode: string }
    base?: { amount: number; currencyCode: string }
    taxes?: { amount: number; currencyCode: string }
  }
}

export interface MigrationMonthSummary {
  key: string
  label: string
  departureStart: string
  departureEnd: string
  searchJobId?: string
  offer?: CanonicalOffer
  offers?: CanonicalOffer[]
  filtered?: boolean
  warnings?: string[]
  status: "loading" | "available" | "partial" | "empty" | "error"
}

export interface SearchResponse {
  offers: CanonicalOffer[]
  allOffers?: CanonicalOffer[]
  searchMeta: {
    requestedAt: string
    completedAt: string
    providersUsed: string[]
    warnings: string[]
    partial: boolean
    searchState: string
  }
  providerMeta: {
    exactProvider: string
    coverageMode: string
  }
  warnings: string[]
  providerDiagnostics?: ProviderDiagnostics[]
}

export interface SearchJobResponse extends SearchResponse {
  searchJobId: string
  searchComplete: boolean
  searchStatus: string
  revision: number
  sortMode: string
  request: SearchRequest
  migrationMonths?: MigrationMonthSummary[]
  diagnosticLog?: string[]
  unchanged?: boolean
}

export interface ProviderDiagnosticEvent {
  name: string
  at: string
  elapsedMs?: number
  detail?: string
}

export interface ProviderDiagnostics {
  providerId: string
  kind: "exact" | "range" | "matrix"
  status: "queued" | "running" | "completed" | "failed"
  events: ProviderDiagnosticEvent[]
  offers?: number
  warningCount?: number
  error?: string
}

export interface MatrixCell {
  key: string
  departureDate: string
  returnDate?: string
  stayNights?: number
  price?: {
    amount: number
    currencyCode: string
  }
  variantKey?: string
  confidence: string
  providerSource: string
  selectable: boolean
  requiresRequery: boolean
  stateCode: string
  tooltip?: string
  purchasePaths?: PurchasePath[]
  offer?: CanonicalOffer
}

export type SortMode = "cheapest" | "fastest"

export type ResultsLayoutColumnKey =
  | "carrier"
  | "dates"
  | "duration"
  | "stops"
  | "price"
  | "links"

export type ResultsColumnLayout = Record<ResultsLayoutColumnKey, number>

export interface ResultsLayout {
  version: number
  savedAt: string
  columns: ResultsColumnLayout
}
