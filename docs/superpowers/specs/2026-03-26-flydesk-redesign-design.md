# Fly Desk — Rediseno Integral de Producto

**Fecha:** 2026-03-26
**Alcance:** Frontend completo (HTML + CSS + JS). Backend sin cambios.
**Objetivo:** Convertir Fly Desk de una web con bloques apilados a una superficie operativa profesional, coherente y mantenible.

---

## 1. Principios de diseno

1. **Superficie continua, no bloques** — La app es un workspace donde busqueda, resultados y detalle coexisten, no secciones independientes apiladas.
2. **Densidad informativa con jerarquia** — Mostrar mucho en poco espacio, pero con orden visual claro. Referencia: Bloomberg Terminal + Linear + Google Flights.
3. **Una sola gramatica visual** — Todos los componentes (inputs, buttons, badges, tables, dropdowns, toasts) comparten tokens y reglas.
4. **Operativo primero** — Pensado para uso repetitivo por agentes de viaje. Velocidad, claridad y control sobre estetica decorativa.
5. **Motion funcional** — Animaciones que comunican estado, no que decoran. Tres escalas: micro (120ms), meso (200ms), macro (300ms).

---

## 2. Arquitectura de layout

### 2.1 Estructura global

```
+----------------------------------------------------------+
|  Header (32px, sticky)                                    |
+----------------------------------------------------------+
|  Search Bar (fila compacta, sticky debajo del header)     |
+----------------------------------------------------------+
|          |                              |                 |
|  Sidebar |       Content Area           |  Detail Panel   |
|  Filtros |   (Results / Calendar)       |  (side panel)   |
|  (220px) |       (flex: 1)              |  (380px)        |
|          |                              |                 |
+----------------------------------------------------------+
```

- **Header**: Logo + status badges + acciones globales. 32px. Siempre visible.
- **Search Bar**: Compacta, horizontal, sticky. Se colapsa a una linea resumen cuando hay resultados y el usuario scrollea.
- **Sidebar**: Filtros de aerolinea + filtros avanzados. Fija a la izquierda, siempre presente cuando hay resultados (sin layout shift).
- **Content Area**: Resultados en tabla o vista calendario. Ocupa el espacio restante.
- **Detail Panel**: Panel lateral derecho que aparece al seleccionar un resultado. Slide-in desde la derecha. Master-detail pattern.

### 2.2 Responsive

- **>=1200px**: Layout completo de 3 columnas (sidebar + content + detail).
- **900-1199px**: Sidebar colapsa a iconos, detail panel como overlay.
- **<900px**: Todo apilado verticalmente. Sidebar como drawer. Detail como pantalla completa.

---

## 3. Sistema visual (Design Tokens)

### 3.1 Paleta de colores

Mantener dark theme. Refinar para mayor jerarquia y menos saturacion electrica.

```css
/* Backgrounds - escala de elevation */
--bg-base:      #0d1117;    /* fondo principal */
--bg-raised:    #161b22;    /* cards, sidebar, paneles */
--bg-surface:   #1c2129;    /* inputs, celdas editables */
--bg-overlay:   #21262d;    /* dropdowns, menus, modales */
--bg-hover:     #262c36;    /* hover sobre elementos interactivos */
--bg-active:    #2a3140;    /* item seleccionado/activo */

/* Accent - mas contenido que el azul electrico actual */
--accent:       #4c9aed;    /* primario */
--accent-hover: #5ba8f5;    /* hover */
--accent-muted: rgba(76, 154, 237, 0.12);  /* backgrounds sutiles */
--accent-border:rgba(76, 154, 237, 0.30);  /* bordes con accent */

/* Semantic */
--success:      #3fb950;
--warning:      #d29922;
--danger:       #f85149;
--info:         #79c0ff;

/* Text - 4 niveles, no mas */
--text-primary:   #e6edf3;   /* titulos, valores clave */
--text-secondary: #b1bac4;   /* body text, labels */
--text-tertiary:  #6e7681;   /* hints, metadata secundaria */
--text-disabled:  #3d444d;   /* deshabilitado */

/* Borders - 3 niveles */
--border-default: #30363d;
--border-subtle:  #21262d;
--border-focus:   var(--accent);
```

### 3.2 Tipografia

```css
--font-sans:  'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
--font-mono:  'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace;

/* Escala: 5 tamanos, no mas */
--text-xs:    11px;   /* badges, metadata minima */
--text-sm:    12px;   /* labels, hints, filtros */
--text-base:  13px;   /* body principal, tablas, inputs */
--text-md:    15px;   /* titulos de seccion, precios en resultados */
--text-lg:    20px;   /* precio hero en detail panel */

--weight-normal:  400;
--weight-medium:  500;
--weight-semibold:600;
```

### 3.3 Spacing

Escala de 4px estricta:

```css
--sp-1: 4px;   --sp-2: 8px;   --sp-3: 12px;
--sp-4: 16px;  --sp-5: 20px;  --sp-6: 24px;
--sp-8: 32px;  --sp-10: 40px; --sp-12: 48px;
```

### 3.4 Elevacion y bordes

```css
--radius-sm: 4px;    /* badges, chips */
--radius-md: 6px;    /* inputs, buttons, cards */
--radius-lg: 8px;    /* modales, paneles */

--shadow-sm:  0 1px 2px rgba(0,0,0,0.3);
--shadow-md:  0 2px 8px rgba(0,0,0,0.3);
--shadow-lg:  0 4px 16px rgba(0,0,0,0.4);
--shadow-glow:0 0 0 3px var(--accent-muted);  /* focus ring */
```

### 3.5 Transiciones

```css
--duration-fast:   120ms;   /* hover, focus */
--duration-normal: 200ms;   /* expand, collapse */
--duration-slow:   300ms;   /* panel slide, overlay */
--ease-default:    cubic-bezier(0.4, 0, 0.2, 1);
--ease-spring:     cubic-bezier(0.34, 1.56, 0.64, 1);
```

---

## 4. Buscador

### 4.1 Arquitectura: dos modos, no tres

**Eliminar la triparticion Exact/Range/Matrix.** Reemplazar por:

1. **Busqueda exacta** — Origen, destino, fecha(s) fija(s). Devuelve lista de ofertas.
2. **Busqueda flexible** — Origen, destino, duracion del viaje + ventana de fechas. Devuelve resultados organizables como lista o como calendario.

**Logica clave de busqueda flexible:**
- El usuario define **duracion** (ej: "10 dias", o rango "7-14 dias") y **ventana de salida** (ej: "1 abril - 31 mayo").
- El sistema calcula las combinaciones posibles y busca precios para cada una.
- Los resultados se muestran como **lista ordenada por precio** (vista default) o como **calendario/grilla** (vista alternativa del mismo resultado).
- No son modos separados. Son vistas del mismo dataset.

**Razon:** Un agente de viajes casi nunca necesita "cualquier combinacion de ida y vuelta". Necesita "10 dias en algun momento de abril". El modelo actual de matriz explora demasiadas combinaciones inutiles.

**Nota de implementacion:** El backend sigue trabajando con rangos de fechas (departure range + return range). El frontend traduce "duracion X dias + ventana Y" a los rangos equivalentes antes de enviar al API. Ejemplo: duracion 10 dias + ventana 1-30 abril → departure range 1-30 abril, return range 11 abril - 10 mayo. Esto es una transformacion puramente de UI, sin cambios de API.

### 4.2 Layout del buscador

**Fila principal** (siempre visible, ~48px):

```
[Tipo viaje ▼] [Origen ✈ ──────] [⇄] [Destino ✈ ──────] [Fechas / Duracion+Ventana] [Pax ▼] [Buscar]
```

- **Tipo viaje**: Dropdown compacto (Solo ida / Ida y vuelta). Default: ida y vuelta.
- **Origen/Destino**: Autocomplete con icono de avion. El bloque dominante visualmente (mas ancho).
- **Swap button**: Icono circular entre origen y destino.
- **Fechas**: Si modo exacto: dos date inputs (ida/vuelta). Si flexible: un campo de duracion + un rango de ventana.
- **Pax**: Dropdown que al hacer click abre un mini-panel con adults/children/infants con controles +/-.
- **Buscar**: Boton primario al final de la fila.

**Chips de parametros secundarios** (debajo de la fila principal):

```
[Cabina: Economy ▼] [Moneda: USD ▼] [Solo directo ○] [Con equipaje ○] [Modo: Exacto | Flexible]
```

- Los parametros secundarios se muestran como **chips/pills** horizontales debajo del buscador.
- "Modo" es un toggle pill: Exacto | Flexible. Al cambiar, los campos de fecha en la fila principal se adaptan.
- Los chips son clickeables y abren inline editing o small popovers.

### 4.3 Comportamiento de fechas

**Modo exacto:**
- Dos inputs tipo date: Salida y Regreso.
- Si es solo ida, solo aparece Salida.
- Smart year: al escribir "2" se autocompleta "2026" cuando corresponde.

**Modo flexible:**
- **Duracion**: Input numerico + label "dias" (ej: `10 dias`), o rango (`7 - 14 dias`).
- **Ventana**: Dos dates (desde/hasta) que definen el periodo donde puede caer la salida.
- La interfaz calcula automaticamente cuantas combinaciones se van a evaluar y lo muestra como badge informativo: "~45 combinaciones".

### 4.4 Componentes del buscador

**Autocomplete de ubicacion:**
- Trigger: al escribir >= 2 caracteres.
- Dropdown fijo debajo del input, max 6 resultados.
- Muestra: codigo IATA (bold) + nombre ciudad + nombre aeropuerto (dim).
- Keyboard nav: arrows, enter para seleccionar, escape para cerrar.
- Al seleccionar: input muestra "LIM - Lima" (codigo + ciudad).

**Selector de pasajeros:**
- Popover que abre al click del chip/input "Pax".
- 3 filas: Adultos (1-9), Ninos (0-9), Bebes (0-9).
- Cada fila: label + boton [-] + valor + boton [+].
- Validacion: total <= 9, bebes <= adultos.
- Muestra resumen compacto cuando cerrado: "2 ADT, 1 CHD".

**Selector de cabina y moneda:**
- Dropdowns simples con las opciones disponibles.
- Cabina: Economy, Premium Economy, Business, First.
- Moneda: Lista de monedas soportadas.

---

## 5. Resultados

### 5.1 Vista de lista (modo default)

**Tabla densa con rows de 44-48px.** Columnas:

| Aerolinea | Ruta | Salida | Llegada | Duracion | Escalas | Equipaje | Precio | Acciones |
|-----------|------|--------|---------|----------|---------|----------|--------|----------|

- **Aerolinea**: Logo + codigo (LA, AA, etc.). 2 letras.
- **Ruta**: Origen-Destino, con escalas como tooltip/badge.
- **Salida/Llegada**: Hora (HH:MM), fecha debajo en dim si es distinto dia.
- **Duracion**: "Xh Ym" format.
- **Escalas**: Badge numerico (0=directo en verde, 1 en amber, 2+ en rojo).
- **Equipaje**: Icono check/cross para carry-on y checked.
- **Precio**: Numero grande, moneda en dim. Alineado a la derecha. Peso visual maximo.
- **Acciones**: Checkbox para comparar, boton de detalle.

**Paginacion:**
- 15 resultados por pagina (ajustable).
- Barra inferior: "Mostrando 1-15 de 47 resultados" + botones Anterior/Siguiente + ir a pagina.
- Conteo total visible siempre.

**Filas agrupadas (ida+vuelta):**
- Si una ida tiene multiples opciones de vuelta, la fila principal muestra la mejor combinacion.
- Badge discreto "3 opciones de vuelta" que al click expande un sub-panel inline con las alternativas.
- Sub-panel: mini-tabla con las opciones de vuelta, seleccionable con click.

### 5.2 Vista calendario (para busqueda flexible)

Cuando el usuario hizo busqueda flexible, los resultados se pueden ver como:

- **Lista** (default): Misma tabla de arriba, ordenada por precio o value score.
- **Calendario**: Grid donde filas = fechas de salida, columnas = fechas de regreso (si ida+vuelta) o filas = fechas (si solo ida).

Toggle entre vistas: dos iconos (lista/grilla) en la toolbar de resultados.

**Calendario/grid:**
- Celdas muestran precio + confidence indicator.
- Color coding: gradiente de verde (barato) a rojo (caro), proporcional al rango de precios del resultado.
- Click en celda: selecciona esa combinacion y abre detalle en panel lateral.
- Hover: tooltip con detalles (fecha, precio, duracion, escalas).
- Celda activa: borde accent + glow sutil.
- Celdas sin datos: gris, no clickeable.

**Escala de color para celdas (refinada):**
```
Mejor precio:    --cell-best    #1a7f37 (verde oscuro, borde accent)
Buen precio:     --cell-good    #238636 (verde)
Normal:          --cell-normal  #2d333b (gris neutro)
Caro:            --cell-warm    #9e6a03 (ambar)
Muy caro:        --cell-hot     #da3633 (rojo)
Loading:         --cell-loading  shimmer animation
No disponible:   --cell-empty   #161b22 (bg-raised, texto dim)
```

### 5.3 Toolbar de resultados

Barra horizontal entre el buscador y los resultados:

```
[Ordenar: Precio ▼ | Duracion | Mejor valor]  [Vista: Lista | Calendario]  |  47 resultados  |  [Comparar (2)]
```

- **Ordenar**: Segmented control con 3 opciones.
- **Vista**: Toggle icons (solo visible en busqueda flexible).
- **Conteo**: Texto informativo.
- **Comparar**: Boton que activa comparacion cuando hay 2+ ofertas seleccionadas.

---

## 6. Panel de detalle

### 6.1 Estructura

Panel lateral derecho (380px) que aparece con slide-in al seleccionar una oferta.

```
+----------------------------------+
|  [X Cerrar]         Detalle      |
+----------------------------------+
|  USD 847.00          Precio hero |
|  ██████ Confidence bar           |
|  LIM → SCL  ·  LATAM  ·  2h45m |
+----------------------------------+
|  SEGMENTOS                       |
|  ┌────────────────────────────┐  |
|  │ IDA  26 Mar               │  |
|  │ LIM 08:30 ──── SCL 13:15 │  |
|  │ LA601 · Economy · 2h45m   │  |
|  └────────────────────────────┘  |
|  ┌────────────────────────────┐  |
|  │ VUELTA  05 Abr            │  |
|  │ SCL 14:00 ──── LIM 16:50 │  |
|  │ LA602 · Economy · 2h50m   │  |
|  └────────────────────────────┘  |
+----------------------------------+
|  OPCIONES DE VUELTA (3)          |
|  [Card vuelta 1] [Card 2] [3]   |
+----------------------------------+
|  EQUIPAJE                        |
|  ✓ Carry-on   ✓ 1 maleta 23kg   |
+----------------------------------+
|  TARIFA                          |
|  Base: 720.00  Taxes: 127.00    |
|  Última emision: 28 Mar         |
+----------------------------------+
|  ACCIONES                        |
|  [Repricing]  [Cotizar]  [Abrir]|
+----------------------------------+
```

### 6.2 Comportamiento

- **Slide-in**: 300ms desde la derecha con ease.
- **Cerrar**: Click en X, click fuera del panel, o Escape.
- **Repricing**: Boton que refresca el precio via API. Muestra spinner inline mientras procesa.
- **Cotizar**: Genera texto de cotizacion. Se muestra en textarea copiable dentro del panel.
- **Abrir en Agil**: Abre la URL de compra en nueva pestana/ventana.
- **Opciones de vuelta**: Si el grupo tiene multiples vuelta, se muestran como cards horizontales scrolleables. Click cambia la vuelta seleccionada.

---

## 7. Comparador

### 7.1 Estructura

El comparador se activa cuando el usuario selecciona 2 ofertas (checkboxes en la tabla de resultados).

**Vista**: Reemplaza el contenido principal (no es un overlay). Panel lateral de detalle se cierra.

**Layout**: Tabla de comparacion con 2-3 columnas (una por oferta).

```
| Atributo        | Oferta A         | Oferta B         |
|-----------------|------------------|------------------|
| Precio          | USD 847 ✓ mejor  | USD 923           |
| Duracion        | 5h 30m           | 2h 45m ✓ mejor    |
| Escalas         | 1 (SCL)          | 0 Directo ✓       |
| Equipaje        | 1x23kg           | 1x23kg            |
| Aerolinea       | LATAM            | Sky               |
| Salida          | 08:30            | 14:00             |
| Llegada         | 14:00            | 16:45             |
| Confianza       | Validado         | Indicativo        |
| Fuente precio   | Agil directo     | Agil directo      |
| Emision limite  | 28 Mar           | 30 Mar            |
```

- Celdas "mejor" resaltadas con fondo accent-muted.
- Boton "Limpiar comparacion" arriba.
- Boton "Volver a resultados" arriba.

---

## 8. Sidebar de filtros

### 8.1 Estructura

Columna izquierda (220px), siempre presente cuando hay resultados.

```
+------------------------+
|  FILTROS               |
+------------------------+
|  Aerolineas            |
|  [x] LATAM (23) $420  |
|  [x] SKY   (12) $380  |
|  [x] Avianca (5) $510 |
|  [ ] Copa   (2) $890  |
+------------------------+
|  Escalas               |
|  [x] Directo           |
|  [x] 1 escala          |
|  [ ] 2+ escalas        |
+------------------------+
|  Precio maximo         |
|  [========|---] $1200  |
+------------------------+
|  Equipaje              |
|  [x] Con equipaje      |
+------------------------+
|  [Limpiar filtros]     |
+------------------------+
```

### 8.2 Comportamiento

- Checkboxes de aerolinea: toggle individual. Muestra conteo de ofertas y precio minimo.
- Click en nombre de aerolinea: toggle on/off.
- Solo-mode: double-click o boton "Solo" para filtrar solo esa aerolinea.
- Escalas: checkboxes multi-select.
- Precio maximo: slider o input numerico.
- Todos los filtros se aplican en tiempo real con debounce 200ms.
- "Limpiar filtros" resetea todo.
- Cuando no hay resultados: sidebar oculta, no hay layout shift (el espacio simplemente no se usa).

---

## 9. Componentes del sistema

### 9.1 Inputs

- Altura: 32px (compact) o 36px (default).
- Border: 1px `--border-default`. Focus: `--border-focus` + `--shadow-glow`.
- Background: `--bg-surface`.
- Border-radius: `--radius-md`.
- Padding: `--sp-2` horizontal.
- Placeholder: `--text-tertiary`.
- Error state: border `--danger`, background `rgba(248,81,73,0.06)`.

### 9.2 Buttons

**Primary** (Buscar, acciones principales):
- Background: `--accent`. Hover: `--accent-hover`. Active: darken.
- Text: white. Font-weight: semibold.
- Height: 36px. Padding: `--sp-2` `--sp-4`.

**Secondary** (acciones secundarias):
- Background: `--bg-surface`. Border: `--border-default`.
- Hover: `--bg-hover`.

**Ghost** (acciones terciarias, links funcionales):
- Background: transparent. Text: `--accent`.
- Hover: `--accent-muted` background.

**Icon button** (swap, close, +/-):
- 28x28px. Border-radius: `--radius-sm`.
- Hover: `--bg-hover`.

### 9.3 Badges/Tags

- Height: 22px. Padding: 0 `--sp-2`.
- Border-radius: `--radius-sm`.
- Font: `--text-xs`, `--weight-medium`.
- Variantes: accent, success, warning, danger, neutral.

### 9.4 Dropdown/Popover

- Background: `--bg-overlay`. Border: `--border-default`.
- Shadow: `--shadow-md`. Border-radius: `--radius-md`.
- Aparicion: fade-in + scale(0.98→1) en `--duration-fast`.
- Items: 32px height, padding `--sp-2` `--sp-3`. Hover: `--bg-hover`.
- Keyboard nav: arrows, enter, escape.

### 9.5 Toast

- Posicion: bottom-right, 16px de margen.
- Background: `--bg-overlay`. Border-left: 3px del color semantico.
- Entrada: slide-in desde derecha (300ms). Salida: fade-out (200ms).
- Duracion: 3s success, 5s error. Hover pausa auto-dismiss.

### 9.6 Tabla de resultados

- Header: sticky, `--bg-raised`, `--text-tertiary`, `--text-xs`, uppercase.
- Rows: 44px height, `--border-subtle` bottom.
- Hover: `--bg-hover`.
- Selected: `--bg-active`, left border 2px `--accent`.
- Alternating: no (demasiado ruido). Separar con border sutil.
- Precio: `--text-md`, `--weight-semibold`, alineado derecha.

### 9.7 Scrollbar

```css
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border-default); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--text-tertiary); }
```

Sutil, no decorativo. 6px de ancho.

### 9.8 Loading states

- **Spinner**: SVG animado, 20px, `--accent`. No overlay full-screen para busquedas — usar inline progress.
- **Skeleton**: Shimmer rectangles en `--bg-surface` con gradiente animado. Para tablas y celdas de calendario.
- **Progress bar**: Barra delgada (2px) en la parte superior del content area. Muestra progreso real cuando se conoce (ej: "12 de 45 combinaciones evaluadas").
- **Loading overlay**: Solo para el estado inicial de busqueda. Semi-transparente, centrado.

### 9.9 Estados vacios

- **Sin resultados**: Icono grande (avion + "X") + texto "No se encontraron vuelos" + sugerencias (ampliar fechas, cambiar filtros).
- **Sin busqueda**: Content area muestra un mensaje de bienvenida ligero con instrucciones basicas: "Ingresa origen, destino y fechas para comenzar".
- **Error**: Icono de alerta + mensaje descriptivo + boton "Reintentar".

---

## 10. Header

### 10.1 Estructura

```
[FLY DESK logo]  |  [Estado: ● Conectado]  [Sesion: abc123]  |  [Config ⚙]
```

- 32px de altura. Background: `--bg-base` con border-bottom `--border-subtle`.
- Logo: "FLY DESK" en `--weight-semibold`, `--text-sm`, letter-spacing 1px.
- Status badges: pequenos (22px), con dot de color semantico.
- Minimalista. No debe competir visualmente con el buscador.

---

## 11. Interaccion y motion

### 11.1 Catalogo de animaciones

| Accion | Animacion | Duracion | Easing |
|--------|-----------|----------|--------|
| Hover en boton/row | Background fade | 120ms | ease |
| Focus en input | Border + glow | 120ms | ease |
| Abrir dropdown | Fade + scale(0.98→1) | 150ms | ease-out |
| Cerrar dropdown | Fade out | 100ms | ease-in |
| Abrir panel detalle | Slide-in desde derecha | 300ms | ease-default |
| Cerrar panel detalle | Slide-out a derecha | 200ms | ease-in |
| Expandir sub-fila | Height expand | 200ms | ease-default |
| Colapsar sub-fila | Height collapse | 150ms | ease-in |
| Toast entrada | Slide-in + fade | 300ms | ease-spring |
| Toast salida | Fade out | 200ms | ease-in |
| Error shake | Translate +-2px | 300ms | ease |
| Cambio de pagina | Fade out old, fade in new | 150ms | ease |
| Celda loading | Shimmer gradient | 1.5s loop | linear |
| Progress bar | Width transition | continuous | linear |

### 11.2 Regla general

- Todo lo que cambia de estado tiene transicion.
- Nada dura mas de 300ms.
- Hover/focus: 120ms. Expansion: 200ms. Paneles: 300ms.
- Nunca bounce ni overshoot excepto toasts (spring sutil).

---

## 12. Formularios y validacion

### 12.1 Patron de validacion

1. **Validacion en tiempo real**: Campos se validan al blur (no en cada keystroke).
2. **Error visible**: Border rojo + mensaje de error debajo del campo (12px, color danger).
3. **Error bar**: Barra de errores debajo del buscador solo cuando se intenta submit con errores.
4. **Shake**: Campos invalidos hacen shake sutil (300ms, +-2px) al intentar submit.

### 12.2 Comportamientos inteligentes

- **Fechas**: Smart year — escribir "15/04" se autocompleta a "15/04/2026". Escribir "2" en anyo se autocompleta a "2026".
- **Moneda**: Solo mayusculas, max 3 chars, validacion contra lista conocida.
- **Pasajeros**: Controles +/- con limites. Total <= 9. Bebes <= adultos.
- **Duracion (flex)**: Acepta "10" (se interpreta como 10 dias) o "7-14" (rango). Label dinamico.
- **Codigo IATA**: Uppercase auto, max 3 chars.

---

## 13. Arquitectura CSS

### 13.1 Organizacion

El CSS se organiza en secciones con comentarios claros, dentro de un solo archivo `app.css`:

```
/* ==========================================================================
   1. TOKENS (variables)
   2. RESET & BASE
   3. LAYOUT (header, search, sidebar, content, detail)
   4. COMPONENTS (inputs, buttons, badges, dropdowns, toasts, tables)
   5. SEARCH FORM
   6. RESULTS TABLE
   7. CALENDAR/GRID VIEW
   8. DETAIL PANEL
   9. COMPARE VIEW
   10. SIDEBAR FILTERS
   11. STATES (loading, empty, error)
   12. ANIMATIONS
   13. SCROLLBAR
   14. RESPONSIVE
   ========================================================================== */
```

### 13.2 Naming convention

Clases con prefijo funcional, no BEM completo pero consistente:

- Layout: `.layout-header`, `.layout-sidebar`, `.layout-content`, `.layout-detail`
- Components: `.btn`, `.btn--primary`, `.btn--ghost`, `.input`, `.badge`, `.tag`, `.dropdown`
- States: `.is-active`, `.is-loading`, `.is-invalid`, `.is-hidden`, `.is-collapsed`
- Search: `.search-bar`, `.search-field`, `.search-pax`, `.search-chips`
- Results: `.results-table`, `.results-row`, `.results-price`, `.results-pagination`
- Calendar: `.cal-grid`, `.cal-cell`, `.cal-header`
- Detail: `.detail-panel`, `.detail-hero`, `.detail-segments`
- Sidebar: `.sidebar`, `.sidebar-section`, `.sidebar-airline`

---

## 14. Arquitectura HTML

### 14.1 Estructura semantica

```html
<body>
  <header class="layout-header">...</header>
  <div class="search-bar">...</div>
  <div class="layout-main">
    <aside class="layout-sidebar">...</aside>
    <main class="layout-content">
      <div class="results-toolbar">...</div>
      <div class="results-container">
        <!-- results table OR calendar grid -->
      </div>
    </main>
    <aside class="layout-detail">...</aside>
  </div>
  <div class="toast-container">...</div>
</body>
```

### 14.2 Cambios respecto al HTML actual

- Eliminar SVG sprite inline → mover a iconos CSS o SVG external.
- Eliminar las 3 filas de busqueda → una sola fila + chips.
- Eliminar secciones colapsables con headers → layout fijo por regiones.
- Sidebar siempre en DOM (visibility toggle, no DOM insertion).
- Detail panel siempre en DOM (translate-x para slide in/out).
- Loading overlay simplificado (inline progress bar + estados skeleton).

---

## 15. Arquitectura JS (cambios en rendering)

### 15.1 Que cambia

- `renderResultsSection()`: Nuevo markup de tabla con columnas redefinidas, paginacion mejorada.
- `renderMatrixSection()`: Se renombra a `renderCalendarView()`. Mismo canvas pero integrado como vista alternativa de resultados.
- `renderDetailSection()`: Se convierte en `renderDetailPanel()`. Render en panel lateral, no en seccion apilada.
- `renderComparePaneContent()`: Layout actualizado para tabla comparativa horizontal.
- `renderSidebar()`: Nuevo layout con secciones de filtros expandidas.
- `renderSearchSummary()`: Nuevo — barra de resumen que reemplaza al buscador cuando se scrollea.
- Nuevo: `renderEmptyState()`, `renderErrorState()` — estados vacios y de error consistentes.
- Nuevo: `renderPaxPopover()` — popover de pasajeros con +/-.

### 15.2 Que NO cambia

- State management (`state` object).
- API calls (`postJson`, `getJson`, polling).
- Form validation logic (se refina, no se reescribe).
- Business logic (filtering, sorting, grouping).
- Event binding patterns.

---

## 16. Resumen de cambios por archivo

| Archivo | Tipo de cambio | Alcance |
|---------|---------------|---------|
| `public/app.css` | **Reescritura completa** | ~1400 lineas nuevas con sistema de tokens |
| `public/index.html` | **Reestructuracion mayor** | Nuevo layout, nuevo buscador, regiones semanticas |
| `public/app.js` | **Actualizacion de renders** | Todas las funciones render*, nuevos componentes UI |

---

## 17. Metricas de exito

- Buscador ocupa <=80px de altura (vs ~200px actual).
- Resultados visibles sin scroll debajo del buscador en viewport 1080p.
- Todas las superficies comparten exactamente los mismos tokens de color, spacing y tipografia.
- No hay estilos inline ni magic numbers en el CSS.
- El panel de detalle no causa layout shift al abrirse/cerrarse.
- La transicion entre vista lista y calendario es instantanea (<200ms).
- La app se siente como un producto unico, no como bloques pegados.
