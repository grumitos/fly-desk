import { LocationSuggestion } from "./core/types";

function normalizeLocationSearchText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function rankLocationSuggestion(input: string, suggestion: LocationSuggestion, index: number): number | undefined {
  const query = normalizeLocationSearchText(input);
  if (!query) {
    return undefined;
  }

  const code = normalizeLocationSearchText(suggestion.code);
  const city = normalizeLocationSearchText(suggestion.city);
  const country = normalizeLocationSearchText(suggestion.country);
  const cityCountry = normalizeLocationSearchText([suggestion.city, suggestion.country].filter(Boolean).join(" "));

  if (code.startsWith(query)) {
    return (code === query ? -10 : 0) + index / 1000;
  }
  if (city.startsWith(query) || cityCountry.startsWith(query)) {
    return 100 + index / 1000;
  }
  if (country.startsWith(query)) {
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
