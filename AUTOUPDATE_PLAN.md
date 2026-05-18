# Fly Desk Autoupdater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. This root plan is the compact source of truth for implementation.

**Goal:** Ship Fly Desk to final clients as a local folder with the same shortcut, while updates arrive without Git, GitHub login, or maintainer credentials on the client's computer.

**Architecture:** Use a stable local bootstrap launcher plus side-by-side release directories. The updater downloads a public or licensed manifest, verifies the zip by SHA-256, stages the release, flips a local `current` pointer only after validation, starts the new version, confirms `/api/health`, and rolls back to the last known good release on failure. Optional remote receipts report whether an update was downloaded, activated, healthy, failed, or rolled back.

**Tech Stack:** PowerShell bootstrap/updater, Bun compiled Windows executable, GitHub Actions release packaging, public update manifest, optional HTTPS receipt endpoint.

---

## Key Decisions After Review

1. **Do not replace runtime files in the install root.**
   Replacing files in place makes rollback hard and risks breaking the launcher while it is running.

2. **Keep the launcher/bootstrap stable.**
   `Abrir Fly Desk.vbs` and the bootstrap PowerShell script live at the install root and are not part of normal app updates. Bootstrap updates can be a separate explicit mechanism.

3. **Install app versions side by side.**
   Each release is extracted to `app/releases/<version>/`. The active version is a small JSON pointer, not a copied tree.

4. **Rollback is pointer-based.**
   If version `0.3.0` fails health checks, switch `app/current.json` back to the previous `lastKnownGoodVersion` and start that version.

5. **Remote delivery confirmation requires receipts.**
   GitHub download counts are not enough. The client updater must POST a small update receipt after health succeeds. If offline, it queues the receipt locally and retries on future launches.

## Local Install Layout

```text
C:\fly-desk\
  Abrir Fly Desk.vbs
  Cerrar Fly Desk.vbs
  AUTOUPDATE_RUNBOOK.md
  .env
  app\
    current.json
    releases\
      0.2.0\
        release.json
        bin\fly-desk.exe
        frontend\dist\index.html
      0.3.0\
        release.json
        bin\fly-desk.exe
        frontend\dist\index.html
  tools\
    start-fly-desk.ps1
    stop-fly-desk.ps1
    update-fly-desk.ps1
  .launcher\
    state.json
    update-lock
    last-known-good.json
    downloads\
    staging\
    receipts\
      pending\
      sent\
    logs\
  output\
```

`tools/start-fly-desk.ps1` runs from the install root, reads `app/current.json`, and starts the executable in `app/releases/<version>/bin/fly-desk.exe`.

The app process should run with:

```text
cwd = C:\fly-desk
FLY_DESK_RELEASE_DIR = C:\fly-desk\app\releases\<version>
FLY_DESK_PUBLIC_DIR = C:\fly-desk\app\releases\<version>\frontend\dist
FLY_DESK_SESSION_DB_PATH = C:\fly-desk\output\cache\fly-desk-cache.sqlite
FLY_DESK_LOCATION_SUGGESTION_DB_PATH = C:\fly-desk\output\cache\location-suggestion-cache.sqlite
```

This keeps `.env` and local caches stable across versions while letting the server serve assets from the active release.

## Release Package Layout

The published zip should contain one root folder:

```text
fly-desk-release\
  release.json
  bin\fly-desk.exe
  frontend\dist\index.html
  frontend\dist\assets\
```

The zip must not include:

```text
.git\
.env
src\
test\
node_modules\
output\
.launcher\
```

Bootstrap files can ship with the first installer bundle, but normal app releases should not overwrite the bootstrap.

## Manifest V1

```json
{
  "schemaVersion": 1,
  "appId": "fly-desk",
  "channel": "stable",
  "version": "0.3.0",
  "releaseId": "2026-05-18T16:00:00Z-v0.3.0",
  "publishedAt": "2026-05-18T16:00:00Z",
  "minimumBootstrapVersion": "1.0.0",
  "package": {
    "platform": "windows-x64",
    "url": "https://github.com/grumitos/fly-desk-updates/releases/download/v0.3.0/fly-desk-windows-x64-v0.3.0.zip",
    "sha256": "64 lowercase hex characters",
    "sizeBytes": 12345678
  },
  "receipts": {
    "enabled": true,
    "url": "https://updates.example.com/fly-desk/receipts"
  },
  "notes": "Short support-facing release note."
}
```

The updater must reject the manifest when:

- `schemaVersion` is not `1`
- `appId` is not `fly-desk`
- `version` is missing or not greater than local
- `package.url` is missing
- `package.sha256` is not 64 lowercase hex characters
- `minimumBootstrapVersion` is greater than local bootstrap version

Unknown fields are ignored.

## Local State

`app/current.json`:

```json
{
  "version": "0.3.0",
  "releaseDir": "C:\\fly-desk\\app\\releases\\0.3.0",
  "activatedAt": "2026-05-18T16:10:00Z"
}
```

`.launcher/last-known-good.json`:

```json
{
  "version": "0.2.0",
  "releaseDir": "C:\\fly-desk\\app\\releases\\0.2.0",
  "healthCheckedAt": "2026-05-18T15:00:00Z"
}
```

`.launcher/install-id.json`:

```json
{
  "installId": "random UUID generated once",
  "createdAt": "2026-05-18T15:00:00Z"
}
```

The install id is not the machine name, Windows username, email, or IP. It exists only to know whether a specific installation reached a version.

## Receipt Events

Remote confirmation is event-based. The updater writes every receipt locally first, then attempts to POST it.

```json
{
  "appId": "fly-desk",
  "installId": "uuid",
  "eventId": "uuid",
  "eventType": "health_ok",
  "version": "0.3.0",
  "previousVersion": "0.2.0",
  "releaseId": "2026-05-18T16:00:00Z-v0.3.0",
  "bootstrapVersion": "1.0.0",
  "occurredAt": "2026-05-18T16:11:00Z",
  "status": "success",
  "errorCode": null
}
```

Required event types:

- `check_started`
- `update_available`
- `download_verified`
- `activated`
- `health_ok`
- `no_update`
- `failed`
- `rolled_back`

Operational meaning:

- **Downloaded** means the zip arrived and matched the manifest.
- **Activated** means `app/current.json` points to the new version.
- **Healthy** means the new process returned HTTP 200 on `/api/health`.
- **Delivered successfully** means a remote `health_ok` receipt was received for the target version.

If receipts are disabled or unreachable, the updater still updates locally and queues pending receipts under `.launcher/receipts/pending/`.

## Fallback And Rollback Rules

- Manifest unreachable: log and launch current version.
- Manifest invalid: log `failed`, do not download, launch current version.
- Download fails: log `failed`, launch current version.
- SHA-256 mismatch: delete zip, log `failed`, launch current version.
- Extract fails: delete staging, log `failed`, launch current version.
- Activation fails before pointer flip: leave `current.json` unchanged.
- Activation succeeds but health fails: restore `current.json` from `last-known-good.json`, start previous version, emit `rolled_back`.
- Previous version also fails: show popup with log path and leave server stopped.
- Receipt POST fails: leave receipt in `pending`, continue normal app launch.

## Implementation Tasks

### Task 1: Packaging Contract

Files:

- Create `test/release-package.test.ts`
- Create `scripts/package-release.ts`
- Modify `package.json`

Build a package that includes only:

- `release.json`
- `bin/fly-desk.exe`
- `frontend/dist/**`

Tests must assert excluded paths are absent: `.env`, `.git`, `src`, `test`, `node_modules`, `output`, `.launcher`.

### Task 2: Runtime Paths For Release Mode

Files:

- Modify `src/server.ts`
- Modify `src/runtime.ts`
- Modify tests for server/static asset path behavior

Add support for:

- `FLY_DESK_PUBLIC_DIR`
- explicit cache DB paths already supported by `runtime.ts`

`src/server.ts` must serve frontend assets from `FLY_DESK_PUBLIC_DIR` when present, otherwise keep current `process.cwd()/frontend/dist` behavior.

### Task 3: Packaged Worker Mode

Files:

- Modify `src/index.ts`
- Modify `src/search-worker-client.ts`
- Modify `test/search-worker-client.test.ts`

Add `--fly-desk-worker` mode to the executable and make worker spawns use the packaged executable in release mode.

### Task 4: Stable Bootstrap Launcher

Files:

- Modify `tools/start-fly-desk.ps1`
- Modify `tools/stop-fly-desk.ps1`
- Create `tools/update-fly-desk.ps1`

Launcher behavior:

1. Acquire `.launcher/update-lock`.
2. Flush pending receipts in the background.
3. Check manifest unless `FLY_DESK_SKIP_SELF_UPDATE=1`.
4. Install update if available and verified.
5. Read `app/current.json`.
6. Start active executable with release env vars.
7. Wait for `/api/health`.
8. If health fails after an update, roll back and retry previous version.

### Task 5: Update Engine

Files:

- Create updater helpers inside `tools/update-fly-desk.ps1`

Implement functions:

- `Read-Manifest`
- `Assert-Manifest`
- `Compare-SemVer`
- `Get-OrCreateInstallId`
- `Write-Receipt`
- `Flush-Receipts`
- `Download-Package`
- `Assert-PackageHash`
- `Expand-PackageToStaging`
- `Validate-StagedRelease`
- `Activate-Release`
- `Rollback-ToLastKnownGood`
- `Prune-OldReleases`

### Task 6: Remote Receipts Endpoint

Files:

- Create `docs/UPDATE_RECEIPTS_ENDPOINT.md` or add endpoint notes to the runbook
- Optional next phase: create a Cloudflare Worker or small HTTPS endpoint

Minimum endpoint contract:

- `POST /fly-desk/receipts`
- Accept JSON receipt events
- Return HTTP 202 for accepted receipts
- Rate-limit by IP and `installId`
- Store `installId`, `eventType`, `version`, `releaseId`, `occurredAt`, `status`, `errorCode`

No secrets, `.env` values, provider credentials, passenger data, search data, or browser paths are sent.

### Task 7: GitHub Release Workflow

Files:

- Create `.github/workflows/release.yml`

Workflow:

1. Install Bun.
2. Run typecheck, lint, build, tests.
3. Compile `bin/fly-desk.exe`.
4. Build release zip.
5. Compute SHA-256.
6. Publish zip to update channel.
7. Update `latest.json`.

### Task 8: End-To-End Verification

Required smoke tests:

1. Fresh install from release zip starts on `127.0.0.1:32123`.
2. Update from `0.2.0` to `0.3.0` flips `current.json`.
3. Health success updates `last-known-good.json`.
4. Broken release rolls back to previous version.
5. Offline receipt queue persists and flushes on a future launch.
6. Hash mismatch never changes `current.json`.

## Acceptance Criteria

- Client can open the same shortcut after update.
- Client machine does not require Git, GitHub CLI, or GitHub credentials.
- Local `.env`, `output/`, `.launcher/`, and caches survive updates.
- A failed update does not destroy the last working version.
- Maintainer can identify remote success by `health_ok` receipt.
- Maintainer can identify failures by `failed` or `rolled_back` receipts.
- If receipt service is offline, the app still launches and retries receipts on a future launch.

## First Implementation Order

1. Implement release-mode paths and package shape.
2. Implement side-by-side launcher without remote receipts.
3. Add rollback and health validation.
4. Add local receipt queue.
5. Add remote receipt POST.
6. Add GitHub Actions release workflow.
7. Run a full install/update/rollback smoke test.
