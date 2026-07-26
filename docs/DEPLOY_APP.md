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

- `deploy`: verifies that the exact SHA belongs to `main`, runs the gate, creates a tar archive with a single `app/` root, calculates its SHA-256 digest, uploads it to the fixed incoming directory, and calls the versioned platform wrapper.
- `rollback`: activates an existing immutable release by SHA through the same wrapper.

The workflow does not install units, modify Caddy, or transmit a deployment script over SSH. The only privileged application commands are:

```text
/usr/local/bin/vps-release-fly-desk deploy <sha40> <sha256>
/usr/local/bin/vps-release-fly-desk rollback <sha40>
```

The engine takes a lock shared with maintenance, validates the archive digest and structure, prepares the candidate as the runtime user, switches the symlink, restarts web/search/redirect, runs health checks, and restores the previous current release if activation fails.

Required secrets:

- `VPS_HOST`
- `VPS_PORT`, optional; defaults to `22`
- `VPS_USER`, the CI identity dedicated to Fly Desk
- `VPS_SSH_KEY_B64`
- `VPS_SSH_KNOWN_HOSTS_B64`, obtained through a trusted channel

The job uses `BatchMode`, `IdentitiesOnly`, and `StrictHostKeyChecking`; it does not allow `ssh-keyscan`. The CI user must only be able to write to the Fly Desk incoming directory and execute its fixed wrapper with `sudo -n`.

## Release Preparation

`deploy/prepare-release.sh` runs `bun install --frozen-lockfile` with the system Bun installation and requires the compiled frontend to be present. The engine runs it as the runtime user, never as root.

Real application variables live in `/etc/fly-desk.env`. `.env.example` documents names and defaults, not values. SQLite databases, caches, sessions, the Chrome profile, and mutable artifacts must remain under `/var/lib/fly-desk`.

During a host migration, do not copy the Chrome profile or session SQLite database to preserve Click and Book Plus. Regenerate its token from credentials/TOTP and use CDP only as a fallback, as described in [`CBPLUS_SESSION_RECOVERY.md`](./CBPLUS_SESSION_RECOVERY.md). The Agil session, which uses a different model, is recovered through [`AGIL_SESSION_RECOVERY.md`](./AGIL_SESSION_RECOVERY.md).

## Verification and Rollback

After deployment, the wrapper requires local health on ports `8100`, `8101`, and `8102`. The workflow accepts a public `200` response or the expected regional `403` from runners outside Peru.

For changes to search, cancellation, redirects, providers, or sessions/cache, run `Fly Desk Production Smoke` in `vps-platform` afterward and wait for its result.

Before retiring a previous VPS, the smoke must test Click and Book Plus search and `/r/*` after regenerating the token on the new host. A `200` health response or a locally usable token is not sufficient on its own.

To roll back, open `Deploy VPS`, choose `mode=rollback`, and provide the exact SHA of an existing release. If Actions is unavailable, use the wrapper through the operational access documented by the platform; do not copy releases with `rsync` or manually change `/opt/fly-desk`.
