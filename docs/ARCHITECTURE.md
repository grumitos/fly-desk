# Architecture

## Overview

Fly Desk is a local-first Node.js/TypeScript workspace for travel agents. The app runs a single HTTP server that serves both static frontend assets and backend APIs.

Main runtime layers:

- HTTP server: `src/server.ts`
- Route handling and API composition: `src/http-router.ts`
- Domain logic: `src/core/*`
- Provider adapters: `src/local-agil.ts`, `src/local-costamar.ts`
- Provider context normalization and token/session discovery: `src/provider-context.ts`
- In-memory jobs/sessions/purchase-path store: `src/session-store.ts`
- Runtime singleton wiring: `src/runtime.ts`

## Request Lifecycle

1. `createServer()` receives the request.
2. Static assets (`public/*`) are served directly.
3. API requests are proxied to `routeRequest()` in `src/http-router.ts`.
4. Router normalizes input and dispatches to provider adapters.
5. Progressive updates are persisted in `SearchSessionStore` and exposed via polling endpoints.

## Data and State

- Search and matrix jobs are in-memory only.
- Purchase paths are rewritten to local relay URLs (`/r/:id`) and resolved from store.
- Location suggestions are cached per session with TTL and max entries.
- Temporary browser artifacts are tracked and periodically cleaned.

## Security Baselines

- Loopback host is default bind.
- Local-only endpoints enforce loopback host checks.
- JSON request body size and read timeout are capped at server edge.
- Costamar tokenized redirects use a local relay response with `Referrer-Policy: no-referrer`.
- Temporary browser/session copies use hardened filesystem permissions where possible.

## Tooling Baselines

- TypeScript strict mode with `npm run typecheck`
- ESLint for `src/` and `test/` via `npm run lint`
- Prettier for formatting via `npm run format` / `npm run format:check`
- GitHub Actions CI (`.github/workflows/ci.yml`) runs typecheck, lint, and tests
