import type {
  CanonicalOffer,
  PurchasePath,
} from "../../src/core/types";

export function buildOffer(overrides: Partial<CanonicalOffer> = {}): CanonicalOffer {
  const id = overrides.id ?? "offer-1";
  const providerSource = overrides.providerSource ?? "agil-local";
  const purchasePath: PurchasePath = providerSource === "costamar"
    ? {
        id: `${id}-costamar-path`,
        provider: "costamar",
        type: "search-redirect",
        label: "Click and Book Plus",
        url: "https://example.test/costamar",
        precision: "exact-search",
        score: 1,
        requiresNewTab: true,
        commercialMode: "provider",
        state: "search_redirect",
      }
    : {
        id: `${id}-agil-path`,
        provider: "agil-local",
        type: "deeplink",
        label: "Agil",
        url: "https://example.test/agil",
        precision: "exact-offer",
        score: 1,
        requiresNewTab: true,
        commercialMode: "provider",
        state: "deeplink_exact",
      };
  const offer = {
    id,
    signature: `${providerSource}:${id}`,
    providerSource,
    providerOfferRef: id,
    tripType: "round-trip",
    origin: "LIM",
    destination: "MIA",
    mainCarrier: "LA",
    validatingCarrier: "LA",
    priceConfidence: "live",
    priceStatus: "unverified",
    comparisonMetrics: {
      totalDurationMinutes: 950,
      totalStops: 0,
      baggageScore: 2,
      purchasePathScore: 1,
    },
    baggage: {
      carryOnIncluded: true,
      checkedIncluded: true,
      checkedBags: 1,
      description: "23kg",
    },
    price: {
      total: {
        amount: 512,
        currencyCode: "USD",
      },
      base: {
        amount: 420,
        currencyCode: "USD",
      },
      taxes: {
        amount: 92,
        currencyCode: "USD",
      },
    },
    itineraries: [
      {
        id: `${id}-outbound`,
        direction: "outbound",
        durationMinutes: 480,
        stops: 0,
        layoverMinutes: [],
        segments: [
          {
            id: `${id}-outbound-segment-1`,
            flightNumber: "LA 123",
            marketingCarrier: "LA",
            origin: "LIM",
            destination: "MIA",
            departureAt: "2026-04-15T14:00:00Z",
            arrivalAt: "2026-04-15T22:00:00Z",
            durationMinutes: 480,
          },
        ],
      },
      {
        id: `${id}-inbound`,
        direction: "inbound",
        durationMinutes: 470,
        stops: 0,
        layoverMinutes: [],
        segments: [
          {
            id: `${id}-inbound-segment-1`,
            flightNumber: "LA 456",
            marketingCarrier: "LA",
            origin: "MIA",
            destination: "LIM",
            departureAt: "2026-04-22T15:00:00Z",
            arrivalAt: "2026-04-22T22:50:00Z",
            durationMinutes: 470,
          },
        ],
      },
    ],
    purchasePaths: [purchasePath],
    tags: [],
    warnings: [],
  } satisfies CanonicalOffer;

  return { ...offer, ...overrides };
}
