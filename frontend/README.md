# Fly Desk Frontend

React UI for Fly Desk. The root workspace owns installs and builds with Bun.

## Commands

- `bun run build:frontend` from the repository root builds `frontend/dist`.
- `bun --filter frontend run lint` runs the frontend ESLint config.

The production bundle is created by `scripts/build-frontend.ts` with `Bun.build` and `bun-plugin-tailwind`.
