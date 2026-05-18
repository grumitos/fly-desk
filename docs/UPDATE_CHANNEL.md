# Canal De Actualizaciones De Fly Desk

Este documento define como publicar una version de Fly Desk y como debe recibirla una instalacion de cliente final. La regla principal es simple: el cliente no usa Git, no inicia sesion en GitHub y no guarda credenciales del mantenedor.

El plan implementable vive en [`../AUTOUPDATE_PLAN.md`](../AUTOUPDATE_PLAN.md), el runbook operativo vive en [`../AUTOUPDATE_RUNBOOK.md`](../AUTOUPDATE_RUNBOOK.md), y el flujo seguro con VPS vive en [`../VPS_UPDATE_CHANNEL.md`](../VPS_UPDATE_CHANNEL.md).

## Modelo

- El codigo fuente vive en el repo privado `grumitos/fly-desk`.
- El cliente final recibe un paquete instalable, no el repo.
- El paquete se publica en el VPS de updates con `latest.json` y un `.zip`.
- Cada instalacion de cliente usa su propio token de update.
- El launcher local consulta el manifiesto, descarga el zip, valida SHA-256 y activa una release bajo `app/releases/<version>/`.
- La carpeta y el acceso directo se mantienen: `C:\fly-desk` y `Abrir Fly Desk.vbs`.

## Contrato Envio-Recepcion

Quien envia una version debe publicar dos cosas compatibles entre si:

```text
latest.json
fly-desk-windows-x64-vX.Y.Z.zip
```

Quien recibe una version solo debe aceptar el zip si:

- `latest.json` usa `schemaVersion: 1`
- `appId` es `fly-desk`
- `package.platform` es `windows-x64`
- `package.url` apunta al zip correcto
- `package.sha256` coincide con el archivo descargado
- `version` es mayor que la version local
- el zip contiene `release.json`
- el zip contiene los archivos minimos de runtime
- la release nueva responde `/api/health` antes de quedar como ultima version buena

## Manifiesto

Formato esperado de `latest.json`:

```json
{
  "schemaVersion": 1,
  "appId": "fly-desk",
  "channel": "stable",
  "version": "0.2.0",
  "publishedAt": "2026-05-18T00:00:00Z",
  "package": {
    "platform": "windows-x64",
    "url": "https://updates.example.com/fly-desk/releases/0.2.0/fly-desk-windows-x64-v0.2.0.zip",
    "sha256": "64 lowercase hex characters",
    "sizeBytes": 12345678
  },
  "receipts": {
    "enabled": true,
    "url": "https://updates.example.com/fly-desk/receipts"
  },
  "minimumBootstrapVersion": "1.0.0",
  "notes": "Resumen corto para soporte."
}
```

## Contenido Del Zip

El zip debe extraer una carpeta raiz `fly-desk-release/` que luego el updater mueve a `app/releases/<version>/`:

```text
fly-desk-release/
  release.json
  bin/
    fly-desk.exe
  frontend/
    dist/
      index.html
      assets/
```

El zip no debe incluir:

```text
.git/
.env
src/
test/
node_modules/
output/
.launcher/
tools/
Abrir Fly Desk.vbs
Cerrar Fly Desk.vbs
```

## Archivos Locales Que Se Conservan

El receptor debe conservar estos paths en la maquina del cliente:

```text
.env
.launcher/
output/
artifacts/
app/releases/<version anterior>/
```

Estos archivos pertenecen a la instalacion local, no al paquete publicado.

## Flujo De Publicacion

1. Actualizar `version` en `package.json`.
2. Ejecutar verificacion local:

```powershell
bun run typecheck
bun run lint
bun run build
bun run test
```

3. Generar el paquete de release.
4. Calcular SHA-256 del zip.
5. Subir el zip al VPS de updates.
6. Publicar o actualizar `latest.json`.
7. Descargar el manifiesto desde el VPS usando un token de prueba.
8. Descargar el zip desde el VPS usando el mismo token.
9. Verificar SHA-256.
10. Probar una instalacion limpia o temporal antes de avisar al cliente.

## Flujo De Recepcion

Cuando el cliente abre Fly Desk:

1. `Abrir Fly Desk.vbs` ejecuta el bootstrap `tools/start-fly-desk.ps1`.
2. El bootstrap lee `app/current.json`.
3. El bootstrap ejecuta el updater salvo que `FLY_DESK_SKIP_SELF_UPDATE=1`.
4. El updater descarga `latest.json` desde el VPS usando `X-FlyDesk-Update-Token`.
5. Si la version remota no es mayor, abre la app local.
6. Si hay version nueva, descarga el zip desde el VPS usando el mismo token.
7. Verifica SHA-256.
8. Extrae en staging bajo `.launcher/`.
9. Valida `release.json`, `bin/fly-desk.exe` y `frontend/dist/index.html`.
10. Mueve la release a `app/releases/<version>/`.
11. Cambia `app/current.json`.
12. Arranca la nueva version y espera `/api/health`.
13. Si responde sano, actualiza `.launcher/last-known-good.json`.
14. Si falla, restaura `app/current.json` a la ultima version buena.
15. Envia o encola un receipt de resultado.

## Compatibilidad

Para no romper instalaciones existentes:

- cambios al formato de `latest.json` requieren incrementar `schemaVersion`
- cambios obligatorios del bootstrap requieren subir `minimumBootstrapVersion`
- el updater debe tratar campos desconocidos como opcionales
- el emisor nunca debe publicar un zip cuyo contenido no coincida con el SHA-256 del manifiesto
- el receptor nunca debe instalar un zip sin hash valido
- una version publicada no debe reutilizarse con otro zip distinto

## Rollback Y Receipts

El rollback debe ser por puntero:

- `app/current.json` apunta a la version activa
- `.launcher/last-known-good.json` apunta a la ultima version que paso `/api/health`
- si la nueva version falla, el updater vuelve a apuntar `current.json` a `last-known-good.json`

Para saber remotamente que una actualizacion llego correctamente, no basta con saber que el zip se descargo. El updater debe enviar un receipt `health_ok` despues de que la version nueva responda `/api/health`. Si no hay red, guarda el receipt en `.launcher/receipts/pending/` y lo reintenta al proximo arranque.

Si una version mala ya fue publicada, el emisor debe publicar una version mayor que corrija el problema. No se debe modificar silenciosamente el zip de una version ya publicada.

## Canal Recomendado Con VPS

Para empezar:

- repo privado de source: `grumitos/fly-desk`
- GitHub Actions construye y sube el zip al VPS
- manifest privado via VPS: `https://updates.example.com/fly-desk/latest.json`
- zip privado via VPS: `https://updates.example.com/fly-desk/releases/<version>/<zip>`
- receipts via VPS: `https://updates.example.com/fly-desk/receipts`

El repo publico de updates queda como fallback, no como flujo preferido. Si se usa fallback publico, el contrato no cambia; solo cambian `package.url` y `receipts.url`.
