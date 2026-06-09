# Estado Actual de la Repo

Fecha de corte: 2026-06-01

## Resumen

Fly Desk es una aplicacion web privada para agentes de viajes. El runtime activo es Bun-only: Bun instala dependencias, ejecuta el backend, compila la UI React, sirve el BFF HTTP y usa `bun:sqlite` para caches locales o de VPS.

El repo no versiona artefactos generados:

- `dist/` esta ignorado
- `frontend/dist/` esta ignorado
- `output/` esta ignorado
- `config/results-layout.json` puede generarse localmente desde el layout editor y no debe tratarse como estado fuente

## Producto Vigente

### UI React

- busqueda exacta
- busqueda flexible de solo ida via rango `stay-range`
- busqueda flexible ida/vuelta via `/api/matrix`, normalizada a lista de resultados
- busqueda migratoria mensual: selector de meses hasta fin del año actual y fan-out solo para meses marcados
- autocomplete de origen y destino
- sugerencias frecuentes de origen/destino con ranking global persistido en el VPS; el backend registra la ruta cuando acepta una busqueda
- filtros de escalas, tiempo maximo de escala, equipaje y aerolineas
- resultados paginados con advertencias del backend
- panel lateral con precio, equipaje, condiciones, rutas de compra y cotizacion
- ajuste persistente de columnas bajo `?layoutEditor=1` o `?layout=editor`

La UI React no debe mostrar controles simulados. Permanecen fuera de la interfaz visible:

- multidestino
- vista calendario/matriz dedicada
- `reprice`

### Feedback De Carga

- busqueda exacta: placeholder inline en resultados
- polling y revalidacion: badge `Actualizando`
- resultados parciales: badge `Parcial` y advertencias agregadas
- cotizacion: estado de carga dentro del panel de detalle

## Runtime, Seguridad Y Dependencias

### Web Privada

- el servidor escucha en `127.0.0.1` por defecto
- en produccion queda detras de Caddy y mantiene `HOST=127.0.0.1`
- `FLY_DESK_WEB_AUTH=1` activa login web con cookie httpOnly firmada
- `FLY_DESK_TRUST_LOOPBACK_CLIENT=0` es obligatorio cuando hay reverse proxy local
- `FLY_DESK_TRUST_REVERSE_PROXY_LOOPBACK=1` solo debe usarse si el proxy local tambien bloquea o autentica rutas local-only; por defecto las solicitudes con `x-forwarded-for`, `forwarded` o `x-real-ip` no heredan confianza loopback
- endpoints operativos aceptan cookie web valida o `FLY_DESK_API_TOKEN`
- diagnosticos, estado de token Click and Book Plus y apertura local de browser son loopback-only
- layout de resultados acepta auth web porque es una preferencia de la app
- la restriccion publica por pais vive en `grumitos/vps-platform`: Caddy bloquea `/login` y el resto de la app fuera de Peru antes de llegar a Fly Desk
- la politica de fechas es movil: `minSearchDate = hoy`, `maxSearchDate = hoy + SEARCH_MAX_FUTURE_DAYS`
- las estadias ida/vuelta se limitan a 90 noches

### Supply Chain

- package manager soportado: Bun (`packageManager: "bun@1.3.13"`)
- lockfile vigente: `bun.lock`
- `bunfig.toml` desactiva lifecycle scripts durante instalacion y filtra versiones publicadas hace menos de 3 dias
- `.npmrc` define `ignore-scripts=true` como proteccion para instalaciones accidentales con npm/pnpm
- no se adopta pnpm como flujo normal porque el repo es Bun-only y no hay `pnpm-lock.yaml`
- el grafo actual no usa paquetes `@tanstack/*`
- cualquier dependencia que necesite scripts de instalacion debe aprobarse con `trustedDependencies` y una nota en el cambio
- no hay launchers Windows ni scripts de autoupdate local en esta rama web

### Providers

- Agil usa sesion persistente de Chrome y subscription key desde entorno o recuperada desde el bundle Agil
- Click and Book Plus usa contexto controlado por entorno, allowlist de hosts y warm-up B2B opcional
- Click and Book Plus no acepta hosts/base URLs por request
- el prewarm silencioso de providers esta activo por defecto y puede apagarse con `FLY_DESK_PROVIDER_PREWARM=0`
- las busquedas de proveedor deben ejecutarse en el runner dedicado cuando `FLY_DESK_SEARCH_SERVICE_URL` esta configurado; dentro del runner, `FLY_DESK_SEARCH_WORKER_PROCESSES=1` mantiene proveedores en procesos hijos
- `FLY_DESK_SEARCH_WORKER_PROCESSES=0` queda como excepcion temporal de QA y requiere repetir QA externo antes de cambiar conteos de workers, runner o warm-up
- toda busqueda publica espera a Agil y Click and Book Plus y retiene las ofertas completas devueltas por ambos; los filtros visibles se materializan sin recortar `allOffers`, y los limites de concurrencia solo regulan solicitudes en lote
- la admision global de busquedas usa unidades de capacidad: presupuesto default `4`, exacta `1`, rango `2`, matriz `2`, cola default `8` y timeout default `120000ms`
- el proxy web hacia el runner de busquedas mantiene un piso de timeout igual al default operativo; no usar valores menores en produccion porque polling con muchas ofertas puede necesitar mas de un segundo
- la capacidad se libera solo cuando termina el trabajo de proveedores; la cache de sesiones y purchase paths queda en `src/session-store.ts` hasta su TTL operativo
- cancelar desde la UI, cerrar la pestaña o detener ordenadamente el proceso cambia el job remoto a cancelado; en `pagehide`/`beforeunload` y shutdown se pide cache parcial para conservar lo ya resuelto y detener workers en el VPS
- los enlaces externos siguen pasando por `/r/<id>` como cache local de purchase paths; Agil redirige sin pagina intermedia, mientras Click and Book Plus conserva validacion/refresh de token antes del `302`
- en produccion `/r/*` puede resolverse desde `fly-desk-redirect.service`, un proceso Bun separado que lee la misma SQLite de sesiones y mantiene la misma autenticacion web/API antes de abrir proveedor

## Estructura Funcional

### Frontend

- `frontend/index.html`: shell HTML/React usado por el build Bun
- `frontend/public/`: favicon y assets estaticos copiados a `frontend/dist`
- `frontend/src/main.tsx`: entrypoint React
- `frontend/src/App.tsx`: composicion principal, filtros, seleccion y layout responsive
- `frontend/src/components/`: `TopBar`, `SearchShell`, `ResultsPanel`, `DetailPanel` y componentes UI
- `frontend/src/components/results/`: `ResultCard`, modelo de tarjeta, CSS y layout editor
- `frontend/src/hooks/`: `useSearch` y `useAutocomplete`
- `frontend/src/lib/api.ts`: cliente HTTP, busqueda/polling, matriz, migratorio, autocomplete, layout y cotizacion
- `frontend/src/lib/location-usage-suggestions.ts`: cliente HTTP del ranking global de origen/destino frecuentes
- `frontend/src/index.css`: tokens, layout, tema claro/oscuro y estados visuales
- `scripts/build-frontend.ts`: build con `Bun.build`, `bun-plugin-tailwind` y copia de `frontend/public`

### Backend

- `src/server.ts`: `Bun.serve`, serving de `frontend/dist`, headers, limite de body e inyeccion de config runtime
- `src/redirect-service.ts` y `src/redirect-index.ts`: resolver dedicado de `/r/<id>` desde cache SQLite para no depender del runtime principal en clicks a proveedores
- `src/http-router.ts`: rutas HTTP, auth web/loopback/token, jobs, matriz, cotizacion, redirects, diagnosticos y layout
- `src/web-auth.ts`: password web, cookie firmada y validacion de sesion
- `src/core/quotation.ts`: render de cotizaciones a partir de ofertas almacenadas y validadas del lado servidor
- `src/search-date-policy.ts`: ventana movil de fechas y config publica embebida
- `src/provider-context.ts`: contexto Click and Book Plus, allowlist, recovery desde Chrome/CDP y estado live de token
- `src/local-agil.ts`: sesion local, refresh token, exact/range/matrix, pricing y deep links
- `src/local-costamar.ts`: autocomplete, exact/range/matrix, branded links y warm-up B2B de Click and Book Plus
- `src/providers/costamar/search-payloads.ts`: payloads Click and Book Plus; `costamar` se conserva como alias interno legacy
- `src/core/`: normalizacion, matriz, grouping, ranking, cotizacion y tipos compartidos
- `src/search-service-client.ts`: proxy loopback de busquedas/matriz/polling/cancelacion hacia `fly-desk-search.service`
- `src/search-worker-client.ts` y `src/search-worker.ts`: procesos hijos Bun para busquedas pesadas de proveedor dentro del runner
- `src/session-store.ts`: jobs vivos, SQLite local, migracion JSON legada, redirects y purchase paths
- `src/location-suggestion-cache.ts`: cache SQLite de autocomplete con TTL
- `src/location-usage-store.ts`: ranking global SQLite de origen/destino frecuentes
- `src/runtime-paths.ts`: fallback persistente basado en `FLY_DESK_APP_DATA_DIR` para caches SQLite cuando no hay `*_DB_PATH` especifico

### Operacion

- `scripts/build-frontend.ts`: build frontend
- `scripts/generate-web-password-hash.ts`: genera hash scrypt para `FLY_DESK_WEB_PASSWORD_HASH`
- `docs/DEPLOY_APP.md`: deploy y rollback de app
- `.github/workflows/ci.yml`: CI Bun para typecheck, lint, test y build
- `.github/workflows/deploy-vps.yml`: deploy manual y rollback por SHA/release al VPS; reinicia `fly-desk-search.service` y `fly-desk-redirect.service` si la plataforma ya los instalo

La infraestructura compartida del VPS ya no vive en este repo: Caddy, systemd, rollback de Caddy y plan de plataforma se mantienen en `grumitos/vps-platform` (`D:\Dev\VPS\vps-platform`). Este repo conserva app, CI, deploy de revision y rollback de release.

Despues de un deploy de app que toque busquedas, cancelacion o redirects, cerrar la verificacion con `Fly Desk Production Smoke` en `vps-platform`. Ese workflow valida health local de web/search/redirect, busqueda completada, `/r/*` para Agil y Click and Book Plus, cancelacion de una segunda busqueda y servicios activos.

## Pruebas

Comandos principales:

- `bun install --frozen-lockfile`
- `bun run typecheck`
- `bun run lint`
- `bun run build`
- `bun run test`

La suite vive en `test/**/*.test.ts`; los helpers compartidos estan en `test/helpers/`. No se mantiene una lista manual de archivos de test para evitar que este documento quede desfasado cuando la suite crece.

Cobertura importante actual:

- bind por defecto a loopback y override por `HOST`
- auth web con cookie firmada y loopback deshabilitable
- token API para clientes no loopback
- endpoints loopback-only
- validacion compartida de fechas con ventana movil
- contexto Click and Book Plus endurecido
- key requerida o recuperable para Agil live
- workers Bun habilitados por defecto para aislar busquedas pesadas de proveedor
- persistencia SQLite y migracion JSON legada de sesiones/autocomplete
- ranking global de sugerencias frecuentes en servidor, no por `localStorage` de cada navegador; se registra desde `/api/search` y `/api/matrix`
- layout persistente de resultados
- rail de busqueda, filtros, tema, autocomplete, provider links y cotizacion

Nota de QA: `test/helpers/server.ts` fija `FLY_DESK_DISABLE_BACKGROUND_SEARCH_JOBS=1` durante tests HTTP para validar contratos inmediatos sin dejar jobs progresivos vivos. El runtime normal no define esa variable.

## Documentacion Vigente

- `README.md`
- `frontend/README.md`
- `docs/REPO_CURRENT_STATE.md`
- `docs/DEPLOY_APP.md`
- `docs/FRONTEND_IDENTITY.md`

## Estado De Deploy

`main` es la linea de producto y despliegue. El deploy repetible escribe el SHA activado en `/opt/fly-desk/REVISION` y lo verifica despues de reiniciar `fly-desk.service`. Si la plataforma ya instalo `fly-desk-search.service` o `fly-desk-redirect.service`, el mismo deploy los reinicia y valida sus healthchecks locales.

Las revisiones desplegadas y el inventario de servicios vivos se mantienen en `D:\Dev\VPS\vps-platform\docs\INVENTORY.md`. Este repo no mantiene SHAs productivos como estado vivo para evitar drift documental.

No se mantienen planes de migracion ni auditorias historicas como documentacion viva. El historial Git conserva ese contexto si hace falta recuperarlo.

## Deuda Tecnica Vigente

- `frontend/src/App.tsx` todavia concentra bastante composicion, filtros y seleccion
- `src/local-agil.ts` concentra sesion, cliente, pricing y mapping
- `src/local-costamar.ts` concentra automatizacion B2B, cliente, mapping y redirects de Click and Book Plus
- la persistencia es SQLite local; no hay store externo para multi-instancia
- Chrome CDP persistente ya queda cubierto por `fly-desk-chrome.service`; Agil aun necesita una sesion real valida en ese perfil del VPS
- repetir QA externo antes de cambiar `FLY_DESK_SEARCH_WORKER_PROCESSES` o warm-up de providers en VPS
- la busqueda migratoria consulta cada dia de cada mes seleccionado contra Agil y Click and Book Plus sin filtros de tarifa; procesa meses en tandas configurables con `FLY_DESK_MIGRATION_CONCURRENT_MONTHS` (default `2`), lo cual debe vigilarse si sube el volumen de uso
