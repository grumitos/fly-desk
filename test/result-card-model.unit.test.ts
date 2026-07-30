import { test } from "bun:test";
import assert from "node:assert/strict";
import { startSearch } from "../frontend/src/lib/api";
import {
  buildAlternateScheduleModel,
  buildResultCardModel,
} from "../frontend/src/components/results/result-card-model";
import type { CanonicalOffer, RedirectVerification } from "../frontend/src/types";

function connectingOffer(): CanonicalOffer {
  return {
    id: "connecting-offset",
    providerSource: "agil-local",
    airline: "Copa Airlines",
    mainCarrier: "CM",
    validatingCarrier: "CM",
    departureDate: "2026-06-08T23:50:00+02:00",
    duration: "8h 15m",
    stops: 0,
    comparisonMetrics: {
      totalDurationMinutes: 495,
      totalStops: 0,
    },
    baggage: {
      carryOnIncluded: true,
      checkedIncluded: true,
      checkedBags: 2,
    },
    price: {
      total: { amount: 512, currencyCode: "USD" },
    },
    itineraries: [
      {
        direction: "outbound",
        durationMinutes: 495,
        stops: 0,
        layoverMinutes: [90],
        segments: [
          {
            flightNumber: "CM 100",
            marketingCarrier: "CM",
            origin: "LIM",
            destination: "PTY",
            departureAt: "2026-06-08T23:50:00+02:00",
            arrivalAt: "2026-06-09T03:30:00+02:00",
          },
          {
            flightNumber: "CM 200",
            marketingCarrier: "CM",
            origin: "PTY",
            destination: "MIA",
            departureAt: "2026-06-09T05:00:00+02:00",
            arrivalAt: "2026-06-09T08:05:00+02:00",
          },
        ],
      },
    ],
  } as CanonicalOffer;
}

test("search normalization keeps the final outbound destination and segment-derived stops", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    searchJobId: "connecting-search",
    searchComplete: true,
    searchStatus: "completed",
    revision: 1,
    sortMode: "cheapest",
    request: {
      tripType: "one-way",
      searchMode: "exact",
      legs: [{ origin: "LIM", destination: "MIA", departureDate: "2026-06-08" }],
      passengers: { adults: 1, children: 0, infants: 0 },
      filters: {},
    },
    offers: [connectingOffer()],
    allOffers: [],
    searchMeta: {
      requestedAt: "2026-06-01T00:00:00.000Z",
      completedAt: "2026-06-01T00:00:00.000Z",
      providersUsed: ["agil-local"],
      warnings: [],
      partial: false,
      searchState: "search_live",
    },
    providerMeta: {
      exactProvider: "agil-local",
      coverageMode: "core",
    },
    warnings: [],
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })) as typeof fetch;

  try {
    const job = await startSearch({
      origin: "LIM",
      destination: "MIA",
      departureDate: "2026-06-08",
      tripType: "one-way",
      adults: 1,
      children: 0,
      infants: 0,
      searchMode: "exact",
    }, "cheapest");
    const offer = job.offers[0];

    assert.equal(offer.destination, "MIA");
    assert.equal(offer.arrivalDate, "2026-06-09T08:05:00+02:00");
    assert.equal(offer.stops, 1);
    assert.equal(offer.stopMeta, "LIM - PTY - MIA");
    assert.equal(offer.baggageLabel, "Cabina + 2 maletas");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the card names the stop by airport and omits the redundant route column", () => {
  const offer = connectingOffer();
  const card = buildResultCardModel(offer, 1);

  // Plate 1b drops the "Ruta" column: it restated the origin and destination
  // that were typed into the search.
  assert.equal(Object.hasOwn(card, "route"), false);

  // Stops are per leg and named by airport, so the agent reads where the stop is
  // without opening anything.
  assert.equal(card.legs.length, 1);
  assert.equal(card.legs[0].stopsLabel, "1 escala en PTY");
  assert.equal(card.legs[0].stopsTone, "one-stop");
});

test("duration and stops are per leg, not summed across the trip", () => {
  const outbound = connectingOffer();
  const roundTrip = buildResultCardModel({
    ...outbound,
    returnDate: "2026-06-15",
    itineraries: [
      ...(outbound.itineraries ?? []),
      {
        id: "in-1",
        direction: "inbound",
        durationMinutes: 695,
        stops: 0,
        layoverMinutes: [],
        segments: [{
          id: "in-seg-1",
          marketingCarrier: "CM",
          flightNumber: "802",
          origin: "MIA",
          destination: "LIM",
          departureAt: "2026-06-15T16:35:00-04:00",
          arrivalAt: "2026-06-16T04:10:00-05:00",
          durationMinutes: 695,
        }],
      },
    ],
  }, 1);

  assert.equal(roundTrip.legs.length, 2);
  assert.equal(roundTrip.legs[0].label, "Ida");
  assert.equal(roundTrip.legs[1].label, "Vta");
  // The old card added the two together and printed a total that matches no
  // flight the agent is about to sell.
  assert.notEqual(roundTrip.legs[0].duration, roundTrip.legs[1].duration);
  assert.equal(roundTrip.legs[1].stopsLabel, "Directo");
  assert.equal(roundTrip.legs[1].stopsTone, "direct");
  // A flight that lands the next day gets its own lane, so the arrival time
  // never shifts left to make room for the "+1".
  assert.equal(roundTrip.legs[1].dayOffset, "+1");
});

test("alternate schedule model names the inbound leg when only the return changes", () => {
  const outbound = connectingOffer();
  const current = {
    ...outbound,
    id: "round-trip-current",
    returnDate: "2026-06-15",
    itineraries: [
      ...(outbound.itineraries ?? []),
      {
        id: "in-current",
        direction: "inbound" as const,
        durationMinutes: 360,
        stops: 0,
        segments: [{
          id: "in-current-segment",
          marketingCarrier: "CM",
          flightNumber: "802",
          origin: "MIA",
          destination: "LIM",
          departureAt: "2026-06-15T17:30:00-04:00",
          arrivalAt: "2026-06-15T23:30:00-05:00",
          durationMinutes: 360,
        }],
      },
    ],
  } as CanonicalOffer;
  const alternate = {
    ...current,
    id: "round-trip-alternate",
    itineraries: current.itineraries?.map((itinerary) => itinerary.direction === "inbound"
      ? {
          ...itinerary,
          id: "in-alternate",
          durationMinutes: 390,
          segments: itinerary.segments.map((segment) => ({
            ...segment,
            id: "in-alternate-segment",
            flightNumber: "804",
            departureAt: "2026-06-15T20:15:00-04:00",
            arrivalAt: "2026-06-16T02:45:00-05:00",
            durationMinutes: 390,
          })),
        }
      : itinerary),
  } as CanonicalOffer;

  assert.deepEqual(buildAlternateScheduleModel(alternate, current), {
    legAriaLabel: "Vuelta",
    time: "20:15",
    meta: "6h 30m",
  });
});

test("card model never labels a missing itinerary as a direct flight", () => {
  const card = buildResultCardModel({
    ...connectingOffer(),
    itineraries: undefined,
  }, 1);

  assert.equal(card.legs[0]?.duration, "--");
  assert.equal(card.legs[0]?.stopsLabel, "Escalas por confirmar");
  assert.equal(card.legs[0]?.stopsTitle, "No hay itinerario para confirmar las escalas");
  assert.equal(card.legs[0]?.stopsTone, "unknown");
});

test("card model omits an inbound row when returnDate has no real inbound itinerary", () => {
  const card = buildResultCardModel({
    ...connectingOffer(),
    returnDate: "2026-06-15",
  }, 1);

  assert.deepEqual(card.legs.map((leg) => leg.ariaLabel), ["Ida"]);
  assert.equal(card.tripType, "one-way");
});

test("card model omits a per-person average when the passenger mix has no real breakdown", () => {
  const card = buildResultCardModel(connectingOffer(), 3, { showPerPerson: false });

  assert.equal(card.price.perPersonLabel, "");
  assert.doesNotMatch(card.price.ariaLabel, /por persona/i);
});

test("seats remaining only appear when there are few enough to act on", () => {
  const offer = connectingOffer();

  assert.equal(buildResultCardModel(offer, 1).seats, null);
  assert.equal(
    buildResultCardModel({ ...offer, fareMeta: { seatsRemaining: 9 } }, 1).seats,
    null,
  );
  assert.deepEqual(
    buildResultCardModel({ ...offer, fareMeta: { seatsRemaining: 4 } }, 1).seats,
    { label: "4 asientos", urgency: "low" },
  );
  assert.deepEqual(
    buildResultCardModel({ ...offer, fareMeta: { seatsRemaining: 1 } }, 1).seats,
    { label: "1 asiento", urgency: "critical" },
  );
  assert.deepEqual(
    buildResultCardModel({ ...offer, fareMeta: { seatsRemaining: 0 } }, 1).seats,
    { label: "0 asientos", urgency: "critical" },
  );
});

test("card model resolves square Click and Book airline logo assets by carrier IATA code", () => {
  const offer = connectingOffer();
  const card = buildResultCardModel({
    ...offer,
    airline: "LATAM Airlines",
    mainCarrier: "LA",
    validatingCarrier: "LA",
    itineraries: offer.itineraries?.map((itinerary) => ({
      ...itinerary,
      segments: itinerary.segments.map((segment) => ({
        ...segment,
        marketingCarrier: "LA",
        marketingCarrierName: "LATAM Airlines",
      })),
    })),
  }, 1);

  assert.equal(card.carrier.code, "LA");
  assert.equal(card.carrier.logo, "/assets/airline-icons/LA.png");
});

test("card model derives baggage and preserves provider-local ISO offset times", () => {
  const offer = connectingOffer();
  const card = buildResultCardModel(offer, 1);

  assert.equal(card.legs[0].departureTime, "23:50");
  assert.equal(card.baggage.label, "mano + bodega");
});

test("card model does not invent missing baggage evidence", () => {
  const withoutBaggage = buildResultCardModel({
    ...connectingOffer(),
    baggage: undefined,
  }, 1);
  const withUnknownPieces = buildResultCardModel({
    ...connectingOffer(),
    baggage: {
      carryOnIncluded: undefined,
      checkedIncluded: undefined,
    },
  }, 1);

  assert.deepEqual(withoutBaggage.baggage, {
    carryOnIncluded: undefined,
    checkedIncluded: undefined,
    label: "",
    ariaLabel: "",
  });
  assert.deepEqual(withUnknownPieces.baggage, withoutBaggage.baggage);
});

test("card model exposes only explicit baggage inclusion evidence", () => {
  const card = buildResultCardModel({
    ...connectingOffer(),
    baggage: {
      carryOnIncluded: true,
      checkedIncluded: undefined,
    },
  }, 1);

  assert.deepEqual(card.baggage, {
    carryOnIncluded: true,
    checkedIncluded: undefined,
    label: "mano",
    ariaLabel: "Equipaje de mano incluido",
  });
});

test("card model preserves explicit baggage exclusion evidence", () => {
  const card = buildResultCardModel({
    ...connectingOffer(),
    baggage: {
      carryOnIncluded: false,
      checkedIncluded: false,
    },
  }, 1);

  assert.deepEqual(card.baggage, {
    carryOnIncluded: false,
    checkedIncluded: false,
    label: "mano: no incluido + bodega: no incluido",
    ariaLabel: "Equipaje de mano no incluido, Equipaje de bodega no incluido",
  });
});

function redirectVerification(verified: boolean, state: RedirectVerification["state"], reason?: string): RedirectVerification {
  return {
    provider: "costamar",
    verified,
    state,
    reason,
    checkedAt: "2026-06-01T12:00:00.000Z",
  };
}

function costamarCardOffer(verification: RedirectVerification): CanonicalOffer {
  return {
    id: `costamar-${verification.state}`,
    providerSource: "costamar",
    airline: "LATAM Airlines",
    origin: "LIM",
    destination: "MIA",
    departureDate: "2026-06-08T10:00:00-05:00",
    duration: "6h",
    stops: 0,
    redirectVerification: verification,
    purchasePaths: [
      {
        id: "path-costamar",
        provider: "costamar",
        type: "search-redirect",
        label: "Buscar en Click and Book Plus",
        url: "https://app.costamar.com/search",
        precision: "search-equivalent",
        state: "available",
        commercialMode: "redirect",
        redirectVerification: verification,
      },
    ],
    price: {
      total: { amount: 500, currencyCode: "USD" },
    },
  } as CanonicalOffer;
}

test("Costamar card model communicates redirect verification status", () => {
  const verified = buildResultCardModel(costamarCardOffer(redirectVerification(true, "verified")), 1);
  const pending = buildResultCardModel(costamarCardOffer(redirectVerification(false, "pending", "Validación en curso")), 1);
  const blocked = buildResultCardModel(costamarCardOffer(redirectVerification(
    false,
    "blocked",
    "No se pudo abrir https://evil.example/redirect?token=secret-token",
  )), 1);

  assert.deepEqual(verified.costamarRedirect, {
    label: "Redirect verificado",
    title: "El enlace de Click and Book Plus fue validado antes de mostrar la oferta.",
    tone: "verified",
  });
  assert.equal(verified.provider.icon, "/assets/provider-icons/click-and-book-plus-128.png");
  assert.equal(pending.costamarRedirect, undefined);
  assert.equal(blocked.costamarRedirect?.label, "Redirect bloqueado");
  assert.equal(
    blocked.costamarRedirect?.title,
    "Click and Book Plus no devolvió un redirect usable para esta búsqueda.",
  );
  assert.equal(blocked.costamarRedirect?.title.includes("secret-token"), false);
});

test("Agil card model does not show Costamar redirect status", () => {
  const offer = {
    ...costamarCardOffer(redirectVerification(true, "verified")),
    id: "agil-offer",
    providerSource: "agil-local",
    redirectVerification: undefined,
    purchasePaths: [
      {
        id: "path-agil",
        provider: "agil-local",
        type: "search-redirect",
        label: "Buscar en Agil",
        url: "/r/path-agil",
        precision: "search-equivalent",
        state: "available",
        commercialMode: "redirect",
      },
    ],
  } as CanonicalOffer;

  assert.equal(buildResultCardModel(offer, 1).costamarRedirect, undefined);
});

test("Agil grouped card keeps Agil badge and hides Costamar redirect status", () => {
  const verification = redirectVerification(false, "pending", "Validación en curso");
  const offer = {
    ...costamarCardOffer(verification),
    id: "agil-grouped-offer",
    providerSource: "agil-local",
    redirectVerification: undefined,
    purchasePaths: [
      {
        id: "path-agil",
        provider: "agil-local",
        type: "search-redirect",
        label: "Buscar en Agil",
        url: "/r/path-agil",
        precision: "search-equivalent",
        state: "available",
        commercialMode: "redirect",
      },
      {
        id: "path-costamar",
        provider: "costamar",
        type: "search-redirect",
        label: "Buscar en Click and Book Plus",
        url: "https://app.costamar.com/search",
        precision: "search-equivalent",
        state: "available",
        commercialMode: "redirect",
        redirectVerification: verification,
      },
    ],
  } as CanonicalOffer;

  const model = buildResultCardModel(offer, 1);

  assert.equal(model.provider.label, "Agilsmart");
  assert.equal(model.provider.shortLabel, "AG");
  assert.equal(model.costamarRedirect, undefined);
});
