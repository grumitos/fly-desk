import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";

const rootDir = resolve(import.meta.dirname, "..");

/* Each UI file owns its harness (`registerDesktopHarness`), so `node --test`
   can run them as independent processes side by side. Sorted, so a failing
   run always names the files in the same order. */
const testFiles = readdirSync(resolve(rootDir, "test", "ui"))
  .filter((name) => name.endsWith(".playwright.ts"))
  .sort()
  .map((name) => `test/ui/${name}`);

if (testFiles.length === 0) {
  throw new Error("No test/ui/*.playwright.ts files to run.");
}

function resolveConcurrency(): number {
  const configured = Number(process.env.FLY_DESK_UI_TEST_CONCURRENCY?.trim() || "");
  if (Number.isInteger(configured) && configured > 0) {
    return configured;
  }

  /* One core is left to the parent process and to the Bun test servers the
     children spawn; each worker also drives a headless Chromium of its own.
     The cap is what a worker really costs: a browser and a server are several
     processes each, and past four of them the machine, not the suite, is what
     the timings measure. */
  return Math.max(1, Math.min(testFiles.length, availableParallelism() - 1, 4));
}

const result = spawnSync(
  "node",
  [
    "--test",
    "--test-timeout=60000",
    "--test-reporter=spec",
    `--test-concurrency=${resolveConcurrency()}`,
    ...process.argv.slice(2),
    ...testFiles,
  ],
  {
    cwd: rootDir,
    env: {
      ...process.env,
      BUN_EXECUTABLE_PATH: process.execPath,
      NODE_ENV: "test",
    },
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
