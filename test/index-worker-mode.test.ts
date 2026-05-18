import { test } from "bun:test";
import assert from "node:assert/strict";

test("index worker mode runs the provider worker instead of starting the HTTP server", async () => {
  const child = Bun.spawn([process.execPath, "src/index.ts", "--fly-desk-worker"], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NODE_ENV: "test",
    },
  });

  child.stdin.write(new TextEncoder().encode("not-json\n"));
  child.stdin.end();

  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), 5000);
  });
  const exited = await Promise.race([child.exited, timeout]);
  if (exited === "timeout") {
    child.kill();
    assert.fail("worker mode did not exit after stdin closed");
  }

  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  assert.equal(exited, 0, stderr);
  const messages = stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id?: string; type?: string; message?: string });

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.id, "unknown");
  assert.equal(messages[0]?.type, "error");
});
