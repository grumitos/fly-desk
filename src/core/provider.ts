import { CanonicalOffer } from "./types";

export interface ProviderSearchResult {
  offers: CanonicalOffer[];
  warnings: string[];
  partial: boolean;
  incremental?: boolean;
}
