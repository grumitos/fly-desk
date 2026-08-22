import { test } from "bun:test"
import assert from "node:assert/strict"
import {
  nextPollDelayMs,
  POLL_FAST_MS,
  POLL_INTERVAL_MS,
  POLL_LONG_WAIT_MS,
} from "../frontend/src/lib/poll-schedule"

/*
 * The gap between two polls, and the one case that still needs one.
 *
 * With `wait=<ms>` the server answers when the job moves, so the browser has
 * nothing to gain by pausing: an update means more is coming, and a slow
 * `unchanged` means the wait was already spent server-side. The single reason
 * to fall back to the old 900ms tick is a server that ignores `wait` and
 * answers `unchanged` instantly — re-asking that one at once would spin.
 */
test("an update is followed immediately by the next poll", () => {
  assert.equal(nextPollDelayMs({ unchanged: false, elapsedMs: 12 }), POLL_FAST_MS)
  assert.equal(nextPollDelayMs({ unchanged: false, elapsedMs: 14_000 }), POLL_FAST_MS)
})

test("an unchanged answer that took the wait is re-asked immediately", () => {
  assert.equal(nextPollDelayMs({ unchanged: true, elapsedMs: 500 }), POLL_FAST_MS)
  assert.equal(nextPollDelayMs({ unchanged: true, elapsedMs: 15_000 }), POLL_FAST_MS)
})

test("an instant unchanged answer falls back to the fixed interval", () => {
  assert.equal(nextPollDelayMs({ unchanged: true, elapsedMs: 0 }), POLL_INTERVAL_MS)
  assert.equal(nextPollDelayMs({ unchanged: true, elapsedMs: 499 }), POLL_INTERVAL_MS)
})

test("the requested wait stays under the router's ceiling", async () => {
  const { JOB_POLL_MAX_WAIT_MS } = await import("../src/http-router")
  assert.ok(POLL_LONG_WAIT_MS > 0)
  assert.ok(POLL_LONG_WAIT_MS <= JOB_POLL_MAX_WAIT_MS)
})
