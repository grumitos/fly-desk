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
import { flushPendingProgressForShutdown } from "./http-router";

const STARTUP_BACKGROUND_TASK_DELAY_MS = 10_000;
const SESSION_MAINTENANCE_INTERVAL_MS = 60_000;
const SHUTDOWN_CANCELLED_WARNING = "Search stopped because Fly Desk was restarted.";
const SHUTDOWN_CANCEL_GRACE_MS = 1_000;

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

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    const activeRuntime = getActiveRuntime();
    const activeSessions = startupSessions ?? getSessionStoreIfInitialized();
    flushPendingProgressForShutdown();
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
    await server.stop();
    await tempCleanupPromise?.catch(() => undefined);
    activeRuntime?.locationSuggestions.purgeExpired(Number.POSITIVE_INFINITY);
    activeSessions?.close();
    await cleanupPrefixedTempArtifacts(undefined, { olderThanMs: 0 }).catch(() => undefined);
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  logPerfSpan("startup.ready", startupStart, { host, port });
  console.log(`Fly Desk running at http://${host}:${port}`);
  startupCleanupTimer = setTimeout(() => {
    startupCleanupTimer = undefined;
    runTempCleanup("startup.tempCleanup");
  }, STARTUP_BACKGROUND_TASK_DELAY_MS);
  startupCleanupTimer.unref?.();
  if (!delegatesSearch) {
    providerPrewarmStartTimer = setTimeout(() => {
      providerPrewarmStartTimer = undefined;
      providerPrewarmHandle = startProviderPrewarmLoop();
    }, STARTUP_BACKGROUND_TASK_DELAY_MS);
    providerPrewarmStartTimer.unref?.();
  }
}

void main();
