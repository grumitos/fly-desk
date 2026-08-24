import { prewarmLocalAgilSession } from "./local-agil";
import { prewarmLocalCostamarContext } from "./local-costamar";
import { logPerfSpan, startPerfTimer } from "./perf";
import type { ProviderId } from "./core/types";
import {
  providerDegradedReasonFromError,
  type ProviderStatusTracker,
} from "./provider-status";
import {
  prewarmProviderInWorker,
  searchWorkerPathAvailable,
  searchWorkerPoolEnabled,
} from "./search-worker-client";

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

/* A provider error can carry a URL with a token in it, so anything long enough
   to be credential material is masked before it reaches the journal, and the
   message is truncated: this is a breadcrumb for an operator, not a payload. */
export function describePrewarmFailure(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  const scrubbed = message
    /* A JWT first, as one unit. Its segments are individually short enough to
       slip a plain length rule - the header of a typical token is twenty
       characters - so masking by run length alone leaves two thirds of the
       credential in the log. Requiring eight characters per segment keeps
       hostnames out of it: no real TLD is that long. */
    .replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return scrubbed.slice(0, 200) || "(no message)";
}

export async function prewarmProvidersSilently(providerStatus?: ProviderStatusTracker): Promise<void> {
  const prewarmStart = startPerfTimer();
  const providerIds = ["agil-local", "costamar"] as const satisfies readonly ProviderId[];
  providerIds.forEach((providerId) => providerStatus?.markChecking(providerId, "prewarm"));
  /* With the pool on, provider searches run inside the pooled workers, so
     warming this process warms nothing that a search will ever read. */
  const warmsPooledWorkers = searchWorkerPoolEnabled() && searchWorkerPathAvailable();
  const outcomes = await Promise.allSettled(
    warmsPooledWorkers
      ? providerIds.map((providerId) => prewarmProviderInWorker(providerId))
      : [
          prewarmLocalAgilSession(),
          Promise.resolve().then(() => prewarmLocalCostamarContext()),
        ],
  );

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

  /* These are failures, not skips. The old line said "skipped N provider(s)"
     and listed only the ids, which reads as a benign optimisation - and the
     reason had been computed one block above and then thrown away. Agil was
     unreachable for two days and this line was the entire trace of it: no
     reason, no error, and a word that invited the reader to move on. */
  const failures = outcomes.flatMap((outcome, index) =>
    outcome.status === "rejected"
      ? [{ providerId: providerIds[index]!, reason: outcome.reason }]
      : []);

  for (const { providerId, reason } of failures) {
    console.warn(
      `Fly Desk provider prewarm failed: ${providerId} `
      + `reason=${providerDegradedReasonFromError(reason)} `
      + `detail=${describePrewarmFailure(reason)}`,
    );
  }

  logPerfSpan("providers.prewarm", prewarmStart, {
    failed: failures.length,
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
