import { test } from "bun:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureAirlineMark, resetAirlineMarkStoreForTests } from "../src/airline-mark-store"
import { readSquarePngSize } from "../src/core/airline-assets"

/** What the directory holds, counting "not created at all" as empty. */
function filesIn(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory) : []
}

/** The smallest thing that is really a PNG of the given square size. */
function squarePng(size: number): Uint8Array {
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const bytes = new Uint8Array(64)
  bytes.set(header, 0)
  const writeUint32BE = (offset: number, value: number) => {
    bytes[offset] = (value >>> 24) & 0xff
    bytes[offset + 1] = (value >>> 16) & 0xff
    bytes[offset + 2] = (value >>> 8) & 0xff
    bytes[offset + 3] = value & 0xff
  }
  writeUint32BE(16, size)
  writeUint32BE(20, size)
  return bytes
}

function pngResponse(bytes: Uint8Array): Response {
  return new Response(bytes, { status: 200, headers: { "content-type": "image/png" } })
}

function withDirectory<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "flydesk-marks-"))
  resetAirlineMarkStoreForTests()
  try {
    return run(directory)
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
      return pngResponse(squarePng(70))
    }) as typeof fetch

    const first = await ensureAirlineMark("ba", { directory, fetchImpl, sourceBaseUrl: "https://marks.test" })
    assert.equal(first, join(directory, "BA.png"))
    assert.equal(fetches, 1)
    assert.equal(readSquarePngSize(new Uint8Array(readFileSync(first!))), 70)

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
      return pngResponse(squarePng(70))
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
    ["a rectangle", pngResponse((() => {
      const bytes = squarePng(70)
      bytes[23] = 40
      return bytes
    })())],
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
    const fetchImpl = (async () => { fetches += 1; return pngResponse(squarePng(70)) }) as typeof fetch
    const options = { directory, fetchImpl, sourceBaseUrl: "https://marks.test" }

    for (const value of ["../../etc/passwd", "LATAM", "", "A", "A/B", undefined]) {
      assert.equal(await ensureAirlineMark(value, options), undefined, String(value))
    }
    assert.equal(fetches, 0)
    assert.deepEqual(filesIn(directory), [])
  })
})
