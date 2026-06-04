# Recuperar sesion Agil en el VPS

Este runbook cubre la recuperacion operativa cuando Agil deja de funcionar en
`fly-desk-chrome.service`, pero la sesion sigue activa en Chrome local del
mantenedor.

## Reglas

- No imprimir cookies, tokens, payloads de storage, passwords ni valores de
  `/etc/fly-desk.env`.
- No copiar el perfil Chrome completo al repo ni dejar payloads en Git.
- No reiniciar `fly-desk-chrome.service` salvo instruccion explicita; ese
  servicio mantiene el perfil Agil del VPS.
- Si se reinicia algo despues de inyectar, reiniciar solo `fly-desk.service`
  para limpiar cache de token en el proceso Bun.
- Borrar archivos temporales locales y remotos al terminar.

## Resumen del flujo

1. Confirmar que el VPS y los servicios estan activos:

   ```bash
   systemctl is-active caddy video-downloader fly-desk fly-desk-chrome fly-desk-maintenance.timer
   curl -fsS http://127.0.0.1:32123/api/health
   curl -fsS http://127.0.0.1:9222/json/version >/dev/null
   ```

2. En Windows, crear una copia temporal minima del perfil Chrome local que tiene
   la sesion Agil. Copiar solo:

   - `Local State`
   - `<profile>/Preferences`
   - `<profile>/Secure Preferences`
   - `<profile>/Network/Cookies`
   - `<profile>/Network/Cookies-journal`
   - `<profile>/Local Storage`
   - `<profile>/Session Storage`

   No sirve copiar la base de cookies al VPS: las cookies de Chrome en Windows
   estan cifradas con DPAPI y no son portables a Linux. La copia temporal se usa
   solo para que Chrome local descifre su propio estado.

3. Levantar Chrome local contra esa copia temporal con CDP en loopback y abrir
   `https://www.agilsmart.com/`. La sesion local queda confirmada si termina en
   `/home-user` y el storage de Agil contiene:

   - `tokenSearchFlight` o `tokenTravelC`
   - `user_data`
   - `ip`

4. Desde ese Chrome temporal, capturar en memoria un payload con:

   - cookies de `agilsmart.com` y `expertiatravel.com`
   - `localStorage` y `sessionStorage` de
     `https://www.agilsmart.com/home-user`
   - `localStorage` y `sessionStorage` de
     `https://motorvuelos.expertiatravel.com/`

   Guardarlo solo en un archivo temporal fuera del repo, con permisos privados.

5. Subir el payload temporal por SSH a `/tmp` en el VPS. Usar `StrictHostKeyChecking=yes`
   y `UserKnownHostsFile` pineado al almacen local de credenciales.

6. En el VPS, conectar por CDP a `http://127.0.0.1:9222` y aplicar el payload:

   - `Network.setCookies` para las cookies capturadas
   - navegar cada origen de Agil
   - ejecutar `localStorage.setItem(...)` y `sessionStorage.setItem(...)` para
     sus claves capturadas

7. Verificar en el mismo Chrome remoto:

   ```text
   https://www.agilsmart.com/ -> https://www.agilsmart.com/home-user
   ```

   Ademas, confirmar que el storage remoto tiene token, `user_data` e `ip`.

8. Reiniciar solo la app para descartar cache de sesion anterior:

   ```bash
   sudo systemctl restart fly-desk.service
   systemctl is-active fly-desk.service fly-desk-chrome.service
   ```

9. Ejecutar una busqueda desde el propio VPS contra Fly Desk. Si no hay
   `FLY_DESK_API_TOKEN`, generar una cookie web valida dentro del proceso remoto
   usando `FLY_DESK_WEB_SESSION_SECRET` cargado desde `/etc/fly-desk.env`; no
   imprimir la cookie.

   Payload minimo recomendado para smoke:

   ```json
   {
     "sortMode": "cheapest",
     "request": {
       "tripType": "one-way",
       "searchMode": "exact",
       "legs": [
         {
           "origin": "LIM",
           "destination": "MIA",
           "departureDate": "2026-06-15"
         }
       ],
       "passengers": {
         "adults": 1,
         "children": 0,
         "infants": 0
       },
       "cabin": "ECONOMY",
       "coverageMode": "core",
       "currencyCode": "USD",
       "locale": "es-PE",
       "market": "PE"
     }
   }
   ```

   La API publica siempre busca en Agil y Click and Book Plus. El criterio de exito de
   esta recuperacion es encontrar al menos una oferta con
   `providerSource = "agil-local"` en `allOffers`.

10. Limpiar temporales:

    ```bash
    rm -f /tmp/flydesk-agil-session-*.json /tmp/flydesk-inject.*.ts /tmp/flydesk-search.*.ts
    ```

    En Windows, borrar el payload local, la copia temporal del perfil Chrome y
    la copia temporal de la llave SSH si se uso una para ajustar permisos.

## Evidencia esperada

Al cerrar la recuperacion, reportar solo hechos no sensibles:

- perfil local usado, por nombre generico si hace falta, por ejemplo `Default`
- cantidad de cookies inyectadas
- cantidad de origenes de storage aplicados
- redireccion remota a `/home-user`
- estado de `fly-desk.service` y `fly-desk-chrome.service`
- resumen del smoke, por ejemplo `agilOfferCount=228`

No reportar valores de cookies, tokens, storage, headers, passwords ni contenido
de archivos `.env`.
