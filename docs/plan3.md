# Plan: Mejora del Frontend — Flight Desk

## Problema

El frontend de Flight Desk es funcional pero ha crecido orgánicamente. Los tres archivos (`index.html`, `app.css`, `app.js`) son monolíticos y la experiencia de usuario tiene problemas de claridad visual, densidad de información y feedback al usuario. Es software utilitario para un agente de viajes: debe ser limpio, claro, sin distracciones.

## Diagnóstico

### Problemas de estructura HTML
- El formulario de búsqueda muestra todos los campos en una fila larga sin agrupaciones visuales claras
- El show/hide de campos por modo (Exacto/Rango/Matriz) es funcional pero visualmente abrupto
- La barra de resumen acumula muchos `<span class="tag">` sin jerarquía
- Las secciones (Resultados, Detalle, Comparador, Matriz) no tienen separación visual clara

### Problemas de CSS
- Fuentes muy pequeñas (labels a 0.62rem, 8px efectivos — difícil de leer)
- Todo es cuadrado/angular sin border-radius — aspecto demasiado industrial
- Sin feedback visual de carga durante búsquedas
- Contraste y jerarquía tipográfica insuficientes
- Solo 1 breakpoint responsive (900px)

### Problemas de UX/JS
- `window.alert()` para errores — interrumpe el flujo del agente
- Sin indicador de carga (spinner) durante búsquedas
- Cada cambio de filtro re-renderiza TODO el DOM y re-adjunta eventos
- Sin atajos de teclado para usuario frecuente
- El botón DEMO es distracción en producción

### Problemas de código (app.js ~1007 líneas)
- Todo en un archivo global sin separación lógica
- Rendering via `innerHTML` con template strings — funcional pero frágil
- Eventos se re-adjuntan en cada render (memoria, bugs potenciales)
- Mezcla español/inglés inconsistente

## Enfoque

Dado que no hay build tools para el frontend (es vanilla JS servido como estáticos), no propondré frameworks ni módulos ES. Los cambios serán pragmáticos dentro de la arquitectura actual.

## Tareas

### 1. `css-polish` — Pulido visual del CSS
**Archivo:** `public/app.css`
- Aumentar fuentes base a 14px (de 13px), labels a mínimo 0.68rem
- Agregar `border-radius: 4px` a inputs, botones, tags, secciones y celdas de matriz
- Mejorar spacing (más padding en secciones, separación entre grupos)
- Agregar variable `--radius` al `:root`
- Mejorar estados hover/focus con transiciones suaves
- Agregar estilos para overlay de carga (spinner)
- Agregar estilos para toast de notificación (reemplaza alert)
- Mejorar responsive: agregar breakpoint a 1200px y 600px

### 2. `html-form-structure` — Reorganizar el formulario de búsqueda
**Archivo:** `public/index.html`
- Agrupar campos relacionados con separadores visuales: [Modo+Tipo] | [Ruta] | [Fechas] | [Pasajeros] | [Cabina+Moneda]
- Mover filtros secundarios (Directos, Equipaje, Orden, Max precio, Max esc, Carriers) a un panel colapsable "Filtros avanzados" — visible con un toggle
- Agregar contenedor para toast de notificaciones
- Agregar overlay de carga con spinner
- Eliminar botón DEMO del layout principal (moverlo a un atajo de teclado oculto o al footer)

### 3. `html-sections-clarity` — Mejorar secciones de contenido
**Archivo:** `public/index.html`
- Limpiar la barra de resumen: solo info esencial (ruta, modo, moneda)
- Agregar secciones plegables (toggle con click en el encabezado)
- Mejor organización del header de sección con contadores visibles

### 4. `js-loading-toast` — Agregar loading states y sistema de toast
**Archivo:** `public/app.js`
- Crear funciones `showLoading()` / `hideLoading()` con overlay
- Crear `showToast(message, type)` para reemplazar `window.alert()`
- Envolver las llamadas API existentes con loading/toast
- Agregar Ctrl+Enter como atajo para buscar

### 5. `js-render-cleanup` — Mejorar lógica de renderizado
**Archivo:** `public/app.js`
- Usar event delegation en vez de re-adjuntar eventos por cada render
- Hacer que renderResults() y renderDetail() usen delegación de eventos desde el contenedor
- Reorganizar el código con secciones/comentarios más claros
- Mover el botón DEMO a atajo oculto (Ctrl+D o similar)
- Debounce en cambios de filtros de texto (carriers, maxPrice)

### 6. `js-table-improvements` — Mejorar tabla de resultados
**Archivo:** `public/app.js`
- Mejorar el renderizado de la tabla: columnas más legibles, alineación
- Mostrar duración en formato "Xh Ym" en vez de "Xm"
- Mostrar fechas de forma más compacta
- Mejorar indicadores de confianza de precio
- Agregar indicador visual del número de resultados filtrados vs total

## Orden de dependencias
```
css-polish ──────────────┐
html-form-structure ─────┼──> js-loading-toast ──> js-render-cleanup ──> js-table-improvements
html-sections-clarity ───┘
```

Los primeros 3 son independientes entre sí. Los últimos 3 son secuenciales.

## Notas
- No se introduce ningún framework ni dependencia nueva
- Se mantiene la misma arquitectura (vanilla JS, 3 archivos estáticos)
- Los cambios en CSS y HTML son independientes y de bajo riesgo
- Los cambios en JS son más delicados porque alteran la lógica de renderizado
- Se recomienda probar visualmente tras cada grupo de cambios
