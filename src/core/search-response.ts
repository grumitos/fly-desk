import { applySearchFilters } from "./filtering";
import { groupExactProviderOffers } from "./offer-grouping";
import { buildOfferScheduleGroups } from "./offer-schedule-groups";
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

export function materializeSearchResponse(
  request: SearchRequest,
  sortMode: SortMode,
  exactProviderId: ProviderId,
  exactResult: { offers: CanonicalOffer[]; warnings: string[]; partial: boolean },
  startedAt = new Date().toISOString(),
): SearchResponse {
  let offers = groupExactProviderOffers(exactResult.offers);

  offers = enrichComparisonMetrics(offers);
  offers = sortOffers(offers, sortMode);
  const allOffers = offers;
  offers = applySearchFilters(allOffers, request.filters);

  return {
    offers,
    allOffers,
    scheduleGroups: buildOfferScheduleGroups(allOffers),
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
