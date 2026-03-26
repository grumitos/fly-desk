# Deploy Railway

## Por que Railway

El backend actual corre mejor en un proceso Node persistente que en serverless:

- `src/server.ts` sirve UI y API en el mismo proceso
- `src/session-store.ts` guarda `searchSessionId` en memoria

`Railway` evita esa friccion y permite desplegar sin rehacer el stack.

## Configuracion minima del servicio

- Runtime: Node
- Install command: `npm install`
- Build command: `npm run build`
- Start command: `npm start`
- Healthcheck path: `/api/health`

El repo ya incluye `Procfile`:

```txt
web: npm start
```

## Variables de entorno

No se requieren variables de entorno obligatorias. Agil funciona via extraccion de sesion local en modo localhost.

## Rutas publicas

- `/`
- `/api/health`
- `/api/search`
- `/api/reprice`
- `/api/matrix`
- `/api/compare`
- `/api/quotation`

## Estado actual

Listo para Railway:

- build TypeScript
- start via `node dist/index.js`
- lectura de `PORT`
- health endpoint

Pendiente para mayor robustez:

- persistencia externa de sesiones
- auth
