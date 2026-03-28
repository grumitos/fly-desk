# CSS Code Audit

Fecha: 2026-03-28

## Hallazgos

- El CSS estaba organizado por pantallas, pero no por familias visuales. La misma intención de diseño aparecía repetida en paneles, overlays, controles y labels con microvariantes manuales.
- Las superficies base estaban duplicadas con literales repetidos como `border: 1px solid var(--line)`, `background: color-mix(... var(--surface) 92% ...)` y `background: var(--overlay)`.
- Los estados `active/selected` usaban la misma semántica visual, pero con mezclas distintas de borde y color según el componente.
- Había números mágicos en overlays, especialmente en `Escala`, donde el ancho mínimo y máximo seguían definidos en JS.
- La tipografía de micro-labels estaba cercana, pero no tokenizada: eyebrow, section title, field label y headers de tabla usaban valores casi iguales sin una capa común.

## Refactor Implementado

- Se añadieron tokens semánticos para labels, superficies, padding de secciones, alturas compactas, selección y anchos del popover de `Escala`.
- Se consolidaron familias base de `panel-surface` y `floating-surface` mediante reglas agrupadas, sin tocar el HTML.
- Se reemplazaron literales repetidos por tokens compartidos en:
  - `search-shell`, `results-toolbar`, `results-container`, `workspace__detail`
  - `autocomplete-menu`, `pax-popover`, `calendar-popover`, `refinement-popover`, `toast`, `matrix-fullscreen__panel`
  - controles secundarios como `badge`, `theme-switch`, `field-button`, `btn`, `refinement`, `airline-chip`, `detail-segment__leg`, `quote-textarea`
- Se normalizaron labels y headers usando una escala tipográfica común para `eyebrow`, títulos de sección y headers de tabla.
- `Escala` dejó de depender de anchos hardcodeados en JS y ahora lee `--layover-popover-min-width` y `--layover-popover-max-width` desde CSS.
- Se tokenizó la ladder principal de `z-index` para que topbar, popovers, toasts y fullscreen compartan una jerarquía declarativa.

## Deuda Pendiente

- El shell de búsqueda todavía depende de medición runtime para cuadrar tracks. Funciona, pero sigue siendo más complejo de lo ideal.
- Los popovers comparten anclaje, pero su ciclo de apertura/cierre aún podría extraerse a una utilidad única.
- El spacing fino todavía usa varios valores cercanos (`0.68`, `0.72`, `0.75`, `0.82`, `0.85`, `0.95`). Ya está mejor encapsulado, pero todavía no es una escala completamente cerrada.
