import { getBrowserClientSessionId } from "@/lib/browser-client-session"
import { normalizeLocationSuggestions } from "@/lib/locations"
import type { LocationSuggestion } from "@/types"

type LocationUsageRole = "origin" | "destination"

export type LocationUsageSuggestions = Record<LocationUsageRole, string[]>

export interface LocationUsageSuggestionGroups {
  frequent: LocationUsageSuggestions
  recent: LocationUsageSuggestions
  /** The station a listed code names, where the server knows one; a code without is drawn alone. */
  stations: ReadonlyMap<string, LocationSuggestion>
}

type LocationUsageApiResponse = {
  suggestions?: Partial<Record<LocationUsageRole, unknown>>
  frequent?: Partial<Record<LocationUsageRole, unknown>>
  recent?: Partial<Record<LocationUsageRole, unknown>>
  stations?: unknown
}

function normalizeLocationUsageCode(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim().toUpperCase()
  const match = normalized.match(/^[A-Z]{3}/)
  return match?.[0]
}

function normalizeCodes(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return []
  }

  const codes: string[] = []
  const seen = new Set<string>()
  for (const value of input) {
    const code = normalizeLocationUsageCode(value)
    if (!code || seen.has(code)) {
      continue
    }

    seen.add(code)
    codes.push(code)
    if (codes.length >= 3) {
      break
    }
  }
  return codes
}

function isStationCandidate(value: unknown): value is LocationSuggestion {
  return Boolean(value) && typeof value === "object" && typeof (value as { code?: unknown }).code === "string"
}

/* A server from before `stations` sends none, and its codes are drawn alone:
   the rows keep their anatomy and lose only the names. The stations pass
   through the normalization the matches pass through, so one code reads the
   same in both states of the panel. */
function normalizeStations(input: unknown): Map<string, LocationSuggestion> {
  const stations = new Map<string, LocationSuggestion>()
  if (!Array.isArray(input)) {
    return stations
  }

  for (const station of normalizeLocationSuggestions(input.filter(isStationCandidate))) {
    if (station.code && !stations.has(station.code)) {
      stations.set(station.code, station)
    }
  }
  return stations
}

function normalizeLocationUsageSuggestions(input: unknown): LocationUsageSuggestionGroups {
  const payload = input && typeof input === "object" ? input as LocationUsageApiResponse : {}
  return {
    frequent: {
      origin: normalizeCodes(payload.frequent?.origin ?? payload.suggestions?.origin),
      destination: normalizeCodes(payload.frequent?.destination ?? payload.suggestions?.destination),
    },
    recent: {
      origin: normalizeCodes(payload.recent?.origin),
      destination: normalizeCodes(payload.recent?.destination),
    },
    stations: normalizeStations(payload.stations),
  }
}

export async function getLocationUsageSuggestions({ signal }: { signal?: AbortSignal } = {}): Promise<LocationUsageSuggestionGroups> {
  try {
    const clientSessionId = getBrowserClientSessionId()
    const url = clientSessionId
      ? `/api/location-usage-suggestions?clientSessionId=${encodeURIComponent(clientSessionId)}`
      : "/api/location-usage-suggestions"
    const response = await fetch(url, { method: "GET", cache: "no-store", signal })
    return response.ok ? normalizeLocationUsageSuggestions(await response.json()) : emptyLocationUsageSuggestions()
  } catch {
    return emptyLocationUsageSuggestions()
  }
}

export function emptyLocationUsageSuggestions(): LocationUsageSuggestionGroups {
  return {
    frequent: { origin: [], destination: [] },
    recent: { origin: [], destination: [] },
    stations: new Map(),
  }
}
