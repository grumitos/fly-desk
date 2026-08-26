import { test } from "bun:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureAirlineMark, readSquarePngSize, resetAirlineMarkStoreForTests } from "../src/airline-mark-store"
import { headerOnlyPng, realPng } from "./helpers/png"

/** What the directory holds, counting "not created at all" as empty. */
function filesIn(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory) : []
}

const squarePng70 = await realPng(70)

function pngResponse(bytes: Uint8Array): Response {
  return new Response(bytes, { status: 200, headers: { "content-type": "image/png" } })
}

/*
 * `await run(...)`, and the await is the point: without it the `finally` fired
 * the moment the callback returned its promise, so the directory was deleted
 * before the test had used it. `ensureAirlineMark` then made it again with
 * `mkdir(recursive)`, which is why nothing ever failed — and why every
 * `filesIn(directory)` assertion was reading a directory that did not exist and
 * passing for the wrong reason. It also left one `flydesk-marks-` directory
 * behind per case, under a prefix the temp sweep does not know.
 */
async function withDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "flydesk-marks-"))
  resetAirlineMarkStoreForTests()
  try {
    return await run(directory)
  } finally {
    resetAirlineMarkStoreForTests()
    rmSync(directory, { recursive: true, force: true })
  }
}

test("a carrier the release does not carry is fetched once and reused from disk", async () => {
  await withDirectory(async (directory) => {
    let fetches = 0
    const fetchImpl = (async (input: string | URL | Request) => {
      fetches += 1
      assert.equal(String(input), "https://marks.test/BA_sq.png")
      return pngResponse(squarePng70)
    }) as typeof fetch

    const first = await ensureAirlineMark("ba", { directory, fetchImpl, sourceBaseUrl: "https://marks.test" })
    assert.equal(first, join(directory, "BA.png"))
    assert.equal(fetches, 1)
    assert.equal(await readSquarePngSize(new Uint8Array(readFileSync(first!))), 70)

    // Second ask is the file, not the network — that is the whole point.
    const second = await ensureAirlineMark("BA", { directory, fetchImpl, sourceBaseUrl: "https://marks.test" })
    assert.equal(second, first)
    assert.equal(fetches, 1)
  })
})

test("a list of cards asking at once still costs one fetch", async () => {
  await withDirectory(async (directory) => {
    let fetches = 0
    const fetchImpl = (async () => {
      fetches += 1
      await Bun.sleep(20)
      return pngResponse(squarePng70)
    }) as typeof fetch

    const asked = await Promise.all(Array.from({ length: 8 }, () =>
      ensureAirlineMark("TK", { directory, fetchImpl, sourceBaseUrl: "https://marks.test" })))

    assert.equal(fetches, 1)
    assert.deepEqual(new Set(asked), new Set([join(directory, "TK.png")]))
  })
})

test("a source with nothing to give is not asked again inside the window", async () => {
  await withDirectory(async (directory) => {
    let fetches = 0
    const fetchImpl = (async () => {
      fetches += 1
      return new Response("", { status: 403 })
    }) as typeof fetch

    let clock = 1_000
    const options = { directory, fetchImpl, sourceBaseUrl: "https://marks.test", now: () => clock }

    assert.equal(await ensureAirlineMark("EB", options), undefined)
    assert.equal(await ensureAirlineMark("EB", options), undefined)
    assert.equal(fetches, 1, "a 403 answered again tomorrow is not worth asking today")

    // A day later it is worth one more try.
    clock += 25 * 60 * 60 * 1000
    assert.equal(await ensureAirlineMark("EB", options), undefined)
    assert.equal(fetches, 2)
  })
})

test("bytes that are not a square PNG never reach the directory this origin serves", async () => {
  const cases: Array<[string, Response]> = [
    ["html dressed as a mark", new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })],
    ["a png content type over bytes that are not one", new Response("nope", { status: 200, headers: { "content-type": "image/png" } })],
    ["a rectangle", pngResponse(await realPng(64, 32))],
    /* The three below all announce a square PNG in their first 24 bytes, which
       is as far as the check used to read. Each of them was written to the
       directory this origin serves, and drawn by the card as a broken image. */
    ["a header promising a square with no body behind it", pngResponse(headerOnlyPng(70))],
    ["a real mark cut short on the way", pngResponse(squarePng70.slice(0, 40))],
    ["a square that decodes, but as a JPEG", pngResponse(await new Bun.Image(squarePng70).jpeg().bytes())],
    ["something far too large", pngResponse(new Uint8Array(300 * 1024))],
    ["an empty body", pngResponse(new Uint8Array(0))],
  ]

  for (const [label, response] of cases) {
    await withDirectory(async (directory) => {
      const fetchImpl = (async () => response) as typeof fetch
      assert.equal(
        await ensureAirlineMark("ZZ", { directory, fetchImpl, sourceBaseUrl: "https://marks.test" }),
        undefined,
        label,
      )
      assert.deepEqual(filesIn(directory), [], `${label} left something behind`)
    })
  }
})

test("a source that never answers leaves the card to its two letters", async () => {
  await withDirectory(async (directory) => {
    const fetchImpl = (async () => { throw new Error("network down") }) as typeof fetch
    assert.equal(
      await ensureAirlineMark("VY", { directory, fetchImpl, sourceBaseUrl: "https://marks.test" }),
      undefined,
    )
    assert.deepEqual(filesIn(directory), [])
  })
})

test("only a well-formed carrier code can name a file in that directory", async () => {
  await withDirectory(async (directory) => {
    let fetches = 0
    const fetchImpl = (async () => { fetches += 1; return pngResponse(squarePng70) }) as typeof fetch
    const options = { directory, fetchImpl, sourceBaseUrl: "https://marks.test" }

    for (const value of ["../../etc/passwd", "LATAM", "", "A", "A/B", undefined]) {
      assert.equal(await ensureAirlineMark(value, options), undefined, String(value))
    }
    assert.equal(fetches, 0)
    assert.deepEqual(filesIn(directory), [])
  })
})
