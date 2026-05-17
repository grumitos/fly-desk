import { test } from "bun:test";
import assert from "node:assert/strict";
import { startSearch } from "../frontend/src/lib/api";
import { buildResultCardModel } from "../frontend/src/components/results/result-card-model";
import { buildOfferDetailSummary, formatOfferDateTime } from "../frontend/src/lib/offer-display";
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

test("card and detail use the same full connecting route and stop label", () => {
  const offer = connectingOffer();
  const card = buildResultCardModel(offer, 1);
  const detail = buildOfferDetailSummary(offer);

  assert.equal(card.route, "LIM - PTY - MIA");
  assert.equal(detail.routeLabel, card.route);
  assert.equal(card.stops.label, "1 escala · Ciudad de Panama");
  assert.equal(detail.stopsLabel, card.stops.label);
});

test("detail display derives baggage and preserves provider-local ISO offset times", () => {
  const offer = connectingOffer();
  const detail = buildOfferDetailSummary(offer);

  assert.equal(formatOfferDateTime("2026-06-08T23:50:00+02:00"), "08/06, 23:50");
  assert.equal(detail.departureDateTime, "08/06, 23:50");
  assert.equal(detail.baggageLabel, "Cabina + 2 maletas");
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
        label: "Buscar en Costamar",
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
  const blocked = buildResultCardModel(costamarCardOffer(redirectVerification(false, "blocked", "Token vencido")), 1);

  assert.deepEqual(verified.costamarRedirect, {
    label: "Redirect verificado",
    title: "El enlace de Costamar fue validado antes de mostrar la oferta.",
    tone: "verified",
  });
  assert.equal(pending.costamarRedirect?.label, "Redirect pendiente");
  assert.equal(pending.costamarRedirect?.title, "Validación en curso");
  assert.equal(blocked.costamarRedirect?.label, "Redirect bloqueado");
  assert.equal(blocked.costamarRedirect?.title, "Token vencido");
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
