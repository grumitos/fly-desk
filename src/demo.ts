import { LocalAgilProvider } from "./core/agil-provider";
import { SearchOrchestrator } from "./core/orchestrator";
import { buildQuotationText } from "./core/quotation";
import { SearchRequest } from "./core/types";

async function main() {
  const provider = new LocalAgilProvider();
  const orchestrator = new SearchOrchestrator(provider);

  const request: SearchRequest = {
    tripType: "round-trip",
    searchMode: "exact",
    legs: [
      {
        origin: "MAD",
        destination: "PAR",
        departureDate: "2026-04-15",
        returnDate: "2026-04-22",
      },
    ],
    passengers: {
      adults: 1,
      children: 0,
      infants: 0,
    },
    cabin: "ECONOMY",
    filters: {
      nonStop: true,
      maxResults: 25,
    },
    coverageMode: "core",
    redirectMode: "best-effort",
    currencyCode: "USD",
  };

  const response = await orchestrator.search(request, "cheapest");
  const best = response.offers[0];

  if (!best) {
    console.log("No results");
    return;
  }

  const repriced = await orchestrator.reprice(request, best.id);
  const repricedOffer = repriced.offers[0] ?? best;

  console.log(buildQuotationText(repricedOffer, request));
}

void main();
