# Deploy VPS

## Objetivo

Esta rama prepara Fly Desk como web privada alojada en un VPS:

- Bun ejecuta UI y API en un solo proceso.
- El proceso escucha solo en loopback (`127.0.0.1`).
- Caddy publica HTTPS y hace reverse proxy al puerto local.
- La UI usa cookie httpOnly firmada, no tokens expuestos al browser.
- `FLY_DESK_TRUST_LOOPBACK_CLIENT=0` evita que el proxy local convierta trafico publico en "localhost confiable".
- Despliegue actual: `https://fly-desk.pages.dev/` publica un Worker de Cloudflare Pages que proxyfica al origen privado configurado fuera del repo.
- Caddy restringe `/login` y el resto del acceso publico de Fly Desk a Peru (`CF-IPCountry=PE`) desde `grumitos/vps-platform`; clientes/runners fuera de Peru pueden recibir `403` antes de llegar a la app.
- El mantenimiento diario de plataforma no es un control de acceso: no invalida cookies web y conserva `fly-desk-chrome.service`. Si se necesita endurecer fuerza bruta sobre login, configurarlo como regla Cloudflare/WAF o rate limit de `POST /login` además de la auth propia de la app.

La fuente vigente de Caddy, systemd compartido, rollback de Caddy y plan de plataforma es `grumitos/vps-platform` (`D:\Dev\vps-platform`). Este documento queda como runbook de app: build, deploy de revision, rollback de release y variables propias de Fly Desk.

## Build

```bash
bun install --frozen-lockfile
bun run build
```

## CI

El workflow `.github/workflows/ci.yml` corre en `pull_request`, `push` a `main` y `workflow_dispatch`.

Pasos:

```bash
bun install --frozen-lockfile
bun run playwright install --with-deps chromium
bun run typecheck
bun run lint # solo si existe script lint
bun run build # genera frontend/dist para tests HTTP/UI
bun run test
bun run build
```

El repo fija Bun en `packageManager` y el workflow usa la misma linea de runtime. Bun recomienda `oven-sh/setup-bun@v2` para GitHub Actions y `bun install --frozen-lockfile` para instalaciones reproducibles con `bun.lock`. Node 26 se instala solo para ejecutar la suite UI que usa `node --test` sobre TypeScript.

## Deploy GitHub Actions

El workflow `.github/workflows/deploy-vps.yml` es manual (`workflow_dispatch`) y tiene dos modos:

- `deploy`: valida, compila y empaqueta el `ref` indicado.
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

El usuario SSH debe poder escribir en las rutas de deploy y ejecutar `systemctl restart fly-desk.service` sin prompt interactivo. No debe necesitar permisos para reiniciar `fly-desk-chrome.service`.

Flujo de `deploy`:

1. Checkout del ref.
2. `bun install --frozen-lockfile`.
3. `bun run typecheck`, `bun run lint` si existe, `bun run build` para assets de test, `bun run test` y `bun run build` final.
4. Empaquetado del arbol fuente y `frontend/dist`, excluyendo `.git`, `node_modules`, `output` y reportes locales.
5. Upload por SSH al VPS.
6. Extraccion en `/opt/apps/fly-desk/releases/<sha>`.
7. `bun install --frozen-lockfile` dentro del release.
8. Escritura de `REVISION` con el SHA.
9. Activacion hacia `/opt/fly-desk`.
10. Reinicio de `fly-desk.service`.
11. Verificacion de que `fly-desk-chrome.service` sigue activo si lo estaba antes.
12. Smoke local contra `127.0.0.1:32123`.
13. Smoke publico contra `https://fly-desk.pages.dev/login`; acepta `200` desde Peru o `403` desde runners fuera de Peru cuando la restriccion regional esta activa.

El workflow no toca Caddy ni cambia unidades systemd. Solo reinicia `fly-desk.service`. Si cambia el contrato de Caddy o de unidades systemd, hacerlo desde `grumitos/vps-platform`.

## Variables Minimas

```dotenv
HOST=127.0.0.1
PORT=32123
FLY_DESK_WEB_AUTH=1
FLY_DESK_WEB_PASSWORD_HASH=scrypt:...
FLY_DESK_WEB_SESSION_SECRET=<32+ random chars>
FLY_DESK_TRUST_LOOPBACK_CLIENT=0
FLY_DESK_COOKIE_SECURE=1
FLY_DESK_SEARCH_WORKER_PROCESSES=0
FLY_DESK_PROVIDER_PREWARM=1
FLY_DESK_SESSION_DB_PATH=/var/lib/fly-desk/fly-desk-cache.sqlite
FLY_DESK_LOCATION_SUGGESTION_DB_PATH=/var/lib/fly-desk/location-suggestion-cache.sqlite
```

Generar hash de password:

```bash
FLY_DESK_WEB_PASSWORD='<password>' bun run auth:hash
```

No guardes `FLY_DESK_WEB_PASSWORD`; usa solo `FLY_DESK_WEB_PASSWORD_HASH` en el entorno final.

El despliegue VPS actual mantiene `FLY_DESK_SEARCH_WORKER_PROCESSES=0`. Costamar B2B fue validado en produccion con busqueda en el proceso principal; no reactives workers para busquedas sin repetir QA externo sobre `https://fly-desk.pages.dev/api/search`.

## systemd

Referencia historica de unidad. La fuente vigente esta en `grumitos/vps-platform/systemd`.

```ini
[Unit]
Description=Fly Desk
After=network-online.target
Wants=network-online.target

[Service]
User=deploy
WorkingDirectory=/opt/fly-desk
EnvironmentFile=/etc/fly-desk.env
ExecStart=/home/deploy/.bun/bin/bun src/index.ts
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

## Caddy

Referencia historica de sitio. La fuente vigente esta en `grumitos/vps-platform/caddy`.

```caddyfile
fly-desk.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:32123
}
```

`yasmiau.com` debe quedar en un bloque separado, apuntando al servicio actual (`127.0.0.1:8000`) mientras se mantenga esa web.

## Agilsmart

Agil necesita una sesion persistente de Chrome disponible en el VPS. La configuracion Linux activa:

```dotenv
AGIL_CHROME_EXECUTABLE=/usr/bin/google-chrome
AGIL_CHROME_USER_DATA_DIR=/var/lib/fly-desk/chrome
AGIL_CHROME_PROFILE=Default
AGIL_BROWSER_URL=http://127.0.0.1:9222
```

Servicio systemd activo:

```ini
[Unit]
Description=Fly Desk Chrome CDP
After=network-online.target
Wants=network-online.target

[Service]
User=deploy
Group=deploy
Environment=HOME=/home/deploy
ExecStart=/usr/bin/google-chrome --headless=new --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir=/var/lib/fly-desk/chrome --profile-directory=Default --no-first-run --no-default-browser-check --disable-dev-shm-usage --disable-gpu --no-sandbox --window-size=1440,1000 about:blank
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Verificacion:

```bash
systemctl is-active fly-desk-chrome
curl -fsS http://127.0.0.1:9222/json/version
```

Estado actual: Chrome CDP ya queda persistente en el VPS; Agil todavia requiere cargar o validar una sesion real dentro de ese perfil. Si Agil no mantiene sesion estable en el VPS, el plan de rollback funcional es mantener Fly Desk web central y dejar un agente local minimo solo para Agil.

## Costamar

Costamar usa las credenciales B2B y TOTP desde `/etc/fly-desk.env`. Para migrar secretos desde un entorno local, no reemplaces el archivo completo en bruto: preserva las variables propias del VPS (`HOST`, `PORT`, auth web, rutas SQLite y rutas Linux de Chrome) y fusiona solo credenciales y claves de integraciones.

QA actual:

```bash
systemctl is-active fly-desk
grep -E '^FLY_DESK_SEARCH_WORKER_PROCESSES=' /etc/fly-desk.env
```

Una busqueda externa de prueba devolvio ofertas en `https://fly-desk.pages.dev/` con `FLY_DESK_SEARCH_WORKER_PROCESSES=0`.

## Healthcheck

```bash
curl -fsS http://127.0.0.1:32123/api/health
```

## Rollback

Rollback por release:

1. Abrir `Deploy VPS` en GitHub Actions.
2. Elegir `mode=rollback`.
3. Indicar un `rollback_sha` que exista en `/opt/apps/fly-desk/releases/<sha>`.
4. El workflow reactiva ese release, reescribe `/opt/fly-desk/REVISION`, reinicia `fly-desk.service` y repite los smokes.

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
