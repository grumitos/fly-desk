# Deploy de app: Fly Desk

Este documento cubre solo el deploy de Fly Desk. Caddy, systemd compartido, firewall, certificados, geofence, mantenimiento diario y rollback de plataforma pertenecen a `grumitos/vps-platform`.

## Estado vigente

- Repo canonico: `grumitos/fly-desk`.
- Branch de producto y deploy: `main`.
- App remota: `/opt/fly-desk`.
- Releases remotos: `/opt/apps/fly-desk/releases/<sha>`.
- Servicio app: `fly-desk.service`.
- Servicio Chrome/CDP: `fly-desk-chrome.service`.
- Healthcheck local: `http://127.0.0.1:32123/api/health`.
- Cara publica: `https://fly-desk.pages.dev/`.

El deploy rutinario reinicia solo `fly-desk.service`, escribe `REVISION`, conserva `fly-desk-chrome.service` y no cambia Caddy ni unidades systemd.

## Build y tests

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run build
bun run test
```

## Deploy GitHub Actions

Workflow: `.github/workflows/deploy-vps.yml`.

Modos:

- `deploy`: valida, compila, empaqueta el ref indicado, sube release y activa el SHA.
- `rollback`: reactiva un release ya existente por SHA.

Secrets requeridos:

- `FLY_DESK_VPS_HOST`
- `FLY_DESK_VPS_USER`
- `FLY_DESK_VPS_SSH_KEY`
- `FLY_DESK_VPS_PORT` opcional; default `22`

Variables opcionales de repo:

- `FLY_DESK_DEPLOY_PATH`; default `/opt/fly-desk`
- `FLY_DESK_RELEASE_ROOT`; default `/opt/apps/fly-desk/releases`
- `FLY_DESK_BUN_BIN`; default `/home/deploy/.bun/bin/bun`
- `FLY_DESK_SERVICE`; default `fly-desk.service`
- `FLY_DESK_CHROME_SERVICE`; default `fly-desk-chrome.service`
- `FLY_DESK_LOCAL_SMOKE_URL`; default `http://127.0.0.1:32123/api/health`

## Configuracion minima de app

`.env.example` lista variables soportadas. En VPS, las variables reales viven en `/etc/fly-desk.env`; no se versionan.

Grupos principales:

- Runtime/API: `HOST`, `PORT`, `FLY_DESK_API_TOKEN`.
- Auth web: `FLY_DESK_WEB_AUTH`, `FLY_DESK_WEB_PASSWORD_HASH`, `FLY_DESK_WEB_SESSION_SECRET`, `FLY_DESK_TRUST_LOOPBACK_CLIENT`, `FLY_DESK_COOKIE_SECURE`.
- Busqueda/cache: `SEARCH_MAX_FUTURE_DAYS`, `FLY_DESK_SESSION_DB_PATH`, `FLY_DESK_LOCATION_SUGGESTION_DB_PATH`.
- Providers: `AGIL_*`, `COSTAMAR_*`, `COSTAMAR_B2B_*`.

Produccion actual usa busqueda en el proceso principal para Costamar B2B. Si se cambian workers o warm-up, repetir QA externo antes de darlo por estable.

## Rollback

Desde GitHub Actions:

1. Abrir `Deploy VPS`.
2. Elegir `mode=rollback`.
3. Indicar un `rollback_sha` que exista en `/opt/apps/fly-desk/releases/<sha>`.
4. Revisar que el workflow reactive el release, reescriba `REVISION`, reinicie `fly-desk.service` y pase smokes.

Rollback manual si GitHub Actions no esta disponible:

```bash
sha=<sha-a-restaurar>
release=/opt/apps/fly-desk/releases/$sha
test -d "$release"
rsync -a --delete "$release"/ /opt/fly-desk/
printf '%s\n' "$sha" > /opt/fly-desk/REVISION
systemctl restart fly-desk.service
curl -fsS http://127.0.0.1:32123/api/health > /dev/null
```

Conserva `/var/lib/fly-desk` para no perder cache/sesiones. No reinicies `fly-desk-chrome.service` salvo que el cambio lo requiera de forma explicita.
