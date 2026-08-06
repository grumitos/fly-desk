import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

const LOCATION_USAGE_CARD_LIMIT = 3;
const LOCATION_USAGE_SQLITE_BUSY_TIMEOUT_MS = 5_000;

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

export type LocationUsageRole = "origin" | "destination";

export type LocationUsageSuggestions = Record<LocationUsageRole, string[]>;

export interface LocationUsageStoreOptions {
  dbPath?: string;
}

interface LocationUsageEntry {
  role: LocationUsageRole;
  code: string;
  totalUses: number;
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

function normalizeLocationUsageCode(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim().toUpperCase();
  const match = normalized.match(/^[A-Z]{3}/);
  return match?.[0];
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

export class LocationUsageStore {
  private readonly entries = new Map<string, LocationUsageEntry>();
  private readonly dbPath: string | undefined;
  private readonly db: Database | undefined;
  private closed = false;

  constructor(options?: LocationUsageStoreOptions) {
    this.dbPath = options?.dbPath?.trim() || undefined;

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
  ): LocationUsageSuggestions {
    const resolvedNowMs = resolveNowMs(nowMs);
    const locations = ([
      ["origin", normalizeLocationUsageCode(request.origin)],
      ["destination", normalizeLocationUsageCode(request.destination)],
    ] as const).filter((entry): entry is readonly [LocationUsageRole, string] => Boolean(entry[1]));

    if (this.db) {
      this.recordPersistedLocations(locations, resolvedNowMs);
    } else {
      for (const [role, code] of locations) {
        this.recordMemoryLocation(role, code, resolvedNowMs);
      }
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

  getDiagnostics() {
    const entries = this.db
      ? Number(getSql<LocationUsageCountRow>(
        this.db,
        "SELECT COUNT(*) AS entries FROM location_usage",
      )?.entries ?? 0)
      : this.entries.size;

    return {
      entries,
      persistence: this.dbPath ? "sqlite" : "memory",
      ranking: "all-time-total-uses",
      cardLimit: LOCATION_USAGE_CARD_LIMIT,
    };
  }

  clearForTests(): void {
    this.entries.clear();
    if (this.db) {
      runSql(this.db, "DELETE FROM location_usage");
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
    `);
    this.removeLegacyRecentUsageColumn();
    this.db.exec(CREATE_LOCATION_USAGE_RANK_INDEX_SQL);
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
}
