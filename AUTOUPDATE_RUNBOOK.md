# Fly Desk Autoupdate Runbook

This runbook is for publishing, monitoring, and recovering client-final Fly Desk updates.

The preferred update channel is the VPS gateway documented in [`VPS_UPDATE_CHANNEL.md`](./VPS_UPDATE_CHANNEL.md). The public GitHub release repo is only a fallback if package access control is not needed.

## Release Checklist

Before publishing:

```powershell
git switch main
git pull --ff-only origin main
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run build
bun run test
```

Then:

1. Confirm `package.json` has the target version.
2. Generate the release package.
3. Verify the zip does not contain `.env`, `.git`, `src`, `test`, `node_modules`, `output`, or `.launcher`.
4. Compute SHA-256.
5. Upload zip to the VPS release directory.
6. Upload `latest.json.tmp` to the VPS.
7. Atomically promote `latest.json.tmp` to the channel's `latest.json`.
8. Download `latest.json` from the VPS with a test client token and verify it points to the published zip.
9. Download the zip from the VPS with the same token and verify SHA-256.
10. Run a temporary install smoke test.

## VPS Release Flow

Recommended VPS paths:

```text
/srv/fly-desk-updates/releases/<version>/
/srv/fly-desk-updates/channels/stable/latest.json
/srv/fly-desk-updates/receipts/events.ndjson
/srv/fly-desk-updates/clients/clients.json
```

Release upload sequence:

```powershell
$version = "0.3.0"
$zip = "artifacts\release\fly-desk-windows-x64-v$version.zip"
$manifest = "artifacts\release\latest.json"

ssh flydesk-updates "mkdir -p /srv/fly-desk-updates/releases/$version /srv/fly-desk-updates/channels/stable"
scp $zip "flydesk-updates:/srv/fly-desk-updates/releases/$version/"
scp $manifest "flydesk-updates:/srv/fly-desk-updates/channels/stable/latest.json.tmp"
ssh flydesk-updates "mv /srv/fly-desk-updates/channels/stable/latest.json.tmp /srv/fly-desk-updates/channels/stable/latest.json"
```

The final `mv` is intentional: clients should never read a partially uploaded manifest.

Verify from any workstation that has a test token:

```powershell
$headers = @{ "X-FlyDesk-Update-Token" = $env:FLY_DESK_TEST_UPDATE_TOKEN }
$manifest = Invoke-RestMethod -Uri "https://updates.example.com/fly-desk/latest.json" -Headers $headers
$zipPath = Join-Path $env:TEMP "fly-desk-release-check.zip"
Invoke-WebRequest -Uri $manifest.package.url -Headers $headers -OutFile $zipPath
$actual = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $manifest.package.sha256) { throw "Release hash mismatch" }
```

## Client Token Operations

Create one token per installation. Store only its SHA-256 on the VPS and store the raw token only on the client.

Client local config:

```text
C:\fly-desk\.launcher\update-client.json
```

Expected shape:

```json
{
  "baseUrl": "https://updates.example.com/fly-desk",
  "channel": "stable",
  "token": "per-client random token"
}
```

To revoke a client:

1. Set the client to disabled in the VPS registry.
2. Reload the update gateway.
3. Confirm `GET /fly-desk/latest.json` returns HTTP `401` or `403` for that token.

Revocation blocks future updates but does not disable the already-installed local app.

## Local Smoke Test

Use a temp install root, not the development checkout:

```powershell
$installRoot = Join-Path $env:TEMP "fly-desk-install-smoke"
Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
```

Install the bootstrap and one release, then run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$installRoot\tools\start-fly-desk.ps1"
Invoke-RestMethod -Uri "http://127.0.0.1:32123/api/health"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$installRoot\tools\stop-fly-desk.ps1"
```

Expected:

- start exits `0`
- `/api/health` returns HTTP 200
- stop releases port `32123`

## Monitoring Delivery

Do not treat a zip download as a successful update. The remote success signal is:

```text
eventType = health_ok
version = target version
status = success
```

Update states:

- `download_verified`: package arrived and hash matched
- `activated`: local `current.json` now points to the new version
- `health_ok`: new version started and answered `/api/health`
- `rolled_back`: updater reverted to the previous version
- `failed`: updater could not continue

For a client-final rollout, wait for `health_ok` receipts from expected installations. If there is no receipt, the client may be offline, may not have opened Fly Desk yet, may have a revoked token, or receipt delivery may be queued locally.

On the VPS, the simple file-backed receipt store is:

```text
/srv/fly-desk-updates/receipts/events.ndjson
```

Example query on the VPS:

```bash
grep '"eventType":"health_ok"' /srv/fly-desk-updates/receipts/events.ndjson | grep '"version":"0.3.0"'
```

## Receipt Privacy Rules

Receipts may include:

- random `installId`
- event id
- app id
- version
- previous version
- release id
- bootstrap version
- timestamp
- event type
- status
- error code

Receipts must not include:

- `.env` values
- provider credentials
- TOTP secrets
- passenger data
- search data
- browser profile paths
- Windows username
- machine name

## Normal Client Update Flow

1. Client opens `Abrir Fly Desk.vbs`.
2. Bootstrap checks manifest.
3. If no update is available, it starts current version.
4. If update is available, it downloads and verifies zip.
5. It extracts to `.launcher/staging/<version>`.
6. It validates `release.json`, executable, and frontend assets.
7. It moves the release to `app/releases/<version>`.
8. It updates `app/current.json`.
9. It starts the new version.
10. It calls `/api/health`.
11. It writes `last-known-good.json`.
12. It sends or queues `health_ok`.

## Failure Handling

### Manifest unavailable

Expected behavior:

- log failure
- emit or queue `failed` with `manifest_unavailable`
- start current version

Operator action:

- check update channel availability
- no client intervention needed if current version starts

### Invalid manifest

Expected behavior:

- reject manifest
- do not download
- start current version

Operator action:

- fix `latest.json`
- do not ask client to reinstall

### Download failure

Expected behavior:

- keep current version
- retry next launch

Operator action:

- check asset URL and CDN/GitHub availability

### SHA-256 mismatch

Expected behavior:

- delete downloaded zip
- keep current version
- emit `failed` with `hash_mismatch`

Operator action:

- stop rollout immediately
- verify whether the manifest SHA or uploaded zip is wrong
- publish a corrected higher version instead of silently replacing an existing released zip

### Extract or validation failure

Expected behavior:

- delete staging
- keep current version
- emit `failed` with `package_invalid`

Operator action:

- inspect package contents
- publish a corrected higher version

### New version health check fails

Expected behavior:

- stop failed new process
- restore `current.json` from `last-known-good.json`
- start previous version
- emit `rolled_back`

Operator action:

- check logs under `.launcher/logs/`
- publish a hotfix version greater than the failed version
- leave the bad version in the release history for audit, but move `latest.json` to the hotfix

### Previous version also fails

Expected behavior:

- show popup with log path
- leave server stopped
- emit or queue `failed` with `rollback_failed`

Operator action:

- ask client for `.launcher/logs/` and `app/current.json`
- use the manual recovery steps below

### Receipt endpoint unavailable

Expected behavior:

- update still proceeds
- receipt remains in `.launcher/receipts/pending/`
- next launch retries

Operator action:

- fix receipt endpoint
- ask client to open Fly Desk again after endpoint recovers

### Token revoked or invalid

Expected behavior:

- updater cannot fetch manifest or zip
- current local version still launches
- local receipt queue remains pending

Operator action:

- confirm whether the client should still receive updates
- re-enable the token or provision a new token
- ask client to open Fly Desk again after token is restored

## Manual Recovery

On the client machine, inspect:

```powershell
Get-Content C:\fly-desk\app\current.json
Get-Content C:\fly-desk\.launcher\last-known-good.json
Get-ChildItem C:\fly-desk\app\releases
Get-ChildItem C:\fly-desk\.launcher\logs
```

Manual rollback:

```powershell
$root = "C:\fly-desk"
$good = Get-Content "$root\.launcher\last-known-good.json" -Raw | ConvertFrom-Json
$current = @{
  version = $good.version
  releaseDir = $good.releaseDir
  activatedAt = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json
Set-Content -LiteralPath "$root\app\current.json" -Value $current -Encoding UTF8
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$root\tools\start-fly-desk.ps1"
```

Force skip update for one launch:

```powershell
$env:FLY_DESK_SKIP_SELF_UPDATE = "1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\fly-desk\tools\start-fly-desk.ps1"
Remove-Item Env:FLY_DESK_SKIP_SELF_UPDATE
```

## Rollout Policy

Recommended rollout rhythm:

1. Publish to update channel.
2. Test on one internal install.
3. Wait for `health_ok`.
4. Ask one friendly client to open Fly Desk.
5. Wait for `health_ok`.
6. Roll out to everyone.

If any install emits `rolled_back`, pause rollout and publish a hotfix. Do not replace an already published zip for the same version.

## Public GitHub Fallback

The public update repo is acceptable only when the main goal is protecting source code and GitHub credentials, and public access to the compiled package is acceptable.

The updater contract does not need to change. Only `baseUrl`, `package.url`, and receipt URL change between the VPS and public fallback.
