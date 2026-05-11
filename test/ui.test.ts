import { test } from "bun:test";
import assert from "node:assert/strict";

test("Playwright UI suite", async () => {
  const child = Bun.spawn(["node", "--test", "test/ui.playwright.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BUN_EXECUTABLE_PATH: process.execPath,
      NODE_ENV: "test",
    },
    stderr: "pipe",
    stdout: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");

  assert.equal(exitCode, 0, output);
});
