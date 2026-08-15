# Recovering an Agil Session on the VPS

This runbook covers operational recovery when Agil stops working in `fly-desk-chrome.service` but the session remains active in the maintainer's local Chrome browser.

Click and Book Plus does not use this procedure: its token must be regenerated from credentials/TOTP, with Chrome/CDP used only as a fallback. See [`CBPLUS_SESSION_RECOVERY.md`](./CBPLUS_SESSION_RECOVERY.md).

On Linux, the runtime uses `http://127.0.0.1:9222` when neither
`AGIL_BROWSER_URL` nor `AGIL_BROWSER_WS_ENDPOINT` is set. This matches
`fly-desk-chrome.service` on the VPS. An explicit endpoint still wins; Windows
does not receive this implicit fallback.

## Identity-File Shortcut (preferred)

Since fly-desk PR #52 the runtime mints its Agil bearer over plain HTTP from
three account identifiers persisted in `agil-identity.json` under
`/var/lib/fly-desk` (path override: `AGIL_IDENTITY_PATH`). The browser session
is only the bootstrap source for that file. If the VPS profile lost its session
but the maintainer's local browser still has one, seeding the file directly is
enough — no cookie or storage transplant.

1. In the logged-in local browser, on `https://www.agilsmart.com/home-user`,
   derive the three values from `localStorage` without printing them:
   `user_data` is base64-encoded UTF-8 JSON (`userCode` =
   `Usuario.CodigoUsuario`, a number; `internalCode` =
   `Cliente.Vendedor.CodigoVendedor`, a string) and `ip` is base64-encoded
   text. Save `{"userCode":…,"internalCode":"…","ip":"…"}` to a private
   temporary file only. A page opened mid-logout has an empty or foreign-origin
   `localStorage`; confirm the tab rests on `/home-user` first.
2. Install it on the VPS through the reviewed deploy wrapper as
   `/var/lib/fly-desk/agil-identity.json`, owner `fly-desk:fly-desk`, mode
   `0600`, validating the JSON shape before the move. Delete every local and
   staged copy afterward.
3. Restart `fly-desk-search.service`, then `fly-desk.service` (step 8 below).
4. Verify: the startup provider prewarm logs
   `provider prewarm skipped … agil-local` only on failure, so silence is
   success; then run `Fly Desk Production Smoke` in `vps-platform`, which
   requires a purchase link from both providers.

This shortcut was validated in production on 2026-08-15: a search that
returned Click and Book Plus offers alone recovered to both providers with no
Chrome interaction. The full session transplant below remains the fallback
when identity minting itself is refused and the VPS browser needs a real
session again.

## Rules

- Do not print cookies, tokens, storage payloads, passwords, or values from `/etc/fly-desk.env`.
- Do not copy the complete Chrome profile into the repository or leave payloads in Git.
- Do not restart `fly-desk-chrome.service` unless explicitly instructed; that service maintains the Agil profile on the VPS.
- If anything is restarted after injection, restart `fly-desk-search.service` when it exists, then restart `fly-desk.service`. This clears the token cache in the Bun processes without touching Chrome.
- Delete local and remote temporary files when finished.

## Procedure Summary

1. Confirm that the VPS and services are active:

   ```bash
   systemctl is-active caddy video-downloader fly-desk fly-desk-search fly-desk-chrome fly-desk-maintenance.timer
   curl -fsS http://127.0.0.1:8100/api/health
   curl -fsS http://127.0.0.1:9222/json/version >/dev/null
   ```

2. On Windows, create a minimal temporary copy of the local Chrome profile that holds the Agil session. Copy only:

   - `Local State`
   - `<profile>/Preferences`
   - `<profile>/Secure Preferences`
   - `<profile>/Network/Cookies`
   - `<profile>/Network/Cookies-journal`
   - `<profile>/Local Storage`
   - `<profile>/Session Storage`

   Copying the cookie database to the VPS will not work: Chrome cookies on Windows are encrypted with DPAPI and are not portable to Linux. The temporary copy is used only so local Chrome can decrypt its own state.

3. Start local Chrome against that temporary copy with CDP bound to loopback, then open `https://www.agilsmart.com/`. The local session is confirmed if the browser reaches `/home-user` and Agil storage contains:

   - `tokenSearchFlight` or `tokenTravelC`
   - `user_data`
   - `ip`

4. From that temporary Chrome instance, capture an in-memory payload containing:

   - cookies for `agilsmart.com` and `expertiatravel.com`
   - `localStorage` and `sessionStorage` from `https://www.agilsmart.com/home-user`
   - `localStorage` and `sessionStorage` from `https://motorvuelos.expertiatravel.com/`

   Save it only to a private temporary file outside the repository.

5. Upload the temporary payload over SSH to `/tmp` on the VPS. Use `StrictHostKeyChecking=yes` and a `UserKnownHostsFile` pinned to the local credential store.

6. On the VPS, connect through CDP to `http://127.0.0.1:9222` and apply the payload:

   - use `Network.setCookies` for the captured cookies
   - navigate to each Agil origin
   - run `localStorage.setItem(...)` and `sessionStorage.setItem(...)` for the captured keys

7. Verify in the same remote Chrome instance:

   ```text
   https://www.agilsmart.com/ -> https://www.agilsmart.com/home-user
   ```

   Also confirm that remote storage contains a token, `user_data`, and `ip`.

8. Restart only the Fly Desk application/runner to discard the previous session cache:

   ```bash
   if systemctl cat fly-desk-search.service >/dev/null 2>&1; then
     sudo systemctl restart fly-desk-search.service
   fi
   sudo systemctl restart fly-desk.service
   systemctl is-active fly-desk.service fly-desk-chrome.service
   if systemctl cat fly-desk-search.service >/dev/null 2>&1; then
     systemctl is-active fly-desk-search.service
   fi
   ```

9. Run a search from the VPS against Fly Desk. If `FLY_DESK_API_TOKEN` is unavailable, generate a valid web cookie within the remote process using `FLY_DESK_WEB_SESSION_SECRET` loaded from `/etc/fly-desk.env`; do not print the cookie.

   Recommended minimal smoke payload:

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
           "departureDate": "YYYY-MM-DD"
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

   Replace `YYYY-MM-DD` with a valid future departure date before running the smoke.

   The public API always searches both Agil and Click and Book Plus. Recovery succeeds when `allOffers` contains at least one offer with `providerSource = "agil-local"`.

10. Remove temporary files:

    ```bash
    rm -f /tmp/flydesk-agil-session-*.json /tmp/flydesk-inject.*.ts /tmp/flydesk-search.*.ts
    ```

    On Windows, delete the local payload, the temporary Chrome profile copy, and any temporary SSH key copy created to adjust permissions.

## Expected Evidence

At the end of recovery, report only non-sensitive facts:

- the local profile used, with a generic name if necessary, such as `Default`
- number of injected cookies
- number of storage origins applied
- remote redirection to `/home-user`
- status of `fly-desk.service`, `fly-desk-search.service` when it exists, and `fly-desk-chrome.service`
- a smoke summary, such as `agilOfferCount=228`

Do not report cookie or token values, storage, headers, passwords, or contents of `.env` files.
