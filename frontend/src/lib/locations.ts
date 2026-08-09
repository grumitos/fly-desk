import type { LocationSuggestion } from "@/types"
import { normalizeLocationSuggestionType } from "../../../src/core/location-suggestion"

function sanitizeLocationToken(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/^[,;:\-\s]+|[,;:\-\s]+$/g, "")
    .trim()
}

export function normalizeLocationSearchText(value: unknown): string {
  return sanitizeLocationToken(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function normalizeLocationCode(value: unknown): string {
  const normalized = sanitizeLocationToken(value).toUpperCase()
  if (!normalized) return ""
  const match = normalized.match(/[A-Z]{3}/)
  return match ? match[0] : ""
}

function stripLocationPrefix(value: unknown): string {
  const source = sanitizeLocationToken(value)
  if (!source) return ""

  const withoutPrefix = source
    .replace(
      /^(?:todos?\s+los?\s+aeropuertos?(?:\s+de)?|all\s+airports?(?:\s+of)?|aeropuerto(?:s)?(?:\s+internacional(?:es)?)?(?:\s+de)?|airport(?:s)?(?:\s+international)?(?:\s+of)?)\s*(?:[:,-]\s*|\s+)/i,
      ""
    )
    .trim()

  return withoutPrefix
    .replace(/^[A-Z]{3}\s*[·-]\s*/u, "")
    .replace(/\((?:todos?\s+los?\s+aeropuertos?|all\s+airports?)\)/gi, "")
    .trim()
}

let regionDisplayNames: Intl.DisplayNames | null | undefined

function countryNameFromCode(code: unknown): string | undefined {
  const normalizedCode = sanitizeLocationToken(code).toUpperCase()
  if (!/^[A-Z]{2}$/.test(normalizedCode)) return undefined

  if (regionDisplayNames === undefined) {
    try {
      regionDisplayNames = new Intl.DisplayNames(["es"], { type: "region" })
    } catch {
      regionDisplayNames = null
    }
  }

  return sanitizeLocationToken(regionDisplayNames?.of(normalizedCode)) || undefined
}

function normalizeCountryName(country: unknown, countryCode?: unknown): string {
  const fromCountryCode = countryNameFromCode(countryCode)
  if (fromCountryCode) return fromCountryCode

  const direct = sanitizeLocationToken(country)
  const fromDirectCode = countryNameFromCode(direct)
  if (fromDirectCode) return fromDirectCode
  if (direct) return direct

  return sanitizeLocationToken(countryCode)
}

function extractLabelParts(label: unknown): { text: string; code: string } {
  const source = sanitizeLocationToken(label)
  if (!source) return { text: "", code: "" }

  const codeMatch = source.match(/\(([A-Za-z]{3})\)\s*$/)
  const code = codeMatch ? normalizeLocationCode(codeMatch[1]) : ""
  const text = sanitizeLocationToken(codeMatch ? source.slice(0, codeMatch.index) : source)
  return { text, code }
}

function buildLocationLabel(city: string, country: string, code: string, fallbackLabel = ""): string {
  const safeCity = sanitizeLocationToken(city)
  const safeCountry = sanitizeLocationToken(country)
  const safeCode = normalizeLocationCode(code)
  const place = [safeCity, safeCountry].filter(Boolean).join(", ")

  if (safeCode && place) return `${safeCode} - ${place}`
  if (safeCode) return safeCode
  return place || sanitizeLocationToken(fallbackLabel)
}

export function normalizeLocationSuggestion(suggestion: LocationSuggestion): LocationSuggestion {
  const fallbackCity = stripLocationPrefix(suggestion.city)
  const fallbackCountry = normalizeCountryName(suggestion.country, suggestion.countryCode)
  const rawLabel = sanitizeLocationToken(suggestion.label)
  const labelParts = extractLabelParts(rawLabel)
  const splitParts = labelParts.text
    .split(",")
    .map((part) => stripLocationPrefix(part))
    .filter(Boolean)
  const parsedCity = splitParts.length >= 2 ? splitParts[splitParts.length - 2] : splitParts[0] || ""
  const parsedCountry = splitParts.length >= 1 ? splitParts[splitParts.length - 1] : ""
  const city = sanitizeLocationToken(parsedCity || fallbackCity)
  const country = normalizeCountryName(parsedCountry, suggestion.countryCode) || fallbackCountry
  const code = normalizeLocationCode(suggestion.code || labelParts.code)
  const label = buildLocationLabel(city, country, code, rawLabel)

  return {
    ...suggestion,
    code,
    city: city || fallbackCity || code,
    country: country || fallbackCountry,
    countryCode: sanitizeLocationToken(suggestion.countryCode).toUpperCase() || undefined,
    type: normalizeLocationSuggestionType(suggestion.type),
    label,
  }
}

export function normalizeLocationSuggestions(suggestions: LocationSuggestion[]): LocationSuggestion[] {
  const deduped = new Map<string, LocationSuggestion>()

  for (const suggestion of suggestions) {
    const normalized = normalizeLocationSuggestion(suggestion)
    const key = [
      normalized.code,
      sanitizeLocationToken(normalized.city).toLowerCase(),
      sanitizeLocationToken(normalized.country).toLowerCase(),
    ]
      .filter(Boolean)
      .join("|")

    if (!key || deduped.has(key)) continue
    deduped.set(key, normalized)
  }

  return [...deduped.values()]
}

function locationMatchKeys(suggestion: LocationSuggestion): string[] {
  const code = normalizeLocationSearchText(suggestion.code)
  const city = normalizeLocationSearchText(suggestion.city)
  const country = normalizeLocationSearchText(suggestion.country)
  const countryFromCode = normalizeLocationSearchText(countryNameFromCode(suggestion.countryCode))
  const label = normalizeLocationSearchText(suggestion.label)
  const compactLabel = normalizeLocationSearchText([suggestion.code, suggestion.city, suggestion.country].filter(Boolean).join(" "))

  return Array.from(new Set([code, city, country, countryFromCode, label, compactLabel].filter(Boolean)))
}

function compactLength(value: string): number {
  return value.replace(/\s+/g, "").length
}

function countrySearchTexts(suggestion: LocationSuggestion): string[] {
  return Array.from(new Set([
    normalizeLocationSearchText(suggestion.country),
    normalizeLocationSearchText(suggestion.countryCode),
    normalizeLocationSearchText(countryNameFromCode(suggestion.countryCode)),
  ].filter(Boolean)))
}

function bestPrefixCoverage(query: string, candidates: string[]): number | undefined {
  const queryLength = compactLength(query)
  if (queryLength === 0) return undefined

  let best: number | undefined
  for (const candidate of candidates) {
    if (!candidate.startsWith(query)) continue

    const candidateLength = compactLength(candidate)
    if (candidateLength === 0) continue

    const coverage = queryLength / candidateLength
    best = best === undefined ? coverage : Math.max(best, coverage)
  }

  return best
}

function rankLocationSuggestion(input: string, suggestion: LocationSuggestion, index: number): number | undefined {
  const query = normalizeLocationSearchText(input)
  if (!query) return undefined

  const queryLength = compactLength(query)
  const code = normalizeLocationSearchText(suggestion.code)
  const city = normalizeLocationSearchText(suggestion.city)
  const cityCountry = normalizeLocationSearchText([suggestion.city, suggestion.country].filter(Boolean).join(" "))
  const countryCoverage = bestPrefixCoverage(query, countrySearchTexts(suggestion))
  const countryIsExact = countryCoverage === 1
  const countryHasEnoughSignal = queryLength >= 4 && (countryCoverage ?? 0) >= 0.5

  if (queryLength <= 3 && code.startsWith(query)) return (code === query ? -10 : 0) + index / 1000
  if (city === query || cityCountry === query) return 20 + index / 1000
  if (countryIsExact) return 40 + index / 1000
  if (countryHasEnoughSignal) return 60 + index / 1000
  if (city.startsWith(query) || cityCountry.startsWith(query)) return 100 + index / 1000
  if (countryCoverage !== undefined) return 200 + index / 1000

  return undefined
}

export function findLocationSuggestionMatch(
  input: string,
  suggestions: LocationSuggestion[]
): LocationSuggestion | undefined {
  const query = normalizeLocationSearchText(input)
  if (!query) return undefined

  const matches = suggestions.filter((suggestion) => locationMatchKeys(suggestion).includes(query))
  if (matches.length !== 1) return undefined

  return matches[0]
}

export function filterLocationSuggestions(
  input: string,
  suggestions: LocationSuggestion[],
  limit = 8
): LocationSuggestion[] {
  const query = normalizeLocationSearchText(input)
  if (!query) return []

  return suggestions
    .map((suggestion, index) => ({
      suggestion,
      rank: rankLocationSuggestion(query, suggestion, index),
    }))
    .filter((entry): entry is { suggestion: LocationSuggestion; rank: number } => entry.rank !== undefined)
    .sort((left, right) => left.rank - right.rank)
    .map((entry) => entry.suggestion)
    .slice(0, limit)
}
