import type { SearchFilters } from "./types";

// Keep legacy filter fields compatible without allowing them to truncate provider output.
export function retainOfferVariants<T>(variants: T[], _filters: SearchFilters): T[] {
  return variants;
}
