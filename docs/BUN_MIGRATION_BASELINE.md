# Bun Migration Baseline

Fecha: 2026-05-08

## Entorno

- Node: `v25.9.0`
- npm: `11.12.1`
- Bun antes de migrar: no instalado en PATH
- Bun instalado para la migracion: `1.3.13` (`1.3.13+bf2e2cecf`)

## Mediciones Node/npm Previas

| Check | Resultado | Tiempo |
| --- | --- | ---: |
| `npm ci` | Falla con `EPERM` al borrar `node_modules\better-sqlite3\build\Release\better_sqlite3.node` | 9.035s |
| `npm --prefix frontend ci` | OK | 26.668s |
| `npm run build` | Falla en `tsc -p tsconfig.build.json` porque `tsc` no queda disponible despues del `npm ci` raiz fallido | 10.404s |

## Artefactos y Arranque

- `frontend/dist`: 2,085,234 bytes antes de la migracion.
- El intento de `npm start` no es una medicion confiable: ya existia un `node.exe D:\Dev\fly-desk\dist\index.js` escuchando en `127.0.0.1:32123`.
- El proceso lanzado por `npm start` fallo con `Cannot find module 'better-sqlite3'`, consistente con el `npm ci` raiz fallido.

## Lectura

El baseline actual ya evidencia fragilidad por la dependencia nativa `better-sqlite3`: bloquea instalacion limpia en Windows cuando el binario esta retenido y deja la build raiz incompleta. La migracion Bun se evaluara contra `bun install --frozen-lockfile`, `bun run build`, `bun run start` y pruebas Bun.

## Mediciones Bun Finales

| Check | Resultado | Tiempo |
| --- | --- | ---: |
| `bun install --frozen-lockfile` | OK | 0.157s |
| `bun run build` | OK | 1.454s |
| `bun run start` hasta `GET /api/health` | OK, HTTP 200 | 0.800s |
| `bun run test` | OK, 181 tests | 80.27s |

## Artefactos y Arranque Bun

- `frontend/dist`: 2,315,348 bytes despues de la migracion.
- Memoria idle del proceso Bun medido al responder `/api/health`: 47,476,736 bytes.
- La suite UI se ejecuta desde `bun test` mediante un wrapper que lanza Playwright en Node y arranca la app bajo Bun, porque Playwright declara runtime Node y en Windows no completa `chromium.launch()` cuando se invoca directamente desde Bun.

## Resultado

Bun mejora instalacion y build de forma clara frente al baseline disponible, elimina el bloqueo nativo de `better-sqlite3`, mantiene el arranque local funcional y deja la suite automatizada completa en verde.
