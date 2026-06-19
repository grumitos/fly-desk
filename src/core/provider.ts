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

export interface PurchasePathResult {
  paths: PurchasePath[];
  warnings: string[];
}

export interface ProviderExecutionContext {
  providerContext?: ProviderContext;
}

export interface SearchProvider {
  id: ProviderId;
  searchExact(
    request: SearchRequest,
    context?: ProviderExecutionContext,
  ): Promise<ProviderSearchResult>;
  searchFlexible?(
    request: SearchRequest,
    context?: ProviderExecutionContext,
  ): Promise<ProviderMatrixResult>;
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
