import { loadRuntimeConfig, resolveServerHost } from "./config";
import { getRuntime } from "./runtime";
import { createServer } from "./server";
import {
  cleanupPrefixedTempArtifacts,
  TEMP_ARTIFACT_SWEEP_INTERVAL_MS,
  TEMP_ARTIFACT_SWEEP_MIN_AGE_MS,
} from "./temp-artifacts";

async function main() {
  loadRuntimeConfig();
  const runtime = getRuntime();

  try {
    await cleanupPrefixedTempArtifacts();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown cleanup failure";
    console.warn(`Fly Desk temp cleanup skipped: ${detail}`);
  }

  const port = Number(process.env.PORT ?? "3000");
  const host = resolveServerHost();
  const server = createServer();
  let periodicCleanupPromise: Promise<void> | undefined;
  const runPeriodicCleanup = (): void => {
    if (periodicCleanupPromise) {
      return;
    }

    periodicCleanupPromise = cleanupPrefixedTempArtifacts(undefined, {
      olderThanMs: TEMP_ARTIFACT_SWEEP_MIN_AGE_MS,
    })
      .catch((error) => {
        const detail = error instanceof Error ? error.message : "unknown cleanup failure";
        console.warn(`Fly Desk periodic temp cleanup skipped: ${detail}`);
      })
      .finally(() => {
        periodicCleanupPromise = undefined;
      });
  };
  const maintenanceHandle = setInterval(() => {
    runtime.sessions.purgeExpired();
    runtime.locationSuggestions.purgeExpired();
    runPeriodicCleanup();
  }, TEMP_ARTIFACT_SWEEP_INTERVAL_MS);
  maintenanceHandle.unref?.();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    clearInterval(maintenanceHandle);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await periodicCleanupPromise?.catch(() => undefined);
    runtime.locationSuggestions.purgeExpired(Number.POSITIVE_INFINITY);
    runtime.sessions.purgeExpired(Number.POSITIVE_INFINITY);
    await cleanupPrefixedTempArtifacts(undefined, { olderThanMs: 0 }).catch(() => undefined);
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  await new Promise<void>((resolve) => {
    server.listen(port, host, resolve);
  });

  console.log(`Fly Desk running at http://${host}:${port}`);
}

void main();
