import { test } from "bun:test";
import assert from "node:assert/strict";
import { airlineNameMatchKey, normalizeAirlineDisplayName, resolveAirlineDisplayName } from "../src/core/airline-names";

test("normalizeAirlineDisplayName removes trailing airline suffixes and styles known carriers", () => {
  assert.equal(normalizeAirlineDisplayName("Sky Airline"), "Sky");
  assert.equal(normalizeAirlineDisplayName("Jetsmart Airlines"), "JetSmart");
  assert.equal(normalizeAirlineDisplayName("JetSmart Airlines"), "JetSmart");
  assert.equal(normalizeAirlineDisplayName("JetSMART SpA"), "JetSmart");
  assert.equal(normalizeAirlineDisplayName("JetSmart Airlines SpA"), "JetSmart");
});

test("normalizeAirlineDisplayName groups LATAM, LAN, and TAM variants under LATAM", () => {
  [
    "LATAM",
    "LATAM Airlines",
    "LATAM Airlines Brasil",
    "LATAM Airlines Brazil",
    "LATAM Airlines Peru",
    "LATAM Airlines Group",
    "LATAM Cargo Chile",
    "LAN Peru",
    "LAN Perú S.A.",
    "LAN Chile",
    "LAN Airlines",
    "LAN Airline",
    "TAM Brasil",
    "TAM Linhas Aéreas S.A.",
    "TAM Airlines",
    "TAM Airline",
    "LA",
    "LP",
    "JJ",
    "4C",
    "4M",
    "LU",
    "PZ",
    "XL",
  ].forEach((name) => {
    assert.equal(normalizeAirlineDisplayName(name), "LATAM", name);
  });
});

test("normalizeAirlineDisplayName centralizes known carrier code display names", () => {
  assert.equal(normalizeAirlineDisplayName("AM"), "Aeroméxico");
  assert.equal(normalizeAirlineDisplayName("IB"), "Iberia");
  assert.equal(normalizeAirlineDisplayName("JA"), "JetSmart");
  assert.equal(normalizeAirlineDisplayName("JZ"), "JetSmart");
  assert.equal(normalizeAirlineDisplayName("H2"), "Sky");
});

test("normalizeAirlineDisplayName names the carriers a Lima desk sees every day", () => {
  assert.equal(normalizeAirlineDisplayName("CM"), "Copa");
  assert.equal(normalizeAirlineDisplayName("AA"), "American");
  assert.equal(normalizeAirlineDisplayName("DL"), "Delta");
  assert.equal(normalizeAirlineDisplayName("UA"), "United");
  assert.equal(normalizeAirlineDisplayName("B6"), "JetBlue");
  assert.equal(normalizeAirlineDisplayName("NK"), "Spirit");
  assert.equal(normalizeAirlineDisplayName("AF"), "Air France");
  assert.equal(normalizeAirlineDisplayName("KL"), "KLM");
  assert.equal(normalizeAirlineDisplayName("LH"), "Lufthansa");
  assert.equal(normalizeAirlineDisplayName("G3"), "Gol");
  assert.equal(normalizeAirlineDisplayName("AD"), "Azul");
  assert.equal(normalizeAirlineDisplayName("VB"), "Viva Aerobus");
  assert.equal(normalizeAirlineDisplayName("Y4"), "Volaris");
});

test("normalizeAirlineDisplayName centralizes known carrier name variants", () => {
  assert.equal(normalizeAirlineDisplayName("Aeromexico"), "Aeroméxico");
  assert.equal(normalizeAirlineDisplayName("Aeroméxico"), "Aeroméxico");
  assert.equal(normalizeAirlineDisplayName("Plus Ultra Lineas Aereas"), "Plus Ultra");
  assert.equal(normalizeAirlineDisplayName("Delta Air Lines"), "Delta");
  assert.equal(normalizeAirlineDisplayName("Copa Airlines"), "Copa");
  assert.equal(normalizeAirlineDisplayName("American Airlines"), "American");
  assert.equal(normalizeAirlineDisplayName("Spirit Airlines"), "Spirit");
  assert.equal(normalizeAirlineDisplayName("JetBlue Airways"), "JetBlue");
  assert.equal(normalizeAirlineDisplayName("Gol Linhas Aéreas"), "Gol");
  assert.equal(normalizeAirlineDisplayName("Azul Linhas Aéreas Brasileiras"), "Azul");
  assert.equal(normalizeAirlineDisplayName("VivaAerobús"), "Viva Aerobus");
});

test("resolveAirlineDisplayName prefers normalized names and falls back to normalized codes", () => {
  assert.equal(resolveAirlineDisplayName({
    names: ["LAN Peru"],
    codes: ["LP"],
    fallback: "Aerolínea",
  }), "LATAM");
  assert.equal(resolveAirlineDisplayName({
    names: [],
    codes: ["JZ"],
    fallback: "Aerolínea",
  }), "JetSmart");
  assert.equal(resolveAirlineDisplayName({
    names: [],
    codes: [],
    fallback: "Aerolínea",
  }), "Aerolínea");
});

test("normalizeAirlineDisplayName only removes suffix words at the end", () => {
  assert.equal(normalizeAirlineDisplayName("Air Canada"), "Air Canada");
  assert.equal(normalizeAirlineDisplayName("Example Airline Group"), "Example Airline Group");
  assert.equal(normalizeAirlineDisplayName("Example Airline"), "Example");
});

test("airlineNameMatchKey treats styled airline variants as the same carrier", () => {
  assert.equal(airlineNameMatchKey("Jetsmart Airlines"), airlineNameMatchKey("JetSMART SpA"));
  assert.equal(airlineNameMatchKey("Sky Airline"), airlineNameMatchKey("Sky"));
  assert.equal(airlineNameMatchKey("LATAM Airlines Brasil"), airlineNameMatchKey("LAN Peru"));
  assert.equal(airlineNameMatchKey("TAM Airlines"), airlineNameMatchKey("LA"));
  assert.equal(airlineNameMatchKey("JetSmart Airlines SpA"), airlineNameMatchKey("JZ"));
  assert.equal(airlineNameMatchKey("Aeromexico"), airlineNameMatchKey("Aeroméxico"));
  assert.equal(airlineNameMatchKey("Aeromexico"), airlineNameMatchKey("AM"));
  assert.equal(airlineNameMatchKey("Copa Airlines"), airlineNameMatchKey("CM"));
  assert.equal(airlineNameMatchKey("American Airlines"), airlineNameMatchKey("AA"));
  assert.equal(airlineNameMatchKey("JetBlue Airways"), airlineNameMatchKey("B6"));
});
