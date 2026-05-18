# Fly Desk

Workspace local para busqueda, comparacion y cotizacion aerea orientado a agentes de viajes.

Fly Desk es una app local-first Bun-only:

- servidor Bun (`Bun.serve`) que sirve UI y API en el mismo proceso
- frontend React desktop en `frontend/`, compilado con `Bun.build` y servido desde `frontend/dist`
- integracion local con Agil reutilizando sesion real de navegador
- integracion con Costamar usando contexto controlado por entorno y warm-up B2B cuando aplica
- caches locales con `bun:sqlite` para sesiones completadas, matriz, purchase paths y autocomplete

## Alcance Actual

- busqueda exacta
- busqueda flexible de solo ida por rango
- busqueda flexible ida/vuelta via `/api/matrix`, normalizada como lista de resultados
- busqueda migratoria mensual de 8 meses desde el mes actual
- autocomplete de origen y destino
- filtros visibles de escalas, tiempo maximo de escala, equipaje y aerolineas
- lista de resultados paginada con advertencias del backend
- panel lateral de detalle, condiciones, rutas de compra y `quotation`
- ajuste persistente de ancho de columnas bajo `?layoutEditor=1` o `?layout=editor`

No estan expuestos en la UI React actual:

- multidestino
- vista calendario/matriz dedicada
- `reprice`
- controles simulados o placeholders de flujos no conectados

## Runtime Y Seguridad

- El servidor escucha en `127.0.0.1` por defecto.
- `HOST=0.0.0.0` es un override explicito para despliegues no locales.
- Los endpoints operativos desde clientes no loopback requieren `FLY_DESK_API_TOKEN`.
- Diagnosticos, layout de resultados, estado de token Costamar y apertura local de browser son superficies loopback-only.
- La ventana normal de fechas es movil: `hoy` a `hoy + SEARCH_MAX_FUTURE_DAYS`; ida/vuelta se limita a 90 noches.
- Costamar no acepta `apiBaseUrl` ni `brandBaseUrl` por request; las bases salen de entorno y pasan por allowlist.
- Agil depende de sesion local de navegador y de una subscription key resuelta desde entorno o desde el bundle Agil.

## Dependencias

El package manager soportado es Bun. No agregues `package-lock.json`, `pnpm-lock.yaml` ni `yarn.lock` a este repo.

- Instalacion: `bun install --frozen-lockfile`
- Lockfile: `bun.lock`
- Workspace: `package.json` con `workspaces: ["frontend"]`
- Hardening: `bunfig.toml` desactiva lifecycle scripts de dependencias y filtra versiones publicadas hace menos de 3 dias.
- Guardrail extra: `.npmrc` define `ignore-scripts=true` para instalaciones accidentales con npm/pnpm; eso no convierte a pnpm en el flujo normal del proyecto.
- Si una dependencia necesita scripts de instalacion, debe agregarse deliberadamente a `trustedDependencies` y documentarse el motivo.
- El grafo actual no usa paquetes `@tanstack/*`.

## Estructura

### Frontend

- `frontend/src/App.tsx`: composicion principal del workspace
- `frontend/src/components/`: topbar, shell de busqueda, resultados, detalle y componentes UI
- `frontend/src/components/results/`: tarjeta de resultado, modelo de presentacion y layout editor
- `frontend/src/hooks/`: busqueda/polling y autocomplete
- `frontend/src/lib/api.ts`: cliente HTTP del BFF
- `frontend/src/index.css`: tokens, layout, tema claro/oscuro y estados visuales
- `frontend/public/`: assets estaticos copiados a `frontend/dist`
- `frontend/dist/`: artefacto generado que sirve el backend

### Backend

- `src/server.ts`: servidor HTTP Bun, headers, limite de body y serving de `frontend/dist`
- `src/http-router.ts`: BFF HTTP y rutas loopback/token
- `src/http-quotation-snapshot.ts`: normalizacion de snapshots para cotizacion
- `src/search-date-policy.ts`: politica compartida de fechas y config publica embebida
- `src/provider-context.ts`: contexto Costamar, allowlist, recovery de Chrome/CDP y estado live
- `src/local-agil.ts`: sesion local, exact/range/matrix, pricing y deep links Agil
- `src/local-costamar.ts`: cliente Costamar, exact/range/matrix, branded links y warm-up B2B
- `src/providers/costamar/search-payloads.ts`: payloads Costamar
- `src/core/`: normalizacion, matriz, grouping, ranking, cotizacion y contratos compartidos
- `src/search-worker-client.ts` / `src/search-worker.ts`: procesos hijos Bun para aislar busquedas pesadas
- `src/session-store.ts`: jobs vivos, SQLite local, migracion JSON legada, redirects y purchase paths
- `src/location-suggestion-cache.ts`: cache SQLite de autocomplete

## Configuracion

`.env.example` es la referencia operativa de variables. Las mas comunes:

- Runtime/API: `HOST`, `PORT`, `FLY_DESK_API_TOKEN`, `FLY_DESK_SERVER_IDLE_TIMEOUT_SECONDS`
- Busqueda/cache: `SEARCH_MAX_FUTURE_DAYS`, `SEARCH_REVALIDATION_CACHE_TTL_MS`, `SEARCH_COMPLETED_SESSION_TTL_MS`, `FLY_DESK_SESSION_DB_PATH`, `FLY_DESK_LOCATION_SUGGESTION_DB_PATH`
- Workers/prewarm: `FLY_DESK_SEARCH_WORKER_PROCESSES`, `FLY_DESK_DISABLE_BACKGROUND_SEARCH_JOBS`, `FLY_DESK_PROVIDER_PREWARM`
- Agil: `AGIL_APIM_SUBSCRIPTION_KEY`, `AGIL_CHROME_USER_DATA_DIR`, `AGIL_CHROME_PROFILE`, `AGIL_BROWSER_URL`, `AGIL_HTTP_TIMEOUT_MS`
- Costamar: `COSTAMAR_API_BASE_URL`, `COSTAMAR_BRAND_BASE_URL`, `COSTAMAR_AIR_API_BASE_URL`, `COSTAMAR_TERMINAL_ID`, `COSTAMAR_TOKEN`
- Costamar B2B: `COSTAMAR_B2B_EMAIL`, `COSTAMAR_B2B_PASSWORD`, `COSTAMAR_B2B_TOTP_SECRET`, `COSTAMAR_B2B_TOTP_URI`, `COSTAMAR_B2B_AUTOMATION_ENABLED`, `COSTAMAR_SESSION_WARMUP_ENABLED`

`COSTAMAR_B2B_TOTP_SECRET` acepta Base32, `otpauth://...`, `otpauth-migration://...` y JSON con `totpUri`; Fly Desk genera el OTP, no guardes codigos temporales.

### `.env` Local

`.env` no se versiona. Para alinear tu archivo local con la estructura de `.env.example` sin imprimir secretos:

```powershell
tools/sync-env-from-example.ps1
tools/sync-env-from-example.ps1 -Write
```

El script preserva los valores actuales por clave, crea un backup `.env.bak-*` antes de escribir y deja al final las claves locales que no existen en `.env.example`.

Para trabajar en otro equipo, no mandes `.env` en texto plano por chat, correo ni commits. En la practica:

- guarda secretos duraderos en un password manager o secret manager: `AGIL_APIM_SUBSCRIPTION_KEY`, credenciales `COSTAMAR_B2B_*`, TOTP/otpauth y `FLY_DESK_API_TOKEN` si aplica
- recrea por maquina las rutas locales de Chrome y caches (`*_CHROME_USER_DATA_DIR`, `output/cache`, layout local)
- evita trasladar tokens de sesion como `COSTAMAR_TOKEN`; normalmente conviene regenerarlos con login/warm-up en la maquina nueva
- si necesitas mover el archivo completo, usa un archivo cifrado para ti mismo (por ejemplo un adjunto seguro del password manager, SOPS/age o GPG), no un `.env` plano

## Scripts

- `bun run dev`
- `bun run build`
- `bun run start`
- `bun run typecheck`
- `bun run lint`
- `bun run test`
- `bun run demo`

## Arranque Con Un Clic

Entradas para abrir y cerrar la app sin terminal:

- [`Abrir Fly Desk.vbs`](./Abrir%20Fly%20Desk.vbs)
- `tools/launch-fly-desk.cmd`
- `tools/start-fly-desk.ps1`
- `tools/stop-fly-desk.cmd`
- `tools/stop-fly-desk.ps1`

Comportamiento actual del launcher:

- usa el puerto fijo `32123`
- antes de reutilizar o relanzar, chequea Git con cache local
- si hay un commit remoto nuevo y el working tree esta limpio, ejecuta `git pull --ff-only`
- si Fly Desk ya esta sano en ese puerto, reutiliza la instancia
- si encuentra una instancia huerfana propia, intenta limpiarla antes de relanzar
- si `node_modules/` no existe, ejecuta `bun install --frozen-lockfile`
- si `frontend/dist/` esta ausente o vieja, ejecuta `bun run build`
- persiste estado y logs en `.launcher/`
- los `.vbs` esperan a que abrir o cerrar termine

## Verificacion

Para cambios de codigo o runtime:

```powershell
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run build
bun run test
```

Para cambios solo documentales, como minimo usar:

```powershell
git diff --check
rg -n "\]\([^)]*\.md\)" README.md docs frontend/README.md
```

## Documentacion Vigente

- [`AUTOUPDATE_PLAN.md`](./AUTOUPDATE_PLAN.md): plan compacto de implementacion del autoupdater para cliente final
- [`AUTOUPDATE_RUNBOOK.md`](./AUTOUPDATE_RUNBOOK.md): runbook de publicacion, monitoreo, fallback y rollback de updates
- [`VPS_UPDATE_CHANNEL.md`](./VPS_UPDATE_CHANNEL.md): contrato seguro de updates via VPS, tokens por cliente y receipts
- [`WEB_CENTRAL_PLAN.md`](./WEB_CENTRAL_PLAN.md): plan general para mover Fly Desk a web central en VPS con auth, Costamar server-side y spike de Agil central
- [`docs/REPO_CURRENT_STATE.md`](./docs/REPO_CURRENT_STATE.md): estado funcional y tecnico actual
- [`docs/DEPLOY_RAILWAY.md`](./docs/DEPLOY_RAILWAY.md): limites y requisitos de despliegue remoto
- [`docs/FRONTEND_IDENTITY.md`](./docs/FRONTEND_IDENTITY.md): identidad visual y reglas UI React
- [`docs/UPDATE_CHANNEL.md`](./docs/UPDATE_CHANNEL.md): contrato entre publicacion de releases y autoupdate de cliente final
- [`frontend/README.md`](./frontend/README.md): notas breves del workspace frontend

## Deploy

La app se puede construir y arrancar en hosts con Bun, pero el comportamiento completo sigue siendo local-first:

- Agil depende de una sesion local de navegador
- Costamar es mas portable, pero sus flujos de sesion siguen pensados para uso controlado
- la UI remota necesita una estrategia explicita para enviar `FLY_DESK_API_TOKEN`

Para mas detalle, ver [`docs/DEPLOY_RAILWAY.md`](./docs/DEPLOY_RAILWAY.md).
