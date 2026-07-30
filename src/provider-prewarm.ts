import { prewarmLocalAgilSession } from "./local-agil";
import { prewarmLocalCostamarContext } from "./local-costamar";
import { logPerfSpan, startPerfTimer } from "./perf";
import type { ProviderId } from "./core/types";
import {
  providerDegradedReasonFromError,
  type ProviderStatusTracker,
} from "./provider-status";

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

export async function prewarmProvidersSilently(providerStatus?: ProviderStatusTracker): Promise<void> {
  const prewarmStart = startPerfTimer();
  const providerIds = ["agil-local", "costamar"] as const satisfies readonly ProviderId[];
  providerIds.forEach((providerId) => providerStatus?.markChecking(providerId, "prewarm"));
  const outcomes = await Promise.allSettled([
    prewarmLocalAgilSession(),
    Promise.resolve().then(() => prewarmLocalCostamarContext()),
  ]);

  outcomes.forEach((outcome, index) => {
    const providerId = providerIds[index]!;
    if (outcome.status === "rejected") {
      const reasonCode = providerDegradedReasonFromError(outcome.reason);
      providerStatus?.recordDegraded(providerId, "prewarm", reasonCode);
      return;
    }

    if (providerId === "costamar") {
      providerStatus?.recordCostamarContextAvailable();
    } else {
      providerStatus?.recordReady(providerId, "prewarm");
    }
  });

  const failed = outcomes.filter((outcome) => outcome.status === "rejected");
  if (failed.length > 0) {
    const failedProviderIds = outcomes.flatMap((outcome, index) =>
      outcome.status === "rejected" ? [providerIds[index]] : []);
    console.warn(
      `Fly Desk provider prewarm skipped ${failed.length} provider(s): ${failedProviderIds.join(", ")}`,
    );
  }

  logPerfSpan("providers.prewarm", prewarmStart, {
    failed: failed.length,
  });
}

export function startProviderPrewarmLoop(providerStatus?: ProviderStatusTracker): NodeJS.Timeout | undefined {
  if (!providerPrewarmEnabled()) {
    return undefined;
  }

  void prewarmProvidersSilently(providerStatus).catch(() => undefined);
  const intervalMs = providerPrewarmIntervalMs();
  if (intervalMs <= 0) {
    return undefined;
  }

  const timer = setInterval(() => {
    void prewarmProvidersSilently(providerStatus).catch(() => undefined);
  }, intervalMs);
  timer.unref?.();
  return timer;
}
