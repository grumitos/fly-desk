import { test } from "bun:test";
import assert from "node:assert/strict";
import { airlineNameMatchKey, normalizeAirlineDisplayName } from "../src/core/airline-names";

test("normalizeAirlineDisplayName removes trailing airline suffixes and styles known carriers", () => {
  assert.equal(normalizeAirlineDisplayName("Sky Airline"), "Sky");
  assert.equal(normalizeAirlineDisplayName("Jetsmart Airlines"), "JetSmart");
  assert.equal(normalizeAirlineDisplayName("JetSmart Airlines"), "JetSmart");
  assert.equal(normalizeAirlineDisplayName("JetSMART SpA"), "JetSmart");
  assert.equal(normalizeAirlineDisplayName("JetSmart Airlines SpA"), "JetSmart");
});

test("normalizeAirlineDisplayName only removes suffix words at the end", () => {
  assert.equal(normalizeAirlineDisplayName("Air Canada"), "Air Canada");
  assert.equal(normalizeAirlineDisplayName("Example Airline Group"), "Example Airline Group");
  assert.equal(normalizeAirlineDisplayName("Example Airline"), "Example");
});

test("airlineNameMatchKey treats styled airline variants as the same carrier", () => {
  assert.equal(airlineNameMatchKey("Jetsmart Airlines"), airlineNameMatchKey("JetSMART SpA"));
  assert.equal(airlineNameMatchKey("Sky Airline"), airlineNameMatchKey("Sky"));
});
