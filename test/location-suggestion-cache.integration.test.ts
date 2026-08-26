import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  LocationSuggestionCacheStore,
  LOCATION_SUGGESTION_CACHE_MAX_ENTRIES,
  LOCATION_SUGGESTION_CACHE_MAX_QUERY_CHARS,
  LOCATION_SUGGESTION_CACHE_TTL_MS,
} from "../src/location-suggestion-cache";
import { removeTempRoot } from "./helpers/temp";

test("location suggestion cache remains the seven-day autocomplete exception", () => {
  assert.equal(LOCATION_SUGGESTION_CACHE_TTL_MS, 7 * 24 * 60 * 60 * 1000);
});

function runSql(db: Database, sql: string, ...params: any[]): void {
  const statement = db.prepare(sql);
  try {
    statement.run(...params);
  } finally {
    statement.finalize();
  }
}

function allSql<T>(db: Database, sql: string, ...params: any[]): T[] {
  const statement = db.prepare(sql);
  try {
    return statement.all(...params) as T[];
  } finally {
    statement.finalize();
  }
}

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

test("location suggestion cache bounds global entries across rotating session ids", async () => {
  const cache = new LocationSuggestionCacheStore();

  for (let index = 0; index <= LOCATION_SUGGESTION_CACHE_MAX_ENTRIES; index += 1) {
    await cache.getOrLoad(`rotating-session-${index}`, "costamar", `query-${index}`, 8, async () => [{
      code: "LIM",
      city: "Lima",
      country: "Peru",
      label: "LIM - Lima, Peru",
    }]);
  }

  assert.equal(cache.getDiagnostics().entries, LOCATION_SUGGESTION_CACHE_MAX_ENTRIES);
  assert.equal(cache.getDiagnostics().sessions, LOCATION_SUGGESTION_CACHE_MAX_ENTRIES);
});

test("location suggestion cache rejects oversized queries before invoking a provider", async () => {
  const cache = new LocationSuggestionCacheStore();
  let calls = 0;

  await assert.rejects(
    cache.getOrLoad(
      "session-a",
      "costamar",
      "x".repeat(LOCATION_SUGGESTION_CACHE_MAX_QUERY_CHARS + 1),
      8,
      async () => {
        calls += 1;
        return [];
      },
    ),
    /cannot exceed/i,
  );
  assert.equal(calls, 0);
  assert.equal(cache.getDiagnostics().entries, 0);
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
  const rows = allSql<{ key: string; payload: string }>(db, "SELECT key, payload FROM location_suggestions");
  db.close();
  assert.equal(rows.length, 1);
  assert.match(rows[0]?.key ?? "", /session-a::costamar::8::LIM/);

  first.close();
  second.close();
  removeTempRoot(tempRoot);
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
  runSql(
    db,
    "UPDATE location_suggestions SET expires_at_ms = ? WHERE key = ?",
    Date.now() - 1,
    "session-a::costamar::8::MAD",
  );
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
  removeTempRoot(tempRoot);
});
