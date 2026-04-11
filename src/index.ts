import { loadRuntimeConfig, resolveServerHost } from "./config";
import { createServer } from "./server";
import { cleanupPrefixedTempArtifacts } from "./temp-artifacts";

async function main() {
  loadRuntimeConfig();
  try {
    await cleanupPrefixedTempArtifacts();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown cleanup failure";
    console.warn(`Fly Desk temp cleanup skipped: ${detail}`);
  }

  const port = Number(process.env.PORT ?? "3000");
  const host = resolveServerHost();
  const server = createServer();

  await new Promise<void>((resolve) => {
    server.listen(port, host, resolve);
  });

  console.log(`Fly Desk running at http://${host}:${port}`);
}

void main();
