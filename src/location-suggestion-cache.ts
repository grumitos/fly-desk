import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import Database = require("better-sqlite3");
import { LocationSuggestion, ProviderId } from "./core/types";

export const LOCATION_SUGGESTION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOCATION_SUGGESTION_CACHE_MAX_ENTRIES_PER_SESSION = 80;

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

interface PersistedLocationSuggestionCache {
  version: 1;
  savedAt: string;
  entries: Array<{
    key: string;
    suggestions: LocationSuggestion[];
    expiresAtMs: number;
    touchedAtMs: number;
  }>;
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
  legacyPersistPath?: string;
  persistPath?: string;
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

export class LocationSuggestionCacheStore {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<LocationSuggestion[]>>();
  private readonly sessionKeys = new Map<string, Set<string>>();
  private readonly dbPath: string | undefined;
  private readonly legacyPersistPath: string | undefined;
  private readonly db: Database.Database | undefined;
  private bootstrapping = false;

  constructor(options?: LocationSuggestionCacheStoreOptions) {
    this.dbPath = options?.dbPath?.trim() || undefined;
    this.legacyPersistPath = options?.legacyPersistPath?.trim() || options?.persistPath?.trim() || undefined;

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
    const normalizedLimit = Math.max(1, Math.trunc(limit));
    const key = cacheKey({
      sessionId: normalizedSessionId,
      providerId,
      query,
      limit: normalizedLimit,
    });
    const nowMs = Date.now();
    const cached = this.entries.get(key);

    if (cached && cached.expiresAtMs > nowMs) {
      cached.touchedAtMs = nowMs;
      this.persistEntry(key, normalizedSessionId, providerId, query, normalizedLimit, cached);
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
        this.trimSession(normalizedSessionId);
        this.persistEntry(key, normalizedSessionId, providerId, query, normalizedLimit, nextEntry);
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
        const sessionId = key.split("::", 1)[0] ?? "anonymous";
        this.deleteKey(sessionId, key);
      }
    }

    this.db?.prepare("DELETE FROM location_suggestions WHERE expires_at_ms <= ?").run(nowMs);
  }

  getDiagnostics() {
    return {
      ttlMs: LOCATION_SUGGESTION_CACHE_TTL_MS,
      sessions: this.sessionKeys.size,
      entries: this.entries.size,
      inflight: this.inflight.size,
      persistence: this.dbPath ? "sqlite" : "disabled",
    };
  }

  close(): void {
    this.db?.close();
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
      this.db?.prepare("DELETE FROM location_suggestions WHERE key = ?").run(key);
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
      this.db.prepare("DELETE FROM location_suggestions WHERE expires_at_ms <= ?").run(Date.now());
      const migrated = this.migrateLegacyJsonIfNeeded();
      if (!migrated) {
        this.loadSqlitePayload();
      }
    } finally {
      this.bootstrapping = false;
    }

    this.purgeExpired();
  }

  private migrateLegacyJsonIfNeeded(): boolean {
    if (!this.db || !this.legacyPersistPath || !existsSync(this.legacyPersistPath) || this.databaseHasRows()) {
      return false;
    }

    const parsed = this.readLegacyJsonPayload();
    if (!parsed) {
      return false;
    }

    this.loadLegacyPayload(parsed);
    this.persistAllEntries();

    try {
      rmSync(this.legacyPersistPath, { force: true });
    } catch {
      // Keep the imported SQLite cache even if the old JSON file cannot be removed.
    }
    return true;
  }

  private readLegacyJsonPayload(): PersistedLocationSuggestionCache | undefined {
    if (!this.legacyPersistPath) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(readFileSync(this.legacyPersistPath, "utf8")) as PersistedLocationSuggestionCache;
      if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  private databaseHasRows(): boolean {
    if (!this.db) {
      return false;
    }

    const row = this.db
      .prepare("SELECT COUNT(*) AS total FROM location_suggestions")
      .get() as { total?: number } | undefined;
    return Number(row?.total ?? 0) > 0;
  }

  private loadSqlitePayload(): void {
    if (!this.db) {
      return;
    }

    const rows = this.db
      .prepare("SELECT key, session_id, expires_at_ms, touched_at_ms, payload FROM location_suggestions ORDER BY key")
      .all() as SqliteLocationSuggestionRow[];

    for (const row of rows) {
      const suggestions = parseJsonPayload<LocationSuggestion[]>(row.payload);
      if (!Array.isArray(suggestions)) {
        this.db.prepare("DELETE FROM location_suggestions WHERE key = ?").run(row.key);
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

  private loadLegacyPayload(parsed: PersistedLocationSuggestionCache): void {
    const nowMs = Date.now();
    for (const entry of parsed.entries) {
      const key = String(entry?.key ?? "").trim();
      if (!key || !Array.isArray(entry?.suggestions)) {
        continue;
      }

      const expiresAtMs = Number(entry.expiresAtMs);
      const touchedAtMs = Number(entry.touchedAtMs);
      if (!Number.isFinite(expiresAtMs) || !Number.isFinite(touchedAtMs) || expiresAtMs <= nowMs) {
        continue;
      }

      const sessionId = key.split("::", 1)[0] ?? "anonymous";
      this.entries.set(key, {
        suggestions: cloneSuggestions(entry.suggestions),
        expiresAtMs,
        touchedAtMs,
      });
      this.trackKey(sessionId, key);
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

    this.db.prepare(`
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
    `).run(
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

  private persistAllEntries(): void {
    if (!this.db) {
      return;
    }

    const insert = this.db.prepare(`
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
    `);
    const write = this.db.transaction(() => {
      for (const [key, entry] of this.entries) {
        const [sessionId = "anonymous", providerId = "costamar", rawLimit = "8", query = ""] = key.split("::");
        insert.run(
          key,
          sessionId,
          providerId,
          query,
          Math.max(1, Math.trunc(Number(rawLimit) || 8)),
          entry.expiresAtMs,
          entry.touchedAtMs,
          JSON.stringify(entry.suggestions),
        );
      }
    });

    write();
  }
}
