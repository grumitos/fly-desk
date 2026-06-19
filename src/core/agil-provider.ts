import {
  ProviderExecutionContext,
  ProviderMatrixResult,
  ProviderSearchResult,
  SearchProvider,
} from "./provider";
import { SearchRequest } from "./types";
import {
  buildLocalAgilMatrix,
  searchLocalAgilExact,
  searchLocalAgilRange,
} from "../local-agil";

export class LocalAgilProvider implements SearchProvider {
  id = "agil-local" as const;

  async searchExact(
    request: SearchRequest,
    _context?: ProviderExecutionContext,
  ): Promise<ProviderSearchResult> {
    if (request.searchMode === "stay-range") {
      return searchLocalAgilRange(request);
    }

    return searchLocalAgilExact(request);
  }

  async searchFlexible(
    request: SearchRequest,
    _context?: ProviderExecutionContext,
  ): Promise<ProviderMatrixResult> {
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
}
