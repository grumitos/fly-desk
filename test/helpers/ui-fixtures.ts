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
      filters: {
        maxResults: 25,
      },
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
          filters: {
            maxResults: 25,
          },
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

export function buildOffer(overrides: Record<string, unknown> = {}) {
  return {
    id: "offer-1",
    origin: "LIM",
    destination: "MIA",
    mainCarrier: "LA",
    validatingCarrier: "LA",
    priceConfidence: "live",
    comparisonMetrics: {
      totalDurationMinutes: 480,
      totalStops: 0,
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
        direction: "outbound",
        durationMinutes: 480,
        stops: 0,
        segments: [
          {
            flightNumber: "LA 123",
            origin: "LIM",
            destination: "MIA",
            departureAt: "2026-04-15T14:00:00Z",
            arrivalAt: "2026-04-15T22:00:00Z",
          },
        ],
      },
      {
        direction: "inbound",
        durationMinutes: 470,
        stops: 0,
        segments: [
          {
            flightNumber: "LA 456",
            origin: "MIA",
            destination: "LIM",
            departureAt: "2026-04-22T15:00:00Z",
            arrivalAt: "2026-04-22T22:50:00Z",
          },
        ],
      },
    ],
    purchasePaths: [
      {
        provider: "agil-local",
        type: "deep-link",
        label: "Agil",
        url: "https://example.test/agil",
      },
    ],
    ...overrides,
  };
}

export function buildOfferWithDates(id: string, departureDate: string, returnDate: string) {
  return buildOffer({
    id,
    itineraries: [
      {
        direction: "outbound",
        durationMinutes: 480,
        stops: 0,
        segments: [
          {
            flightNumber: "LA 123",
            origin: "LIM",
            destination: "MIA",
            departureAt: `${departureDate}T14:00:00Z`,
            arrivalAt: `${departureDate}T22:00:00Z`,
          },
        ],
      },
      {
        direction: "inbound",
        durationMinutes: 470,
        stops: 0,
        segments: [
          {
            flightNumber: "LA 456",
            origin: "MIA",
            destination: "LIM",
            departureAt: `${returnDate}T15:00:00Z`,
            arrivalAt: `${returnDate}T22:50:00Z`,
          },
        ],
      },
    ],
  });
}

export function buildCarrierOffer(id: string, carrierCode: string, amount: number) {
  return buildOffer({
    id,
    mainCarrier: carrierCode,
    validatingCarrier: carrierCode,
    price: {
      total: {
        amount,
        currencyCode: "USD",
      },
      base: {
        amount: Math.max(0, amount - 90),
        currencyCode: "USD",
      },
      taxes: {
        amount: 90,
        currencyCode: "USD",
      },
    },
    itineraries: [
      {
        direction: "outbound",
        durationMinutes: 480,
        stops: 0,
        segments: [
          {
            flightNumber: `${carrierCode} 123`,
            marketingCarrier: carrierCode,
            origin: "LIM",
            destination: "MIA",
            departureAt: "2026-04-15T14:00:00Z",
            arrivalAt: "2026-04-15T22:00:00Z",
          },
        ],
      },
      {
        direction: "inbound",
        durationMinutes: 470,
        stops: 0,
        segments: [
          {
            flightNumber: `${carrierCode} 456`,
            marketingCarrier: carrierCode,
            origin: "MIA",
            destination: "LIM",
            departureAt: "2026-04-22T15:00:00Z",
            arrivalAt: "2026-04-22T22:50:00Z",
          },
        ],
      },
    ],
  });
}

export function buildLayoverOffer(id: string, amount: number, layoverMinutes: number) {
  const departureAt = "2026-04-15T08:00:00Z";
  const firstArrival = "2026-04-15T12:00:00Z";
  const secondDepartureDate = new Date(Date.parse(firstArrival) + layoverMinutes * 60000).toISOString();
  const secondArrivalDate = new Date(Date.parse(secondDepartureDate) + 240 * 60000).toISOString();

  return buildOffer({
    id,
    mainCarrier: "LA",
    validatingCarrier: "LA",
    comparisonMetrics: {
      totalDurationMinutes: 710 + layoverMinutes,
      totalStops: 1,
    },
    price: {
      total: {
        amount,
        currencyCode: "USD",
      },
      base: {
        amount: Math.max(0, amount - 90),
        currencyCode: "USD",
      },
      taxes: {
        amount: 90,
        currencyCode: "USD",
      },
    },
    itineraries: [
      {
        direction: "outbound",
        durationMinutes: 470 + layoverMinutes,
        stops: 1,
        layoverMinutes: [layoverMinutes],
        segments: [
          {
            flightNumber: "LA 201",
            marketingCarrier: "LA",
            origin: "LIM",
            destination: "BOG",
            departureAt,
            arrivalAt: firstArrival,
          },
          {
            flightNumber: "LA 305",
            marketingCarrier: "LA",
            origin: "BOG",
            destination: "MIA",
            departureAt: secondDepartureDate,
            arrivalAt: secondArrivalDate,
          },
        ],
      },
      {
        direction: "inbound",
        durationMinutes: 470,
        stops: 0,
        segments: [
          {
            flightNumber: "LA 456",
            marketingCarrier: "LA",
            origin: "MIA",
            destination: "LIM",
            departureAt: "2026-04-22T15:00:00Z",
            arrivalAt: "2026-04-22T22:50:00Z",
          },
        ],
      },
    ],
  });
}

export function buildTwoStopOffer(id: string, amount: number, firstLayoverMinutes: number, secondLayoverMinutes: number) {
  const departureAt = "2026-04-15T08:00:00Z";
  const firstArrival = "2026-04-15T12:00:00Z";
  const secondDepartureDate = new Date(Date.parse(firstArrival) + firstLayoverMinutes * 60000).toISOString();
  const secondArrivalDate = new Date(Date.parse(secondDepartureDate) + 180 * 60000).toISOString();
  const thirdDepartureDate = new Date(Date.parse(secondArrivalDate) + secondLayoverMinutes * 60000).toISOString();
  const thirdArrivalDate = new Date(Date.parse(thirdDepartureDate) + 180 * 60000).toISOString();

  return buildOffer({
    id,
    mainCarrier: "AA",
    validatingCarrier: "AA",
    comparisonMetrics: {
      totalDurationMinutes: 820 + firstLayoverMinutes + secondLayoverMinutes,
      totalStops: 2,
    },
    price: {
      total: {
        amount,
        currencyCode: "USD",
      },
      base: {
        amount: Math.max(0, amount - 90),
        currencyCode: "USD",
      },
      taxes: {
        amount: 90,
        currencyCode: "USD",
      },
    },
    itineraries: [
      {
        direction: "outbound",
        durationMinutes: 300 + firstLayoverMinutes + 180 + secondLayoverMinutes + 180,
        stops: 2,
        layoverMinutes: [firstLayoverMinutes, secondLayoverMinutes],
        segments: [
          {
            flightNumber: "AA 201",
            marketingCarrier: "AA",
            origin: "LIM",
            destination: "BOG",
            departureAt,
            arrivalAt: firstArrival,
          },
          {
            flightNumber: "AA 305",
            marketingCarrier: "AA",
            origin: "BOG",
            destination: "MVD",
            departureAt: secondDepartureDate,
            arrivalAt: secondArrivalDate,
          },
          {
            flightNumber: "AA 307",
            marketingCarrier: "AA",
            origin: "MVD",
            destination: "MIA",
            departureAt: thirdDepartureDate,
            arrivalAt: thirdArrivalDate,
          },
        ],
      },
      {
        direction: "inbound",
        durationMinutes: 470,
        stops: 0,
        segments: [
          {
            flightNumber: "AA 456",
            marketingCarrier: "AA",
            origin: "MIA",
            destination: "LIM",
            departureAt: "2026-04-22T15:00:00Z",
            arrivalAt: "2026-04-22T22:50:00Z",
          },
        ],
      },
    ],
  });
}

export function buildRoundTripLayoverOffer(id: string, outboundLayoverMinutes: number, inboundLayoverMinutes: number) {
  const outboundDepartureAt = "2026-04-15T08:00:00Z";
  const outboundFirstArrival = "2026-04-15T12:00:00Z";
  const outboundSecondDeparture = new Date(Date.parse(outboundFirstArrival) + outboundLayoverMinutes * 60000).toISOString();
  const outboundSecondArrival = new Date(Date.parse(outboundSecondDeparture) + 240 * 60000).toISOString();
  const inboundDepartureAt = "2026-04-22T10:00:00Z";
  const inboundFirstArrival = "2026-04-22T14:00:00Z";
  const inboundSecondDeparture = new Date(Date.parse(inboundFirstArrival) + inboundLayoverMinutes * 60000).toISOString();
  const inboundSecondArrival = new Date(Date.parse(inboundSecondDeparture) + 240 * 60000).toISOString();

  return buildOffer({
    id,
    comparisonMetrics: {
      totalDurationMinutes: 960 + outboundLayoverMinutes + inboundLayoverMinutes,
      totalStops: 2,
    },
    itineraries: [
      {
        direction: "outbound",
        durationMinutes: 480 + outboundLayoverMinutes,
        stops: 1,
        layoverMinutes: [outboundLayoverMinutes],
        segments: [
          {
            flightNumber: "LA 201",
            marketingCarrier: "LA",
            origin: "LIM",
            destination: "BOG",
            departureAt: outboundDepartureAt,
            arrivalAt: outboundFirstArrival,
          },
          {
            flightNumber: "LA 305",
            marketingCarrier: "LA",
            origin: "BOG",
            destination: "MIA",
            departureAt: outboundSecondDeparture,
            arrivalAt: outboundSecondArrival,
          },
        ],
      },
      {
        direction: "inbound",
        durationMinutes: 480 + inboundLayoverMinutes,
        stops: 1,
        layoverMinutes: [inboundLayoverMinutes],
        segments: [
          {
            flightNumber: "LA 456",
            marketingCarrier: "LA",
            origin: "MIA",
            destination: "BOG",
            departureAt: inboundDepartureAt,
            arrivalAt: inboundFirstArrival,
          },
          {
            flightNumber: "LA 457",
            marketingCarrier: "LA",
            origin: "BOG",
            destination: "LIM",
            departureAt: inboundSecondDeparture,
            arrivalAt: inboundSecondArrival,
          },
        ],
      },
    ],
  });
}
