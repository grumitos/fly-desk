import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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

interface LocationSuggestionCacheStoreOptions {
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

export class LocationSuggestionCacheStore {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<LocationSuggestion[]>>();
  private readonly sessionKeys = new Map<string, Set<string>>();
  private readonly persistPath: string | undefined;
  private persistTimer: NodeJS.Timeout | undefined;
  private bootstrapping = false;
  private lastPersistedPayload = "";

  constructor(options?: LocationSuggestionCacheStoreOptions) {
    this.persistPath = options?.persistPath?.trim() || undefined;
    if (this.persistPath) {
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
        const nextSuggestions = cloneSuggestions(suggestions);
        this.entries.set(key, {
          suggestions: nextSuggestions,
          expiresAtMs: nowMs + LOCATION_SUGGESTION_CACHE_TTL_MS,
          touchedAtMs: nowMs,
        });
        this.trackKey(normalizedSessionId, key);
        this.trimSession(normalizedSessionId);
        this.schedulePersist();
        return cloneSuggestions(nextSuggestions);
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return cloneSuggestions(await promise);
  }

  purgeExpired(nowMs = Date.now()): void {
    let removed = false;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs <= nowMs) {
        const sessionId = key.split("::", 1)[0] ?? "anonymous";
        this.deleteKey(sessionId, key);
        removed = true;
      }
    }
    if (removed) {
      this.schedulePersist();
    }
  }

  getDiagnostics() {
    return {
      ttlMs: LOCATION_SUGGESTION_CACHE_TTL_MS,
      sessions: this.sessionKeys.size,
      entries: this.entries.size,
      inflight: this.inflight.size,
      persistence: this.persistPath ? "enabled" : "disabled",
    };
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
    if (!keys) {
      return;
    }
    keys.delete(key);
    if (keys.size === 0) {
      this.sessionKeys.delete(sessionId);
    }
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (!this.persistPath || this.bootstrapping || this.persistTimer) {
      return;
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persistNow();
    }, 120);
    this.persistTimer.unref?.();
  }

  private loadPersisted(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) {
      return;
    }

    try {
      const parsed = JSON.parse(readFileSync(this.persistPath, "utf8")) as PersistedLocationSuggestionCache;
      if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) {
        return;
      }

      this.bootstrapping = true;
      const nowMs = Date.now();
      parsed.entries.forEach((entry) => {
        const key = String(entry?.key ?? "").trim();
        if (!key) {
          return;
        }

        const expiresAtMs = Number(entry?.expiresAtMs);
        const touchedAtMs = Number(entry?.touchedAtMs);
        const suggestions = Array.isArray(entry?.suggestions)
          ? entry.suggestions.map((suggestion) => ({ ...suggestion }))
          : [];
        if (!Number.isFinite(expiresAtMs) || !Number.isFinite(touchedAtMs) || expiresAtMs <= nowMs) {
          return;
        }

        this.entries.set(key, {
          suggestions,
          expiresAtMs,
          touchedAtMs,
        });
        const sessionId = key.split("::", 1)[0] ?? "anonymous";
        this.trackKey(sessionId, key);
      });
    } catch {
      // Ignore malformed cache files and start fresh in-memory.
    } finally {
      this.bootstrapping = false;
    }

    this.lastPersistedPayload = JSON.stringify(this.buildPersistencePayload());
    this.purgeExpired();
  }

  private buildPersistencePayload(): PersistedLocationSuggestionCache {
    const entries = [...this.entries.entries()]
      .map(([key, entry]) => ({
        key,
        suggestions: cloneSuggestions(entry.suggestions),
        expiresAtMs: entry.expiresAtMs,
        touchedAtMs: entry.touchedAtMs,
      }))
      .sort((left, right) => left.key.localeCompare(right.key));

    return {
      version: 1,
      savedAt: new Date().toISOString(),
      entries,
    };
  }

  private persistNow(): void {
    if (!this.persistPath) {
      return;
    }

    try {
      const payload = this.buildPersistencePayload();
      const serialized = JSON.stringify(payload);
      if (serialized === this.lastPersistedPayload) {
        return;
      }

      mkdirSync(dirname(this.persistPath), { recursive: true });
      const tempPath = `${this.persistPath}.${process.pid}.tmp`;
      writeFileSync(tempPath, serialized, "utf8");
      renameSync(tempPath, this.persistPath);
      this.lastPersistedPayload = serialized;
    } catch {
      // Ignore persistence failures; in-memory cache remains available.
    }
  }
}
