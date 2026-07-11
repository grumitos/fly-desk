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
  assert.match(text, /COTIZACIÓN BOLETO AÉREO ✈️\n\n✈️ Ruta:/);
  assert.match(text, /Aerolíneas: Aerolíneas Argentinas \+ LATAM\n\n🛫 IDA/);
  assert.match(text, /🛫 IDA\nLIM · 11 abril · 02:45 am\nAEP · 11 abril · 09:05 am/);
  assert.match(text, /🛬 RETORNO\nAEP · 10 mayo · 10:35 pm\nLIM · 11 mayo · 01:30 am/);
  assert.doesNotMatch(text, /🔁 Escalas ida: Sin escalas/);
  assert.doesNotMatch(text, /🔁 Escalas retorno: Sin escalas/);
  assert.match(text, /✅ INCLUYE\n\* Boleto de ida y vuelta\n\* Equipaje incluido: mochila o artículo personal y maleta de mano/);
  assert.match(text, /🚫 NO INCLUYE\n\* Maleta de bodega/);
  assert.match(text, /📋 CONDICIONES\n- Reembolsos no permitidos después de emitir\n\* Cambios de nombre no permitidos\n\* Cambios de fecha y ruta sujetos a condiciones de la tarifa/);
  assert.match(text, /💵 PRECIO:\nUS\$ 1,799 por adulto/);
  assert.doesNotMatch(text, /S\/|aprox|Tipo de cambio|Fuente|Fecha/);
  assert.deepEqual(text.split("\n").filter((line) => line.endsWith(".")), []);
  assert.doesNotMatch(text, /Sin Maleta Facturada/);
  assert.doesNotMatch(text, /DETALLE TECNICO/);
  assert.doesNotMatch(text, /\[Aquí no se coloca nada de momento, el agente decide\]/);
});

test("commercial quotation preserves each provider segment wall-clock by default", () => {
  const request = buildRequest();
  request.tripType = "one-way";
  request.legs[0] = {
    origin: "LIM",
    destination: "MAD",
    originLabel: "LIM - Lima, Peru",
    destinationLabel: "MAD - Madrid, España",
    departureDate: "2026-06-01",
  };

  const text = buildCommercialQuotation(buildOffer({
    origin: "LIM",
    destination: "MAD",
    itineraries: [{
      direction: "outbound",
      durationMinutes: 720,
      stops: 0,
      segments: [{
        marketingCarrier: "IB",
        flightNumber: "IB 6650",
        origin: "LIM",
        destination: "MAD",
        departureAt: "2026-06-01T10:00:00-05:00",
        arrivalAt: "2026-06-02T06:00:00+02:00",
      }],
    }],
  }), request);

  assert.match(text, /LIM · 01 junio · 10:00 am/);
  assert.match(text, /MAD · 02 junio · 06:00 am/);
});

test("commercial quotation uses city names for IATA-only endpoints and omits direct-flight stop lines", () => {
  const request = buildRequest();
  request.legs[0] = {
    ...request.legs[0],
    origin: "LIM",
    destination: "CUZ",
    originLabel: "LIM",
    destinationLabel: "CUZ",
  };

  const text = buildCommercialQuotation(buildOffer({
    origin: "LIM",
    destination: "CUZ",
    itineraries: [
      {
        direction: "outbound",
        durationMinutes: 85,
        stops: 0,
        segments: [
          {
            flightNumber: "JA 7031",
            marketingCarrier: "JA",
            marketingCarrierName: "Jetsmart Airlines",
            origin: "LIM",
            destination: "CUZ",
            departureAt: "2026-10-01T11:45:00Z",
            arrivalAt: "2026-10-01T13:11:00Z",
            durationMinutes: 86,
          },
        ],
      },
      {
        direction: "inbound",
        durationMinutes: 93,
        stops: 0,
        segments: [
          {
            flightNumber: "JA 7032",
            marketingCarrier: "JA",
            marketingCarrierName: "Jetsmart Airlines",
            origin: "CUZ",
            destination: "LIM",
            departureAt: "2026-10-04T12:42:00Z",
            arrivalAt: "2026-10-04T14:15:00Z",
            durationMinutes: 93,
          },
        ],
      },
    ],
  }), request, {
    timeZone: "UTC",
  });

  assert.match(text, /✈️ Ruta: Lima \(LIM\) - Cusco \(CUZ\) - Lima \(LIM\)/);
  assert.match(text, /JetSmart/);
  assert.doesNotMatch(text, /Jetsmart Airlines|JetSmart Airlines/);
  assert.doesNotMatch(text, /Escalas ida|Escalas retorno|Sin escalas/);
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

  assert.match(text, /🛫 IDA\nLIM · 20 mayo · 08:00 pm\nBIO · 21 mayo · 11:00 am/);
  assert.match(text, /🔁 Escalas ida: 1 escala en MAD/);
  assert.match(text, /Equipaje incluido: mochila o artículo personal, maleta de mano y 1 maleta de bodega de 23kg/);
  assert.match(text, /💵 PRECIO:\nUS\$ 512 por adulto/);
});

test("domestic commercial quotation uses soles only when an exchange rate exists", () => {
  const request = buildRequest();
  request.legs[0] = {
    ...request.legs[0],
    origin: "LIM",
    destination: "CUZ",
    originLabel: "LIM - Lima, Perú",
    destinationLabel: "CUZ - Cusco, Perú",
  };

  const text = buildCommercialQuotation(buildOffer({
    origin: "LIM",
    destination: "CUZ",
    itineraries: [
      {
        direction: "outbound",
        durationMinutes: 85,
        stops: 0,
        segments: [
          {
            flightNumber: "JA 7031",
            marketingCarrier: "JA",
            origin: "LIM",
            destination: "CUZ",
            departureAt: "2026-10-01T11:45:00Z",
            arrivalAt: "2026-10-01T13:11:00Z",
            durationMinutes: 86,
          },
        ],
      },
      {
        direction: "inbound",
        durationMinutes: 93,
        stops: 0,
        segments: [
          {
            flightNumber: "JA 7032",
            marketingCarrier: "JA",
            origin: "CUZ",
            destination: "LIM",
            departureAt: "2026-10-04T12:42:00Z",
            arrivalAt: "2026-10-04T14:15:00Z",
            durationMinutes: 93,
          },
        ],
      },
    ],
  }), request, {
    timeZone: "UTC",
    usdToPenRateInfo: {
      rate: 3.61,
      sourceLabel: "Agil",
      date: "2026-04-07",
    },
  });

  assert.match(text, /S\/ 1,848\.32 por adulto/);
  assert.doesNotMatch(text, /US\$|aprox|Tipo de cambio|Fuente|Fecha/);
});

test("international commercial quotation uses dollars only even when an exchange rate exists", () => {
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
    usdToPenRateInfo: {
      rate: 3.61,
      sourceLabel: "Agil",
      date: "2026-04-07",
    },
  });

  assert.match(text, /US\$ 512 por adulto/);
  assert.doesNotMatch(text, /S\//);
  assert.doesNotMatch(text, /aprox|Tipo de cambio|Fuente|Fecha/);
});

test("adult-only multi-passenger commercial quotation keeps per-adult price above total", () => {
  const request = buildRequest();
  request.passengers = {
    adults: 3,
    children: 0,
    infants: 0,
  };

  const text = buildCommercialQuotation(buildOffer({
    price: {
      total: {
        amount: 1361.14,
        currencyCode: "USD",
      },
      base: {
        amount: 1120,
        currencyCode: "USD",
      },
      taxes: {
        amount: 241.14,
        currencyCode: "USD",
      },
    },
  }), request, {
    timeZone: "UTC",
    usdToPenRateInfo: {
      rate: 3.61,
      sourceLabel: "Agil",
      date: "2026-04-07",
    },
  });

  assert.match(text, /💵 PRECIO:\nUS\$ 453\.71 por adulto\nTotal: US\$ 1,361\.14/);
  assert.doesNotMatch(text, /S\/|aprox|Tipo de cambio|Fuente|Fecha/);
});

test("mixed-passenger commercial quotation shows total instead of average adult fare", () => {
  const request = buildRequest();
  request.passengers = {
    adults: 1,
    children: 1,
    infants: 1,
  };

  const text = buildCommercialQuotation(buildOffer({
    price: {
      total: {
        amount: 1361.14,
        currencyCode: "USD",
      },
      base: {
        amount: 1120,
        currencyCode: "USD",
      },
      taxes: {
        amount: 241.14,
        currencyCode: "USD",
      },
    },
  }), request, {
    timeZone: "UTC",
    usdToPenRateInfo: {
      rate: 3.61,
      sourceLabel: "Agil",
      date: "2026-04-07",
    },
  });

  assert.match(text, /💵 PRECIO:\nTotal: US\$ 1,361\.14/);
  assert.doesNotMatch(text, /US\$ 453\.71 por adulto|por adulto\nTotal: US\$ 1,361\.14/);
  assert.doesNotMatch(text, /S\/|aprox|Tipo de cambio|Fuente|Fecha/);
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

test("migration package keeps the quotation structure and adds only its explicit differences", () => {
  const request = buildRequest();
  request.tripType = "one-way";
  request.legs[0] = {
    origin: "LIM",
    destination: "MAD",
    originLabel: "LIM - Lima, Perú",
    destinationLabel: "MAD - Madrid, España",
    destinationCountryCode: "ES",
    departureDate: "2026-07-01",
  };
  const offer = buildOffer({
    origin: "LIM",
    destination: "MAD",
    itineraries: [{
      direction: "outbound",
      durationMinutes: 660,
      stops: 0,
      segments: [{
        flightNumber: "IB 6659",
        marketingCarrier: "IB",
        marketingCarrierName: "Iberia",
        origin: "LIM",
        originName: "Lima",
        destination: "MAD",
        destinationName: "Madrid",
        departureAt: "2026-07-01T11:00:00-05:00",
        arrivalAt: "2026-07-02T05:40:00+02:00",
      }],
    }],
  });

  const standard = buildCommercialQuotation(offer, request, { timeZone: "UTC" });
  const migration = buildCommercialQuotation(offer, request, { timeZone: "UTC", migrationPlan: true });

  assert.match(migration, /^PAQUETE MIGRATORIO MADRID 🇪🇸\n\n✈️ Ruta:/);
  assert.match(migration, /✅ INCLUYE\n\* Boleto de ida \+ retorno de apoyo anulable/);
  assert.match(migration, /\* Seguro de viaje Transitorio/);
  assert.match(migration, /\* Reserva de Alojamiento Transitorio/);
  assert.match(migration, /\* Itinerario completo/);
  assert.match(migration, /\* Asesoría Integral/);
  assert.match(migration, /\* Selección de asiento no permitida; la asignación es aleatoria/);
  assert.doesNotMatch(migration, /\* Asiento según disponibilidad/);
  assert.match(standard, /^COTIZACIÓN BOLETO AÉREO ✈️/);
  assert.doesNotMatch(standard, /PAQUETE MIGRATORIO|retorno de apoyo|Seguro de viaje Transitorio|asignación es aleatoria/);

  const normalizedMigration = migration
    .replace(/^PAQUETE MIGRATORIO MADRID 🇪🇸/, "COTIZACIÓN BOLETO AÉREO ✈️")
    .replace("* Boleto de ida + retorno de apoyo anulable", "* Boleto de solo ida")
    .replace("* Check in online\n", "* Check in online\n* Asiento según disponibilidad\n")
    .replace(/^\* (?:Seguro de viaje Transitorio|Reserva de Alojamiento Transitorio|Itinerario completo|Asesoría Integral)\n/gm, "")
    .replace("\n* Selección de asiento no permitida; la asignación es aleatoria", "");
  assert.equal(normalizedMigration, standard);

  request.legs[0].destinationCountryCode = "ZZ";
  const unknownCountry = buildCommercialQuotation(offer, request, { migrationPlan: true });
  assert.match(unknownCountry, /^PAQUETE MIGRATORIO MADRID 🇪🇸/);
  assert.doesNotMatch(unknownCountry, /🇿🇿/);

  request.legs[0].destinationLabel = "MIA - Miami, Estados Unidos";
  request.legs[0].destinationCountryCode = "US";
  const inconsistentMetadata = buildCommercialQuotation(offer, request, { migrationPlan: true });
  assert.match(inconsistentMetadata, /^PAQUETE MIGRATORIO MADRID 🇪🇸/);
});

test("migration package pairs known destination cities with their country flags", () => {
  const cases = [
    { code: "MAD", city: "Madrid", flag: "🇪🇸" },
    { code: "MIA", city: "Miami", flag: "🇺🇸" },
    { code: "BOG", city: "Bogota", flag: "🇨🇴" },
  ];

  for (const destination of cases) {
    const request = buildRequest();
    request.tripType = "one-way";
    request.legs[0] = {
      origin: "LIM",
      destination: destination.code,
      departureDate: "2026-07-01",
    };
    const offer = buildOffer({
      origin: "LIM",
      destination: destination.code,
      itineraries: [{
        direction: "outbound",
        durationMinutes: 600,
        stops: 0,
        segments: [{
          flightNumber: "LA 100",
          marketingCarrier: "LA",
          origin: "LIM",
          destination: destination.code,
          departureAt: "2026-07-01T11:00:00-05:00",
          arrivalAt: "2026-07-02T05:00:00+02:00",
        }],
      }],
    });

    const text = buildCommercialQuotation(offer, request, { migrationPlan: true });
    assert.match(text, new RegExp(`^PAQUETE MIGRATORIO ${destination.city.toUpperCase()} ${destination.flag}`));
  }
});

test("migration package uses validated metadata for destinations outside the trusted IATA map", () => {
  const request = buildRequest();
  request.tripType = "one-way";
  request.legs[0] = {
    origin: "LIM",
    destination: "NRT",
    destinationLabel: "NRT - Tokio, Japón",
    destinationCountryCode: "JP",
    departureDate: "2026-07-01",
  };
  const offer = buildOffer({
    origin: "LIM",
    destination: "NRT",
    itineraries: [{
      direction: "outbound",
      durationMinutes: 1_200,
      stops: 0,
      segments: [{
        flightNumber: "LA 100",
        marketingCarrier: "LA",
        origin: "LIM",
        destination: "NRT",
        departureAt: "2026-07-01T11:00:00-05:00",
        arrivalAt: "2026-07-02T18:00:00+09:00",
      }],
    }],
  });

  const text = buildCommercialQuotation(offer, request, { migrationPlan: true });
  assert.match(text, /^PAQUETE MIGRATORIO TOKIO 🇯🇵/);
});
