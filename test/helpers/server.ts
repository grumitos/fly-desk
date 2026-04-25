import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/server";

const CHROMIUM_UNSAFE_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6697, 10080,
]);

async function listenOnChromiumSafePort() {
  for (;;) {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    if (!CHROMIUM_UNSAFE_PORTS.has(address.port)) {
      return { server, port: address.port };
    }

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

export async function withServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const previousSearchTodayOverride = process.env.SEARCH_TODAY_OVERRIDE;
  const previousBackgroundSearchJobs = process.env.FLY_DESK_DISABLE_BACKGROUND_SEARCH_JOBS;
  process.env.SEARCH_TODAY_OVERRIDE = previousSearchTodayOverride ?? "2026-03-31";
  process.env.FLY_DESK_DISABLE_BACKGROUND_SEARCH_JOBS = "1";
  const { server, port } = await listenOnChromiumSafePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    return await run(baseUrl);
  } finally {
    try {
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

      if (previousBackgroundSearchJobs === undefined) {
        delete process.env.FLY_DESK_DISABLE_BACKGROUND_SEARCH_JOBS;
      } else {
        process.env.FLY_DESK_DISABLE_BACKGROUND_SEARCH_JOBS = previousBackgroundSearchJobs;
      }
    }
  }
}
