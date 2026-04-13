import { SearchRequest, SearchResponse } from "./core/types";

export const LIST_SEARCH_RESULTS_PAGE_SIZE = 15;
export const LIST_SEARCH_MAX_PAGES = 25;
export const LIST_SEARCH_RESULT_LIMIT = LIST_SEARCH_RESULTS_PAGE_SIZE * LIST_SEARCH_MAX_PAGES;

export function resolveListSearchResultLimit(request: SearchRequest): number {
  const requestedMaxResults = typeof request.filters.maxResults === "number" && request.filters.maxResults > 0
    ? Math.trunc(request.filters.maxResults)
    : Number.POSITIVE_INFINITY;

  return Math.max(1, Math.min(LIST_SEARCH_RESULT_LIMIT, requestedMaxResults));
}

export function hasFilledSearchResultLimit(
  request: SearchRequest,
  response: Pick<SearchResponse, "offers">,
): boolean {
  return response.offers.length >= resolveListSearchResultLimit(request);
}

export function limitSearchResponseForPagination(
  request: SearchRequest,
  response: SearchResponse,
): SearchResponse {
  const limit = resolveListSearchResultLimit(request);
  const allOffers = response.allOffers ?? response.offers;

  return {
    ...response,
    offers: response.offers.slice(0, limit),
    allOffers,
  };
}
