/*
 * The poll asks the server to hold the request (`wait=<ms>`) until the job
 * moves, so an answer is re-asked at once. Only a server that ignores `wait`
 * answers `unchanged` immediately, and that is spaced out instead of spun on.
 */
export const POLL_FAST_MS = 50
export const POLL_LONG_WAIT_MS = 15_000
const POLL_INTERVAL_MS = 900
const LONG_POLL_MIN_ELAPSED_MS = 500

/* A lost answer is a hop that timed out, not a search that stopped: the job
   keeps running on the server, so three misses in a row are needed to call it. */
export const POLL_MAX_CONSECUTIVE_FAILURES = 3
export const POLL_RETRY_DELAY_MS = 400

export function nextPollDelayMs({ unchanged, elapsedMs }: { unchanged: boolean; elapsedMs: number }): number {
  if (!unchanged) return POLL_FAST_MS
  return elapsedMs < LONG_POLL_MIN_ELAPSED_MS ? POLL_INTERVAL_MS : POLL_FAST_MS
}
