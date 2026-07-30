import {
  getBrowserClientSessionId,
  normalizeBrowserClientSessionId,
} from "@/lib/browser-client-session"

type LocationUsageRole = "origin" | "destination"

export type LocationUsageSuggestions = Record<LocationUsageRole, string[]>

export interface LocationUsageSuggestionGroups {
  frequent: LocationUsageSuggestions
  recent: LocationUsageSuggestions
}

type LocationUsageApiResponse = {
  suggestions?: Partial<Record<LocationUsageRole, unknown>>
  frequent?: Partial<Record<LocationUsageRole, unknown>>
  recent?: Partial<Record<LocationUsageRole, unknown>>
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

type LocationUsageClientOptions = {
  clientSessionId?: string
  fetchImpl?: FetchLike
  signal?: AbortSignal
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

function emptySuggestions(): LocationUsageSuggestions {
  return {
    origin: [],
    destination: [],
  }
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
  }
}

function resolveFetch(fetchImpl: FetchLike | undefined): FetchLike {
  return fetchImpl ?? fetch
}

async function readUsageResponse(response: Response): Promise<LocationUsageSuggestionGroups> {
  if (!response.ok) {
    return emptyLocationUsageSuggestions()
  }

  try {
    return normalizeLocationUsageSuggestions(await response.json())
  } catch {
    return emptyLocationUsageSuggestions()
  }
}

export async function getLocationUsageSuggestions(
  options: LocationUsageClientOptions = {},
): Promise<LocationUsageSuggestionGroups> {
  try {
    const clientSessionId = options.clientSessionId === undefined
      ? getBrowserClientSessionId()
      : normalizeBrowserClientSessionId(options.clientSessionId)
    const url = clientSessionId
      ? `/api/location-usage-suggestions?clientSessionId=${encodeURIComponent(clientSessionId)}`
      : "/api/location-usage-suggestions"
    const response = await resolveFetch(options.fetchImpl)(url, {
      method: "GET",
      cache: "no-store",
      signal: options.signal,
    })
    return readUsageResponse(response)
  } catch {
    return emptyLocationUsageSuggestions()
  }
}

export function emptyLocationUsageSuggestions(): LocationUsageSuggestionGroups {
  return {
    frequent: emptySuggestions(),
    recent: emptySuggestions(),
  }
}
