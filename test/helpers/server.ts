import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/server";

export async function withServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    return await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}
