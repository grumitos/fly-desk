import { applySearchFilters } from "./filtering";
import { groupExactProviderOffers } from "./offer-grouping";
import { ProviderExecutionContext, SearchProvider } from "./provider";
import { enrichComparisonMetrics, sortOffers } from "./ranking";
import {
  CanonicalOffer,
  MatrixResponse,
  ProviderId,
  ProviderMeta,
  SearchMeta,
  SearchRequest,
  SearchResponse,
} from "./types";

function buildProviderMeta(request: SearchRequest, exactProviderId: ProviderId): ProviderMeta {
  return {
    exactProvider: exactProviderId,
    coverageMode: request.coverageMode,
  };
}

function providerDisplayName(providerId: ProviderId): string {
  return providerId === "costamar" ? "Costamar" : "Agilsmart";
}

export function buildSearchMeta(
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
  };
}

export function materializeSearchResponse(
  request: SearchRequest,
  sortMode: "cheapest" | "fastest",
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

export interface SearchExecutionOptions extends ProviderExecutionContext {
  providerId?: ProviderId;
}

export class SearchOrchestrator {
  private readonly providers: Map<ProviderId, SearchProvider>;

  constructor(providers: SearchProvider[]) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
  }

  getProvider(providerId: ProviderId): SearchProvider | undefined {
    return this.providers.get(providerId);
  }

  private resolveProvider(providerId?: ProviderId): SearchProvider {
    const resolvedId = providerId ?? "agil-local";
    const provider = this.providers.get(resolvedId);

    if (!provider) {
      throw new Error(`Search provider is not configured: ${resolvedId}`);
    }

    return provider;
  }

  async search(
    request: SearchRequest,
    sortMode: "cheapest" | "fastest" = "cheapest",
    options?: SearchExecutionOptions,
  ): Promise<SearchResponse> {
    const startedAt = new Date().toISOString();
    const provider = this.resolveProvider(options?.providerId ?? request.providerId);
    const exactResult = await provider.searchExact(request, options);
    return materializeSearchResponse(
      request,
      sortMode,
      provider.id,
      exactResult,
      startedAt,
    );
  }

  async buildMatrix(
    request: SearchRequest,
    options?: SearchExecutionOptions,
  ): Promise<MatrixResponse> {
    const startedAt = new Date().toISOString();
    const provider = this.resolveProvider(options?.providerId ?? request.providerId);
    if (!provider.searchFlexible) {
      throw new Error("Exact provider does not support matrix search");
    }

    const flexibleResult = await provider.searchFlexible(request, options);
    const cells = flexibleResult.cells;

    const departureDates = [...new Set(cells.map((cell) => cell.departureDate))];
    const returnDates = [...new Set(cells.map((cell) => cell.returnDate).filter(Boolean) as string[])];
    const confidenceSummary = cells.reduce<Record<string, number>>((acc, cell) => {
      acc[cell.confidence] = (acc[cell.confidence] ?? 0) + 1;
      return acc;
    }, {});

    return {
      cells,
      axes: {
        departureDates,
        returnDates,
      },
      confidenceSummary,
      recommendations: [
        `Matrix cells come from live ${providerDisplayName(provider.id)} searches.`,
        "Abre una celda para relanzar una busqueda exacta con esas fechas.",
      ],
      searchMeta: buildSearchMeta(
        startedAt,
        [provider.id],
        flexibleResult.warnings,
        flexibleResult.partial,
      ),
      providerMeta: buildProviderMeta(request, provider.id),
      warnings: flexibleResult.warnings,
    };
  }
}
