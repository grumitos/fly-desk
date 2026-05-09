import { test } from "bun:test";
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
  assert.match(text, /🛫 Horario ida: LIM · 11 abril a las 02:45 am → AEP · 11 abril a las 09:05 am/);
  assert.match(text, /🔁 Escalas ida: Sin escalas/);
  assert.match(text, /🛬 Horario retorno: AEP · 10 mayo a las 10:35 pm → LIM · 11 mayo a las 01:30 am/);
  assert.match(text, /🔁 Escalas retorno: Sin escalas/);
  assert.match(text, /✅ INCLUYE\n\* Boleto de ida y vuelta\n\* Equipaje incluido: mochila o artículo personal y maleta de mano/);
  assert.match(text, /🚫 NO INCLUYE\n\* Maleta de bodega/);
  assert.match(text, /📋 CONDICIONES\n- Reembolsos no permitidos después de emitir\.\n\* Cambios de nombre no permitidos\.\n\* Cambios de fecha y ruta sujetos a condiciones de la tarifa\./);
  assert.match(text, /💵 PRECIO:\nUS\$ 1,799 por adulto\.\nS\/ 6,329 aprox\. por adulto\./);
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

test("commercial quotation includes layover cities and checked baggage weight when available", () => {
  const text = buildCommercialQuotation(buildOffer({
    baggage: {
      carryOnIncluded: true,
      checkedIncluded: true,
      checkedBags: 1,
      description: "23kg",
    },
    itineraries: [
      {
        direction: "outbound",
        durationMinutes: 780,
        stops: 1,
        layoverMinutes: [120],
        segments: [
          {
            id: "seg-1",
            marketingCarrier: "LA",
            flightNumber: "LA 2400",
            origin: "LIM",
            destination: "MAD",
            departureAt: "2026-05-20T20:00:00Z",
            arrivalAt: "2026-05-21T08:00:00Z",
            durationMinutes: 720,
          },
          {
            id: "seg-2",
            marketingCarrier: "IB",
            flightNumber: "IB 447",
            origin: "MAD",
            destination: "BIO",
            departureAt: "2026-05-21T10:00:00Z",
            arrivalAt: "2026-05-21T11:00:00Z",
            durationMinutes: 60,
          },
        ],
      },
    ],
  }), {
    ...buildRequest(),
    tripType: "one-way",
    legs: [
      {
        origin: "LIM",
        destination: "BIO",
        originLabel: "LIM - Lima, Peru",
        destinationLabel: "BIO - Bilbao, España",
        departureDate: "2026-05-20",
      },
    ],
  }, {
    timeZone: "UTC",
  });

  assert.match(text, /🛫 Horario ida: LIM · 20 mayo a las 08:00 pm → BIO · 21 mayo a las 11:00 am/);
  assert.match(text, /🔁 Escalas ida: 1 escala en MAD/);
  assert.match(text, /Equipaje incluido: mochila o artículo personal, maleta de mano y 1 maleta de bodega de 23kg/);
  assert.match(text, /💵 PRECIO:\nUS\$ 512 por adulto\./);
});

test("commercial quotation includes soles under the dollars line when an exchange rate exists", () => {
  const text = buildCommercialQuotation(buildOffer(), buildRequest(), {
    timeZone: "UTC",
    usdToPenRate: 3.61,
  });

  assert.match(text, /US\$ 512 por adulto\./);
  assert.match(text, /S\/ 1,848\.32 aprox\. por adulto\./);
});

test("commercial quotation does not include soles when LIM is not a route endpoint", () => {
  const request = buildRequest();
  request.legs[0] = {
    ...request.legs[0],
    origin: "MAD",
    destination: "BIO",
    originLabel: "MAD - Madrid, España",
    destinationLabel: "BIO - Bilbao, España",
  };

  const text = buildCommercialQuotation(buildOffer({
    origin: "MAD",
    destination: "BIO",
    itineraries: [
      {
        direction: "outbound",
        durationMinutes: 60,
        stops: 0,
        segments: [
          {
            flightNumber: "IB 447",
            marketingCarrier: "IB",
            origin: "MAD",
            destination: "BIO",
            departureAt: "2026-04-15T14:00:00Z",
            arrivalAt: "2026-04-15T15:00:00Z",
          },
        ],
      },
    ],
  }), request, {
    timeZone: "UTC",
    usdToPenRate: 3.61,
  });

  assert.match(text, /US\$ 512 por adulto\./);
  assert.doesNotMatch(text, /S\//);
});

test("commercial quotation omits all-airports labels from the route summary", () => {
  const request = buildRequest();
  request.legs[0] = {
    ...request.legs[0],
    origin: "MAD",
    destination: "LIM",
    originLabel: "MAD - Madrid (Todos Los Aeropuertos), España",
    destinationLabel: "LIM - Lima, Peru",
  };

  const text = buildCommercialQuotation(buildOffer({
    origin: "MAD",
    destination: "LIM",
    itineraries: [
      {
        direction: "outbound",
        durationMinutes: 660,
        stops: 0,
        segments: [
          {
            flightNumber: "PU 101",
            marketingCarrier: "PU",
            origin: "MAD",
            destination: "LIM",
            departureAt: "2026-05-11T11:00:00Z",
            arrivalAt: "2026-05-11T19:00:00Z",
          },
        ],
      },
      {
        direction: "inbound",
        durationMinutes: 650,
        stops: 0,
        segments: [
          {
            flightNumber: "PU 102",
            marketingCarrier: "PU",
            origin: "LIM",
            destination: "MAD",
            departureAt: "2026-06-10T18:10:00Z",
            arrivalAt: "2026-06-11T05:00:00Z",
          },
        ],
      },
    ],
  }), request, {
    timeZone: "UTC",
  });

  assert.match(text, /✈️ Ruta: Madrid \(MAD\) - Lima \(LIM\) - Madrid \(MAD\)/);
  assert.doesNotMatch(text, /Todos Los Aeropuertos|Todos los aeropuertos|todos los aeropuertos/);
});
