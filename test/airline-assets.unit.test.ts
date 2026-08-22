import { test } from "bun:test"
import assert from "node:assert/strict"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { AIRLINE_LOGO_CODES, airlineLogoAssetPath, normalizeAirlineAssetCode } from "../src/core/airline-assets"
import { normalizeAirlineDisplayName } from "../src/core/airline-names"

const ICON_DIR = join("frontend", "public", "assets", "airline-icons")

test("every code the card promises a mark for has one on disk, and no file is orphaned", () => {
  /*
   * Aeroméxico and United were reported missing from the results, and the cause
   * was this pair drifting apart: the code list is what `airlineLogoAssetPath`
   * answers from, the directory is what the browser fetches, and nothing tied
   * the two together. A code with no file renders a broken image; a file with
   * no code is weight nobody serves.
   */
  const files = readdirSync(ICON_DIR).filter((name) => name.endsWith(".png")).sort()
  const codes = [...AIRLINE_LOGO_CODES].sort()

  assert.deepEqual(files, codes.map((code) => `${code}.png`))
})

test("the two carriers the desk was missing resolve to their own marks", () => {
  assert.equal(airlineLogoAssetPath("AM"), "/assets/airline-icons/AM.png")
  assert.equal(airlineLogoAssetPath("UA"), "/assets/airline-icons/UA.png")
  assert.equal(normalizeAirlineDisplayName("AM"), "Aeroméxico")
  assert.equal(normalizeAirlineDisplayName("UA"), "United")
})

test("a carrier with a name but no mark falls back to its code rather than to a broken image", () => {
  /*
   * The name catalogue is deliberately the longer of the two: a mark that is a
   * wordmark rather than a symbol is illegible in the card's 32px slot, where
   * the two letters are not. So this is a supported state, not a gap to close
   * by adding files.
   */
  const named = ["AD", "B6", "G3", "LH", "NK", "VB", "Y4"]
  for (const code of named) {
    assert.notEqual(normalizeAirlineDisplayName(code), code, `${code} should have a name`)
    assert.equal(airlineLogoAssetPath(code), "", `${code} should have no mark`)
  }
})

test("only a two-character alphanumeric code can name an asset", () => {
  assert.equal(normalizeAirlineAssetCode(" la "), "LA")
  assert.equal(normalizeAirlineAssetCode("LATAM"), "")
  assert.equal(airlineLogoAssetPath("../../etc/passwd"), "")
  assert.equal(airlineLogoAssetPath("ZZ"), "")
})
