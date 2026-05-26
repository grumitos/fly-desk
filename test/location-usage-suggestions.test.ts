import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  getLocationUsageSuggestions,
  LOCATION_USAGE_RECENT_WINDOW_MS,
  recordLocationUsageFromSearch,
} from "../frontend/src/lib/location-usage-suggestions";
import type { SearchRequest } from "../frontend/src/types";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function buildSearchRequest(origin: string, destination: string): SearchRequest {
  return {
    origin,
    destination,
    departureDate: "2026-06-15",
    tripType: "round-trip",
    adults: 1,
    children: 0,
    infants: 0,
    searchMode: "exact",
  };
}

test("location usage suggestions rank origin and destination independently", () => {
  const storage = new MemoryStorage();
  const nowMs = Date.UTC(2026, 4, 26, 12);

  recordLocationUsageFromSearch(buildSearchRequest("LIM", "MAD"), { storage, nowMs });
  recordLocationUsageFromSearch(buildSearchRequest("LIM", "MAD"), { storage, nowMs: nowMs + 1 });
  recordLocationUsageFromSearch(buildSearchRequest("TPP", "MIA"), { storage, nowMs: nowMs + 2 });
  recordLocationUsageFromSearch(buildSearchRequest("CUZ", "BIO"), { storage, nowMs: nowMs + 3 });
  recordLocationUsageFromSearch(buildSearchRequest("AQP", "SCL"), { storage, nowMs: nowMs + 4 });

  const suggestions = getLocationUsageSuggestions({ storage, nowMs: nowMs + 5 });

  assert.deepEqual(suggestions.origin, ["LIM", "AQP", "CUZ"]);
  assert.deepEqual(suggestions.destination, ["MAD", "SCL", "BIO"]);
});

test("location usage suggestions keep older codes as fallback after the seven-day window", () => {
  const storage = new MemoryStorage();
  const nowMs = Date.UTC(2026, 4, 26, 12);
  const oldMs = nowMs - LOCATION_USAGE_RECENT_WINDOW_MS - 60_000;

  recordLocationUsageFromSearch(buildSearchRequest("LIM", "MAD"), { storage, nowMs: oldMs });

  assert.deepEqual(getLocationUsageSuggestions({ storage, nowMs }), {
    origin: ["LIM"],
    destination: ["MAD"],
  });

  recordLocationUsageFromSearch(buildSearchRequest("CUZ", "BOG"), { storage, nowMs });

  assert.deepEqual(getLocationUsageSuggestions({ storage, nowMs: nowMs + 1 }), {
    origin: ["CUZ", "LIM"],
    destination: ["BOG", "MAD"],
  });
});

test("location usage suggestions normalize IATA prefixes and ignore invalid codes", () => {
  const storage = new MemoryStorage();
  const nowMs = Date.UTC(2026, 4, 26, 12);

  recordLocationUsageFromSearch(buildSearchRequest("lim - Lima, Peru", "12"), { storage, nowMs });

  assert.deepEqual(getLocationUsageSuggestions({ storage, nowMs: nowMs + 1 }), {
    origin: ["LIM"],
    destination: [],
  });
});
