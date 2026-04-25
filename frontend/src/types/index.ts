export interface LocationSuggestion {
  code: string
  city: string
  country: string
  countryCode?: string
  label: string
}

export interface SearchRequest {
  origin: string
  destination: string
  departureDate?: string
  returnDate?: string
  tripType: "round-trip" | "one-way"
  adults: number
  children: number
  infants: number
  searchMode: "exact" | "stay-range" | "roundtrip-grid"
  nonStop?: boolean
  maxStopsFilter?: string
  maxLayoverMinutes?: string
  baggageRequired?: boolean
  sortMode?: string
}

export interface CanonicalOffer {
  id: string
  providerSource: string
  airline: string
  departureDate: string
  returnDate?: string
  duration: string
  stops: number
  stopMeta?: string
  baggage?: string
  price: {
    total: { amount: number; currencyCode: string }
  }
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
}

export interface SearchJobResponse extends SearchResponse {
  searchJobId: string
  searchComplete: boolean
  searchStatus: string
  revision: number
  sortMode: string
  request: SearchRequest
  unchanged?: boolean
}

export type SortMode = "cheapest" | "fastest" | "best-value"
export type ViewMode = "list" | "calendar"
