# Fly Desk Application Deployment

This repository publishes only the Fly Desk product. Caddy, systemd, users,
firewall, the release engine and its wrappers belong to `grumitos/vps-platform`.

## Production Contract

- Canonical repository: `grumitos/fly-desk`.
- Deployable branch: `main`; the workflow requires an exact 40-character SHA
  reachable from `origin/main`.
- Atomic current path: `/opt/fly-desk`.
- Immutable releases: `/opt/apps/fly-desk/releases/<sha>`.
- Persistent state: `/var/lib/fly-desk`; never part of an artifact or a
  rollback.
- Web: `fly-desk.service`, `127.0.0.1:8100`.
- Search runner: `fly-desk-search.service`, `127.0.0.1:8101`.
- Redirects: `fly-desk-redirect.service`, `127.0.0.1:8102`.
- Chrome/CDP: `fly-desk-chrome.service`, `127.0.0.1:9222`; a deployment does
  not restart it.
- Public endpoint: `https://fly-desk.pages.dev/`.

## Local Gate

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run build
bun run test
```

`bun run test` runs the unit tests and then the end-to-end suite; see
[`TESTING.md`](./TESTING.md).

## Deployment Through GitHub Actions

`.github/workflows/deploy-vps.yml` has two modes:

- `deploy`: verifies that the exact SHA belongs to `main`, runs the gate,
  builds a deterministic tar archive with a single `app/` root, computes its
  SHA-256 digest and stores it as a short-lived artifact. A separate
  production-environment job downloads it, verifies the digest, configures the
  pinned SSH identity, streams the archive through the forced `upload` command,
  activates it with `deploy` and confirms it with `verify`.
- `rollback`: activates an already installed release by SHA through the forced
  `rollback` command and confirms it with `verify`.

The workflow never installs units, edits Caddy, sends a script over SSH, writes
the canonical incoming spool or calls `sudo`. Its entire remote command
surface is:

```text
upload <sha40> <sha256>
deploy <sha40> <sha256>
verify <sha40>
rollback <sha40>
```

The release engine takes a lock shared with maintenance, validates the archive
digest and structure, prepares the candidate as the build user, switches the
symlink, restarts web, search and redirect, checks their health, and restores
the previous release if activation fails.

Required secrets: `VPS_HOST`, `VPS_PORT` (optional, defaults to `22`),
`VPS_USER` (the Fly Desk CI identity), `VPS_SSH_KEY_B64` and
`VPS_SSH_KNOWN_HOSTS_B64` (obtained through a trusted channel). The job uses
`BatchMode`, `IdentitiesOnly` and `StrictHostKeyChecking`, never
`ssh-keyscan`. The CI identity is restricted to the forced commands above;
build and test code runs only in the secretless build job, and the
credentialed job does not check out or execute repository code.

The release source is `git archive` of the requested SHA plus the frontend
built from that checkout and a `REVISION` file; ordering, timestamps,
ownership and gzip metadata are normalized, so untracked files cannot enter a
release.

## Release Preparation

A release installs no packages. The runtime imports only Bun and Node
built-ins, the frontend arrives built in `frontend/dist`, and `bunfig.toml`
disables Bun's install-on-import (`[install] auto = "disable"`), so importing a
package the release does not carry fails instead of fetching it from the
registry. Playwright, the one package the source still names, is a development
dependency: the end-to-end suite and the Click and Book Plus browser fallback
on a workstation use it.

`deploy/prepare-release.sh` runs as the platform's build user with the system
Bun. It refuses a `package.json` that declares runtime `dependencies`, and
requires `frontend/dist/index.html`.

Real configuration lives in `/etc/fly-desk.env` (`.env.example` documents the
names and defaults, never values). The Click and Book Plus token file
`/etc/fly-desk.cbplus-token` is written by the platform; see
[`CBPLUS_SESSION_RECOVERY.md`](./CBPLUS_SESSION_RECOVERY.md). SQLite
databases, caches, the Agil identity and the Chrome profile stay under
`/var/lib/fly-desk`.

On a new host, never copy the Chrome profile, the session database or a token.
Click and Book Plus comes back with the next platform renewal; Agilsmart is
recovered through [`AGIL_SESSION_RECOVERY.md`](./AGIL_SESSION_RECOVERY.md).

## Verification and Rollback

After activation the engine requires local health on `8100`, `8101` and
`8102`. The workflow's public smoke accepts `200` or the expected regional
`403` from runners outside Peru.

For changes that touch search, cancellation, redirects, providers, sessions or
caches, run `Fly Desk Production Smoke` in `vps-platform` afterwards and wait
for its result.

To roll back, run `Deploy VPS` with `mode=rollback` and the exact SHA of an
installed release. If Actions is unavailable, restore the forced-command CI
path through the platform recovery procedure. Neither `ops` nor `deploy` may
invoke an application release wrapper by hand, copy releases or move
`/opt/fly-desk`.
