import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

export const LOCATION_USAGE_RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const LOCATION_USAGE_RECENT_SAMPLE_LIMIT = 50;
const LOCATION_USAGE_MAX_CODES_PER_ROLE = 60;
const LOCATION_USAGE_DEFAULT_LIMIT = 3;

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
  recentUsesMs: number[];
}

interface LocationUsageRow {
  role: string;
  code: string;
  total_uses: number;
  last_used_at_ms: number;
  recent_uses_ms: string;
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

function parseJsonPayload<T>(payload: string): T | undefined {
  try {
    return JSON.parse(payload) as T;
  } catch {
    return undefined;
  }
}

function resolveNowMs(nowMs: number | undefined): number {
  return Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
}

function normalizeLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(20, Math.trunc(Number(limit) || LOCATION_USAGE_DEFAULT_LIMIT)));
}

function normalizeLocationUsageCode(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim().toUpperCase();
  const match = normalized.match(/^[A-Z]{3}/);
  return match?.[0];
}

function trimRecentUses(values: number[], nowMs: number): number[] {
  const cutoffMs = nowMs - LOCATION_USAGE_RECENT_WINDOW_MS;
  return values
    .filter((value) => Number.isFinite(value) && value >= cutoffMs && value <= nowMs)
    .slice(-LOCATION_USAGE_RECENT_SAMPLE_LIMIT);
}

function countRecentUses(values: number[], nowMs: number): number {
  const cutoffMs = nowMs - LOCATION_USAGE_RECENT_WINDOW_MS;
  return values.filter((value) => Number.isFinite(value) && value >= cutoffMs && value <= nowMs).length;
}

function normalizeEntry(entry: Partial<LocationUsageEntry> | undefined): LocationUsageEntry | undefined {
  const code = normalizeLocationUsageCode(entry?.code);
  const role = entry?.role;
  if (!code || (role !== "origin" && role !== "destination")) {
    return undefined;
  }

  const totalUses = Math.max(1, Math.trunc(Number(entry?.totalUses) || 1));
  const lastUsedAtMs = Number(entry?.lastUsedAtMs);

  return {
    role,
    code,
    totalUses,
    lastUsedAtMs: Number.isFinite(lastUsedAtMs) ? lastUsedAtMs : 0,
    recentUsesMs: Array.isArray(entry?.recentUsesMs)
      ? entry.recentUsesMs.map(Number).filter(Number.isFinite)
      : [],
  };
}

function normalizeRow(row: LocationUsageRow): LocationUsageEntry | undefined {
  return normalizeEntry({
    role: row.role === "origin" || row.role === "destination" ? row.role : undefined,
    code: row.code,
    totalUses: row.total_uses,
    lastUsedAtMs: row.last_used_at_ms,
    recentUsesMs: parseJsonPayload<number[]>(row.recent_uses_ms) ?? [],
  });
}

function rankLocationUsageRole(
  entries: Iterable<LocationUsageEntry>,
  role: LocationUsageRole,
  limit: number,
  nowMs: number,
): string[] {
  return [...entries]
    .filter((entry) => entry.role === role)
    .map((entry) => ({
      ...entry,
      recentCount: countRecentUses(entry.recentUsesMs, nowMs),
    }))
    .sort((left, right) => {
      const recentDelta = right.recentCount - left.recentCount;
      if (recentDelta !== 0) return recentDelta;

      const totalDelta = right.totalUses - left.totalUses;
      if (totalDelta !== 0) return totalDelta;

      const touchedDelta = right.lastUsedAtMs - left.lastUsedAtMs;
      if (touchedDelta !== 0) return touchedDelta;

      return left.code.localeCompare(right.code);
    })
    .slice(0, limit)
    .map((entry) => entry.code);
}

function trimLocationUsageEntries(entries: LocationUsageEntry[], nowMs: number): LocationUsageEntry[] {
  const trimmed = entries.map((entry) => ({
    ...entry,
    recentUsesMs: trimRecentUses(entry.recentUsesMs, nowMs),
  }));

  return (["origin", "destination"] as const)
    .flatMap((role) => trimmed
      .filter((entry) => entry.role === role)
      .sort((left, right) => {
        const touchedDelta = right.lastUsedAtMs - left.lastUsedAtMs;
        if (touchedDelta !== 0) return touchedDelta;
        return left.code.localeCompare(right.code);
      })
      .slice(0, LOCATION_USAGE_MAX_CODES_PER_ROLE));
}

export class LocationUsageStore {
  private entries = new Map<string, LocationUsageEntry>();
  private readonly dbPath: string | undefined;
  private readonly db: Database | undefined;
  private closed = false;

  constructor(options?: LocationUsageStoreOptions) {
    this.dbPath = options?.dbPath?.trim() || undefined;

    if (this.dbPath) {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      this.db = new Database(this.dbPath);
      this.initializeDatabase();
      this.loadPersisted();
    }
  }

  recordFromSearch(
    request: { origin?: unknown; destination?: unknown },
    nowMs = Date.now(),
    limit = LOCATION_USAGE_DEFAULT_LIMIT,
  ): LocationUsageSuggestions {
    const resolvedNowMs = resolveNowMs(nowMs);
    this.recordLocationUsage("origin", request.origin, resolvedNowMs);
    this.recordLocationUsage("destination", request.destination, resolvedNowMs);
    this.entries = new Map(
      trimLocationUsageEntries([...this.entries.values()], resolvedNowMs)
        .map((entry) => [entryKey(entry.role, entry.code), entry]),
    );
    this.persistAllEntries();
    return this.getSuggestions(limit, resolvedNowMs);
  }

  getSuggestions(limit = LOCATION_USAGE_DEFAULT_LIMIT, nowMs = Date.now()): LocationUsageSuggestions {
    const resolvedLimit = normalizeLimit(limit);
    const resolvedNowMs = resolveNowMs(nowMs);
    const values = this.entries.values();

    return {
      origin: rankLocationUsageRole(values, "origin", resolvedLimit, resolvedNowMs),
      destination: rankLocationUsageRole(this.entries.values(), "destination", resolvedLimit, resolvedNowMs),
    };
  }

  getDiagnostics() {
    return {
      entries: this.entries.size,
      persistence: this.dbPath ? "sqlite" : "memory",
      recentWindowMs: LOCATION_USAGE_RECENT_WINDOW_MS,
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

  private recordLocationUsage(role: LocationUsageRole, rawCode: unknown, nowMs: number): void {
    const code = normalizeLocationUsageCode(rawCode);
    if (!code) {
      return;
    }

    const key = entryKey(role, code);
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.set(key, {
        ...existing,
        totalUses: existing.totalUses + 1,
        lastUsedAtMs: nowMs,
        recentUsesMs: trimRecentUses([...existing.recentUsesMs, nowMs], nowMs),
      });
      return;
    }

    this.entries.set(key, {
      role,
      code,
      totalUses: 1,
      lastUsedAtMs: nowMs,
      recentUsesMs: [nowMs],
    });
  }

  private initializeDatabase(): void {
    if (!this.db) {
      return;
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS location_usage (
        role TEXT NOT NULL,
        code TEXT NOT NULL,
        total_uses INTEGER NOT NULL,
        last_used_at_ms INTEGER NOT NULL,
        recent_uses_ms TEXT NOT NULL,
        PRIMARY KEY (role, code)
      );

      CREATE INDEX IF NOT EXISTS idx_location_usage_role_rank
        ON location_usage (role, last_used_at_ms);
    `);
  }

  private loadPersisted(): void {
    if (!this.db) {
      return;
    }

    const rows = allSql<LocationUsageRow>(
      this.db,
      "SELECT role, code, total_uses, last_used_at_ms, recent_uses_ms FROM location_usage ORDER BY role, code",
    );

    for (const row of rows) {
      const entry = normalizeRow(row);
      if (!entry) {
        runSql(this.db, "DELETE FROM location_usage WHERE role = ? AND code = ?", row.role, row.code);
        continue;
      }
      this.entries.set(entryKey(entry.role, entry.code), entry);
    }
  }

  private persistAllEntries(): void {
    if (!this.db) {
      return;
    }

    const insert = this.db.prepare(`
      INSERT INTO location_usage (
        role,
        code,
        total_uses,
        last_used_at_ms,
        recent_uses_ms
      ) VALUES (?, ?, ?, ?, ?)
    `);

    try {
      const write = this.db.transaction(() => {
        runSql(this.db!, "DELETE FROM location_usage");
        for (const entry of this.entries.values()) {
          insert.run(
            entry.role,
            entry.code,
            entry.totalUses,
            entry.lastUsedAtMs,
            JSON.stringify(entry.recentUsesMs),
          );
        }
      });

      write();
    } finally {
      insert.finalize();
    }
  }
}
