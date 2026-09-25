# Agilsmart Session Recovery

Agilsmart searches need a bearer token. The runtime mints it over plain HTTP
from three account identifiers persisted in `agil-identity.json` under
`/var/lib/fly-desk` (override: `AGIL_IDENTITY_PATH`), together with
`AGIL_APIM_SUBSCRIPTION_KEY`. The browser profile of `fly-desk-chrome.service`
is consulted only to create that file when it is missing, or when the provider
refuses the persisted identity.

On Linux the runtime reaches that browser at `http://127.0.0.1:9222` unless
`AGIL_BROWSER_URL` or `AGIL_BROWSER_WS_ENDPOINT` says otherwise; Windows has no
implicit endpoint.

## Symptoms

- Searches return Click and Book Plus results only, and the results notice
  names Agilsmart as the provider that failed.
- The search runner logs `provider prewarm failed: agil-local reason=… detail=…`
  on every prewarm cycle (credential-like material in `detail` is masked).

## Preferred recovery: seed the identity file

Use this when the maintainer's own browser still has a working Agilsmart
session. No cookie or storage leaves that browser.

1. In the signed-in browser, on `https://www.agilsmart.com/home-user`, read the
   three values from `localStorage` without printing them:
   - `user_data` is base64-encoded UTF-8 JSON: `userCode` is
     `Usuario.CodigoUsuario` (a number) and `internalCode` is
     `Cliente.Vendedor.CodigoVendedor` (a string);
   - `ip` is base64-encoded text.

   Write `{"userCode":…,"internalCode":"…","ip":"…"}` to a private temporary
   file outside every repository. Make sure the tab rests on `/home-user`
   first: a page caught mid-logout has empty or foreign storage.
2. Install it through the reviewed administrative wrapper, sending the file on
   standard input to a reviewed script that validates the JSON shape and moves
   it into place as `/var/lib/fly-desk/agil-identity.json`, owner
   `fly-desk:fly-desk`, mode `0600`:

   ```powershell
   .\scripts\Invoke-VpsDeploySsh.ps1 -Command "sudo -n bash -s" -InputFile .\reviewed-install-agil-identity.sh
   ```

   The identity file travels inside the reviewed script's here-document or as
   its standard input; never as a command-line argument. Delete every local
   copy afterwards.
3. Restart `fly-desk-search.service` through `ops` so the runner discards the
   refused identity it cached.
4. Run `Fly Desk Production Smoke` in `vps-platform`; it requires offers and a
   purchase link from both providers.

## Fallback: restore the session in the VPS browser

Use this only when the provider refuses every identity and the VPS browser
needs a real Agilsmart session again.

1. On the maintainer's machine, start Chrome with a temporary copy of the
   signed-in profile (only `Local State`, `Preferences`, `Secure Preferences`,
   `Network/Cookies`, `Network/Cookies-journal`, `Local Storage` and
   `Session Storage`) and CDP bound to loopback. Chrome encrypts cookies with
   the operating system's key store, so the copy is only readable locally.
2. From that browser, capture into a private temporary file: the cookies for
   `agilsmart.com` and `expertiatravel.com`, and `localStorage` /
   `sessionStorage` of `https://www.agilsmart.com/home-user` and
   `https://motorvuelos.expertiatravel.com/`.
3. Apply it to `fly-desk-chrome.service` with a reviewed script run through
   `Invoke-VpsDeploySsh.ps1` (the payload on standard input, never an
   argument): connect to `http://127.0.0.1:9222`, call `Network.setCookies`,
   visit each origin and restore its storage keys.
4. Confirm in the same browser that `https://www.agilsmart.com/` lands on
   `/home-user` and that storage holds a token, `user_data` and `ip`.
5. Delete `/var/lib/fly-desk/agil-identity.json` through the same wrapper and
   restart `fly-desk-search.service`, so the next search mints from the
   restored session and writes a fresh identity file.
6. Run the production smoke, then delete every temporary copy on both sides.

## Rules

- Never print cookies, tokens, storage payloads or values from
  `/etc/fly-desk.env`.
- Use only the pinned wrappers; never raw `ssh`, `scp` or `sftp`.
- Do not restart `fly-desk-chrome.service`: it holds the session this runbook
  may need.
- Report only non-sensitive facts: which path was used, counts of cookies and
  storage origins applied, the landing path, service states and the smoke
  outcome.
