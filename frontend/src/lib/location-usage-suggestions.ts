import type { SearchRequest } from "@/types"

export const LOCATION_USAGE_RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const LOCATION_USAGE_STORAGE_KEY = "flydesk-location-usage-v1"
const LOCATION_USAGE_RECENT_SAMPLE_LIMIT = 50
const LOCATION_USAGE_MAX_CODES_PER_ROLE = 60

type LocationUsageRole = "origin" | "destination"

type LocationUsageEntry = {
  role: LocationUsageRole
  code: string
  totalUses: number
  lastUsedAtMs: number
  recentUsesMs: number[]
}

type StoredLocationUsage = {
  version: 1
  entries: LocationUsageEntry[]
}

type StorageLike = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem?: (key: string) => void
}

type LocationUsageOptions = {
  storage?: StorageLike
  nowMs?: number
}

export type LocationUsageSuggestions = Record<LocationUsageRole, string[]>

export function recordLocationUsageFromSearch(
  request: Pick<SearchRequest, "origin" | "destination">,
  options: LocationUsageOptions = {},
): LocationUsageSuggestions {
  const nowMs = resolveNowMs(options.nowMs)
  const storage = resolveStorage(options.storage)
  const payload = readLocationUsage(storage)

  recordLocationUsage(payload, "origin", request.origin, nowMs)
  recordLocationUsage(payload, "destination", request.destination, nowMs)
  payload.entries = trimLocationUsageEntries(payload.entries, nowMs)
  writeLocationUsage(storage, payload)

  return rankLocationUsageSuggestions(payload.entries, nowMs)
}

export function getLocationUsageSuggestions(options: LocationUsageOptions = {}): LocationUsageSuggestions {
  const nowMs = resolveNowMs(options.nowMs)
  const payload = readLocationUsage(resolveStorage(options.storage))
  return rankLocationUsageSuggestions(payload.entries, nowMs)
}

function resolveNowMs(nowMs: number | undefined): number {
  return Number.isFinite(nowMs) ? Number(nowMs) : Date.now()
}

function resolveStorage(explicitStorage: StorageLike | undefined): StorageLike | undefined {
  if (explicitStorage) {
    return explicitStorage
  }

  try {
    return typeof window === "undefined" ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

function readLocationUsage(storage: StorageLike | undefined): StoredLocationUsage {
  if (!storage) {
    return { version: 1, entries: [] }
  }

  try {
    const parsed = JSON.parse(storage.getItem(LOCATION_USAGE_STORAGE_KEY) ?? "") as Partial<StoredLocationUsage>
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) {
      return { version: 1, entries: [] }
    }

    return {
      version: 1,
      entries: parsed.entries.map(normalizeStoredEntry).filter((entry): entry is LocationUsageEntry => Boolean(entry)),
    }
  } catch {
    return { version: 1, entries: [] }
  }
}

function writeLocationUsage(storage: StorageLike | undefined, payload: StoredLocationUsage): void {
  if (!storage) {
    return
  }

  try {
    storage.setItem(LOCATION_USAGE_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    try {
      storage.removeItem?.(LOCATION_USAGE_STORAGE_KEY)
    } catch {
      // Local usage suggestions are a non-critical convenience.
    }
  }
}

function recordLocationUsage(
  payload: StoredLocationUsage,
  role: LocationUsageRole,
  rawCode: string,
  nowMs: number,
): void {
  const code = normalizeLocationUsageCode(rawCode)
  if (!code) {
    return
  }

  const existing = payload.entries.find((entry) => entry.role === role && entry.code === code)
  if (existing) {
    existing.totalUses += 1
    existing.lastUsedAtMs = nowMs
    existing.recentUsesMs = trimRecentUses([...existing.recentUsesMs, nowMs], nowMs)
    return
  }

  payload.entries.push({
    role,
    code,
    totalUses: 1,
    lastUsedAtMs: nowMs,
    recentUsesMs: [nowMs],
  })
}

function rankLocationUsageSuggestions(entries: LocationUsageEntry[], nowMs: number): LocationUsageSuggestions {
  return {
    origin: rankLocationUsageRole(entries, "origin", nowMs),
    destination: rankLocationUsageRole(entries, "destination", nowMs),
  }
}

function rankLocationUsageRole(entries: LocationUsageEntry[], role: LocationUsageRole, nowMs: number): string[] {
  return entries
    .filter((entry) => entry.role === role)
    .map((entry) => ({
      ...entry,
      recentCount: countRecentUses(entry.recentUsesMs, nowMs),
    }))
    .sort((left, right) => {
      const recentDelta = right.recentCount - left.recentCount
      if (recentDelta !== 0) return recentDelta

      const totalDelta = right.totalUses - left.totalUses
      if (totalDelta !== 0) return totalDelta

      const touchedDelta = right.lastUsedAtMs - left.lastUsedAtMs
      if (touchedDelta !== 0) return touchedDelta

      return left.code.localeCompare(right.code)
    })
    .slice(0, 3)
    .map((entry) => entry.code)
}

function trimLocationUsageEntries(entries: LocationUsageEntry[], nowMs: number): LocationUsageEntry[] {
  const trimmed = entries.map((entry) => ({
    ...entry,
    recentUsesMs: trimRecentUses(entry.recentUsesMs, nowMs),
  }))

  return (["origin", "destination"] as const)
    .flatMap((role) => trimmed
      .filter((entry) => entry.role === role)
      .sort((left, right) => {
        const touchedDelta = right.lastUsedAtMs - left.lastUsedAtMs
        if (touchedDelta !== 0) return touchedDelta
        return left.code.localeCompare(right.code)
      })
      .slice(0, LOCATION_USAGE_MAX_CODES_PER_ROLE))
}

function trimRecentUses(values: number[], nowMs: number): number[] {
  const cutoffMs = nowMs - LOCATION_USAGE_RECENT_WINDOW_MS
  return values
    .filter((value) => Number.isFinite(value) && value >= cutoffMs && value <= nowMs)
    .slice(-LOCATION_USAGE_RECENT_SAMPLE_LIMIT)
}

function countRecentUses(values: number[], nowMs: number): number {
  const cutoffMs = nowMs - LOCATION_USAGE_RECENT_WINDOW_MS
  return values.filter((value) => Number.isFinite(value) && value >= cutoffMs && value <= nowMs).length
}

function normalizeStoredEntry(entry: Partial<LocationUsageEntry> | undefined): LocationUsageEntry | undefined {
  const code = normalizeLocationUsageCode(entry?.code)
  const role = entry?.role
  if (!code || (role !== "origin" && role !== "destination")) {
    return undefined
  }

  const totalUses = Math.max(1, Math.trunc(Number(entry?.totalUses) || 1))
  const lastUsedAtMs = Number(entry?.lastUsedAtMs)

  return {
    role,
    code,
    totalUses,
    lastUsedAtMs: Number.isFinite(lastUsedAtMs) ? lastUsedAtMs : 0,
    recentUsesMs: Array.isArray(entry?.recentUsesMs)
      ? entry.recentUsesMs.map(Number).filter(Number.isFinite)
      : [],
  }
}

function normalizeLocationUsageCode(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim().toUpperCase()
  const match = normalized.match(/^[A-Z]{3}/)
  return match?.[0]
}
