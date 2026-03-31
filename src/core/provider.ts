import {
  CreateOrderInput,
  CanonicalOffer,
  LocationSuggestion,
  MatrixCell,
  OrderResult,
  ProviderContext,
  ProviderId,
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

export interface ProviderExecutionContext {
  providerContext?: ProviderContext;
}

export interface SearchProvider {
  id: ProviderId;
  capabilities: ProviderCapabilities;
  searchExact(
    request: SearchRequest,
    context?: ProviderExecutionContext,
  ): Promise<ProviderSearchResult>;
  searchFlexible?(
    request: SearchRequest,
    context?: ProviderExecutionContext,
  ): Promise<ProviderMatrixResult>;
  reprice?(
    offer: CanonicalOffer,
    request: SearchRequest,
    context?: ProviderExecutionContext,
  ): Promise<RepriceResult>;
  createOrder?(
    offer: CanonicalOffer,
    request: SearchRequest,
    input: CreateOrderInput,
    context?: ProviderExecutionContext,
  ): Promise<OrderResult>;
  resolvePurchasePaths?(
    offer: CanonicalOffer,
    request: SearchRequest,
    context?: ProviderExecutionContext,
  ): Promise<PurchasePathResult>;
  suggestLocations?(
    query: string,
    limit?: number,
    context?: ProviderExecutionContext,
  ): Promise<LocationSuggestion[]>;
}
