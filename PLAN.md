# Plan De Auditoría Back + Front Para Fly Desk

## Summary
Auditar Fly Desk en modo read-only, usando el set curado de skills y cubriendo backend, frontend React/Vite, seguridad local-first, integración API/UI, deuda técnica y validación real. No corregir código en esta pasada; entregar hallazgos priorizados con evidencia, rutas, impacto, riesgo y pruebas recomendadas.

Antes de ejecutar, reiniciar Codex para que cargue las nuevas skills USER.

## Skills A Usar
- Coordinación: `planning-and-task-breakdown`, `context-engineering`
- Backend/API: `api-and-interface-design`, `security-and-hardening`, `code-review-and-quality`
- Frontend/UI: `frontend-product-ui`, `web-design-guidelines`, `vercel-react-best-practices`, `vercel-composition-patterns`
- QA real: `webapp-testing`, `repo-quality-gate`
- Deuda técnica: `safe-dead-code-cleanup`, `monolith-modularization`, `performance-optimization`
- Documentación: `documentation-and-adrs`

## Audit Plan
- Baseline inicial:
  - Registrar `git status`, branch, scripts, Node/npm, estructura `src/`, `test/`, `frontend/`, `docs/`.
  - Tratar los cambios actuales sin commitear como parte del estado a auditar, no como algo a revertir.
  - Marcar explícitamente la divergencia documental: `README.md` y `docs/REPO_CURRENT_STATE.md` describen `public/`, mientras el código actual sirve `frontend/dist`.

- Backend:
  - Revisar `src/server.ts`, `src/http-router.ts`, providers, session-store, runtime, temp artifacts y políticas de fecha.
  - Auditar límites de request body, path traversal, serving estático, errores expuestos, auth `FLY_DESK_API_TOKEN`, headers `x-flydesk-*`, endpoints loopback-only y apertura local de URLs.
  - Revisar contratos `/api/search`, `/api/matrix`, `/api/locations`, `/api/quotation`, `/api/results-layout`, `/api/diagnostics`, `/r/:id`.
  - Revisar concurrencia, cache/SWR, jobs en memoria, polling, stale data, revalidación, carga a providers y manejo de fallos parciales.
  - Revisar superficies de secretos: Agil, Costamar, TOTP, tokens, logs, diagnósticos, archivos `output/`, `.launcher/`, `config/`.

- Frontend:
  - Auditar `frontend/src/App.tsx`, componentes, hooks, `lib/api.ts`, tipos, CSS/Tailwind y shadcn-like components locales.
  - Comparar UI contra `docs/FRONTEND_IDENTITY.md`: densidad, español, tokens, dark mode, layout operacional, estados interactivos, foco visible, responsive y no-overflow.
  - Revisar integración API/UI: errores, loading, polling, filtros, sort, selección de ofertas, cotización, autocomplete y estados vacíos.
  - Revisar accesibilidad: teclado, labels, botones, controles custom, focus-visible, contraste, semántica y navegación móvil.
  - Revisar riesgos React: estado derivado, callbacks, renders innecesarios, stale closures, separación de componentes y duplicación.

- Código muerto / arquitectura:
  - Detectar referencias obsoletas entre `public/` legacy, `frontend/`, docs y servidor.
  - No proponer borrados directos; clasificar candidatos como seguro, medio, alto o revisión manual.
  - Mapear módulos grandes (`http-router`, providers, `App.tsx`) y proponer primeras extracciones pequeñas si hay evidencia.
  - No proponer microservicios.

## Validation Plan
Ejecutar y registrar resultados, sin modificar archivos fuente:

- `npm run typecheck`
- `npm test`
- `npm --prefix frontend run lint`
- `npm run build`
- Smoke local con app construida:
  - iniciar servidor en puerto libre o `32123` si está disponible.
  - abrir desktop `1440x900`, tablet `1024x768`, mobile `390x844`.
  - verificar carga sin errores de consola, sin overflow horizontal, modo claro/oscuro, topbar, search rail, filtros, resultados, detalle, migratorio placeholder, foco por teclado.
- Si una prueba no puede correr por entorno, reportar causa exacta y riesgo residual.

## Reporte Esperado
Entregar en español:

- Resumen ejecutivo con estado general: verde/amarillo/rojo.
- Hallazgos priorizados por severidad:
  - Seguridad
  - Bugs funcionales
  - Frontend/UX/a11y
  - Performance/concurrencia
  - Arquitectura/mantenibilidad
  - Testing/QA
  - Documentación desfasada
- Cada hallazgo debe incluir evidencia, archivo/ruta, impacto, reproducción o razonamiento, y recomendación concreta.
- Separar “verificado” de “inferido”.
- Incluir lista de comandos ejecutados y resultados.
- Incluir quick-win fixes sugeridos, pero no implementarlos en esta pasada.

## Assumptions
- Esta auditoría es read-only: no fixes, no commits, no migraciones, no cambios de secrets, no cambios de pipelines.
- El foco es el estado completo actual del repo, no solo el último diff.
- El frontend React/Vite actual se audita como fuente activa porque `src/server.ts` sirve `frontend/dist`.
- Los cambios sin commitear existentes son del usuario o de trabajo previo y no se revierten.
