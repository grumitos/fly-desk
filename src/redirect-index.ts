import { loadRuntimeConfig } from "./config";
import { createRedirectServer, resolveRedirectServerHost, resolveRedirectServerPort } from "./redirect-service";

async function main(): Promise<void> {
  loadRuntimeConfig();
  const host = resolveRedirectServerHost();
  const port = resolveRedirectServerPort();
  const server = createRedirectServer({ hostname: host, port });

  const shutdown = async () => {
    await server.stop();
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  console.log(`Fly Desk redirect service running at http://${host}:${port}`);
}

void main();
