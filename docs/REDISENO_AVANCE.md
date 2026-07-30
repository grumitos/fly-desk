# Rediseño · estado del avance

Rama `claude/fly-desk-frontend-redesign-9232c6`. Implementación de
`Fly Desk Rediseño.dc.html` (proyecto de diseño `9d0c1e04-e3a0-415e-8371-224efcad7b39`).

Alcance acordado: **solo frontend**. El cableado de backend lo lleva otro agente;
lo que le falta está en [`REDISENO_PENDIENTE_CABLEADO.md`](REDISENO_PENDIENTE_CABLEADO.md).

Balance: **33 archivos, +2.460 / −4.755**. El rediseño borra casi el doble de lo
que añade, porque cierra catálogos que antes estaban dispersos.

---

## 1. Verificación

```bash
bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run build && bun run test:core
```

| Comando | Estado |
|---|---|
| `typecheck` | ✅ |
| `lint` | ✅ |
| `build` | ✅ |
| `test:core` | ✅ 412 pass / 0 fail |
| `test:ui` | ❌ **37 de 51 en rojo** — ver §4.2 |

---

## 2. Implementado

### 2.1 Fundamento — catálogos cerrados

Tres archivos nuevos que son la única fuente de cada valor. Escribir un valor que
no esté en el catálogo es el bug que las láminas se dibujaron para evitar; se
amplía el catálogo, no se inventa un caso suelto.

- **`frontend/src/design-system.css`** — plate 5a (ocho cuerpos + display, cuatro
  pesos), plate 5b (alturas 26/32/36/40/52 escritorio · 36/44/52 móvil; radios
  4/6/8/10/12/14/999; gaps siempre pares), plate 7b (cuatro tamaños de
  pictograma atados a alturas de control), los seis tokens de movimiento del §0
  del inventario, y el anillo de foco de plate 3d.
- **`frontend/src/components.css`** — una sección por superficie del mapa de
  cobertura (plate 6b).
- **`frontend/src/lib/iso-date.ts`** — aritmética de calendario sobre `YYYY-MM-DD`
  en UTC. Una fecha de búsqueda es un día civil, no un instante: parsearla en la
  zona del navegador desplazaría el día de salida bajo los pies del agente.

`@theme` en `index.css` quedó alineado al catálogo de radios (px, como las
láminas), y `--radius-3xl: 16px` —fuera de catálogo y sin uso— desapareció.

### 2.2 Superficies

| Lámina | Qué | Dónde |
|---|---|---|
| 1a | Reposo escritorio: campos de 52 px, chips de estación, línea de política, zócalo de proveedores | `SearchShell.tsx`, `ProviderRail.tsx` |
| 1b | Activo escritorio: aviso de una línea, filtros segmentados, tarjeta de 5 columnas, paginado anidado, panel de detalle | `App.tsx`, `ResultsPanel.tsx`, `ResultCard.tsx`, `DetailPanel.tsx` |
| 1h | Cotización lista para pegar, 620 × 768 sobre el espacio de trabajo | `QuotationOverlay.tsx` |
| 1i / 2f | Migratorio por mes: precio display, barra comparativa, dos tarifas al pie | `MigrationMonthGrid.tsx` |
| 2a | Sugerencias: filas de 46 px, IATA en columna fija, zócalo de teclas | `SearchShell.tsx`, `kbd.tsx` |
| 2e | Fechas fusionadas: un control, dos mitades, línea de 1 px | `date-range-field.tsx`, `range-calendar.tsx` |
| 2g | Estados de la lista: vacío por filtros señalando el culpable | `ResultsPanel.tsx` |
| 3b | Lista completa de horarios con diferencia de precio | `AllSchedulesPanel.tsx` |
| 3c | Error al cotizar, resuelto dentro del panel | `QuotationOverlay.tsx` |
| 4a | Esqueletos con la grilla real del componente | `ResultsSkeleton.tsx` |
| 6c / 7a | Selector de meses como barrido | `month-range-field.tsx` |

### 2.3 Decisiones estructurales que vale la pena conocer

- **La tarjeta suelta la columna «Ruta»** — restataba el origen y destino que se
  acababan de teclear. Con ese ancho la tarjeta baja de 81 a 68 px: **7
  resultados visibles en lugar de 4**.
- **Duración y escalas son por tramo.** Antes se sumaban ida + vuelta y producían
  un número que no corresponde a ningún vuelo que el agente esté por vender.
- **Los horarios alternativos son una tira dentro de la tarjeta**, no N filas
  casi vacías repitiendo aerolínea y precio.
- **El editor de anchos de columna se retiró**: plate 1b cierra la grilla en
  `32 / 186 / 1fr / 116 / 26`, así que no queda nada que ajustar. Eso deja
  `/api/results-layout` sin consumidores (§3 del informe de cableado).
- **Una regla de tipografía transversal**: cifra dura —hora, precio, fecha, día de
  calendario, contador, número de página— en mono 600; texto de interfaz en Inter.

### 2.4 Borrado del UI anterior

Borrados, no desactivados: `alert`, `badge` (+`badge-variants`), `calendar`,
`empty`, `filter-slider`, `slider`, `pagination`, `panel-section`, `skeleton`,
`results-layout-editor` y su test. Con ellos salieron `@daypicker/react` y
`@radix-ui/react-slider` del `package.json`. En una segunda pasada también
cayeron `.fd-control`, `.fd-control-invalid` y `.fd-label`, al unificar los
campos en una sola implementación.

Se barrió el CSS muerto clase por clase y se verificó que no queda ninguna
referencia al UI anterior en `frontend/src/`.

### 2.5 Ajuste 1:1 del reposo

Tras revisión visual se corrigieron, midiendo con `getBoundingClientRect()` y no
a ojo: la línea de política sobresalía 34 px por lado (medía 1248 contra los 1180
de la grilla); el zócalo de proveedores no estaba anclado abajo y dejaba ~305 px
muertos (ahora último hijo de `main`, con espaciadores en proporción 1 : 1,3); los
seis campos tenían el mismo alto de caja pero interiores distintos (`padding` y
alto de valor), ahora unificados con las cinco líneas base en la misma `y`; la
etiqueta de cada segmentado iba **1 px por debajo** del centro de su píldora
(`min-h-8` forzaba 32 px dentro de una caja de contenido de 30); y el botón de
pegar quedó atenuado como el de copiar cuando no hay configuración, sin dejar de
ser clicable y sin leer el portapapeles.

De paso aparecieron tres desvíos más: el CTA tenía radio 10 en vez de 12, la fila
de controles `margin-bottom:8` en vez de 10, y el placeholder usaba dos colores.

Dos puntos reportados como fallos se **midieron como ya correctos** y se dejaron
intactos: la cabecera (44 px, `padding:6px 16px`, marca y cápsulas sobre una
línea base de 32 px) y el control de fechas fusionado (columnas resolviendo a
`169.125px 1px 169.125px`, borde exterior único, mitades sin borde ni radio
propios, las tres cajas contiguas). Sobre el segundo: si visualmente sigue
leyéndose como dos cajas, la causa es que la columna es fraccionaria y el divisor
de 1 px cae en `x=825.4`, rasterizando sobre un píxel parcialmente cubierto —
se ve más claro que el borde exterior, pero no es un hueco. Se arregla dibujando
el divisor como `border-left` de la mitad derecha con `1fr 1fr`.

---

## 3. Pendiente de decisión del usuario

Dos cambios que **se hicieron sin pedirlo**, al responder una pregunta sobre si la
línea de política estaba cableada. Están verificados y en verde, pero la decisión
de dejarlos o revertirlos es del usuario y **está abierta**:

1. **`frontend/src/components/SearchShell.tsx`** — `getRuntimeSearchLimits()` lee
   `maxStayNights` / `maxPassengers` de `window.__FLYDESK_RUNTIME__` con 90 / 9 de
   respaldo, resuelto a nivel de módulo. Pisa territorio del agente de backend, en
   el sentido de que anticipa dos campos que aún no existen. Si se revierte, el
   informe de cableado §2.3 sigue siendo válido salvo la frase «ya hecho en el
   frontend».
2. **`frontend/index.html`** — los ejes de fuente pasaron de Inter 400–700 /
   Plex Mono 400–600 a Inter 400–900 / Plex Mono 400–700, que es exactamente lo
   que pide la maqueta. Sin esto, la escala 5a pide **mono 800 para toda cifra** y
   el navegador dibuja los precios con negrita sintética. Es puramente de
   presentación.

---

## 4. Pendiente de trabajo

### 4.1 Móvil: láminas 1c – 1f — **no implementadas**

El móvil sigue en el layout de pestañas anterior (Resultados / Filtros / Oferta).
Las piezas compartidas ya están a escala táctil: las celdas de calendario suben a
44 px por media query y el catálogo 36/44/52 está en `design-system.css`.

Especificación, ya recuperada:

- **1c · reposo** — origen y destino como **un único control** con el intercambio
  de 44 px sobre la división; valores a 16 px, campos de 58 px, CTA de 52 px a
  todo el ancho.
- **1d · resultados** — retracción de herramientas al desplazar: dispara a los
  88 px y **bloquea 300 ms tras cada cambio**; sin ese bloqueo el reajuste de
  altura vuelve a disparar el gesto y la cabecera vibra (era el bug de la lista
  móvil). La lista pasa de 6 a 7 tarjetas; la fila de estado nunca se va y saca un
  botón de filtros.
- **1e · hoja de filtros** — segmentados de 44 px, filas de aerolínea de 48 px con
  logo, y el botón primario dice cuántos vuelos quedan antes de cerrar.
- **1f · hoja de oferta** — itinerario por tramo con su ciudad, su vuelo y su
  escala; «Cotizar» copia y confirma en una línea, sin hoja intermedia, porque en
  móvil la cotización no se edita.

### 4.2 Suite Playwright — 37 de 51 en rojo

`test/ui/*.playwright.ts` son ~4.900 líneas fijadas al DOM anterior:
`.fd-result-card` (ahora `.fd-card`), `.fd-filter-slider`,
`.fd-results-layout-editor`, `.fd-migration-grid` (ahora `.fd-month-grid`),
`.fd-offer-detail-*`, `.fd-alert` / `.fd-search-alert`, `.fd-result-variant-card`,
`.fd-result-group`, `--fd-results-col-*`, y tras §2.5 también `.fd-control`,
`.fd-control-invalid` y `.fd-label`.

**Se dejaron en rojo a propósito.** Varios casos verifican comportamientos que el
rediseño elimina deliberadamente («normal results wait for saved column layout»,
«layout editor guide renders as the first result card», «baggage filter uses one
compact slider»), así que reescribirlos mecánicamente para que pasen daría una
suite que aprueba aserciones vacías — peor que una roja, porque esconde
regresiones. Es trabajo aparte y caso por caso.

---

## 5. Notas operativas

**El archivo de diseño no se puede leer completo con `DesignSync get_file`**:
trunca a 256 KiB y el archivo mide 377 KB, así que las láminas 1c–1i vienen
cortadas. La API del propio proyecto no tiene ese tope:

```
/design/v1/design/projects/{projectId}/download?path={encodeURIComponent(ruta)}
```

Requiere una pestaña de claude.ai con sesión (el navegador integrado arranca sin
login). Antes de confiar en el archivo nuevo conviene hashear el prefijo ya
aplicado contra el mismo rango del descargado: distingue «solo estaba truncado»
de «además es otra revisión». En esta implementación los primeros 261.370 de
375.867 chars hashearon idénticos, así que solo faltaba la cola.

**Para previsualizar**: `bun ./index.html` en `frontend/` falla al resolver
`/favicon.svg` (comportamiento preexistente del dev server; en producción se
sirve desde `public/`). Conviene `bun run build` y servir `frontend/dist`. Ojo:
un servidor estático pelado **no inyecta** `window.__FLYDESK_RUNTIME__`, así que
la ventana de búsqueda cae a su respaldo (`hoy + 365`) y parece hardcodeada.
