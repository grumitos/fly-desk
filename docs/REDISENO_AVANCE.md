# Rediseño · estado del avance

Rama `claude/fly-desk-frontend-redesign-9232c6`. Implementación de
`Fly Desk Rediseño.dc.html` (proyecto de diseño `9d0c1e04-e3a0-415e-8371-224efcad7b39`).

El primer incremento fue solo frontend. Las secciones 1–3 del cableado de
backend y contratos se implementaron después en la misma rama; el estado y los
residuales verificables están en
[`REDISENO_PENDIENTE_CABLEADO.md`](REDISENO_PENDIENTE_CABLEADO.md).

Gate actual del cableado: core **500 pass / 0 fail**; Playwright **56 pass / 0
fail**. Incluye reposo y workspace activo en escritorio, tableta y móvil. El
detalle de contratos, auditoría y residuales está en el documento enlazado
arriba.

El rediseño fue una reescritura casi completa de la superficie: añadió la capa
de sistema de diseño que no existía y retiró los componentes anteriores.

---

## 1. Verificación

```bash
bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run build && bun run test
```

| Comando | Estado |
|---|---|
| `typecheck` | ✅ |
| `lint` | ✅ |
| `build` | ✅ |
| `test:core` | ✅ 500 pass / 0 fail |
| `test:ui` | ✅ 56 pass / 0 fail |

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
  `/api/results-layout` sin consumidores; el cableado posterior retiró también
  la ruta, persistencia y cliente (§3 del informe).
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

## 3. Decisiones cerradas por el cableado

Los dos cambios que el primer incremento dejó abiertos se conservan:

1. **`frontend/src/components/SearchShell.tsx`** — `getRuntimeSearchLimits()` ya
   no anticipa campos inexistentes: `maxStayNights`, `maxPassengers` y
   `maxLapInfantsPerAdult` forman parte de `PublicRuntimeConfig`, usan las mismas
   constantes que valida el backend y mantienen respaldo solo para HTML antiguo.
2. **`frontend/index.html`** — se conservan los ejes Inter 400–900 / Plex Mono
   400–700 requeridos por la escala tipográfica del rediseño; no alteran ningún
   contrato de proveedor.

---

## 4. Residual de diseño y pruebas

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

### 4.2 Suite Playwright — terminada

Los 53 casos anteriores fueron migrados caso por caso a las superficies actuales
sin aliases productivos, pruebas omitidas ni timeouts inflados. El trabajo
conservó los contratos de payload y proveedor y detectó defectos reales en la
selección de alternativas de vuelta, overflow horario, fechas civiles, ARIA del
rango y estabilidad vertical de avisos. La auditoría posterior añadió cobertura
para ida y vuelta incompleta, pasajeros mixtos, cero asientos, semántica de
precio de matriz, fallos parciales de Click and Book Plus y redirects corruptos.

Tres casos adicionales fijan el gate de `FRONTEND_IDENTITY.md` en `1440x900`,
`1024x768` y `390x844`, desde reposo hasta resultados, filtros y detalle, con
temas claro/oscuro, foco y overflow global e interno. Resultado final:
**56/56**.

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
