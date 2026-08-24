import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { LocationUsageStore } from "../src/location-usage-store";

const DAY_MS = 24 * 60 * 60 * 1000;

function buildSearch(origin: string, destination: string) {
  return { origin, destination };
}

/* «si se buscó 30 veces el mes pasado y este 10, y hay otro con 20 en el mes
   actual, entonces pasaría a segundo puesto». MAD/FCO keeps the larger lifetime
   total — forty uses against twenty — and the thirty that made it are outside
   the window. */
function recordOwnersExample(store: LocationUsageStore, nowMs: number): void {
  for (let index = 0; index < 30; index += 1) {
    store.recordFromSearch(buildSearch("MAD", "FCO"), nowMs - (40 * DAY_MS) + index);
  }
  for (let index = 0; index < 10; index += 1) {
    store.recordFromSearch(buildSearch("MAD", "FCO"), nowMs - (2 * DAY_MS) + index);
  }
  for (let index = 0; index < 20; index += 1) {
    store.recordFromSearch(buildSearch("LIM", "BCN"), nowMs - DAY_MS + index);
  }
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

test("a counter a year old is not a station the desk still searches", () => {
  const store = new LocationUsageStore();
  const nowMs = Date.UTC(2026, 4, 26, 12);
  const oldMs = nowMs - (365 * DAY_MS);

  for (let index = 0; index < 4; index += 1) {
    store.recordFromSearch(buildSearch("LIM", "MAD"), oldMs + index);
  }
  for (let index = 0; index < 3; index += 1) {
    store.recordFromSearch(buildSearch("CUZ", "BOG"), nowMs + index);
  }

  /* LIM keeps the larger lifetime total and is off the row anyway: four uses a
     year ago are four uses that expired. This assertion used to read
     `["LIM", "CUZ"]`, which is the behaviour being replaced. */
  assert.deepEqual(store.getSuggestions(3, nowMs + 3), {
    origin: ["CUZ"],
    destination: ["BOG"],
  });
});

test("a station's uses expire out of the ranking a month after they happened", () => {
  const store = new LocationUsageStore();
  const nowMs = Date.UTC(2026, 7, 24, 12);

  recordOwnersExample(store, nowMs);

  /* Ten live uses against twenty, so MAD is second — even though it is the
     station with forty uses to its name and LIM/BCN has twenty. Rank on
     `total_uses` and this comes back the other way round. */
  assert.deepEqual(store.getSuggestions(3, nowMs), {
    origin: ["LIM", "MAD"],
    destination: ["BCN", "FCO"],
  });
});

test("the rolling window ranks a station the same in memory as in sqlite", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "fly-desk-location-usage-window-parity-"));
  const dbPath = join(tempRoot, "location-usage.sqlite");
  const nowMs = Date.UTC(2026, 7, 24, 12);
  let persisted: LocationUsageStore | undefined;

  try {
    const memory = new LocationUsageStore();
    persisted = new LocationUsageStore({ dbPath });
    recordOwnersExample(memory, nowMs);
    recordOwnersExample(persisted, nowMs);

    /* A runtime with no `dbPath` — every test process, and any deployment that
       has not been given one — must not quietly go on ranking by lifetime
       totals, so the two paths are asserted against the same expectation and
       then against each other at every card count the endpoint can ask for. */
    assert.deepEqual(memory.getSuggestions(3, nowMs), {
      origin: ["LIM", "MAD"],
      destination: ["BCN", "FCO"],
    });
    assert.deepEqual(persisted.getSuggestions(3, nowMs), {
      origin: ["LIM", "MAD"],
      destination: ["BCN", "FCO"],
    });

    for (const limit of [1, 2, 3]) {
      assert.deepEqual(
        persisted.getSuggestions(limit, nowMs),
        memory.getSuggestions(limit, nowMs),
      );
      // And once the whole window has gone by with nothing searched.
      assert.deepEqual(
        persisted.getSuggestions(limit, nowMs + (31 * DAY_MS)),
        memory.getSuggestions(limit, nowMs + (31 * DAY_MS)),
      );
    }

    assert.deepEqual(memory.getSuggestions(3, nowMs + (31 * DAY_MS)), {
      origin: ["LIM"],
      destination: ["BCN"],
    });
  } finally {
    persisted?.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("a use leaves the count on the day it crosses the window, not before", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "fly-desk-location-usage-window-edge-"));
  const dbPath = join(tempRoot, "location-usage.sqlite");
  const startMs = Date.UTC(2026, 0, 1, 12);
  const useDayStartMs = Math.floor(startMs / DAY_MS) * DAY_MS;
  let persisted: LocationUsageStore | undefined;

  try {
    const memory = new LocationUsageStore();
    persisted = new LocationUsageStore({ dbPath });
    memory.recordFromSearch(buildSearch("CUZ", "BOG"), startMs);
    persisted.recordFromSearch(buildSearch("CUZ", "BOG"), startMs);

    /* One card per role: below two there is no reserved newest slot, so this
       reads the count and nothing else. */
    for (const store of [memory, persisted]) {
      /* Thirty days later to the millisecond — mid-afternoon on the thirtieth
         day — and the card has not moved. Day granularity is the point. */
      assert.deepEqual(store.getSuggestions(1, startMs + (30 * DAY_MS)), {
        origin: ["CUZ"],
        destination: ["BOG"],
      });
      // Through the last millisecond of that UTC day.
      assert.deepEqual(store.getSuggestions(1, useDayStartMs + (31 * DAY_MS) - 1), {
        origin: ["CUZ"],
        destination: ["BOG"],
      });
      // And gone on the first millisecond of the next one.
      assert.deepEqual(store.getSuggestions(1, useDayStartMs + (31 * DAY_MS)), {
        origin: [],
        destination: [],
      });
    }
  } finally {
    persisted?.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("pruning drops the days that left the window and nothing else", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "fly-desk-location-usage-window-prune-"));
  const dbPath = join(tempRoot, "location-usage.sqlite");
  const startMs = Date.UTC(2026, 0, 1, 12);
  const startDay = Math.floor(startMs / DAY_MS);
  let store: LocationUsageStore | undefined;

  try {
    store = new LocationUsageStore({ dbPath });
    for (let index = 0; index < 5; index += 1) {
      store.recordFromSearch(buildSearch("LIM", "MAD"), startMs + index);
    }
    for (let index = 0; index < 2; index += 1) {
      store.recordFromSearch(buildSearch("LIM", "MAD"), startMs + (25 * DAY_MS) + index);
    }

    /* Another station searched forty days in. The write path prunes, and the
       only thing entitled to go is LIM's first day. */
    store.recordFromSearch(buildSearch("AQP", "SCL"), startMs + (40 * DAY_MS));

    assert.deepEqual(store.getSuggestions(1, startMs + (40 * DAY_MS)), {
      origin: ["LIM"],
      destination: ["MAD"],
    });

    store.close();
    store = undefined;

    const persisted = new Database(dbPath, { readonly: true });
    const days = persisted.query(
      "SELECT day, uses FROM location_usage_daily WHERE role = 'origin' AND code = 'LIM' ORDER BY day ASC",
    ).all() as Array<{ day: number; uses: number }>;
    const lifetime = persisted.query(
      "SELECT total_uses FROM location_usage WHERE role = 'origin' AND code = 'LIM'",
    ).get() as { total_uses: number };
    persisted.close();

    assert.deepEqual(days, [{ day: startDay + 25, uses: 2 }]);
    // The lifetime figure is not what pruning is about, and it does not move.
    assert.equal(lifetime.total_uses, 7);
  } finally {
    store?.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("the reserved newest card keeps its slot under the rolling window", () => {
  const store = new LocationUsageStore();
  const nowMs = Date.UTC(2026, 7, 24, 12);

  for (let index = 0; index < 20; index += 1) {
    store.recordFromSearch(buildSearch("LIM", "MAD"), nowMs - (10 * DAY_MS) + index);
  }
  for (let index = 0; index < 12; index += 1) {
    store.recordFromSearch(buildSearch("CUZ", "BOG"), nowMs - (5 * DAY_MS) + index);
  }
  for (let index = 0; index < 6; index += 1) {
    store.recordFromSearch(buildSearch("AQP", "SCL"), nowMs - (3 * DAY_MS) + index);
  }

  assert.deepEqual(store.getSuggestions(3, nowMs), {
    origin: ["LIM", "CUZ", "AQP"],
    destination: ["MAD", "BOG", "SCL"],
  });

  // One executed search still takes the last slot, against live counts of
  // twenty and twelve.
  store.recordFromSearch(buildSearch("IQT", "UIO"), nowMs);
  assert.deepEqual(store.getSuggestions(3, nowMs + 1), {
    origin: ["LIM", "CUZ", "IQT"],
    destination: ["MAD", "BOG", "UIO"],
  });

  /* And after a month with nothing searched every count is gone, while the
     station used last is still worth the card it holds. */
  assert.deepEqual(store.getSuggestions(3, nowMs + (31 * DAY_MS)), {
    origin: ["IQT"],
    destination: ["UIO"],
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
    /* Nothing is seeded into the rolling count, so these two come back on the
       reserved newest card rather than on a total. */
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

test("a database written before the window opens, serves, and starts the count empty", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "fly-desk-location-usage-window-migration-"));
  const dbPath = join(tempRoot, "location-usage.sqlite");
  const nowMs = Date.UTC(2026, 7, 24, 12);
  let store: LocationUsageStore | undefined;

  try {
    /* The shape on the deployment, at the volumes it actually holds: MAD
       entrenched at 1425 for destination against LIM's 446, and the ranking
       index the old ordering needed. */
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE location_usage (
        role TEXT NOT NULL,
        code TEXT NOT NULL,
        total_uses INTEGER NOT NULL,
        last_used_at_ms INTEGER NOT NULL,
        PRIMARY KEY (role, code)
      );
      CREATE INDEX idx_location_usage_role_rank
        ON location_usage (role, total_uses DESC, last_used_at_ms DESC, code ASC);
      CREATE TABLE location_recent_usage (
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        code TEXT NOT NULL,
        last_used_at_ms INTEGER NOT NULL,
        PRIMARY KEY (session_id, role, code)
      );
      INSERT INTO location_usage VALUES ('destination', 'MAD', 1425, ${nowMs - (40 * DAY_MS)});
      INSERT INTO location_usage VALUES ('destination', 'LIM', 446, ${nowMs - (200 * DAY_MS)});
      INSERT INTO location_usage VALUES ('destination', 'FCO', 200, ${nowMs - (120 * DAY_MS)});
      INSERT INTO location_usage VALUES ('origin', 'LIM', 2013, ${nowMs - (40 * DAY_MS)});
      INSERT INTO location_usage VALUES ('origin', 'MAD', 287, ${nowMs - (150 * DAY_MS)});
    `);
    legacy.close();

    store = new LocationUsageStore({ dbPath });

    /* Nothing is seeded from the old totals, because they say how often and
       never when: dating 1425 uses to `last_used_at_ms` would drop the whole
       backlog onto one day and hand MAD the very window it is meant to lose. */
    assert.equal(store.getDiagnostics().dailyEntries, 0);
    assert.equal(store.getDiagnostics().entries, 5);
    assert.equal(store.getDiagnostics().ranking, "rolling-window-uses-with-newest-card");

    /* It serves on the first read: with no live uses the row is the reserved
       newest card, which is also what the deployment shows on day one. */
    assert.deepEqual(store.getSuggestions(3, nowMs), {
      origin: ["LIM"],
      destination: ["MAD"],
    });

    // And two live searches are already ahead of 1425 lifetime uses.
    for (let index = 0; index < 2; index += 1) {
      store.recordFromSearch(buildSearch("TPP", "FCO"), nowMs + index);
    }
    assert.deepEqual(store.getSuggestions(3, nowMs + 2), {
      origin: ["TPP"],
      destination: ["FCO"],
    });
    assert.equal(store.getDiagnostics().dailyEntries, 2);

    store.close();
    store = undefined;

    const upgraded = new Database(dbPath, { readonly: true });
    const madLifetime = upgraded.query(
      "SELECT total_uses FROM location_usage WHERE role = 'destination' AND code = 'MAD'",
    ).get() as { total_uses: number };
    const columns = upgraded.query("PRAGMA table_info(location_usage)").all() as Array<{ name: string }>;
    const dailyColumns = upgraded.query("PRAGMA table_info(location_usage_daily)").all() as Array<{ name: string }>;
    const staleIndex = upgraded.query(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_location_usage_role_rank'",
    ).all() as Array<{ name: string }>;
    upgraded.close();

    /* Non-destructive: every row and column the deployment had is still there,
       and the only thing removed is the index that served the old ordering. */
    assert.equal(madLifetime.total_uses, 1425);
    assert.deepEqual(
      columns.map((column) => column.name),
      ["role", "code", "total_uses", "last_used_at_ms"],
    );
    assert.deepEqual(
      dailyColumns.map((column) => column.name),
      ["role", "code", "day", "uses"],
    );
    assert.deepEqual(staleIndex, []);
  } finally {
    store?.close();
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
