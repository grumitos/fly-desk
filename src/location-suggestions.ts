import { LocationSuggestion } from "./core/types";

function normalizeLocationSearchText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

let regionDisplayNames: Intl.DisplayNames | null | undefined;

function countryNameFromCode(code: unknown): string {
  const normalizedCode = String(code ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalizedCode)) {
    return "";
  }

  if (regionDisplayNames === undefined) {
    try {
      regionDisplayNames = new Intl.DisplayNames(["es"], { type: "region" });
    } catch {
      regionDisplayNames = null;
    }
  }

  return String(regionDisplayNames?.of(normalizedCode) ?? "").trim();
}

function compactLength(value: string): number {
  return value.replace(/\s+/g, "").length;
}

function countrySearchTexts(suggestion: LocationSuggestion): string[] {
  return Array.from(new Set([
    normalizeLocationSearchText(suggestion.country),
    normalizeLocationSearchText(suggestion.countryCode),
    normalizeLocationSearchText(countryNameFromCode(suggestion.countryCode)),
  ].filter(Boolean)));
}

function bestPrefixCoverage(query: string, candidates: string[]): number | undefined {
  const queryLength = compactLength(query);
  if (queryLength === 0) {
    return undefined;
  }

  let best: number | undefined;
  for (const candidate of candidates) {
    if (!candidate.startsWith(query)) {
      continue;
    }

    const candidateLength = compactLength(candidate);
    if (candidateLength === 0) {
      continue;
    }

    const coverage = queryLength / candidateLength;
    best = best === undefined ? coverage : Math.max(best, coverage);
  }

  return best;
}

function rankLocationSuggestion(input: string, suggestion: LocationSuggestion, index: number): number | undefined {
  const query = normalizeLocationSearchText(input);
  if (!query) {
    return undefined;
  }

  const queryLength = compactLength(query);
  const code = normalizeLocationSearchText(suggestion.code);
  const city = normalizeLocationSearchText(suggestion.city);
  const cityCountry = normalizeLocationSearchText([suggestion.city, suggestion.country].filter(Boolean).join(" "));
  const countryCoverage = bestPrefixCoverage(query, countrySearchTexts(suggestion));
  const countryIsExact = countryCoverage === 1;
  const countryHasEnoughSignal = queryLength >= 4 && (countryCoverage ?? 0) >= 0.5;

  if (queryLength <= 3 && code.startsWith(query)) {
    return (code === query ? -10 : 0) + index / 1000;
  }
  if (city === query || cityCountry === query) {
    return 20 + index / 1000;
  }
  if (countryIsExact) {
    return 40 + index / 1000;
  }
  if (countryHasEnoughSignal) {
    return 60 + index / 1000;
  }
  if (city.startsWith(query) || cityCountry.startsWith(query)) {
    return 100 + index / 1000;
  }
  if (countryCoverage !== undefined) {
    return 200 + index / 1000;
  }

  return undefined;
}

export function rankLocationSuggestions(
  query: string,
  suggestions: LocationSuggestion[],
  limit: number,
): LocationSuggestion[] {
  return suggestions
    .map((suggestion, index) => ({
      suggestion,
      rank: rankLocationSuggestion(query, suggestion, index),
    }))
    .filter((entry): entry is { suggestion: LocationSuggestion; rank: number } => entry.rank !== undefined)
    .sort((left, right) => left.rank - right.rank)
    .map((entry) => entry.suggestion)
    .slice(0, Math.max(1, limit));
}
