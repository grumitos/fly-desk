# Auditoría Técnica — 2026-03-27

## Hallazgos corregidos

### 1. Fuga de `purchasePaths` en memoria

- `SearchSessionStore` reescribía `purchasePaths` en cada refresco de búsqueda.
- Los ids anteriores seguían vivos en el mapa interno y nunca se limpiaban.
- Efecto:
  - crecimiento innecesario de memoria
  - redirects viejos todavía resolubles aunque el resultado ya hubiera sido reemplazado
- Corrección aplicada:
  - limpieza por sesión en cada `syncSessionFromSearchJob`
  - limpieza por oferta en `updateOffer`

### 2. Código muerto en `public/app.js`

- Se retiraron helpers que ya no participaban en el flujo actual:
  - builder cliente de URLs de Agil
  - formatter de fecha asociado a ese builder
  - helper de celda de matriz no usado
  - helper de rango de fechas no usado
  - enforce helpers no conectados al formulario
  - flags `showAgilEmbed` y `agilLaunchStatus` sin efecto real
- Resultado:
  - menos ruido en el archivo principal
  - menos riesgo de desalinear frontend y backend con dos constructores de URL distintos

## Riesgos y deuda técnica vigente

### 1. `public/app.js` sigue siendo demasiado grande

- Mezcla:
  - estado global
  - calendario
  - validación
  - búsqueda
  - render de resultados
  - detalle
  - eventos
- Riesgo:
  - cambios cruzados difíciles de validar
  - pruebas más caras de mantener
- Siguiente refactor recomendado:
  - extraer `calendar`, `search-form`, `results-view` y `detail-panel` a módulos separados

### 2. `src/local-agil.ts` concentra demasiadas responsabilidades

- Hoy mezcla:
  - sesión de Chrome
  - refresh de token
  - payload building
  - llamadas HTTP a Agil
  - mapeo de resultados
  - concurrencia
  - matriz/range/exact/reprice
- Riesgo:
  - muy alta superficie de regresión
  - difícil aislar errores de sesión vs errores de búsqueda
- Siguiente refactor recomendado:
  - separar en:
    - `agil-session`
    - `agil-client`
    - `agil-mappers`
    - `agil-search`

### 3. No hay linter ni chequeo de código muerto automatizado

- El proyecto hoy depende de:
  - `npm test`
  - `npm run build`
- Riesgo:
  - helpers muertos o estilos inline pueden reaparecer sin fricción
- Recomendación:
  - agregar ESLint con reglas de `no-unused-vars`, complejidad y estilo básico

## Pruebas ejecutadas después de la limpieza

- `npm test`
- `npm run build`

## Cobertura añadida

- nueva prueba para limpiar `purchasePaths` viejos tras refresco de job
- nueva prueba para limpiar `purchasePaths` viejos tras `updateOffer`
