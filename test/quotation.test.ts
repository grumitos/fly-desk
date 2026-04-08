import test from "node:test";
import assert from "node:assert/strict";
import { buildCommercialQuotation } from "../src/core/quotation";
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
    price: {
      total: {
        amount: 1799,
        currencyCode: "USD",
      },
      base: {
        amount: 1600,
        currencyCode: "USD",
      },
      taxes: {
        amount: 199,
        currencyCode: "USD",
      },
    },
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

  const text = buildCommercialQuotation(offer, buildRequest(), {
    timeZone: "UTC",
    usdToPenRate: 6329 / 1799,
  });

  assert.match(text, /COTIZACIÓN BOLETO AÉREO ✈️/);
  assert.match(text, /✈️ Ruta: Lima \(LIM\) - Buenos Aires \(BUE\) - Lima \(LIM\)/);
  assert.match(text, /✈️ Aerolíneas: Aerolíneas Argentinas \+ LATAM/);
  assert.match(text, /🛫 Horario ida: LIM · 11 abril a las 02:45 am/);
  assert.match(text, /🛬 Horario retorno: AEP · 10 mayo a las 10:35 pm/);
  assert.match(text, /✅ INCLUYE\n\* Boleto de ida y vuelta\n\* Equipaje incluido: mochila o artículo personal y maleta de mano/);
  assert.match(text, /🚫 NO INCLUYE\n\* Maleta de bodega/);
  assert.match(text, /📋 CONDICIONES\n- Reembolsos no permitidos después de emitir\.\n\* Cambios de nombre no permitidos\.\n\* Cambios de fecha y ruta sujetos a condiciones de la tarifa\./);
  assert.match(text, /💵 PRECIO:\n\nUS\$ 1,799 o S\/ 6,329 soles por adulto/);
  assert.doesNotMatch(text, /Sin Maleta Facturada/);
  assert.doesNotMatch(text, /DETALLE TECNICO/);
  assert.doesNotMatch(text, /\[Aquí no se coloca nada de momento, el agente decide\]/);
});

test("commercial quotation lists both hand and checked baggage as exclusions when neither is included", () => {
  const text = buildCommercialQuotation(buildOffer({
    baggage: {
      carryOnIncluded: false,
      checkedIncluded: false,
      description: "Sin equipaje incluido",
    },
  }), buildRequest(), {
    timeZone: "UTC",
  });

  assert.doesNotMatch(text, /Equipaje incluido:/);
  assert.match(text, /🚫 NO INCLUYE\n\* Maleta de mano\n\* Maleta de bodega/);
});

test("commercial quotation keeps only the dollars line when the exchange rate is unavailable", () => {
  const text = buildCommercialQuotation(buildOffer(), buildRequest(), {
    timeZone: "UTC",
  });

  assert.match(text, /US\$ 512 por adulto/);
  assert.doesNotMatch(text, / o S\//);
});
