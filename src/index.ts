import { resolveServerHost } from "./config";
import { envNumber } from "./env";
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
import { abortLiveJobs, flushPendingProgressForShutdown } from "./http-router";

const STARTUP_BACKGROUND_TASK_DELAY_MS = 10_000;
const SESSION_MAINTENANCE_INTERVAL_MS = 60_000;
const SHUTDOWN_CANCELLED_WARNING = "Search stopped because Fly Desk was restarted.";

/*
 * Shutdown budget. Running searches get `SHUTDOWN_JOB_DRAIN_MS` to finish,
 * with the HTTP side still serving, so a page following one sees how it ends;
 * the rest are cancelled keeping what they found. From there the cancelled
 * jobs unwind, the pooled workers stop (closing their tabs within 2 s), and
 * the HTTP side stops: Bun's graceful `server.stop()` waits for every request
 * in flight, a long poll included, so it gets `SHUTDOWN_DRAIN_MS` before
 * connections are closed under it. The whole shutdown has a deadline below
 * the search runner's 15 s `TimeoutStopSec`: exiting on our own terms runs the
 * cleanup (CDP tabs, SQLite) that SIGKILL would skip.
 */
const SHUTDOWN_JOB_DRAIN_MS = 3_000;
const SHUTDOWN_CANCEL_GRACE_MS = 1_000;
const SHUTDOWN_WORKER_EXIT_MS = 2_500;
const SHUTDOWN_DRAIN_MS = 3_000;
const SHUTDOWN_DEADLINE_MS = 8_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const startupStart = startPerfTimer();
  const delegatesSearch = isSearchServiceDelegationConfigured();
  const runtimeStart = startPerfTimer();
  const startupRuntime = delegatesSearch ? undefined : getRuntime();
  const startupSessions = startupRuntime?.sessions;
  if (startupRuntime) {
    logPerfSpan("startup.runtime", runtimeStart);
  } else {
    logPerfSpan("startup.runtime.skipped", runtimeStart);
  }
  /* The unit that runs searches owns the session cache, and before its port
     opens no request waits on it. The web unit delegates searches to this one,
     and the redirect unit only reads the file, which WAL does not block. */
  startupSessions?.vacuumIfWorthwhile();

  const port = Math.trunc(envNumber("PORT", 3000, { min: 0, max: 65535 }));
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
  /* The phase a stop is in, for the deadline to name. */
  let shutdownPhase = "starting";
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    const startedAt = Date.now();
    /* Each phase logs its duration as it ends, so a stop killed at
       `TimeoutStopSec` still shows the phases it finished and the one it was
       in. A phase that throws is logged and the stop goes on: the phases after
       it are what keep the session cache on disk. */
    const phase = async (name: string, run: () => unknown): Promise<void> => {
      shutdownPhase = name;
      const phaseStartedAt = Date.now();
      let outcome = "took";
      try {
        await run();
      } catch (error) {
        outcome = `failed (${error instanceof Error ? error.message : "unknown failure"}) after`;
      }
      const now = Date.now();
      console.log(`Fly Desk shutdown: ${name} ${outcome} ${now - phaseStartedAt}ms, ${now - startedAt}ms after ${signal}`);
    };

    const activeRuntime = getActiveRuntime();
    const activeSessions = startupSessions ?? getSessionStoreIfInitialized();
    activeRuntime?.searchAdmission.stopAccepting(SHUTDOWN_CANCELLED_WARNING);
    /* The HTTP side keeps serving while running searches finish, so a
       provider about to answer still publishes its offers and a page
       following the search reads them. */
    await phase("drain", async () => {
      flushPendingProgressForShutdown();
      await activeRuntime?.searchAdmission.drain(SHUTDOWN_JOB_DRAIN_MS);
    });
    let cancelled = { searchJobs: 0, matrixJobs: 0 };
    await phase("cancel", () => {
      cancelled = activeSessions?.cancelRunningJobs(SHUTDOWN_CANCELLED_WARNING, { cachePartial: true })
        ?? cancelled;
      /* What the cancelled jobs still had at their providers is hung up on,
         and their units come back as that settles. */
      abortLiveJobs();
      if (cancelled.searchJobs > 0 || cancelled.matrixJobs > 0) {
        console.warn(
          `Fly Desk shutdown cancelled active jobs: search=${cancelled.searchJobs} matrix=${cancelled.matrixJobs}`,
        );
      }
    });
    /* Nothing starts from here on: a prewarm would spawn the workers anew. */
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
    /* Every job has its final state, and the pages parked on one have been
       answered: the rest ends side by side. */
    const workersStopped = stopSearchWorkerPool();
    const serverStop = stopServerWithinDrainWindow();
    if (cancelled.searchJobs > 0 || cancelled.matrixJobs > 0) {
      await phase("unwind", () => activeRuntime?.searchAdmission.drain(SHUTDOWN_CANCEL_GRACE_MS));
    }
    await phase("workers", () => Promise.race([workersStopped, delay(SHUTDOWN_WORKER_EXIT_MS)]));
    await phase("http", () => serverStop);
    await phase("temp cleanup", () => tempCleanupPromise?.catch(() => undefined));
    await phase("location cache", () => activeRuntime?.locationSuggestions.purgeExpired());
    await phase("session cache", () => activeSessions?.close());
    await phase("temp artifacts", () =>
      cleanupPrefixedTempArtifacts(undefined, { olderThanMs: TEMP_ARTIFACT_SWEEP_MIN_AGE_MS }).catch(() => undefined));
  };

  /* The deadline is armed by the signal, not by `shutdown()`, so it covers a
     hang anywhere — including one before the first await. Nothing below it may
     be trusted to finish; that is what a deadline is for. */
  const exitOnSignal = (signal: string) => {
    const deadline = setTimeout(() => {
      console.warn(
        `Fly Desk shutdown exceeded ${SHUTDOWN_DEADLINE_MS}ms after ${signal} during ${shutdownPhase}; exiting anyway.`,
      );
      process.exit(0);
    }, SHUTDOWN_DEADLINE_MS);

    void shutdown(signal).finally(() => {
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
    runTempCleanup("startup.tempCleanup", { olderThanMs: TEMP_ARTIFACT_SWEEP_MIN_AGE_MS });
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
