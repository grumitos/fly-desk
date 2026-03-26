import { CanonicalOffer, CompareResponse, CompareRow } from "./types";

function formatMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toFixed(2)}`;
}

function formatBoolean(value: boolean | undefined, yes = "Yes", no = "No"): string {
  return value ? yes : no;
}

export function buildCompareResponse(offers: CanonicalOffer[]): CompareResponse {
  const rows: CompareRow[] = [
    {
      key: "price",
      label: "Precio total",
      values: offers.map((offer) =>
        formatMoney(offer.price.total.amount, offer.price.total.currencyCode)),
      highlight: "lowest",
    },
    {
      key: "duration",
      label: "Duracion total",
      values: offers.map((offer) => `${offer.comparisonMetrics.totalDurationMinutes} min`),
      highlight: "lowest",
    },
    {
      key: "stops",
      label: "Escalas",
      values: offers.map((offer) => String(offer.comparisonMetrics.totalStops)),
      highlight: "lowest",
    },
    {
      key: "baggage",
      label: "Equipaje",
      values: offers.map((offer) =>
        offer.baggage?.description ??
        formatBoolean(offer.baggage?.checkedIncluded, "Facturado incluido", "Solo mano")),
      highlight: "highest",
    },
    {
      key: "purchasePath",
      label: "Purchase path",
      values: offers.map((offer) => offer.purchasePaths[0]?.type ?? "none"),
      highlight: "none",
    },
    {
      key: "priceSource",
      label: "Fuente precio",
      values: offers.map((offer) => offer.priceConfidence === "validated" ? "Reprice Agil" : "Agil live"),
      highlight: "none",
    },
    {
      key: "ticketing",
      label: "Limite de emision",
      values: offers.map((offer) => offer.fareMeta?.lastTicketingDate ?? "N/D"),
      highlight: "none",
    },
  ];

  return {
    offers,
    rows,
    warnings: [],
  };
}
