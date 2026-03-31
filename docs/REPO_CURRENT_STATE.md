# Estado Actual de la Repo

Fecha de corte: 2026-03-31

## Resumen

Fly Desk es hoy una aplicacion local-first para agentes de viajes, con frontend vanilla modularizado y backend Node, conectada a Agil mediante reutilizacion de sesion local del navegador y a Costamar mediante contexto controlado por entorno.

El repo no versiona artefactos generados de build:

- `dist/` esta ignorado
- `output/` esta ignorado
- no se versionan bundles minificados ni capturas de smoke locales

## Estado funcional vigente

### Busqueda y producto

- busqueda exacta
- busqueda flexible por rango y por matriz
- autocomplete de origen y destino
- filtros visibles `Directo`, `Equipaje` y `Escala`
- lista de resultados con paginacion
- vista calendario
- barra de aerolineas
- panel lateral de detalle
- `reprice`
- `quotation`
- purchase paths y apertura local del flujo equivalente cuando aplica

### Feedback de carga

- busqueda exacta: placeholder inline en el area de resultados
- matriz flexible: celdas `loading` en la propia matriz
- `reprice` y `quotation`: estado de carga dentro del panel de detalle

## Cambios estructurales ya consolidados

### Runtime y seguridad local-first

- el servidor escucha en `127.0.0.1` por defecto
- `HOST` queda como override explicito para despliegues no locales
- Costamar ya no acepta hosts o base URLs por request
- `COSTAMAR_API_BASE_URL` y `COSTAMAR_BRAND_BASE_URL` quedan restringidas a hosts aprobados
- el endpoint de apertura local de browser solo funciona desde loopback

### Politica compartida de fechas

- se elimino la validacion fija atada a `2026`
- la politica actual es movil:
  - `minSearchDate = hoy`
  - `maxSearchDate = hoy + 365 dias`
- `SEARCH_MAX_FUTURE_DAYS` permite ajustar la ventana
- el backend embebe esa config al frontend en el HTML inicial
- frontend y backend validan con la misma regla

### Limpieza core y providers

- ya no existe fallback hardcodeado para `AGIL_APIM_SUBSCRIPTION_KEY`
- la key de Agil solo se resuelve desde entorno y falla en el camino live real
- helpers compartidos de matriz y concurrencia viven en `src/core/matrix.ts`
- derivacion de requests flexibles vive en `src/core/flexible-search.ts`
- router, Agil y Costamar usan esos helpers compartidos

### Frontend

- `public/app.js` sigue siendo el entrypoint, pero ya no concentra toda la infraestructura basica
- se abrieron seams en `public/app/`:
  - `runtime.js`
  - `date.js`
  - `network.js`
  - `render.js`
  - `bootstrap.js`
- la UI visible se mantuvo sin rediseño

### Launchers

- el acceso directo usa puerto fijo `32123`
- el launcher persiste estado y logs en `.launcher/`
- el cierre espera la liberacion real del puerto
- los `.vbs` esperan a que abrir o cerrar termine para evitar carreras
- si encuentra una instancia sana, la reutiliza
- si encuentra una instancia huerfana propia, intenta limpiarla antes de relanzar

## Estructura funcional vigente

### Frontend

- `public/index.html`
  - shell desktop
  - bootstrap de tema
  - script runtime embebido
- `public/app.css`
  - tokens, layout, componentes, overlays y estados visuales
- `public/app.js`
  - entrypoint del frontend
- `public/app/runtime.js`
  - estado compartido
  - refs del DOM
  - constantes runtime
- `public/app/date.js`
  - helpers de fechas
  - politica de rango en cliente
- `public/app/network.js`
  - `getJson`
  - `postJson`
  - `scheduleJsonPoll`
- `public/app/render.js`
  - render shell global
- `public/app/bootstrap.js`
  - wiring de inicializacion

### Backend

- `src/server.ts`
  - serving de `public/`
  - inyeccion de config runtime en `index.html`
- `src/http-router.ts`
  - `/api/health`
  - `/api/agil/locations`
  - `/api/costamar/locations`
  - `/api/locations`
  - `/api/local/open-url`
  - `/api/search`
  - `/api/search/:jobId`
  - `/api/matrix`
  - `/api/matrix/:jobId`
  - `/api/reprice`
  - `/api/quotation`
  - `/r/:id`
- `src/search-date-policy.ts`
  - ventana movil de fechas
  - config publica embebida al frontend
- `src/provider-context.ts`
  - normalizacion de contexto de Costamar
  - allowlist de URLs
  - recovery de sesion branded desde Chrome
- `src/local-agil.ts`
  - sesion local
  - refresh token
  - exact
  - range
  - matrix
  - reprice
  - deep links
- `src/local-costamar.ts`
  - autocomplete
  - exact
  - range
  - matrix
  - reprice
  - branded links
- `src/core/flexible-search.ts`
  - helpers de derivacion de requests
- `src/core/matrix.ts`
  - `buildMatrixConfidenceSummary`
  - `prioritizeMatrixLoadingCells`
  - `mapConcurrent`
- `src/session-store.ts`
  - jobs en memoria
  - redirects
  - purchase paths

### Launchers para usuario final

- `Abrir Fly Desk.vbs`
- `Cerrar Fly Desk.vbs`
- `tools/launch-fly-desk.cmd`
- `tools/start-fly-desk.ps1`
- `tools/stop-fly-desk.cmd`
- `tools/stop-fly-desk.ps1`
- `tools/stop-fly-desk.js`

## Pruebas vigentes

### Suite automatica

- `test/config.test.ts`
- `test/provider-context.test.ts`
- `test/search-date-policy.test.ts`
- `test/http-router.test.ts`
- `test/filtering.test.ts`
- `test/local-agil.test.ts`
- `test/costamar.test.ts`
- `test/matrix-core.test.ts`
- `test/session-store.test.ts`
- `test/theme-css.test.ts`
- `test/ui.test.ts`

Helpers y fixtures de test:

- `test/helpers/server.ts`
- `test/helpers/ui.ts`
- `test/helpers/ui-fixtures.ts`

Cobertura importante actual:

- bind por defecto a loopback y override por `HOST`
- validacion compartida de fechas con ventana movil
- endurecimiento de contexto de Costamar
- key requerida para Agil live
- helpers compartidos de matriz
- rail de busqueda y orden del formulario
- smoke de `exacto/flexible` con `ida/ida-vuelta`
- tema claro y oscuro
- calendario custom
- autocomplete anclado
- matriz flexible y paso a exacto
- provider links y feedback de sesion faltante
- launcher de abrir/cerrar sobre `32123`

### Verificacion reciente

Comandos:

- `npm run typecheck`
- `npm test`

Resultado al 31 de marzo de 2026:

- `67/67` pruebas en verde
- launcher verificado con abrir, reabrir, cerrar y reabrir sobre `32123`

## Documentacion historica

Siguen siendo utiles como referencia historica, no como descripcion del estado presente:

- `docs/CODE_AUDIT_2026-03-27.md`
- `docs/UI_UX_AUDIT_2026-03-27_LIVE.md`

## Deuda tecnica vigente

- `public/app.js` sigue siendo un entrypoint grande aunque ya tiene infraestructura extraida
- `src/local-agil.ts` sigue concentrando mucha logica de sesion, cliente y mapping
- el store sigue siendo en memoria; no hay persistencia externa para jobs
- no hay linter real configurado
- el deploy remoto completo sigue bloqueado por la dependencia de sesion local de navegador para Agil
