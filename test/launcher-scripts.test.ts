import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeRelease(root: string, version: string, executableContent = "fake executable"): string {
  const releaseDir = join(root, "app", "releases", version);
  mkdirSync(join(releaseDir, "bin"), { recursive: true });
  mkdirSync(join(releaseDir, "frontend", "dist"), { recursive: true });
  writeFileSync(join(releaseDir, "bin", "fly-desk.exe"), executableContent);
  writeFileSync(join(releaseDir, "frontend", "dist", "index.html"), "<title>Fly Desk</title>");
  writeFileSync(join(releaseDir, "release.json"), JSON.stringify({
    schemaVersion: 1,
    appId: "fly-desk",
    version,
    platform: "windows-x64",
  }));
  return releaseDir;
}

function writeCurrent(root: string, version: string, releaseDir: string): void {
  mkdirSync(join(root, "app"), { recursive: true });
  writeFileSync(join(root, "app", "current.json"), JSON.stringify({
    version,
    releaseDir,
    activatedAt: "2026-05-18T16:10:00.000Z",
  }));
}

function makeInstallRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "flydesk-install-"));
  tempRoots.push(root);
  mkdirSync(join(root, ".launcher"), { recursive: true });
  const releaseDir = writeRelease(root, "0.3.0");
  writeCurrent(root, "0.3.0", releaseDir);
  return root;
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sha256File(path: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(readFileSync(path));
  return hasher.digest("hex");
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

function createReleaseZip(version: string): { zipPath: string; sha256: string; sizeBytes: number } {
  const packageRoot = mkdtempSync(join(tmpdir(), "flydesk-release-package-"));
  tempRoots.push(packageRoot);
  const releaseRoot = join(packageRoot, "fly-desk-release");
  mkdirSync(join(releaseRoot, "bin"), { recursive: true });
  mkdirSync(join(releaseRoot, "frontend", "dist"), { recursive: true });
  writeFileSync(join(releaseRoot, "bin", "fly-desk.exe"), `fake executable ${version}`);
  writeFileSync(join(releaseRoot, "frontend", "dist", "index.html"), "<title>Fly Desk</title>");
  writeFileSync(join(releaseRoot, "release.json"), JSON.stringify({
    schemaVersion: 1,
    appId: "fly-desk",
    version,
    platform: "windows-x64",
  }));

  const zipPath = join(packageRoot, `fly-desk-windows-x64-v${version}.zip`);
  runPowerShell(
    `Compress-Archive -LiteralPath ${powershellQuote(releaseRoot)} -DestinationPath ${powershellQuote(zipPath)} -Force`,
    {},
  );
  return {
    zipPath,
    sha256: sha256File(zipPath),
    sizeBytes: readFileSync(zipPath).byteLength,
  };
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

test("launcher records last-known-good after release health succeeds", () => {
  const installRoot = makeInstallRoot();
  const scriptPath = join(process.cwd(), "tools", "start-fly-desk.ps1");
  const output = runPowerShell(
    [
      `. ${powershellQuote(scriptPath)}`,
      `$release = Get-ActiveRelease`,
      `Save-LastKnownGood -Release $release`,
      `$good = Get-Content -LiteralPath (Join-Path ${powershellQuote(installRoot)} '.launcher/last-known-good.json') -Raw | ConvertFrom-Json`,
      `[pscustomobject]@{`,
      `  version = $good.version`,
      `  releaseDir = $good.releaseDir`,
      `  healthCheckedAtPresent = -not [string]::IsNullOrWhiteSpace([string]$good.healthCheckedAt)`,
      `} | ConvertTo-Json -Compress`,
    ].join("\n"),
    {
      FLY_DESK_INSTALL_ROOT: installRoot,
      FLY_DESK_LAUNCHER_IMPORT_ONLY: "1",
    },
  );

  const payload = JSON.parse(output);
  assert.equal(payload.version, "0.3.0");
  assert.equal(payload.releaseDir, join(installRoot, "app", "releases", "0.3.0"));
  assert.equal(payload.healthCheckedAtPresent, true);
});

test("updater rollback restores current.json from last-known-good", () => {
  const installRoot = makeInstallRoot();
  const goodReleaseDir = join(installRoot, "app", "releases", "0.3.0");
  const badReleaseDir = writeRelease(installRoot, "0.4.0", "bad executable");
  writeCurrent(installRoot, "0.4.0", badReleaseDir);
  writeFileSync(join(installRoot, ".launcher", "last-known-good.json"), JSON.stringify({
    version: "0.3.0",
    releaseDir: goodReleaseDir,
    healthCheckedAt: "2026-05-18T15:00:00.000Z",
  }));

  const scriptPath = join(process.cwd(), "tools", "update-fly-desk.ps1");
  const output = runPowerShell(
    [
      `. ${powershellQuote(scriptPath)}`,
      `$rolledBack = Rollback-ToLastKnownGood`,
      `$current = Get-Content -LiteralPath (Join-Path ${powershellQuote(installRoot)} 'app/current.json') -Raw | ConvertFrom-Json`,
      `[pscustomobject]@{`,
      `  rolledBackVersion = $rolledBack.version`,
      `  currentVersion = $current.version`,
      `  releaseDir = $current.releaseDir`,
      `  activatedAtPresent = -not [string]::IsNullOrWhiteSpace([string]$current.activatedAt)`,
      `} | ConvertTo-Json -Compress`,
    ].join("\n"),
    {
      FLY_DESK_INSTALL_ROOT: installRoot,
      FLY_DESK_UPDATER_IMPORT_ONLY: "1",
    },
  );

  const payload = JSON.parse(output);
  assert.equal(payload.rolledBackVersion, "0.3.0");
  assert.equal(payload.currentVersion, "0.3.0");
  assert.equal(payload.releaseDir, goodReleaseDir);
  assert.equal(payload.activatedAtPresent, true);

  const current = JSON.parse(readFileSync(join(installRoot, "app", "current.json"), "utf8"));
  assert.equal(current.version, "0.3.0");
});

test("launcher retries the last-known-good release when the active release fails health", () => {
  const installRoot = makeInstallRoot();
  const goodReleaseDir = join(installRoot, "app", "releases", "0.3.0");
  const badReleaseDir = writeRelease(installRoot, "0.4.0", "bad executable");
  writeCurrent(installRoot, "0.4.0", badReleaseDir);
  writeFileSync(join(installRoot, ".launcher", "last-known-good.json"), JSON.stringify({
    version: "0.3.0",
    releaseDir: goodReleaseDir,
    healthCheckedAt: "2026-05-18T15:00:00.000Z",
  }));

  const scriptPath = join(process.cwd(), "tools", "start-fly-desk.ps1");
  const output = runPowerShell(
    [
      `. ${powershellQuote(scriptPath)}`,
      `$script:startedVersions = @()`,
      `$script:stoppedPids = @()`,
      `function Start-ReleaseServerProcess {`,
      `  param($Release, [int]$Port)`,
      `  $script:startedVersions += [string]$Release.version`,
      `  if ([string]$Release.version -eq '0.4.0') { return 4040 }`,
      `  return 3030`,
      `}`,
      `function Wait-ForServer {`,
      `  param([int]$Port, [int]$ProcessId)`,
      `  return $ProcessId -eq 3030`,
      `}`,
      `function Stop-ProcessTree {`,
      `  param([int]$ProcessId)`,
      `  $script:stoppedPids += $ProcessId`,
      `}`,
      `$release = Get-ActiveRelease`,
      `$result = Start-AndValidateRelease -Release $release -Port 32123`,
      `$current = Get-Content -LiteralPath (Join-Path ${powershellQuote(installRoot)} 'app/current.json') -Raw | ConvertFrom-Json`,
      `[pscustomobject]@{`,
      `  rolledBack = $result.rolledBack`,
      `  resultVersion = $result.release.version`,
      `  currentVersion = $current.version`,
      `  startedVersions = $script:startedVersions -join ','`,
      `  stoppedPids = $script:stoppedPids -join ','`,
      `} | ConvertTo-Json -Compress`,
    ].join("\n"),
    {
      FLY_DESK_INSTALL_ROOT: installRoot,
      FLY_DESK_LAUNCHER_IMPORT_ONLY: "1",
    },
  );

  const payload = JSON.parse(output);
  assert.equal(payload.rolledBack, true);
  assert.equal(payload.resultVersion, "0.3.0");
  assert.equal(payload.currentVersion, "0.3.0");
  assert.equal(payload.startedVersions, "0.4.0,0.3.0");
  assert.equal(payload.stoppedPids, "4040");
});

test("updater installs a newer manifest package after hash and release validation", () => {
  const installRoot = makeInstallRoot();
  const packageZip = createReleaseZip("0.4.0");
  const scriptPath = join(process.cwd(), "tools", "update-fly-desk.ps1");
  const output = runPowerShell(
    [
      `. ${powershellQuote(scriptPath)}`,
      `$manifest = [pscustomobject]@{`,
      `  schemaVersion = 1`,
      `  appId = 'fly-desk'`,
      `  channel = 'stable'`,
      `  version = '0.4.0'`,
      `  releaseId = 'test-v0.4.0'`,
      `  minimumBootstrapVersion = '1.0.0'`,
      `  package = [pscustomobject]@{`,
      `    platform = 'windows-x64'`,
      `    url = ${powershellQuote(packageZip.zipPath)}`,
      `    sha256 = '${packageZip.sha256}'`,
      `    sizeBytes = ${packageZip.sizeBytes}`,
      `  }`,
      `}`,
      `$installed = Install-ManifestUpdate -Manifest $manifest`,
      `$current = Get-Content -LiteralPath (Join-Path ${powershellQuote(installRoot)} 'app/current.json') -Raw | ConvertFrom-Json`,
      `[pscustomobject]@{`,
      `  installedVersion = $installed.version`,
      `  currentVersion = $current.version`,
      `  releaseDir = $current.releaseDir`,
      `  releaseExists = Test-Path -LiteralPath (Join-Path ${powershellQuote(installRoot)} 'app/releases/0.4.0/release.json')`,
      `  stagingExists = Test-Path -LiteralPath (Join-Path ${powershellQuote(installRoot)} '.launcher/staging/0.4.0')`,
      `} | ConvertTo-Json -Compress`,
    ].join("\n"),
    {
      FLY_DESK_INSTALL_ROOT: installRoot,
      FLY_DESK_UPDATER_IMPORT_ONLY: "1",
    },
  );

  const payload = JSON.parse(output);
  assert.equal(payload.installedVersion, "0.4.0");
  assert.equal(payload.currentVersion, "0.4.0");
  assert.equal(payload.releaseDir, join(installRoot, "app", "releases", "0.4.0"));
  assert.equal(payload.releaseExists, true);
  assert.equal(payload.stagingExists, false);
});

test("updater rejects hash mismatch without changing current.json", () => {
  const installRoot = makeInstallRoot();
  const packageZip = createReleaseZip("0.4.0");
  const scriptPath = join(process.cwd(), "tools", "update-fly-desk.ps1");
  const output = runPowerShell(
    [
      `. ${powershellQuote(scriptPath)}`,
      `$manifest = [pscustomobject]@{`,
      `  schemaVersion = 1`,
      `  appId = 'fly-desk'`,
      `  channel = 'stable'`,
      `  version = '0.4.0'`,
      `  releaseId = 'test-v0.4.0'`,
      `  minimumBootstrapVersion = '1.0.0'`,
      `  package = [pscustomobject]@{`,
      `    platform = 'windows-x64'`,
      `    url = ${powershellQuote(packageZip.zipPath)}`,
      `    sha256 = '0000000000000000000000000000000000000000000000000000000000000000'`,
      `    sizeBytes = ${packageZip.sizeBytes}`,
      `  }`,
      `}`,
      `$errorCode = ''`,
      `try { Install-ManifestUpdate -Manifest $manifest | Out-Null } catch { $errorCode = $_.Exception.Message }`,
      `$current = Get-Content -LiteralPath (Join-Path ${powershellQuote(installRoot)} 'app/current.json') -Raw | ConvertFrom-Json`,
      `[pscustomobject]@{`,
      `  error = $errorCode`,
      `  currentVersion = $current.version`,
      `  releaseExists = Test-Path -LiteralPath (Join-Path ${powershellQuote(installRoot)} 'app/releases/0.4.0')`,
      `} | ConvertTo-Json -Compress`,
    ].join("\n"),
    {
      FLY_DESK_INSTALL_ROOT: installRoot,
      FLY_DESK_UPDATER_IMPORT_ONLY: "1",
    },
  );

  const payload = JSON.parse(output);
  assert.match(payload.error, /hash/i);
  assert.equal(payload.currentVersion, "0.3.0");
  assert.equal(payload.releaseExists, false);
});
