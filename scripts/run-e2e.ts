import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, join, resolve } from "node:path";

/*
 * Runs the end-to-end suite: every `test/e2e/*.e2e.ts` file in its own
 * `bun test` process, several at once. Each file starts its own fake
 * upstream, service stack and browser, so files share nothing but the
 * machine; the tests inside a file run one after another.
 *
 *   bun scripts/run-e2e.ts [spec files…] [-- bun test options…]
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

/* The same Bun runs each file and the stack each file starts. */
const bunExecutable = process.env.BUN_EXECUTABLE_PATH?.trim()
  || (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? process.execPath : "bun");

interface FileResult {
  file: string;
  exitCode: number;
  wallMs: number;
  counts: Record<"tests" | "pass" | "fail" | "todo" | "skip" | "error", number>;
}

/* The totals `bun test` prints last: " 3 pass", " 1 todo", "Ran 4 tests across 1 file." */
function readCounts(output: string): FileResult["counts"] {
  const last = (pattern: RegExp) => Number([...output.matchAll(pattern)].at(-1)?.[1] ?? 0);
  const count = (label: string) => last(new RegExp(`^ *(\\d+) ${label}s?$`, "gm"));
  return {
    tests: last(/^Ran (\d+) tests? across/gm),
    pass: count("pass"),
    fail: count("fail"),
    todo: count("todo"),
    skip: count("skip"),
    error: count("error"),
  };
}

function runFile(file: string): Promise<FileResult> {
  const startedAt = Date.now();
  return new Promise((resolveRun) => {
    const child = spawn(bunExecutable, [
      "test",
      /* A test marked todo runs: its failure counts as a known gap, and its
         pass fails the file until the mark comes off. */
      "--todo",
      /* A name pattern that matches nothing in this file leaves it nothing to run. */
      "--pass-with-no-tests",
      /* The file's stack and browser go with it if this runner dies. */
      "--no-orphans",
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
  const concurrency = resolveConcurrency();
  const startedAt = Date.now();
  process.stdout.write(`Running ${specFiles.length} end-to-end files, ${concurrency} at a time.\n`);

  const queue = [...specFiles];
  const results: FileResult[] = [];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      results.push(await runFile(file));
    }
  }));

  const totalMs = Date.now() - startedAt;
  const rows = [...results].sort((left, right) => left.file.localeCompare(right.file));
  const width = Math.max(...rows.map((row) => basename(row.file).length));
  process.stdout.write("\nEnd-to-end summary\n");
  for (const row of rows) {
    const { tests, pass, fail, todo, skip, error } = row.counts;
    process.stdout.write(
      `  ${basename(row.file).padEnd(width)}  ${(row.wallMs / 1000).toFixed(1).padStart(6)} s  `
      + `${pass}/${tests} passed${todo ? `, ${todo} known gap${todo === 1 ? "" : "s"}` : ""}`
      + `${skip ? `, ${skip} skipped` : ""}${fail ? `, ${fail} FAILED` : ""}`
      + `${error ? `, ${error} error${error === 1 ? "" : "s"}` : ""}${row.exitCode !== 0 ? `  (exit ${row.exitCode})` : ""}\n`,
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
