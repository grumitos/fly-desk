import { test } from "bun:test"
import assert from "node:assert/strict"
import { stationDisplayName } from "../frontend/src/lib/offer-display"

test("a shouted provider airport name is written the way plate 1b writes it", () => {
  assert.equal(stationDisplayName("SAO PAULO GUARULHOS"), "Sao Paulo Guarulhos")
  assert.equal(stationDisplayName("JORGE CHAVEZ"), "Jorge Chavez")
  assert.equal(stationDisplayName("  MADRID BARAJAS  "), "Madrid Barajas")
})

test("Spanish connectors stay lowercase inside the name, never at its head", () => {
  assert.equal(stationDisplayName("AEROPUERTO DE LA CIUDAD"), "Aeropuerto de la Ciudad")
  assert.equal(stationDisplayName("DEL VALLE"), "Del Valle")
})

test("a name the provider already cased is left exactly as it came", () => {
  assert.equal(stationDisplayName("Jorge Chávez"), "Jorge Chávez")
  assert.equal(stationDisplayName("Charles de Gaulle"), "Charles de Gaulle")
  // One lowercase letter is enough evidence that the provider meant this casing.
  assert.equal(stationDisplayName("JFK New York"), "JFK New York")
})

test("an absent name stays absent rather than becoming an empty label", () => {
  assert.equal(stationDisplayName(undefined), "")
  assert.equal(stationDisplayName("   "), "")
})

test("a search concept never survives into an itinerary line", () => {
  // «todos los aeropuertos» means the query covered a city; a leg departs from
  // one runway, so it has no business on the station line.
  assert.equal(stationDisplayName("Lima (Todos los aeropuertos)"), "Lima")
  assert.equal(stationDisplayName("BUENOS AIRES (TODOS LOS AEROPUERTOS)"), "Buenos Aires")
  assert.equal(stationDisplayName("Buenos Aires (all airports)"), "Buenos Aires")
})

test("the code is not printed twice on the line that already carries it", () => {
  assert.equal(stationDisplayName("LIM · Jorge Chávez"), "Jorge Chávez")
  assert.equal(stationDisplayName("Jorge Chávez (LIM)"), "Jorge Chávez")
  assert.equal(stationDisplayName("GRU - Guarulhos"), "Guarulhos")
})
