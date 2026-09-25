import { groupExactProviderOffers } from "./offer-grouping";
import { enrichComparisonMetrics, sortOffers } from "./ranking";
import {
  CanonicalOffer,
  ProviderId,
  SEARCH_CACHE_VERSION,
  SearchMeta,
  SearchRequest,
  SearchResponse,
  SortMode,
} from "./types";

function buildSearchMeta(
  startedAt: string,
  providersUsed: ProviderId[],
  warnings: string[],
  partial: boolean,
): SearchMeta {
  return {
    requestedAt: startedAt,
    completedAt: new Date().toISOString(),
    providersUsed,
    warnings,
    partial,
    searchState: partial ? "search_partial" : "search_live",
    cacheVersion: SEARCH_CACHE_VERSION,
  };
}

/* Every offer the providers returned, grouped, measured and in the requested
   order: the browser draws it through the rail's filters. */
export function materializeSearchResponse(
  request: SearchRequest,
  sortMode: SortMode,
  exactProviderId: ProviderId,
  exactResult: { offers: CanonicalOffer[]; warnings: string[]; partial: boolean },
  startedAt = new Date().toISOString(),
): SearchResponse {
  const allOffers = sortOffers(enrichComparisonMetrics(groupExactProviderOffers(exactResult.offers)), sortMode);

  return {
    allOffers,
    searchMeta: buildSearchMeta(
      startedAt,
      [exactProviderId],
      exactResult.warnings,
      exactResult.partial,
    ),
    providerMeta: {
      exactProvider: exactProviderId,
      coverageMode: request.coverageMode,
    },
    warnings: exactResult.warnings,
  };
}
