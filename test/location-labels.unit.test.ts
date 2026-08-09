import { test } from "bun:test";
import assert from "node:assert/strict"
import {
  getCachedLocationSuggestions,
  resetLocationSuggestionCachesForTests,
  suggestLocations,
} from "../frontend/src/lib/api"
import { filterLocationSuggestions, findLocationSuggestionMatch, normalizeLocationSuggestion } from "../frontend/src/lib/locations"
import { rankLocationSuggestions as rankBackendLocationSuggestions } from "../src/location-suggestions"
import { normalizeLocationSuggestionType } from "../src/core/location-suggestion"

const LOCATION_SUGGESTION_DETAILS_STORAGE_KEY = "flydesk-location-suggestion-details-v1"

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

function installLocalStorage(storage: MemoryStorage): () => void {
  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  })

  return () => {
    if (previousDescriptor) {
      Object.defineProperty(globalThis, "localStorage", previousDescriptor)
      return
    }

    delete (globalThis as typeof globalThis & { localStorage?: MemoryStorage }).localStorage
  }
}

function apiLocationSuggestion(code: string, city: string, countryCode: string) {
  return {
    code,
    city,
    country: countryCode,
    countryCode,
    label: `All airports: ${city}, ${countryCode} (${code})`,
  }
}

test("location labels use IATA - city, country and remove all-airports noise", () => {
  const suggestion = normalizeLocationSuggestion({
    code: "BCN",
    city: "Barcelona (Todos Los Aeropuertos)",
    country: "España",
    countryCode: "ES",
    label: "BCN - Barcelona (Todos Los Aeropuertos), España",
  })

  assert.equal(suggestion.label, "BCN - Barcelona, España")
  assert.equal(suggestion.code, "BCN")
})

test("location labels preserve provider city and country when the raw label is noisy", () => {
  const suggestion = normalizeLocationSuggestion({
    code: "LIM",
    city: "Lima",
    country: "PE",
    countryCode: "PE",
    label: "All airports: Lima, PE (LIM)",
  })

  assert.equal(suggestion.label, "LIM - Lima, Perú")
  assert.equal(suggestion.country, "Perú")
})

test("location suggestion type keeps only explicit city and airport values", () => {
  assert.equal(normalizeLocationSuggestionType("CITY"), "CITY")
  assert.equal(normalizeLocationSuggestionType(" airport "), "AIRPORT")
  assert.equal(normalizeLocationSuggestionType("ALL_AIRPORTS"), undefined)
  assert.equal(normalizeLocationSuggestionType(undefined), undefined)

  const city = normalizeLocationSuggestion({
    code: "RIO",
    city: "Río de Janeiro",
    country: "Brasil",
    type: "CITY",
    label: "RIO - Río de Janeiro, Brasil",
  })
  const unknown = normalizeLocationSuggestion({
    code: "LIM",
    city: "Lima",
    country: "Perú",
    type: "ALL_AIRPORTS" as never,
    label: "LIM - Lima, Perú",
  })

  assert.equal(city.type, "CITY")
  assert.equal(unknown.type, undefined)
})

test("location match accepts code, city, country, and accent-insensitive label variants", () => {
  const suggestions = [
    normalizeLocationSuggestion({
      code: "LIM",
      city: "Lima",
      country: "PE",
      countryCode: "PE",
      label: "All airports: Lima, PE (LIM)",
    }),
  ]

  assert.equal(findLocationSuggestionMatch("lim", suggestions)?.label, "LIM - Lima, Perú")
  assert.equal(findLocationSuggestionMatch("lima", suggestions)?.label, "LIM - Lima, Perú")
  assert.equal(findLocationSuggestionMatch("peru", suggestions)?.label, "LIM - Lima, Perú")
  assert.equal(findLocationSuggestionMatch("LIM - Lima, Peru", suggestions)?.label, "LIM - Lima, Perú")
})

test("location match avoids ambiguous country matches", () => {
  const suggestions = [
    normalizeLocationSuggestion({ code: "LIM", city: "Lima", country: "Perú", countryCode: "PE", label: "Lima, Perú (LIM)" }),
    normalizeLocationSuggestion({ code: "CUZ", city: "Cusco", country: "Perú", countryCode: "PE", label: "Cusco, Perú (CUZ)" }),
  ]

  assert.equal(findLocationSuggestionMatch("peru", suggestions), undefined)
})

test("location suggestions prefer IATA prefix, then city prefix, then country prefix", () => {
  const suggestions = [
    normalizeLocationSuggestion({ code: "AGU", city: "Aguascalientes", country: "México", countryCode: "MX", label: "AGU - Aguascalientes, México" }),
    normalizeLocationSuggestion({ code: "ALC", city: "Alicante", country: "España", countryCode: "ES", label: "ALC - Alicante, España" }),
    normalizeLocationSuggestion({ code: "ALI", city: "Alice", country: "Estados Unidos", countryCode: "US", label: "ALI - Alice, Estados Unidos" }),
    normalizeLocationSuggestion({ code: "LIM", city: "Lima", country: "Perú", countryCode: "PE", label: "LIM - Lima, Perú" }),
    normalizeLocationSuggestion({ code: "LIS", city: "Lisboa", country: "Portugal", countryCode: "PT", label: "LIS - Lisboa, Portugal" }),
    normalizeLocationSuggestion({ code: "MEX", city: "Ciudad de México", country: "Liechtenstein", countryCode: "LI", label: "MEX - Ciudad de México, Liechtenstein" }),
  ]

  assert.deepEqual(
    filterLocationSuggestions("li", suggestions, 8).map((suggestion) => suggestion.code),
    ["LIM", "LIS", "MEX"],
  )
  assert.deepEqual(
    rankBackendLocationSuggestions("li", suggestions, 8).map((suggestion) => suggestion.code),
    ["LIM", "LIS", "MEX"],
  )
})

test("country prefixes with enough signal surface country airports without IATA noise", () => {
  const suggestions = [
    normalizeLocationSuggestion({ code: "ESP", city: "Stroudsburg-Pocono", country: "Estados Unidos", countryCode: "US", label: "ESP - Stroudsburg-Pocono, Estados Unidos" }),
    normalizeLocationSuggestion({ code: "ACE", city: "Arrecife", country: "España", countryCode: "ES", label: "ACE - Arrecife, España" }),
    normalizeLocationSuggestion({ code: "BCN", city: "Barcelona", country: "España", countryCode: "ES", label: "BCN - Barcelona, España" }),
  ]

  assert.deepEqual(
    filterLocationSuggestions("espa", suggestions, 8).map((suggestion) => suggestion.code),
    ["ACE", "BCN"],
  )
})

test("backend location ranking expands country codes into country-name matches", () => {
  const suggestions = [
    { code: "MAD", city: "Madrid", country: "ES", countryCode: "ES", label: "Todos los aeropuertos, Madrid, España (MAD)" },
    { code: "ESB", city: "Ankara", country: "TR", countryCode: "TR", label: "Aeropuerto Internacional Esenboga, Ankara, Turquía (ESB)" },
    { code: "BCN", city: "Barcelona", country: "ES", countryCode: "ES", label: "Todos los aeropuertos, Barcelona, España (BCN)" },
  ]

  assert.deepEqual(
    rankBackendLocationSuggestions("espa", suggestions, 8).map((suggestion) => suggestion.code),
    ["MAD", "BCN"],
  )
})

test("suggestLocations uses the combined provider autocomplete endpoint", async () => {
  const previousFetch = globalThis.fetch
  let requestedUrl = ""

  globalThis.fetch = (async (input) => {
    requestedUrl = typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url

    return new Response(JSON.stringify({
      suggestions: [
        { code: "BUE", city: "Buenos Aires", country: "Argentina", countryCode: "AR", label: "BUE - Buenos Aires, Argentina" },
      ],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch

  try {
    const suggestions = await suggestLocations("argen")
    const url = new URL(requestedUrl, "http://localhost")

    assert.equal(url.pathname, "/api/locations")
    assert.equal(url.searchParams.get("providerId"), null)
    assert.deepEqual(suggestions.map((suggestion) => suggestion.code), ["BUE"])
  } finally {
    globalThis.fetch = previousFetch
    resetLocationSuggestionCachesForTests()
  }
})

test("location suggestion details stay memory-only and never persist in browser storage", async () => {
  const previousFetch = globalThis.fetch
  const storage = new MemoryStorage()
  const restoreLocalStorage = installLocalStorage(storage)

  resetLocationSuggestionCachesForTests()
  globalThis.fetch = (async () => new Response(JSON.stringify({
    suggestions: [
      apiLocationSuggestion("LIM", "Lima", "PE"),
    ],
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })) as typeof fetch

  try {
    await suggestLocations("lim")
    assert.equal(storage.getItem(LOCATION_SUGGESTION_DETAILS_STORAGE_KEY), null)
    assert.equal(
      findLocationSuggestionMatch("LIM", getCachedLocationSuggestions("LIM"))?.label,
      "LIM - Lima, Perú",
    )

    resetLocationSuggestionCachesForTests()
    assert.equal(findLocationSuggestionMatch("LIM", getCachedLocationSuggestions("LIM")), undefined)
  } finally {
    globalThis.fetch = previousFetch
    resetLocationSuggestionCachesForTests()
    restoreLocalStorage()
  }
})
