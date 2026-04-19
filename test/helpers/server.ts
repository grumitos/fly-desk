import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { resetRuntimeForTests } from "../../src/runtime";
import { createServer } from "../../src/server";

export async function withServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const previousSearchTodayOverride = process.env.SEARCH_TODAY_OVERRIDE;
  process.env.SEARCH_TODAY_OVERRIDE = previousSearchTodayOverride ?? "2026-03-31";
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    return await run(baseUrl);
  } finally {
    try {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    } finally {
      if (previousSearchTodayOverride === undefined) {
        delete process.env.SEARCH_TODAY_OVERRIDE;
      } else {
        process.env.SEARCH_TODAY_OVERRIDE = previousSearchTodayOverride;
      }
      resetRuntimeForTests();
    }
  }
}
