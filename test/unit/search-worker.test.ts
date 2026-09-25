import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * The pooled search worker, started the way the runner starts it, against a
 * Chrome that answers only the DevTools calls the worker makes. The end-to-end
 * stack never opens a tab, so this is where a stop in the middle of one is
 * seen.
 */

const repoRoot = join(import.meta.dir, "..", "..");
const HOST_ENV = ["PATH", "SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "LANG", "TZ"];

/* Opens tabs whose pages never finish loading, so a tab stays open until closed. */
function startFakeChrome() {
  const closed: string[] = [];
  let reportNavigation!: (targetId: string) => void;
  const navigated = new Promise<string>((resolve) => {
    reportNavigation = resolve;
  });
  let targets = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, server) => (server.upgrade(request) ? undefined : new Response("Not found", { status: 404 })),
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(String(raw)) as { id: number; method: string; params?: { targetId?: string } };
        const reply = (result: unknown) => socket.send(JSON.stringify({ id: message.id, result }));
        switch (message.method) {
          case "Target.createTarget":
            targets += 1;
            reply({ targetId: `target-${targets}` });
            return;
          case "Target.attachToTarget":
            reply({ sessionId: `session-${message.params?.targetId}` });
            return;
          case "Page.enable":
          case "Runtime.enable":
            reply({});
            return;
          case "Page.navigate":
            reply({ frameId: "frame" });
            reportNavigation(`target-${targets}`);
            return;
          case "Target.closeTarget":
            closed.push(String(message.params?.targetId));
            reply({ success: true });
            return;
          default:
            /* Playwright's handshake: refused, so the worker uses its own client. */
            socket.close(1011, "not a browser");
        }
      },
    },
  });
  return {
    endpoint: `ws://127.0.0.1:${server.port}/devtools/browser/fake`,
    navigated,
    closed,
    stop: () => server.stop(true),
  };
}

describe("search worker", () => {
  /* Windows has no signal a process can catch: a kill there is TerminateProcess. */
  test.skipIf(process.platform === "win32")("closes the tab it has open in the shared Chrome when it is stopped", async () => {
    const chrome = startFakeChrome();
    const home = mkdtempSync(join(tmpdir(), "fly-desk-unit-worker-"));
    const hostEnv = Object.fromEntries(HOST_ENV.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
    const worker = Bun.spawn([process.execPath, "--no-env-file", join(repoRoot, "src", "search-worker.ts")], {
      cwd: repoRoot,
      env: {
        ...hostEnv,
        HOME: home,
        TMPDIR: home,
        NODE_ENV: "test",
        /* No stored Agil identity, so the session is read from Chrome. */
        AGIL_BROWSER_WS_ENDPOINT: chrome.endpoint,
        AGIL_BROWSER_CONNECT_TIMEOUT_MS: "1000",
        AGIL_CHROME_PROCESS_DISCOVERY: "0",
        AGIL_RAW_CHROME_STORAGE_FILE_SCAN: "0",
        AGIL_TEMP_CHROME_STORAGE_FALLBACK: "0",
        AGIL_CHROME_USER_DATA_DIR: home,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      worker.stdin.write(`${JSON.stringify({ id: "prewarm-1", type: "prewarm", providerId: "agil-local" })}\n`);
      worker.stdin.flush();
      const target = await Promise.race([chrome.navigated, Bun.sleep(15_000).then(() => "no tab opened")]);
      expect(target).toBe("target-1");

      worker.kill("SIGTERM");
      const exitCode = await Promise.race([worker.exited, Bun.sleep(5_000).then(() => "still running")]);
      expect(chrome.closed).toEqual(["target-1"]);
      expect(exitCode).toBe(0);
    } finally {
      worker.kill("SIGKILL");
      chrome.stop();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
