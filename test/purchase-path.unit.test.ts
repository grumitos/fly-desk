import { test } from "bun:test"
import assert from "node:assert/strict"
import { bestPurchasePath, normalizeSafePurchaseUrl } from "../frontend/src/lib/purchase-path"
import type { CanonicalOffer, PurchasePath } from "../frontend/src/types"

/*
 * Which link «Ir al proveedor» opens.
 *
 * An offer can carry several ways to buy it, and they are not equivalent: an
 * exact deeplink lands on the fare the agent chose, a broad search lands on a
 * results page they then have to find it in again. The Playwright case in
 * `test/ui/results.playwright.ts` proves the highest-ranked one is opened, with
 * a fixture whose paths are already in the right order — which is the shape
 * where any sort at all looks correct.
 *
 * The ordering itself is what this file pins.
 */

function path(overrides: Partial<PurchasePath> & { id: string }): PurchasePath {
  return {
    type: "search-redirect",
    provider: "costamar",
    label: "Click and Book Plus",
    url: `https://example.test/${overrides.id}`,
    precision: "broad-search",
    score: 0,
    requiresNewTab: true,
    commercialMode: "provider",
    state: "search_redirect",
    ...overrides,
  }
}

function offerWith(paths: PurchasePath[]): CanonicalOffer {
  return { id: "offer-1", purchasePaths: paths } as CanonicalOffer
}

test("precision decides before anything else", () => {
  const chosen = bestPurchasePath(offerWith([
    path({ id: "manual", precision: "manual" }),
    path({ id: "broad", precision: "broad-search" }),
    path({ id: "exact-search", precision: "exact-search" }),
    path({ id: "exact-offer", precision: "exact-offer" }),
  ]))

  assert.equal(chosen?.id, "exact-offer")
})

test("a state that reaches the fare is worth two steps of precision", () => {
  /* The precision ladder moves in 10s and `api_bookable`/`deeplink_exact` are
     worth 20, so the bonus is deliberately large enough to jump two rungs: a
     broad search that still deeplinks to the fare beats an exact search that
     only redirects. That is the point — precision describes the landing page,
     the state describes whether the fare is actually there. */
  const acrossPrecision = bestPurchasePath(offerWith([
    path({ id: "broad-deeplink", precision: "broad-search", state: "deeplink_exact" }),
    path({ id: "exact-search-redirect", precision: "exact-search", state: "search_redirect" }),
  ]))
  assert.equal(acrossPrecision?.id, "broad-deeplink")

  // Three rungs is beyond it, so precision still wins where the gap is wide.
  const wideGap = bestPurchasePath(offerWith([
    path({ id: "manual-deeplink", precision: "manual", state: "deeplink_exact" }),
    path({ id: "exact-offer-redirect", precision: "exact-offer", state: "search_redirect" }),
  ]))
  assert.equal(wideGap?.id, "exact-offer-redirect")

  const withinPrecision = bestPurchasePath(offerWith([
    path({ id: "redirect", precision: "exact-search", state: "search_redirect" }),
    path({ id: "bookable", precision: "exact-search", state: "api_bookable" }),
  ]))
  assert.equal(withinPrecision?.id, "bookable")
})

test("the provider's own score only breaks a tie", () => {
  const chosen = bestPurchasePath(offerWith([
    path({ id: "high-score-broad", precision: "broad-search", score: 9 }),
    path({ id: "low-score-exact", precision: "exact-offer", score: 0 }),
  ]))
  assert.equal(chosen?.id, "low-score-exact")

  const tie = bestPurchasePath(offerWith([
    path({ id: "quiet", precision: "exact-offer", score: 1 }),
    path({ id: "loud", precision: "exact-offer", score: 5 }),
  ]))
  assert.equal(tie?.id, "loud")
})

test("choosing a path does not reorder the offer's own list", () => {
  /* The list is rendered elsewhere in the order the provider gave it; a sort in
     place here would have silently rewritten that. */
  const paths = [
    path({ id: "broad", precision: "broad-search" }),
    path({ id: "exact", precision: "exact-offer" }),
  ]
  const offer = offerWith(paths)

  assert.equal(bestPurchasePath(offer)?.id, "exact")
  assert.deepEqual(paths.map((entry) => entry.id), ["broad", "exact"])
})

test("an offer with no way to buy it has no best one", () => {
  assert.equal(bestPurchasePath(offerWith([]), ), undefined)
  assert.equal(bestPurchasePath({ id: "offer-2" } as CanonicalOffer), undefined)
})

test("only an http(s) destination is handed to the browser", () => {
  const globalWindow = globalThis as typeof globalThis & { window?: { location: { origin: string } } }
  const originalWindow = globalWindow.window
  globalWindow.window = { location: { origin: "https://fly-desk.test" } }

  try {
    assert.equal(
      normalizeSafePurchaseUrl("https://booking.clickandbook.com/vuelos"),
      "https://booking.clickandbook.com/vuelos",
    )
    // Relative paths resolve against this instance, whatever port it is on.
    assert.equal(normalizeSafePurchaseUrl("/redirect/abc"), "https://fly-desk.test/redirect/abc")
    // A provider payload is not trusted to name the scheme.
    assert.equal(normalizeSafePurchaseUrl("javascript:alert(1)"), undefined)
    assert.equal(normalizeSafePurchaseUrl("data:text/html,<script>alert(1)</script>"), undefined)
    assert.equal(normalizeSafePurchaseUrl("file:///etc/passwd"), undefined)
    /* An empty value is *not* rejected — it resolves to this instance's root,
       which is why `DetailPanel` asks whether the path has a url at all before
       it gets here. Pinned so that guard is not read as redundant. */
    assert.equal(normalizeSafePurchaseUrl(""), "https://fly-desk.test/")
  } finally {
    globalWindow.window = originalWindow
  }
})
