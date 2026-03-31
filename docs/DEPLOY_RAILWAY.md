# Deploy Railway

## Estado real

El proceso Node actual se puede construir y arrancar en Railway, pero la funcionalidad completa de busqueda no esta lista para un deploy remoto fiel al entorno local.

Motivo principal:

- la integracion activa con Agil depende de una sesion local de Chrome o Edge
- esa sesion se extrae desde el filesystem del usuario y `localStorage`
- ese mecanismo no existe de forma equivalente dentro de un contenedor remoto

## Lo que si funciona en Railway

- build TypeScript
- servidor Node en un solo proceso
- serving de UI y API
- lectura de `PORT`
- override explicito de `HOST`
- healthcheck

Comandos:

- install: `npm install`
- build: `npm run build`
- start: `npm start`
- healthcheck: `/api/health`

Variables minimas para un deploy remoto:

- `HOST=0.0.0.0`
- `PORT` provisto por Railway

Importante:

- localmente Fly Desk escucha en `127.0.0.1` por defecto
- en Railway hay que forzar `HOST=0.0.0.0` o el contenedor no quedara expuesto

## Lo que no debe asumirse

No debe asumirse que un deploy remoto hoy pueda:

- reutilizar la sesion local de Agil
- hacer busquedas reales contra Agil igual que en localhost
- mantener el mismo flujo end-to-end sin una estrategia nueva de autenticacion/sesion

## Para que quede listo de verdad

Hace falta resolver al menos:

1. una fuente remota de autenticacion o sesion para Agil, o reemplazar Agil como provider directo
2. persistencia externa para jobs y redirects si se quiere robustez multi-instancia
3. estrategia segura para secretos/configuracion

## Conclusión

Railway sigue siendo una opcion natural para el servidor Node, pero hoy sirve mejor como destino de shell/API parcial que como deploy totalmente funcional de la integracion local con Agil.
