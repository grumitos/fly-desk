import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, join, resolve } from "node:path";

/*
 * Runs the end-to-end suite: every `test/e2e/*.e2e.ts` file in its own
 * `node --test` process, several at once. Each file starts its own fake
 * upstream, service stack and browser, so files share nothing but the
 * machine; the tests inside a file run one after another.
 *
 *   bun scripts/run-e2e.ts [spec files…] [-- node --test options…]
 *
 * FLY_DESK_E2E_CONCURRENCY sets how many files run at once (default: one less
 * than the cores, at most three). FLY_DESK_TEST_BROWSER_CHANNEL picks the
 * browser (`chrome` in CI; the installed Playwright Chromium otherwise). A
 * failing test leaves screenshots, service logs and the fake's request log in
 * test-results/e2e/<spec>/<test>/.
 */

const rootDir = resolve(import.meta.dirname, "..");
const specDir = join(rootDir, "test", "e2e");
const resultsDir = join(rootDir, "test-results", "e2e");
/* The harness gives each test three minutes; this only catches a test that
   never reaches its own timeout. */
const TEST_TIMEOUT_MS = 300_000;

const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
const requested = (separator >= 0 ? argv.slice(0, separator) : argv).filter((arg) => !arg.startsWith("-"));
const passthrough = separator >= 0 ? argv.slice(separator + 1) : argv.filter((arg) => arg.startsWith("-"));

const specFiles = (requested.length > 0
  ? requested.map((file) => resolve(rootDir, file))
  : readdirSync(specDir).filter((name) => name.endsWith(".e2e.ts")).sort().map((name) => join(specDir, name)));
for (const file of specFiles) {
  if (!existsSync(file)) {
    throw new Error(`No such spec file: ${file}`);
  }
}
if (specFiles.length === 0) {
  throw new Error("No test/e2e/*.e2e.ts files to run.");
}
if (!existsSync(join(rootDir, "frontend", "dist", "index.html"))) {
  throw new Error("frontend/dist is missing: run `bun run build` first (`bun run test:e2e` does).");
}

function resolveConcurrency(): number {
  const configured = Number(process.env.FLY_DESK_E2E_CONCURRENCY?.trim() || "");
  if (Number.isInteger(configured) && configured > 0) {
    return Math.min(configured, specFiles.length);
  }
  return Math.max(1, Math.min(3, availableParallelism() - 1, specFiles.length));
}

/* Node strips TypeScript types on its own from 22.18; before that it needs the flag. */
function nodeTypeFlags(): string[] {
  const version = spawnSync("node", ["--version"], { encoding: "utf8" }).stdout.trim();
  const match = /^v(\d+)\.(\d+)/.exec(version);
  if (!match) {
    throw new Error(`Cannot read the Node version (${version || "node not found"}).`);
  }
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major < 22 || (major === 22 && minor < 6)) {
    throw new Error(`The end-to-end suite needs Node 22.6 or later; found ${version}.`);
  }
  return major === 22 && minor < 18
    ? ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"]
    : [];
}

/* The stack spawns Bun; when this runner is Bun itself, that is the one to use. */
const bunExecutable = process.env.BUN_EXECUTABLE_PATH?.trim()
  || (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? process.execPath : "bun");

interface FileResult {
  file: string;
  exitCode: number;
  wallMs: number;
  counts: Record<"tests" | "pass" | "fail" | "todo" | "cancelled" | "skipped", number>;
}

function readCounts(output: string): FileResult["counts"] {
  const count = (label: string) => Number(new RegExp(`^ℹ ${label} (\\d+)$`, "m").exec(output)?.[1] ?? 0);
  return {
    tests: count("tests"),
    pass: count("pass"),
    fail: count("fail"),
    todo: count("todo"),
    cancelled: count("cancelled"),
    skipped: count("skipped"),
  };
}

function runFile(file: string, typeFlags: string[]): Promise<FileResult> {
  const startedAt = Date.now();
  return new Promise((resolveRun) => {
    const child = spawn("node", [
      ...typeFlags,
      "--test",
      "--test-reporter=spec",
      `--test-timeout=${TEST_TIMEOUT_MS}`,
      ...passthrough,
      file,
    ], {
      cwd: rootDir,
      env: { ...process.env, BUN_EXECUTABLE_PATH: bunExecutable, FORCE_COLOR: process.env.FORCE_COLOR ?? "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      const result: FileResult = {
        file,
        exitCode: code ?? 1,
        wallMs: Date.now() - startedAt,
        counts: readCounts(output),
      };
      /* One file's report at a time, whole, so parallel files never interleave. */
      process.stdout.write(`\n━━ ${basename(file)} · ${(result.wallMs / 1000).toFixed(1)} s · exit ${result.exitCode}\n${output}`);
      resolveRun(result);
    });
  });
}

async function main(): Promise<void> {
  rmSync(resultsDir, { recursive: true, force: true });
  const typeFlags = nodeTypeFlags();
  const concurrency = resolveConcurrency();
  const startedAt = Date.now();
  process.stdout.write(`Running ${specFiles.length} end-to-end files, ${concurrency} at a time.\n`);

  const queue = [...specFiles];
  const results: FileResult[] = [];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      results.push(await runFile(file, typeFlags));
    }
  }));

  const totalMs = Date.now() - startedAt;
  const rows = [...results].sort((left, right) => left.file.localeCompare(right.file));
  const width = Math.max(...rows.map((row) => basename(row.file).length));
  process.stdout.write("\nEnd-to-end summary\n");
  for (const row of rows) {
    const { tests, pass, fail, todo, cancelled } = row.counts;
    process.stdout.write(
      `  ${basename(row.file).padEnd(width)}  ${(row.wallMs / 1000).toFixed(1).padStart(6)} s  `
      + `${pass}/${tests} passed${todo ? `, ${todo} known gap${todo === 1 ? "" : "s"}` : ""}`
      + `${fail ? `, ${fail} FAILED` : ""}${cancelled ? `, ${cancelled} cancelled` : ""}${row.exitCode !== 0 ? `  (exit ${row.exitCode})` : ""}\n`,
    );
  }
  process.stdout.write(`  ${"total wall time".padEnd(width)}  ${(totalMs / 1000).toFixed(1).padStart(6)} s\n`);

  const failed = rows.filter((row) => row.exitCode !== 0);
  if (failed.length > 0) {
    process.stdout.write(`\nFailures left their screenshots and logs in ${resultsDir}\n`);
    process.exitCode = 1;
  }
}

await main();
