import { createRedirectServer, resolveRedirectServerHost, resolveRedirectServerPort } from "./redirect-service";

/* Same shutdown budget as the web entrypoint: a redirect mid-validation can hold
   a connection open past this unit's 20 s `TimeoutStopSec`. */
const SHUTDOWN_DRAIN_MS = 3_000;
const SHUTDOWN_DEADLINE_MS = 8_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const host = resolveRedirectServerHost();
  const port = resolveRedirectServerPort();
  const server = createRedirectServer({ hostname: host, port });

  const shutdown = async () => {
    let drained = false;
    await Promise.race([
      server.stop().then(() => {
        drained = true;
      }),
      delay(SHUTDOWN_DRAIN_MS),
    ]).catch(() => undefined);

    if (!drained) {
      await server.stop(true).catch(() => undefined);
    }
  };

  const exitOnSignal = (signal: string) => {
    const deadline = setTimeout(() => {
      console.warn(
        `Fly Desk redirect shutdown exceeded ${SHUTDOWN_DEADLINE_MS}ms after ${signal}; exiting anyway.`,
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

  console.log(`Fly Desk redirect service running at http://${host}:${port}`);
}

void main();
