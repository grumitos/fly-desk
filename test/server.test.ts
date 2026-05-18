import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest, resolveServerIdleTimeoutSeconds } from "../src/server";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempPublicDir(): string {
  const root = mkdtempSync(join(tmpdir(), "flydesk-public-dir-"));
  tempRoots.push(root);
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(
    join(root, "index.html"),
    "<html><head><!-- __FLYDESK_RUNTIME_CONFIG__ --></head><body>release public dir</body></html>",
  );
  writeFileSync(join(root, "assets", "app.js"), "console.log('release asset');");
  return root;
}

async function withPublicDir<T>(publicDir: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.FLY_DESK_PUBLIC_DIR;
  process.env.FLY_DESK_PUBLIC_DIR = publicDir;

  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.FLY_DESK_PUBLIC_DIR;
    } else {
      process.env.FLY_DESK_PUBLIC_DIR = previous;
    }
  }
}

test("server idle timeout defaults above Bun's short request timeout", () => {
  assert.equal(resolveServerIdleTimeoutSeconds(undefined), 120);
  assert.equal(resolveServerIdleTimeoutSeconds("not-a-number"), 120);
  assert.equal(resolveServerIdleTimeoutSeconds("999"), 255);
  assert.equal(resolveServerIdleTimeoutSeconds("0"), 0);
  assert.equal(resolveServerIdleTimeoutSeconds("45"), 45);
});

test("server serves frontend assets from FLY_DESK_PUBLIC_DIR when set", async () => {
  const publicDir = makeTempPublicDir();

  await withPublicDir(publicDir, async () => {
    const indexResponse = await handleRequest(
      new Request("http://127.0.0.1/"),
      {} as never,
    );
    assert.equal(indexResponse.status, 200);
    assert.match(await indexResponse.text(), /release public dir/);

    const assetResponse = await handleRequest(
      new Request("http://127.0.0.1/assets/app.js"),
      {} as never,
    );
    assert.equal(assetResponse.status, 200);
    assert.equal(await assetResponse.text(), "console.log('release asset');");
  });
});
