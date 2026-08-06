import { prewarmLocalAgilSession } from "./local-agil";
import { prewarmLocalCostamarContext } from "./local-costamar";
import { logPerfSpan, startPerfTimer } from "./perf";

const DEFAULT_PROVIDER_PREWARM_INTERVAL_MS = 10 * 60 * 1000;

function readNonNegativeMs(name: string, fallbackMs: number): number {
  const raw = Number(process.env[name] ?? fallbackMs);
  return Number.isFinite(raw) && raw >= 0
    ? Math.trunc(raw)
    : fallbackMs;
}

export function providerPrewarmEnabled(): boolean {
  return String(process.env.FLY_DESK_PROVIDER_PREWARM ?? "1").trim() !== "0";
}

export function providerPrewarmIntervalMs(): number {
  return readNonNegativeMs("FLY_DESK_PROVIDER_PREWARM_INTERVAL_MS", DEFAULT_PROVIDER_PREWARM_INTERVAL_MS);
}

export async function prewarmProvidersSilently(): Promise<void> {
  const prewarmStart = startPerfTimer();
  const outcomes = await Promise.allSettled([
    prewarmLocalAgilSession(),
    Promise.resolve().then(() => prewarmLocalCostamarContext()),
  ]);

  const failed = outcomes.filter((outcome) => outcome.status === "rejected");
  if (failed.length > 0) {
    console.warn(`Fly Desk provider prewarm skipped ${failed.length} provider(s): ${
      failed.map((outcome) => outcome.status === "rejected"
        ? outcome.reason instanceof Error ? outcome.reason.message : "unknown failure"
        : "")
        .filter(Boolean)
        .join(" | ")
    }`);
  }

  logPerfSpan("providers.prewarm", prewarmStart, {
    failed: failed.length,
  });
}

export function startProviderPrewarmLoop(): NodeJS.Timeout | undefined {
  if (!providerPrewarmEnabled()) {
    return undefined;
  }

  void prewarmProvidersSilently().catch(() => undefined);
  const intervalMs = providerPrewarmIntervalMs();
  if (intervalMs <= 0) {
    return undefined;
  }

  const timer = setInterval(() => {
    void prewarmProvidersSilently().catch(() => undefined);
  }, intervalMs);
  timer.unref?.();
  return timer;
}
