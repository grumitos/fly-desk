# Click and Book Plus Token

Click and Book Plus searches and branded purchase links need a branded JWT that
belongs to `CBPLUS_TERMINAL_ID` and lives about an hour. This runbook explains
where the token comes from, how to tell when it is missing, and how to recover.

## How the token reaches Fly Desk

- The token is minted outside the application by the platform renewer (the VPS
  primary, with the operator PC as coordinated fallback) and installed by
  `vps-platform-fly-cbplus-token`. Schedule, lease, review and journal are
  documented in `vps-platform/docs/OPERATIONS.md`, "Click and Book token
  renewal".
- The installer writes `/etc/fly-desk.cbplus-token` and sets `CBPLUS_TOKEN` and
  `CBPLUS_TOKEN_FILE` in `/etc/fly-desk.env`.
- Every Fly Desk process that talks to Click and Book Plus (the search runner,
  its workers and the redirect service) re-reads the file named by
  `CBPLUS_TOKEN_FILE` when its modification time or size changes, so a renewal
  needs no restart. `CBPLUS_TOKEN` is the fallback while the file is absent or
  empty.
- `src/provider-context.ts` accepts a token only when it is a well-formed,
  unexpired JWT for the configured terminal; anything else is treated as
  missing.

## Symptoms

- Searches return Agilsmart results only, and the results notice names Click and
  Book Plus as the provider that failed.
- Click and Book Plus purchase links answer with the blocked page instead of a
  `302`.

Confirm from the host with the daily `ops` wrapper, reading status only:

```bash
sudo -n journalctl -t vps-platform-fly-cbplus-token --since '2 hours ago' --no-pager
```

A healthy host shows an accepted install every twenty minutes or so. Then run
`Fly Desk Production Smoke` in `vps-platform`: it requires Click and Book Plus
offers and a validated `/r/<id>` redirect.

## Recovery

1. Restore the renewer first. Its runbooks (`vps-platform/docs/OPERATIONS.md`
   and `CLICK_AND_BOOK_RENEWER_VPS_MIGRATION_RUNBOOK.md`) cover the lease, the
   PC fallback and a manual portal sign-in.
2. Once an install is accepted, nothing else is needed: the running processes
   pick up the new file. If the journal reports that the units were restarted
   instead, the active release or the running units predate the token file;
   that is expected only after a rollback.
3. Verify with the production smoke.

Do not copy a token, a Chrome profile, a cookie database or the session SQLite
database from another host or from a backup. A token is ephemeral credential
material and a copied one proves nothing about the next renewal.

## In-application fallback

When no usable token is configured, the runtime can obtain one from the
Click and Book B2B site (`b2b.clickandbook.com`, HTTPS only, exact origin) using
`CBPLUS_B2B_EMAIL`, `CBPLUS_B2B_PASSWORD` and a TOTP source
(`CBPLUS_B2B_TOTP_SECRET` in Base32, `otpauth://`, `otpauth-migration://` or JSON
with `totpUri`). It tries plain HTTP first and, only with
`CBPLUS_B2B_PLAYWRIGHT_FALLBACK_ENABLED=1`, drives the platform Chrome
(`fly-desk-chrome.service`, CDP on loopback) with Playwright. The flow keeps
cookies in memory, re-checks the origin before entering credentials or a code,
and never persists the resolved token.

| Setting | Effect |
| --- | --- |
| `CBPLUS_B2B_AUTOMATION_ENABLED` | Allows the B2B sign-in at all |
| `CBPLUS_SESSION_WARMUP_ENABLED` | Allows warm-up to request a token before a search needs it |
| `CBPLUS_B2B_PLAYWRIGHT_FALLBACK_ENABLED` | Allows the browser path when HTTP cannot finish the sign-in |
| `CBPLUS_B2B_USE_LIVE_BROWSER` | Uses the platform Chrome instead of a temporary browser |
| `CBPLUS_CDP_TAB_SCAN_ENABLED` | Lets the runtime read branded URLs from open Chrome tabs |
| `CBPLUS_B2B_CLONE_CHROME_PROFILE` | Must stay `0`; a cloned profile is never the source of truth |
| `CBPLUS_B2B_DEBUG` | Must stay `0` in production |

The provider may refuse the branded-token origin from the VPS network, which is
why the renewer exists; treat this path as a diagnostic fallback, not as the
normal source.

## Security rules

- Never print, log or paste credentials, TOTP values, cookies, JWTs,
  authorization headers or `.env` values.
- Check environment keys by presence only, through the platform's private
  procedure.
- A Click and Book Plus `Location` header carries the token in its query string:
  report only the status code and the destination host.
- Keep CDP on loopback; never expose port `9222` or tunnel it.
- Do not restart `fly-desk-chrome.service` as part of this recovery.
- Safe report fields are presence booleans, states, counts, stage names and
  HTTP status codes.
