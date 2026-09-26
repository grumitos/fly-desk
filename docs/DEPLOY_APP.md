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

Run the gates in [`AGENTS.md`](../AGENTS.md), "Verification", before a change
reaches `main`; the pull request's required checks run the same ones.

## Deployment Through GitHub Actions

`.github/workflows/deploy-vps.yml` has two modes:

- `deploy`: verifies that the exact SHA belongs to `main`, installs and builds
  it, packs a deterministic tar archive with a single `app/` root
  (`scripts/pack-release.sh`), computes its SHA-256 digest, smokes the archive
  (`scripts/release-smoke.ts`, below) and stores it as a one-day artifact.
  The revision's typecheck, lint and end-to-end suite already passed as the
  pull request's required checks, so they are not run again here. A separate
  production-environment job downloads the artifact, verifies the digest,
  configures the pinned SSH identity, streams the archive through the forced
  `upload` command, activates it with `deploy` and confirms it with `verify`.
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
digest and structure, prepares the candidate as the build user
`fly-desk-build`, switches the symlink, restarts web, search and redirect,
checks their health, and restores the previous release if activation fails.

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

The release smoke unpacks the archive into an empty directory, runs its
prepare hook with only the build user's environment, and starts web, search
and redirect from it as their units do, with prewarm off so no provider is
called. It requires each unit's `/api/health`, a sign-in, the signed-in shell
and one of its built assets. The environment carries a `SEARCH_TODAY_OVERRIDE`
that production must ignore and empty numeric settings that must keep their
defaults, and the smoke checks both through the shell's runtime settings and
the session cookie. It also requires the release's capability declaration
(below) to be a regular file of at most 1 KiB that lists `cbplus-token-file`
and nothing but known capabilities; a released `src/**/*.ts` naming
`CBPLUS_TOKEN_FILE`, the literal the platform still detects that capability
by; and an import of an uncarried package to fail instead of downloading it.
The Core quality gate runs the same smoke on every pull request.

## Release Preparation

A release installs no packages. The runtime imports only Bun and Node
built-ins, the frontend arrives built in `frontend/dist`, and `bunfig.toml`
disables Bun's install-on-import (`[install] auto = "disable"`), so importing a
package the release does not carry fails instead of fetching it from the
registry. Playwright, the one package the source names, is a development
dependency: the end-to-end suite and the Click and Book Plus browser fallback
on a workstation use it.

`deploy/prepare-release.sh` runs as `fly-desk-build` with the system Bun, in an
environment that holds only `HOME`, `PATH`, `RELEASE_DIR` and `REVISION`. It
refuses a `package.json` that declares runtime `dependencies`, and
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

## Release Capabilities

`deploy/release-capabilities` is the release's declaration of what its code
does that the platform acts on. `git archive` carries it, like the prepare hook
beside it, to `<release>/deploy/release-capabilities`. It is plain text: one
capability name per line, each matching `[a-z0-9-]+`, with LF line endings and
no comments or blank lines. A name is declared only while the code does what
it says, and the release smoke refuses a name it does not know.

| Capability | What the release does | Proof |
| --- | --- | --- |
| `cbplus-token-file` | The search runner, its workers and the redirect service re-read the Click and Book Plus token from the file named by `CBPLUS_TOKEN_FILE` whenever it changes (`src/provider-context.ts`), so a renewal needs no restart. | `test/e2e/capacity.e2e.ts`, "a renewed Click and Book Plus token file reaches searches and redirects with nothing restarted" |

On a token renewal the platform restarts `fly-desk-search.service` and
`fly-desk-redirect.service` unless the active release has `cbplus-token-file`.
Today it still detects that capability by searching the release's
`src/**/*.ts` for the literal `CBPLUS_TOKEN_FILE`, which is why the release
smoke requires the literal as well. A separate `vps-platform` change switches
the platform to this declaration; from then on, a release that does not declare
`cbplus-token-file`, every release from before this file included, has those
units restarted on every renewal.

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
