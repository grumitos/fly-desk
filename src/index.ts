import { loadRuntimeConfig, resolveServerHost } from "./config";
import { createServer } from "./server";

async function main() {
  loadRuntimeConfig();
  const port = Number(process.env.PORT ?? "3000");
  const host = resolveServerHost();
  const server = createServer();

  await new Promise<void>((resolve) => {
    server.listen(port, host, resolve);
  });

  console.log(`Fly Desk running at http://${host}:${port}`);
}

void main();
