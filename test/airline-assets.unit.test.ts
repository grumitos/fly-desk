import { test } from "bun:test"
import assert from "node:assert/strict"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import {
  AIRLINE_LOGO_CODES,
  airlineLogoAssetPath,
  isBundledAirlineLogoCode,
  normalizeAirlineAssetCode,
} from "../src/core/airline-assets"
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

test("the carriers the desk was missing resolve to their own marks", () => {
  assert.equal(airlineLogoAssetPath("AM"), "/assets/airline-icons/AM.png")
  assert.equal(airlineLogoAssetPath("UA"), "/assets/airline-icons/UA.png")
  assert.equal(airlineLogoAssetPath("LH"), "/assets/airline-icons/LH.png")
  assert.equal(normalizeAirlineDisplayName("AM"), "Aeroméxico")
  assert.equal(normalizeAirlineDisplayName("UA"), "United")
})

test("a carrier the release does not bundle is asked for anyway, not written off", () => {
  /*
   * The two lists used to have to agree, and neither could be finished by hand:
   * eight ordinary LIM routes return 38 carriers, and a search can always
   * return one more. So a code missing from the bundle is no longer a carrier
   * without a mark — it is one whose mark has not been fetched yet.
   */
  for (const code of ["QR", "SQ", "ET"]) {
    assert.equal(isBundledAirlineLogoCode(code), false, `${code} is not bundled`)
    assert.equal(
      airlineLogoAssetPath(code),
      `/assets/airline-icons/${code}.png`,
      `${code} should still be asked for`,
    )
  }
})

test("only a two-character alphanumeric code can name an asset", () => {
  assert.equal(normalizeAirlineAssetCode(" la "), "LA")
  assert.equal(normalizeAirlineAssetCode("LATAM"), "")
  assert.equal(airlineLogoAssetPath("../../etc/passwd"), "")
  assert.equal(airlineLogoAssetPath("LATAM"), "")
})

test("a carrier the release does not bundle still gets a path to ask for", () => {
  /*
   * The gate used to be this list, which is why British Airways and Turkish —
   * 290 and 91 segments across eight ordinary routes — were drawn as their two
   * letters. The card asks for every well-formed code now; the server answers
   * one it has no file for by fetching it once, and a code with no artwork
   * anywhere answers 404, which the card draws as the letters.
   */
  assert.equal(airlineLogoAssetPath("QR"), "/assets/airline-icons/QR.png")
  assert.equal(isBundledAirlineLogoCode("QR"), false)
  assert.equal(isBundledAirlineLogoCode("LA"), true)
  // And the carriers those routes did return are bundled, so no cold fetch.
  for (const code of ["BA", "TK", "VY", "AZ", "TP", "EK"]) {
    assert.equal(isBundledAirlineLogoCode(code), true, `${code} should ship with the release`)
  }
})
