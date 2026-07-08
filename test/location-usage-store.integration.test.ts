import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocationUsageStore,
  LOCATION_USAGE_RECENT_WINDOW_MS,
} from "../src/location-usage-store";

function buildSearch(origin: string, destination: string) {
  return { origin, destination };
}

test("location usage store ranks origin and destination globally", () => {
  const store = new LocationUsageStore();
  const nowMs = Date.UTC(2026, 4, 26, 12);

  store.recordFromSearch(buildSearch("LIM", "MAD"), nowMs);
  store.recordFromSearch(buildSearch("LIM", "MAD"), nowMs + 1);
  store.recordFromSearch(buildSearch("TPP", "MIA"), nowMs + 2);
  store.recordFromSearch(buildSearch("CUZ", "BIO"), nowMs + 3);
  store.recordFromSearch(buildSearch("AQP", "SCL"), nowMs + 4);

  const suggestions = store.getSuggestions(3, nowMs + 5);

  assert.deepEqual(suggestions.origin, ["LIM", "AQP", "CUZ"]);
  assert.deepEqual(suggestions.destination, ["MAD", "SCL", "BIO"]);
});

test("location usage store keeps older codes as fallback after recent window", () => {
  const store = new LocationUsageStore();
  const nowMs = Date.UTC(2026, 4, 26, 12);
  const oldMs = nowMs - LOCATION_USAGE_RECENT_WINDOW_MS - 60_000;

  store.recordFromSearch(buildSearch("LIM", "MAD"), oldMs);

  assert.deepEqual(store.getSuggestions(3, nowMs), {
    origin: ["LIM"],
    destination: ["MAD"],
  });

  store.recordFromSearch(buildSearch("CUZ", "BOG"), nowMs);

  assert.deepEqual(store.getSuggestions(3, nowMs + 1), {
    origin: ["CUZ", "LIM"],
    destination: ["BOG", "MAD"],
  });
});

test("location usage store normalizes IATA prefixes and ignores invalid codes", () => {
  const store = new LocationUsageStore();
  const nowMs = Date.UTC(2026, 4, 26, 12);

  store.recordFromSearch(buildSearch("lim - Lima, Peru", "12"), nowMs);

  assert.deepEqual(store.getSuggestions(3, nowMs + 1), {
    origin: ["LIM"],
    destination: [],
  });
});

test("location usage store persists global ranking across process-like restarts", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "fly-desk-location-usage-"));
  const dbPath = join(tempRoot, "location-usage.sqlite");
  const nowMs = Date.UTC(2026, 4, 26, 12);

  try {
    const first = new LocationUsageStore({ dbPath });
    first.recordFromSearch(buildSearch("LIM", "MAD"), nowMs);
    first.recordFromSearch(buildSearch("LIM", "MAD"), nowMs + 1);
    first.recordFromSearch(buildSearch("CUZ", "BOG"), nowMs + 2);
    first.close();
    first.close();

    const second = new LocationUsageStore({ dbPath });
    assert.deepEqual(second.getSuggestions(3, nowMs + 3), {
      origin: ["LIM", "CUZ"],
      destination: ["MAD", "BOG"],
    });
    second.close();
    second.close();
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
