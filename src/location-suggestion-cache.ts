import { LocationSuggestion, ProviderId } from "./core/types";

export const LOCATION_SUGGESTION_CACHE_TTL_MS = 8 * 60 * 60 * 1000;
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

function cloneSuggestions(suggestions: ReadonlyArray<LocationSuggestion>): LocationSuggestion[] {
  return suggestions.map((suggestion) => ({ ...suggestion }));
}

function normalizeSessionId(value: string | undefined): string {
  const normalized = String(value ?? "").trim();
  return (normalized ? normalized.replaceAll("::", "__") : "") || "anonymous";
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

function sessionIdFromCacheKey(key: string): string {
  return key.split("::")[0] ?? "anonymous";
}

export class LocationSuggestionCacheStore {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<LocationSuggestion[]>>();
  private readonly sessionKeys = new Map<string, Set<string>>();

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
        return cloneSuggestions(nextSuggestions);
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
        this.deleteKey(sessionIdFromCacheKey(key), key, { preserveInflight: true });
      }
    }
  }

  getDiagnostics() {
    return {
      ttlMs: LOCATION_SUGGESTION_CACHE_TTL_MS,
      sessions: this.sessionKeys.size,
      entries: this.entries.size,
      inflight: this.inflight.size,
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

  private deleteKey(sessionId: string, key: string, options?: { preserveInflight?: boolean }): void {
    this.entries.delete(key);
    if (!options?.preserveInflight) {
      this.inflight.delete(key);
    }
    const keys = this.sessionKeys.get(sessionId);
    if (!keys) {
      return;
    }
    keys.delete(key);
    if (keys.size === 0) {
      this.sessionKeys.delete(sessionId);
    }
  }
}
