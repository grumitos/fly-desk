import type {
  CanonicalOffer,
  PurchasePath,
} from "../../src/core/types";

export function buildSearchMeta(searchState: "search_partial" | "search_live" | "search_failed" = "search_partial") {
  const timestamp = "2026-03-26T00:00:00.000Z";
  return {
    requestedAt: timestamp,
    completedAt: timestamp,
    providersUsed: ["agil-local"],
    warnings: [],
    partial: searchState !== "search_live",
    searchState,
    searchSessionId: "job-search-1",
  };
}

export function buildMatrixResponse(overrides: Record<string, unknown> = {}) {
  return {
    matrixJobId: "matrix-job-1",
    matrixComplete: false,
    matrixStatus: "running",
    request: {
      tripType: "round-trip",
      searchMode: "roundtrip-grid",
      flexibleMode: "exact-stay",
      legs: [
        {
          origin: "LIM",
          destination: "MIA",
          departureStart: "2026-04-15",
          departureEnd: "2026-04-19",
          returnStart: "2026-04-15",
          returnEnd: "2026-04-19",
          stayNights: 4,
        },
      ],
      passengers: {
        adults: 1,
        children: 0,
        infants: 0,
      },
      cabin: "ECONOMY",
      filters: {},
      coverageMode: "core",
      redirectMode: "best-effort",
      currencyCode: "USD",
      locale: "es-PE",
      market: "PE",
    },
    cells: [
      {
        key: "2026-04-15_2026-04-19",
        departureDate: "2026-04-15",
        returnDate: "2026-04-19",
        stayNights: 4,
        confidence: "loading",
        providerSource: "agil-local",
        selectable: false,
        requiresRequery: true,
        stateCode: "ind",
        tooltip: "Consultando Agil...",
        derivedRequest: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MIA",
              departureDate: "2026-04-15",
              returnDate: "2026-04-19",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
          cabin: "ECONOMY",
          filters: {},
          coverageMode: "core",
          redirectMode: "best-effort",
          currencyCode: "USD",
          locale: "es-PE",
          market: "PE",
        },
      },
    ],
    axes: {
      departureDates: ["2026-04-15"],
      returnDates: ["2026-04-19"],
    },
    confidenceSummary: {
      loading: 1,
    },
    recommendations: [],
    searchMeta: buildSearchMeta(),
    providerMeta: {
      exactProvider: "agil-local",
      coverageMode: "core",
    },
    warnings: [],
    ...overrides,
  };
}

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
