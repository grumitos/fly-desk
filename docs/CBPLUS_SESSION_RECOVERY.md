# Recuperar Click and Book Plus sin migrar una sesion

Este runbook cubre la preparacion y recuperacion de Click and Book Plus en un
host nuevo. La estrategia normal es regenerar el token branded desde
credenciales B2B y TOTP almacenados de forma segura. La extraccion logica desde
Chrome/CDP queda reservada como fallback controlado.

No se debe copiar el perfil Chrome, la base de cookies, una SQLite de sesiones
ni `CBPLUS_TOKEN` desde el VPS anterior. Esos artefactos son estado efimero,
pueden contener tokens o rutas de compra y no demuestran que la autenticacion
sea reproducible en el host nuevo.

## Decision operativa

El orden de recuperacion es obligatorio:

1. regeneracion HTTP desde `CBPLUS_B2B_EMAIL`, `CBPLUS_B2B_PASSWORD` y una
   fuente TOTP;
2. automatizacion Playwright sobre el Chrome/CDP del host nuevo, sin clonar un
   perfil, solo si el flujo HTTP no puede completar el login vigente;
3. bloqueo y diagnostico si ninguno de los dos flujos produce un token valido.

`src/local-costamar.ts` intenta el flujo HTTP antes de Playwright. El login
mantiene cookies solo en memoria, genera el OTP en el momento y solicita un
token para `CBPLUS_TERMINAL_ID`. `src/provider-context.ts` descarta tokens
vencidos o asociados a otro terminal. El identificador interno `costamar` se
conserva por compatibilidad; una instalacion nueva debe usar variables
`CBPLUS_*`, no introducir nuevas dependencias de `COSTAMAR_*`.

## Reglas de seguridad

- No imprimir, registrar, pegar en comandos ni incluir en tickets valores de
  credenciales, TOTP, cookies, JWT, cabeceras de autorizacion o `.env`.
- No establecer `CBPLUS_TOKEN` como secreto permanente en el host nuevo. Debe
  quedar ausente para probar que la regeneracion funciona.
- No copiar `/etc/fly-desk.env`, `/var/lib/fly-desk`, el perfil de
  `fly-desk-chrome.service` ni archivos bajo `/tmp` desde Hetzner.
- No usar `rsync`, `scp` ni un tar para trasladar un perfil Chrome completo o
  parcial. Las cookies de otro host no son la fuente de verdad.
- Mantener `CBPLUS_B2B_DEBUG=0`; los diagnosticos normales exponen estados y
  conteos suficientes.
- Mantener `CBPLUS_B2B_CLONE_CHROME_PROFILE=0`, incluso durante el fallback.
- El acceso CDP debe seguir en loopback. No publicar `9222` ni crear un tunel
  compartido para facilitar la recuperacion.
- No mostrar una cabecera `Location` de Click and Book Plus: puede contener el
  token en la URL. Reportar solo estado HTTP y host de destino permitido.
- No reiniciar ni reemplazar `fly-desk-chrome.service` durante el camino normal.

## Precondiciones

Antes de intentar la recuperacion:

- el release que se va a operar esta activo en el host nuevo;
- `fly-desk.service`, `fly-desk-search.service` y
  `fly-desk-redirect.service` responden en loopback;
- `/etc/fly-desk.env` fue reconstruido desde el almacen de secretos canonico,
  no copiado del VPS anterior;
- estan presentes `CBPLUS_TERMINAL_ID`, `CBPLUS_B2B_EMAIL` y
  `CBPLUS_B2B_PASSWORD`;
- esta presente exactamente una fuente TOTP operativa:
  `CBPLUS_B2B_TOTP_SECRET` o `CBPLUS_B2B_TOTP_URI`;
- el reloj del host esta sincronizado; un desfase puede invalidar cada OTP;
- `CBPLUS_B2B_AUTOMATION_ENABLED=1`,
  `CBPLUS_SESSION_WARMUP_ENABLED=1` y
  `CBPLUS_B2B_CLONE_CHROME_PROFILE=0`;
- `CBPLUS_B2B_PLAYWRIGHT_FALLBACK_ENABLED=0` y
  `CBPLUS_CDP_TAB_SCAN_ENABLED=0` durante la primera prueba, para demostrar que
  el host no depende de una sesion de navegador previa.

No comprobar estas variables con `cat`, `grep` o `systemctl show` si la salida
puede incluir valores. La comprobacion debe limitarse a presencia/ausencia y
realizarse mediante el procedimiento privado de secretos de plataforma.

## Camino normal: regeneracion desde credenciales y TOTP

1. Confirmar que `CBPLUS_TOKEN` y el fallback `COSTAMAR_TOKEN` estan ausentes.
   Si existian, retirarlos mediante el flujo seguro de configuracion; no
   conservar una copia temporal.

2. Reiniciar los procesos que leen `/etc/fly-desk.env`, sin tocar Chrome:

   ```bash
   sudo systemctl restart fly-desk-search.service
   sudo systemctl restart fly-desk-redirect.service
   sudo systemctl restart fly-desk.service
   systemctl is-active fly-desk.service fly-desk-search.service fly-desk-redirect.service
   ```

3. Ejecutar `Fly Desk Production Smoke` desde `vps-platform`. La primera
   busqueda fuerza al runner a obtener contexto Click and Book Plus y, al no
   encontrar un token persistido, activa la regeneracion B2B. El smoke espera
   la finalizacion, exige purchase paths para Agil y Click and Book Plus y
   resuelve `/r/*` sin publicar la URL externa sensible.

4. Despues de la busqueda, consultar desde loopback el endpoint de estado del
   runner:

   ```text
   http://127.0.0.1:8101/api/costamar/token-status?verify=true
   ```

   La respuesta no contiene el token, pero no debe copiarse completa. Registrar
   solo `tokenUsable` y `verification.valid`. Esta comprobacion complementa el
   smoke: valida compatibilidad local y alcance del upstream, pero no demuestra
   por si sola que el redirect branded acepte el token.

5. Considerar regenerado el token solo si se cumplen en la misma ejecucion:

   - la busqueda termina;
   - existe al menos una oferta con `providerSource = "costamar"`;
   - existe un purchase path Click and Book Plus bajo `/r/<id>`;
   - el resolver responde `302` hacia un host branded permitido;
   - el destino no es una pagina de login, autenticacion o error;
   - los tres servicios siguen activos.

6. Reiniciar otra vez `fly-desk-search.service` y
   `fly-desk-redirect.service`, repetir el smoke y exigir el mismo resultado.
   Esta segunda pasada prueba regeneracion despues de perder el estado solo en
   memoria; no basta con reutilizar el token de la primera busqueda.

`CBPLUS_PROVIDER_B2B_PREWARM_ENABLED` puede habilitarse despues de esta prueba
si se desea renovar antes del primer click. No es requisito para la migracion y
no debe sustituir el smoke externo.

## Fallback: automatizacion logica sobre Chrome/CDP

Usar este camino solo si el proveedor cambio el login de modo que el flujo HTTP
no puede completarlo, pero las credenciales y el TOTP siguen siendo validos.
Debe operar exclusivamente sobre `fly-desk-chrome.service` del host nuevo.

1. Mantener las credenciales/TOTP configuradas y habilitar de forma temporal:

   ```text
   CBPLUS_B2B_PLAYWRIGHT_FALLBACK_ENABLED=1
   CBPLUS_B2B_USE_LIVE_BROWSER=1
   CBPLUS_CDP_TAB_SCAN_ENABLED=1
   CBPLUS_B2B_CLONE_CHROME_PROFILE=0
   ```

2. Configurar `CBPLUS_CHROME_USER_DATA_DIR` y `CBPLUS_CHROME_PROFILE` para el
   perfil ya administrado por `fly-desk-chrome.service` en el host nuevo. No
   apuntarlos a un staging, mount o copia procedente de Hetzner.

3. Reiniciar runner y redirect, no Chrome. Ejecutar una busqueda controlada o
   el smoke de produccion. Playwright se conecta por CDP al browser existente,
   completa el login y observa solamente paginas/respuestas de hosts permitidos
   para capturar un candidato compatible.

4. Exigir los mismos criterios de busqueda y redirect del camino normal. La
   presencia de una pestaña autenticada no es evidencia suficiente.

5. Si el fallback queda como operacion estable, documentar el motivo y mantener
   CDP en loopback. Si solo fue diagnostico, volver a
   `CBPLUS_B2B_PLAYWRIGHT_FALLBACK_ENABLED=0` y
   `CBPLUS_CDP_TAB_SCAN_ENABLED=0`, reiniciar los procesos y repetir el camino
   normal.

El runtime puede inspeccionar artefactos que ya pertenezcan al perfil local
configurado para recuperar URLs branded recientes. Eso no autoriza copiar
archivos de sesion, History, Favicons o Cookies desde otro host.

## Diagnostico sin exponer secretos

Clasificar el fallo antes de repetir intentos:

| Estado observable | Interpretacion | Accion |
| --- | --- | --- |
| `tokenUsable=false` | falta token, expiro o no coincide con el terminal | revisar presencia de credenciales/TOTP, reloj y terminal; no copiar un JWT viejo |
| OTP generado, sin token capturado | el login o el endpoint B2B cambio | habilitar temporalmente el fallback CDP y revisar solo nombres de etapas/estado HTTP |
| busqueda `401` o `402` | el proveedor rechazo el token de busqueda | forzar una regeneracion; bloquear si vuelve a ocurrir |
| busqueda con ofertas, redirect bloqueado | el JWT no fue aceptado por el branded flow | usar `/r/*` como evidencia y diagnosticar refresh/terminal; no entregar enlaces directos |
| timeout o upstream inaccesible | no se puede distinguir red de autenticacion | comprobar DNS, TLS y reachability; no declarar recuperada la sesion |

Los campos seguros para un informe son booleanos de presencia, estados,
conteos, nombres de etapas y codigos HTTP. No incluir `terminalId`, timestamps de
token, URLs completas, cuerpos de proveedor ni contenido de
`lastWarmup.failureReason` si incorpora datos externos.

## Limpieza

Al terminar, exitoso o no:

1. deshabilitar flags temporales de fallback que no formen parte del diseño
   final;
2. comprobar mediante `/api/diagnostics` que no quedaron artefactos temporales
   activos de Click and Book Plus;
3. ejecutar la rutina de mantenimiento de plataforma si existen artefactos
   obsoletos `travel_quote_foundation_costamar_*` o
   `travel_quote_foundation_costamar_browser_*`; no abrirlos ni archivarlos;
4. confirmar que no se crearon `.env`, payloads, perfiles, cookies o tokens en
   el repo, el home de `ops` o `/tmp`;
5. conservar en `/var/lib/fly-desk` solo el estado generado por el host nuevo y
   sujeto al TTL de la aplicacion.

No migrar la SQLite de sesiones para preservar redirects antiguos: los precios
y purchase paths son efimeros y deben reconstruirse mediante una busqueda
nueva.

## Puerta para eliminar Hetzner

Click and Book Plus bloquea la eliminacion del VPS anterior mientras falte
cualquiera de estas evidencias:

- las credenciales B2B y la fuente TOTP estan disponibles desde el almacen
  canonico y no existen solamente en el host viejo;
- el host nuevo regenera un token con `CBPLUS_TOKEN` ausente y sin usar una
  copia del perfil anterior;
- dos smokes consecutivos, separados por reinicio de runner/redirect, completan
  busqueda Click and Book Plus y validan su `/r/*`;
- no hay referencias desde configuracion, rutas Chrome/CDP, unidades, callbacks
  ni documentacion operativa hacia Hetzner;
- la limpieza no encuentra perfiles, cookies, payloads o tokens copiados;
- la ruta de recuperacion se ha probado con el acceso operativo del host nuevo;
- las puertas globales de Agil, las otras aplicaciones, DNS y rollback tambien
  autorizaron el retiro del VPS anterior.

Si la unica evidencia funcional sigue siendo una cookie, JWT, perfil o SQLite
del VPS viejo, la migracion esta bloqueada. No compensar esa dependencia
copiando el artefacto: recuperar primero las credenciales/TOTP o coordinar con
Click and Book Plus la restauracion del acceso.

## Evidencia de cierre

Reportar solamente:

- camino usado: `http-b2b` o `cdp-fallback`;
- `tokenUsable=true` y resultado booleano de la prevalidacion;
- busqueda completa y cantidad de ofertas Click and Book Plus;
- `/r/*` validado con `302` y host branded permitido, sin URL completa;
- estado de web/search/redirect despues de la segunda pasada;
- limpieza de temporales completada;
- decision `apto` o `bloqueado` para retirar Hetzner, con motivos no sensibles.
