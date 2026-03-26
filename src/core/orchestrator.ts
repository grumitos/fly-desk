import { applySearchFilters } from "./filtering";
import { SearchProvider } from "./provider";
import { computeValueScores, enrichComparisonMetrics, sortOffers } from "./ranking";
import {
  CanonicalOffer,
  MatrixResponse,
  ProviderId,
  ProviderMeta,
  SearchMeta,
  SearchRequest,
  SearchResponse,
} from "./types";

function buildProviderMeta(
  request: SearchRequest,
  exactProvider: SearchProvider,
  secondaryRedirectProvider?: SearchProvider,
): ProviderMeta {
  return {
    exactProvider: exactProvider.id as ProviderId,
    redirectProvider: secondaryRedirectProvider?.id as ProviderId | undefined,
    coverageMode: request.coverageMode,
  };
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
  sortMode: "cheapest" | "fastest" | "best-value",
  exactProviderId: ProviderId,
  exactResult: { offers: CanonicalOffer[]; warnings: string[]; partial: boolean },
): SearchResponse {
  let offers = exactResult.offers;

  offers = enrichComparisonMetrics(offers);
  offers = computeValueScores(offers);
  offers = sortOffers(offers, sortMode);
  const allOffers = offers;
  offers = applySearchFilters(allOffers, request.filters);

  if (typeof request.filters.maxResults === "number") {
    offers = offers.slice(0, request.filters.maxResults);
  }

  return {
    offers,
    allOffers,
    searchMeta: buildSearchMeta(
      new Date().toISOString(),
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

export class SearchOrchestrator {
  constructor(
    private readonly exactProvider: SearchProvider,
    private readonly secondaryRedirectProvider?: SearchProvider,
  ) {}

  async search(
    request: SearchRequest,
    sortMode: "cheapest" | "fastest" | "best-value" = "cheapest",
  ): Promise<SearchResponse> {
    const exactResult = await this.exactProvider.searchExact(request);
    return materializeSearchResponse(
      request,
      sortMode,
      this.exactProvider.id as ProviderId,
      exactResult,
    );
  }

  async buildMatrix(request: SearchRequest): Promise<MatrixResponse> {
    const startedAt = new Date().toISOString();
    if (!this.exactProvider.searchFlexible) {
      throw new Error("Exact provider does not support matrix search");
    }

    const flexibleResult = await this.exactProvider.searchFlexible(request);
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
        "Matrix cells come from live Agil searches.",
        "Validated pricing still comes from reprice on a selected offer.",
      ],
      searchMeta: buildSearchMeta(
        startedAt,
        [this.exactProvider.id as ProviderId],
        flexibleResult.warnings,
        flexibleResult.partial,
      ),
      providerMeta: buildProviderMeta(request, this.exactProvider, this.secondaryRedirectProvider),
      warnings: flexibleResult.warnings,
    };
  }

  async reprice(
    request: SearchRequest,
    offerId: string,
    existingOffer?: CanonicalOffer,
  ): Promise<SearchResponse> {
    const target = existingOffer ?? await this.findOffer(request, offerId);

    if (!target) {
      throw new Error(`Offer not found: ${offerId}`);
    }

    if (!this.exactProvider.reprice) {
      throw new Error("Exact provider does not support repricing");
    }

    const result = await this.exactProvider.reprice(target, request);
    const offers = result.offer ? enrichComparisonMetrics(computeValueScores([result.offer])) : [];

    return {
      offers,
      searchMeta: {
        requestedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        providersUsed: [this.exactProvider.id as ProviderId],
        warnings: result.warnings,
        partial: result.status !== "verified",
        searchState: result.status === "verified" ? "search_live" : "search_partial",
      },
      providerMeta: buildProviderMeta(request, this.exactProvider, this.secondaryRedirectProvider),
      warnings: result.warnings,
    };
  }

  private async findOffer(
    request: SearchRequest,
    offerId: string,
  ): Promise<CanonicalOffer | undefined> {
    const search = await this.exactProvider.searchExact(request);
    return search.offers.find((offer: CanonicalOffer) => offer.id === offerId);
  }
}
