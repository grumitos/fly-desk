# Plan: Migración Bun-Only de Fly Desk

## Summary
Migrar Fly Desk de Node/npm/Vite/tsx/better-sqlite3 a Bun como runtime, package manager, bundler, test runner y SQLite driver. La migración se hará en una sola rama/cambio integral, con checkpoints internos para detectar bloqueos, pero sin dejar una entrega parcial. La decisión de “conviene” se medirá principalmente por instalación, build, arranque y apertura local.

Fuentes base: Bun install/runtime/build/server/sqlite/test docs: `https://bun.sh/docs/installation`, `https://bun.sh/docs/runtime/http/server`, `https://bun.sh/docs/bundler`, `https://bun.sh/docs/runtime/sqlite`, `https://bun.sh/docs/test/writing-tests`, `https://bun.sh/docs/pm/lockfile`.

## Key Changes
- Tooling:
  - Exigir Bun como runtime único.
  - Añadir `packageManager: "bun@<version-instalada>"`, `workspaces: ["frontend"]`, `bun.lock`, `bunfig.toml`.
  - Eliminar `package-lock.json`, `frontend/package-lock.json`, `tsx`, `vite`, `@vitejs/plugin-react`, `@tailwindcss/vite`, `better-sqlite3`, `@types/better-sqlite3`.
  - Añadir `@types/bun` y `bun-plugin-tailwind`; conservar `typescript`, `eslint`, Playwright y dependencias React/UI.

- Scripts:
  - `dev`: `bun --watch src/index.ts`
  - `start`: `bun src/index.ts`
  - `build`: `bun run build:frontend`
  - `build:frontend`: ejecutar un script Bun que compile `frontend/src/main.tsx`, procese Tailwind y genere `frontend/dist/index.html`.
  - `typecheck`: `tsc --noEmit`
  - `lint`: `bun --filter frontend run lint`
  - `test`: `bun test test/**/*.test.ts`
  - `demo`: `bun src/demo.ts`

- Runtime HTTP:
  - Reemplazar el servidor `node:http` por `Bun.serve`.
  - Mantener el contrato interno `routeRequest(Request): Promise<Response>`.
  - Conservar serving de `frontend/dist`, cache headers, CSP, `x-flydesk-client-loopback`, límite de body y la inyección de `window.__FLYDESK_RUNTIME__`.
  - Usar `server.stop()` para shutdown y tests.

- Workers/procesos:
  - Reemplazar `child_process.fork` y `tsx` en búsquedas por una implementación Bun-native.
  - Opción elegida: usar `Bun.spawn(["bun", "src/search-worker.ts"])` con protocolo JSON por stdout/stdin, no Worker API, porque Bun Workers aún documenta partes experimentales.
  - Mantener el protocolo de mensajes actual a nivel de tipos, cambiando solo el transporte.
  - Conservar `FLY_DESK_SEARCH_WORKER_PROCESSES=0` como bypass para debug/tests.

- SQLite:
  - Migrar `SearchSessionStore` y `LocationSuggestionCacheStore` de `better-sqlite3` a `bun:sqlite`.
  - Mantener rutas, tablas, JSON payloads, WAL/pragma equivalentes y migración desde JSON legado.
  - Actualizar tests que inspeccionan DB para usar `bun:sqlite`.
  - No crear adapter permanente Node/Bun; el destino es Bun-only.

- Frontend bundling:
  - Reemplazar Vite por script Bun de build.
  - Usar `Bun.build` con entrypoint `frontend/src/main.tsx`, salida `frontend/dist/assets`, sourcemaps de producción desactivados salvo que ya existan.
  - Procesar Tailwind con `bun-plugin-tailwind` vía `bunfig.toml`.
  - Generar `frontend/dist/index.html` desde `frontend/index.html`, reemplazando `/src/main.tsx` por el asset hasheado.
  - Copiar assets públicos necesarios y preservar rutas `/assets/provider-icons/...` y `/favicon.svg`.

- Tests:
  - Cambiar imports `node:test` a `bun:test`; mantener `node:assert/strict` porque Bun lo marca compatible.
  - Actualizar helpers HTTP para levantar `Bun.serve({ port: 0 })`.
  - Ajustar detección de test en runtime: reemplazar `process.argv.includes("--test")` por una señal compatible con Bun, por ejemplo `NODE_ENV === "test"` fijada por el script.
  - Validar que no queden dependencias de `node --test`, `tsx`, `dist/search-worker.js` ni `process.execArgv`.

- Launcher, docs y deploy:
  - Actualizar `tools/start-fly-desk.ps1` para buscar `bun.exe`, validar `bun --version`, instalar con `bun install --frozen-lockfile`, construir con `bun run build` y arrancar con `bun run start`.
  - Actualizar detección de procesos de `node.exe` a `bun.exe`.
  - Actualizar `.codex/environments/environment.toml` a `bun run dev`.
  - Cambiar `Procfile` a `web: bun run start`.
  - Actualizar README: requisitos, scripts, launcher, verificación y notas de deploy Bun.

## Execution Plan
1. Baseline antes de tocar código:
   - Medir `npm install` o `npm ci`, `npm run build`, `npm start` hasta `/api/health`, memoria idle y tamaño `frontend/dist`.
   - Guardar resultados en `docs/BUN_MIGRATION_BASELINE.md`.
   - Criterio de conveniencia: Bun debe mejorar install/build/start combinado al menos 20%, no empeorar memoria idle más de 10%, y pasar todos los tests.

2. Tooling Bun:
   - Instalar Bun si falta, registrar versión exacta.
   - Convertir root + frontend a workspace Bun con lock único.
   - Reescribir scripts y dependencias.
   - Verificar `bun install --frozen-lockfile` desde limpio.

3. Runtime/server:
   - Reescribir entrypoint a `Bun.serve`.
   - Extraer handler fetch reusable para app y tests.
   - Mantener comportamiento HTTP observable: headers, estáticos, favicon, body limit, errores JSON y health.

4. SQLite:
   - Cambiar imports a `bun:sqlite`.
   - Adaptar métodos `.prepare` a API Bun (`query`/`prepare` según corresponda tras validación local).
   - Verificar persistencia, purge, WAL/pragma y lectura de DB por tests.

5. Workers:
   - Sustituir `fork` por `Bun.spawn` con protocolo newline-delimited JSON.
   - Mantener cancelación, stderr capture, errores serializados, progress y complete.
   - Probar exact/range/matrix con workers activos y con bypass.

6. Frontend:
   - Crear build script Bun para React/Tailwind/assets.
   - Eliminar Vite config y deps.
   - Confirmar que `frontend/dist/index.html` conserva placeholder runtime y que el backend lo inyecta.
   - Validar UI en navegador local y comparar bundle size contra baseline.

7. Tests y repo hygiene:
   - Migrar tests a `bun:test`.
   - Corregir helpers, timeouts y cleanup de servidores/procesos.
   - Actualizar docs, launcher, Procfile y Codex env.
   - Buscar referencias remanentes a `node`, `npm`, `tsx`, `vite`, `better-sqlite3`, `package-lock`.

## Test Plan
- Automated:
  - `bun install --frozen-lockfile`
  - `bun run typecheck`
  - `bun run lint`
  - `bun run build`
  - `bun test test/**/*.test.ts`
  - `bun run start`, luego `GET /api/health` y `GET /`
- Runtime scenarios:
  - Arranque normal desde `bun run start`.
  - Arranque desde launcher Windows.
  - `/api/search` con workers desactivados.
  - `/api/search`, range y matrix con workers activos.
  - Persistencia SQLite: crear job/cache, reiniciar, restaurar, purgar expirados.
  - Frontend: abrir UI, búsqueda básica mockeada, assets de providers, tema claro/oscuro.
- Regression checks:
  - No archivos `package-lock.json`.
  - No imports `better-sqlite3`.
  - No uso de `node --test`, `tsx`, `vite`.
  - No dependencia de `dist/index.js` para start.
  - `README`, `Procfile`, `.codex` y launcher apuntan a Bun.

## Assumptions
- Estado final requerido: Bun-only completo, sin fallback Node permanente.
- Métrica principal: eficiencia de instalación, build y arranque local.
- Se mantienen `node:*` APIs compatibles bajo Bun cuando no hay alternativa útil, pero se eliminan herramientas Node/npm/Vite/tsx/better-sqlite3.
- Se conserva TypeScript para typechecking; Bun no reemplaza `tsc` en esta función porque su documentación indica que el bundler no sustituye typechecking.
- Si un bloqueo de Bun impide pasar tests o rompe workers/SQLite, la migración se considera no conveniente y se documenta el bloqueo con reproducción mínima antes de retirar cambios.
