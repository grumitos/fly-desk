# Fly Desk

Workspace local para busqueda y cotizacion aerea orientado a agentes de viajes.

Fly Desk hoy es una app local-first con:

- servidor Node que sirve UI y API en el mismo proceso
- frontend desktop React/Vite en `frontend/`, servido desde `frontend/dist`
- integracion local con Agil reutilizando sesion real de navegador
- integracion con Costamar usando contexto controlado por entorno
- store en memoria para jobs, redirects y resultados

## Alcance actual

- busqueda exacta
- busqueda flexible por rango y matriz
- autocomplete de origen y destino
- filtros visibles `Directo`, `Equipaje` y `Escala`
- lista de resultados con paginacion
- vista calendario/matriz
- barra de aerolineas
- panel lateral de detalle
- `reprice`
- `quotation`
- links de compra y apertura local del flujo equivalente cuando aplica

Controles ya retirados del frontend visible:

- cabina visible
- moneda editable
- precio maximo
- maximo de escalas como control independiente
- overlay global de carga

El feedback de carga vigente es inline:

- placeholder en resultados durante busqueda exacta
- celdas `loading` dentro de la matriz
- estado de carga dentro del panel de detalle para `reprice` y `quotation`

## Guardrails de runtime

- el servidor escucha en `127.0.0.1` por defecto
- `HOST` solo se usa como override explicito para despliegues no locales
- la ventana de fechas normal es movil: `minSearchDate = hoy`, `maxSearchDate = hoy + 365 dias`
- `SEARCH_MAX_FUTURE_DAYS` permite ajustar esa ventana
- las estadias ida/vuelta se limitan a 90 noches
- el barrido migratorio de solo ida mantiene su busqueda extendida por meses
- Costamar ya no acepta `apiBaseUrl` ni `brandBaseUrl` por request
- las base URLs de Costamar solo salen de entorno y quedan limitadas a hosts aprobados
- Agil requiere sesion local de navegador y `AGIL_APIM_SUBSCRIPTION_KEY` para requests HTTP reales

## Estructura

### Frontend

- `frontend/src/App.tsx`: composicion principal del workspace
- `frontend/src/components/`: topbar, rail de busqueda, resultados, detalle y componentes UI
- `frontend/src/hooks/`: busqueda/polling y autocomplete
- `frontend/src/lib/api.ts`: cliente HTTP del BFF
- `frontend/src/index.css`: tokens, layout, tema claro/oscuro y estados visuales
- `frontend/dist/`: artefacto generado que sirve el backend

### Backend

- `src/server.ts`: servidor HTTP y serving de assets de `frontend/dist`
- `src/http-router.ts`: BFF HTTP
- `src/search-date-policy.ts`: politica compartida de fechas y config publica embebida
- `src/provider-context.ts`: normalizacion y recovery de contexto de providers
- `src/local-agil.ts`: sesion local, cliente Agil, exact/range/matrix y reprice
- `src/local-costamar.ts`: cliente Costamar, exact/range/matrix y reprice
- `src/core/flexible-search.ts`: helpers compartidos de derivacion de requests
- `src/core/matrix.ts`: helpers compartidos de matriz y concurrencia
- `src/session-store.ts`: jobs en memoria, redirects y purchase paths

### Tests

- `test/http-router.test.ts`
- `test/search-date-policy.test.ts`
- `test/provider-context.test.ts`
- `test/local-agil.test.ts`
- `test/costamar.test.ts`
- `test/matrix-core.test.ts`
- `test/ui.test.ts`
- `test/helpers/ui.ts`
- `test/helpers/ui-fixtures.ts`

## Variables utiles

Runtime general:

- `HOST=0.0.0.0` para exponer la app fuera de loopback
- `PORT=32123` o el puerto que se quiera usar fuera del launcher
- `SEARCH_MAX_FUTURE_DAYS=365`
- `SEARCH_REVALIDATION_CACHE_TTL_MS=300000` TTL del cache SWR de busqueda general (misma configuracion), en milisegundos
- `SEARCH_COMPLETED_SESSION_TTL_MS=14400000` TTL idle para jobs completados y redirects cacheados, en milisegundos
- `FLY_DESK_SEARCH_WORKER_PROCESSES=0` desactiva los procesos hijos para busquedas de proveedor; por defecto quedan activos para que una busqueda pesada no bloquee el servidor web ni otras pestañas
- `FLY_DESK_BACKGROUND_SEARCH_START_DELAY_MS=0` delay antes de iniciar la consulta live en segundo plano
- `FLY_DESK_CACHED_BACKGROUND_SEARCH_START_DELAY_MS=250` delay antes de revalidar una respuesta cacheada
- `FLY_DESK_PROVIDER_PREWARM=1` activa el prewarm silencioso de sesiones/tokens al iniciar y de forma periodica
- `FLY_DESK_PROVIDER_PREWARM_INTERVAL_MS=600000` intervalo del prewarm silencioso, en milisegundos
- `FLY_DESK_SESSION_DB_PATH=output/cache/fly-desk-cache.sqlite` cache SQLite local de jobs completados, matriz y redirects
- `FLY_DESK_SEARCH_SESSION_STORE_PATH=output/cache/search-session-store.json` ruta JSON legada; si existe y la DB esta vacia, se migra a SQLite y se elimina
- `FLY_DESK_LOCATION_SUGGESTION_CACHE_PATH=output/cache/location-suggestion-cache.json` cache JSON acotado para autocomplete

Agil:

- `AGIL_APIM_SUBSCRIPTION_KEY=<subscription key>`
- `AGIL_BROWSER_URL=http://127.0.0.1:9222`
- `AGIL_BROWSER_WS_ENDPOINT=ws://127.0.0.1:9222/devtools/browser/<id>`
- `AGIL_CHROME_PROFILE=Profile 1`
- `AGIL_CHROME_USER_DATA_DIR=...`
- `AGIL_CHROME_EXECUTABLE=...`
- `AGILSMART_HOST_IP=1.2.3.4`
- `AGIL_HTTP_TIMEOUT_MS=20000`

Costamar:

- `COSTAMAR_API_BASE_URL=https://costamar.com.pe/vuelos/api`
- `COSTAMAR_BRAND_BASE_URL=https://booking.clickandbook.com/vuelos`
- `COSTAMAR_TERMINAL_ID=...`
  Si no se define, Fly Desk usa el terminal publico `0721808110`.
- `COSTAMAR_TOKEN=...`
- `COSTAMAR_LANG=es`
- `COSTAMAR_B2B_EMAIL=...`
- `COSTAMAR_B2B_PASSWORD=...`
- `COSTAMAR_B2B_TOTP_SECRET=...`
  Acepta la clave Base32 del autenticador, un `otpauth://...`, un `otpauth-migration://...` de Google Authenticator o un JSON que incluya `totpUri` como el de Proton Pass. Fly Desk genera el OTP automáticamente; no guardes un código temporal.
- `COSTAMAR_B2B_PROMPT_ENABLED=1`
  Activo por defecto. Si Fly Desk está corriendo en una terminal interactiva, puede pedir ahí mismo el email, la contraseña y el código Auth/OTP de Costamar cuando falten o cuando el login exija segundo factor.
- `COSTAMAR_B2B_AUTOMATION_ALLOW_SESSION_ONLY=1`
  Está activo por defecto. Permite intentar la generación del token usando una sesión B2B ya viva en el perfil de Chrome, aun sin credenciales explícitas.
- `COSTAMAR_B2B_USE_LIVE_BROWSER=0`
  Si configuras `COSTAMAR_B2B_EMAIL` y `COSTAMAR_B2B_PASSWORD`, conviene dejarlo en `0` para que Costamar genere el token con un navegador aislado y no use tu Chrome vivo ni dispare prompts de depuración.
- `COSTAMAR_CDP_TAB_SCAN_ENABLED=0`
  Queda apagado por defecto para que Chrome no vuelva a pedir permisos de depuración en cada búsqueda solo por escanear pestañas abiertas.
- `COSTAMAR_BROWSER_HEADLESS=1`
- `COSTAMAR_SESSION_WARMUP_ENABLED=1`
  Activo por defecto. Primero intenta generar el token desde la sesión B2B viva de Costamar usando la misma llamada interna que dispara el formulario de vuelos y, si eso falla, cae al flujo aislado. Usa `0` para desactivarlo.
- `COSTAMAR_SESSION_WARMUP_OPEN_BROWSER_FALLBACK=1`
  Opcional. Reabre la pestaña B2B y una branded search visible como último recurso. Por defecto queda apagado para evitar pestañas innecesarias.
- `COSTAMAR_SESSION_WARMUP_TIMEOUT_MS=8000`
- `COSTAMAR_HTTP_TIMEOUT_MS=20000`

## Scripts

- `npm run dev`
- `npm run build`
- `npm start`
- `npm run typecheck`
- `npm run lint`
- `npm --prefix frontend run lint`
- `npm test`
- `npm run demo`

## Arranque con un clic

Entradas para abrir y cerrar la app sin terminal:

- [`Abrir Fly Desk.vbs`](./Abrir%20Fly%20Desk.vbs)
- [`Cerrar Fly Desk.vbs`](./Cerrar%20Fly%20Desk.vbs)
- `tools/launch-fly-desk.cmd`
- `tools/start-fly-desk.ps1`
- `tools/stop-fly-desk.cmd`
- `tools/stop-fly-desk.ps1`

Comportamiento actual del launcher:

- usa el puerto fijo `32123`
- antes de reutilizar o relanzar, chequea Git con cache local; si el remoto ya fue confirmado en el mismo commit, salta la red
- si hay un commit remoto nuevo y el working tree esta limpio, ejecuta `git pull --ff-only`
- si Fly Desk ya esta sano en ese puerto, reutiliza la instancia
- si `node_modules/` no existe, instala dependencias
- si `dist/` esta ausente o vieja, ejecuta `npm run build`
- persiste estado y logs en `.launcher/`
- los `.vbs` esperan a que abrir o cerrar termine, evitando carreras entre doble click de abrir/cerrar
- el cierre espera a que `32123` deje de estar en `LISTENING`

Variables utiles del launcher:

- `FLY_DESK_SKIP_BROWSER=1`
- `FLY_DESK_SILENT=1`
- `FLY_DESK_LAUNCHER_PORT=32123`
- `FLY_DESK_SKIP_GIT_UPDATE=1`
- `FLY_DESK_GIT_CHECK_TTL_SECONDS=300`
- `FLY_DESK_GIT_CHECK_TIMEOUT_SECONDS=3`
- `FLY_DESK_GIT_PULL_TIMEOUT_SECONDS=90`

## Verificacion reciente

Estado validado el 27 de abril de 2026:

- `npm run typecheck`
- `npm run lint`
- `npm --prefix frontend run lint`
- `npm run build`
- `npm test` (`168/168`)

Nota de QA: los helpers HTTP de test fijan `FLY_DESK_DISABLE_BACKGROUND_SEARCH_JOBS=1` para validar contratos inmediatos sin dejar jobs progresivos vivos despues del cierre del servidor. El runtime normal no define esa variable y conserva el polling/revalidacion en segundo plano.

## Documentacion vigente

- [`docs/REPO_CURRENT_STATE.md`](./docs/REPO_CURRENT_STATE.md): estado funcional y tecnico actual
- [`docs/DEPLOY_RAILWAY.md`](./docs/DEPLOY_RAILWAY.md): notas de deploy remoto y limites actuales
- [`docs/CODE_AUDIT_2026-03-27.md`](./docs/CODE_AUDIT_2026-03-27.md): auditoria historica previa al saneamiento repo-wide

## Nota de deploy

La app se puede construir y arrancar en cualquier host Node, pero el comportamiento local completo sigue siendo local-first:

- el bind por defecto es loopback
- Agil depende de sesion local de navegador
- Costamar esta mas cerca de un provider remoto estable, pero el proyecto sigue pensado para uso local

Para un deploy remoto real hay que definir al menos `HOST=0.0.0.0` y asumir que la integracion completa con Agil no es equivalente al entorno local.
