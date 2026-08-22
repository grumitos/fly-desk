import { test } from "bun:test"
import assert from "node:assert/strict"
import { stationDisplayName, stationPlaceName } from "../frontend/src/lib/offer-display"

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

test("the itinerary names a station by its code, not by the provider that sent it", () => {
  /*
   * The reported difference: the same LIM read «LIM · Lima» on an Agil result
   * and «LIM · Aeropuerto Internacional Jorge Chávez» on a Click and Book Plus
   * one, because each provider sends its own name for the same runway. The
   * code is the fact both agree on, so the catalogue behind it decides.
   */
  assert.equal(stationPlaceName("LIM", "Lima"), "Lima")
  assert.equal(stationPlaceName("LIM", "Aeropuerto Internacional Jorge Chávez"), "Lima")
  assert.equal(stationPlaceName("lim", undefined), "Lima")
  assert.equal(stationPlaceName("MAD", "ADOLFO SUAREZ MADRID BARAJAS"), "Madrid")
})

test("a code the catalogue does not know keeps the provider's own name, cleaned", () => {
  assert.equal(stationPlaceName("GRU", "SAO PAULO GUARULHOS"), "Sao Paulo Guarulhos")
  assert.equal(stationPlaceName("GRU", "GRU - Guarulhos"), "Guarulhos")
  assert.equal(stationPlaceName("GRU", undefined), "")
  assert.equal(stationPlaceName(undefined, "Lima (Todos los aeropuertos)"), "Lima")
})

test("the facility is not the place, so its words come off an unknown code", () => {
  /* Plate 1b's «LIM · Jorge Chávez»: two providers writing the same runway at
     two lengths converge once the designation goes. */
  assert.equal(stationPlaceName("GRU", "Aeroporto Internacional de Guarulhos"), "Guarulhos")
  assert.equal(stationPlaceName("DFW", "Dallas Fort Worth International Airport"), "Dallas Fort Worth")
  assert.equal(stationPlaceName("FCO", "AEROPUERTO INTERNACIONAL LEONARDO DA VINCI"), "Leonardo da Vinci")
  // A label that is nothing but the facility names no place; the code says which.
  assert.equal(stationPlaceName("XXX", "Aeropuerto Internacional"), "")
  // And a real name is never trimmed for being long.
  assert.equal(stationPlaceName("CDG", "Charles de Gaulle"), "Charles de Gaulle")
})
