# Canal De Actualizaciones De Fly Desk

Este documento define como publicar una version de Fly Desk y como debe recibirla una instalacion de cliente final. La regla principal es simple: el cliente no usa Git, no inicia sesion en GitHub y no guarda credenciales del mantenedor.

## Modelo

- El codigo fuente vive en el repo privado `grumitos/fly-desk`.
- El cliente final recibe un paquete instalable, no el repo.
- El paquete se publica en un canal de updates con `latest.json` y un `.zip`.
- El launcher local consulta el manifiesto, descarga el zip, valida SHA-256 y actualiza la carpeta local.
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
- `platforms.windows-x64.url` apunta al zip correcto
- `platforms.windows-x64.sha256` coincide con el archivo descargado
- `version` es mayor que la version local
- el zip contiene `release.json`
- el zip contiene los archivos minimos de runtime

## Manifiesto

Formato esperado de `latest.json`:

```json
{
  "schemaVersion": 1,
  "appId": "fly-desk",
  "channel": "stable",
  "version": "0.2.0",
  "publishedAt": "2026-05-18T00:00:00Z",
  "platforms": {
    "windows-x64": {
      "url": "https://github.com/grumitos/fly-desk-updates/releases/download/v0.2.0/fly-desk-windows-x64-v0.2.0.zip",
      "sha256": "64 lowercase hex characters",
      "sizeBytes": 12345678
    }
  },
  "minimumLauncherVersion": "1.0.0",
  "notes": "Resumen corto para soporte."
}
```

## Contenido Del Zip

El zip debe extraer una carpeta raiz `fly-desk/`:

```text
fly-desk/
  Abrir Fly Desk.vbs
  Cerrar Fly Desk.vbs
  Abrir Fly Desk.ico
  VERSION
  release.json
  bin/
    fly-desk.exe
  frontend/
    dist/
      index.html
      assets/
  tools/
    start-fly-desk.ps1
    stop-fly-desk.ps1
    update-fly-desk.ps1
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
```

## Archivos Locales Que Se Conservan

El receptor debe conservar estos paths en la maquina del cliente:

```text
.env
.launcher/
output/
artifacts/
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
5. Publicar el zip en el canal de updates.
6. Publicar o actualizar `latest.json`.
7. Descargar el manifiesto publicado y verificar que apunta al zip nuevo.
8. Probar una instalacion limpia o temporal antes de avisar al cliente.

## Flujo De Recepcion

Cuando el cliente abre Fly Desk:

1. `Abrir Fly Desk.vbs` ejecuta `tools/start-fly-desk.ps1`.
2. El launcher detecta si la instalacion tiene `release.json`.
3. Si es instalacion de cliente final, ejecuta el updater.
4. El updater descarga `latest.json`.
5. Si la version remota no es mayor, abre la app local.
6. Si hay version nueva, descarga el zip.
7. Verifica SHA-256.
8. Detiene Fly Desk si esta corriendo.
9. Extrae en staging bajo `.launcher/`.
10. Reemplaza solo archivos de runtime.
11. Conserva `.env`, caches, logs y estado local.
12. Relanza Fly Desk.

## Compatibilidad

Para no romper instalaciones existentes:

- cambios al formato de `latest.json` requieren incrementar `schemaVersion`
- cambios obligatorios del launcher requieren subir `minimumLauncherVersion`
- el updater debe tratar campos desconocidos como opcionales
- el emisor nunca debe publicar un zip cuyo contenido no coincida con el SHA-256 del manifiesto
- el receptor nunca debe instalar un zip sin hash valido
- una version publicada no debe reutilizarse con otro zip distinto

## Rollback

Antes de reemplazar archivos, el receptor debe crear un backup local en `.launcher/backup-before-<version>`. Si el reemplazo falla, restaura ese backup y abre la version anterior.

Si una version mala ya fue publicada, el emisor debe publicar una version mayor que corrija el problema. No se debe modificar silenciosamente el zip de una version ya publicada.

## Primer Canal Recomendado

Para empezar:

- repo privado de source: `grumitos/fly-desk`
- repo publico de updates: `grumitos/fly-desk-updates`
- manifest publico: `https://raw.githubusercontent.com/grumitos/fly-desk-updates/main/latest.json`

Si luego se necesita restringir descargas, se mantiene el mismo contrato y se cambia solo la fuente del `url`: un endpoint propio puede validar licencia y devolver una URL temporal.
