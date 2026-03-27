# Fly Desk

Workspace local para busqueda y cotizacion aerea orientado a agentes de viajes.

El repositorio hoy combina:

- servidor Node que sirve UI y API en el mismo proceso
- frontend desktop en `public/` con HTML/CSS/JS vanilla
- integracion local con Agil reutilizando la sesion del navegador real
- store en memoria para jobs, redirects y resultados

## Alcance actual

- busqueda exacta
- busqueda flexible con matriz de fechas
- autocomplete de origen/destino
- filtro rapido `Directo` y `Con equipaje`
- lista de resultados con paginacion
- vista calendario/matriz
- sidebar por aerolinea
- panel de detalle
- `reprice`
- `quotation`
- comparador
- links de compra / apertura equivalente en Agil

Controles retirados del frontend actual:

- cabina visible
- moneda editable
- precio maximo
- maximo de escalas
- overlay global de carga

El feedback de carga ahora es inline:

- placeholder en resultados durante busqueda exacta
- celdas loading en matriz
- estado de carga dentro del panel de detalle para `reprice` y `quotation`

## Estructura

- [public/index.html](/D:/Dev/fly-desk/public/index.html): shell desktop y markup del producto
- [public/app.css](/D:/Dev/fly-desk/public/app.css): tokens, layout, componentes, overlays y estados visuales
- [public/app.js](/D:/Dev/fly-desk/public/app.js): estado global, calendario, formulario, render, polling y eventos
- [src/http-router.ts](/D:/Dev/fly-desk/src/http-router.ts): BFF HTTP
- [src/local-agil.ts](/D:/Dev/fly-desk/src/local-agil.ts): sesion local, refresh de token, requests a Agil, mapeo y matriz
- [src/session-store.ts](/D:/Dev/fly-desk/src/session-store.ts): store en memoria para jobs y purchase paths
- [test/ui.test.ts](/D:/Dev/fly-desk/test/ui.test.ts): regresiones de interfaz desktop

## Sesion local de Agil

La integracion actual depende de una sesion real en Chrome o Edge. El flujo local intenta leer `localStorage` de:

- `https://www.agilsmart.com/home-user`
- `https://motorvuelos.expertiatravel.com/`

Variables utiles:

- `AGIL_CHROME_PROFILE`
- `AGIL_CHROME_USER_DATA_DIR`
- `AGIL_CHROME_EXECUTABLE`

Ejemplos:

- Chrome perfil por defecto: sin variables adicionales
- Chrome perfil secundario: `AGIL_CHROME_PROFILE=Profile 1`
- Edge: `AGIL_CHROME_USER_DATA_DIR=%LOCALAPPDATA%\\Microsoft\\Edge\\User Data`

## Scripts

- `npm run dev`
- `npm test`
- `npm run build`
- `npm run typecheck`
- `npm start`
- `npm run demo`

## Verificacion reciente

Estado validado el 27 de marzo de 2026:

- `npm test`
- `npm run build`
- `npm run typecheck`
- smoke real en navegador a `1920x1080`
- busqueda exacta real con placeholder inline y resultados
- matriz flexible real con celdas resolviendo y paso a lista exacta

## Documentacion vigente

- [Estado actual de la repo](/D:/Dev/fly-desk/docs/REPO_CURRENT_STATE.md)
- [Auditoria tecnica de codigo](/D:/Dev/fly-desk/docs/CODE_AUDIT_2026-03-27.md)
- [Deploy en Railway](/D:/Dev/fly-desk/docs/DEPLOY_RAILWAY.md)

## Nota de deploy

La UI y el servidor se pueden levantar en cualquier host Node, pero la integracion completa con Agil todavia depende de una sesion local de navegador. Eso hace que un deploy remoto sea parcial hasta rediseñar la estrategia de autenticacion/sesion.
