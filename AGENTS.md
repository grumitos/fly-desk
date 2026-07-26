# AGENTS

Guidance for agents working on Fly Desk.

## Mandatory Rules

1. Read `README.md`, `docs/REPO_CURRENT_STATE.md`, `docs/DEPLOY_APP.md`, and `docs/FRONTEND_IDENTITY.md` first.
2. Never print or store secrets. This includes `.env` files, cookies, tokens, passwords, TOTP/otpauth values, subscription keys, API tokens, and browser sessions.
3. This repository owns the Fly Desk product, backend, frontend, CI, and application deployment. Shared Caddy, systemd, firewall, certificates, geofencing, and daily maintenance belong to `D:\Dev\VPS\vps-platform`.
4. Bun is the supported package manager. Do not add `package-lock.json`, `pnpm-lock.yaml`, or `yarn.lock`.
5. Application deployment must restart `fly-desk.service`, restart `fly-desk-search.service` and `fly-desk-redirect.service` when they exist, and preserve `fly-desk-chrome.service` unless explicitly instructed otherwise.
6. Cloudflare Pages, Pages bindings, public geofencing, and shared operational secrets belong to `vps-platform`; do not manage or document them from this repository.

## Verification

For code or runtime changes:

```powershell
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run build
bun run test
```

For documentation-only changes:

```powershell
git diff --check
rg -n "\]\([^)]*\.md\)" README.md docs frontend/README.md AGENTS.md
```
