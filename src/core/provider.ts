import {
  CreateOrderInput,
  CanonicalOffer,
  MatrixCell,
  OrderResult,
  PurchasePath,
  SearchRequest,
} from "./types";

export interface ProviderCapabilities {
  exactSearch: boolean;
  reprice: boolean;
  flexibleDates: boolean;
  deeplinks: boolean;
  searchRedirects: boolean;
  calendarRedirects: boolean;
  multiCity: boolean;
}

export interface ProviderSearchResult {
  offers: CanonicalOffer[];
  warnings: string[];
  partial: boolean;
}

export interface ProviderMatrixResult {
  cells: MatrixCell[];
  warnings: string[];
  partial: boolean;
}

export interface RepriceResult {
  status: "verified" | "changed" | "unavailable";
  offer?: CanonicalOffer;
  warnings: string[];
}

export interface PurchasePathResult {
  paths: PurchasePath[];
  warnings: string[];
}

export interface SearchProvider {
  id: string;
  capabilities: ProviderCapabilities;
  searchExact(request: SearchRequest): Promise<ProviderSearchResult>;
  searchFlexible?(request: SearchRequest): Promise<ProviderMatrixResult>;
  reprice?(offer: CanonicalOffer, request: SearchRequest): Promise<RepriceResult>;
  createOrder?(offer: CanonicalOffer, request: SearchRequest, input: CreateOrderInput): Promise<OrderResult>;
  resolvePurchasePaths?(
    offer: CanonicalOffer,
    request: SearchRequest,
  ): Promise<PurchasePathResult>;
}
