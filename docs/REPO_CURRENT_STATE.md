# Estado Actual de la Repo

Fecha de corte: 2026-03-28

## Resumen

Fly Desk es hoy una aplicacion desktop-first para agentes de viajes, con frontend vanilla y backend Node, conectada a Agil mediante reutilizacion de sesion local del navegador.

No hay assets compactados o bundles versionados en la repo actual:

- `dist/` esta ignorado
- `output/` esta ignorado
- no se versionan archivos minificados generados

## Trabajo entregado

### UI y UX

- rediseño completo del shell desktop
- orden del rail principal priorizando `Exacto/Flexible`
- calendario propio integrado al layout
- popover de pasajeros y autocomplete alineados a la misma gramatica visual
- sidebar por aerolinea y panel lateral de detalle
- normalizacion de `Consulta` y `Oferta` como paneles hermanos con header persistente
- soporte explicito de tema claro y oscuro
- reemplazo del switch textual de tema por iconos
- radios y formas unificados entre controles
- retiro de copy sobrante en el buscador
- eliminacion de reflows del rail al cambiar `Escala`

### Simplificacion del formulario

Se retiraron del frontend visible:

- cabina
- moneda editable
- precio maximo
- maximo de escalas

Defaults actuales enviados por cliente:

- `currencyCode: "USD"`
- `cabin: "ECONOMY"`

Filtros visibles actuales:

- `Directo`
- `Equipaje`
- `Escala`

Semantica actual:

- `Escala` vacia implica sin limite, sin declararlo en el boton
- ya no existe `maxStops` oculto enviado por frontend
- `maxLayoverMinutes` solo se envia cuando el usuario elige `2h`, `4h` u `8h`

### Feedback de carga

Se elimino el overlay global que cubria toda la pantalla al buscar.

Estado actual:

- busqueda exacta: placeholder inline en el area de resultados
- matriz flexible: celdas loading en la propia matriz
- `reprice` / `quotation`: placeholder dentro del panel de detalle
- `toastContainer` ahora tiene `aria-live`

### Integracion local con Agil

- refresh de token soportando `accessToken`
- derivacion de sesion desde storage real de Chrome/Edge
- `start-search` + consultas GDS reales
- matrix/flexible con concurrencia minima de 10 requests en paralelo
- redirects a Agil con labels humanos en origen/destino

### Higiene tecnica

- limpieza de codigo muerto en frontend
- retiro del limite silencioso de escalas que rompia busquedas round-trip
- limpieza de `purchasePaths` viejos en memoria
- launcher estable de un clic con puerto fijo y estado persistido en `.launcher/`
- ignores para artefactos locales:
  - `.codex/`
  - `.playwright-cli/`
  - `.superpowers/`
  - `output/`

## Estructura funcional vigente

### Frontend

- `public/index.html`
  - topbar
  - search shell
  - refinements
  - calendar popover
  - workspace con sidebar, resultados y detalle
- `public/app.css`
  - tokens de tema
  - controles
  - overlays
  - resultados
  - matriz
  - placeholders
- `public/app.js`
  - estado global
  - validacion
  - calendario
  - render
  - polling
  - interacciones

### Backend

- `src/http-router.ts`
  - `/api/health`
  - `/api/agil/locations`
  - `/api/search`
  - `/api/search/:jobId`
  - `/api/matrix`
  - `/api/matrix/:jobId`
  - `/api/reprice`
  - `/api/quotation`
  - `/api/compare`
  - `/r/:id`
- `src/local-agil.ts`
  - sesion local
  - refresh token
  - exact
  - range
  - matrix
  - reprice
  - deep links
- `src/session-store.ts`
  - jobs en memoria
  - purchase paths

### Launchers para usuario final

Entradas pensadas para abrir/cerrar la app sin terminal:

- `Abrir Fly Desk.vbs`
- `Cerrar Fly Desk.vbs`
- `tools/start-fly-desk.ps1`
- `tools/stop-fly-desk.ps1`

Comportamiento actual:

- puerto fijo `32123`
- deteccion de instancia ya sana antes de intentar arrancar otra
- build bajo demanda si `dist/` esta ausente o viejo
- logs y estado en `.launcher/`
- wrappers `cmd` y `js` apuntando al mismo flujo PowerShell para evitar divergencias

## Pruebas vigentes

### Suite automatica

- `test/http-router.test.ts`
- `test/filtering.test.ts`
- `test/local-agil.test.ts`
- `test/session-store.test.ts`
- `test/theme-css.test.ts`
- `test/ui.test.ts`

Cobertura importante actual:

- rail de busqueda y orden del formulario
- smoke de `exacto/flexible` con `ida/ida-vuelta`
- controles retirados que no deben volver a aparecer
- `USD` fijo en payload
- ausencia de `maxStops` oculto en payload
- tema claro y oscuro
- calendario custom
- autocomplete anclado
- matriz flexible y paso a exacto
- paneles `Consulta` y `Oferta` con header homogeneo
- placeholder inline en busqueda
- carga inline en `reprice`

### Verificacion real reciente

Comandos:

- `npm test`
- `npm run typecheck`
- `npm run build`

Smoke real con Playwright sobre `http://127.0.0.1:3000`:

- exacta real con placeholder inline y 15 filas visibles
- detalle visible tras seleccionar oferta
- matriz flexible real con 15 celdas y al menos 1 seleccionable
- click en celda de matriz llevando a lista exacta con 15 filas

Artefactos locales de verificacion:

- `output/playwright/hygiene-live/exact-inline-loading-1920.png`
- `output/playwright/hygiene-live/exact-results-1920.png`
- `output/playwright/hygiene-live/exact-detail-1920.png`
- `output/playwright/hygiene-live/flex-matrix-1920.png`
- `output/playwright/hygiene-live/flex-matrix-to-list-1920.png`

Estos artefactos no forman parte del repositorio versionado.

## Documentacion retirada por obsolescencia

Se consideran obsoletos frente al estado actual del repo:

- planes de implementación viejos
- notas internas de herramientas auxiliares
- auditorias funcionales que describen la UI anterior o bugs ya corregidos
- research notes que describen un stack distinto al codigo real

## Deuda tecnica vigente

- `public/app.js` sigue siendo un archivo grande y multi-responsabilidad
- `src/local-agil.ts` sigue concentrando demasiada logica
- no hay linter configurado
- deploy remoto completo sigue bloqueado por dependencia de sesion local de navegador
