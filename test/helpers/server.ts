import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import { resolve } from "node:path";

const CHROMIUM_UNSAFE_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6697, 10080,
]);

type ServerHandle = {
  baseUrl: string;
  stop: () => Promise<void>;
};

async function findAvailableChromiumSafePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolvePort, reject) => {
      const probe = createTcpServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        probe.close(() => {
          if (typeof address === "object" && address) {
            resolvePort(address.port);
            return;
          }

          reject(new Error("Unable to reserve a local test port."));
        });
      });
    });

    if (!CHROMIUM_UNSAFE_PORTS.has(port)) {
      return port;
    }
  }
}

async function listenOnInProcessBunServer(): Promise<ServerHandle> {
  const { createServer } = await import("../../src/server");

  for (;;) {
    const server = createServer({ port: 0, hostname: "127.0.0.1" });
    if (!CHROMIUM_UNSAFE_PORTS.has(server.port)) {
      return {
        baseUrl: `http://127.0.0.1:${server.port}`,
        stop: () => server.stop(),
      };
    }

    await server.stop();
  }
}

function resolveBunExecutable(): string {
  return process.env.BUN_EXECUTABLE_PATH?.trim() || "bun";
}

async function waitForExternalServer(
  baseUrl: string,
  child: ChildProcessWithoutNullStreams,
  getLogs: () => string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  child.once("exit", (code, signal) => {
    exitCode = code;
    exitSignal = signal;
  });

  while (Date.now() < deadline) {
    if (exitCode !== null || exitSignal !== null) {
      throw new Error(`Bun test server exited before becoming ready.\n${getLogs()}`);
    }

    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the process binds its port or exits.
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }

  throw new Error(`Timed out waiting for Bun test server at ${baseUrl}.\n${getLogs()}`);
}

async function stopExternalServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill();
  await Promise.race([
    new Promise<void>((resolveStop) => child.once("exit", () => resolveStop())),
    new Promise<void>((resolveStop) => setTimeout(resolveStop, 5_000)),
  ]);

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

async function listenOnExternalBunServer(): Promise<ServerHandle> {
  const port = await findAvailableChromiumSafePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const rootDir = resolve(import.meta.dirname, "..", "..");
  let logs = "";
  const appendLogs = (chunk: Buffer) => {
    logs += chunk.toString("utf8");
    if (logs.length > 20_000) {
      logs = logs.slice(-20_000);
    }
  };
  const child = spawn(resolveBunExecutable(), ["src/index.ts"], {
    cwd: rootDir,
    env: {
      ...process.env,
      FLY_DESK_DISABLE_BACKGROUND_SEARCH_JOBS: "1",
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      PORT: String(port),
      SEARCH_TODAY_OVERRIDE: process.env.SEARCH_TODAY_OVERRIDE ?? "2026-03-31",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout.on("data", appendLogs);
  child.stderr.on("data", appendLogs);

  try {
    await waitForExternalServer(baseUrl, child, () => logs);
  } catch (error) {
    await stopExternalServer(child);
    throw error;
  }

  return {
    baseUrl,
    stop: () => stopExternalServer(child),
  };
}

async function listenOnTestServer(): Promise<ServerHandle> {
  return process.env.FLY_DESK_TEST_SERVER_MODE === "in-process"
    ? listenOnInProcessBunServer()
    : listenOnExternalBunServer();
}

export async function withServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const previousSearchTodayOverride = process.env.SEARCH_TODAY_OVERRIDE;
  const previousBackgroundSearchJobs = process.env.FLY_DESK_DISABLE_BACKGROUND_SEARCH_JOBS;
  process.env.SEARCH_TODAY_OVERRIDE = previousSearchTodayOverride ?? "2026-03-31";
  process.env.FLY_DESK_DISABLE_BACKGROUND_SEARCH_JOBS = "1";
  const server = await listenOnTestServer();

  try {
    return await run(server.baseUrl);
  } finally {
    try {
      await server.stop();
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
