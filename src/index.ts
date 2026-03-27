import { loadRuntimeConfig } from "./config";
import { createServer } from "./server";

async function main() {
  loadRuntimeConfig();
  const port = Number(process.env.PORT ?? "3000");
  const server = createServer();

  await new Promise<void>((resolve) => {
    server.listen(port, resolve);
  });

  console.log(`Fly Desk running at http://localhost:${port}`);
}

void main();
