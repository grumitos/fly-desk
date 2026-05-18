import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeInstallRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "flydesk-install-"));
  tempRoots.push(root);
  const releaseDir = join(root, "app", "releases", "0.3.0");
  mkdirSync(join(releaseDir, "bin"), { recursive: true });
  mkdirSync(join(releaseDir, "frontend", "dist"), { recursive: true });
  mkdirSync(join(root, ".launcher"), { recursive: true });
  writeFileSync(join(releaseDir, "bin", "fly-desk.exe"), "fake executable");
  writeFileSync(join(releaseDir, "frontend", "dist", "index.html"), "<title>Fly Desk</title>");
  writeFileSync(join(releaseDir, "release.json"), JSON.stringify({
    schemaVersion: 1,
    appId: "fly-desk",
    version: "0.3.0",
    platform: "windows-x64",
  }));
  writeFileSync(join(root, "app", "current.json"), JSON.stringify({
    version: "0.3.0",
    releaseDir,
    activatedAt: "2026-05-18T16:10:00.000Z",
  }));
  return root;
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function runPowerShell(script: string, env: Record<string, string>): string {
  const result = Bun.spawnSync([
    "powershell.exe",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ], {
    env: {
      ...process.env,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  assert.equal(
    result.exitCode,
    0,
    `${result.stdout.toString()}\n${result.stderr.toString()}`,
  );
  return result.stdout.toString().trim();
}

test("launcher resolves current side-by-side release and release-mode environment", () => {
  const installRoot = makeInstallRoot();
  const scriptPath = join(process.cwd(), "tools", "start-fly-desk.ps1");
  const output = runPowerShell(
    [
      `. ${powershellQuote(scriptPath)}`,
      `$release = Get-ActiveRelease`,
      `$envMap = New-ReleaseEnvironment -ReleaseDir $release.releaseDir -Port 32123 -ExecutablePath $release.executablePath`,
      `[pscustomobject]@{`,
      `  version = $release.version`,
      `  releaseDir = $release.releaseDir`,
      `  executablePath = $release.executablePath`,
      `  publicDir = $envMap['FLY_DESK_PUBLIC_DIR']`,
      `  sessionDb = $envMap['FLY_DESK_SESSION_DB_PATH']`,
      `  locationDb = $envMap['FLY_DESK_LOCATION_SUGGESTION_DB_PATH']`,
      `  port = $envMap['PORT']`,
      `} | ConvertTo-Json -Compress`,
    ].join("\n"),
    {
      FLY_DESK_INSTALL_ROOT: installRoot,
      FLY_DESK_LAUNCHER_IMPORT_ONLY: "1",
    },
  );

  const payload = JSON.parse(output);
  const releaseDir = join(installRoot, "app", "releases", "0.3.0");
  assert.equal(payload.version, "0.3.0");
  assert.equal(payload.releaseDir, releaseDir);
  assert.equal(payload.executablePath, join(releaseDir, "bin", "fly-desk.exe"));
  assert.equal(payload.publicDir, join(releaseDir, "frontend", "dist"));
  assert.equal(payload.sessionDb, join(installRoot, "output", "cache", "fly-desk-cache.sqlite"));
  assert.equal(
    payload.locationDb,
    join(installRoot, "output", "cache", "location-suggestion-cache.sqlite"),
  );
  assert.equal(payload.port, "32123");
});

test("update script activates a staged release by moving it under app/releases and writing current.json", () => {
  const installRoot = makeInstallRoot();
  const stagingRelease = join(installRoot, ".launcher", "staging", "0.4.0", "fly-desk-release");
  mkdirSync(join(stagingRelease, "bin"), { recursive: true });
  mkdirSync(join(stagingRelease, "frontend", "dist"), { recursive: true });
  writeFileSync(join(stagingRelease, "bin", "fly-desk.exe"), "fake executable 0.4.0");
  writeFileSync(join(stagingRelease, "frontend", "dist", "index.html"), "<title>Fly Desk</title>");
  writeFileSync(join(stagingRelease, "release.json"), JSON.stringify({
    schemaVersion: 1,
    appId: "fly-desk",
    version: "0.4.0",
    platform: "windows-x64",
  }));

  const scriptPath = join(process.cwd(), "tools", "update-fly-desk.ps1");
  const output = runPowerShell(
    [
      `. ${powershellQuote(scriptPath)}`,
      `$activated = Activate-StagedRelease -Version '0.4.0' -StagedReleaseDir ${powershellQuote(stagingRelease)}`,
      `$current = Get-Content -LiteralPath (Join-Path ${powershellQuote(installRoot)} 'app/current.json') -Raw | ConvertFrom-Json`,
      `[pscustomobject]@{`,
      `  activatedVersion = $activated.version`,
      `  currentVersion = $current.version`,
      `  releaseDir = $current.releaseDir`,
      `  releaseExists = Test-Path -LiteralPath $activated.releaseDir`,
      `  stagedExists = Test-Path -LiteralPath ${powershellQuote(stagingRelease)}`,
      `} | ConvertTo-Json -Compress`,
    ].join("\n"),
    {
      FLY_DESK_INSTALL_ROOT: installRoot,
      FLY_DESK_UPDATER_IMPORT_ONLY: "1",
    },
  );

  const payload = JSON.parse(output);
  assert.equal(payload.activatedVersion, "0.4.0");
  assert.equal(payload.currentVersion, "0.4.0");
  assert.equal(payload.releaseDir, join(installRoot, "app", "releases", "0.4.0"));
  assert.equal(payload.releaseExists, true);
  assert.equal(payload.stagedExists, false);
});
