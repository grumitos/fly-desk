# Estado Actual de la Repo

Fecha de corte: 2026-04-25

## Resumen

Fly Desk es hoy una aplicacion local-first para agentes de viajes, con frontend React/Vite y backend Node, conectada a Agil mediante reutilizacion de sesion local del navegador y a Costamar mediante contexto controlado por entorno.

El repo no versiona artefactos generados de build:

- `dist/` esta ignorado
- `frontend/dist/` esta ignorado
- `output/` esta ignorado
- no se versionan bundles minificados ni capturas de smoke locales

## Estado funcional vigente

### Busqueda y producto en React

- busqueda exacta
- busqueda flexible: solo ida por rango y ida/vuelta por matriz exact-stay
- busqueda migratoria mensual: 8 meses desde el mes actual, agregando la mejor tarifa mensual
- autocomplete de origen y destino
- filtros visibles de escalas, tiempo maximo de escala, equipaje y aerolineas
- lista de resultados con advertencias del backend
- panel lateral de detalle con precio, equipaje, condiciones, advertencias, rutas de compra y cotizacion
- `quotation`
- purchase paths y apertura del flujo equivalente cuando aplica

La UI React no debe mostrar controles simulados. Busqueda flexible y migratorio mensual estan conectados en React; matriz/calendario, multidestino y `reprice` permanecen fuera de la interfaz hasta reconstruirse desde cero con los componentes React actuales.

### Feedback de carga

- busqueda exacta: placeholder inline en el area de resultados
- polling de busqueda: badge `Actualizando` en resultados
- resultados parciales: badge `Parcial` y advertencias del backend
- `quotation`: estado de carga dentro del panel de detalle

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

- `frontend/src/main.tsx` monta la app React
- `frontend/src/App.tsx` compone el workspace operacional
- `frontend/src/components/` contiene topbar, rail de busqueda, resultados, detalle y componentes UI
- `frontend/src/hooks/` concentra busqueda/polling y autocomplete
- `frontend/src/index.css` define tokens, layout y tema claro/oscuro
- el backend sirve el build generado en `frontend/dist`

### Launchers

- el acceso directo usa puerto fijo `32123`
- el launcher persiste estado y logs en `.launcher/`
- el cierre espera la liberacion real del puerto
- los `.vbs` esperan a que abrir o cerrar termine para evitar carreras
- si encuentra una instancia sana, la reutiliza
- si encuentra una instancia huerfana propia, intenta limpiarla antes de relanzar

## Estructura funcional vigente

### Frontend

- `frontend/index.html`
  - shell Vite
- `frontend/src/main.tsx`
  - entrypoint React
- `frontend/src/App.tsx`
  - composicion principal, filtros y seleccion de ofertas
- `frontend/src/components/`
  - `TopBar`, `SearchShell`, `ResultsPanel`, `DetailPanel` y componentes UI
- `frontend/src/hooks/`
  - `useSearch` y `useAutocomplete`
- `frontend/src/lib/api.ts`
  - `getJson`, `postJson`, busqueda, polling, autocomplete y cotizacion
- `frontend/src/index.css`
  - tokens, layout, componentes, overlays y estados visuales

### Backend

- `src/server.ts`
  - serving de `frontend/dist`
  - inyeccion de config runtime en `index.html`
- `src/http-router.ts`
  - `/api/health`
  - `/api/costamar/token-status`
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
  - extraccion via Chrome DevTools Protocol (CDP)
  - verificacion live de token (`verifyCostamarTokenLive`)
  - endpoint de estado de token (`getCostamarTokenStatus`)
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
- `test/variant-group-key.test.ts`

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
- smoke de `exacto/flexible/migratorio` con `ida/ida-vuelta`
- tema claro y oscuro
- calendario custom
- autocomplete anclado
- matriz flexible y paso a exacto
- provider links y feedback de sesion faltante
- launcher de abrir/cerrar sobre `32123`

### Verificacion reciente

Comandos:

- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm test`

Resultado al 25 de abril de 2026:

- typecheck en verde
- lint frontend en verde via script raiz
- build frontend/backend en verde
- suite automatica en verde: `168/168`
- `test/helpers/server.ts` desactiva jobs progresivos de fondo durante tests HTTP con `FLY_DESK_DISABLE_BACKGROUND_SEARCH_JOBS=1`; esto evita handles vivos en Windows y no cambia el runtime normal

## Documentacion historica

Siguen siendo utiles como referencia historica, no como descripcion del estado presente:

- `docs/CODE_AUDIT_2026-03-27.md`
- `docs/UI_UX_AUDIT_2026-03-27_LIVE.md`

## Deuda tecnica vigente

- `frontend/src/App.tsx` concentra composicion, filtros y seleccion; conviene seguir extrayendo verticalmente si crece
- `src/local-agil.ts` sigue concentrando mucha logica de sesion, cliente y mapping
- el store sigue siendo en memoria; no hay persistencia externa para jobs
- `npm run lint` delega al ESLint real del frontend
- el deploy remoto completo sigue bloqueado por la dependencia de sesion local de navegador para Agil
- la extraccion de token Costamar por CDP requiere que Chrome se lance con `--remote-debugging-port`; sin ese flag, se depende de archivos de sesion que Chrome puede no tener desbloqueados
- la busqueda migratoria lanza 8 jobs de rango con concurrencia limitada, lo cual debe vigilarse si sube el volumen de uso

## Cambios del 25 de abril de 2026

### Frontend React/Vite activo

- `src/server.ts` sirve `frontend/dist`
- `npm run build` compila frontend y backend
- `npm run lint` delega a `npm --prefix frontend run lint`
- `docs/FRONTEND_IDENTITY.md` define la identidad visual actual

### Endurecimiento posterior a auditoria

- el polling de busqueda sigue activo cuando el backend responde `unchanged` sin estado final
- el autocomplete ignora respuestas obsoletas fuera de orden
- los controles custom de autocomplete y pasajeros tienen semantica accesible adicional
- el servidor emite headers basicos de hardening en respuestas propias
- JSON invalido se reporta como 400 en lugar de 500
- `frontend/src/lib/api.ts` adapta el contrato React simple al payload BFF real (`request` + `sortMode`) y normaliza la respuesta para la UI actual
- los smoke tests de UI apuntan al shell React/Vite vigente, no al DOM legacy de `public/`

## Cambios del 9 de abril de 2026

### Extraccion de token Costamar via CDP

- nueva funcion `readCostamarCandidatesViaCDP()` en `provider-context.ts`
- lee `DevToolsActivePort` del directorio de usuario de Chrome
- conecta al protocolo CDP para listar pestanas abiertas
- extrae tokens de URLs de Costamar visibles en pestanas
- se integra al pipeline existente: file-based -> CDP -> fallback profiles
- requiere Chrome con `--remote-debugging-port` habilitado

### Verificacion y estado de token

- `getCostamarTokenStatus()`: devuelve estado completo del token (terminal, usable, expiracion, minutos restantes)
- `verifyCostamarTokenLive()`: verificacion async via API de Costamar (`GET /engines/:terminalId`)
- nuevo endpoint `GET /api/costamar/token-status` con parametro opcional `?verify=true`

### Modo de busqueda migratoria

React vuelve a exponer `Migratorio` como flujo real. Usa origen y destino, arma 8 rangos mensuales contando el mes actual, consulta cada mes como `stay-range` con concurrencia limitada y conserva la sesion original de cada oferta para cotizacion.
