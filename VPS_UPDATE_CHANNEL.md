# Fly Desk VPS Update Channel

This document describes the preferred final-client update channel when a VPS is available.

## Purpose

The VPS becomes the only public update surface for client machines:

```text
private GitHub repo
  -> GitHub Actions builds release zip
  -> GitHub Actions uploads zip + manifest to VPS
  -> client updater authenticates to VPS
  -> VPS serves manifest, zip, and receives receipts
```

The client machine never needs Git, GitHub CLI, GitHub credentials, or a maintainer token.

## Security Model

- Source code stays in `grumitos/fly-desk`.
- GitHub Actions may have an SSH key for the VPS, stored as a GitHub Actions secret.
- The VPS stores release zips and manifests.
- Each client installation has its own update token.
- The updater sends the token in an HTTP header, not in a URL.
- The VPS can revoke one client without affecting other clients.
- The updater verifies every zip with SHA-256 before activation.
- The updater sends receipts only after local events occur.

Recommended client header:

```text
X-FlyDesk-Update-Token: <per-client random token>
```

Do not use query string tokens for normal operation because URLs are easier to leak through browser history, reverse proxy logs, and screenshots.

## VPS Layout

Recommended filesystem layout:

```text
/srv/fly-desk-updates/
  releases/
    0.3.0/
      fly-desk-windows-x64-v0.3.0.zip
      manifest-package.json
  channels/
    stable/
      latest.json
  receipts/
    events.ndjson
  clients/
    clients.json
  logs/
```

`clients.json` is owned by the VPS update gateway and should not be served as a static file.

Example client registry:

```json
{
  "clients": [
    {
      "clientId": "agency-main-pc",
      "tokenSha256": "sha256 of the client token",
      "enabled": true,
      "channel": "stable",
      "notes": "Main agency workstation"
    }
  ]
}
```

## HTTP Contract

All endpoints require HTTPS.

### GET `/fly-desk/latest.json`

Headers:

```text
X-FlyDesk-Update-Token: <token>
```

Success response:

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
    "url": "https://updates.example.com/fly-desk/releases/0.3.0/fly-desk-windows-x64-v0.3.0.zip",
    "sha256": "64 lowercase hex characters",
    "sizeBytes": 12345678
  },
  "receipts": {
    "enabled": true,
    "url": "https://updates.example.com/fly-desk/receipts"
  },
  "notes": "Support-facing release notes."
}
```

### GET `/fly-desk/releases/<version>/<zip>`

Headers:

```text
X-FlyDesk-Update-Token: <token>
```

The VPS should return the zip only if the token is enabled for the requested channel.

### POST `/fly-desk/receipts`

Headers:

```text
Content-Type: application/json
X-FlyDesk-Update-Token: <token>
```

Body:

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

Success response: HTTP `202`.

The gateway stores one JSON object per line in `receipts/events.ndjson` or forwards to a database in a future phase.

## Client Configuration

The first install should write local update config:

```json
{
  "baseUrl": "https://updates.example.com/fly-desk",
  "channel": "stable",
  "token": "per-client random token"
}
```

Recommended path:

```text
C:\fly-desk\.launcher\update-client.json
```

This file is local-only and must not be committed, zipped into releases, or sent in support bundles unless deliberately redacted.

The updater may also allow these environment overrides for support:

```text
FLY_DESK_UPDATE_BASE_URL
FLY_DESK_UPDATE_TOKEN
FLY_DESK_UPDATE_CHANNEL
FLY_DESK_SKIP_SELF_UPDATE=1
```

## GitHub Actions To VPS

Store these secrets in the private repo:

```text
FLY_DESK_VPS_HOST
FLY_DESK_VPS_USER
FLY_DESK_VPS_SSH_KEY
FLY_DESK_UPDATE_BASE_URL
```

Release workflow outline:

1. Build and test in GitHub Actions.
2. Generate `fly-desk-windows-x64-vX.Y.Z.zip`.
3. Compute SHA-256.
4. Generate `latest.json`.
5. Upload zip to `/srv/fly-desk-updates/releases/X.Y.Z/`.
6. Upload manifest to a temporary file.
7. Atomically move temporary manifest to `/srv/fly-desk-updates/channels/stable/latest.json`.
8. Call the VPS health endpoint.

The manifest move must be atomic so clients never read a half-written manifest.

## Revocation

To revoke a client:

1. Set the client's `enabled` field to `false` in `clients.json`.
2. Reload or restart the update gateway.
3. Confirm `GET /fly-desk/latest.json` returns HTTP `401` or `403` for that token.

The client's already-installed Fly Desk can still run. Revocation only prevents future downloads and receipt submission.

## VPS Hardening Checklist

- HTTPS only.
- Firewall allows `80` and `443`; SSH restricted where possible.
- Update gateway does not log raw tokens.
- Tokens are stored hashed server-side.
- Release zip directory is not listable.
- Receipts endpoint has a request body size limit.
- Gateway rejects unknown `appId`.
- Gateway rejects disabled clients.
- Gateway rate-limits repeated auth failures.
- VPS backups include `channels/`, `releases/`, `clients/`, and receipts.

## Failure Model

- VPS offline: client launches current local version and queues receipts.
- Token revoked: client launches current local version, cannot download updates.
- Manifest broken: client rejects manifest and launches current version.
- Zip corrupted: client rejects hash and launches current version.
- New version unhealthy: client rolls back to last known good release.

## Why This Is Preferred

Compared with a public GitHub release repo, the VPS gives:

- per-client access control
- simple revocation
- private package downloads
- first-party receipt collection
- no GitHub dependency on client machines

The updater contract stays the same if the VPS is replaced in a future phase. Only `baseUrl`, manifest URL, and package URLs change.
