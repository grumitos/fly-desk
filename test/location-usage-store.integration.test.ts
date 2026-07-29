import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { LocationUsageStore } from "../src/location-usage-store";

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

test("location usage store ranks by permanent all-time counters instead of recent activity", () => {
  const store = new LocationUsageStore();
  const nowMs = Date.UTC(2026, 4, 26, 12);
  const oldMs = nowMs - (365 * 24 * 60 * 60 * 1000);

  for (let index = 0; index < 4; index += 1) {
    store.recordFromSearch(buildSearch("LIM", "MAD"), oldMs + index);
  }
  for (let index = 0; index < 3; index += 1) {
    store.recordFromSearch(buildSearch("CUZ", "BOG"), nowMs + index);
  }

  assert.deepEqual(store.getSuggestions(3, nowMs + 3), {
    origin: ["LIM", "CUZ"],
    destination: ["MAD", "BOG"],
  });
});

test("location usage store always exposes at most three cards per role", () => {
  const store = new LocationUsageStore();
  const nowMs = Date.UTC(2026, 4, 26, 12);

  store.recordFromSearch(buildSearch("LIM", "MAD"), nowMs);
  store.recordFromSearch(buildSearch("CUZ", "BOG"), nowMs + 1);
  store.recordFromSearch(buildSearch("AQP", "SCL"), nowMs + 2);
  store.recordFromSearch(buildSearch("TPP", "MIA"), nowMs + 3);

  assert.deepEqual(store.getSuggestions(20, nowMs + 4), {
    origin: ["TPP", "AQP", "CUZ"],
    destination: ["MIA", "SCL", "BOG"],
  });
});

test("location usage store never prunes an older counter that remains globally most used", () => {
  const store = new LocationUsageStore();
  const nowMs = Date.UTC(2026, 4, 26, 12);

  store.recordFromSearch(buildSearch("LIM", "MAD"), nowMs);
  store.recordFromSearch(buildSearch("LIM", "MAD"), nowMs + 1);

  for (let index = 0; index < 61; index += 1) {
    const secondLetter = String.fromCharCode(65 + Math.floor(index / 26));
    const thirdLetter = String.fromCharCode(65 + (index % 26));
    store.recordFromSearch(
      buildSearch(`X${secondLetter}${thirdLetter}`, `Y${secondLetter}${thirdLetter}`),
      nowMs + index + 2,
    );
  }

  assert.equal(store.getSuggestions(3, nowMs + 100).origin[0], "LIM");
  assert.equal(store.getSuggestions(3, nowMs + 100).destination[0], "MAD");
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

test("location usage store shares fresh global counters across already-running processes", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "fly-desk-location-usage-"));
  const dbPath = join(tempRoot, "location-usage.sqlite");
  const nowMs = Date.UTC(2026, 4, 26, 12);
  let first: LocationUsageStore | undefined;
  let second: LocationUsageStore | undefined;

  try {
    first = new LocationUsageStore({ dbPath });
    second = new LocationUsageStore({ dbPath });

    first.recordFromSearch(buildSearch("LIM", "MAD"), nowMs);
    assert.deepEqual(second.getSuggestions(3, nowMs + 1), {
      origin: ["LIM"],
      destination: ["MAD"],
    });

    second.recordFromSearch(buildSearch("CUZ", "BOG"), nowMs + 2);
    second.recordFromSearch(buildSearch("CUZ", "BOG"), nowMs + 3);
    assert.deepEqual(first.getSuggestions(3, nowMs + 4), {
      origin: ["CUZ", "LIM"],
      destination: ["BOG", "MAD"],
    });
  } finally {
    first?.close();
    second?.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("location usage store migrates the former recent-use cache into permanent counters", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "fly-desk-location-usage-migration-"));
  const dbPath = join(tempRoot, "location-usage.sqlite");

  try {
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE location_usage (
        role TEXT NOT NULL,
        code TEXT NOT NULL,
        total_uses INTEGER NOT NULL,
        last_used_at_ms INTEGER NOT NULL,
        recent_uses_ms TEXT NOT NULL,
        PRIMARY KEY (role, code)
      );
      INSERT INTO location_usage VALUES ('origin', 'LIM', 7, 1000, '[1000]');
      INSERT INTO location_usage VALUES ('destination', 'MAD', 6, 1000, '[1000]');
    `);
    legacy.close();

    const store = new LocationUsageStore({ dbPath });
    assert.deepEqual(store.getSuggestions(), {
      origin: ["LIM"],
      destination: ["MAD"],
    });
    store.close();

    const migrated = new Database(dbPath, { readonly: true });
    const statement = migrated.prepare("PRAGMA table_info(location_usage)");
    const columns = statement.all() as Array<{ name: string }>;
    statement.finalize();
    migrated.close();

    assert.deepEqual(
      columns.map((column) => column.name),
      ["role", "code", "total_uses", "last_used_at_ms"],
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
