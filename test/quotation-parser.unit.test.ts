import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  MAX_COMMERCIAL_QUOTATION_CHARS,
  parseCommercialQuotation,
} from "../src/core/quotation-parser";

test("current round-trip quotation yields only unambiguous search fields and trace metadata", () => {
  const quotation = [
    "COTIZACIÓN BOLETO AÉREO ✈️",
    "",
    "✈️ Ruta: Lima (LIM) - Buenos Aires (BUE) - Lima (LIM)",
    "✈️ Aerolíneas: Aerolíneas Argentinas + LATAM",
    "",
    "🛫 IDA",
    "LIM · 11 abril · 02:45 am",
    "AEP · 11 abril · 09:05 am",
    "",
    "🛬 RETORNO",
    "AEP · 10 mayo · 10:35 pm",
    "LIM · 11 mayo · 01:30 am",
    "🔁 Escalas retorno: 1 escala en SCL",
    "",
    "✅ INCLUYE",
    "* Boleto de ida y vuelta",
    "",
    "💵 PRECIO:",
    "US$ 1,799 por adulto",
  ].join("\r\n");

  const result = parseCommercialQuotation(quotation);

  assert.deepEqual(result.request, {
    tripType: "round-trip",
    legs: [{ origin: "LIM", destination: "BUE" }],
  });
  assert.deepEqual(result.fields.origin, {
    state: "parsed",
    value: "LIM",
    source: { line: 3, label: "route" },
  });
  assert.deepEqual(result.fields.destination, {
    state: "parsed",
    value: "BUE",
    source: { line: 3, label: "route" },
  });
  assert.equal(result.fields.tripType.state, "parsed");
  assert.equal(result.fields.departureDate.state, "ambiguous");
  assert.deepEqual(result.fields.departureDate.source, { line: 7, label: "outbound-schedule" });
  assert.equal(result.fields.returnDate.state, "ambiguous");
  assert.deepEqual(result.fields.returnDate.source, { line: 11, label: "inbound-schedule" });
  assert.equal(result.fields.airline.state, "ignored");
  assert.equal(result.fields.stops.state, "ignored");
  assert.equal(result.fields.price.state, "ignored");
  assert.equal(result.fields.passengers.state, "missing");
  assert.equal(result.fields.cabin.state, "missing");
  assert.equal(Object.hasOwn(result.request, "filters"), false);
  assert.equal(Object.hasOwn(result.request, "passengers"), false);
  assert.equal(Object.hasOwn(result.request, "cabin"), false);
  assert.equal(Object.hasOwn(result.request, "price"), false);
});

test("one-way quotation treats return data as inapplicable without inventing defaults", () => {
  const result = parseCommercialQuotation([
    "PAQUETE MIGRATORIO MADRID 🇪🇸",
    "",
    "Ruta: Lima (LIM) - Madrid (MAD)",
    "Aerolínea: Iberia",
    "",
    "IDA",
    "LIM · 01 julio · 11:00 am",
    "MAD · 02 julio · 05:40 am",
    "",
    "PRECIO:",
    "US$ 512 por adulto",
  ].join("\n"));

  assert.deepEqual(result.request, {
    tripType: "one-way",
    legs: [{ origin: "LIM", destination: "MAD" }],
  });
  assert.equal(result.fields.departureDate.state, "ambiguous");
  assert.equal(result.fields.returnDate.state, "ignored");
  assert.equal(result.fields.passengers.state, "missing");
  assert.equal(result.fields.cabin.state, "missing");
});

test("schedule dates are parsed only when an explicit valid year is present", () => {
  const result = parseCommercialQuotation([
    "COTIZACIÓN BOLETO AÉREO ✈️",
    "Ruta: Lima (LIM) - Cusco (CUZ) - Lima (LIM)",
    "IDA",
    "LIM · 09 septiembre 2027 · 09:00 am",
    "CUZ · 09 septiembre 2027 · 10:20 am",
    "RETORNO",
    "CUZ · 12 septiembre 2027 · 07:00 pm",
    "LIM · 12 septiembre 2027 · 08:25 pm",
  ].join("\n"));

  assert.deepEqual(result.request, {
    tripType: "round-trip",
    legs: [{
      origin: "LIM",
      destination: "CUZ",
      departureDate: "2027-09-09",
      returnDate: "2027-09-12",
    }],
  });
  assert.equal(result.fields.departureDate.state, "parsed");
  assert.equal(result.fields.returnDate.state, "parsed");
});

test("oversized input is rejected before any quotation fields are interpreted", () => {
  const result = parseCommercialQuotation("A".repeat(MAX_COMMERCIAL_QUOTATION_CHARS + 1));

  assert.equal(result.fields.format.state, "invalid");
  assert.match(result.fields.format.reason, /máximo/i);
  assert.deepEqual(result.request, {});
  assert.equal(result.warnings.length, 1);
});

test("hostile unrelated lines cannot inject price, filters, passengers, cabin, or object keys", () => {
  const result = parseCommercialQuotation([
    "COTIZACIÓN BOLETO AÉREO ✈️",
    "<script>globalThis.compromised = true</script>",
    "__proto__: { polluted: true }",
    "Ruta: Lima (LIM) - Bogotá (BOG)",
    "IDA",
    "LIM · 09 septiembre · 09:00 am",
    "passengers: { adults: 99 }",
    "cabin: FIRST",
    "filters: { maxPrice: 1, nonStop: true }",
    "PRECIO:",
    "US$ 1 por adulto",
  ].join("\n"));

  assert.deepEqual(result.request, {
    tripType: "one-way",
    legs: [{ origin: "LIM", destination: "BOG" }],
  });
  assert.equal(result.fields.price.state, "ignored");
  assert.equal(Object.hasOwn(result.request, "__proto__"), false);
  assert.equal(Object.hasOwn(result.request, "filters"), false);
  assert.equal(Object.hasOwn(result.request, "passengers"), false);
  assert.equal(Object.hasOwn(result.request, "cabin"), false);
  assert.doesNotMatch(JSON.stringify(result), /globalThis\.compromised|maxPrice|adults: 99/);
});

test("malformed routes and impossible explicit dates are invalid instead of guessed", () => {
  const result = parseCommercialQuotation([
    "COTIZACIÓN BOLETO AÉREO ✈️",
    "Ruta: Lima - Buenos Aires",
    "IDA",
    "LIM · 31 febrero 2027 · 09:00 am",
  ].join("\n"));

  assert.equal(result.fields.origin.state, "invalid");
  assert.equal(result.fields.destination.state, "invalid");
  assert.equal(result.fields.tripType.state, "invalid");
  assert.equal(result.fields.departureDate.state, "invalid");
  assert.deepEqual(result.request, {});
});
