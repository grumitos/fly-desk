import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { LocationSuggestion, ProviderId } from "./core/types";

export const LOCATION_SUGGESTION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOCATION_SUGGESTION_CACHE_MAX_ENTRIES_PER_SESSION = 80;
export const LOCATION_SUGGESTION_CACHE_MAX_ENTRIES = 1000;
export const LOCATION_SUGGESTION_CACHE_MAX_QUERY_CHARS = 120;

interface CacheEntry {
  suggestions: LocationSuggestion[];
  expiresAtMs: number;
  touchedAtMs: number;
}

interface CacheKeyParts {
  sessionId: string;
  providerId: ProviderId;
  query: string;
  limit: number;
}

interface SqliteLocationSuggestionRow {
  key: string;
  session_id: string;
  expires_at_ms: number;
  touched_at_ms: number;
  payload: string;
}

interface LocationSuggestionCacheStoreOptions {
  dbPath?: string;
}

function cloneSuggestions(suggestions: ReadonlyArray<LocationSuggestion>): LocationSuggestion[] {
  return suggestions.map((suggestion) => ({ ...suggestion }));
}

function normalizeSessionId(value: string | undefined): string {
  const normalized = String(value ?? "").trim();
  return normalized || "anonymous";
}

function normalizeQuery(value: string): string {
  return value.trim().toUpperCase();
}

function cacheKey(parts: CacheKeyParts): string {
  return [
    normalizeSessionId(parts.sessionId),
    parts.providerId,
    String(Math.max(1, Math.trunc(parts.limit))),
    normalizeQuery(parts.query),
  ].join("::");
}

function parseJsonPayload<T>(payload: string): T | undefined {
  try {
    return JSON.parse(payload) as T;
  } catch {
    return undefined;
  }
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

export class LocationSuggestionCacheStore {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<LocationSuggestion[]>>();
  private readonly sessionKeys = new Map<string, Set<string>>();
  private readonly dbPath: string | undefined;
  private readonly db: Database | undefined;
  private bootstrapping = false;

  constructor(options?: LocationSuggestionCacheStoreOptions) {
    this.dbPath = options?.dbPath?.trim() || undefined;

    if (this.dbPath) {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      this.db = new Database(this.dbPath);
      this.initializeDatabase();
      this.loadPersisted();
    }
  }

  async getOrLoad(
    sessionId: string | undefined,
    providerId: ProviderId,
    query: string,
    limit: number,
    loader: () => Promise<LocationSuggestion[]>,
  ): Promise<LocationSuggestion[]> {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedQuery = normalizeQuery(query);
    if (normalizedQuery.length > LOCATION_SUGGESTION_CACHE_MAX_QUERY_CHARS) {
      throw new RangeError(
        `Location suggestion query cannot exceed ${LOCATION_SUGGESTION_CACHE_MAX_QUERY_CHARS} characters.`,
      );
    }
    const normalizedLimit = Math.max(1, Math.trunc(limit));
    const key = cacheKey({
      sessionId: normalizedSessionId,
      providerId,
      query: normalizedQuery,
      limit: normalizedLimit,
    });
    const nowMs = Date.now();
    const cached = this.entries.get(key);

    if (cached && cached.expiresAtMs > nowMs) {
      cached.touchedAtMs = nowMs;
      this.persistEntry(key, normalizedSessionId, providerId, normalizedQuery, normalizedLimit, cached);
      return cloneSuggestions(cached.suggestions);
    }

    if (cached) {
      this.deleteKey(normalizedSessionId, key);
    }

    const pending = this.inflight.get(key);
    if (pending) {
      return cloneSuggestions(await pending);
    }

    const promise = loader()
      .then((suggestions) => {
        const resolvedAtMs = Date.now();
        const nextEntry = {
          suggestions: cloneSuggestions(suggestions),
          expiresAtMs: resolvedAtMs + LOCATION_SUGGESTION_CACHE_TTL_MS,
          touchedAtMs: resolvedAtMs,
        };
        this.entries.set(key, nextEntry);
        this.trackKey(normalizedSessionId, key);
        this.persistEntry(key, normalizedSessionId, providerId, normalizedQuery, normalizedLimit, nextEntry);
        this.trimSession(normalizedSessionId);
        this.trimGlobal();
        return cloneSuggestions(nextEntry.suggestions);
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return cloneSuggestions(await promise);
  }

  purgeExpired(nowMs = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs <= nowMs) {
        const sessionId = this.sessionIdForKey(key);
        this.deleteKey(sessionId, key);
      }
    }

    if (this.db) {
      runSql(this.db, "DELETE FROM location_suggestions WHERE expires_at_ms <= ?", nowMs);
    }
  }

  getDiagnostics() {
    return {
      ttlMs: LOCATION_SUGGESTION_CACHE_TTL_MS,
      sessions: this.sessionKeys.size,
      entries: this.entries.size,
      maxEntries: LOCATION_SUGGESTION_CACHE_MAX_ENTRIES,
      maxQueryChars: LOCATION_SUGGESTION_CACHE_MAX_QUERY_CHARS,
      inflight: this.inflight.size,
      persistence: this.dbPath ? "sqlite" : "disabled",
    };
  }

  close(): void {
    if (this.db) {
      try {
        this.db.run("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {
        // Closing the database is still the important cleanup path.
      }
      this.db.close(true);
    }
  }

  private trackKey(sessionId: string, key: string): void {
    const keys = this.sessionKeys.get(sessionId) ?? new Set<string>();
    keys.add(key);
    this.sessionKeys.set(sessionId, keys);
  }

  private trimSession(sessionId: string): void {
    const keys = this.sessionKeys.get(sessionId);
    if (!keys || keys.size <= LOCATION_SUGGESTION_CACHE_MAX_ENTRIES_PER_SESSION) {
      return;
    }

    const oldestKeys = [...keys]
      .map((key) => ({
        key,
        touchedAtMs: this.entries.get(key)?.touchedAtMs ?? 0,
      }))
      .sort((left, right) => left.touchedAtMs - right.touchedAtMs);

    while (keys.size > LOCATION_SUGGESTION_CACHE_MAX_ENTRIES_PER_SESSION && oldestKeys.length > 0) {
      const oldest = oldestKeys.shift();
      if (!oldest) {
        break;
      }
      this.deleteKey(sessionId, oldest.key);
    }
  }

  private trimGlobal(): void {
    if (this.entries.size <= LOCATION_SUGGESTION_CACHE_MAX_ENTRIES) {
      return;
    }

    const oldestKeys = [...this.entries]
      .map(([key, entry]) => ({ key, touchedAtMs: entry.touchedAtMs }))
      .sort((left, right) => left.touchedAtMs - right.touchedAtMs);

    while (this.entries.size > LOCATION_SUGGESTION_CACHE_MAX_ENTRIES && oldestKeys.length > 0) {
      const oldest = oldestKeys.shift();
      if (!oldest) {
        break;
      }
      this.deleteKey(this.sessionIdForKey(oldest.key), oldest.key);
    }
  }

  private sessionIdForKey(key: string): string {
    for (const [sessionId, keys] of this.sessionKeys) {
      if (keys.has(key)) {
        return sessionId;
      }
    }
    return "anonymous";
  }

  private deleteKey(sessionId: string, key: string): void {
    this.entries.delete(key);
    this.inflight.delete(key);
    const keys = this.sessionKeys.get(sessionId);
    if (keys) {
      keys.delete(key);
      if (keys.size === 0) {
        this.sessionKeys.delete(sessionId);
      }
    }

    if (!this.bootstrapping) {
      if (this.db) {
        runSql(this.db, "DELETE FROM location_suggestions WHERE key = ?", key);
      }
    }
  }

  private initializeDatabase(): void {
    if (!this.db) {
      return;
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS location_suggestions (
        key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        query TEXT NOT NULL,
        limit_value INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        touched_at_ms INTEGER NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_location_suggestions_expiry
        ON location_suggestions (expires_at_ms);

      CREATE INDEX IF NOT EXISTS idx_location_suggestions_session_touch
        ON location_suggestions (session_id, touched_at_ms);
    `);
  }

  private loadPersisted(): void {
    if (!this.db) {
      return;
    }

    try {
      this.bootstrapping = true;
      runSql(this.db, "DELETE FROM location_suggestions WHERE expires_at_ms <= ?", Date.now());
      this.loadSqlitePayload();
    } finally {
      this.bootstrapping = false;
    }

    this.purgeExpired();
  }

  private loadSqlitePayload(): void {
    if (!this.db) {
      return;
    }

    runSql(this.db, `
      DELETE FROM location_suggestions
      WHERE key NOT IN (
        SELECT key
        FROM location_suggestions
        ORDER BY touched_at_ms DESC, key DESC
        LIMIT ?
      )
    `, LOCATION_SUGGESTION_CACHE_MAX_ENTRIES);

    const rows = allSql<SqliteLocationSuggestionRow>(
      this.db,
      "SELECT key, session_id, expires_at_ms, touched_at_ms, payload FROM location_suggestions ORDER BY touched_at_ms DESC, key DESC",
    );

    for (const row of rows) {
      const suggestions = parseJsonPayload<LocationSuggestion[]>(row.payload);
      if (!Array.isArray(suggestions)) {
        runSql(this.db, "DELETE FROM location_suggestions WHERE key = ?", row.key);
        continue;
      }
      if ((this.sessionKeys.get(row.session_id)?.size ?? 0) >= LOCATION_SUGGESTION_CACHE_MAX_ENTRIES_PER_SESSION) {
        runSql(this.db, "DELETE FROM location_suggestions WHERE key = ?", row.key);
        continue;
      }

      this.entries.set(row.key, {
        suggestions: cloneSuggestions(suggestions),
        expiresAtMs: Number(row.expires_at_ms),
        touchedAtMs: Number(row.touched_at_ms),
      });
      this.trackKey(row.session_id, row.key);
    }
  }

  private persistEntry(
    key: string,
    sessionId: string,
    providerId: ProviderId,
    query: string,
    limit: number,
    entry: CacheEntry,
  ): void {
    if (!this.db || this.bootstrapping) {
      return;
    }

    runSql(this.db, `
      INSERT INTO location_suggestions (
        key,
        session_id,
        provider_id,
        query,
        limit_value,
        expires_at_ms,
        touched_at_ms,
        payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        session_id = excluded.session_id,
        provider_id = excluded.provider_id,
        query = excluded.query,
        limit_value = excluded.limit_value,
        expires_at_ms = excluded.expires_at_ms,
        touched_at_ms = excluded.touched_at_ms,
        payload = excluded.payload
    `,
      key,
      sessionId,
      providerId,
      normalizeQuery(query),
      limit,
      entry.expiresAtMs,
      entry.touchedAtMs,
      JSON.stringify(entry.suggestions),
    );
  }

}
