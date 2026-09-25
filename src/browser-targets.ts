/*
 * Tabs this process has open in a browser it does not own: the shared Chrome
 * that holds the provider sessions, which outlives every Fly Desk process. The
 * code that opens a tab closes it in a `finally`; this list is for the stop that
 * comes before that `finally` runs.
 */
const openTargets = new Set<() => Promise<unknown>>();
let closing = false;

/**
 * Records how to close a tab just opened, and returns what forgets it once
 * its owner has closed it. A tab that arrives while the process is stopping
 * is closed at once.
 */
export function trackOpenBrowserTarget(close: () => Promise<unknown>): () => void {
  if (closing) {
    void Promise.resolve().then(close).catch(() => undefined);
    return () => undefined;
  }

  openTargets.add(close);
  return () => {
    openTargets.delete(close);
  };
}

/** Closes every tab still open, waiting for them at most `timeoutMs`. */
export async function closeOpenBrowserTargets(timeoutMs: number): Promise<void> {
  closing = true;
  const closers = [...openTargets];
  openTargets.clear();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(closers.map((close) => Promise.resolve().then(close))),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}
