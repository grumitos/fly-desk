# Recovering Click and Book Plus Without Migrating a Session

This runbook covers preparing and recovering Click and Book Plus on a new host. The normal strategy is to regenerate the branded token from securely stored B2B credentials and TOTP. Logical extraction through Chrome/CDP is reserved as a controlled fallback.

Do not copy the Chrome profile, cookie database, session SQLite database, or `CBPLUS_TOKEN` from the previous VPS. These artifacts are ephemeral state, may contain tokens or purchase paths, and do not prove that authentication is reproducible on the new host.

## Operational Decision

The recovery order is mandatory:

1. HTTP regeneration from `CBPLUS_B2B_EMAIL`, `CBPLUS_B2B_PASSWORD`, and a TOTP source;
2. Playwright automation against Chrome/CDP on the new host, without cloning a profile, only if the HTTP flow cannot complete the current login;
3. block and diagnose if neither flow produces a valid token.

`src/local-costamar.ts` tries the HTTP flow before Playwright. Login keeps cookies only in memory, generates the OTP when needed, and requests a token for `CBPLUS_TERMINAL_ID`. `src/provider-context.ts` rejects expired tokens and tokens associated with a different terminal. The internal `costamar` identifier remains for compatibility; a new installation must use `CBPLUS_*` variables rather than introduce new dependencies on `COSTAMAR_*`.

## Security Rules

- Do not print, log, paste into commands, or include in tickets any credentials, TOTP values, cookies, JWTs, authorization headers, or `.env` values.
- Do not set `CBPLUS_TOKEN` as a permanent secret on the new host. It must remain absent to prove regeneration works.
- Do not copy `/etc/fly-desk.env`, `/var/lib/fly-desk`, the `fly-desk-chrome.service` profile, or files under `/tmp` from Hetzner.
- Do not use `rsync`, `scp`, or a tar archive to move a complete or partial Chrome profile. Cookies from another host are not the source of truth.
- Keep `CBPLUS_B2B_DEBUG=0`; normal diagnostics expose sufficient states and counts.
- Keep `CBPLUS_B2B_CLONE_CHROME_PROFILE=0`, including during fallback.
- CDP access must remain on loopback. Do not expose port `9222` or create a shared tunnel to simplify recovery.
- Do not display a Click and Book Plus `Location` header: it may contain the token in the URL. Report only the HTTP status and the allowed destination host.
- Do not restart or replace `fly-desk-chrome.service` during the normal path.

## Preconditions

Before attempting recovery:

- the release to be operated is active on the new host;
- `fly-desk.service`, `fly-desk-search.service`, and `fly-desk-redirect.service` respond on loopback;
- `/etc/fly-desk.env` was reconstructed from the canonical secret store, not copied from the previous VPS;
- `CBPLUS_TERMINAL_ID`, `CBPLUS_B2B_EMAIL`, and `CBPLUS_B2B_PASSWORD` are present;
- exactly one working TOTP source is present: `CBPLUS_B2B_TOTP_SECRET` or `CBPLUS_B2B_TOTP_URI`;
- the host clock is synchronized, because drift can invalidate every OTP;
- `CBPLUS_B2B_AUTOMATION_ENABLED=1`, `CBPLUS_SESSION_WARMUP_ENABLED=1`, and `CBPLUS_B2B_CLONE_CHROME_PROFILE=0`;
- `CBPLUS_B2B_PLAYWRIGHT_FALLBACK_ENABLED=0` and `CBPLUS_CDP_TAB_SCAN_ENABLED=0` during the first test, proving that the host does not depend on an existing browser session.

Do not check these variables with `cat`, `grep`, or `systemctl show` if the output could include values. Limit the check to presence or absence and perform it through the platform's private secret procedure.

## Normal Path: Regeneration From Credentials and TOTP

1. Confirm that `CBPLUS_TOKEN` and its `COSTAMAR_TOKEN` fallback are absent. If they existed, remove them through the secure configuration flow; do not retain a temporary copy.

2. Restart the processes that read `/etc/fly-desk.env`, without touching Chrome:

   ```bash
   sudo systemctl restart fly-desk-search.service
   sudo systemctl restart fly-desk-redirect.service
   sudo systemctl restart fly-desk.service
   systemctl is-active fly-desk.service fly-desk-search.service fly-desk-redirect.service
   ```

3. Run `Fly Desk Production Smoke` from `vps-platform`. The first search forces the runner to obtain Click and Book Plus context and, because no persisted token is present, triggers B2B regeneration. The smoke waits for completion, requires purchase paths for Agil and Click and Book Plus, and resolves `/r/*` without exposing the sensitive external URL.

4. After the search, query the runner status endpoint over loopback:

   ```text
   http://127.0.0.1:8101/api/costamar/token-status?verify=true
   ```

   The response does not contain the token, but it still must not be copied in full. Record only `tokenUsable` and `verification.valid`. This check complements the smoke: it validates local compatibility and upstream scope, but does not prove by itself that the branded redirect accepts the token.

5. Consider the token regenerated only when all of the following hold in the same run:

   - the search completes;
   - at least one offer has `providerSource = "costamar"`;
   - a Click and Book Plus purchase path exists under `/r/<id>`;
   - the resolver returns `302` to an allowed branded host;
   - the destination is not a login, authentication, or error page;
   - all three services remain active.

6. Restart `fly-desk-search.service` and `fly-desk-redirect.service` again, repeat the smoke, and require the same result. This second pass proves regeneration after losing in-memory-only state; reusing the first search's token is not sufficient.

`CBPLUS_PROVIDER_B2B_PREWARM_ENABLED` may be enabled after this test to renew the token before the first click. It is not required for migration and must not replace the external smoke.

## Fallback: Logical Automation Through Chrome/CDP

Use this path only if the provider changed the login so that the HTTP flow cannot complete it, while the credentials and TOTP remain valid. It must operate exclusively against `fly-desk-chrome.service` on the new host.

1. Keep credentials/TOTP configured and temporarily enable:

   ```text
   CBPLUS_B2B_PLAYWRIGHT_FALLBACK_ENABLED=1
   CBPLUS_B2B_USE_LIVE_BROWSER=1
   CBPLUS_CDP_TAB_SCAN_ENABLED=1
   CBPLUS_B2B_CLONE_CHROME_PROFILE=0
   ```

2. Set `CBPLUS_CHROME_USER_DATA_DIR` and `CBPLUS_CHROME_PROFILE` to the profile already managed by `fly-desk-chrome.service` on the new host. Do not point them to staging, a mount, or a copy from Hetzner.

3. Restart the runner and redirect service, not Chrome. Run a controlled search or the production smoke. Playwright connects to the existing browser through CDP, completes login, and observes only pages and responses from allowed hosts to capture a compatible candidate.

4. Require the same search and redirect criteria as the normal path. An authenticated tab alone is not sufficient evidence.

5. If fallback becomes part of stable operations, document why and keep CDP on loopback. If it was only diagnostic, return `CBPLUS_B2B_PLAYWRIGHT_FALLBACK_ENABLED=0` and `CBPLUS_CDP_TAB_SCAN_ENABLED=0`, restart the processes, and repeat the normal path.

The runtime may inspect artifacts that already belong to the configured local profile to recover recent branded URLs. This does not authorize copying session files, History, Favicons, or Cookies from another host.

## Diagnostics Without Exposing Secrets

Classify the failure before repeating attempts:

| Observable state | Interpretation | Action |
| --- | --- | --- |
| `tokenUsable=false` | Token is missing, expired, or does not match the terminal | Check the presence of credentials/TOTP, clock, and terminal; do not copy an old JWT |
| OTP generated, no token captured | The login or B2B endpoint changed | Temporarily enable CDP fallback and inspect only stage names and HTTP status |
| Search returns `401` or `402` | The provider rejected the search token | Force regeneration; block if it happens again |
| Search has offers, redirect is blocked | The branded flow did not accept the JWT | Use `/r/*` as evidence and diagnose refresh/terminal; do not provide direct links |
| Timeout or upstream unreachable | Network and authentication failures cannot be distinguished | Check DNS, TLS, and reachability; do not declare the session recovered |

Safe report fields are presence booleans, states, counts, stage names, and HTTP status codes. Do not include `terminalId`, token timestamps, complete URLs, provider bodies, or `lastWarmup.failureReason` contents if they incorporate external data.

## Cleanup

When finished, whether successful or not:

1. disable temporary fallback flags that are not part of the final design;
2. use `/api/diagnostics` to confirm that no active temporary Click and Book Plus artifacts remain;
3. run the platform maintenance routine if obsolete `travel_quote_foundation_costamar_*` or `travel_quote_foundation_costamar_browser_*` artifacts exist; do not open or archive them;
4. confirm that no `.env` files, payloads, profiles, cookies, or tokens were created in the repository, the `ops` home directory, or `/tmp`;
5. keep under `/var/lib/fly-desk` only state generated by the new host and subject to the application's TTL.

Do not migrate the session SQLite database to preserve old redirects: prices and purchase paths are ephemeral and must be rebuilt by a new search.

## Gate for Removing Hetzner

Click and Book Plus blocks removal of the previous VPS until all of the following evidence exists:

- B2B credentials and the TOTP source are available from the canonical store and do not exist only on the old host;
- the new host regenerates a token with `CBPLUS_TOKEN` absent and without using a copy of the previous profile;
- two consecutive smokes, separated by a runner/redirect restart, complete a Click and Book Plus search and validate its `/r/*`;
- no configuration, Chrome/CDP paths, units, callbacks, or operational documentation refer to Hetzner;
- cleanup finds no copied profiles, cookies, payloads, or tokens;
- the recovery path has been tested through operational access to the new host;
- the global gates for Agil, the other applications, DNS, and rollback also authorize retiring the previous VPS.

If the only functional evidence remains a cookie, JWT, profile, or SQLite database from the old VPS, migration is blocked. Do not compensate for that dependency by copying the artifact: recover credentials/TOTP first or coordinate access restoration with Click and Book Plus.

## Closure Evidence

Report only:

- path used: `http-b2b` or `cdp-fallback`;
- `tokenUsable=true` and the boolean prevalidation result;
- completed search and Click and Book Plus offer count;
- `/r/*` validated with `302` and an allowed branded host, without the complete URL;
- web/search/redirect status after the second pass;
- completion of temporary-file cleanup;
- `ready` or `blocked` decision for removing Hetzner, with non-sensitive reasons.
