# Travel Quote Foundation

Base tecnica para un motor de cotizacion aerea orientado a agentes de viajes.

## Que incluye

- modelo canonico de busqueda/oferta
- interfaces de providers
- orquestador de busqueda
- score de ranking
- motor de matriz flexible
- generador de cotizacion en texto
- provider mock para pruebas tempranas
- integracion con Agil (motorvuelos + AgilSmart)
- BFF HTTP y UI utilitaria

## Que NO incluye todavia

- persistencia
- auth
- estado externo para serverless

## Configuracion

El proyecto trabaja con Agil como proveedor principal. En modo local, la matriz se construye via AgilSmart extrayendo sesion de Chrome.

Si no hay sesion Agil disponible, el proyecto cae a `MockProvider`.

## Deploy recomendado

Para este repo, `Railway` es mas natural que serverless porque hoy:

- corre sobre un servidor Node propio
- guarda sesiones y purchase paths en memoria

En `Railway` el proceso puede correr tal cual con:

- install: `npm install`
- build: `npm run build`
- start: `npm start`

Healthcheck recomendado:

- `/api/health`

## Scripts

- `npm run dev`
- `npm run build`
- `npm start`
- `npm run demo`
