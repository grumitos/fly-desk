import {
  ProviderCapabilities,
  ProviderMatrixResult,
  ProviderSearchResult,
  RepriceResult,
  SearchProvider,
} from "./provider";
import { CanonicalOffer, SearchRequest } from "./types";
import {
  buildLocalAgilMatrix,
  repriceLocalAgilOffer,
  searchLocalAgilExact,
  searchLocalAgilRange,
} from "../local-agil";

export class LocalAgilProvider implements SearchProvider {
  id = "agil-local";

  capabilities: ProviderCapabilities = {
    exactSearch: true,
    reprice: true,
    flexibleDates: true,
    deeplinks: false,
    searchRedirects: true,
    calendarRedirects: false,
    multiCity: false,
  };

  async searchExact(request: SearchRequest): Promise<ProviderSearchResult> {
    if (request.searchMode === "stay-range") {
      return searchLocalAgilRange(request);
    }

    return searchLocalAgilExact(request);
  }

  async searchFlexible(request: SearchRequest): Promise<ProviderMatrixResult> {
    const result = await buildLocalAgilMatrix(request, {
      exactProvider: "agil-local",
      coverageMode: request.coverageMode,
    });

    return {
      cells: result.cells,
      warnings: result.warnings,
      partial: result.searchMeta.partial,
    };
  }

  async reprice(offer: CanonicalOffer, request: SearchRequest): Promise<RepriceResult> {
    return repriceLocalAgilOffer(offer, request);
  }
}
