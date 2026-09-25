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

// The form's flat request; `lib/api.ts` converts it to the core request.
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

// The core offer as the browser receives it, plus the display fields `lib/api.ts` derives.
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
  | "rawRefs"
  | "signature"
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
  baggage?: BaggageSummary
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

// A month of the migratory sweep, aggregated in the browser from its search job.
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

/* The backend sends every offer once, in `allOffers`; what a list draws is
   derived from it on this side. */
export interface SearchResponse extends Omit<
  CoreSearchResponse,
  "allOffers" | "matrix" | "offers" | "providerDiagnostics" | "providerMeta" | "searchMeta"
> {
  allOffers: CanonicalOffer[]
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
  /** Why the job ended in `failed`. */
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

/* The order travels in `POST /api/search` and is validated against this same
   catalogue, so the browser cannot offer an order the server cannot serve. */
export { SORT_MODES }

export type SortMode = (typeof SORT_MODES)[number]

export function isSortMode(value: unknown): value is SortMode {
  return SORT_MODES.includes(value as SortMode)
}
