import test from "node:test"
import assert from "node:assert/strict"
import { findLocationSuggestionMatch, normalizeLocationSuggestion } from "../frontend/src/lib/locations"

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
