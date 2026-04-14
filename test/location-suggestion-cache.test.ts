import test from "node:test";
import assert from "node:assert/strict";
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
