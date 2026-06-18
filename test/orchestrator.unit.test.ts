import { expect, test } from "bun:test";
import { SearchOrchestrator } from "../src/core/orchestrator.ts";
import type {
  ProviderExecutionContext,
  SearchProvider,
} from "../src/core/provider.ts";
import type {
  MatrixCell,
  SearchRequest,
} from "../src/core/types.ts";

function buildRequest(providerId?: SearchRequest["providerId"]): SearchRequest {
  return {
    providerId,
    tripType: "round-trip",
    searchMode: "exact",
    legs: [{
      origin: "LIM",
      destination: "MIA",
      departureDate: "2026-06-08",
      returnDate: "2026-06-20",
    }],
    passengers: { adults: 1, children: 0, infants: 0 },
    cabin: "ECONOMY",
    filters: {},
    coverageMode: "extended",
    redirectMode: "best-effort",
    currencyCode: "USD",
  };
}

function buildCell(
  key: string,
  departureDate: string,
  returnDate: string | undefined,
  confidence: MatrixCell["confidence"],
): MatrixCell {
  return {
    key,
    departureDate,
    returnDate,
    confidence,
    providerSource: "costamar",
    selectable: confidence !== "empty",
    requiresRequery: true,
    stateCode: confidence === "empty" ? "emp" : "live",
  };
}

test("SearchOrchestrator uses the default provider and forwards execution context", async () => {
  let receivedContext: ProviderExecutionContext | undefined;
  const provider: SearchProvider = {
    id: "agil-local",
    capabilities: {
      exactSearch: true,
      flexibleDates: false,
      deeplinks: false,
      searchRedirects: true,
      calendarRedirects: false,
      multiCity: false,
    },
    async searchExact(_request, context) {
      receivedContext = context;
      return { offers: [], warnings: ["provider warning"], partial: true };
    },
  };
  const orchestrator = new SearchOrchestrator([provider]);
  const providerContext = { costamar: undefined };

  const response = await orchestrator.search(buildRequest(), "fastest", { providerContext });

  expect(receivedContext?.providerContext).toBe(providerContext);
  expect(response.providerMeta).toEqual({
    exactProvider: "agil-local",
    coverageMode: "extended",
  });
  expect(response.searchMeta.searchState).toBe("search_partial");
  expect(response.warnings).toEqual(["provider warning"]);
});

test("SearchOrchestrator lets explicit execution options override the request provider", async () => {
  const called: string[] = [];
  const provider = (id: SearchProvider["id"]): SearchProvider => ({
    id,
    capabilities: {
      exactSearch: true,
      flexibleDates: false,
      deeplinks: false,
      searchRedirects: true,
      calendarRedirects: false,
      multiCity: false,
    },
    async searchExact() {
      called.push(id);
      return { offers: [], warnings: [], partial: false };
    },
  });
  const orchestrator = new SearchOrchestrator([
    provider("agil-local"),
    provider("costamar"),
  ]);

  await orchestrator.search(buildRequest("costamar"), "cheapest", {
    providerId: "agil-local",
  });

  expect(called).toEqual(["agil-local"]);
  expect(orchestrator.getProvider("costamar")?.id).toBe("costamar");
});

test("SearchOrchestrator rejects missing providers and unsupported matrix searches", async () => {
  const exactOnly: SearchProvider = {
    id: "agil-local",
    capabilities: {
      exactSearch: true,
      flexibleDates: false,
      deeplinks: false,
      searchRedirects: true,
      calendarRedirects: false,
      multiCity: false,
    },
    async searchExact() {
      return { offers: [], warnings: [], partial: false };
    },
  };

  await expect(new SearchOrchestrator([]).search(buildRequest())).rejects.toThrow(
    "Search provider is not configured: agil-local",
  );
  await expect(new SearchOrchestrator([exactOnly]).buildMatrix(buildRequest())).rejects.toThrow(
    "Exact provider does not support matrix search",
  );
});

test("SearchOrchestrator builds unique matrix axes and confidence counts", async () => {
  const provider: SearchProvider = {
    id: "costamar",
    capabilities: {
      exactSearch: true,
      flexibleDates: true,
      deeplinks: false,
      searchRedirects: true,
      calendarRedirects: false,
      multiCity: false,
    },
    async searchExact() {
      return { offers: [], warnings: [], partial: false };
    },
    async searchFlexible() {
      return {
        cells: [
          buildCell("a", "2026-06-08", "2026-06-20", "live"),
          buildCell("b", "2026-06-08", "2026-06-21", "empty"),
          buildCell("c", "2026-06-09", "2026-06-21", "live"),
        ],
        warnings: ["partial provider response"],
        partial: true,
      };
    },
  };

  const response = await new SearchOrchestrator([provider]).buildMatrix(
    buildRequest("costamar"),
  );

  expect(response.axes).toEqual({
    departureDates: ["2026-06-08", "2026-06-09"],
    returnDates: ["2026-06-20", "2026-06-21"],
  });
  expect(response.confidenceSummary).toEqual({ live: 2, empty: 1 });
  expect(response.recommendations[0]).toContain("Click and Book Plus");
  expect(response.searchMeta.searchState).toBe("search_partial");
});
