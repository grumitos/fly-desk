# Fly Desk

Workspace web privado para busqueda, comparacion y cotizacion aerea orientado a agentes de viajes.

Fly Desk es una app Bun-only preparada para VPS:

- servidor Bun (`Bun.serve`) que sirve UI y API web privadas
- proceso Bun dedicado opcional para ejecutar busquedas en loopback y aislar carga de proveedores del login/UI
- proceso Bun dedicado opcional para resolver `/r/<id>` desde la cache SQLite sin cargar el runtime principal
- frontend React desktop en `frontend/`, compilado con `Bun.build` y servido desde `frontend/dist`
- autenticacion web con cookie httpOnly firmada
- integracion con Agil reutilizando una sesion real de Chrome cuando el host la tenga disponible
- integracion con Click and Book Plus usando contexto controlado por entorno y warm-up B2B cuando aplica
- caches SQLite con `bun:sqlite` para sesiones completadas, matriz, purchase paths, autocomplete y ranking global de rutas frecuentes

## Alcance Actual

- busqueda exacta
- busqueda flexible de solo ida por rango
- busqueda flexible ida/vuelta via `/api/matrix`, normalizada como lista de resultados
- busqueda migratoria mensual exhaustiva: consulta cada dia de los meses seleccionados contra Agil y Click and Book Plus, sin filtros de tarifa, y procesa los meses en tandas
- todas las busquedas esperan a Agil y Click and Book Plus y retienen sus resultados completos; la concurrencia regula solicitudes en lote, no recorta ofertas disponibles
- la busqueda exacta publica un conjunto estable al terminar ambos proveedores; rango, matriz y migratorio envian deltas y publican milestones geometricos (1, 2, 4...) coalescidos durante 900 ms, mas el estado final, sin remontar tarjetas visibles
- autocomplete de origen y destino
- sugerencias frecuentes de origen/destino rankeadas globalmente desde el VPS y registradas por el backend al aceptar busquedas
- filtros visibles de escalas, tiempo maximo de escala, equipaje y aerolineas
- lista de resultados paginada con advertencias del backend
- panel lateral de detalle, condiciones, rutas de compra y cotizacion local desde la oferta fresca; el switch migratorio modifica el texto al instante y no llama de nuevo al proveedor
- ajuste persistente de ancho de columnas bajo `?layoutEditor=1` o `?layout=editor`

No estan expuestos en la UI React actual:

- multidestino
- vista calendario/matriz dedicada
- `reprice`
- controles simulados o placeholders de flujos no conectados

## Runtime Y Seguridad

- El servidor escucha en `127.0.0.1` por defecto.
- En produccion debe quedar detras de Caddy y mantener `HOST=127.0.0.1`.
- `FLY_DESK_WEB_AUTH=1` activa login web con cookie httpOnly.
- `FLY_DESK_TRUST_LOOPBACK_CLIENT=0` es obligatorio cuando hay reverse proxy local.
- Si se habilita `FLY_DESK_TRUST_LOOPBACK_CLIENT=1` para uso local directo, las solicitudes con cabeceras de proxy (`x-forwarded-for`, `forwarded`, `x-real-ip`) no se tratan como locales salvo que tambien se configure deliberadamente `FLY_DESK_TRUST_REVERSE_PROXY_LOOPBACK=1`.
- Los endpoints operativos aceptan cookie web valida o `FLY_DESK_API_TOKEN`.
- Diagnosticos, estado de token Click and Book Plus y apertura local de browser siguen siendo superficies loopback-only.
- La ventana normal de fechas es movil: `hoy` a `hoy + SEARCH_MAX_FUTURE_DAYS`; ida/vuelta se limita a 90 noches.
- Click and Book Plus no acepta `apiBaseUrl` ni `brandBaseUrl` por request; las bases salen de entorno y pasan por allowlist.
- Agil depende de sesion local de navegador y de una subscription key resuelta desde entorno o desde el bundle Agil.
- En produccion, `fly-desk.service` puede delegar `/api/search`, `/api/matrix`, polling y cancelacion a `fly-desk-search.service` mediante `FLY_DESK_SEARCH_SERVICE_URL`; ese runner queda en loopback y ejecuta proveedores/workers.
- Con delegacion activa, el runtime web inicializa la cache de sesiones de forma perezosa: autocomplete y preferencias no restauran el estado pesado del runner.
- Las busquedas pasan por admision por unidades en el runner: presupuesto default `4`, exactas cuestan `1`, rangos y matrices cuestan `2`. Asi se admiten dos busquedas pesadas simultaneas y el exceso queda en cola con timeout.
- La reutilizacion de precios expira desde `searchMeta.completedAt`; leer o hacer polling no renueva una tarifa. El TTL idle separado conserva sesiones y redirects operativos.
- La cache completada residente usa un presupuesto combinado default de 128 MiB. El exceso LRU sale de RAM despues de una gracia corta, pero permanece en SQLite con sus `/r/<id>` hasta el TTL; las busquedas activas nunca se expulsan.
- El progreso activo usa los mismos milestones geometricos para acotar snapshots de RAM/HTTP/SQLite; los purchase paths nuevos se persisten aparte para que `/r/<id>` funcione entre checkpoints, y todo estado terminal queda durable.
- El proxy web hacia el runner transmite el body sin almacenarlo completo y mantiene un timeout bounded durante el stream; no bajar `FLY_DESK_SEARCH_SERVICE_TIMEOUT_MS` por debajo del default operativo.
- El boton `Detener busqueda`, el cierre/navegacion de pestaña y el shutdown ordenado del proceso cancelan jobs remotos. En cierre de pestaña y shutdown se materializa primero cualquier delta pendiente y se usa cache parcial para conservar resultados y purchase paths ya resueltos.
- Los purchase paths publicos se sirven como `/r/<id>` para conservar cache y no persistir enlaces sensibles en la UI. Agil responde con `302` directo al proveedor; Click and Book Plus mantiene el handoff local para validar o refrescar el token antes de abrir el enlace externo.
- En produccion, plataforma puede enrutar `/r/*` a `fly-desk-redirect.service`, un proceso Bun separado que lee `FLY_DESK_SESSION_DB_PATH` y conserva la misma autenticacion web/API antes de responder.

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
- `src/redirect-service.ts` / `src/redirect-index.ts`: resolver dedicado de `/r/<id>` para procesar redirects sin depender del runtime principal
- `src/http-router.ts`: BFF HTTP, rutas auth, API y superficies loopback/token
- `src/web-auth.ts`: password web, cookie firmada y validacion de sesion
- `src/search-date-policy.ts`: politica compartida de fechas y config publica embebida
- `src/provider-context.ts`: contexto Click and Book Plus, allowlist, recovery de Chrome/CDP y estado live
- `src/local-agil.ts`: sesion local, exact/range/matrix, pricing y deep links Agil
- `src/local-costamar.ts`: cliente Click and Book Plus, exact/range/matrix, branded links y warm-up B2B
- `src/providers/costamar/search-payloads.ts`: payloads Click and Book Plus; `costamar` se conserva como alias interno legacy
- `src/core/`: normalizacion, matriz, grouping, ranking, cotizacion y contratos compartidos
- `src/search-service-client.ts`: delegacion loopback opcional de rutas de busqueda hacia el runner dedicado
- `src/search-worker-client.ts` / `src/search-worker.ts`: procesos hijos Bun para aislar busquedas pesadas
- `src/session-store.ts`: jobs vivos, presupuesto residente, SQLite local, redirects y purchase paths
- `src/location-suggestion-cache.ts`: cache SQLite de autocomplete
- `src/location-usage-store.ts`: ranking global SQLite de origen/destino frecuentes
- `src/runtime-paths.ts`: resolucion de rutas persistentes; `FLY_DESK_APP_DATA_DIR` mantiene caches fuera del release cuando no hay override especifico

## Configuracion

`.env.example` es la referencia operativa de variables. Las mas comunes:

- Runtime/API: `HOST`, `PORT`, `FLY_DESK_API_TOKEN`, `FLY_DESK_SERVER_IDLE_TIMEOUT_SECONDS`, `FLY_DESK_SEARCH_SERVICE_URL`, `FLY_DESK_SEARCH_SERVICE_API_TOKEN`, `FLY_DESK_SEARCH_SERVICE_TIMEOUT_MS`, `FLY_DESK_REDIRECT_HOST`, `FLY_DESK_REDIRECT_PORT`, `FLY_DESK_REDIRECT_CACHE_LOOKUP_TIMEOUT_MS`
- Auth web: `FLY_DESK_WEB_AUTH`, `FLY_DESK_WEB_PASSWORD_HASH`, `FLY_DESK_WEB_SESSION_SECRET`, `FLY_DESK_TRUST_LOOPBACK_CLIENT`, `FLY_DESK_TRUST_REVERSE_PROXY_LOOPBACK`
- Busqueda/cache: `SEARCH_MAX_FUTURE_DAYS`, `SEARCH_REVALIDATION_CACHE_TTL_MS`, `SEARCH_COMPLETED_SESSION_TTL_MS`, `SEARCH_COMPLETED_SESSION_RESIDENT_BUDGET_BYTES`, `FLY_DESK_QUOTATION_RATE_TIMEOUT_MS`, `FLY_DESK_SESSION_DB_PATH`, `FLY_DESK_LOCATION_SUGGESTION_DB_PATH`, `FLY_DESK_LOCATION_USAGE_DB_PATH`, `FLY_DESK_MIGRATION_CONCURRENT_MONTHS`, `FLY_DESK_SEARCH_CAPACITY_UNITS`, `FLY_DESK_SEARCH_EXACT_COST_UNITS`, `FLY_DESK_SEARCH_RANGE_COST_UNITS`, `FLY_DESK_SEARCH_MATRIX_COST_UNITS`, `FLY_DESK_SEARCH_MAX_QUEUED`, `FLY_DESK_SEARCH_QUEUE_TIMEOUT_MS`
- App data: `FLY_DESK_APP_DATA_DIR`, `FLY_DESK_QUOTATION_RATE_CACHE_PATH`
- Workers/prewarm: `FLY_DESK_SEARCH_WORKER_PROCESSES`, `FLY_DESK_DISABLE_BACKGROUND_SEARCH_JOBS`, `FLY_DESK_PROVIDER_PREWARM`
- Agil: `AGIL_APIM_SUBSCRIPTION_KEY`, `AGIL_CHROME_USER_DATA_DIR`, `AGIL_CHROME_PROFILE`, `AGIL_BROWSER_URL`, `AGIL_RAW_CHROME_STORAGE_FILE_SCAN`, `AGIL_TEMP_CHROME_STORAGE_FALLBACK`, `AGIL_HTTP_TIMEOUT_MS`
- Click and Book Plus: `CBPLUS_SEARCH_API_BASE_URL`, `CBPLUS_BRAND_BASE_URL`, `CBPLUS_ENGINE_API_BASE_URL`, `CBPLUS_MARKUP_API_BASE_URL`, `CBPLUS_AIR_API_BASE_URL`, `CBPLUS_TERMINAL_ID`, `CBPLUS_TOKEN`
- Click and Book Plus B2B: `CBPLUS_B2B_EMAIL`, `CBPLUS_B2B_PASSWORD`, `CBPLUS_B2B_TOTP_SECRET`, `CBPLUS_B2B_TOTP_URI`, `CBPLUS_B2B_AUTOMATION_ENABLED`, `CBPLUS_SESSION_WARMUP_ENABLED`; las variables `COSTAMAR_*` equivalentes siguen funcionando como fallback legacy

`CBPLUS_B2B_TOTP_SECRET` acepta Base32, `otpauth://...`, `otpauth-migration://...` y JSON con `totpUri`; Fly Desk genera el OTP, no guardes codigos temporales.

Produccion debe mantener `FLY_DESK_SEARCH_WORKER_PROCESSES=1` salvo una excepcion temporal de QA. Si se cambia el conteo de workers o warm-up, repetir QA externo antes de darlo por estable.

### Secretos

`.env` no se versiona. Para generar el hash del password web:

```bash
FLY_DESK_WEB_PASSWORD='<password>' bun run auth:hash
```

Usa el resultado como `FLY_DESK_WEB_PASSWORD_HASH` y no guardes `FLY_DESK_WEB_PASSWORD` en el entorno final.

Para trabajar en otro equipo, no mandes `.env` en texto plano por chat, correo ni commits. En la practica:

- guarda secretos duraderos en un password manager o secret manager: `FLY_DESK_WEB_SESSION_SECRET`, `FLY_DESK_WEB_PASSWORD_HASH`, `AGIL_APIM_SUBSCRIPTION_KEY`, credenciales `CBPLUS_B2B_*`, TOTP/otpauth y `FLY_DESK_API_TOKEN` si aplica
- recrea por host las rutas de Chrome y caches (`*_CHROME_USER_DATA_DIR` y `FLY_DESK_APP_DATA_DIR`; usar overrides `*_DB_PATH` solo si hace falta separar archivos)
- evita trasladar tokens de sesion como `CBPLUS_TOKEN`; normalmente conviene regenerarlos con login/warm-up en la maquina nueva
- si necesitas mover el archivo completo, usa un archivo cifrado para ti mismo (por ejemplo un adjunto seguro del password manager, SOPS/age o GPG), no un `.env` plano

## Scripts

- `bun run dev`
- `bun run build`
- `bun run start`
- `bun run start:search`
- `bun run start:redirect`
- `bun run auth:hash`
- `bun run typecheck`
- `bun run lint`
- `bun run test`
- `bun run test:unit`
- `bun run test:integration`
- `bun run test:core`
- `bun run test:ui`
- `bun run test:coverage`
- `bun run demo`

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

## CI

GitHub Actions ejecuta `.github/workflows/ci.yml` en PRs, pushes a `main` y manualmente. El gate
separa core y UI en jobs paralelos: core ejecuta typecheck, lint, build y pruebas Bun; UI instala
Chromium, compila el frontend y ejecuta los flujos de navegador. Los fallos UI publican capturas
como artefactos.

## Documentacion Vigente

- [`docs/REPO_CURRENT_STATE.md`](./docs/REPO_CURRENT_STATE.md): estado funcional y tecnico actual
- [`docs/DEPLOY_APP.md`](./docs/DEPLOY_APP.md): deploy y rollback de app Fly Desk
- [`docs/AGIL_SESSION_RECOVERY.md`](./docs/AGIL_SESSION_RECOVERY.md): recuperacion de sesion Agil en Chrome/CDP del VPS
- [`docs/FRONTEND_IDENTITY.md`](./docs/FRONTEND_IDENTITY.md): identidad visual y reglas UI React
- [`docs/TESTING.md`](./docs/TESTING.md): clasificacion, ejecucion y criterios de relevancia de pruebas
- [`docs/superpowers/specs/2026-07-10-search-runtime-budget-design.md`](./docs/superpowers/specs/2026-07-10-search-runtime-budget-design.md): decisiones de fluidez, cotizacion local y presupuesto residente
- [`frontend/README.md`](./frontend/README.md): notas breves del workspace frontend

## Deploy

La app se despliega como servicio Bun privado detras de Caddy:

- `HOST=127.0.0.1`
- `FLY_DESK_WEB_AUTH=1`
- `FLY_DESK_TRUST_LOOPBACK_CLIENT=0`
- `FLY_DESK_SEARCH_WORKER_PROCESSES=1`
- `FLY_DESK_SEARCH_SERVICE_URL` apunta al runner dedicado cuando la plataforma instala `fly-desk-search.service`
- `FLY_DESK_COOKIE_SECURE=1`
- Agil usa `fly-desk-chrome.service` con Chrome CDP en `127.0.0.1:9222`; todavia requiere una sesion Agil valida en ese perfil
- Click and Book Plus es mas portable, pero sus flujos de sesion siguen pensados para uso controlado

Para mas detalle, ver [`docs/DEPLOY_APP.md`](./docs/DEPLOY_APP.md).

La fuente vigente de Caddy, systemd compartido, rollback de Caddy y plan de plataforma es `grumitos/vps-platform` (`D:\Dev\VPS\vps-platform`). Este repo mantiene el codigo de la app y el deploy de `fly-desk`.

El deploy repetible vive en `.github/workflows/deploy-vps.yml` como workflow manual con modos `deploy` y `rollback`. Cada deploy escribe `REVISION` con el SHA activado, reinicia `fly-desk.service`, reinicia `fly-desk-search.service` y `fly-desk-redirect.service` si ya existen, conserva `fly-desk-chrome.service` y ejecuta smoke local y publico. Los secretos SSH y valores de infraestructura se configuran en GitHub Secrets/Variables, no en el repo.

El smoke publico puede devolver `403` desde runners o clientes fuera de Peru cuando la restriccion regional de `vps-platform` esta activa. Esa restriccion cubre `/login` y la app antes de llegar a Fly Desk; el indicador operativo principal es `Fly Desk Production Smoke` en `vps-platform`, que prueba health local, busqueda completada, `/r/*` para Agil/Click and Book Plus, cancelacion y servicios activos.
