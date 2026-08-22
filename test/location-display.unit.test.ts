import { test } from "bun:test"
import assert from "node:assert/strict"
import {
  IATA_LOCATION_CODES,
  cityNameForIataCode,
  countryCodeForIataCode,
  isAirportFacilityLabel,
  normalizeIataCode,
  stripAirportFacilityWords,
  stripAllAirportsLabel,
} from "../src/core/location-display"

test("every entry is a real IATA code paired with a city and an ISO country", () => {
  /*
   * The shape is the part a reviewer cannot check by reading: a four-letter
   * key, an empty city or a three-letter country would each reach a customer
   * quotation as a broken line rather than as a missing one.
   */
  assert.ok(IATA_LOCATION_CODES.length >= 80, `${IATA_LOCATION_CODES.length} entries`)

  for (const code of IATA_LOCATION_CODES) {
    assert.match(code, /^[A-Z]{3}$/, `${code} is not an IATA code`)

    const city = cityNameForIataCode(code)
    assert.ok(city && city.trim() === city && city.length > 1, `${code} has no usable city`)
    assert.doesNotMatch(city, /\b(?:airport|aeropuerto|international|internacional)\b/i, `${code} names a facility`)

    const countryCode = countryCodeForIataCode(code)
    assert.match(countryCode ?? "", /^[A-Z]{2}$/, `${code} has no ISO country`)
  }
})

test("a city with more than one airport answers the same for each of them", () => {
  // The code is printed beside the name, so it is what tells them apart.
  assert.equal(cityNameForIataCode("EZE"), cityNameForIataCode("AEP"))
  assert.equal(cityNameForIataCode("EZE"), cityNameForIataCode("BUE"))
  assert.equal(cityNameForIataCode("GRU"), cityNameForIataCode("CGH"))
  assert.equal(cityNameForIataCode("LHR"), cityNameForIataCode("LGW"))
  assert.equal(cityNameForIataCode("CDG"), cityNameForIataCode("ORY"))
  assert.equal(cityNameForIataCode("JFK"), cityNameForIataCode("EWR"))
  assert.equal(cityNameForIataCode("JFK"), cityNameForIataCode("LGA"))
  // And two cities that share an airport region still answer separately.
  assert.notEqual(cityNameForIataCode("MIA"), cityNameForIataCode("FLL"))
})

test("the home network is named, because it is what this desk sells most", () => {
  assert.equal(cityNameForIataCode("LIM"), "Lima")
  assert.equal(cityNameForIataCode("CUZ"), "Cusco")
  assert.equal(cityNameForIataCode("AQP"), "Arequipa")
  assert.equal(cityNameForIataCode("IQT"), "Iquitos")
  assert.equal(countryCodeForIataCode("JUL"), "PE")
})

test("a code outside the catalogue says nothing rather than something false", () => {
  assert.equal(cityNameForIataCode("ZZZ"), undefined)
  assert.equal(countryCodeForIataCode("ZZZ"), undefined)
  assert.equal(cityNameForIataCode(""), undefined)
  assert.equal(cityNameForIataCode(undefined), undefined)
})

test("a code is read however the provider cased or padded it", () => {
  assert.equal(cityNameForIataCode(" lim "), "Lima")
  assert.equal(normalizeIataCode(" gru "), "GRU")
})

test("the facility words are recognised and removed, in both languages", () => {
  assert.equal(isAirportFacilityLabel("Aeropuerto Internacional Jorge Chávez"), true)
  assert.equal(isAirportFacilityLabel("Charles de Gaulle"), false)
  assert.equal(stripAirportFacilityWords("Aeropuerto Internacional Jorge Chávez"), "Jorge Chávez")
  assert.equal(stripAirportFacilityWords("Aeroporto Internacional de Guarulhos"), "Guarulhos")
  assert.equal(stripAirportFacilityWords("Dallas Fort Worth International Airport"), "Dallas Fort Worth")
  assert.equal(stripAirportFacilityWords("Aeropuerto Internacional"), "")
})

test("«todos los aeropuertos» is a search concept and never a station", () => {
  assert.equal(stripAllAirportsLabel("Lima (Todos los aeropuertos)"), "Lima")
  assert.equal(stripAllAirportsLabel("Buenos Aires (all airports)"), "Buenos Aires")
})
