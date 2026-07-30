# Rediseño · pendiente de cablear

Estado del frontend tras implementar `Fly Desk Rediseño.dc.html`, y qué falta del
lado del backend para que cada superficie muestre datos reales en lugar de
degradarse.

Regla que siguió toda la implementación: **cuando un dato no existe, la pieza
desaparece; nunca se inventa**. Una cobertura de mes fabricada o un contador de
asientos por defecto son peores que no mostrar nada, porque hacen que un mes
apenas muestreado parezca verificado.

---

## 1. Datos que el diseño asume y el contrato aún no entrega

### 1.1 `faredDays` / `queriedDays` por mes — **no existe en el contrato**

Plate 1i cierra la tarjeta de mes con «12 de 30 días con tarifa»: es lo que
distingue un mes genuinamente barato de uno apenas muestreado.

- **Dónde se consume:** `frontend/src/components/results/MigrationMonthGrid.tsx`,
  función `monthFareCoverage()`.
- **Qué falta:** añadir `faredDays: number` y `queriedDays: number` a
  `MigrationMonthSummary` (`frontend/src/types/index.ts`) y poblarlos al agregar
  el mes.
- **Comportamiento actual:** la línea no se dibuja. El resto de la tarjeta es
  correcto.

### 1.2 Las dos siguientes tarifas del mes — **campo existe, sin poblar**

Plate 1i: «al pie, las dos siguientes tarifas del mes — el agente compara sin
abrir cada mes ni decidir con un solo vuelo».

- **Dónde se consume:** `MigrationMonthGrid.tsx`, función `nextFaresForMonth()`.
- **Qué falta:** `MigrationMonthSummary.offers` ya existe en el tipo, pero hoy la
  agregación por mes retiene una sola oferta (`month.offer`). Hace falta
  conservar al menos las 3 más baratas del mes.
- **Comportamiento actual:** el pie queda vacío si solo llega una oferta.

### 1.3 `fareMeta.seatsRemaining` en las ofertas de la lista

Plate 1b muestra los asientos restantes bajo el precio, **solo cuando quedan 4 o
menos** (crítico a ≤2). Hoy el campo aparece principalmente en el detalle.

- **Dónde se consume:** `result-card-model.ts`, función `seatsParts()`.
- **Qué falta:** confirmar que los proveedores pueblan `seatsRemaining` en las
  ofertas de listado, no solo al pedir el detalle.
- **Comportamiento actual:** sin el dato la tarjeta cae al precio por persona.

### 1.4 Aerolínea operadora (codeshare) por oferta

Plate 1b la pinta junto al nombre, como «op. LATAM»: el agente necesita saber
quién vuela realmente porque es con quien lidia el pasajero en el mostrador.

- **Dónde se consume:** `result-card-model.ts`, función `operatingCopy()`.
- **Qué falta:** `Segment.operatingCarrier` y `operatingCarrierName` existen en
  `src/core/types.ts`; hace falta que los normalizadores de cada proveedor los
  rellenen cuando difieren del `marketingCarrier`.
- **Comportamiento actual:** sin el dato no se muestra nada (correcto).

### 1.5 Sugerencias de ciudad vs. aeropuerto

Plate 2a distingue la fila «todos los aeropuertos de la ciudad» con un
pictograma distinto (capas), porque una cotización real casi siempre acepta
cualquiera de los tres aeropuertos.

- **Dónde se consume:** `SearchShell.tsx`, función `isCityGroupSuggestion()`.
- **Qué falta:** que `LocationSuggestion` traiga un discriminante explícito
  (`type: "CITY" | "AIRPORT"`). Hoy el frontend lo infiere de `type === "CITY"`
  o del texto «todos los aeropuertos», que es frágil.

### 1.6 Recientes y Frecuentes con el campo vacío

Plate 2a: con el campo vacío el mismo panel muestra *Recientes* y *Frecuentes*
con la misma fila de 46 px; al escribir se reemplaza por *Coincidencias*.

- **Dónde se consume:** `getLocationUsageSuggestions()`
  (`frontend/src/lib/location-usage-suggestions.ts`) ya alimenta los chips de
  estación bajo Origen/Destino.
- **Qué falta:** separar *recientes* (esta sesión / este agente) de *frecuentes*
  (ranking global) para poder titular las dos secciones del panel.
- **Comportamiento actual:** solo los chips de 32 px bajo cada campo.

---

## 2. Decisiones de contrato pendientes

### 2.1 Cotización migratoria: ¿core compartido o endpoint?

Plate 6a dice: «El frontend no compone nada: pide el texto con
`migrationPlan: true` y lo pinta».

- **Estado:** el texto se compone en `src/core/quotation.ts`
  (`buildCommercialQuotation`, que ya acepta `migrationPlan` y produce las cuatro
  diferencias: título con ciudad y bandera, «ida + retorno de apoyo anulable»,
  las cuatro líneas del paquete en INCLUYE, y la condición de asiento
  aleatorio). El componente solo pasa el flag y pinta el resultado.
- **Decisión:** si «no compone nada» significa *literalmente* que el texto llegue
  por HTTP, hace falta un endpoint `POST /api/quotation` que reciba
  `{ offerId, migrationPlan }`. Si basta con que la composición viva en el core
  compartido y no en los componentes, ya está cumplido.
- **Riesgo de no decidirlo:** la lógica comercial quedaría duplicada si alguien
  añade el endpoint sin retirar la ruta del core.

### 2.2 Antigüedad de la tarifa (`quotationPreparedAt`)

Plate 1h pone «la antigüedad de la tarifa a la vista»: *Tarifa preparada hace
2 min · vuelve a cotizar si pasa de 15*.

- **Dónde se consume:** `frontend/src/components/QuotationOverlay.tsx`,
  función `fareAgeLabel()`.
- **Qué falta:** que `CanonicalOffer.quotationPreparedAt` se fije en el momento
  en que el proveedor confirma la tarifa (hoy ya se usa como *gate* de
  «cotizable», pero conviene verificar que el timestamp es el de confirmación y
  no el de creación del job).
- **Comportamiento actual:** sin el dato el pie muestra solo la regla de los 15
  minutos, sin la edad.

### 2.3 Techos de estancia y pasajeros en `PublicRuntimeConfig` — **2 campos**

La línea de política de plate 1a anuncia tres hechos, y solo uno venía del
backend:

| Dato | Origen |
|---|---|
| Ventana de búsqueda | `getPublicRuntimeConfig()` → `window.__FLYDESK_RUNTIME__.searchDatePolicy` ✅ |
| «hasta 90 noches» | constante del frontend que *coincide* con `MAX_FLEXIBLE_STAY_NIGHTS` (`src/core/flexible-search.ts:28`) |
| «hasta 9 pasajeros» | constante del frontend que *coincide* con el chequeo de `src/http-search-contract.ts:268` |

Los dos techos estaban duplicados, no cableados. Es el modo de falla que la
lámina existe para evitar: la línea **promete** una política, así que si el
backend baja su techo a 8, la pantalla sigue anunciando 9 y el agente se enteraría
recién al ser rechazado. Lo mismo aplica a «un bebé en falda por adulto», que
duplica `src/http-search-contract.ts:264`.

- **Ya hecho en el frontend:** `getRuntimeSearchLimits()`
  (`frontend/src/components/SearchShell.tsx`) lee `maxStayNights` y
  `maxPassengers` de `window.__FLYDESK_RUNTIME__`, con 90 / 9 como respaldo. Se
  resuelve a nivel de módulo, que es válido porque `src/server.ts` inyecta la
  config en `<head>` y el bundle es el último script del `<body>`.
- **Qué falta:** añadir `maxStayNights` y `maxPassengers` a `PublicRuntimeConfig`
  (`src/search-date-policy.ts`), tomándolos de `MAX_FLEXIBLE_STAY_NIGHTS` y del
  techo de pasajeros que ya valida el contrato. **No hace falta tocar el
  frontend**: en cuanto los campos aparezcan, los usa.

### 2.4 Pegar cotización (plate 3a) — **parser no existe**

Plate 3a reconstruye una búsqueda a partir de un **texto comercial pegado**,
campo por campo, con tres estados: leído, leído pero no se usa, y ausente («queda
sin filtro», con palabras, no con un hueco). La tarifa del texto **nunca** se
hereda.

- **Estado:** `readSharedSearchFromText()`
  (`frontend/src/lib/search-share.ts`) solo lee el JSON de configuración que la
  propia app copia. No parsea una cotización comercial en prosa.
- **Qué falta:** un parser de cotización → `SearchRequest` parcial, con un mapa
  de qué campo salió de qué línea y qué no se pudo leer. Encaja mejor en
  `src/core/` (junto a `quotation.ts`, que es su inversa) que en el frontend.
- **Comportamiento actual:** el icono de pegar sigue aceptando el JSON de la
  app. El panel de reconstrucción de 940 × 520 **no está construido**, porque sin
  parser no tendría nada que mostrar.

### 2.5 Horarios alternativos por tramo (plate 3b)

Plate 3b: «Cada tramo se elige por separado; al elegir, la tarjeta y el detalle
se repintan».

- **Estado:** la tira de la tarjeta y la lista completa funcionan, pero eligen
  una **oferta completa** alternativa, no un tramo. La agrupación es
  client-side, sobre `rawRefs.agilGroupId` / `rawRefs.recommendationId`
  (`frontend/src/components/results/result-groups.ts`).
- **Qué falta para el comportamiento del plate:** poder recombinar ida y vuelta
  de forma independiente. Eso es soporte de backend: hoy no hay forma de pedir
  «esta ida con esa vuelta» y obtener una tarifa válida.
- **Dependencia adicional:** la agrupación depende de que `rawRefs` traiga
  `agilGroupId` o `recommendationId`. Si un proveedor deja de enviarlos, la tira
  desaparece y cada horario vuelve a ser una fila.

### 2.6 Estado de proveedores en reposo — **diferido por el propio diseño**

`docs/detalles-no-visibles.md` lo deja explícito: mostrar qué proveedor está
caído antes de buscar exige una superficie de loopback que hoy no existe.
Mientras no exista, **aparecer = disponible**.

- **Estado:** el zócalo se alimenta de `configuredSearchProviders()`
  (`frontend/src/lib/providers.ts`), una lista estática.
- **Qué falta cuando exista el loopback:** cambiar esa función por una lectura
  del backend. La firma ya está pensada para eso.

---

## 3. Superficie de backend que el frontend dejó de usar

### 3.1 `/api/results-layout` — **retirable**

El editor de anchos de columna existía para ajustar la grilla de la tarjeta.
Plate 1b **cierra** esa grilla en `32 / 186 / 1fr / 116 / 26`, así que no queda
nada que ajustar.

- **Retirado del frontend:** `frontend/src/lib/results-layout-editor.ts`, el
  editor dentro de `ResultsPanel`, y las llamadas `getResultsLayout()` /
  `saveResultsLayout()` quedaron sin consumidores.
- **Qué queda del lado backend:** el endpoint `GET`/`POST /api/results-layout`,
  el archivo `config/results-layout.json`, las funciones en
  `frontend/src/lib/api.ts` y los tests en
  `test/http-router.integration.test.ts` (~4 casos).
- **Decisión:** retirar endpoint + archivo + tests, o dejarlos como superficie
  muerta. Recomendación: retirar.

---

## 4. Lo que quedó pendiente del lado frontend

Honestidad sobre el alcance entregado.

### 4.1 Móvil: plates 1c – 1f — **no implementadas**

El archivo del diseño llega por API con un tope de 256 KiB y mide 377 KB, así que
las láminas 1c–1i venían truncadas; se recuperaron al final de la sesión (vía
`/design/v1/design/projects/{id}/download?path=…`, que no tiene ese tope) y se
verificó por hash que el prefijo ya aplicado era idéntico. Alcanzó para corregir
1h, 1i y los contadores de 1g, pero no para reconstruir el móvil.

Falta, con su especificación ya conocida:

- **1c · móvil en reposo:** origen y destino como **un único control** con el
  intercambio de 44 px sobre la división; valores a 16 px, campos de 58 px, CTA
  de 52 px a todo el ancho.
- **1d · móvil resultados:** retracción de herramientas al desplazar (dispara a
  los 88 px, bloquea 300 ms tras cada cambio — sin ese bloqueo el reajuste de
  altura vuelve a disparar el gesto y la cabecera vibra); la lista pasa de 6 a 7
  tarjetas; la fila de estado nunca se va y saca un botón de filtros.
- **1e · hoja de filtros:** segmentados de 44 px, filas de aerolínea de 48 px con
  logo, y el botón primario dice cuántos vuelos quedan antes de cerrar.
- **1f · hoja de oferta:** el itinerario por tramo con su ciudad, su vuelo y su
  escala; «Cotizar» copia y confirma en una línea (sin panel intermedio: en móvil
  la cotización no se edita).

Hoy el móvil sigue en el layout de pestañas anterior (Resultados / Filtros /
Oferta). Las piezas compartidas ya están listas a escala táctil: las celdas de
calendario suben a 44 px por media query, y el catálogo 36/44/52 está en
`design-system.css`.

### 4.2 Suite Playwright — **37 de 51 en rojo**

`test/ui/*.playwright.ts` son 4.889 líneas fijadas al DOM anterior:
`.fd-result-card` (ahora `.fd-card`), `.fd-filter-slider`,
`.fd-results-layout-editor`, `.fd-migration-grid` (ahora `.fd-month-grid`),
`.fd-offer-detail-*`, `.fd-alert` / `.fd-search-alert`, `.fd-result-variant-card`,
`.fd-result-group`, `--fd-results-col-*`.

Se dejaron en rojo a propósito. Varios casos verifican comportamientos que el
rediseño **elimina** deliberadamente («normal results wait for saved column
layout», «layout editor guide renders as the first result card», «baggage filter
uses one compact slider»), así que reescribirlos mecánicamente para que pasen
produciría una suite que aprueba aserciones vacías — peor que una roja, porque
esconde regresiones. Es un trabajo aparte y por caso.

`bun run typecheck`, `bun run lint`, `bun run build` y `bun run test:core`
(412 tests) están en verde.

---

## 5. Verificación

```bash
bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run build && bun run test:core
```
