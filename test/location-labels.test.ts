import test from "node:test"
import assert from "node:assert/strict"
import { filterLocationSuggestions, findLocationSuggestionMatch, normalizeLocationSuggestion } from "../frontend/src/lib/locations"
import { rankLocationSuggestions as rankBackendLocationSuggestions } from "../src/location-suggestions"

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
