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

test("one search puts a new station on the global row against entrenched counters", () => {
  const store = new LocationUsageStore();
  const nowMs = Date.UTC(2026, 4, 26, 12);

  /* The shape the deployment itself produces: the production smoke fires
     LIM–MAD on every deploy and rollback, and the desk's own routes pile up
     behind it. Under a ranking that only ever adds, the three slots were
     settled for good. */
  for (let index = 0; index < 40; index += 1) {
    store.recordFromSearch(buildSearch("LIM", "MAD"), nowMs + index);
  }
  for (let index = 0; index < 25; index += 1) {
    store.recordFromSearch(buildSearch("CUZ", "BOG"), nowMs + 100 + index);
  }
  for (let index = 0; index < 12; index += 1) {
    store.recordFromSearch(buildSearch("AQP", "SCL"), nowMs + 200 + index);
  }

  assert.deepEqual(store.getSuggestions(3, nowMs + 300), {
    origin: ["LIM", "CUZ", "AQP"],
    destination: ["MAD", "BOG", "SCL"],
  });

  store.recordFromSearch(buildSearch("IQT", "UIO"), nowMs + 400);

  assert.deepEqual(store.getSuggestions(3, nowMs + 401), {
    origin: ["LIM", "CUZ", "IQT"],
    destination: ["MAD", "BOG", "UIO"],
  });

  /* And the slot is a slot, not a queue: the next station searched takes it,
     while the two stations the desk lives on keep the slots above. */
  store.recordFromSearch(buildSearch("TPP", "MIA"), nowMs + 500);
  assert.deepEqual(store.getSuggestions(3, nowMs + 501), {
    origin: ["LIM", "CUZ", "TPP"],
    destination: ["MAD", "BOG", "MIA"],
  });
});

test("the persisted ranking is one global row for every browser session and process", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "fly-desk-location-usage-global-"));
  const dbPath = join(tempRoot, "location-usage.sqlite");
  const nowMs = Date.UTC(2026, 4, 26, 12);
  let web: LocationUsageStore | undefined;
  let runner: LocationUsageStore | undefined;

  try {
    web = new LocationUsageStore({ dbPath });
    runner = new LocationUsageStore({ dbPath });

    /* Three different browsers, and the search executed in the other process.
       None of that is allowed to shard the row. */
    runner.recordFromSearch(buildSearch("LIM", "MAD"), nowMs, 3, "browser-session-desk-0001");
    runner.recordFromSearch(buildSearch("LIM", "MAD"), nowMs + 1, 3, "browser-session-desk-0002");
    runner.recordFromSearch(buildSearch("CUZ", "BOG"), nowMs + 2, 3, "browser-session-desk-0003");

    assert.deepEqual(web.getSuggestions(3, nowMs + 3), {
      origin: ["LIM", "CUZ"],
      destination: ["MAD", "BOG"],
    });

    // A station a third browser searched once, read from the first process.
    runner.recordFromSearch(buildSearch("IQT", "UIO"), nowMs + 4, 3, "browser-session-desk-0003");
    const groups = web.getUsageSuggestions("browser-session-desk-0001", 3, nowMs + 5);
    /* Two uses put LIM first; between the two single uses the newer one leads,
       which is the same recency the last card answers to. */
    assert.deepEqual(groups.frequent, {
      origin: ["LIM", "IQT", "CUZ"],
      destination: ["MAD", "UIO", "BOG"],
    });
    /* The per-session strip stays per-session — it is the only thing here that
       is allowed to differ between browsers. */
    assert.deepEqual(groups.recent, {
      origin: ["LIM"],
      destination: ["MAD"],
    });
  } finally {
    web?.close();
    runner?.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
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

test("location usage store isolates recent routes by opaque session and orders them by last use", () => {
  const store = new LocationUsageStore({ recentTtlMs: 1_000, recentMaxEntries: 100 });
  const sessionA = "browser-session-a1";
  const sessionB = "browser-session-b2";
  const nowMs = Date.UTC(2026, 4, 26, 12);

  store.recordFromSearch(buildSearch("LIM", "MAD"), nowMs, 3, sessionA);
  store.recordFromSearch(buildSearch("CUZ", "BOG"), nowMs + 1, 3, sessionA);
  store.recordFromSearch(buildSearch("AQP", "SCL"), nowMs + 2, 3, sessionA);
  store.recordFromSearch(buildSearch("TPP", "MIA"), nowMs + 3, 3, sessionA);
  store.recordFromSearch(buildSearch("CUZ", "BOG"), nowMs + 4, 3, sessionA);
  store.recordFromSearch(buildSearch("IQT", "UIO"), nowMs + 5, 3, sessionB);

  assert.deepEqual(store.getUsageSuggestions(sessionA, 3, nowMs + 6), {
    frequent: {
      origin: ["CUZ", "IQT", "TPP"],
      destination: ["BOG", "UIO", "MIA"],
    },
    recent: {
      origin: ["CUZ", "TPP", "AQP"],
      destination: ["BOG", "MIA", "SCL"],
    },
  });
  assert.deepEqual(store.getUsageSuggestions(sessionB, 3, nowMs + 6).recent, {
    origin: ["IQT"],
    destination: ["UIO"],
  });
  assert.deepEqual(store.getUsageSuggestions(undefined, 3, nowMs + 6).recent, {
    origin: [],
    destination: [],
  });
  assert.deepEqual(store.getUsageSuggestions("invalid/id", 3, nowMs + 6).recent, {
    origin: [],
    destination: [],
  });
  assert.deepEqual(store.getUsageSuggestions(sessionA, 3, nowMs + 1_006).recent, {
    origin: [],
    destination: [],
  });
});

test("location usage store bounds the persisted recent table globally", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "fly-desk-location-recents-cap-"));
  const dbPath = join(tempRoot, "location-usage.sqlite");
  const nowMs = Date.UTC(2026, 4, 26, 12);
  let store: LocationUsageStore | undefined;

  try {
    store = new LocationUsageStore({
      dbPath,
      recentTtlMs: 60_000,
      recentMaxEntries: 5,
    });

    for (let index = 0; index < 20; index += 1) {
      const secondLetter = String.fromCharCode(65 + Math.floor(index / 26));
      const thirdLetter = String.fromCharCode(65 + (index % 26));
      store.recordFromSearch(
        buildSearch(`A${secondLetter}${thirdLetter}`, `B${secondLetter}${thirdLetter}`),
        nowMs + index,
        3,
        `browser-session-${String(index).padStart(4, "0")}`,
      );
    }

    assert.equal(store.getDiagnostics().recentEntries, 5);

    store.close();
    store = undefined;
    const persisted = new Database(dbPath, { readonly: true });
    const recentCount = persisted.query("SELECT COUNT(*) AS entries FROM location_recent_usage").get() as { entries: number };
    persisted.close();
    assert.equal(recentCount.entries, 5);
  } finally {
    store?.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("location usage store persists session recents across restarts and expires them by TTL", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "fly-desk-location-recents-restart-"));
  const dbPath = join(tempRoot, "location-usage.sqlite");
  const sessionId = "browser-session-restart-a";
  const nowMs = Date.UTC(2026, 4, 26, 12);

  try {
    const first = new LocationUsageStore({ dbPath, recentTtlMs: 1_000 });
    first.recordFromSearch(buildSearch("LIM", "MAD"), nowMs, 3, sessionId);
    first.close();

    const reopened = new LocationUsageStore({ dbPath, recentTtlMs: 1_000 });
    assert.deepEqual(reopened.getUsageSuggestions(sessionId, 3, nowMs + 500).recent, {
      origin: ["LIM"],
      destination: ["MAD"],
    });
    assert.deepEqual(reopened.getUsageSuggestions("browser-session-restart-b", 3, nowMs + 500).recent, {
      origin: [],
      destination: [],
    });
    assert.deepEqual(reopened.getUsageSuggestions(sessionId, 3, nowMs + 1_001).recent, {
      origin: [],
      destination: [],
    });
    reopened.close();
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
