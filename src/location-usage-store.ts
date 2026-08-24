import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

const LOCATION_USAGE_CARD_LIMIT = 3;
const LOCATION_USAGE_SQLITE_BUSY_TIMEOUT_MS = 5_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/* A month, not a day. A day is shorter than the gap between two ordinary
   working sessions, so the strip an agent had built up was routinely empty
   again by the next morning. A month keeps a useful average over time and
   still lets a route that stopped being searched fall out of it. */
export const LOCATION_USAGE_RECENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const LOCATION_USAGE_RECENT_MAX_ENTRIES = 2_048;

/* «La idea de mantener una media es que el conteo expire en un mes»: a use
   counts towards the ranking for a month and then stops counting, so a station
   searched thirty times last month and ten times this one stands behind a
   station searched twenty times this month. The window is a different concern
   from `LOCATION_USAGE_RECENT_TTL_MS` — that one is how long a route stays on
   one browser's «Recientes» strip — so it is a separate constant and a separate
   option even though the two happen to hold the same length today.

   It is counted in whole days rather than milliseconds because the buckets it
   reads are whole days; an option in milliseconds would promise a resolution
   the storage does not have. */
export const LOCATION_USAGE_RANKING_WINDOW_DAYS = 30;

const CREATE_LOCATION_USAGE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS location_usage (
    role TEXT NOT NULL,
    code TEXT NOT NULL,
    total_uses INTEGER NOT NULL,
    last_used_at_ms INTEGER NOT NULL,
    PRIMARY KEY (role, code)
  );
`;

/* One row per station per day, which is what makes an expiry possible at all:
   an individual use cannot be taken back out of a running total, so
   `total_uses` could only ever grow and the leading cards were settled for
   good — MAD stands at 1425 on this deployment and outranks everything for as
   long as it is searched once a month, however cold the route has gone.

   Per day rather than per use: the table stays bounded (stations seen in the
   window × 31 rows, some 2,700 at today's volume, against an unbounded row per
   search), the ranking is one grouped scan of it, and a use leaves the count at
   a day boundary instead of blinking out mid-afternoon on its thirtieth day.
   `day` is the UTC day number — monotone, and the same integer in the web unit
   and in the runner whatever the host's timezone is. */
const CREATE_LOCATION_USAGE_DAILY_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS location_usage_daily (
    role TEXT NOT NULL,
    code TEXT NOT NULL,
    day INTEGER NOT NULL,
    uses INTEGER NOT NULL,
    PRIMARY KEY (role, code, day)
  );
`;

/* Covering for the ranking read, the one that runs on every idle screen: role
   and day select the window, code and uses complete the grouped sum without
   going back to the table. Pruning scans instead of seeking, which is what a
   few thousand rows deserve. */
const CREATE_LOCATION_USAGE_DAILY_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_location_usage_daily_role_window
    ON location_usage_daily (role, day, code, uses);
`;

/* `total_uses` orders nothing any more. The column stays — it is the honest
   lifetime figure, and rewriting a live table to remove it would buy nothing —
   but the index that existed only to serve that ordering goes. */
const DROP_LOCATION_USAGE_RANK_INDEX_SQL = `
  DROP INDEX IF EXISTS idx_location_usage_role_rank;
`;

/* The newest card of each role is a second ordering over the same table, so it
   gets its own index rather than a scan: the ranking read runs on every idle
   screen. */
const CREATE_LOCATION_USAGE_NEWEST_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_location_usage_role_newest
    ON location_usage (role, last_used_at_ms DESC, code ASC);
`;

const CREATE_LOCATION_RECENT_USAGE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS location_recent_usage (
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    code TEXT NOT NULL,
    last_used_at_ms INTEGER NOT NULL,
    PRIMARY KEY (session_id, role, code)
  );
`;

const CREATE_LOCATION_RECENT_USAGE_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_location_recent_usage_session_role_rank
    ON location_recent_usage (session_id, role, last_used_at_ms DESC, code ASC);
  CREATE INDEX IF NOT EXISTS idx_location_recent_usage_expiry
    ON location_recent_usage (last_used_at_ms ASC);
`;

export type LocationUsageRole = "origin" | "destination";

export type LocationUsageSuggestions = Record<LocationUsageRole, string[]>;

export interface LocationUsageSuggestionGroups {
  frequent: LocationUsageSuggestions;
  recent: LocationUsageSuggestions;
}

export interface LocationUsageStoreOptions {
  dbPath?: string;
  rankingWindowDays?: number;
  recentTtlMs?: number;
  recentMaxEntries?: number;
}

interface LocationUsageEntry {
  role: LocationUsageRole;
  code: string;
  /* Lifetime, kept for the record and for diagnostics; the ranking reads
     `dailyUses`, which is the sqlite table's `(day -> uses)` in a map. */
  totalUses: number;
  lastUsedAtMs: number;
  dailyUses: Map<number, number>;
}

interface LocationRecentUsageEntry {
  sessionId: string;
  role: LocationUsageRole;
  code: string;
  lastUsedAtMs: number;
}

interface LocationUsageRow {
  code: string;
}

interface LocationUsageCountRow {
  entries: number;
}

interface SqliteTableInfoRow {
  name: string;
}

function entryKey(role: LocationUsageRole, code: string): string {
  return `${role}:${code}`;
}

function recentEntryKey(sessionId: string, role: LocationUsageRole, code: string): string {
  return `${sessionId}:${role}:${code}`;
}

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

function getSql<T>(db: Database, sql: string, ...params: any[]): T | undefined {
  const statement = db.prepare(sql);
  try {
    return statement.get(...params) as T | undefined;
  } finally {
    statement.finalize();
  }
}

/* The UTC day number: monotone, and the same integer in every process that
   opens the file. */
function dayNumber(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS);
}

function resolveNowMs(nowMs: number | undefined): number {
  return Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
}

function normalizeLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(
    LOCATION_USAGE_CARD_LIMIT,
    Math.trunc(Number(limit) || LOCATION_USAGE_CARD_LIMIT),
  ));
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.max(1, Math.trunc(numeric)) : fallback;
}

function normalizeLocationUsageCode(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim().toUpperCase();
  const match = normalized.match(/^[A-Z]{3}/);
  return match?.[0];
}

export function normalizeLocationUsageSessionId(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/.test(value)) {
    return undefined;
  }

  return value;
}

/* Even a falling counter admits nobody quickly: a station the desk searched
   twenty times this month is a month of searching away from a station searched
   once. That is «una búsqueda bastaría para agregar otro comodín, y probándolo
   no aparece» exactly. So the last slot of each role answers to recency rather
   than to the count: the stations the desk really lives on hold the slots above
   it, and one executed search — from any browser, any process — puts a new
   station on the row for everybody, at once. */
function withNewestCard(
  leaders: readonly string[],
  newest: string | undefined,
  limit: number,
): string[] {
  const ranked = leaders.slice(0, limit);
  if (limit < 2 || !newest) {
    return ranked;
  }

  const head = ranked.slice(0, limit - 1);
  return head.includes(newest) ? ranked : [...head, newest];
}

function liveUsesInWindow(entry: LocationUsageEntry, cutoffDay: number): number {
  let live = 0;
  for (const [day, uses] of entry.dailyUses) {
    if (day >= cutoffDay) {
      live += uses;
    }
  }

  return live;
}

function rankMemoryEntries(
  entries: Iterable<LocationUsageEntry>,
  role: LocationUsageRole,
  limit: number,
  cutoffDay: number,
): string[] {
  const roleEntries = [...entries].filter((entry) => entry.role === role);
  const leaders = roleEntries
    .map((entry) => ({ entry, liveUses: liveUsesInWindow(entry, cutoffDay) }))
    /* A station whose every use has aged out is off the ranking entirely, which
       is what the sqlite side gets for free — the window clause simply does not
       see its rows. It can still hold the newest card below. */
    .filter((ranked) => ranked.liveUses > 0)
    .sort((left, right) => {
      const liveDelta = right.liveUses - left.liveUses;
      if (liveDelta !== 0) return liveDelta;

      const touchedDelta = right.entry.lastUsedAtMs - left.entry.lastUsedAtMs;
      if (touchedDelta !== 0) return touchedDelta;

      return left.entry.code.localeCompare(right.entry.code);
    })
    .slice(0, limit)
    .map((ranked) => ranked.entry.code);
  const newest = [...roleEntries]
    .sort((left, right) => (
      right.lastUsedAtMs - left.lastUsedAtMs || left.code.localeCompare(right.code)
    ))[0]?.code;

  return withNewestCard(leaders, newest, limit);
}

function rankMemoryRecentEntries(
  entries: Iterable<LocationRecentUsageEntry>,
  sessionId: string,
  role: LocationUsageRole,
  limit: number,
): string[] {
  return [...entries]
    .filter((entry) => entry.sessionId === sessionId && entry.role === role)
    .sort((left, right) => {
      const touchedDelta = right.lastUsedAtMs - left.lastUsedAtMs;
      return touchedDelta || left.code.localeCompare(right.code);
    })
    .slice(0, limit)
    .map((entry) => entry.code);
}

export class LocationUsageStore {
  private readonly entries = new Map<string, LocationUsageEntry>();
  private readonly recentEntries = new Map<string, LocationRecentUsageEntry>();
  private readonly dbPath: string | undefined;
  private readonly db: Database | undefined;
  private readonly rankingWindowDays: number;
  private readonly recentTtlMs: number;
  private readonly recentMaxEntries: number;
  private closed = false;

  constructor(options?: LocationUsageStoreOptions) {
    this.dbPath = options?.dbPath?.trim() || undefined;
    this.rankingWindowDays = normalizePositiveInteger(
      options?.rankingWindowDays,
      LOCATION_USAGE_RANKING_WINDOW_DAYS,
    );
    this.recentTtlMs = normalizePositiveInteger(options?.recentTtlMs, LOCATION_USAGE_RECENT_TTL_MS);
    this.recentMaxEntries = normalizePositiveInteger(options?.recentMaxEntries, LOCATION_USAGE_RECENT_MAX_ENTRIES);

    if (this.dbPath) {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      this.db = new Database(this.dbPath);
      this.initializeDatabase();
    }
  }

  recordFromSearch(
    request: { origin?: unknown; destination?: unknown },
    nowMs = Date.now(),
    limit = LOCATION_USAGE_CARD_LIMIT,
    clientSessionId?: unknown,
  ): LocationUsageSuggestions {
    const resolvedNowMs = resolveNowMs(nowMs);
    const sessionId = normalizeLocationUsageSessionId(clientSessionId);
    const locations = ([
      ["origin", normalizeLocationUsageCode(request.origin)],
      ["destination", normalizeLocationUsageCode(request.destination)],
    ] as const).filter((entry): entry is readonly [LocationUsageRole, string] => Boolean(entry[1]));

    if (this.db) {
      this.recordPersistedLocations(locations, resolvedNowMs);
      if (sessionId) {
        this.recordPersistedRecentLocations(sessionId, locations, resolvedNowMs);
      } else {
        this.prunePersistedRecentEntries(resolvedNowMs);
      }
    } else {
      for (const [role, code] of locations) {
        this.recordMemoryLocation(role, code, resolvedNowMs);
        if (sessionId) {
          this.recordMemoryRecentLocation(sessionId, role, code, resolvedNowMs);
        }
      }
      this.pruneMemoryDailyUses(resolvedNowMs);
      this.pruneMemoryRecentEntries(resolvedNowMs);
    }

    return this.getSuggestions(limit, resolvedNowMs);
  }

  getSuggestions(
    limit = LOCATION_USAGE_CARD_LIMIT,
    nowMs = Date.now(),
  ): LocationUsageSuggestions {
    const resolvedLimit = normalizeLimit(limit);
    const cutoffDay = this.cutoffDayFor(resolveNowMs(nowMs));

    if (!this.db) {
      return {
        origin: rankMemoryEntries(this.entries.values(), "origin", resolvedLimit, cutoffDay),
        destination: rankMemoryEntries(this.entries.values(), "destination", resolvedLimit, cutoffDay),
      };
    }

    /* Read-only on purpose. Everything outside the window is already excluded
       by the window clause, so expiring rows are housekeeping and belong on the
       write path; this is the request every idle screen makes, and the web unit
       and the runner share the file. */
    const readRanking = this.db.transaction(() => ({
      origin: this.readPersistedRoleCards("origin", resolvedLimit, cutoffDay),
      destination: this.readPersistedRoleCards("destination", resolvedLimit, cutoffDay),
    }));
    return readRanking();
  }

  getUsageSuggestions(
    clientSessionId?: unknown,
    limit = LOCATION_USAGE_CARD_LIMIT,
    nowMs = Date.now(),
  ): LocationUsageSuggestionGroups {
    const resolvedLimit = normalizeLimit(limit);
    const resolvedNowMs = resolveNowMs(nowMs);
    const sessionId = normalizeLocationUsageSessionId(clientSessionId);
    const frequent = this.getSuggestions(resolvedLimit, resolvedNowMs);
    if (!sessionId) {
      if (this.db) {
        this.prunePersistedRecentEntries(resolvedNowMs);
      } else {
        this.pruneMemoryRecentEntries(resolvedNowMs);
      }
      return { frequent, recent: { origin: [], destination: [] } };
    }

    if (!this.db) {
      this.pruneMemoryRecentEntries(resolvedNowMs);
      return {
        frequent,
        recent: {
          origin: rankMemoryRecentEntries(this.recentEntries.values(), sessionId, "origin", resolvedLimit),
          destination: rankMemoryRecentEntries(this.recentEntries.values(), sessionId, "destination", resolvedLimit),
        },
      };
    }

    this.prunePersistedRecentEntries(resolvedNowMs);
    const readRecent = this.db.transaction(() => ({
      origin: this.readPersistedRecentRoleRanking(sessionId, "origin", resolvedLimit),
      destination: this.readPersistedRecentRoleRanking(sessionId, "destination", resolvedLimit),
    }));
    return { frequent, recent: readRecent() };
  }

  getDiagnostics() {
    const dailyEntries = this.db
      ? Number(getSql<LocationUsageCountRow>(
        this.db,
        "SELECT COUNT(*) AS entries FROM location_usage_daily",
      )?.entries ?? 0)
      : [...this.entries.values()].reduce((total, entry) => total + entry.dailyUses.size, 0);
    const entries = this.db
      ? Number(getSql<LocationUsageCountRow>(
        this.db,
        "SELECT COUNT(*) AS entries FROM location_usage",
      )?.entries ?? 0)
      : this.entries.size;
    const recentEntries = this.db
      ? Number(getSql<LocationUsageCountRow>(
        this.db,
        "SELECT COUNT(*) AS entries FROM location_recent_usage",
      )?.entries ?? 0)
      : this.recentEntries.size;

    return {
      entries,
      dailyEntries,
      recentEntries,
      persistence: this.dbPath ? "sqlite" : "memory",
      ranking: "rolling-window-uses-with-newest-card",
      cardLimit: LOCATION_USAGE_CARD_LIMIT,
      rankingWindowDays: this.rankingWindowDays,
      recentTtlMs: this.recentTtlMs,
      recentMaxEntries: this.recentMaxEntries,
    };
  }

  clearForTests(): void {
    this.entries.clear();
    this.recentEntries.clear();
    if (this.db) {
      runSql(this.db, "DELETE FROM location_usage");
      runSql(this.db, "DELETE FROM location_usage_daily");
      runSql(this.db, "DELETE FROM location_recent_usage");
    }
  }

  close(): void {
    if (this.db && !this.closed) {
      try {
        runSql(this.db, "PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {
        // Closing the database is still the important cleanup path.
      }
      this.db.close();
      this.closed = true;
    }
  }

  private initializeDatabase(): void {
    if (!this.db) {
      return;
    }

    this.db.exec(`
      PRAGMA busy_timeout = ${LOCATION_USAGE_SQLITE_BUSY_TIMEOUT_MS};
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      ${CREATE_LOCATION_USAGE_TABLE_SQL}
      ${CREATE_LOCATION_USAGE_DAILY_TABLE_SQL}
      ${CREATE_LOCATION_RECENT_USAGE_TABLE_SQL}
    `);
    this.removeLegacyRecentUsageColumn();
    /* `CREATE TABLE IF NOT EXISTS` and a dropped index: a database written
       before the window existed opens, keeps every row it had, and starts
       filling `location_usage_daily` from the next search. Nothing is seeded
       from `total_uses` — there is no way to know when those uses happened, and
       dating them all to `last_used_at_ms` would drop the whole backlog onto
       one day and hand it the window it is meant to lose. */
    this.db.exec(DROP_LOCATION_USAGE_RANK_INDEX_SQL);
    this.db.exec(CREATE_LOCATION_USAGE_DAILY_INDEX_SQL);
    this.db.exec(CREATE_LOCATION_USAGE_NEWEST_INDEX_SQL);
    this.db.exec(CREATE_LOCATION_RECENT_USAGE_INDEXES_SQL);
  }

  private removeLegacyRecentUsageColumn(): void {
    if (!this.db) {
      return;
    }

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const columns = allSql<SqliteTableInfoRow>(this.db, "PRAGMA table_info(location_usage)");
      if (columns.some((column) => column.name === "recent_uses_ms")) {
        this.db.exec(`
          DROP INDEX IF EXISTS idx_location_usage_role_rank;
          ALTER TABLE location_usage DROP COLUMN recent_uses_ms;
        `);
      }
      this.db.exec("COMMIT;");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // Preserve the original migration error.
      }
      throw error;
    }
  }

  private recordPersistedLocations(
    locations: ReadonlyArray<readonly [LocationUsageRole, string]>,
    nowMs: number,
  ): void {
    if (!this.db || locations.length === 0) {
      return;
    }

    const upsertLifetime = this.db.prepare(`
      INSERT INTO location_usage (role, code, total_uses, last_used_at_ms)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(role, code) DO UPDATE SET
        total_uses = location_usage.total_uses + 1,
        last_used_at_ms = MAX(location_usage.last_used_at_ms, excluded.last_used_at_ms)
    `);
    const upsertDaily = this.db.prepare(`
      INSERT INTO location_usage_daily (role, code, day, uses)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(role, code, day) DO UPDATE SET
        uses = location_usage_daily.uses + 1
    `);

    try {
      const day = dayNumber(nowMs);
      const record = this.db.transaction(() => {
        for (const [role, code] of locations) {
          upsertLifetime.run(role, code, nowMs);
          upsertDaily.run(role, code, day);
        }
        this.deleteExpiredPersistedDailyUses(nowMs);
      });
      record();
    } finally {
      upsertLifetime.finalize();
      upsertDaily.finalize();
    }
  }

  /* Housekeeping, not correctness: the ranking clause already ignores a day
     outside the window, so this only keeps the table at its bound — the
     stations seen in the window, times the days in it. */
  private deleteExpiredPersistedDailyUses(nowMs: number): void {
    if (!this.db) {
      return;
    }

    runSql(
      this.db,
      "DELETE FROM location_usage_daily WHERE day < ?",
      this.cutoffDayFor(nowMs),
    );
  }

  /* A use recorded on day D counts for the whole of day D and the window's
     worth of days after it, and stops counting when the UTC day rolls past
     that. Rounding to the day is the point: an agent should not watch a card
     move because a use turned thirty days old mid-afternoon. */
  private cutoffDayFor(nowMs: number): number {
    return dayNumber(nowMs) - this.rankingWindowDays;
  }

  private recordMemoryLocation(role: LocationUsageRole, code: string, nowMs: number): void {
    const key = entryKey(role, code);
    const existing = this.entries.get(key);
    const dailyUses = existing?.dailyUses ?? new Map<number, number>();
    const day = dayNumber(nowMs);
    dailyUses.set(day, (dailyUses.get(day) ?? 0) + 1);

    this.entries.set(key, {
      role,
      code,
      totalUses: (existing?.totalUses ?? 0) + 1,
      lastUsedAtMs: Math.max(existing?.lastUsedAtMs ?? 0, nowMs),
      dailyUses,
    });
  }

  /* The same bound the sqlite path keeps, so a runtime configured without a
     `dbPath` cannot quietly go on ranking by lifetime totals. The entry itself
     survives an empty map: `lastUsedAtMs` is what the newest card reads, and
     the persisted `location_usage` row is not deleted either. */
  private pruneMemoryDailyUses(nowMs: number): void {
    const cutoffDay = this.cutoffDayFor(nowMs);
    for (const entry of this.entries.values()) {
      for (const day of entry.dailyUses.keys()) {
        if (day < cutoffDay) {
          entry.dailyUses.delete(day);
        }
      }
    }
  }

  private recordPersistedRecentLocations(
    sessionId: string,
    locations: ReadonlyArray<readonly [LocationUsageRole, string]>,
    nowMs: number,
  ): void {
    if (!this.db || locations.length === 0) {
      return;
    }

    const upsert = this.db.prepare(`
      INSERT INTO location_recent_usage (session_id, role, code, last_used_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, role, code) DO UPDATE SET
        last_used_at_ms = MAX(location_recent_usage.last_used_at_ms, excluded.last_used_at_ms)
    `);
    const trimSessionRole = this.db.prepare(`
      DELETE FROM location_recent_usage
      WHERE session_id = ?
        AND role = ?
        AND rowid NOT IN (
          SELECT rowid
          FROM location_recent_usage
          WHERE session_id = ? AND role = ?
          ORDER BY last_used_at_ms DESC, code ASC
          LIMIT ?
        )
    `);

    try {
      const record = this.db.transaction(() => {
        this.deleteExpiredPersistedRecentEntries(nowMs);
        for (const [role, code] of locations) {
          upsert.run(sessionId, role, code, nowMs);
          trimSessionRole.run(sessionId, role, sessionId, role, LOCATION_USAGE_CARD_LIMIT);
        }
        this.trimPersistedRecentEntriesGlobally();
      });
      record();
    } finally {
      upsert.finalize();
      trimSessionRole.finalize();
    }
  }

  private recordMemoryRecentLocation(
    sessionId: string,
    role: LocationUsageRole,
    code: string,
    nowMs: number,
  ): void {
    this.recentEntries.set(recentEntryKey(sessionId, role, code), {
      sessionId,
      role,
      code,
      lastUsedAtMs: Math.max(
        this.recentEntries.get(recentEntryKey(sessionId, role, code))?.lastUsedAtMs ?? 0,
        nowMs,
      ),
    });

    const ranked = [...this.recentEntries.values()]
      .filter((entry) => entry.sessionId === sessionId && entry.role === role)
      .sort((left, right) => (
        right.lastUsedAtMs - left.lastUsedAtMs || left.code.localeCompare(right.code)
      ));
    for (const entry of ranked.slice(LOCATION_USAGE_CARD_LIMIT)) {
      this.recentEntries.delete(recentEntryKey(entry.sessionId, entry.role, entry.code));
    }
  }

  private pruneMemoryRecentEntries(nowMs: number): void {
    const expiresBeforeMs = nowMs - this.recentTtlMs;
    for (const [key, entry] of this.recentEntries) {
      if (entry.lastUsedAtMs < expiresBeforeMs) {
        this.recentEntries.delete(key);
      }
    }

    const ranked = [...this.recentEntries.values()].sort((left, right) => (
      right.lastUsedAtMs - left.lastUsedAtMs
      || left.sessionId.localeCompare(right.sessionId)
      || left.role.localeCompare(right.role)
      || left.code.localeCompare(right.code)
    ));
    for (const entry of ranked.slice(this.recentMaxEntries)) {
      this.recentEntries.delete(recentEntryKey(entry.sessionId, entry.role, entry.code));
    }
  }

  private prunePersistedRecentEntries(nowMs: number): void {
    if (!this.db) {
      return;
    }

    const prune = this.db.transaction(() => {
      this.deleteExpiredPersistedRecentEntries(nowMs);
      this.trimPersistedRecentEntriesGlobally();
    });
    prune();
  }

  private deleteExpiredPersistedRecentEntries(nowMs: number): void {
    if (!this.db) {
      return;
    }

    runSql(
      this.db,
      "DELETE FROM location_recent_usage WHERE last_used_at_ms < ?",
      nowMs - this.recentTtlMs,
    );
  }

  private trimPersistedRecentEntriesGlobally(): void {
    if (!this.db) {
      return;
    }

    runSql(
      this.db,
      `
        DELETE FROM location_recent_usage
        WHERE rowid IN (
          SELECT rowid
          FROM location_recent_usage
          ORDER BY last_used_at_ms DESC, session_id ASC, role ASC, code ASC
          LIMIT -1 OFFSET ?
        )
      `,
      this.recentMaxEntries,
    );
  }

  private readPersistedRoleCards(
    role: LocationUsageRole,
    limit: number,
    cutoffDay: number,
  ): string[] {
    return withNewestCard(
      this.readPersistedRoleRanking(role, limit, cutoffDay),
      limit < 2 ? undefined : this.readPersistedRoleNewest(role),
      limit,
    );
  }

  private readPersistedRoleNewest(role: LocationUsageRole): string | undefined {
    if (!this.db) {
      return undefined;
    }

    return getSql<LocationUsageRow>(
      this.db,
      `
        SELECT code
        FROM location_usage
        WHERE role = ?
        ORDER BY last_used_at_ms DESC, code ASC
        LIMIT 1
      `,
      role,
    )?.code;
  }

  private readPersistedRoleRanking(
    role: LocationUsageRole,
    limit: number,
    cutoffDay: number,
  ): string[] {
    if (!this.db) {
      return [];
    }

    /* The join exists for the tie-break alone: `location_usage` holds at most
       one row per (role, code), so `MAX(lifetime.last_used_at_ms)` over the
       group is that row's own value, and two stations on the same live count
       are still separated to the millisecond rather than to the day. */
    return allSql<LocationUsageRow>(
      this.db,
      `
        SELECT daily.code AS code
        FROM location_usage_daily AS daily
        LEFT JOIN location_usage AS lifetime
          ON lifetime.role = daily.role AND lifetime.code = daily.code
        WHERE daily.role = ? AND daily.day >= ?
        GROUP BY daily.code
        ORDER BY SUM(daily.uses) DESC, MAX(lifetime.last_used_at_ms) DESC, daily.code ASC
        LIMIT ?
      `,
      role,
      cutoffDay,
      limit,
    ).map((row) => row.code);
  }

  private readPersistedRecentRoleRanking(
    sessionId: string,
    role: LocationUsageRole,
    limit: number,
  ): string[] {
    if (!this.db) {
      return [];
    }

    return allSql<LocationUsageRow>(
      this.db,
      `
        SELECT code
        FROM location_recent_usage
        WHERE session_id = ? AND role = ?
        ORDER BY last_used_at_ms DESC, code ASC
        LIMIT ?
      `,
      sessionId,
      role,
      limit,
    ).map((row) => row.code);
  }
}
