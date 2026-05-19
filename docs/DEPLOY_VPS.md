# Deploy VPS

## Objetivo

Esta rama prepara Fly Desk como web privada alojada en un VPS:

- Bun ejecuta UI y API en un solo proceso.
- El proceso escucha solo en loopback (`127.0.0.1`).
- Caddy publica HTTPS y hace reverse proxy al puerto local.
- La UI usa cookie httpOnly firmada, no tokens expuestos al browser.
- `FLY_DESK_TRUST_LOOPBACK_CLIENT=0` evita que el proxy local convierta trafico publico en "localhost confiable".
- Despliegue actual: `https://fly-desk.pages.dev/` publica un Worker de Cloudflare Pages que proxyfica al origen privado `fly-desk-origin.yasmiau.com` sin mostrar `yasmiau.com` al usuario.

## Build

```bash
bun install --frozen-lockfile
bun run build
```

## Variables Minimas

```dotenv
HOST=127.0.0.1
PORT=32123
FLY_DESK_WEB_AUTH=1
FLY_DESK_WEB_PASSWORD_HASH=scrypt:...
FLY_DESK_WEB_SESSION_SECRET=<32+ random chars>
FLY_DESK_TRUST_LOOPBACK_CLIENT=0
FLY_DESK_COOKIE_SECURE=1
FLY_DESK_SEARCH_WORKER_PROCESSES=1
FLY_DESK_PROVIDER_PREWARM=1
FLY_DESK_SESSION_DB_PATH=/var/lib/fly-desk/fly-desk-cache.sqlite
FLY_DESK_LOCATION_SUGGESTION_DB_PATH=/var/lib/fly-desk/location-suggestion-cache.sqlite
```

Generar hash de password:

```bash
FLY_DESK_WEB_PASSWORD='<password>' bun run auth:hash
```

No guardes `FLY_DESK_WEB_PASSWORD`; usa solo `FLY_DESK_WEB_PASSWORD_HASH` en el entorno final.

## systemd

Ejemplo de unidad:

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

Ejemplo de sitio:

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

## Healthcheck

```bash
curl -fsS http://127.0.0.1:32123/api/health
```

## Rollback

1. Restaurar el proxy anterior.
2. Detener `fly-desk.service`.
3. Conservar `/var/lib/fly-desk` para no perder cache/sesiones.
4. Volver a publicar la pagina Cloudflare Pages de staging si el dominio final no esta listo.
