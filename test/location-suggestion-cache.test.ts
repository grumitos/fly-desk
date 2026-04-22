import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocationSuggestionCacheStore, LOCATION_SUGGESTION_CACHE_TTL_MS } from "../src/location-suggestion-cache";

test("location suggestion cache reuses the first result for the same session and query", async () => {
  const cache = new LocationSuggestionCacheStore();
  let calls = 0;

  const loader = async () => {
    calls += 1;
    return [{
      code: "LIM",
      city: "Lima",
      country: "Peru",
      label: "LIM - Lima, Peru",
    }];
  };

  const first = await cache.getOrLoad("session-a", "costamar", "lim", 8, loader);
  const second = await cache.getOrLoad("session-a", "costamar", "LIM", 8, loader);

  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
});

test("location suggestion cache keeps sessions isolated", async () => {
  const cache = new LocationSuggestionCacheStore();
  let calls = 0;

  const loader = async () => {
    calls += 1;
    return [{
      code: "PIU",
      city: "Piura",
      country: "Peru",
      label: "PIU - Piura, Peru",
    }];
  };

  await cache.getOrLoad("session-a", "agil-local", "piu", 8, loader);
  await cache.getOrLoad("session-b", "agil-local", "piu", 8, loader);

  assert.equal(calls, 2);
});

test("location suggestion cache purges expired entries", async () => {
  const cache = new LocationSuggestionCacheStore();
  let calls = 0;

  const loader = async () => {
    calls += 1;
    return [{
      code: "MAD",
      city: "Madrid",
      country: "Spain",
      label: "MAD - Madrid, Spain",
    }];
  };

  await cache.getOrLoad("session-a", "costamar", "mad", 8, loader);
  cache.purgeExpired(Date.now() + LOCATION_SUGGESTION_CACHE_TTL_MS + 1);
  await cache.getOrLoad("session-a", "costamar", "mad", 8, loader);

  assert.equal(calls, 2);
});

test("location suggestion cache survives process-like restarts when persisted", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-location-cache-persist-"));
  const persistPath = join(tempRoot, "location-suggestions.json");
  let calls = 0;

  const loader = async () => {
    calls += 1;
    return [{
      code: "LIM",
      city: "Lima",
      country: "Peru",
      label: "LIM - Lima, Peru",
    }];
  };

  const first = new LocationSuggestionCacheStore({ persistPath });
  await first.getOrLoad("session-a", "costamar", "lim", 8, loader);
  await new Promise((resolve) => setTimeout(resolve, 180));

  const second = new LocationSuggestionCacheStore({ persistPath });
  const restored = await second.getOrLoad("session-a", "costamar", "LIM", 8, loader);

  assert.equal(calls, 1);
  assert.equal(restored.length, 1);
  assert.equal(restored[0]?.code, "LIM");

  rmSync(tempRoot, { recursive: true, force: true });
});

test("location suggestion cache keeps valid persisted entries while reloading expired ones", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-location-cache-expiry-"));
  const persistPath = join(tempRoot, "location-suggestions.json");
  mkdirSync(tempRoot, { recursive: true });
  const nowMs = Date.now();
  const staleTouchedAtMs = nowMs - LOCATION_SUGGESTION_CACHE_TTL_MS - 2_000;

  writeFileSync(persistPath, JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    entries: [
      {
        key: "session-a::costamar::8::LIM",
        touchedAtMs: nowMs - 2_000,
        expiresAtMs: nowMs + 120_000,
        suggestions: [{ code: "LIM", city: "Lima", country: "Peru", label: "LIM - Lima, Peru" }],
      },
      {
        key: "session-a::costamar::8::MAD",
        touchedAtMs: staleTouchedAtMs,
        expiresAtMs: nowMs - 1,
        suggestions: [{ code: "MAD", city: "Madrid", country: "Spain", label: "MAD - Madrid, Spain" }],
      },
    ],
  }), "utf8");

  let calls = 0;
  const loader = async () => {
    calls += 1;
    return [{
      code: "MAD",
      city: "Madrid",
      country: "Spain",
      label: "MAD - Madrid, Spain",
    }];
  };

  const cache = new LocationSuggestionCacheStore({ persistPath });
  const restored = await cache.getOrLoad("session-a", "costamar", "LIM", 8, async () => {
    throw new Error("LIM should come from persisted cache");
  });
  const reloaded = await cache.getOrLoad("session-a", "costamar", "MAD", 8, loader);

  assert.equal(restored.length, 1);
  assert.equal(restored[0]?.code, "LIM");
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0]?.code, "MAD");
  assert.equal(calls, 1);

  rmSync(tempRoot, { recursive: true, force: true });
});
