import type { LocationSuggestionType } from "./types";

export function normalizeLocationSuggestionType(value: unknown): LocationSuggestionType | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  return normalized === "CITY" || normalized === "AIRPORT"
    ? normalized
    : undefined;
}
