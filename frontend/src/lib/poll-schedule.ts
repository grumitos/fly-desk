/*
 * How long to wait before asking the job again.
 *
 * The poll now asks the server to hold the request open (`wait=<ms>`), so the
 * answer arrives when the job moves rather than when the next tick comes due.
 * That makes waiting between polls almost always wrong: an update means there
 * is more coming right behind it, and a long-polled `unchanged` means the
 * server already spent the wait for us.
 *
 * The one case that still needs a gap is a server that does not know about
 * `wait` — an older runner, or a proxy that dropped the parameter. It answers
 * `unchanged` immediately, and re-asking at once would turn the poll into a
 * spin. A response that comes back faster than `LONG_POLL_MIN_ELAPSED_MS` with
 * nothing new is read as exactly that, and falls back to the old interval.
 */
export const POLL_INTERVAL_MS = 900
export const POLL_FAST_MS = 50
export const POLL_LONG_WAIT_MS = 15_000
const LONG_POLL_MIN_ELAPSED_MS = 500

export interface PollDelayInput {
  unchanged: boolean
  elapsedMs: number
}

export function nextPollDelayMs({ unchanged, elapsedMs }: PollDelayInput): number {
  if (!unchanged) return POLL_FAST_MS
  return elapsedMs < LONG_POLL_MIN_ELAPSED_MS ? POLL_INTERVAL_MS : POLL_FAST_MS
}
