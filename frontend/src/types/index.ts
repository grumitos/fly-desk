import type {
  BaggageSummary as CoreBaggageSummary,
  CanonicalOffer as CoreCanonicalOffer,
  ComparisonMetrics as CoreComparisonMetrics,
  FareMeta as CoreFareMeta,
  Itinerary as CoreItinerary,
  LocationSuggestion as CoreLocationSuggestion,
  MatrixCell as CoreMatrixCell,
  ProviderDiagnostics as CoreProviderDiagnostics,
  ProviderId,
  PurchasePath as CorePurchasePath,
  RedirectVerification as CoreRedirectVerification,
  SearchMode,
  SearchRequest as CoreSearchRequest,
  SearchResponse as CoreSearchResponse,
  Segment as CoreSegment,
} from "../../../src/core/types"

type OpenString<T extends string> = T | (string & {})

export type LocationSuggestion = CoreLocationSuggestion & {
  providerId?: string
  providerIds?: string[]
}

// Frontend-only: flat form/share state converted to the core SearchRequest in lib/api.ts.
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
  tripType: Extract<CoreSearchRequest["tripType"], "round-trip" | "one-way">
  adults: number
  children: number
  infants: number
  searchMode: SearchMode
  flexibleMode?: CoreSearchRequest["flexibleMode"]
  nonStop?: boolean
  maxStopsFilter?: string
  maxLayoverMinutes?: string
  baggageRequired?: boolean
  includedAirlineCodes?: string[]
  maxResults?: number
  compactAllOffers?: boolean
  sortMode?: string
}

export type Segment = Partial<CoreSegment> & Pick<CoreSegment, "origin" | "destination" | "departureAt" | "arrivalAt">

export type Itinerary = Partial<Omit<CoreItinerary, "segments">> & {
  direction: CoreItinerary["direction"]
  segments: Segment[]
}

export type BaggageSummary = CoreBaggageSummary

export type FareMeta = CoreFareMeta

export type RedirectVerification = Omit<CoreRedirectVerification, "provider"> & {
  provider: OpenString<ProviderId>
}

export type PurchasePath = Omit<
  CorePurchasePath,
  "commercialMode" | "provider" | "redirectVerification" | "state" | "type"
> & {
  type: OpenString<CorePurchasePath["type"]>
  provider: OpenString<ProviderId>
  commercialMode: OpenString<CorePurchasePath["commercialMode"]>
  state: OpenString<CorePurchasePath["state"]>
  redirectVerification?: RedirectVerification
}

export type ComparisonMetrics = Partial<CoreComparisonMetrics>

// Frontend-only facade: core offer plus normalized display fields used by result cards.
export type CanonicalOffer = Partial<Omit<
  CoreCanonicalOffer,
  | "comparisonMetrics"
  | "itineraries"
  | "price"
  | "priceConfidence"
  | "priceStatus"
  | "providerSource"
  | "purchasePaths"
  | "redirectVerification"
>> & {
  id: string
  sourceOfferId?: string
  sourceSearchJobId?: string
  providerSource: OpenString<ProviderId>
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
  priceConfidence?: OpenString<CoreCanonicalOffer["priceConfidence"]>
  priceStatus?: OpenString<CoreCanonicalOffer["priceStatus"]>
  purchasePaths?: PurchasePath[]
  redirectVerification?: RedirectVerification
  comparisonMetrics?: ComparisonMetrics
  tags?: string[]
  warnings?: string[]
  price: CoreCanonicalOffer["price"]
}

// Frontend-only: month-view aggregation produced in the browser from search jobs.
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
  status: "loading" | "available" | "partial" | "empty" | "error" | "cancelled"
}

export type SearchMeta = Omit<CoreSearchResponse["searchMeta"], "providersUsed" | "searchState"> & {
  providersUsed: Array<OpenString<ProviderId>>
  searchState: OpenString<CoreSearchResponse["searchMeta"]["searchState"]>
}

export type ProviderMeta = Omit<CoreSearchResponse["providerMeta"], "coverageMode" | "exactProvider" | "redirectProvider"> & {
  exactProvider: OpenString<ProviderId>
  redirectProvider?: OpenString<ProviderId>
  coverageMode: OpenString<CoreSearchResponse["providerMeta"]["coverageMode"]>
}

export interface SearchResponse extends Omit<
  CoreSearchResponse,
  "allOffers" | "matrix" | "offers" | "providerDiagnostics" | "providerMeta" | "searchMeta"
> {
  offers: CanonicalOffer[]
  allOffers?: CanonicalOffer[]
  searchMeta: SearchMeta
  providerMeta: ProviderMeta
  providerDiagnostics?: ProviderDiagnostics[]
}

export interface SearchJobResponse extends SearchResponse {
  searchJobId: string
  searchComplete: boolean
  searchStatus: string
  revision: number
  sortMode: SortMode
  request: SearchRequest
  migrationMonths?: MigrationMonthSummary[]
  diagnosticLog?: string[]
  unchanged?: boolean
}

export type ProviderDiagnosticEvent = CoreProviderDiagnostics["events"][number]

export type ProviderDiagnostics = Omit<CoreProviderDiagnostics, "providerId"> & {
  providerId: OpenString<ProviderId>
}

export interface MatrixCell extends Omit<
  CoreMatrixCell,
  "confidence" | "derivedRequest" | "offer" | "providerSource" | "purchasePaths" | "stateCode"
> {
  confidence: OpenString<CoreMatrixCell["confidence"]>
  providerSource: OpenString<ProviderId>
  stateCode: OpenString<CoreMatrixCell["stateCode"]>
  purchasePaths?: PurchasePath[]
  offer?: CanonicalOffer
}

export type SortMode = "cheapest" | "fastest"

// Frontend-only: persisted result table layout, unrelated to the backend search contract.
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
