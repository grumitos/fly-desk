# Fly Desk Frontend

The React UI of Fly Desk. The root workspace manages dependencies, linting, and builds with Bun.

## Commands

- `bun run build:frontend` from the repository root generates `frontend/dist`.
- `bun run build` from the repository root runs the same frontend build.
- `bun run lint` from the repository root delegates to `bun run --filter './frontend' lint`.
- `bun run --filter './frontend' typecheck` runs only the frontend typecheck.
- `bun run --filter './frontend' lint` runs only frontend ESLint.

The gates a change must pass are listed in [`AGENTS.md`](../AGENTS.md), "Verification".

The production bundle is created by `scripts/build-frontend.ts` with `Bun.build` and `bun-plugin-tailwind`; it also writes the self-hosted font faces into the page and copies `frontend/public` to `frontend/dist`.

The dedicated calendar/matrix view, multi-city search, and `reprice` are not exposed in React. Flexible round-trip search uses `/api/matrix`, but the frontend normalizes its cells into a results list.

The visual identity and its catalogues are described in [`docs/FRONTEND_IDENTITY.md`](../docs/FRONTEND_IDENTITY.md).
