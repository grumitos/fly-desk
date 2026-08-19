import {
  CanonicalOffer,
  LocationSuggestion,
  MatrixCell,
  ProviderContext,
  ProviderId,
  PurchasePath,
  SearchRequest,
} from "./types";

export interface ProviderSearchResult {
  offers: CanonicalOffer[];
  warnings: string[];
  partial: boolean;
  incremental?: boolean;
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
