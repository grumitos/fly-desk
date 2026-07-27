# Fly Desk Application Deployment

This repository publishes only the Fly Desk product. Caddy, systemd, users, firewall, the release engine, and its wrappers belong to `grumitos/vps-platform`.

## Production Contract

- Canonical repository: `grumitos/fly-desk`.
- Deployable branch: `main`; the workflow requires an exact 40-character SHA reachable from `origin/main`.
- Atomic current path: `/opt/fly-desk`.
- Immutable releases: `/opt/apps/fly-desk/releases/<sha>`.
- Persistent state: `/var/lib/fly-desk`; it is never part of the artifact or rollback.
- Web: `fly-desk.service`, `127.0.0.1:8100`.
- Search: `fly-desk-search.service`, `127.0.0.1:8101`.
- Redirects: `fly-desk-redirect.service`, `127.0.0.1:8102`.
- Chrome/CDP: `fly-desk-chrome.service`, `127.0.0.1:9222`; a normal deployment does not restart it.
- Public endpoint: `https://fly-desk.pages.dev/`.

## Local Gate

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run build
bun run test
```

## Deployment Through GitHub Actions

The `.github/workflows/deploy-vps.yml` workflow has two modes:

- `deploy`: verifies that the exact SHA belongs to `main`, runs the gate,
  creates a deterministic tar archive with a single `app/` root, calculates
  its SHA-256 digest, and stores it as a short-lived GitHub artifact. A fresh
  production-environment job downloads and verifies that digest before it
  configures the SSH identity, streams the archive through the forced `upload`
  command, activates it with `deploy`, and confirms it with `verify`.
- `rollback`: activates an existing immutable release by SHA through the
  forced `rollback` command and confirms it with `verify`.

The workflow does not install units, modify Caddy, transmit a deployment
script over SSH, write the canonical incoming spool directly, or invoke
`sudo`. Its complete remote command surface is:

```text
upload <sha40> <sha256>
deploy <sha40> <sha256>
verify <sha40>
rollback <sha40>
```

The engine takes a lock shared with maintenance, validates the archive digest and structure, prepares the candidate as the runtime user, switches the symlink, restarts web/search/redirect, runs health checks, and restores the previous current release if activation fails.

Required secrets:

- `VPS_HOST`
- `VPS_PORT`, optional; defaults to `22`
- `VPS_USER`, the CI identity dedicated to Fly Desk
- `VPS_SSH_KEY_B64`
- `VPS_SSH_KNOWN_HOSTS_B64`, obtained through a trusted channel

The job uses `BatchMode`, `IdentitiesOnly`, and `StrictHostKeyChecking`; it does
not allow `ssh-keyscan`. The CI identity is restricted to those forced
commands, receives no interactive shell, and cannot submit arbitrary commands.
The dispatcher alone invokes the fixed wrapper under the platform policy. The
forced upload command owns placement in the canonical incoming spool.
Repository build and test code runs only in the secretless build job. The
credentialed delivery job does not check out or execute repository code.

The release source comes from `git archive` at the requested main SHA. The
workflow adds only the frontend output built from that checkout and the exact
`REVISION`, then normalizes archive ordering, timestamps, ownership, and gzip
metadata. Unrelated generated or untracked working-tree files cannot enter the
release.

## Release Preparation

`deploy/prepare-release.sh` runs `bun install --frozen-lockfile` with the system Bun installation and requires the compiled frontend to be present. The engine runs it as the runtime user, never as root.

Real application variables live in `/etc/fly-desk.env`. `.env.example` documents names and defaults, not values. SQLite databases, caches, sessions, the Chrome profile, and mutable artifacts must remain under `/var/lib/fly-desk`.

During a host migration, do not copy the Chrome profile or session SQLite database to preserve Click and Book Plus. Regenerate its token from credentials/TOTP and use CDP only as a fallback, as described in [`CBPLUS_SESSION_RECOVERY.md`](./CBPLUS_SESSION_RECOVERY.md). The Agil session, which uses a different model, is recovered through [`AGIL_SESSION_RECOVERY.md`](./AGIL_SESSION_RECOVERY.md).

## Verification and Rollback

After deployment, the wrapper requires local health on ports `8100`, `8101`, and `8102`. The workflow accepts a public `200` response or the expected regional `403` from runners outside Peru.

For changes to search, cancellation, redirects, providers, or sessions/cache, run `Fly Desk Production Smoke` in `vps-platform` afterward and wait for its result.

To roll back, open `Deploy VPS`, choose `mode=rollback`, and provide the exact
SHA of an existing release. If Actions is unavailable, stop and restore the
dedicated forced-command CI path through the platform recovery procedure.
Neither `ops` nor `deploy` may invoke an application release wrapper manually;
do not copy releases or change `/opt/fly-desk` directly.
