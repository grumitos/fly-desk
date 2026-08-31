import { loadRuntimeConfig, resolveServerHost } from "./config";
import {
  getRuntime,
  getRuntimeIfInitialized,
  getSessionStoreIfInitialized,
  maintainSessionStoreIfInitialized,
  type RuntimeServices,
} from "./runtime";
import { createServer } from "./server";
import { logPerfSpan, startPerfTimer } from "./perf";
import {
  cleanupPrefixedTempArtifacts,
  TEMP_ARTIFACT_SWEEP_INTERVAL_MS,
  TEMP_ARTIFACT_SWEEP_MIN_AGE_MS,
} from "./temp-artifacts";
import { startProviderPrewarmLoop } from "./provider-prewarm";
import { isSearchServiceDelegationConfigured } from "./search-service-client";
import { startSearchWorkerPool, stopSearchWorkerPool } from "./search-worker-client";
import { flushPendingProgressForShutdown } from "./http-router";

const STARTUP_BACKGROUND_TASK_DELAY_MS = 10_000;
const SESSION_MAINTENANCE_INTERVAL_MS = 60_000;
const SHUTDOWN_CANCELLED_WARNING = "Search stopped because Fly Desk was restarted.";
const SHUTDOWN_CANCEL_GRACE_MS = 1_000;
const SHUTDOWN_JOB_DRAIN_MS = 4_000;

/*
 * How long a stop may take, and what happens when it takes longer.
 *
 * `server.stop()` with no argument is Bun's graceful stop: it resolves once
 * in-flight requests and their connections have drained. Under a migratory
 * sweep the frontend polls without pause and each proxied call carries its own
 * multi-second timeout, so "drained" can be a minute away — and on 2026-08-14 it
 * was. Every stop took the full 45s `TimeoutStopSec` and ended in SIGKILL, five
 * times in eight minutes, while Caddy had no upstream and the site served 503.
 * The contrast that proves it: at 19:34:23 an idle process with nothing to drain
 * stopped instantly, same code.
 *
 * SIGKILL is not a tidy ending. It skips every `finally`, which is how the
 * provider paths close the CDP tabs they opened — renderers went from 8 to 30
 * across the loop.
 *
 * So the drain gets a short window and then the connections are closed under it,
 * and the whole shutdown gets a deadline shorter than the tightest
 * `TimeoutStopSec` in the unit files (the search runner's 15s). Exiting on our
 * own terms at 8s runs the cleanup; being killed at 15 or 45 does not.
 */
const SHUTDOWN_DRAIN_MS = 3_000;
const SHUTDOWN_DEADLINE_MS = 8_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const startupStart = startPerfTimer();
  loadRuntimeConfig();
  const delegatesSearch = isSearchServiceDelegationConfigured();
  const runtimeStart = startPerfTimer();
  const startupRuntime = delegatesSearch ? undefined : getRuntime();
  const startupSessions = startupRuntime?.sessions;
  if (startupRuntime) {
    logPerfSpan("startup.runtime", runtimeStart);
  } else {
    logPerfSpan("startup.runtime.skipped", runtimeStart);
  }

  const port = Number(process.env.PORT ?? "3000");
  const host = resolveServerHost();
  const server = createServer({ port, hostname: host });
  let providerPrewarmHandle: NodeJS.Timeout | undefined;
  let providerPrewarmStartTimer: NodeJS.Timeout | undefined;
  let startupCleanupTimer: NodeJS.Timeout | undefined;
  let tempCleanupPromise: Promise<void> | undefined;
  const runTempCleanup = (label: string, options?: { olderThanMs?: number }): void => {
    if (tempCleanupPromise) {
      return;
    }

    const cleanupStart = startPerfTimer();
    tempCleanupPromise = cleanupPrefixedTempArtifacts(undefined, options)
      .catch((error) => {
        const detail = error instanceof Error ? error.message : "unknown cleanup failure";
        console.warn(`Fly Desk temp cleanup skipped: ${detail}`);
      })
      .finally(() => {
        logPerfSpan(label, cleanupStart);
        tempCleanupPromise = undefined;
      });
  };
  const getActiveRuntime = (): RuntimeServices | undefined => startupRuntime ?? getRuntimeIfInitialized();
  const sessionMaintenanceHandle = setInterval(
    maintainSessionStoreIfInitialized,
    SESSION_MAINTENANCE_INTERVAL_MS,
  );
  sessionMaintenanceHandle.unref?.();
  const maintenanceHandle = setInterval(() => {
    const activeRuntime = getActiveRuntime();
    activeRuntime?.locationSuggestions.purgeExpired();
    runTempCleanup("periodic.tempCleanup", {
      olderThanMs: TEMP_ARTIFACT_SWEEP_MIN_AGE_MS,
    });
  }, TEMP_ARTIFACT_SWEEP_INTERVAL_MS);
  maintenanceHandle.unref?.();

  /* Give the drain its window, then take the connections down under it.
     `server.stop(true)` is the same stop with `closeActiveConnections`, which is
     the difference between a poller deciding to go away and us deciding for it. */
  const stopServerWithinDrainWindow = async (): Promise<void> => {
    let drained = false;
    await Promise.race([
      server.stop().then(() => {
        drained = true;
      }),
      delay(SHUTDOWN_DRAIN_MS),
    ]).catch(() => undefined);

    if (drained) {
      return;
    }

    console.warn(
      `Fly Desk shutdown closing active connections after ${SHUTDOWN_DRAIN_MS}ms of drain.`,
    );
    await server.stop(true).catch(() => undefined);
  };

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    const activeRuntime = getActiveRuntime();
    const activeSessions = startupSessions ?? getSessionStoreIfInitialized();
    activeRuntime?.searchAdmission.stopAccepting(SHUTDOWN_CANCELLED_WARNING);
    /* Close the HTTP side while the admission leases finish. The token
       receiver restarts this unit after every successful C&B installation;
       cancelling first used to take Agil down with C&B even when its worker
       was about to return usable offers. */
    const serverStop = stopServerWithinDrainWindow();
    flushPendingProgressForShutdown();
    await activeRuntime?.searchAdmission.drain(SHUTDOWN_JOB_DRAIN_MS);
    const cancelled = activeSessions?.cancelRunningJobs(SHUTDOWN_CANCELLED_WARNING, { cachePartial: true })
      ?? { searchJobs: 0, matrixJobs: 0 };
    activeRuntime?.searchAdmission.dispose(SHUTDOWN_CANCELLED_WARNING);
    if (cancelled.searchJobs > 0 || cancelled.matrixJobs > 0) {
      console.warn(
        `Fly Desk shutdown cancelled active jobs: search=${cancelled.searchJobs} matrix=${cancelled.matrixJobs}`,
      );
      await delay(SHUTDOWN_CANCEL_GRACE_MS);
    }
    clearInterval(maintenanceHandle);
    clearInterval(sessionMaintenanceHandle);
    if (startupCleanupTimer) {
      clearTimeout(startupCleanupTimer);
    }
    if (providerPrewarmStartTimer) {
      clearTimeout(providerPrewarmStartTimer);
    }
    if (providerPrewarmHandle) {
      clearInterval(providerPrewarmHandle);
    }
    stopSearchWorkerPool();
    await serverStop;
    await tempCleanupPromise?.catch(() => undefined);
    activeRuntime?.locationSuggestions.purgeExpired(Number.POSITIVE_INFINITY);
    activeSessions?.close();
    await cleanupPrefixedTempArtifacts(undefined, { olderThanMs: 0 }).catch(() => undefined);
  };

  /* The deadline is armed by the signal, not by `shutdown()`, so it covers a
     hang anywhere — including one before the first await. Nothing below it may
     be trusted to finish; that is what a deadline is for. */
  const exitOnSignal = (signal: string) => {
    const deadline = setTimeout(() => {
      console.warn(
        `Fly Desk shutdown exceeded ${SHUTDOWN_DEADLINE_MS}ms after ${signal}; exiting anyway.`,
      );
      process.exit(0);
    }, SHUTDOWN_DEADLINE_MS);

    void shutdown().finally(() => {
      clearTimeout(deadline);
      process.exit(0);
    });
  };

  process.once("SIGINT", () => exitOnSignal("SIGINT"));
  process.once("SIGTERM", () => exitOnSignal("SIGTERM"));

  logPerfSpan("startup.ready", startupStart, { host, port });
  console.log(`Fly Desk running at http://${host}:${port}`);
  startupCleanupTimer = setTimeout(() => {
    startupCleanupTimer = undefined;
    runTempCleanup("startup.tempCleanup");
  }, STARTUP_BACKGROUND_TASK_DELAY_MS);
  startupCleanupTimer.unref?.();
  if (!delegatesSearch) {
    /* Start the pooled workers with the server, so the first search pays for a
       warm worker instead of a Bun startup. */
    startSearchWorkerPool();
    providerPrewarmStartTimer = setTimeout(() => {
      providerPrewarmStartTimer = undefined;
      providerPrewarmHandle = startProviderPrewarmLoop(startupRuntime?.providerStatus);
    }, STARTUP_BACKGROUND_TASK_DELAY_MS);
    providerPrewarmStartTimer.unref?.();
  }
}

void main();
