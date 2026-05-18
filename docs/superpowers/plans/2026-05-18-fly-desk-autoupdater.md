# Fly Desk Autoupdater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-folder autoupdater for Fly Desk so users keep the same shortcut and install directory while receiving releases without Git, GitHub login, or the maintainer's credentials on their computer.

**Architecture:** Keep `grumitos/fly-desk` private. Publish user-facing release zips to a separate public update channel, recommended name `grumitos/fly-desk-updates`, containing only distributable runtime files. The local launcher checks a public manifest, downloads a zip, verifies SHA-256, stages the update, preserves local state, swaps files, then launches Fly Desk.

**Tech Stack:** PowerShell launcher/updater, Bun build/compile, GitHub CLI, GitHub Actions, GitHub Releases, public JSON manifest.

---

## Current Context

- Local repo: `C:\fly-desk`
- GitHub repo: `grumitos/fly-desk`
- Repo visibility checked with `gh repo view`: `PRIVATE`
- Default branch: `main`
- Existing release workflow: none; `.github/` is not present
- Existing releases: none from `gh release list`
- Local branch status when this plan was written: `main...origin/main [behind 4]`
- Launcher today: `Abrir Fly Desk.vbs` -> `tools/start-fly-desk.ps1`
- Launcher today already attempts Git updates, but recent logs show `No se pudo confirmar repositorio Git; se omite actualizacion.`

## Distribution Decision

The user's computer must not need GitHub authentication. A private GitHub Release cannot be the direct update source for an unauthenticated user. The update channel must expose the installable artifact publicly or through a non-GitHub access layer.

Recommended release channel:

- Private source repo: `grumitos/fly-desk`
- Public update repo: `grumitos/fly-desk-updates`
- Public manifest URL: `https://raw.githubusercontent.com/grumitos/fly-desk-updates/main/latest.json`
- Public release zip URL pattern: `https://github.com/grumitos/fly-desk-updates/releases/download/vX.Y.Z/fly-desk-windows-x64-vX.Y.Z.zip`

The public artifact should not contain `.git`, `.env`, `src/`, `test/`, or raw development files. It should contain the compiled runtime, compiled frontend assets, launcher scripts, icon, stop script, and release metadata.

## File Structure

### Create

- `.github/workflows/release.yml`
  - Manual release workflow for building the Windows package and publishing it to `grumitos/fly-desk-updates`.
- `docs/UPDATE_CHANNEL.md`
  - Human-readable release/update operating guide.
- `scripts/package-release.ts`
  - Creates the release staging directory, copies distributable files, writes release metadata, zips the package, and prints SHA-256.
- `tools/update-fly-desk.ps1`
  - Small updater invoked by `tools/start-fly-desk.ps1`; owns manifest fetch, zip download, hash verification, staging, backup, swap, rollback, and state preservation.
- `test/release-package.test.ts`
  - Verifies the release package excludes source/private files and includes required runtime files.

### Modify

- `package.json`
  - Add scripts for binary build and release packaging.
- `src/index.ts`
  - Add `--fly-desk-worker` mode so the packaged executable can act as the search worker entrypoint.
- `src/search-worker-client.ts`
  - Allow worker child processes to run either from `src/search-worker.ts` in dev mode or from the packaged executable in release mode.
- `test/search-worker-client.test.ts`
  - Add tests for packaged worker command resolution.
- `tools/start-fly-desk.ps1`
  - Replace Git update behavior with manifest updater behavior for user installs.
  - Keep Bun/source fallback for development installs.
- `README.md`
  - Document user-facing update behavior and maintainer release steps.

## Release Artifact Layout

The zip should extract into the install root and keep the existing shortcut model:

```text
fly-desk/
  Abrir Fly Desk.vbs
  Cerrar Fly Desk.vbs
  Abrir Fly Desk.ico
  VERSION
  release.json
  bin/
    fly-desk.exe
  frontend/
    dist/
      index.html
      assets/
  tools/
    start-fly-desk.ps1
    stop-fly-desk.ps1
    update-fly-desk.ps1
```

The updater must preserve these local paths during every update:

```text
.env
.launcher/
output/
artifacts/
```

It must ignore or remove release-owned paths before replacement:

```text
bin/
frontend/dist/
tools/start-fly-desk.ps1
tools/stop-fly-desk.ps1
tools/update-fly-desk.ps1
Abrir Fly Desk.vbs
Cerrar Fly Desk.vbs
Abrir Fly Desk.ico
VERSION
release.json
```

## Manifest Contract

`latest.json` in `grumitos/fly-desk-updates`:

```json
{
  "schemaVersion": 1,
  "appId": "fly-desk",
  "channel": "stable",
  "version": "0.2.0",
  "publishedAt": "2026-05-18T00:00:00Z",
  "platforms": {
    "windows-x64": {
      "url": "https://github.com/grumitos/fly-desk-updates/releases/download/v0.2.0/fly-desk-windows-x64-v0.2.0.zip",
      "sha256": "64 lowercase hex characters",
      "sizeBytes": 12345678
    }
  },
  "minimumLauncherVersion": "1.0.0",
  "notes": "Stability fixes and updater bootstrap."
}
```

The updater must reject:

- missing `schemaVersion`
- wrong `appId`
- missing `platforms.windows-x64.url`
- missing or malformed `platforms.windows-x64.sha256`
- local version greater than manifest version
- unsupported `minimumLauncherVersion`

## Task 0: Prepare The Development Branch

**Files:**
- Modify: none

- [ ] **Step 1: Sync local `main` with `origin/main`**

Run:

```powershell
git switch main
git pull --ff-only origin main
```

Expected:

```text
Updating ...
Fast-forward
```

- [ ] **Step 2: Create an implementation branch**

Run:

```powershell
git switch -c codex/fly-desk-autoupdater
```

Expected:

```text
Switched to a new branch 'codex/fly-desk-autoupdater'
```

- [ ] **Step 3: Confirm the baseline test suite**

Run:

```powershell
bun run typecheck
bun run lint
bun run build
bun test --timeout=600000 ./test/**/*.test.ts
```

Expected: all commands exit `0`.

- [ ] **Step 4: Commit no changes**

Run:

```powershell
git status -sb
```

Expected: branch is clean before implementation.

## Task 1: Add Release Package Tests

**Files:**
- Create: `test/release-package.test.ts`

- [ ] **Step 1: Write the failing package-shape tests**

Create `test/release-package.test.ts` with:

```ts
import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = join(import.meta.dir, "..");

function makeTempDir(name: string): string {
  const dir = join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("release package includes runtime files and excludes private source files", () => {
  const outputDir = makeTempDir("fly-desk-release-test");

  try {
    const result = spawnSync(process.execPath, [
      "scripts/package-release.ts",
      "--version",
      "9.9.9-test",
      "--output-dir",
      outputDir,
      "--skip-binary-build",
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        FLY_DESK_TEST_FAKE_BINARY: "1",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const packageRoot = join(outputDir, "fly-desk");
    assert.equal(existsSync(join(packageRoot, "Abrir Fly Desk.vbs")), true);
    assert.equal(existsSync(join(packageRoot, "Cerrar Fly Desk.vbs")), true);
    assert.equal(existsSync(join(packageRoot, "tools", "start-fly-desk.ps1")), true);
    assert.equal(existsSync(join(packageRoot, "tools", "stop-fly-desk.ps1")), true);
    assert.equal(existsSync(join(packageRoot, "tools", "update-fly-desk.ps1")), true);
    assert.equal(existsSync(join(packageRoot, "bin", "fly-desk.exe")), true);
    assert.equal(existsSync(join(packageRoot, "frontend", "dist", "index.html")), true);
    assert.equal(existsSync(join(packageRoot, "VERSION")), true);
    assert.equal(existsSync(join(packageRoot, "release.json")), true);

    assert.equal(existsSync(join(packageRoot, ".git")), false);
    assert.equal(existsSync(join(packageRoot, ".env")), false);
    assert.equal(existsSync(join(packageRoot, "src")), false);
    assert.equal(existsSync(join(packageRoot, "test")), false);
    assert.equal(existsSync(join(packageRoot, "node_modules")), false);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("release package preserves explicit release metadata", () => {
  const outputDir = makeTempDir("fly-desk-release-metadata-test");

  try {
    const result = spawnSync(process.execPath, [
      "scripts/package-release.ts",
      "--version",
      "1.2.3",
      "--output-dir",
      outputDir,
      "--skip-binary-build",
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        FLY_DESK_TEST_FAKE_BINARY: "1",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const metadataPath = join(outputDir, "fly-desk", "release.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
      appId: string;
      version: string;
      platform: string;
    };

    assert.deepEqual(metadata, {
      appId: "fly-desk",
      version: "1.2.3",
      platform: "windows-x64",
    });
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
bun test test/release-package.test.ts
```

Expected: FAIL because `scripts/package-release.ts` does not exist.

- [ ] **Step 3: Commit the failing test**

Run:

```powershell
git add test/release-package.test.ts
git commit -m "test: define release package shape"
```

Expected: commit succeeds.

## Task 2: Add Release Packaging Script

**Files:**
- Create: `tools/update-fly-desk.ps1`
- Create: `scripts/package-release.ts`
- Modify: `package.json`

- [ ] **Step 1: Create the updater entrypoint**

Create `tools/update-fly-desk.ps1` with this initial script:

```powershell
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

param(
  [string]$InstallRoot,
  [string]$ManifestUrl = "https://raw.githubusercontent.com/grumitos/fly-desk-updates/main/latest.json",
  [switch]$CheckOnly
)

Write-Output "Fly Desk updater entrypoint is installed."
```

Task 5 replaces this entrypoint with the full updater behavior.

- [ ] **Step 2: Add package scripts**

Modify `package.json` scripts to include:

```json
{
  "build:binary": "bun build --compile --target=bun-windows-x64 --windows-icon=\"Abrir Fly Desk.ico\" src/index.ts --outfile dist/fly-desk.exe",
  "package:release": "bun scripts/package-release.ts"
}
```

- [ ] **Step 3: Create `scripts/package-release.ts`**

Create `scripts/package-release.ts` with:

```ts
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

interface Options {
  version: string;
  outputDir: string;
  skipBinaryBuild: boolean;
}

const repoRoot = resolve(import.meta.dir, "..");

function readPackageVersion(): string {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version?: string };
  if (!packageJson.version) {
    throw new Error("package.json is missing version.");
  }
  return packageJson.version;
}

function parseArgs(argv: string[]): Options {
  let version = "";
  let outputDir = join(repoRoot, "artifacts", "release");
  let skipBinaryBuild = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--version") {
      version = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--output-dir") {
      outputDir = resolve(argv[index + 1] ?? "");
      index += 1;
    } else if (arg === "--skip-binary-build") {
      skipBinaryBuild = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    version: version || readPackageVersion(),
    outputDir,
    skipBinaryBuild,
  };
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
  }
}

function ensureBuiltFrontend(): void {
  run("bun", ["run", "build"]);
}

function ensureBuiltBinary(skipBinaryBuild: boolean): void {
  const binaryPath = join(repoRoot, "dist", "fly-desk.exe");
  if (skipBinaryBuild) {
    mkdirSync(join(repoRoot, "dist"), { recursive: true });
    if (!existsSync(binaryPath)) {
      writeFileSync(binaryPath, "fake binary for release packaging tests");
    }
    return;
  }

  run("bun", ["run", "build:binary"]);
}

function copyRequiredFile(from: string, to: string): void {
  if (!existsSync(from)) {
    throw new Error(`Required release input does not exist: ${from}`);
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

function copyRequiredDirectory(from: string, to: string): void {
  if (!existsSync(from)) {
    throw new Error(`Required release input does not exist: ${from}`);
  }
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

function zipDirectory(sourceDir: string, zipPath: string): void {
  rmSync(zipPath, { force: true });
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "Compress-Archive -Path fly-desk -DestinationPath $args[0] -Force",
    zipPath,
  ], {
    cwd: sourceDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Compress-Archive failed: ${result.stdout}\n${result.stderr}`);
  }
}

function sha256File(filePath: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const packageRoot = join(options.outputDir, "fly-desk");
  const zipName = `fly-desk-windows-x64-v${options.version}.zip`;
  const zipPath = join(options.outputDir, zipName);

  rmSync(packageRoot, { recursive: true, force: true });
  mkdirSync(packageRoot, { recursive: true });

  ensureBuiltFrontend();
  ensureBuiltBinary(options.skipBinaryBuild);

  copyRequiredFile(join(repoRoot, "Abrir Fly Desk.vbs"), join(packageRoot, "Abrir Fly Desk.vbs"));
  copyRequiredFile(join(repoRoot, "Cerrar Fly Desk.vbs"), join(packageRoot, "Cerrar Fly Desk.vbs"));
  copyRequiredFile(join(repoRoot, "Abrir Fly Desk.ico"), join(packageRoot, "Abrir Fly Desk.ico"));
  copyRequiredFile(join(repoRoot, "tools", "start-fly-desk.ps1"), join(packageRoot, "tools", "start-fly-desk.ps1"));
  copyRequiredFile(join(repoRoot, "tools", "stop-fly-desk.ps1"), join(packageRoot, "tools", "stop-fly-desk.ps1"));
  copyRequiredFile(join(repoRoot, "tools", "update-fly-desk.ps1"), join(packageRoot, "tools", "update-fly-desk.ps1"));
  copyRequiredFile(join(repoRoot, "dist", "fly-desk.exe"), join(packageRoot, "bin", "fly-desk.exe"));
  copyRequiredDirectory(join(repoRoot, "frontend", "dist"), join(packageRoot, "frontend", "dist"));

  writeFileSync(join(packageRoot, "VERSION"), `${options.version}\n`);
  writeFileSync(join(packageRoot, "release.json"), `${JSON.stringify({
    appId: "fly-desk",
    version: options.version,
    platform: "windows-x64",
  }, null, 2)}\n`);

  zipDirectory(options.outputDir, zipPath);
  const sha256 = sha256File(zipPath);
  const sizeBytes = statSync(zipPath).size;

  console.log(JSON.stringify({
    version: options.version,
    zipPath,
    zipName: basename(zipPath),
    sha256,
    sizeBytes,
  }, null, 2));
}

await main();
```

- [ ] **Step 4: Run package tests**

Run:

```powershell
bun test test/release-package.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit packaging script**

Run:

```powershell
git add package.json scripts/package-release.ts tools/update-fly-desk.ps1 test/release-package.test.ts
git commit -m "feat: package Fly Desk release artifact"
```

Expected: commit succeeds.

## Task 3: Make The Executable Support Worker Mode

**Files:**
- Modify: `src/index.ts`
- Modify: `src/search-worker-client.ts`
- Modify: `test/search-worker-client.test.ts`

- [ ] **Step 1: Add worker command tests**

Modify `test/search-worker-client.test.ts` imports:

```ts
import {
  resolveSearchWorkerBunExecutableForTests,
  resolveSearchWorkerCommandForTests,
  runProviderSearchInWorker,
} from "../src/search-worker-client";
```

Add:

```ts
test("packaged search workers run through the Fly Desk executable when source worker is absent", () => {
  const command = resolveSearchWorkerCommandForTests({
    env: {},
    execPath: "C:\\fly-desk\\bin\\fly-desk.exe",
    platform: "win32",
    workerPath: undefined,
    exists: () => false,
  });

  assert.deepEqual(command, [
    "C:\\fly-desk\\bin\\fly-desk.exe",
    "--fly-desk-worker",
  ]);
});

test("development search workers prefer Bun plus src search worker when the source worker exists", () => {
  const workerPath = "C:\\fly-desk\\src\\search-worker.ts";
  const command = resolveSearchWorkerCommandForTests({
    env: {
      BUN_EXECUTABLE_PATH: "C:\\Users\\agent\\.bun\\bin\\bun.exe",
    },
    execPath: "C:\\Users\\agent\\.bun\\bin\\bun.exe",
    platform: "win32",
    workerPath,
    exists: (path) => path === workerPath,
  });

  assert.deepEqual(command, [
    "C:\\Users\\agent\\.bun\\bin\\bun.exe",
    workerPath,
  ]);
});
```

- [ ] **Step 2: Run failing worker tests**

Run:

```powershell
bun test test/search-worker-client.test.ts
```

Expected: FAIL because `resolveSearchWorkerCommandForTests` does not exist.

- [ ] **Step 3: Modify `src/index.ts`**

Replace the final line:

```ts
void main();
```

with:

```ts
if (process.argv.includes("--fly-desk-worker")) {
  await import("./search-worker");
} else {
  void main();
}
```

- [ ] **Step 4: Modify `src/search-worker-client.ts`**

Ensure the imports use this exact pair:

```ts
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
```

Add this interface near `BunExecutableResolverOptions`:

```ts
interface WorkerCommandResolverOptions extends BunExecutableResolverOptions {
  workerPath?: string;
}
```

Add these functions below `resolveBunExecutable`:

```ts
function isLikelyFlyDeskExecutable(value: string | undefined): value is string {
  const fileName = basename(String(value ?? "")).toLowerCase();
  return fileName === "fly-desk.exe" || fileName === "fly-desk";
}

function resolveWorkerCommand(options: WorkerCommandResolverOptions = {}): string[] | undefined {
  const workerPath = options.workerPath ?? resolveWorkerPath();
  const pathExists = options.exists ?? existsSync;
  if (workerPath && pathExists(workerPath)) {
    return [resolveBunExecutable(options), workerPath];
  }

  const execPath = normalizeExecutableCandidate(options.execPath ?? process.execPath);
  if (isLikelyFlyDeskExecutable(execPath)) {
    return [execPath, "--fly-desk-worker"];
  }

  return undefined;
}

export function resolveSearchWorkerCommandForTests(options: WorkerCommandResolverOptions): string[] | undefined {
  return resolveWorkerCommand(options);
}
```

Replace the worker command creation in `runInWorker`:

```ts
const workerPath = resolveWorkerPath();
if (!searchWorkerProcessesEnabled() || !workerPath) {
  return Promise.reject(new Error("Search worker processes are disabled or unavailable."));
}
```

with:

```ts
const workerCommand = resolveWorkerCommand();
if (!searchWorkerProcessesEnabled() || !workerCommand) {
  return Promise.reject(new Error("Search worker processes are disabled or unavailable."));
}
```

Replace:

```ts
const bunExecutable = resolveBunExecutable();
const child = Bun.spawn([bunExecutable, workerPath], {
```

with:

```ts
const child = Bun.spawn(workerCommand, {
```

Replace:

```ts
BUN_EXECUTABLE_PATH: bunExecutable,
```

with:

```ts
BUN_EXECUTABLE_PATH: workerCommand[0],
```

- [ ] **Step 5: Run worker tests**

Run:

```powershell
bun test test/search-worker-client.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit worker executable support**

Run:

```powershell
git add src/index.ts src/search-worker-client.ts test/search-worker-client.test.ts
git commit -m "feat: support packaged search workers"
```

Expected: commit succeeds.

## Task 4: Add The Updater Contract And Documentation

**Files:**
- Create: `docs/UPDATE_CHANNEL.md`

- [ ] **Step 1: Create update channel docs**

Create `docs/UPDATE_CHANNEL.md` with:

```md
# Fly Desk Update Channel

Fly Desk source stays in the private `grumitos/fly-desk` repository.
User installations update from the public `grumitos/fly-desk-updates` repository.

## Public files

- `latest.json` on `main`
- `fly-desk-windows-x64-vX.Y.Z.zip` attached to release `vX.Y.Z`

## Local files preserved by updates

- `.env`
- `.launcher/`
- `output/`
- `artifacts/`

## Release artifact files

- `bin/fly-desk.exe`
- `frontend/dist/`
- `tools/start-fly-desk.ps1`
- `tools/stop-fly-desk.ps1`
- `tools/update-fly-desk.ps1`
- `Abrir Fly Desk.vbs`
- `Cerrar Fly Desk.vbs`
- `Abrir Fly Desk.ico`
- `VERSION`
- `release.json`

## Manifest URL

`https://raw.githubusercontent.com/grumitos/fly-desk-updates/main/latest.json`

## Security model

The updater verifies the downloaded zip with SHA-256 from the manifest before replacing local files.
No GitHub credentials are stored on the user's computer.
The public zip is the only public distribution artifact.
```

- [ ] **Step 2: Commit docs**

Run:

```powershell
git add docs/UPDATE_CHANNEL.md
git commit -m "docs: describe Fly Desk update channel"
```

Expected: commit succeeds.

## Task 5: Add PowerShell Updater

**Files:**
- Create: `tools/update-fly-desk.ps1`
- Modify: `tools/start-fly-desk.ps1`

- [ ] **Step 1: Add a local manifest fixture for manual testing**

Run this command only during implementation testing:

```powershell
$fixtureRoot = Join-Path $env:TEMP "fly-desk-update-fixture"
New-Item -ItemType Directory -Force -Path $fixtureRoot | Out-Null
```

Expected: directory exists.

- [ ] **Step 2: Create a minimal valid zip for updater smoke testing**

Run this command only during implementation testing:

```powershell
$zipRoot = Join-Path $fixtureRoot "ziproot"
$zipApp = Join-Path $zipRoot "fly-desk"
New-Item -ItemType Directory -Force -Path (Join-Path $zipApp "bin") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $zipApp "tools") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $zipApp "frontend\dist") | Out-Null
Set-Content -LiteralPath (Join-Path $zipApp "VERSION") -Value "99.0.0"
Set-Content -LiteralPath (Join-Path $zipApp "release.json") -Value '{"appId":"fly-desk","version":"99.0.0","platform":"windows-x64"}'
Set-Content -LiteralPath (Join-Path $zipApp "bin\fly-desk.exe") -Value "fake exe"
Set-Content -LiteralPath (Join-Path $zipApp "tools\start-fly-desk.ps1") -Value "Write-Host start"
Set-Content -LiteralPath (Join-Path $zipApp "tools\stop-fly-desk.ps1") -Value "Write-Host stop"
Set-Content -LiteralPath (Join-Path $zipApp "tools\update-fly-desk.ps1") -Value "Write-Host update"
Set-Content -LiteralPath (Join-Path $zipApp "frontend\dist\index.html") -Value "<title>Fly Desk</title>"
Set-Content -LiteralPath (Join-Path $zipApp "Abrir Fly Desk.vbs") -Value "' open"
Set-Content -LiteralPath (Join-Path $zipApp "Cerrar Fly Desk.vbs") -Value "' close"
Set-Content -LiteralPath (Join-Path $zipApp "Abrir Fly Desk.ico") -Value "ico"
Compress-Archive -Path $zipApp -DestinationPath (Join-Path $fixtureRoot "fly-desk-windows-x64-v99.0.0.zip") -Force
```

Expected: zip file exists.

- [ ] **Step 3: Create `tools/update-fly-desk.ps1`**

Create the updater with these responsibilities:

```powershell
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

param(
  [string]$InstallRoot,
  [string]$ManifestUrl = "https://raw.githubusercontent.com/grumitos/fly-desk-updates/main/latest.json",
  [switch]$CheckOnly
)

function Get-InstallRoot {
  if ($InstallRoot) {
    return (Resolve-Path -LiteralPath $InstallRoot).Path
  }
  return (Split-Path -Parent $PSScriptRoot)
}

function Get-LocalVersion {
  param([string]$Root)
  $versionFile = Join-Path $Root "VERSION"
  if (Test-Path -LiteralPath $versionFile) {
    return (Get-Content -LiteralPath $versionFile -Raw).Trim()
  }
  $packageFile = Join-Path $Root "package.json"
  if (Test-Path -LiteralPath $packageFile) {
    $package = Get-Content -LiteralPath $packageFile -Raw | ConvertFrom-Json
    return [string]$package.version
  }
  return "0.0.0"
}

function Compare-SemVer {
  param([string]$Left, [string]$Right)
  $leftParts = @($Left.Split("-")[0].Split(".") | ForEach-Object { [int]$_ })
  $rightParts = @($Right.Split("-")[0].Split(".") | ForEach-Object { [int]$_ })
  for ($i = 0; $i -lt 3; $i += 1) {
    $l = if ($i -lt $leftParts.Count) { $leftParts[$i] } else { 0 }
    $r = if ($i -lt $rightParts.Count) { $rightParts[$i] } else { 0 }
    if ($l -lt $r) { return -1 }
    if ($l -gt $r) { return 1 }
  }
  return 0
}

function Read-Manifest {
  param([string]$Url)
  if ($Url.StartsWith("file://")) {
    return Get-Content -LiteralPath ($Url.Substring(7)) -Raw | ConvertFrom-Json
  }
  return Invoke-RestMethod -Uri $Url -UseBasicParsing -TimeoutSec 10
}

function Assert-Manifest {
  param($Manifest)
  if ([int]$Manifest.schemaVersion -ne 1) { throw "Unsupported manifest schema." }
  if ([string]$Manifest.appId -ne "fly-desk") { throw "Manifest appId mismatch." }
  if (-not $Manifest.platforms.'windows-x64'.url) { throw "Manifest is missing windows-x64 URL." }
  $sha = [string]$Manifest.platforms.'windows-x64'.sha256
  if ($sha -notmatch "^[a-f0-9]{64}$") { throw "Manifest is missing a valid SHA-256." }
}

function Get-FileSha256 {
  param([string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Stop-FlyDeskIfPresent {
  param([string]$Root)
  $stopScript = Join-Path $Root "tools\stop-fly-desk.ps1"
  if (Test-Path -LiteralPath $stopScript) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stopScript | Out-Null
  }
}

function Copy-TreeContents {
  param([string]$From, [string]$To)
  Get-ChildItem -LiteralPath $From -Force | ForEach-Object {
    $target = Join-Path $To $_.Name
    if ($_.PSIsContainer) {
      Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force
    } else {
      Copy-Item -LiteralPath $_.FullName -Destination $target -Force
    }
  }
}

function Remove-ReleaseOwnedPaths {
  param([string]$Root)
  @(
    "bin",
    "frontend\dist",
    "tools\start-fly-desk.ps1",
    "tools\stop-fly-desk.ps1",
    "tools\update-fly-desk.ps1",
    "Abrir Fly Desk.vbs",
    "Cerrar Fly Desk.vbs",
    "Abrir Fly Desk.ico",
    "VERSION",
    "release.json"
  ) | ForEach-Object {
    $path = Join-Path $Root $_
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Recurse -Force
    }
  }
}

function Install-Update {
  param(
    [string]$Root,
    [string]$ZipPath,
    [string]$Version
  )

  $launcherDir = Join-Path $Root ".launcher"
  New-Item -ItemType Directory -Force -Path $launcherDir | Out-Null
  $staging = Join-Path $launcherDir "update-staging"
  $backup = Join-Path $launcherDir "backup-before-$Version"
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  New-Item -ItemType Directory -Force -Path $backup | Out-Null

  Expand-Archive -LiteralPath $ZipPath -DestinationPath $staging -Force
  $packageRoot = Join-Path $staging "fly-desk"
  if (-not (Test-Path -LiteralPath (Join-Path $packageRoot "release.json"))) {
    throw "Downloaded package does not contain release.json."
  }

  @("bin", "frontend\dist", "tools", "Abrir Fly Desk.vbs", "Cerrar Fly Desk.vbs", "Abrir Fly Desk.ico", "VERSION", "release.json") | ForEach-Object {
    $path = Join-Path $Root $_
    if (Test-Path -LiteralPath $path) {
      Copy-Item -LiteralPath $path -Destination (Join-Path $backup $_) -Recurse -Force
    }
  }

  try {
    Remove-ReleaseOwnedPaths -Root $Root
    Copy-TreeContents -From $packageRoot -To $Root
  } catch {
    Copy-TreeContents -From $backup -To $Root
    throw
  }
}

$root = Get-InstallRoot
$localVersion = Get-LocalVersion -Root $root
$manifest = Read-Manifest -Url $ManifestUrl
Assert-Manifest -Manifest $manifest
$remoteVersion = [string]$manifest.version

if ((Compare-SemVer -Left $localVersion -Right $remoteVersion) -ge 0) {
  Write-Output "Fly Desk is up to date ($localVersion)."
  exit 0
}

if ($CheckOnly) {
  Write-Output "Fly Desk update available: $localVersion -> $remoteVersion"
  exit 0
}

$downloadUrl = [string]$manifest.platforms.'windows-x64'.url
$expectedSha = [string]$manifest.platforms.'windows-x64'.sha256
$downloadDir = Join-Path $root ".launcher\downloads"
New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
$zipPath = Join-Path $downloadDir ("fly-desk-windows-x64-v{0}.zip" -f $remoteVersion)

Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath -UseBasicParsing -TimeoutSec 120
$actualSha = Get-FileSha256 -Path $zipPath
if ($actualSha -ne $expectedSha) {
  Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
  throw "Downloaded update failed SHA-256 verification."
}

Stop-FlyDeskIfPresent -Root $root
Install-Update -Root $root -ZipPath $zipPath -Version $remoteVersion
Write-Output "Fly Desk updated: $localVersion -> $remoteVersion"
```

- [ ] **Step 4: Modify `tools/start-fly-desk.ps1` to call updater**

Add script variables near the Git update variables:

```powershell
$script:SkipSelfUpdate = $false
$script:UpdateManifestUrl = if ($env:FLY_DESK_UPDATE_MANIFEST_URL) {
  $env:FLY_DESK_UPDATE_MANIFEST_URL
} else {
  "https://raw.githubusercontent.com/grumitos/fly-desk-updates/main/latest.json"
}
```

Set the flag near existing env flag parsing:

```powershell
$script:SkipSelfUpdate = Test-EnabledFlag -Value $env:FLY_DESK_SKIP_SELF_UPDATE
```

Add:

```powershell
function Test-ReleaseInstall {
  return Test-Path -LiteralPath (Join-Path $script:ProjectRoot "release.json")
}

function Ensure-SelfUpdated {
  if ($script:SkipSelfUpdate) {
    Write-LauncherLog "Self update omitido por FLY_DESK_SKIP_SELF_UPDATE."
    return
  }

  if (-not (Test-ReleaseInstall)) {
    Write-LauncherLog "Self update omitido: instalacion de desarrollo/source mode."
    return
  }

  $updater = Join-Path $script:ProjectRoot "tools\update-fly-desk.ps1"
  if (-not (Test-Path -LiteralPath $updater)) {
    Write-LauncherLog "Self update omitido: no existe tools\update-fly-desk.ps1."
    return
  }

  try {
    Write-LauncherLog "Self update: consultando $script:UpdateManifestUrl."
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $updater -InstallRoot $script:ProjectRoot -ManifestUrl $script:UpdateManifestUrl | ForEach-Object {
      Write-LauncherLog "Self update: $_"
    }
  } catch {
    Write-LauncherLog "Self update fallo y se continuara con la version local: $($_.Exception.Message)"
  }
}
```

Replace the top-level call:

```powershell
Ensure-ProjectUpdated
```

with:

```powershell
if (Test-ReleaseInstall) {
  Ensure-SelfUpdated
} else {
  Ensure-ProjectUpdated
}
```

- [ ] **Step 5: Modify server start in `tools/start-fly-desk.ps1`**

Add:

```powershell
function Get-PackagedExecutablePath {
  $candidate = Join-Path $script:ProjectRoot "bin\fly-desk.exe"
  if (Test-Path -LiteralPath $candidate) {
    return $candidate
  }
  return $null
}
```

Modify `Ensure-DependenciesAndBuild` so release installs do not require Bun:

```powershell
function Ensure-DependenciesAndBuild {
  if (Test-ReleaseInstall) {
    if (-not (Get-PackagedExecutablePath)) {
      Fail-Launcher "La instalacion de Fly Desk no contiene bin\fly-desk.exe."
    }
    return
  }

  $bunPath = Assert-BunReady
  $nodeModules = Join-Path $script:ProjectRoot "node_modules"

  if (-not (Test-Path -LiteralPath $nodeModules)) {
    Invoke-LoggedProcess -FilePath $bunPath -ArgumentList @("install", "--frozen-lockfile") -WorkingDirectory $script:ProjectRoot -StepName "bun install --frozen-lockfile"
  }

  if (Test-BuildNeeded) {
    Invoke-LoggedProcess -FilePath $bunPath -ArgumentList @("run", "build") -WorkingDirectory $script:ProjectRoot -StepName "bun run build"
  }
}
```

Modify the launch path so release mode uses `bin\fly-desk.exe` and dev mode uses Bun:

```powershell
$serverExecutable = Get-PackagedExecutablePath
if ($serverExecutable) {
  $serverProcessId = Start-ServerProcess -BunPath $serverExecutable -Port $script:LauncherPort
} else {
  $bunPath = Assert-BunReady
  $serverProcessId = Start-ServerProcess -BunPath $bunPath -Port $script:LauncherPort
}
```

Then modify `Start-ServerProcess` to use arguments based on executable name:

```powershell
$args = if ((Split-Path -Leaf $BunPath).ToLowerInvariant() -eq "fly-desk.exe") {
  @()
} else {
  @("run", "start")
}
```

Use `$args` in `Start-Process -ArgumentList`.

- [ ] **Step 6: Smoke test updater with file manifest**

Build the manifest from the fixture zip:

```powershell
$zipPath = Join-Path $fixtureRoot "fly-desk-windows-x64-v99.0.0.zip"
$sha = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = @{
  schemaVersion = 1
  appId = "fly-desk"
  channel = "stable"
  version = "99.0.0"
  publishedAt = "2026-05-18T00:00:00Z"
  platforms = @{
    "windows-x64" = @{
      url = $zipPath
      sha256 = $sha
      sizeBytes = (Get-Item -LiteralPath $zipPath).Length
    }
  }
  minimumLauncherVersion = "1.0.0"
  notes = "Fixture update."
} | ConvertTo-Json -Depth 5
$manifestPath = Join-Path $fixtureRoot "latest.json"
Set-Content -LiteralPath $manifestPath -Value $manifest -Encoding UTF8
```

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/update-fly-desk.ps1 -InstallRoot C:\fly-desk -ManifestUrl "file://$manifestPath" -CheckOnly
```

Expected:

```text
Fly Desk update available: ... -> 99.0.0
```

Do not install the fixture into the real repo.

- [ ] **Step 7: Commit updater scripts**

Run:

```powershell
git add tools/update-fly-desk.ps1 tools/start-fly-desk.ps1
git commit -m "feat: add manifest-based updater"
```

Expected: commit succeeds.

## Task 6: Add GitHub Release Automation

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Create public update repo**

Run once:

```powershell
gh repo create grumitos/fly-desk-updates --public --description "Public Fly Desk update artifacts" --confirm
```

Expected:

```text
https://github.com/grumitos/fly-desk-updates
```

- [ ] **Step 2: Create a fine-grained token for the workflow**

Create a GitHub fine-grained token with repository access only to `grumitos/fly-desk-updates` and permission `Contents: Read and write`.

Add it to the private repo as an Actions secret:

```powershell
gh secret set FLY_DESK_UPDATES_TOKEN --repo grumitos/fly-desk
```

Expected: `FLY_DESK_UPDATES_TOKEN` exists in the private repo's Actions secrets.

- [ ] **Step 3: Create `.github/workflows/release.yml`**

Create:

```yaml
name: Release Fly Desk

on:
  workflow_dispatch:
    inputs:
      version:
        description: Fly Desk version without leading v
        required: true
        type: string
      notes:
        description: Short release notes for latest.json
        required: true
        type: string

permissions:
  contents: read

jobs:
  release:
    runs-on: windows-latest
    steps:
      - name: Checkout source
        uses: actions/checkout@v5

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.13"

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Verify
        run: |
          bun run typecheck
          bun run lint
          bun test --timeout=600000 ./test/**/*.test.ts

      - name: Package release
        id: package
        shell: pwsh
        run: |
          $json = bun scripts/package-release.ts --version "${{ inputs.version }}" | Out-String
          $json | Set-Content -LiteralPath package-output.json
          $parsed = Get-Content -LiteralPath package-output.json -Raw | ConvertFrom-Json
          "zip_path=$($parsed.zipPath)" >> $env:GITHUB_OUTPUT
          "zip_name=$($parsed.zipName)" >> $env:GITHUB_OUTPUT
          "sha256=$($parsed.sha256)" >> $env:GITHUB_OUTPUT
          "size_bytes=$($parsed.sizeBytes)" >> $env:GITHUB_OUTPUT

      - name: Publish update artifact
        env:
          GH_TOKEN: ${{ secrets.FLY_DESK_UPDATES_TOKEN }}
          UPDATES_REPO: grumitos/fly-desk-updates
          VERSION: ${{ inputs.version }}
          NOTES: ${{ inputs.notes }}
          ZIP_PATH: ${{ steps.package.outputs.zip_path }}
          ZIP_NAME: ${{ steps.package.outputs.zip_name }}
          SHA256: ${{ steps.package.outputs.sha256 }}
          SIZE_BYTES: ${{ steps.package.outputs.size_bytes }}
        shell: pwsh
        run: |
          $tag = "v$env:VERSION"
          gh release create $tag $env:ZIP_PATH --repo $env:UPDATES_REPO --title "Fly Desk $tag" --notes $env:NOTES
          $downloadUrl = "https://github.com/$env:UPDATES_REPO/releases/download/$tag/$env:ZIP_NAME"
          $manifest = @{
            schemaVersion = 1
            appId = "fly-desk"
            channel = "stable"
            version = $env:VERSION
            publishedAt = (Get-Date).ToUniversalTime().ToString("o")
            platforms = @{
              "windows-x64" = @{
                url = $downloadUrl
                sha256 = $env:SHA256
                sizeBytes = [int64]$env:SIZE_BYTES
              }
            }
            minimumLauncherVersion = "1.0.0"
            notes = $env:NOTES
          } | ConvertTo-Json -Depth 5
          $manifestPath = Join-Path $env:RUNNER_TEMP "latest.json"
          Set-Content -LiteralPath $manifestPath -Value $manifest -Encoding UTF8
          $content = [Convert]::ToBase64String([IO.File]::ReadAllBytes($manifestPath))
          $existing = gh api "repos/$env:UPDATES_REPO/contents/latest.json" --jq .sha 2>$null
          if ($LASTEXITCODE -eq 0 -and $existing) {
            gh api "repos/$env:UPDATES_REPO/contents/latest.json" -X PUT -f message="Update latest.json for $tag" -f content=$content -f sha=$existing | Out-Null
          } else {
            gh api "repos/$env:UPDATES_REPO/contents/latest.json" -X PUT -f message="Create latest.json for $tag" -f content=$content | Out-Null
          }
```

- [ ] **Step 4: Commit workflow**

Run:

```powershell
git add .github/workflows/release.yml
git commit -m "ci: publish Fly Desk update releases"
```

Expected: commit succeeds.

## Task 7: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace Git-pull launcher docs**

In the "Arranque con un clic" section, replace the Git update behavior bullets with:

```md
Comportamiento actual del launcher:

- usa el puerto fijo `32123`
- si la carpeta contiene `release.json`, consulta el canal publico de actualizaciones
- descarga releases desde `grumitos/fly-desk-updates`
- verifica SHA-256 antes de instalar
- conserva `.env`, `.launcher/`, `output/` y `artifacts/`
- si hay una instancia activa, la detiene solo cuando ya tiene un update verificado
- si no hay update, reutiliza la instancia sana cuando corresponde
- en instalaciones de desarrollo sin `release.json`, mantiene el modo source/Bun
```

- [ ] **Step 2: Add maintainer release instructions**

Add:

```md
## Publicacion de actualizaciones

El codigo fuente vive en el repo privado `grumitos/fly-desk`.
Los usuarios finales actualizan desde el repo publico `grumitos/fly-desk-updates`.

Para publicar una version:

1. Actualiza `version` en `package.json`.
2. Ejecuta `bun run typecheck`, `bun run lint`, `bun run build` y `bun test --timeout=600000 ./test/**/*.test.ts`.
3. Lanza el workflow `Release Fly Desk` con la version sin `v`.
4. Confirma que `https://raw.githubusercontent.com/grumitos/fly-desk-updates/main/latest.json` apunta al nuevo zip.

La PC del usuario no necesita Git, GitHub CLI ni credenciales de GitHub.
```

- [ ] **Step 3: Commit README updates**

Run:

```powershell
git add README.md
git commit -m "docs: document release updater workflow"
```

Expected: commit succeeds.

## Task 8: End-To-End Verification

**Files:**
- Modify: none

- [ ] **Step 1: Run full local verification**

Run:

```powershell
bun run typecheck
bun run lint
bun run build
bun test --timeout=600000 ./test/**/*.test.ts
```

Expected: all commands exit `0`.

- [ ] **Step 2: Build a local release package**

Run:

```powershell
bun scripts/package-release.ts --version 0.0.0-local --output-dir artifacts\release-smoke
```

Expected: command prints JSON containing `zipPath`, `sha256`, and `sizeBytes`.

- [ ] **Step 3: Extract into a temporary install root**

Run:

```powershell
$installRoot = Join-Path $env:TEMP "fly-desk-install-smoke"
Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
Expand-Archive -LiteralPath artifacts\release-smoke\fly-desk-windows-x64-v0.0.0-local.zip -DestinationPath $installRoot -Force
Get-ChildItem -LiteralPath (Join-Path $installRoot "fly-desk")
```

Expected: extracted folder contains `bin\fly-desk.exe`, `tools\start-fly-desk.ps1`, and `frontend\dist\index.html`.

- [ ] **Step 4: Start the packaged app**

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $installRoot "fly-desk\tools\start-fly-desk.ps1")
```

Expected: launcher starts Fly Desk and opens `http://127.0.0.1:32123/`.

- [ ] **Step 5: Check health endpoint**

Run:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:32123/api/health
```

Expected: HTTP 200 response.

- [ ] **Step 6: Stop packaged app**

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $installRoot "fly-desk\tools\stop-fly-desk.ps1")
```

Expected: port `32123` is released.

- [ ] **Step 7: Publish first real release**

Run:

```powershell
gh workflow run "Release Fly Desk" --repo grumitos/fly-desk -f version=0.2.0 -f notes="Bootstrap manifest-based updater."
```

Expected: workflow starts successfully.

- [ ] **Step 8: Watch workflow**

Run:

```powershell
gh run watch --repo grumitos/fly-desk
```

Expected: workflow completes successfully.

- [ ] **Step 9: Verify public manifest**

Run:

```powershell
Invoke-RestMethod -Uri "https://raw.githubusercontent.com/grumitos/fly-desk-updates/main/latest.json"
```

Expected: manifest version is `0.2.0`, URL is a public GitHub Release asset, and SHA-256 is 64 lowercase hex characters.

- [ ] **Step 10: Commit final verification note if docs changed during verification**

Run:

```powershell
git status -sb
```

Expected: clean working tree. If docs were adjusted, commit them with:

```powershell
git add README.md docs/UPDATE_CHANNEL.md
git commit -m "docs: refine updater release notes"
```

## Task 9: Rollout To Existing User Folder

**Files:**
- Modify: none in repo

- [ ] **Step 1: Backup existing user install**

Run on the user's machine:

```powershell
Compress-Archive -Path C:\fly-desk -DestinationPath "$env:USERPROFILE\Desktop\fly-desk-backup-before-updater.zip" -Force
```

Expected: backup zip exists on the desktop.

- [ ] **Step 2: Download the first release zip**

Run:

```powershell
$manifest = Invoke-RestMethod -Uri "https://raw.githubusercontent.com/grumitos/fly-desk-updates/main/latest.json"
$url = $manifest.platforms.'windows-x64'.url
$zip = Join-Path $env:TEMP "fly-desk-first-release.zip"
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
```

Expected: release zip exists.

- [ ] **Step 3: Verify hash**

Run:

```powershell
$actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $manifest.platforms.'windows-x64'.sha256) { throw "Hash mismatch" }
```

Expected: no exception.

- [ ] **Step 4: Install first release over existing folder**

Run:

```powershell
Expand-Archive -LiteralPath $zip -DestinationPath $env:TEMP\fly-desk-first-release -Force
Copy-Item -LiteralPath "$env:TEMP\fly-desk-first-release\fly-desk\*" -Destination C:\fly-desk -Recurse -Force
```

Expected: `C:\fly-desk\release.json` and `C:\fly-desk\bin\fly-desk.exe` exist.

- [ ] **Step 5: Open through the same shortcut**

Run:

```powershell
wscript.exe "C:\fly-desk\Abrir Fly Desk.vbs"
```

Expected: Fly Desk opens from the same local folder and future opens use the manifest updater.

## Risks And Controls

- Public artifact exposure: the public zip is downloadable by anyone with the public update repo URL. Control: ship compiled/minified runtime files, not the private source tree.
- Hash-only verification: SHA-256 protects against corrupted or mismatched downloads as long as the manifest is trusted. Control: publish `latest.json` only from the private repo workflow using a narrow token.
- Windows file locks: active server processes can block replacement. Control: updater downloads and verifies first, then stops Fly Desk before replacing release-owned files.
- Broken release: a bad manifest can point users to a broken version. Control: workflow runs tests before publishing, and updater keeps a backup for rollback during failed swaps.
- Dev install compatibility: developers still need source/Bun mode. Control: `release.json` selects release updater mode; absence of `release.json` keeps the current source-mode behavior.

## References

- Bun standalone executables: https://bun.sh/docs/bundler/executables
- GitHub Releases API requires authentication for private repo release assets, so user downloads should come from a public update channel: https://docs.github.com/en/rest/releases/releases
