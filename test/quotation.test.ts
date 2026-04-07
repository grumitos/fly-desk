import test from "node:test";
import assert from "node:assert/strict";
import { buildCommercialQuotation, buildTechnicalQuotation } from "../src/core/quotation";
import type { SearchRequest } from "../src/core/types";
import { buildOffer } from "./helpers/ui-fixtures";

function buildRequest(): SearchRequest {
  return {
    tripType: "round-trip",
    searchMode: "exact",
    legs: [
      {
        origin: "LIM",
        destination: "BUE",
        originLabel: "LIM - Lima, Peru",
        destinationLabel: "BUE - Buenos Aires, Argentina",
        departureDate: "2026-04-10",
        returnDate: "2026-05-10",
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
  };
}

test("commercial quotation lists multiple airlines and moves missing baggage to exclusions", () => {
  const offer = buildOffer({
    origin: "LIM",
    destination: "BUE",
    mainCarrier: "AR",
    validatingCarrier: "AR",
    baggage: {
      carryOnIncluded: true,
      checkedIncluded: false,
      description: "Sin maleta facturada",
    },
    itineraries: [
      {
        direction: "outbound",
        durationMinutes: 260,
        stops: 0,
        segments: [
          {
            id: "seg-1",
            marketingCarrier: "AR",
            marketingCarrierName: "Aerolineas Argentinas",
            flightNumber: "1365",
            origin: "LIM",
            originName: "Lima",
            destination: "AEP",
            destinationName: "Buenos Aires",
            departureAt: "2026-04-11T02:45:00Z",
            arrivalAt: "2026-04-11T09:05:00Z",
            durationMinutes: 260,
          },
        ],
      },
      {
        direction: "inbound",
        durationMinutes: 295,
        stops: 0,
        segments: [
          {
            id: "seg-2",
            marketingCarrier: "LA",
            flightNumber: "2381",
            origin: "AEP",
            originName: "Buenos Aires",
            destination: "LIM",
            destinationName: "Lima",
            departureAt: "2026-05-10T22:35:00Z",
            arrivalAt: "2026-05-11T01:30:00Z",
            durationMinutes: 295,
          },
        ],
      },
    ],
  });

  const text = buildCommercialQuotation(offer, buildRequest());

  assert.match(text, /COTIZACIÓN BOLETO AÉREO ✈️/);
  assert.match(text, /✈️ Ruta: Lima \(LIM\) - Buenos Aires \(BUE\) - Lima \(LIM\)/);
  assert.match(text, /✈️ Aerolíneas: Aerolíneas Argentinas \+ LATAM/);
  assert.match(text, /✅ INCLUYE\n\* Boleto de ida y vuelta\n\* Equipaje de mano/);
  assert.match(text, /🚫 NO INCLUYE\n\* Maleta facturada/);
  assert.match(text, /📋 CONDICIONES\n\* Cambios de nombre no permitidos\./);
  assert.match(text, /💵 PRECIO:\n\n\$ ______ dólares por adulto\nS\/\. ______ soles por adulto/);
  assert.doesNotMatch(text, /Sin Maleta Facturada/);
  assert.doesNotMatch(text, /DETALLE TECNICO/);
  assert.doesNotMatch(text, /\[Aquí no se coloca nada de momento, el agente decide\]/);
});

test("technical quotation reflects mixed carrier codes", () => {
  const offer = buildOffer({
    mainCarrier: "AR",
    validatingCarrier: "AR",
    itineraries: [
      {
        direction: "outbound",
        durationMinutes: 260,
        stops: 0,
        segments: [
          {
            id: "seg-1",
            marketingCarrier: "AR",
            flightNumber: "1365",
            origin: "LIM",
            destination: "AEP",
            departureAt: "2026-04-11T02:45:00Z",
            arrivalAt: "2026-04-11T09:05:00Z",
            durationMinutes: 260,
          },
        ],
      },
      {
        direction: "inbound",
        durationMinutes: 295,
        stops: 0,
        segments: [
          {
            id: "seg-2",
            marketingCarrier: "LA",
            flightNumber: "2381",
            origin: "AEP",
            destination: "LIM",
            departureAt: "2026-05-10T22:35:00Z",
            arrivalAt: "2026-05-11T01:30:00Z",
            durationMinutes: 295,
          },
        ],
      },
    ],
  });

  const text = buildTechnicalQuotation(offer, buildRequest());
  assert.match(text, /AEROLINEAS: AR \/ LA/);
});
