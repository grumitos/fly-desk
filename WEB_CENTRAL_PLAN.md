# Fly Desk Web Central Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. This plan supersedes the full-local-client direction when the goal is serving an agency from a VPS.

**Goal:** Move Fly Desk toward a VPS-hosted web app for an agency with at least two users, keeping Costamar fully server-side and testing whether Agilsmart can also live centrally on the VPS.

**Architecture:** The VPS hosts the web UI, API, authentication, users, jobs, Costamar integration, and ideally one persistent Chrome/Agilsmart session for the agency. The local updater/agent work remains useful as fallback, but the preferred direction is central web service first. If Agil cannot run reliably on the VPS, the fallback is a minimal local Agil agent per workstation.

**Tech Stack:** Bun server, React frontend, HTTPS on VPS, cookie-based auth, SQLite for MVP persistence on one VPS, persistent Chrome profile for Agil spike, Costamar server-side provider, optional local agent fallback.

---

## Current Direction

The previous autoupdater plan solves distribution for a local app. The new product direction is different:

```text
Browser users
  -> VPS Fly Desk web app
  -> Costamar directly from VPS
  -> Agilsmart from VPS if spike succeeds
  -> local Agil agent only if VPS Agil fails
```

This is better for a small agency because:

- one VPS deployment updates all users
- two or more users can share the same web app
- Costamar is already portable enough for server-side use
- the agency uses one shared Agil account
- the local install can shrink or disappear if Agil works on the VPS

## Primary Product Model

Start with one agency, but model the database with `agencyId` so the system can grow.

Entities:

```text
agencies
users
sessions
search_jobs
provider_runs
quotations
audit_events
agil_sessions
```

Roles:

- `admin`: manages users, sees provider health, can reset sessions
- `agent`: searches, compares, quotes, opens provider paths

No public signup for the MVP. Users are created by an admin or by a maintainer script.

## Authentication

Use Fly Desk users even if Agil uses a shared agency account.

MVP auth:

- email + password
- password hashes with Argon2id or bcrypt
- cookie session with `HttpOnly`, `Secure`, `SameSite=Lax`
- HTTPS required
- login rate limit
- logout endpoint
- inactive users cannot log in
- audit `lastLoginAt`

Do not use a shared app password. Do not expose `FLY_DESK_API_TOKEN` to the browser as user auth.

Suggested tables:

```text
users
  id
  agencyId
  email
  passwordHash
  role
  active
  createdAt
  updatedAt
  lastLoginAt

sessions
  id
  userId
  agencyId
  tokenHash
  expiresAt
  createdAt
  lastSeenAt
```

## Provider Routing

Costamar:

- runs on the VPS
- uses server-side Costamar credentials/session config
- can run with normal queue concurrency
- does not depend on client browser state

Agilsmart:

- first attempt is central VPS Chrome session
- one shared agency Agil account
- persistent Chrome profile on VPS
- run searches through the existing Agil integration after adapting paths/env
- serialize Agil jobs at first to avoid session collision
- increase concurrency only after evidence

Fallback:

- if Agil central fails because of datacenter IP, fingerprinting, 2FA churn, or Chrome instability, add a minimal local Agil agent
- the web app still stays central
- agents connect outbound to the VPS with per-device tokens

## Agil On VPS Spike

Do this before building a local agent.

Success criteria:

1. Chrome runs on the VPS with a persistent user data directory.
2. Maintainer can log in to Agilsmart manually through RDP, noVNC, or another controlled remote UI.
3. Fly Desk can extract or use that Agil session.
4. A real Agil search succeeds from the VPS.
5. Session survives restart of the Bun process.
6. Session ideally survives VPS reboot.
7. Two web users can submit searches without breaking the shared Agil session, even if Agil jobs are serialized.
8. Provider health clearly reports when Agil needs manual relogin.

Failure criteria:

- Agil blocks VPS/datacenter IP
- repeated 2FA/captcha makes operation impractical
- session dies after every restart
- shared session cannot tolerate normal agency use

If the spike fails, keep Costamar on VPS and implement the local Agil agent fallback.

## VPS Runtime

Minimum production shape:

```text
VPS
  Caddy or Nginx for HTTPS
  Fly Desk Bun server
  persistent data directory
  persistent Chrome profile for Agil
  SQLite DB for MVP
  logs and backups
```

Environment:

```text
HOST=127.0.0.1
PORT=32123
FLY_DESK_PUBLIC_BASE_URL=https://flydesk.example.com
FLY_DESK_AUTH_SECRET=<random secret>
FLY_DESK_SESSION_DB_PATH=/srv/fly-desk/data/fly-desk.sqlite
FLY_DESK_LOCATION_SUGGESTION_DB_PATH=/srv/fly-desk/data/location-suggestions.sqlite
COSTAMAR_*
AGIL_*
```

Reverse proxy exposes only HTTPS. Bun can stay bound to loopback behind the proxy.

SQLite is acceptable for MVP on one VPS and one agency. Move to Postgres when multi-agency, multi-instance, or stronger reporting becomes necessary.

## Job Model

All searches become server-owned jobs.

```text
search_jobs
  id
  agencyId
  userId
  requestJson
  status
  createdAt
  updatedAt
  completedAt

provider_runs
  id
  jobId
  providerId
  assignedWorkerId
  status
  startedAt
  completedAt
  warningsJson
  errorCode
```

Provider strategy:

- Costamar can run directly on the VPS.
- Agil central runs through the VPS Chrome session.
- Agil fallback local agent runs through an outbound connection from an agency workstation.

The UI should show partial results and provider status. If Agil is offline, users still get Costamar results and a clear Agil unavailable state.

## Security Boundaries

- Browser users authenticate with Fly Desk credentials.
- Provider credentials stay server-side.
- Agil Chrome profile lives only on VPS or on the fallback agent machine.
- User search requests are scoped by `agencyId`.
- Admin-only pages show provider/session health.
- Logs must not include passwords, TOTP secrets, Costamar tokens, Agil cookies, or session tokens.

## Implementation Phases

### Phase 0: Agil VPS Feasibility Spike

- Provision VPS environment with Chrome and persistent profile.
- Log in to Agil manually.
- Run current Fly Desk backend against that profile.
- Verify real Agil search, process restart, and VPS reboot behavior.
- Record result in `docs/AGIL_VPS_SPIKE.md`.

Decision gate:

- If pass: continue with web central.
- If fail: continue web central plus local Agil agent fallback.

### Phase 1: Web Auth Foundation

- Add user/session persistence.
- Add login/logout routes.
- Protect operational API routes.
- Add admin-created users, no public signup.
- Add audit events for login/logout/search creation.

### Phase 2: Central Web Deployment

- Run Fly Desk behind HTTPS on VPS.
- Serve React UI from the VPS.
- Move from local-only assumptions to authenticated remote users.
- Keep loopback-only endpoints loopback-only unless explicitly replaced.

### Phase 3: Costamar Server Mode

- Configure Costamar credentials on VPS.
- Validate exact, range, matrix, quotation, and redirect flows.
- Add provider health and warmup visibility.

### Phase 4: Agil Central Mode

- Use the spike result to productionize Agil on VPS.
- Add serialized Agil queue.
- Add relogin-needed status.
- Add admin-facing Agil health endpoint.

### Phase 5: Local Agil Agent Fallback

Only implement if the VPS Agil spike fails or proves unstable.

- Minimal local agent, not full app.
- Outbound connection to VPS.
- Per-device token.
- Agil jobs assigned to online agent.
- Same web UI and job model.

### Phase 6: Operations

- Backups for SQLite/data.
- Deploy runbook.
- Provider health dashboard.
- Log retention.
- Manual relogin procedure for Agil.
- Smoke tests after deploy.

## What Happens To The Autoupdater Work

The autoupdater remains useful for:

- distributing a minimal local Agil agent if needed
- distributing bootstrap tools
- emergency local installs

It is no longer the main product delivery mechanism if the VPS web app succeeds.

## Open Decisions

- VPS OS: Windows may be easier for visible Chrome/Agil operation; Linux may be cleaner but needs more setup.
- Auth library vs small custom session implementation.
- SQLite vs Postgres after MVP.
- Whether Agil central uses one browser profile or a small pool of profiles.
- Whether users can choose provider routing or only see automatic fallback.

## Acceptance Criteria For The New Direction

- Two agency users can log in from separate machines.
- Both users can search Costamar from the web app.
- Agil works from the VPS, or the system clearly falls back to local agent plan.
- Search jobs are scoped to the agency and user.
- Users do not need GitHub, Git, or local full Fly Desk install.
- Admin can see provider health.
- If Agil session expires, the UI says relogin is needed instead of failing silently.
