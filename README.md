# Fly Desk

Workspace local para busqueda y cotizacion aerea orientado a agentes de viajes.

Fly Desk hoy es una app local-first con:

- servidor Node que sirve UI y API en el mismo proceso
- frontend desktop en `public/` con HTML/CSS y JavaScript vanilla en modulos ES
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
- la ventana de fechas es movil: `minSearchDate = hoy`, `maxSearchDate = hoy + 365 dias`
- `SEARCH_MAX_FUTURE_DAYS` permite ajustar esa ventana
- Costamar ya no acepta `apiBaseUrl` ni `brandBaseUrl` por request
- las base URLs de Costamar solo salen de entorno y quedan limitadas a hosts aprobados
- Agil requiere sesion local de navegador y `AGIL_APIM_SUBSCRIPTION_KEY` para requests HTTP reales

## Estructura

### Frontend

- `public/index.html`: shell desktop y bootstrap inicial
- `public/app.css`: tokens, layout, componentes y estados visuales
- `public/app.js`: entrypoint del frontend
- `public/app/runtime.js`: estado compartido, refs DOM y constantes runtime
- `public/app/date.js`: helpers de fechas y politica de rango en cliente
- `public/app/network.js`: helpers de fetch y polling
- `public/app/render.js`: shell de render global
- `public/app/bootstrap.js`: wiring de inicializacion del frontend

### Backend

- `src/server.ts`: servidor HTTP y serving de assets de `public/`
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
- `COSTAMAR_HTTP_TIMEOUT_MS=20000`

## Scripts

- `npm run dev`
- `npm run build`
- `npm start`
- `npm run typecheck`
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

## Verificacion reciente

Estado validado el 31 de marzo de 2026:

- `npm run typecheck`
- `npm test` con `67/67` pruebas en verde
- verificacion del launcher de abrir/cerrar sobre `32123`

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
