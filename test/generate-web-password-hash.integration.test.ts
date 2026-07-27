import { test } from "bun:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/generate-web-password-hash.ts", import.meta.url));

async function runGenerator(options: {
  args?: string[];
  stdin?: string;
  passwordEnvironment?: string;
} = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = { ...process.env };
  delete env.FLY_DESK_WEB_PASSWORD;
  if (options.passwordEnvironment !== undefined) {
    env.FLY_DESK_WEB_PASSWORD = options.passwordEnvironment;
  }

  const child = Bun.spawn(
    [process.execPath, "--no-env-file", script, ...(options.args ?? [])],
    {
      env,
      stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("password hash generator reads piped stdin without echoing plaintext", async () => {
  const secret = "stdin-only-password";
  const result = await runGenerator({ stdin: `${secret}\n` });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout.trim(), /^scrypt:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret));
});

test("password hash generator rejects plaintext argv", async () => {
  const secret = "argv-password-must-not-leak";
  const result = await runGenerator({ args: [secret] });

  assert.notEqual(result.exitCode, 0);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret));
});

test("password hash generator rejects plaintext password environment input", async () => {
  const secret = "environment-password-must-not-leak";
  const result = await runGenerator({ passwordEnvironment: secret });

  assert.notEqual(result.exitCode, 0);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret));
});
