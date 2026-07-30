# Rediseño · cableado de backend y residuales

Estado verificado el 2026-07-29 tras cablear las secciones 1, 2 y 3 del informe
original. La sección 4 conserva el trabajo de móvil y la reescritura general de
Playwright que siguen fuera de este alcance.

Regla que siguió toda la implementación: **cuando un dato no existe, la pieza
desaparece; nunca se inventa**. Una cobertura de mes fabricada o un contador de
asientos por defecto son peores que no mostrar nada, porque hacen que un mes
apenas muestreado parezca verificado.

---

## 1. Datos del diseño entregados por el contrato

### 1.1 `faredDays` / `queriedDays` por mes — **terminado**

Plate 1i cierra la tarjeta de mes con «12 de 30 días con tarifa»: es lo que
distingue un mes genuinamente barato de uno apenas muestreado.

- `MigrationMonthSummary` expone ambos campos y la agregación mensual los
  calcula solo cuando el job terminó completo y no es parcial.
- `queriedDays` es el rango inclusivo consultado; `faredDays` cuenta fechas de
  salida ISO únicas con una oferta real dentro de ese rango.
- En resultados parciales ambos quedan ausentes: la UI no convierte una muestra
  incompleta en una cobertura aparente.

### 1.2 Las dos siguientes tarifas del mes — **terminado**

Plate 1i: «al pie, las dos siguientes tarifas del mes — el agente compara sin
abrir cada mes ni decidir con un solo vuelo».

- La agregación conserva las ofertas reales del mes; `month.offer` sigue siendo
  la seleccionada y `month.offers` permite obtener las dos tarifas siguientes.
- El filtrado visible actualiza tanto la selección como la colección mensual,
  evitando mostrar al pie una tarifa que ya no cumple los filtros.

### 1.3 `fareMeta.seatsRemaining` en las ofertas de la lista — **terminado con capacidad real**

Plate 1b muestra los asientos restantes bajo el precio, **solo cuando quedan 4 o
menos** (crítico a ≤2). Hoy el campo aparece principalmente en el detalle.

- Agil propaga la disponibilidad de la tarifa a la oferta de listado y solo
  acepta enteros no negativos.
- Los fixtures y respuestas observadas de Click and Book Plus no exponen una
  cantidad de asientos equivalente. En ese proveedor el campo permanece
  ausente; la tarjeta cae al precio por persona, sin inventar un contador.

### 1.4 Aerolínea operadora (codeshare) por oferta — **terminado**

Plate 1b la pinta junto al nombre, como «op. LATAM»: el agente necesita saber
quién vuela realmente porque es con quien lidia el pasajero en el mostrador.

- Los normalizadores Agil y Click and Book Plus propagan operador y nombre cuando
  el proveedor los entrega; los códigos se recortan y normalizan a mayúsculas.
- Si el dato falta, no se muestra; los fixtures cubren codeshare explícito.

### 1.5 Sugerencias de ciudad vs. aeropuerto — **terminado**

Plate 2a distingue la fila «todos los aeropuertos de la ciudad» con un
pictograma distinto (capas), porque una cotización real casi siempre acepta
cualquiera de los tres aeropuertos.

- `LocationSuggestion.type` admite únicamente `CITY` o `AIRPORT`, normalizados
  sin depender de mayúsculas/minúsculas.
- Ambos mappers lo toman del campo explícito del proveedor. Un valor desconocido
  queda `undefined`; el frontend usa el icono neutro y ya no infiere el tipo por
  frases del texto.

### 1.6 Recientes y Frecuentes con el campo vacío — **terminado**

Plate 2a: con el campo vacío el mismo panel muestra *Recientes* y *Frecuentes*
con la misma fila de 46 px; al escribir se reemplaza por *Coincidencias*.

- `GET /api/location-usage-suggestions` responde aditivamente
  `{ suggestions: frequent, frequent, recent }`; `suggestions` mantiene
  compatibilidad con clientes anteriores.
- *Frecuentes* conserva el ranking global permanente. *Recientes* vive en una
  tabla SQLite separada, se aísla por ID opaco de sesión y rol, vence a las 24 h,
  retiene hasta tres por rol/sesión y aplica un máximo global de 2.048 filas.
- El ID URL-safe de 16–96 caracteres se genera en `sessionStorage`, viaja en
  autocomplete, búsqueda y matriz, y se excluye del JSON para compartir.
- Con el campo vacío el panel muestra ambas secciones; al escribir las reemplaza
  por coincidencias. Una sesión ausente o inválida produce recientes vacíos.

---

## 2. Decisiones de contrato resueltas

### 2.1 Cotización migratoria: core compartido y endpoint de revalidación — **decidido**

Plate 6a dice: «El frontend no compone nada: pide el texto con
`migrationPlan: true` y lo pinta».

- `src/core/quotation.ts::buildCommercialQuotation()` es el compositor único.
  Tanto la UI como `POST /api/quotation` pasan `migrationPlan` a esa misma
  función; no hay una segunda plantilla comercial en el router o el componente.
- El primer «Cotizar» llama obligatoriamente a `POST /api/quotation` con los IDs
  fuente de búsqueda y oferta. El endpoint solo acepta una oferta completa
  guardada; una celda de matriz que tenga precio pero no itinerario real no es
  cotizable.
- Una tarifa `validated` / `verified` se reutiliza únicamente durante los 15
  minutos siguientes a `priceVerifiedAt`. Sin timestamp, o al vencer esa
  ventana, el endpoint consulta de nuevo al proveedor y exige la misma firma
  canónica de vuelo (tramos, números, aeropuertos y horarios). Una alternativa
  más barata del mismo día y ruta no puede sustituir silenciosamente la elegida.
- Agil y Click and Book Plus incluyen el precio en sus IDs normalizados. La
  recotización conserva el ID interno seleccionado al persistir el mismo vuelo,
  pero actualiza precio, referencias, paths y `priceVerifiedAt`; una segunda
  cotización dentro de la ventana reutiliza ese registro fresco.
- El cliente acepta la respuesta únicamente si conserva la sesión solicitada y
  trae una oferta de transporte completa, precio positivo, moneda,
  `validated` / `verified`, timestamp válido y texto no vacío. Solo entonces
  abre y copia la cotización; un fallo cae al estado de error cerrado y no
  permite copiar ni recomponer el borrador local sin validar.
- El interruptor migratorio regenera el texto localmente desde el mismo core y
  sobre la oferta ya revalidada, sin una segunda consulta al proveedor. Eso
  mantiene la interacción inmediata sin duplicar reglas de negocio.

### 2.2 Antigüedad de la tarifa (`quotationPreparedAt`) — **semántica cerrada**

Plate 1h pone «la antigüedad de la tarifa a la vista»: *Tarifa preparada hace
2 min · vuelve a cotizar si pasa de 15*.

- `quotationPreparedAt` significa **primera materialización local con todos los
  datos necesarios para cotizar**. Se fija una sola vez y se preserva en nuevas
  materializaciones del mismo resultado; no es el instante de creación del job.
- No significa confirmación del proveedor. La revalidación real se representa
  con `priceVerifiedAt`, que solo cambia al pasar por la consulta de cotización.
- La misma constante compartida fija en 15 minutos la advertencia visible y la
  ventana máxima durante la que el backend puede reutilizar esa revalidación.
- Los borradores SWR cacheados retiran `quotationPreparedAt` hasta que los datos
  frescos vuelven a estar listos, por lo que la UI no publica una edad falsa.

### 2.3 Techos de estancia, pasajeros y bebés en `PublicRuntimeConfig` — **terminado**

La línea de política de plate 1a anuncia tres hechos, y solo uno venía del
backend:

| Dato | Origen |
|---|---|
| Ventana de búsqueda | `getPublicRuntimeConfig()` → `window.__FLYDESK_RUNTIME__.searchDatePolicy` ✅ |
| «hasta 90 noches» | `maxStayNights` desde `MAX_FLEXIBLE_STAY_NIGHTS` |
| «hasta 9 pasajeros» | `maxPassengers` desde `MAX_SEARCH_PASSENGERS` |
| «un bebé en falda por adulto» | `maxLapInfantsPerAdult` desde `MAX_LAP_INFANTS_PER_ADULT` |

Las tres reglas viven en `src/core/search-limits.ts`. El contrato HTTP valida con
esas constantes y `getPublicRuntimeConfig()` las inyecta en la página; la UI lee
los tres campos y conserva respaldos compatibles solo para HTML antiguo. Además,
el backend rechaza estadías >90 noches y matrices de más de 5.000 combinaciones
antes de iniciar el fan-out.

### 2.4 Pegar cotización (plate 3a) — **parser terminado; panel diferido**

Plate 3a reconstruye una búsqueda a partir de un **texto comercial pegado**,
campo por campo, con tres estados: leído, leído pero no se usa, y ausente («queda
sin filtro», con palabras, no con un hueco). La tarifa del texto **nunca** se
hereda.

- `src/core/quotation-parser.ts` transforma texto acotado a una solicitud
  parcial y entrega trazas de línea 1-based con estados `parsed`, `missing`,
  `ambiguous`, `ignored` o `invalid`.
- Reconoce ruta IATA, tipo de viaje y fechas con año explícito. Fechas sin año
  quedan ambiguas; pasajeros y cabina quedan ausentes si no son inequívocos;
  aerolínea, escalas y precio se marcan como ignorados.
- Nunca hereda la tarifa ni inventa adultos/filtros. Normaliza CRLF, limita la
  entrada a 16.384 caracteres y tiene cobertura hostil/ambigua.
- El módulo queda como contrato preparado y probado, sin consumidor productivo:
  no se añadió un endpoint o flujo intermedio solo para aparentar cableado.
- **Residual de frontend:** el icono existente todavía lee el JSON compartido;
  el panel de reconstrucción 940 × 520 no forma parte de este alcance.

### 2.5 Horarios alternativos por tramo (plate 3b) — **contrato seguro; recombinación diferida**

Plate 3b: «Cada tramo se elige por separado; al elegir, la tarjeta y el detalle
se repintan».

- `SearchResponse.scheduleGroups` publica grupos respaldados por identidad nativa
  de Agil o Click and Book Plus. Las combinaciones referencian únicamente IDs de
  ofertas realmente cotizadas; no se construye un producto cartesiano sintético.
- La identidad incorpora el ámbito necesario para no mezclar respuestas, GDS o
  fechas distintas, y `truncated` solo se activa cuando el normalizador tiene
  evidencia de haber podado combinaciones reales.
- La UI consume `scheduleGroups.combinations[].offerId` como única fuente de
  membresía. Ignora IDs ausentes o filtrados, no infiere grupos desde `rawRefs`,
  precio o equipaje, y selecciona siempre el objeto de oferta completo.
- Sin referencia nativa no hay grupo; una única alternativa visible se mantiene
  como oferta independiente.
- **Residual verificable:** elegir ida y vuelta de forma independiente exige que
  el proveedor cotice esa combinación exacta. No hay evidencia en fixtures de
  una capacidad para recombinar arbitrariamente, por lo que el backend no la
  promete ni la simula.

### 2.6 Estado de proveedores en reposo — **terminado**

- `GET /api/provider-status` es una superficie autenticada, `no-store` y
  delegable al runner. Solo entrega IDs canónicos, estado cerrado, evidencia,
  código de razón cerrado y timestamps; nunca mensajes, URLs, tokens ni payloads
  del proveedor.
- El tracker distingue `unknown`, `checking`, `ready` y `degraded`, con TTL de
  cinco minutos. Una observación de búsqueda fresca tiene precedencia sobre el
  prewarm periódico.
- En Agil el prewarm puede demostrar disponibilidad. En Click and Book Plus solo
  demuestra contexto local (`context_only`); únicamente una búsqueda real puede
  marcar el proveedor como `ready`.
- El zócalo consulta el endpoint cada 30 s y muestra `disponible`, `verificando`,
  `con incidencias`, `sin verificar`, `requiere sesión` para Agil o `requiere
  autenticación` para Click and Book Plus. Si una lectura falla, incluso después
  de haber mostrado `disponible`, retira la afirmación anterior y conserva solo
  los nombres canónicos. Una respuesta abortada por una consulta más nueva no
  puede sobrescribir el estado vigente.

---

## 3. Superficie de backend retirada

### 3.1 `/api/results-layout` — **retirado**

El editor de anchos de columna existía para ajustar la grilla de la tarjeta.
Plate 1b **cierra** esa grilla en `32 / 186 / 1fr / 116 / 26`, así que no queda
nada que ajustar.

- Se confirmó con búsqueda de referencias que no quedaba ningún consumidor de
  producción.
- Se retiraron rutas GET/POST, tipos, persistencia, helpers y cliente HTTP. El
  archivo `config/results-layout.json` no existe en el worktree.
- Una prueba negativa fija el nuevo contrato: ambos métodos devuelven 404.

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

### 4.2 Suite Playwright — **35 de 53 en rojo**

`test/ui/*.playwright.ts` son 4.434 líneas, con 35 casos todavía fijados al DOM anterior:
`.fd-result-card` (ahora `.fd-card`), `.fd-filter-slider`,
`.fd-migration-grid` (ahora `.fd-month-grid`),
`.fd-offer-detail-*`, `.fd-alert` / `.fd-search-alert`, `.fd-result-variant-card`,
`.fd-result-group`, `--fd-results-col-*`.

Los casos específicos del editor de layout ya se retiraron junto con la
superficie muerta. La reescritura general de los casos restantes sigue siendo un
trabajo aparte y por caso; no forma parte de las secciones 1–3.

El gate completo del 2026-07-29 terminó con 18 casos UI verdes y 35 rojos. La
cobertura de *Recientes* / *Frecuentes*, cotización validada, error sin copiar
fallback y retirada de salud obsoleta del zócalo está verde. Los fallos restantes
siguen buscando clases, accesibles o geometría del DOM anterior. El fixture
compartido sí se completó con proveedor e itinerario reales por exigencia del
nuevo contrato; no se añadieron aliases muertos a producción ni se eliminaron
casos para hacer pasar el gate.

---

## 5. Verificación

```bash
bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run build && bun run test
```

| Paso | Resultado |
|---|---|
| `bun install --frozen-lockfile` | ✅ 202 instalaciones verificadas / 236 paquetes; lockfile sin cambios |
| `bun run typecheck` | ✅ |
| `bun run lint` | ✅ |
| `bun run build` | ✅ |
| `bun run test:core` (dentro de `test`) | ✅ 490 pass / 0 fail |
| `bun run test:ui` (dentro de `test`) | ❌ 18 pass / 35 fallos legacy descritos en §4.2 |

Por tanto se ejecutó el gate exigido, pero `bun run test` no está verde por el
residual Playwright explícitamente excluido de este alcance.

---

## 6. Auditoría adicional del backend

Mejoras aplicadas durante el cableado:

- El contrato rechaza estadías flexibles >90 noches y fan-outs de matriz de más
  de 5.000 combinaciones antes de abrir trabajo de proveedor.
- El autocomplete rechaza consultas >120 caracteres antes del loader, limita a
  80 entradas por sesión y 1.000 globales, y poda también al restaurar SQLite.
- Agil y Click and Book Plus convierten fallos de transporte a mensajes estables.
  Click and Book Plus ya no lee ni interpola cuerpos de error no-2xx; el prewarm
  registra solo IDs de proveedor fallidos. Los workers y las respuestas HTTP
  serializan códigos cerrados en vez de stacks, rutas, URLs o cuerpos externos.
- La automatización B2B de Click and Book Plus acepta únicamente HTTPS en el
  origen exacto `b2b.clickandbook.com`, conserva redirects HTTP en ese mismo
  origen y vuelve a comprobarlo antes de escribir correo, contraseña u OTP en
  Playwright. El token que exige la URL de compra se resuelve justo antes del
  `302`; no se persiste en `providerContext`, el purchase path ni los logs.
- Agil mantiene su contrato de sesión Chrome: un endpoint explícito prevalece y
  Linux/VPS cae a `http://127.0.0.1:9222`, que corresponde al Chrome loopback de
  plataforma. Windows no recibe ese fallback implícito.
- Los meses migratorios conservan el estado `partial` si cualquier proveedor
  queda parcial y registran recientes/frecuentes una sola vez por búsqueda, no
  una vez por cada mes del fan-out.
- Recientes y estado de proveedores tienen límites, TTL, códigos cerrados y
  pruebas de entradas hostiles.
- La matriz frontend conserva únicamente `cell.offer`: una celda con precio sin
  oferta sigue siendo cobertura de matriz, pero nunca se materializa como vuelo
  «Flexible» ni recibe horarios, escalas o duración inventados. El endpoint de
  cotización aplica la misma regla y ya no construye una oferta sintética para
  esas celdas.
- Los normalizadores HTTP y del frontend descartan ofertas sin precio positivo,
  moneda o itinerario completo. El snapshot de cotización no rellena desde la
  solicitud precio, moneda, segmentos, horarios, directo ni carrier; un dato
  ausente permanece ausente en vez de convertirse en evidencia comercial.
- Equipaje ausente se mantiene desconocido y se oculta. `true` / `false`
  explícitos conservan su significado; del mismo modo, Agil y Click and Book
  Plus dejan carrier y número de vuelo vacíos si el proveedor no los entregó.
- Los motivos persistidos de redirects bloqueados nunca cruzan al título de la
  tarjeta; la UI usa copy cerrado y no reproduce URLs o texto externo antiguo.
- Los bloqueos de Click and Book Plus piden renovar la autenticación, no una
  sesión de Chrome al estilo de Agil. El contrato sigue siendo el mismo: token
  autenticado en la URL, validado o renovado justo antes del redirect.
- Se podaron helpers de detalle, agrupación de purchase paths y firma visual sin
  consumidores; la firma canónica de backend y el compositor compartido siguen
  siendo las únicas piezas necesarias para identidad y cotización.

La revisión de configuración local de `vps-platform` confirmó que web, search y
redirect leen `/etc/fly-desk.env`; el runner depende de Chrome, y Chrome expone
CDP solo en `127.0.0.1:9222`. No se añadió otra variable, servicio, puerto ni
capa operativa.

Residuales verificables que no se cambiaron por requerir una decisión operativa
separada:

- `SearchSessionStore` usa WAL, `synchronous=NORMAL` y `busy_timeout=5000`, pero
  una escritura que falla después de ese plazo se ignora y no programa un retry
  propio hasta otra mutación o el cierre. La memoria sigue funcionando, pero hay
  una ventana de durabilidad que merece una política explícita de reintentos y
  observabilidad antes de alterar el servicio.
- `SEARCH_COMPLETED_SESSION_TTL_MS=0` se acepta y expira al primer intervalo con
  edad positiva; no equivale a un `no-store` sincrónico. Conviene cerrar esa
  semántica antes de usar cero operativamente.
- Click and Book Plus no entrega cantidad de asientos en los fixtures actuales y
  ninguno de los dos proveedores demuestra recombinación arbitraria de tramos.
  Esos datos siguen ausentes hasta que exista evidencia del proveedor.
- Las tres unidades Fly comparten hoy el mismo archivo de entorno y la identidad
  `fly-desk`. Separar privilegios o variables sería trabajo de plataforma y no
  es necesario para cablear estos contratos.
- Filas antiguas que ya quedaron solo en disco fuera del presupuesto de restore
  pueden conservar URLs históricas hasta ser restauradas o vencer por TTL. Las
  escrituras y restauraciones actuales se sanitizan; no se añadió una migración
  masiva sin una necesidad operativa demostrada.
- El router principal y el proceso dedicado conservan orquestación paralela de
  `/r/<id>` alrededor del mismo resolver. Sus fronteras de autenticación y
  proceso son distintas; una unificación merece un refactor separado, no una
  abstracción especulativa dentro de este cableado.
