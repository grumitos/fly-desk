import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database = require("better-sqlite3");
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
  const dbPath = join(tempRoot, "location-suggestions.sqlite");
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

  const first = new LocationSuggestionCacheStore({ dbPath });
  await first.getOrLoad("session-a", "costamar", "lim", 8, loader);

  const second = new LocationSuggestionCacheStore({ dbPath });
  const restored = await second.getOrLoad("session-a", "costamar", "LIM", 8, loader);

  assert.equal(calls, 1);
  assert.equal(restored.length, 1);
  assert.equal(restored[0]?.code, "LIM");
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare("SELECT key, payload FROM location_suggestions").all() as Array<{ key: string; payload: string }>;
  db.close();
  assert.equal(rows.length, 1);
  assert.match(rows[0]?.key ?? "", /session-a::costamar::8::LIM/);

  first.close();
  second.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

test("location suggestion cache keeps valid persisted entries while reloading expired ones", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-location-cache-expiry-"));
  const dbPath = join(tempRoot, "location-suggestions.sqlite");
  const bootstrap = new LocationSuggestionCacheStore({ dbPath });

  await bootstrap.getOrLoad("session-a", "costamar", "LIM", 8, async () => [
    { code: "LIM", city: "Lima", country: "Peru", label: "LIM - Lima, Peru" },
  ]);
  await bootstrap.getOrLoad("session-a", "costamar", "MAD", 8, async () => [
    { code: "MAD", city: "Madrid", country: "Spain", label: "MAD - Madrid, Spain" },
  ]);

  const db = new Database(dbPath);
  db.prepare("UPDATE location_suggestions SET expires_at_ms = ? WHERE key = ?")
    .run(Date.now() - 1, "session-a::costamar::8::MAD");
  db.close();

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

  const cache = new LocationSuggestionCacheStore({ dbPath });
  const restored = await cache.getOrLoad("session-a", "costamar", "LIM", 8, async () => {
    throw new Error("LIM should come from persisted cache");
  });
  const reloaded = await cache.getOrLoad("session-a", "costamar", "MAD", 8, loader);

  assert.equal(restored.length, 1);
  assert.equal(restored[0]?.code, "LIM");
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0]?.code, "MAD");
  assert.equal(calls, 1);

  bootstrap.close();
  cache.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

test("location suggestion cache migrates valid legacy JSON entries into SQLite", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-location-cache-migrate-"));
  const dbPath = join(tempRoot, "location-suggestions.sqlite");
  const legacyPersistPath = join(tempRoot, "location-suggestions.json");
  mkdirSync(tempRoot, { recursive: true });

  writeFileSync(legacyPersistPath, JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    entries: [
      {
        key: "session-a::costamar::8::LIM",
        touchedAtMs: Date.now() - 2_000,
        expiresAtMs: Date.now() + LOCATION_SUGGESTION_CACHE_TTL_MS,
        suggestions: [{ code: "LIM", city: "Lima", country: "Peru", label: "LIM - Lima, Peru" }],
      },
    ],
  }), "utf8");

  const cache = new LocationSuggestionCacheStore({ dbPath, legacyPersistPath });
  const restored = await cache.getOrLoad("session-a", "costamar", "LIM", 8, async () => {
    throw new Error("LIM should come from migrated cache");
  });
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare("SELECT payload FROM location_suggestions WHERE key = ?")
    .get("session-a::costamar::8::LIM") as { payload?: string } | undefined;
  db.close();

  assert.equal(restored[0]?.code, "LIM");
  assert.ok(row?.payload);

  cache.close();
  rmSync(tempRoot, { recursive: true, force: true });
});
