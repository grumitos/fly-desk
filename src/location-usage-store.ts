import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

const LOCATION_USAGE_CARD_LIMIT = 3;
const LOCATION_USAGE_SQLITE_BUSY_TIMEOUT_MS = 5_000;
export const LOCATION_USAGE_RECENT_TTL_MS = 24 * 60 * 60 * 1000;
export const LOCATION_USAGE_RECENT_MAX_ENTRIES = 2_048;

const CREATE_LOCATION_USAGE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS location_usage (
    role TEXT NOT NULL,
    code TEXT NOT NULL,
    total_uses INTEGER NOT NULL,
    last_used_at_ms INTEGER NOT NULL,
    PRIMARY KEY (role, code)
  );
`;

const CREATE_LOCATION_USAGE_RANK_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_location_usage_role_rank
    ON location_usage (role, total_uses DESC, last_used_at_ms DESC, code ASC);
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
  recentTtlMs?: number;
  recentMaxEntries?: number;
}

interface LocationUsageEntry {
  role: LocationUsageRole;
  code: string;
  totalUses: number;
  lastUsedAtMs: number;
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

function rankMemoryEntries(
  entries: Iterable<LocationUsageEntry>,
  role: LocationUsageRole,
  limit: number,
): string[] {
  return [...entries]
    .filter((entry) => entry.role === role)
    .sort((left, right) => {
      const totalDelta = right.totalUses - left.totalUses;
      if (totalDelta !== 0) return totalDelta;

      const touchedDelta = right.lastUsedAtMs - left.lastUsedAtMs;
      if (touchedDelta !== 0) return touchedDelta;

      return left.code.localeCompare(right.code);
    })
    .slice(0, limit)
    .map((entry) => entry.code);
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
  private readonly recentTtlMs: number;
  private readonly recentMaxEntries: number;
  private closed = false;

  constructor(options?: LocationUsageStoreOptions) {
    this.dbPath = options?.dbPath?.trim() || undefined;
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
      this.pruneMemoryRecentEntries(resolvedNowMs);
    }

    return this.getSuggestions(limit, resolvedNowMs);
  }

  getSuggestions(
    limit = LOCATION_USAGE_CARD_LIMIT,
    _nowMs = Date.now(),
  ): LocationUsageSuggestions {
    const resolvedLimit = normalizeLimit(limit);

    if (!this.db) {
      return {
        origin: rankMemoryEntries(this.entries.values(), "origin", resolvedLimit),
        destination: rankMemoryEntries(this.entries.values(), "destination", resolvedLimit),
      };
    }

    const readRanking = this.db.transaction(() => ({
      origin: this.readPersistedRoleRanking("origin", resolvedLimit),
      destination: this.readPersistedRoleRanking("destination", resolvedLimit),
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
      recentEntries,
      persistence: this.dbPath ? "sqlite" : "memory",
      ranking: "all-time-total-uses",
      cardLimit: LOCATION_USAGE_CARD_LIMIT,
      recentTtlMs: this.recentTtlMs,
      recentMaxEntries: this.recentMaxEntries,
    };
  }

  clearForTests(): void {
    this.entries.clear();
    this.recentEntries.clear();
    if (this.db) {
      runSql(this.db, "DELETE FROM location_usage");
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
      ${CREATE_LOCATION_RECENT_USAGE_TABLE_SQL}
    `);
    this.removeLegacyRecentUsageColumn();
    this.db.exec(CREATE_LOCATION_USAGE_RANK_INDEX_SQL);
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

    const upsert = this.db.prepare(`
      INSERT INTO location_usage (role, code, total_uses, last_used_at_ms)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(role, code) DO UPDATE SET
        total_uses = location_usage.total_uses + 1,
        last_used_at_ms = MAX(location_usage.last_used_at_ms, excluded.last_used_at_ms)
    `);

    try {
      const record = this.db.transaction(() => {
        for (const [role, code] of locations) {
          upsert.run(role, code, nowMs);
        }
      });
      record();
    } finally {
      upsert.finalize();
    }
  }

  private recordMemoryLocation(role: LocationUsageRole, code: string, nowMs: number): void {
    const key = entryKey(role, code);
    const existing = this.entries.get(key);

    this.entries.set(key, {
      role,
      code,
      totalUses: (existing?.totalUses ?? 0) + 1,
      lastUsedAtMs: Math.max(existing?.lastUsedAtMs ?? 0, nowMs),
    });
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

  private readPersistedRoleRanking(role: LocationUsageRole, limit: number): string[] {
    if (!this.db) {
      return [];
    }

    return allSql<LocationUsageRow>(
      this.db,
      `
        SELECT code
        FROM location_usage
        WHERE role = ?
        ORDER BY total_uses DESC, last_used_at_ms DESC, code ASC
        LIMIT ?
      `,
      role,
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
