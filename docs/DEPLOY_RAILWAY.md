# Deploy Railway

## Estado Real

El proceso Bun actual se puede construir y arrancar en Railway, pero Fly Desk sigue siendo local-first. Un deploy remoto sirve para shell, healthcheck y API parcial; no equivale al entorno local completo.

Motivo principal:

- Agil depende de una sesion local de Chrome o Edge
- esa sesion se extrae desde el filesystem del usuario, storage del navegador y, cuando aplica, DevTools
- ese mecanismo no existe de forma equivalente dentro de un contenedor remoto
- la UI empaquetada no inyecta automaticamente `FLY_DESK_API_TOKEN` para clientes publicos

## Lo Que Si Funciona

- instalacion con Bun
- build frontend con `Bun.build`
- servidor Bun en un solo proceso
- serving de UI estatica y API tecnica
- lectura de `PORT`
- override explicito de `HOST`
- healthcheck `/api/health`

Comandos:

- install: `bun install --frozen-lockfile`
- build: `bun run build`
- start: `bun run start`
- healthcheck: `/api/health`

Variables minimas:

- `HOST=0.0.0.0`
- `PORT` provisto por Railway
- `FLY_DESK_API_TOKEN=<token>` si se exponen endpoints operativos a clientes no loopback

Importante:

- localmente Fly Desk escucha en `127.0.0.1` por defecto
- en Railway hay que forzar `HOST=0.0.0.0`
- `/api/health` no requiere token
- busqueda, matriz, cotizacion, autocomplete y redirects requieren localhost o token valido

## Seguridad De Instalacion

El deploy debe usar Bun, no npm ni pnpm:

- `bun.lock` es el lockfile fuente
- `bunfig.toml` desactiva lifecycle scripts de dependencias
- `bunfig.toml` filtra versiones npm publicadas hace menos de 3 dias
- `.npmrc` solo existe como guardrail para instalaciones accidentales con npm/pnpm

Si un paquete nuevo necesita ejecutar scripts de instalacion, debe aprobarse explicitamente con `trustedDependencies` y revisarse como cambio de supply chain.

## Lo Que No Debe Asumirse

No debe asumirse que un deploy remoto hoy pueda:

- reutilizar la sesion local de Agil
- hacer busquedas reales contra Agil igual que en localhost
- mantener el mismo flujo end-to-end sin una estrategia nueva de autenticacion/sesion
- servir una UI publica sin resolver como entregar credenciales/API token de forma segura

## Para Que Quede Listo De Verdad

Hace falta resolver al menos:

1. una fuente remota de autenticacion o sesion para Agil, o reemplazar Agil como provider directo
2. una forma segura de entregar `FLY_DESK_API_TOKEN` o un esquema de auth equivalente a la UI remota
3. persistencia externa para jobs y redirects si se quiere robustez multi-instancia
4. estrategia segura para secretos/configuracion

## Conclusion

Railway sigue siendo una opcion natural para el servidor Bun, pero hoy sirve mejor como destino de shell, healthcheck y API parcial que como deploy totalmente funcional de la integracion local con Agil.
