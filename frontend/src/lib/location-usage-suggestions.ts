import type { SearchRequest } from "@/types"

export const LOCATION_USAGE_RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

type LocationUsageRole = "origin" | "destination"

export type LocationUsageSuggestions = Record<LocationUsageRole, string[]>

type LocationUsageApiResponse = {
  suggestions?: Partial<Record<LocationUsageRole, unknown>>
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

type LocationUsageClientOptions = {
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

function normalizeLocationUsageSuggestions(input: unknown): LocationUsageSuggestions {
  const payload = input && typeof input === "object" ? input as LocationUsageApiResponse : {}
  return {
    origin: normalizeCodes(payload.suggestions?.origin),
    destination: normalizeCodes(payload.suggestions?.destination),
  }
}

function resolveFetch(fetchImpl: FetchLike | undefined): FetchLike {
  return fetchImpl ?? fetch
}

async function readUsageResponse(response: Response): Promise<LocationUsageSuggestions> {
  if (!response.ok) {
    return emptySuggestions()
  }

  try {
    return normalizeLocationUsageSuggestions(await response.json())
  } catch {
    return emptySuggestions()
  }
}

export async function recordLocationUsageFromSearch(
  request: Pick<SearchRequest, "origin" | "destination">,
  options: LocationUsageClientOptions = {},
): Promise<LocationUsageSuggestions> {
  try {
    const response = await resolveFetch(options.fetchImpl)("/api/location-usage-suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        origin: request.origin,
        destination: request.destination,
      }),
      signal: options.signal,
    })
    return readUsageResponse(response)
  } catch {
    return emptySuggestions()
  }
}

export async function getLocationUsageSuggestions(
  options: LocationUsageClientOptions = {},
): Promise<LocationUsageSuggestions> {
  try {
    const response = await resolveFetch(options.fetchImpl)("/api/location-usage-suggestions", {
      method: "GET",
      signal: options.signal,
    })
    return readUsageResponse(response)
  } catch {
    return emptySuggestions()
  }
}

export function emptyLocationUsageSuggestions(): LocationUsageSuggestions {
  return emptySuggestions()
}
