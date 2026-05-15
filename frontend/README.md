# Fly Desk Frontend

React UI activa de Fly Desk. El workspace raiz controla dependencias, lint y builds con Bun.

## Commands

- `bun run build:frontend` desde la raiz genera `frontend/dist`.
- `bun run build` desde la raiz ejecuta el mismo build frontend.
- `bun run lint` desde la raiz delega a `bun run --filter './frontend' lint`.
- `bun run --filter './frontend' typecheck` ejecuta solo el typecheck del frontend.
- `bun run --filter './frontend' lint` ejecuta solo el ESLint del frontend.

El bundle de produccion lo crea `scripts/build-frontend.ts` con `Bun.build` y `bun-plugin-tailwind`; tambien copia `frontend/public` a `frontend/dist`.

La vista calendario/matriz dedicada, multidestino y `reprice` no estan expuestos en React. La busqueda flexible ida/vuelta usa `/api/matrix`, pero el frontend normaliza sus celdas como lista de resultados.
