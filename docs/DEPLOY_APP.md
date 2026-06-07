# Deploy de app: Fly Desk

Este documento cubre solo el deploy de Fly Desk. Caddy, systemd compartido, firewall, certificados, geofence, mantenimiento diario y rollback de plataforma pertenecen a `grumitos/vps-platform`.

## Estado vigente

- Repo canonico: `grumitos/fly-desk`.
- Branch de producto y deploy: `main`.
- App remota: `/opt/fly-desk`.
- Releases remotos: `/opt/apps/fly-desk/releases/<sha>`.
- Servicio web/app: `fly-desk.service`.
- Servicio busquedas: `fly-desk-search.service` cuando la plataforma lo instala.
- Servicio redirects: `fly-desk-redirect.service` cuando la plataforma lo instala.
- Servicio Chrome/CDP: `fly-desk-chrome.service`.
- Healthcheck local web: `http://127.0.0.1:32123/api/health`.
- Healthcheck local busquedas: `http://127.0.0.1:32125/api/health`.
- Healthcheck local redirects: `http://127.0.0.1:32124/api/health`.
- Cara publica: `https://fly-desk.pages.dev/`.

El deploy rutinario reinicia `fly-desk.service`, escribe `REVISION`, conserva `fly-desk-chrome.service` y no cambia Caddy ni unidades systemd. Si `fly-desk-search.service` o `fly-desk-redirect.service` ya existen en el VPS, tambien los reinicia y valida sus healthchecks locales para que busquedas y `/r/*` usen la misma revision.

## Plataforma publica

`https://fly-desk.pages.dev/`, Cloudflare Pages, bindings de Pages, geofence publico, Caddy y secretos operativos compartidos se operan desde `grumitos/vps-platform`. Para cambios en esa capa, usar los runbooks de plataforma (`docs/FLY_DESK_PAGES.md` y `docs/LOCAL_SECRET_STORE.md`) y no agregar procedimientos de acceso ni valores a este repo.

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
- `FLY_DESK_SEARCH_SERVICE`; default `fly-desk-search.service`
- `FLY_DESK_CHROME_SERVICE`; default `fly-desk-chrome.service`
- `FLY_DESK_REDIRECT_SERVICE`; default `fly-desk-redirect.service`
- `FLY_DESK_LOCAL_SMOKE_URL`; default `http://127.0.0.1:32123/api/health`
- `FLY_DESK_SEARCH_LOCAL_SMOKE_URL`; default `http://127.0.0.1:32125/api/health`
- `FLY_DESK_REDIRECT_LOCAL_SMOKE_URL`; default `http://127.0.0.1:32124/api/health`

## Configuracion minima de app

`.env.example` lista variables soportadas. En VPS, las variables reales viven en `/etc/fly-desk.env`; no se versionan.

Grupos principales:

- Runtime/API: `HOST`, `PORT`, `FLY_DESK_API_TOKEN`, `FLY_DESK_SEARCH_SERVICE_URL`, `FLY_DESK_SEARCH_SERVICE_API_TOKEN`, `FLY_DESK_SEARCH_SERVICE_TIMEOUT_MS`, `FLY_DESK_REDIRECT_HOST`, `FLY_DESK_REDIRECT_PORT`, `FLY_DESK_REDIRECT_CACHE_LOOKUP_TIMEOUT_MS`.
- Auth web: `FLY_DESK_WEB_AUTH`, `FLY_DESK_WEB_PASSWORD_HASH`, `FLY_DESK_WEB_SESSION_SECRET`, `FLY_DESK_TRUST_LOOPBACK_CLIENT`, `FLY_DESK_TRUST_REVERSE_PROXY_LOOPBACK`, `FLY_DESK_COOKIE_SECURE`.
- Busqueda/cache: `SEARCH_MAX_FUTURE_DAYS`, `FLY_DESK_SEARCH_WORKER_PROCESSES`, `FLY_DESK_MIGRATION_CONCURRENT_MONTHS`, `FLY_DESK_SESSION_DB_PATH`, `FLY_DESK_LOCATION_SUGGESTION_DB_PATH`, `FLY_DESK_LOCATION_USAGE_DB_PATH`, `FLY_DESK_APP_DATA_DIR`, `FLY_DESK_QUOTATION_RATE_CACHE_PATH`.
- Providers: `AGIL_*`, `CBPLUS_*`, `CBPLUS_B2B_*`; `COSTAMAR_*` queda como fallback legacy donde aplique.

Produccion debe mantener busquedas de proveedor delegadas al runner dedicado cuando la plataforma instala `fly-desk-search.service`, y dentro de ese runner mantener `FLY_DESK_SEARCH_WORKER_PROCESSES=1`. Usar `0` solo como excepcion temporal de QA; si se cambian workers, runner o warm-up, repetir QA externo antes de darlo por estable.

No configurar `FLY_DESK_SEARCH_SERVICE_TIMEOUT_MS` por debajo del default operativo. El proxy web hacia el runner aplica un piso defensivo para evitar abortos inmediatos, pero un valor bajo en produccion sigue siendo mala senal operativa: polling con muchas ofertas debe tener margen suficiente sin bloquear el proceso web.

Despues de un deploy que toque busquedas, cancelacion, proxy al runner o redirects, ejecutar en `grumitos/vps-platform` el workflow `Fly Desk Production Smoke`. Es el gate productivo que valida health local web/search/redirect, una busqueda completada, enlaces Agil y Click and Book Plus resueltos por `/r/*`, cancelacion de una segunda busqueda y servicios activos al final.

## Rollback

Desde GitHub Actions:

1. Abrir `Deploy VPS`.
2. Elegir `mode=rollback`.
3. Indicar un `rollback_sha` que exista en `/opt/apps/fly-desk/releases/<sha>`.
4. Revisar que el workflow reactive el release, reescriba `REVISION`, reinicie `fly-desk.service`, reinicie `fly-desk-search.service` y `fly-desk-redirect.service` si existen, y pase smokes.

Rollback manual si GitHub Actions no esta disponible:

```bash
sha=<sha-a-restaurar>
release=/opt/apps/fly-desk/releases/$sha
test -d "$release"
rsync -a --delete "$release"/ /opt/fly-desk/
printf '%s\n' "$sha" > /opt/fly-desk/REVISION
if systemctl cat fly-desk-search.service >/dev/null 2>&1; then
  systemctl restart fly-desk-search.service
  curl -fsS http://127.0.0.1:32125/api/health > /dev/null
fi
systemctl restart fly-desk.service
if systemctl cat fly-desk-redirect.service >/dev/null 2>&1; then
  systemctl restart fly-desk-redirect.service
  curl -fsS http://127.0.0.1:32124/api/health > /dev/null
fi
curl -fsS http://127.0.0.1:32123/api/health > /dev/null
```

Conserva `/var/lib/fly-desk` para no perder cache/sesiones. No reinicies `fly-desk-chrome.service` salvo que el cambio lo requiera de forma explicita.
