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
import { SORT_MODES } from "../../../src/core/types"

type OpenString<T extends string> = T | (string & {})

export type LocationSuggestion = CoreLocationSuggestion & {
  providerId?: string
  providerIds?: string[]
}

// Frontend-only: flat form/share state converted to the core SearchRequest in lib/api.ts.
export interface SearchRequest {
  origin: string
  destination: string
  originLabel?: string
  destinationLabel?: string
  originCountryCode?: string
  destinationCountryCode?: string
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
  carryOnRequired?: boolean
  checkedBaggageRequired?: boolean
  baggageRequired?: boolean
  includedAirlineCodes?: string[]
  migrationMonths?: string[]
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
  quotationPreparedAt?: string
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
  faredDays?: number
  queriedDays?: number
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
  /**
   * Why the job ended in `failed`. The backend has always sent it; leaving it
   * undeclared here is what kept the shell from being able to say that a search
   * failed at all, so a job that died on admission was drawn as a route with no
   * flights.
   */
  error?: string
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

/*
 * The order is a contract, not a screen preference: the criterion travels in
 * `POST /api/search` and the backend is what sorts. So the type is not written
 * out again here as a union of its own — it comes from the same catalogue that
 * validates the request, the way `airline-names` and `location-display` come
 * from the core. A hand-copied union is what leaves the frontend offering an
 * order the server does not know how to serve.
 */
export { SORT_MODES }

export type SortMode = (typeof SORT_MODES)[number]

export function isSortMode(value: unknown): value is SortMode {
  return SORT_MODES.includes(value as SortMode)
}
