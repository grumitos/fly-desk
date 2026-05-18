import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeFile(path: string, content = "x"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function expandZip(zipPath: string, destination: string): void {
  const result = Bun.spawnSync([
    "powershell.exe",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Expand-Archive -LiteralPath ${powershellQuote(zipPath)} -DestinationPath ${powershellQuote(destination)} -Force`,
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });

  assert.equal(
    result.exitCode,
    0,
    `${result.stdout.toString()}\n${result.stderr.toString()}`,
  );
}

function listRelativeFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort();
}

test("release package contains only the runtime release tree", () => {
  const projectRoot = makeTempRoot("flydesk-package-root-");
  const outputRoot = makeTempRoot("flydesk-package-out-");
  const extractRoot = makeTempRoot("flydesk-package-extract-");

  writeFileSync(
    join(projectRoot, "package.json"),
    JSON.stringify({ name: "fly-desk", version: "0.3.0" }),
  );
  writeFile(join(projectRoot, "bin", "fly-desk.exe"), "fake executable");
  writeFile(join(projectRoot, "frontend", "dist", "index.html"), "<title>Fly Desk</title>");
  writeFile(join(projectRoot, "frontend", "dist", "assets", "app.js"), "console.log('ok')");

  for (const excludedPath of [
    ".env",
    ".git/config",
    "src/index.ts",
    "test/server.test.ts",
    "node_modules/pkg/index.js",
    "output/cache.sqlite",
    ".launcher/state.json",
    "tools/start-fly-desk.ps1",
  ]) {
    writeFile(join(projectRoot, excludedPath), "must not ship");
  }

  const result = Bun.spawnSync([
    process.execPath,
    "scripts/package-release.ts",
    "--root",
    projectRoot,
    "--out",
    outputRoot,
  ], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });

  assert.equal(
    result.exitCode,
    0,
    `${result.stdout.toString()}\n${result.stderr.toString()}`,
  );

  const zipPath = join(outputRoot, "fly-desk-windows-x64-v0.3.0.zip");
  assert.ok(existsSync(zipPath), `missing ${basename(zipPath)}`);

  expandZip(zipPath, extractRoot);

  const files = listRelativeFiles(extractRoot);
  assert.deepEqual(files, [
    "fly-desk-release/bin/fly-desk.exe",
    "fly-desk-release/frontend/dist/assets/app.js",
    "fly-desk-release/frontend/dist/index.html",
    "fly-desk-release/release.json",
  ]);

  const releaseJson = JSON.parse(
    readFileSync(join(extractRoot, "fly-desk-release", "release.json"), "utf8"),
  );
  assert.equal(releaseJson.schemaVersion, 1);
  assert.equal(releaseJson.appId, "fly-desk");
  assert.equal(releaseJson.version, "0.3.0");
  assert.equal(releaseJson.platform, "windows-x64");
});

test("configured executable build script compiles the Bun Windows release binary", () => {
  const outputRoot = makeTempRoot("flydesk-exe-out-");
  const result = Bun.spawnSync([
    process.execPath,
    "run",
    "build:exe",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FLY_DESK_EXE_OUTFILE: join(outputRoot, "fly-desk.exe"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  assert.equal(
    result.exitCode,
    0,
    `${result.stdout.toString()}\n${result.stderr.toString()}`,
  );
  assert.ok(existsSync(join(outputRoot, "fly-desk.exe")));
});
