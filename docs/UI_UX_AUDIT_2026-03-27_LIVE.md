# Auditoría UI/UX Live — Fly Desk

Fecha: 2026-03-27

## Contexto

- Baseline principal auditado: Chrome MCP en `1920x1080` real.
- App auditada: `http://127.0.0.1:32123/`.
- Fuente de datos: sesión real de Agil, sin mocks activos al momento de la validación live.
- Baseline técnica validada:
  - `npm test`
  - `npm run typecheck`
- Estado live confirmado:
  - la integración real responde con `agil-local` en el badge de runtime
  - varias búsquedas exactas reales devolvieron `0 ofertas`
  - una búsqueda flexible real `LIM -> MIA`, `15/04/2026 -> 16/04/2026`, estadía `4-5` noches levantó `6 celdas` y quedó en loading sostenido durante la ventana de auditoría
- búsquedas exactas live probadas durante esta sesión:
  - ida y vuelta: `LIM -> MIA`, `LIM -> CUZ`, `LIM -> SCL`, `LIM -> BOG`, `LIM -> BUE`, `LIM -> MAD`
  - solo ida: `LIM -> CUZ`, `LIM -> AQP`, `LIM -> SCL`

## Evidencia

Artefactos guardados en `D:\Dev\fly-desk\output\playwright\`:

- `chrome-audit-1920-real-no-results.png`
- `chrome-audit-1920-real-matrix-loading.png`
- `chrome-audit-1920-real-matrix-loading-dark.png`
- `chrome-audit-1024.png`
- `chrome-audit-390.png`
- `chrome-audit-light-autocomplete.png`
- `chrome-audit-toasts-manual.png`

Mediciones relevantes obtenidas en Chrome:

- a `390px` el documento llegó a `scrollWidth ~= 1378px`
- el rail principal conserva una grilla fija de 8 columnas
- la barra lateral del workspace mantiene un ancho fijo de `22rem`
- en la misma zona visual conviven controles de `50px`, `48px`, `40px` y `38px`

## Hallazgos

### P0

- El rail principal no pertenece a un mismo sistema de componentes. En la misma línea conviven segmentados grandes, inputs de campo, botones-field, un icon button de swap y un CTA primario; debajo aparecen refinamientos más bajos y más compactos que no comparten la misma densidad ni anclaje visual. Esto se ve especialmente entre Origen/Destino, Fechas, Pasajeros y `Escala máx.`. Referencias:
  - `public/index.html:35`
  - `public/index.html:157`
  - `public/index.html:171`
  - `public/app.css:377`
  - `public/app.css:392`
  - `public/app.css:489`
  - `public/app.css:545`
  - `public/app.css:624`
  - `public/app.css:1014`
  - `public/app.css:1032`

- La estrategia de layout no soporta nada fuera del desktop ancho. El rail usa columnas fijas y el workspace fuerza una segunda columna fija; con una única media query real a `720px`, el layout ya se deforma en `1024px` y a `390px` directamente desborda. Esto no es un tema “responsive opcional”: rompe la composición incluso como desktop reducido. Referencias:
  - `public/app.css:392`
  - `public/app.css:1107`
  - `public/app.css:1884`

- `Escala máx.` se renderiza como una mini-card select distinta del resto de refinamientos y distinta de los campos principales. Queda ni al nivel del rail ni al nivel de los toggles; se percibe como un tercer sistema sin justificación. Referencias:
  - `public/index.html:157`
  - `public/app.css:1014`
  - `public/app.css:1032`

- El calendario flexible y su matriz introducen otro lenguaje visual separado del shell principal. Toolbar, toggle de vistas, celdas, fullscreen y loading no comparten la misma gramática de densidad, jerarquía y espaciado que el buscador ni que el panel lateral. Referencias:
  - `public/index.html:185`
  - `public/index.html:239`
  - `public/index.html:293`
  - `public/app.css:765`
  - `public/app.css:1152`
  - `public/app.css:1202`
  - `public/app.css:1758`

### P1

- Las acciones secundarias están visualmente demasiado cerca entre sí aunque pertenezcan a contextos distintos. `Copiar/Pegar`, chips de aerolínea, sort pills y acciones del panel (`Reprice`, `Cotizar`) son todas variantes de “píldora redondeada pequeña” con diferencias menores, sin una jerarquía clara por intención. Referencias:
  - `public/index.html:171`
  - `public/index.html:239`
  - `public/index.html:278`
  - `public/app.css:624`
  - `public/app.css:973`
  - `public/app.css:1152`
  - `public/app.css:1169`
  - `public/app.css:1572`

- Los popovers no comparten patrón. Autocomplete y pasajeros se comportan como overlays anclados y compactos; el calendario usa un panel fijo mucho más pesado, con otra escala de header y otra lógica de acciones. Se siente hecho por módulos distintos. Referencias:
  - `public/app.css:708`
  - `public/app.css:765`
  - `public/app.js:731`
  - `public/app.js:758`
  - `public/app.js:1189`

- El badge de runtime expone estados internos crudos (`agil-local · running`, `agil-local · search_live`) en lugar de copy de producto. Además mezcla un `IDLE` en inglés con el resto del producto en español. Esto da sensación de herramienta interna más que de interfaz consolidada. Referencias:
  - `public/index.html:11`
  - `public/app.js:2236`
  - `public/app.js:2243`

- La consistencia entre light y dark existe a nivel de tokens, pero la separación visual en light se debilita bastante más rápido en estados sutiles: empty state, matrix loading, disabled y superficies secundarias. En oscuro la jerarquía general se lee mejor que en claro. Referencias:
  - `public/app.css:377`
  - `public/app.css:765`
  - `public/app.css:1152`
  - `public/app.css:1758`

### P2

- Hay mezcla de idioma y tono en acciones y estados: `Reprice`, `IDLE`, `running`, `search_live` conviven con `Cotizar`, `Buscar vuelos`, `Sin resultados`. Falta una política de copy para acciones, estados y badges. Referencias:
  - `public/index.html:278`
  - `public/app.js:2236`
  - `public/app.js:2243`

- El sistema visual hoy depende demasiado de ajustes puntuales en clases concretas y no de una matriz de tamaños/intenciones bien cerrada. La repetición de tamaños “parecidos pero no iguales” vuelve muy fácil seguir agregando incoherencias. Referencias:
  - `public/app.css:377`
  - `public/app.css:624`
  - `public/app.css:1014`
  - `public/app.css:1152`
  - `public/app.css:1758`

## Sistema Visual Objetivo

### Escalas

- `rail-control`
  - altura única para modo, trayecto, origen, destino, fechas, pasajeros y CTA
  - padding horizontal consistente
  - radius único

- `secondary-control`
  - para sort, copy/paste, reprice/cotizar, toggles de vista
  - un solo alto y un solo font-size

- `chip`
  - para aerolíneas y filtros compactos
  - densidad menor que `secondary-control`, pero consistente entre todos los chips

- `icon-control`
  - swap, theme buttons, vista, navegación de calendario, cerrar fullscreen
  - una única caja base y solo variantes `sm`/`md`

### Familias permitidas

- `segmented`
  - modo y trayecto

- `field`
  - origen, destino, fechas, pasajeros
  - todos deben compartir shell, altura y label system

- `filter-chip`
  - directo, equipaje

- `filter-select`
  - escala máxima
  - debe comportarse como refinamiento, no como mini formulario aparte

- `toolbar-pill`
  - sort, copy/paste, reprice/cotizar

- `data-cell`
  - tabla, matriz y panel de detalle deben compartir reglas de meta, valor y estado

### Reglas

- un solo sistema de espaciado vertical dentro del shell
- un solo sistema de label uppercase para controles y secciones
- sans para navegación y copy general; mono solo para códigos, importes y datos comparables
- estados `default`, `hover`, `focus`, `active`, `disabled`, `loading`, `selected` definidos por familia
- light y dark con la misma jerarquía perceptual, no solo mismos tokens convertidos
- ningún badge o texto visible debe exponer estados técnicos crudos

## Backlog de Unificación

### Bloque 1

- Rehacer el rail como una sola familia de layout con columnas fluidas y alturas únicas.
- Normalizar `Escala máx.` dentro del mismo sistema de refinamientos.
- Separar visualmente rail principal y refinamientos, evitando la mezcla actual de dos densidades en un mismo bloque.

### Bloque 2

- Unificar acciones secundarias: sort, copy/paste, detail actions, toggles de vista.
- Redefinir chips de aerolínea para que se lean como filtro y no como pseudo-card independiente.
- Unificar el header/toolbar del workspace con el panel lateral.

### Bloque 3

- Hacer que calendario, popover de pasajeros, autocomplete y matrix fullscreen compartan una misma gramática de overlay.
- Bajar el contraste entre “componente aparte” y “subestado del mismo producto”.
- Unificar loading states: skeleton, matrix loading y detail loading hoy hablan dialectos visuales distintos.

### Bloque 4

- Definir breakpoints reales para `1280`, `1024` y `768`.
- Reemplazar las columnas fijas del rail y del workspace por reglas que colapsen con intención.
- El objetivo no es mobile-first, sino evitar quiebres duros y scroll horizontal accidental.

## Cobertura Live Real Alcanzada

- Validado visualmente con sesión real:
  - shell principal
  - no-results exacto
  - flexible con matrix loading real
  - topbar y badges
  - light/dark
  - detalle vacío
  - toolbar de resultados en flexible

- No quedó visualmente verificado con datos reales durante esta sesión:
  - lista exacta con filas reales
  - detalle poblado con oferta real
  - matrix resuelta con celdas reales completas

Motivo:

- varias búsquedas exactas live devolvieron `0 ofertas`
- la matriz real levantó celdas pero se mantuvo en loading durante la ventana de auditoría

Eso no invalida los hallazgos estructurales del sistema visual, pero sí limita la verificación live de estados poblados.
