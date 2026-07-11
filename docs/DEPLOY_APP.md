# Deploy de app: Fly Desk

Este repo publica solo el producto Fly Desk. Caddy, systemd, usuarios, firewall, el motor de releases y sus wrappers pertenecen a `grumitos/vps-platform`.

## Contrato de produccion

- Repo canonico: `grumitos/fly-desk`.
- Rama desplegable: `main`; el workflow exige un SHA exacto de 40 caracteres alcanzable desde `origin/main`.
- Current atomico: `/opt/fly-desk`.
- Releases inmutables: `/opt/apps/fly-desk/releases/<sha>`.
- Estado persistente: `/var/lib/fly-desk`; nunca forma parte del artefacto ni del rollback.
- Web: `fly-desk.service`, `127.0.0.1:8100`.
- Busquedas: `fly-desk-search.service`, `127.0.0.1:8101`.
- Redirects: `fly-desk-redirect.service`, `127.0.0.1:8102`.
- Chrome/CDP: `fly-desk-chrome.service`, `127.0.0.1:9222`; un deploy normal no lo reinicia.
- Cara publica: `https://fly-desk.pages.dev/`.

## Gate local

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run build
bun run test
```

## Deploy por GitHub Actions

El workflow `.github/workflows/deploy-vps.yml` tiene dos modos:

- `deploy`: comprueba que el SHA exacto pertenece a `main`, ejecuta el gate, crea un tar con raiz unica `app/`, calcula SHA-256, lo sube al incoming fijo y llama al wrapper versionado de plataforma.
- `rollback`: activa un release inmutable existente por SHA mediante el mismo wrapper.

El workflow no instala unidades, no modifica Caddy y no transmite un script de despliegue por SSH. El unico comando privilegiado de app es:

```text
/usr/local/bin/vps-release-fly-desk deploy <sha40> <sha256>
/usr/local/bin/vps-release-fly-desk rollback <sha40>
```

El motor toma un lock compartido con mantenimiento, valida digest y estructura del tar, prepara el candidate como usuario de runtime, conmuta el symlink, reinicia web/search/redirect, ejecuta healthchecks y restaura el current anterior si falla la activacion.

Secrets requeridos:

- `VPS_HOST`
- `VPS_PORT`, opcional; default `22`
- `VPS_USER`, identidad CI dedicada a Fly Desk
- `VPS_SSH_KEY_B64`
- `VPS_SSH_KNOWN_HOSTS_B64`, obtenido por un canal confiable

El job usa `BatchMode`, `IdentitiesOnly` y `StrictHostKeyChecking`; no admite `ssh-keyscan`. El usuario CI solo debe poder escribir en el incoming de Fly Desk y ejecutar su wrapper fijo con `sudo -n`.

## Preparacion del release

`deploy/prepare-release.sh` ejecuta `bun install --frozen-lockfile` con el Bun del sistema y exige que el frontend compilado esté presente. El motor lo ejecuta como usuario de runtime, nunca como root.

Las variables reales de aplicación viven en `/etc/fly-desk.env`. `.env.example` documenta nombres y defaults, no valores. Los SQLite, caches, sesiones, perfil Chrome y artefactos mutables deben permanecer bajo `/var/lib/fly-desk`.

## Verificacion y rollback

Tras desplegar, el wrapper exige health local en `8100`, `8101` y `8102`. El workflow acepta `200` publico o el `403` regional esperado desde runners fuera de Peru.

Para cambios de busqueda, cancelacion, redirects, proveedores o sesiones/cache, ejecutar despues `Fly Desk Production Smoke` en `vps-platform` y esperar su resultado.

Para rollback, abrir `Deploy VPS`, elegir `mode=rollback` e indicar el SHA exacto de un release existente. Si Actions no esta disponible, usar el wrapper desde el acceso operativo documentado por plataforma; no copiar releases con `rsync` ni cambiar manualmente `/opt/fly-desk`.
