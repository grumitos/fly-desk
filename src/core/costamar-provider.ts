import {
  ProviderExecutionContext,
  ProviderCapabilities,
  ProviderMatrixResult,
  ProviderSearchResult,
  SearchProvider,
} from "./provider";
import { SearchRequest } from "./types";
import {
  buildLocalCostamarMatrix,
  searchLocalCostamarExact,
  suggestLocalCostamarLocations,
} from "../local-costamar";

export class LocalCostamarProvider implements SearchProvider {
  id = "costamar" as const;

  capabilities: ProviderCapabilities = {
    exactSearch: true,
    flexibleDates: true,
    deeplinks: false,
    searchRedirects: true,
    calendarRedirects: false,
    multiCity: false,
  };

  async searchExact(
    request: SearchRequest,
    context?: ProviderExecutionContext,
  ): Promise<ProviderSearchResult> {
    return searchLocalCostamarExact(request, context?.providerContext);
  }

  async searchFlexible(
    request: SearchRequest,
    context?: ProviderExecutionContext,
  ): Promise<ProviderMatrixResult> {
    const result = await buildLocalCostamarMatrix(request, context?.providerContext, {
      exactProvider: "costamar",
      coverageMode: request.coverageMode,
    });

    return {
      cells: result.cells,
      warnings: result.warnings,
      partial: result.searchMeta.partial,
    };
  }

  async suggestLocations(query: string, limit = 8) {
    return suggestLocalCostamarLocations(query, limit);
  }
}
