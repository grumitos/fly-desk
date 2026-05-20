import { LocalAgilProvider } from "./core/agil-provider";
import { SearchOrchestrator } from "./core/orchestrator";
import { buildCommercialQuotation } from "./core/quotation";
import { SearchRequest } from "./core/types";

function localIsoDateAfter(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

async function main() {
  const provider = new LocalAgilProvider();
  const orchestrator = new SearchOrchestrator([provider]);
  const departureDate = localIsoDateAfter(14);
  const returnDate = localIsoDateAfter(21);

  const request: SearchRequest = {
    tripType: "round-trip",
    searchMode: "exact",
    legs: [
      {
        origin: "MAD",
        destination: "PAR",
        departureDate,
        returnDate,
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

  console.log(buildCommercialQuotation(best, request));
}

void main();
