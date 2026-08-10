import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const WEB_SESSION_COOKIE_NAME = "flydesk_session";
export const REDIRECT_SESSION_COOKIE_NAME = "flydesk_redirect_session";
export const WEB_THEME_COOKIE_NAME = "flydesk_theme";

const DEFAULT_WEB_SESSION_TTL_SECONDS = 12 * 60 * 60;
const MIN_WEB_SESSION_TTL_SECONDS = 5 * 60;
const MAX_WEB_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const SCRYPT_KEY_BYTES = 32;
const DEFAULT_WEB_THEME: WebTheme = "light";

type WebTheme = "light" | "dark";

interface PasswordVerificationResult {
  ok: boolean;
  configError?: string;
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export function isWebAuthEnabled(): boolean {
  return readEnv("FLY_DESK_WEB_AUTH") === "1";
}

export function shouldTrustLoopbackClient(): boolean {
  return readEnv("FLY_DESK_TRUST_LOOPBACK_CLIENT") === "1";
}

export function shouldTrustReverseProxyLoopbackClient(): boolean {
  return readEnv("FLY_DESK_TRUST_REVERSE_PROXY_LOOPBACK") === "1";
}

function resolveWebSessionSecret(): string | undefined {
  return readEnv("FLY_DESK_WEB_SESSION_SECRET");
}

function resolveWebPasswordHash(): string | undefined {
  return readEnv("FLY_DESK_WEB_PASSWORD_HASH");
}

interface ParsedScryptPasswordHash {
  salt: Buffer;
  expected: Buffer;
}

function parseScryptPasswordHash(encodedHash: string | undefined): ParsedScryptPasswordHash | undefined {
  const parts = encodedHash?.split(":");
  if (parts?.length !== 3 || parts[0] !== "scrypt") {
    return undefined;
  }

  const [, saltValue, expectedValue] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(saltValue) || !/^[A-Za-z0-9_-]+$/.test(expectedValue)) {
    return undefined;
  }

  const salt = Buffer.from(saltValue, "base64url");
  const expected = Buffer.from(expectedValue, "base64url");
  if (salt.length < 8 || expected.length < 16 || expected.length > 128) {
    return undefined;
  }

  return { salt, expected };
}

export function getWebAuthConfigError(): string | undefined {
  if (!isWebAuthEnabled()) {
    return undefined;
  }

  const sessionSecret = resolveWebSessionSecret();
  if (!sessionSecret || sessionSecret.length < 32) {
    return "FLY_DESK_WEB_SESSION_SECRET must be set to at least 32 characters.";
  }

  if (!parseScryptPasswordHash(resolveWebPasswordHash())) {
    return "FLY_DESK_WEB_PASSWORD_HASH must contain a valid scrypt hash.";
  }

  return undefined;
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

function safeEqualString(left: string, right: string): boolean {
  return safeEqual(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function createScryptPasswordHash(password: string, salt = randomBytes(16)): string {
  const key = scryptSync(password, salt, SCRYPT_KEY_BYTES);
  return `scrypt:${salt.toString("base64url")}:${key.toString("base64url")}`;
}

function verifyScryptPassword(password: string, encodedHash: string): boolean {
  const parsed = parseScryptPasswordHash(encodedHash);
  if (!parsed) {
    return false;
  }

  const actual = scryptSync(password, parsed.salt, parsed.expected.length);
  return safeEqual(actual, parsed.expected);
}

export function verifyWebPassword(password: string): PasswordVerificationResult {
  const configError = getWebAuthConfigError();
  if (configError) {
    return { ok: false, configError };
  }

  return { ok: verifyScryptPassword(password, resolveWebPasswordHash()!) };
}

export function resolveWebSessionTtlSeconds(): number {
  const configured = Number(process.env.FLY_DESK_WEB_SESSION_TTL_SECONDS ?? DEFAULT_WEB_SESSION_TTL_SECONDS);
  if (!Number.isFinite(configured)) {
    return DEFAULT_WEB_SESSION_TTL_SECONDS;
  }

  return Math.max(
    MIN_WEB_SESSION_TTL_SECONDS,
    Math.min(MAX_WEB_SESSION_TTL_SECONDS, Math.trunc(configured)),
  );
}

function parseCookies(headerValue: string | null): Map<string, string> {
  const cookies = new Map<string, string>();

  for (const segment of String(headerValue ?? "").split(";")) {
    const [name, ...valueParts] = segment.trim().split("=");
    if (!name || valueParts.length === 0) {
      continue;
    }
    cookies.set(name, valueParts.join("="));
  }

  return cookies;
}

function signSessionPayload(expiresAtMs: number, nonce: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${expiresAtMs}.${nonce}`)
    .digest("base64url");
}

function signRedirectSessionPayload(expiresAtMs: number, nonce: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`redirect.${expiresAtMs}.${nonce}`)
    .digest("base64url");
}

function validSessionExpiry(
  request: Request,
  cookieName: string,
  signer: typeof signSessionPayload,
  nowMs: number,
): number | undefined {
  const secret = resolveWebSessionSecret();
  if (!secret) {
    return undefined;
  }

  const session = parseCookies(request.headers.get("cookie")).get(cookieName);
  const parts = session?.split(".") ?? [];
  if (parts.length !== 4 || parts[0] !== "v1") {
    return undefined;
  }

  const expiresAtMs = Number(parts[1]);
  const nonce = parts[2];
  const signature = parts[3];
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs || !nonce || !signature) {
    return undefined;
  }

  const expected = signer(expiresAtMs, nonce, secret);
  return safeEqualString(signature, expected) ? expiresAtMs : undefined;
}

function isCookieSecure(request: Request): boolean {
  const configured = readEnv("FLY_DESK_COOKIE_SECURE");
  if (configured === "1") {
    return true;
  }
  if (configured === "0") {
    return false;
  }

  const forwardedProto = request.headers.get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    ?.toLowerCase();
  return forwardedProto === "https" || new URL(request.url).protocol === "https:";
}

export function createWebSessionCookie(request: Request, nowMs = Date.now()): string {
  const secret = resolveWebSessionSecret();
  if (!secret) {
    throw new Error("Fly Desk web session secret is not configured.");
  }

  const ttlSeconds = resolveWebSessionTtlSeconds();
  const expiresAtMs = nowMs + ttlSeconds * 1000;
  const nonce = randomBytes(18).toString("base64url");
  const signature = signSessionPayload(expiresAtMs, nonce, secret);
  const secure = isCookieSecure(request) ? "; Secure" : "";
  return `${WEB_SESSION_COOKIE_NAME}=v1.${expiresAtMs}.${nonce}.${signature}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${ttlSeconds}${secure}`;
}

export function createRedirectSessionCookie(
  request: Request,
  nowMs = Date.now(),
  expiresAtMs = nowMs + resolveWebSessionTtlSeconds() * 1000,
): string {
  const secret = resolveWebSessionSecret();
  if (!secret) {
    throw new Error("Fly Desk web session secret is not configured.");
  }

  const nonce = randomBytes(18).toString("base64url");
  const signature = signRedirectSessionPayload(expiresAtMs, nonce, secret);
  const maxAgeSeconds = Math.max(0, Math.floor((expiresAtMs - nowMs) / 1000));
  const secure = isCookieSecure(request) ? "; Secure" : "";
  return `${REDIRECT_SESSION_COOKIE_NAME}=v1.${expiresAtMs}.${nonce}.${signature}; HttpOnly; Path=/r; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function createRedirectSessionCookieForWebSession(
  request: Request,
  nowMs = Date.now(),
): string | undefined {
  const expiresAtMs = validSessionExpiry(
    request,
    WEB_SESSION_COOKIE_NAME,
    signSessionPayload,
    nowMs,
  );
  return expiresAtMs === undefined
    ? undefined
    : createRedirectSessionCookie(request, nowMs, expiresAtMs);
}

export function clearWebSessionCookie(request: Request): string {
  const secure = isCookieSecure(request) ? "; Secure" : "";
  return `${WEB_SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`;
}

export function clearRedirectSessionCookie(request: Request): string {
  const secure = isCookieSecure(request) ? "; Secure" : "";
  return `${REDIRECT_SESSION_COOKIE_NAME}=; HttpOnly; Path=/r; SameSite=Lax; Max-Age=0${secure}`;
}

export function hasValidWebSession(request: Request, nowMs = Date.now()): boolean {
  if (!isWebAuthEnabled()) {
    return false;
  }
  return validSessionExpiry(
    request,
    WEB_SESSION_COOKIE_NAME,
    signSessionPayload,
    nowMs,
  ) !== undefined;
}

export function hasValidRedirectSession(request: Request, nowMs = Date.now()): boolean {
  if (!isWebAuthEnabled()) {
    return false;
  }
  return validSessionExpiry(
    request,
    REDIRECT_SESSION_COOKIE_NAME,
    signRedirectSessionPayload,
    nowMs,
  ) !== undefined;
}

export function resolveWebTheme(request: Request): WebTheme {
  const theme = parseCookies(request.headers.get("cookie")).get(WEB_THEME_COOKIE_NAME);
  return theme === "dark" || theme === "light" ? theme : DEFAULT_WEB_THEME;
}

/*
 * The gate, drawn from the same catalogues as the application behind it.
 *
 * It cannot import `frontend/src`: this page is served by the router before any
 * bundle is reachable, and it has to render from a single string with no build
 * step. So the values are transcribed rather than shared, and the transcription
 * is deliberately literal — the token names below are the ones in
 * `design-system.css`, so a value that drifts is visible as a difference in a
 * name, not just in a number.
 *
 * Nothing here is off-catalogue: the field is `.fd-field-control` (52 · r12 ·
 * micro label at 9/12), the action is the `xl` button (52 · r12 · pressed 12 %),
 * the notice is `.fd-alert-line`, the brand is the title bar's, and the focus
 * ring is 3d's — 2px of primary at 55 %, outside the border, keyboard only.
 */
export function renderLoginPage(error?: string, theme: WebTheme = DEFAULT_WEB_THEME): string {
  const errorMarkup = error
    ? `<p class="fd-alert-line fd-alert-line-error" role="alert" aria-live="assertive">
          <svg class="fd-alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
          <span>${escapeHtml(error)}</span>
        </p>`
    : "";
  const initialTheme = theme === "dark" ? "dark" : "light";

  return `<!doctype html>
<html lang="es" class="${initialTheme === "dark" ? "dark" : ""}" data-theme="${initialTheme}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <title>Fly Desk</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <script>
      (() => {
        const root = document.documentElement;
        try {
          const saved = window.localStorage.getItem("flydesk-theme");
          if (saved === "light" || saved === "dark") {
            root.dataset.theme = saved;
            root.classList.toggle("dark", saved === "dark");
            document.cookie = "flydesk_theme=" + saved + "; Path=/; Max-Age=31536000; SameSite=Lax";
          }
        } catch {}
      })();
    </script>
    <style>
      /* ---- the tokens, by their names in design-system.css ---------------- */
      :root {
        color-scheme: light;

        --color-background: #f8f8f6;
        --color-foreground: #121212;
        --color-card: #ffffff;
        --color-primary: #d97757;
        --color-primary-foreground: #ffffff;
        --color-secondary: #efeeeb;
        --color-muted-foreground: #7b7974;
        --color-accent: #e9e8e3;
        --color-border: #1f1f1e26;
        --color-input: #1f1f1e26;
        --color-destructive: #d97757;
        --color-warning-soft: #d977571a;
        --color-warning-soft-foreground: #6f321f;

        /* 5b · the two control heights this page needs, and three radii. */
        --fd-control-standard: 32px;
        --fd-control-primary: 52px;
        --fd-radius-8: 8px;
        --fd-radius-10: 10px;
        --fd-radius-12: 12px;

        /* 5a · four bodies of the scale and its four weights. */
        --fd-text-sheet: 17px;
        --fd-text-body: 14px;
        --fd-text-base: 13px;
        --fd-text-micro: 10px;
        --fd-weight-label: 600;
        --fd-weight-title: 700;
        --fd-tracking-micro: 0.04em;

        /* §0 · the one duration and the one easing anything here may use. */
        --fd-dur-tacto: 90ms;
        --fd-ease-tacto: cubic-bezier(0.2, 0, 0.4, 1);

        /* The title bar hover of plate 1b: the toggle previews the theme it
           switches to, so its hover colours are the *other* palette. */
        --fd-theme-toggle-hover-bg: #1f1f1e;
        --fd-theme-toggle-hover-fg: #f8f8f6;

        --keyboard-shift: 0px;
        font-family: Inter, "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: var(--color-background);
        color: var(--color-foreground);
      }
      :root.dark {
        color-scheme: dark;

        --color-background: #1f1f1e;
        --color-foreground: #f8f8f6;
        /* Not a lighter grey: in the dark palette a card *is* the background,
           and a field is read by its border. */
        --color-card: #1f1f1e;
        --color-secondary: #2c2c2a;
        --color-muted-foreground: #97958c;
        --color-accent: #121212;
        --color-border: #e2e1da26;
        --color-input: #e2e1da26;
        --color-warning-soft: #d9775726;
        --color-warning-soft-foreground: #f2c3b3;

        --fd-theme-toggle-hover-bg: #f8f8f6;
        --fd-theme-toggle-hover-fg: #121212;
      }
      *, *::before, *::after { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; overflow: hidden; overscroll-behavior: none; }
      html { background: var(--color-background); }
      body {
        position: fixed;
        inset: 0;
        display: flex;
        flex-direction: column;
        margin: 0;
        overflow: clip;
        background: var(--color-background);
        color: var(--color-foreground);
        text-rendering: geometricPrecision;
        -webkit-font-smoothing: antialiased;
      }

      /* ---- the title bar (1b) --------------------------------------------
       * The same bar the application wears, so signing in does not change the
       * chrome — only what is under it. */
      .fd-topbar {
        display: flex;
        flex-shrink: 0;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-height: 44px;
        padding:
          calc(6px + env(safe-area-inset-top, 0px))
          calc(16px + env(safe-area-inset-right, 0px))
          6px
          calc(16px + env(safe-area-inset-left, 0px));
        background: var(--color-accent);
      }
      .fd-topbar-brand {
        display: flex;
        height: var(--fd-control-standard);
        align-items: center;
        gap: 8px;
        margin-left: -4px;
        padding-inline: 4px;
      }
      .fd-topbar-brand-mark {
        width: 24px;
        height: 24px;
        color: var(--color-primary);
      }
      .fd-topbar-brand-name {
        font-size: var(--fd-text-body);
        font-weight: var(--fd-weight-title);
      }
      .fd-capsule {
        display: inline-flex;
        height: var(--fd-control-standard);
        align-items: stretch;
        overflow: hidden;
        border: 1px solid var(--color-input);
        border-radius: var(--fd-radius-10);
        background: var(--color-secondary);
        color: var(--color-muted-foreground);
      }
      .fd-capsule-cell {
        display: grid;
        width: var(--fd-control-standard);
        height: var(--fd-control-standard);
        place-items: center;
        border: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        transition:
          background-color var(--fd-dur-tacto) var(--fd-ease-tacto),
          color var(--fd-dur-tacto) var(--fd-ease-tacto);
      }
      .fd-capsule-cell:hover {
        background: var(--fd-theme-toggle-hover-bg);
        color: var(--fd-theme-toggle-hover-fg);
      }
      .fd-capsule-cell svg { width: 16px; height: 16px; }
      /* One glyph per theme, both in the same cell so the swap costs no
         layout — the chevron pattern of 7b, applied to the switch. */
      :root:not(.dark) .fd-theme-moon, :root.dark .fd-theme-sun { display: none; }

      /* ---- the stage (1a) -------------------------------------------------
       * Two unequal spacers, 1 above and 1.3 below, which is what leaves the
       * form slightly above centre on the idle screen. */
      .fd-stage {
        display: flex;
        flex: 1;
        min-height: 0;
        flex-direction: column;
        align-items: center;
        padding:
          0
          calc(16px + env(safe-area-inset-right, 0px))
          calc(12px + env(safe-area-inset-bottom, 0px))
          calc(16px + env(safe-area-inset-left, 0px));
      }
      .fd-stage::before { content: ""; flex: 1 1 0; }
      .fd-stage::after { content: ""; flex: 1.3 1 0; }
      main {
        display: grid;
        width: min(100%, 344px);
        flex: none;
        gap: 16px;
        transform: translateY(calc(var(--keyboard-shift) * -1));
        transition: transform 220ms var(--fd-ease-tacto);
      }
      h1 {
        margin: 0;
        font-size: var(--fd-text-sheet);
        font-weight: var(--fd-weight-title);
        letter-spacing: -0.01em;
        line-height: 1.2;
      }
      form { display: grid; gap: 10px; }

      /* ---- the field (1a · 03 §2) -----------------------------------------
       * 52 · r12, with the micro label parked at 9/12. It does not float: in
       * this system the label is always up and the value has its own band
       * underneath, so nothing moves when the agent starts typing. */
      .fd-field-control {
        position: relative;
        display: flex;
        height: var(--fd-control-primary);
        align-items: center;
        padding: 15px 12px 0;
        border: 1px solid var(--color-input);
        border-radius: var(--fd-radius-12);
        background: var(--color-card);
        transition:
          border-color var(--fd-dur-tacto) var(--fd-ease-tacto),
          box-shadow var(--fd-dur-tacto) var(--fd-ease-tacto);
      }
      .fd-field-control:hover {
        border-color: color-mix(in srgb, var(--color-primary) 40%, var(--color-border));
      }
      .fd-field-control:focus-within {
        border-color: color-mix(in srgb, var(--color-primary) 50%, var(--color-border));
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 18%, transparent);
      }
      .fd-field-label {
        position: absolute;
        top: 9px;
        left: 12px;
        color: var(--color-muted-foreground);
        font-size: var(--fd-text-micro);
        font-weight: var(--fd-weight-title);
        letter-spacing: var(--fd-tracking-micro);
        line-height: 1;
        pointer-events: none;
        text-transform: uppercase;
        transition: color var(--fd-dur-tacto) var(--fd-ease-tacto);
      }
      .fd-field-control:focus-within .fd-field-label { color: var(--color-primary); }
      .fd-field-value {
        width: 100%;
        height: 17px;
        padding: 0;
        border: 0;
        background: transparent;
        color: var(--color-foreground);
        font: inherit;
        font-size: var(--fd-text-body);
        font-weight: var(--fd-weight-label);
        line-height: 17px;
      }
      .fd-field-value:focus { outline: none; }
      /* Chrome paints autofilled inputs with its own white and its own text
         colour, which in the dark palette is white on white. An inset shadow
         the height of the field is the only way to keep the surface ours. */
      .fd-field-value:-webkit-autofill,
      .fd-field-value:-webkit-autofill:focus {
        -webkit-text-fill-color: var(--color-foreground);
        box-shadow: inset 0 0 0 60px var(--color-card);
      }

      /* ---- the action (5b · 07 §4 row 11) ---------------------------------
       * The "xl" button: 52 · r12, primary fill, one step darker on hover and
       * 12 % of black over the surface while pressed — never a scale, and
       * never a filter, which would darken the label with the fill. */
      .fd-button {
        display: inline-flex;
        height: var(--fd-control-primary);
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding-inline: 20px;
        border: 0;
        border-radius: var(--fd-radius-12);
        background: var(--color-primary);
        color: var(--color-primary-foreground);
        font: inherit;
        font-size: var(--fd-text-body);
        font-weight: var(--fd-weight-label);
        cursor: pointer;
        transition:
          background-color var(--fd-dur-tacto) var(--fd-ease-tacto),
          box-shadow var(--fd-dur-tacto) var(--fd-ease-tacto);
      }
      .fd-button:hover { background: color-mix(in srgb, var(--color-primary) 90%, black); }
      .fd-button:active { box-shadow: inset 0 0 0 100px rgb(0 0 0 / 12%); }

      /* ---- 3d · one ring, outside the border, keyboard only --------------- */
      .fd-focus-ring:focus-visible {
        outline: none;
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 55%, transparent);
      }
      /* On a primary fill the ring needs 2px of page colour behind it to read
         as a ring and not as a thicker button. */
      .fd-button.fd-focus-ring:focus-visible {
        box-shadow:
          0 0 0 2px var(--color-background),
          0 0 0 4px color-mix(in srgb, var(--color-primary) 55%, transparent);
      }

      /* ---- the notice (11 §3) ---------------------------------------------
       * ".fd-alert-line", except that it wraps: the application's copy is one
       * line and ellipsises, and a password error the agent cannot read is
       * worse than a bar two lines tall. */
      .fd-alert-line {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        margin: 0;
        min-height: 36px;
        padding: 9px 12px;
        border: 1px solid color-mix(in srgb, var(--color-primary) 38%, transparent);
        border-radius: var(--fd-radius-10);
        background: var(--color-warning-soft);
        color: var(--color-warning-soft-foreground);
        font-size: var(--fd-text-base);
        font-weight: var(--fd-weight-label);
        line-height: 1.35;
      }
      .fd-alert-line-error {
        border-color: color-mix(in srgb, var(--color-destructive) 50%, transparent);
      }
      .fd-alert-icon { width: 16px; height: 16px; flex-shrink: 0; margin-top: 1px; }

      /* ---- armazón C (02 §4) ----------------------------------------------
       * The same 719.98 the shell's container query uses, as a media query —
       * this page has no shell to ask. The capsule breaks into a loose button
       * with its own border, at the 36px of the mobile height column. */
      @media (max-width: 719.98px) {
        .fd-capsule {
          height: auto;
          overflow: visible;
          border: 0;
          border-radius: 0;
          background: transparent;
        }
        .fd-capsule-cell {
          width: 36px;
          height: 36px;
          border: 1px solid var(--color-input);
          border-radius: var(--fd-radius-10);
          background: var(--color-secondary);
        }
        /* 7b: a 36px control takes the 18px pictogram, not the 16 of its 32px
           desktop twin. */
        .fd-capsule-cell svg { width: 18px; height: 18px; }
      }

      @media (prefers-reduced-motion: reduce) {
        main { transition: none; }
      }

      /* 07 §5 · a change of theme is one of the things that never animates.
         Every transition on this page is armed against colour, so flipping the
         palette would retint the page *through* them — a wipe where the plate
         asks for a switch. The class is up for one frame while the swap lands,
         and it is the same contract as lib/reduced-motion.ts in the bundle. */
      html.fd-theme-swap, html.fd-theme-swap * { transition: none !important; }
    </style>
  </head>
  <body>
    <header class="fd-topbar">
      <span class="fd-topbar-brand">
        <svg class="fd-topbar-brand-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M21.96 3.05c.76-.3 1.51.42 1.25 1.19l-5.36 15.7c-.26.77-1.24.98-1.79.38l-4.2-4.57-2.45 3.43c-.47.66-1.5.44-1.67-.36l-1.02-4.9-4.52-1.5c-.84-.28-.88-1.46-.05-1.78l19.81-7.59ZM19.46 6.45l-10.3 6.2 3.25 1.07 7.05-7.27Zm-5.94 8.62 2.86 3.13 2.75-8.12-5.61 4.99Z"/>
        </svg>
        <span class="fd-topbar-brand-name">Fly Desk</span>
      </span>
      <span class="fd-capsule">
        <button type="button" id="theme-toggle" class="fd-capsule-cell fd-focus-ring" aria-label="Cambiar tema">
          <svg class="fd-theme-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
          <svg class="fd-theme-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
        </button>
      </span>
    </header>
    <div class="fd-stage">
      <main>
        <h1>Acceso</h1>
        <form method="post" action="/login">
          ${errorMarkup}
          <label class="fd-field-control" for="password">
            <span class="fd-field-label">Contraseña</span>
            <input class="fd-field-value" id="password" name="password" type="password" autocomplete="current-password" required autofocus>
          </label>
          <button type="submit" class="fd-button fd-focus-ring">Entrar</button>
        </form>
      </main>
    </div>
    <script>
      (() => {
        const root = document.documentElement;
        const isTextInputFocused = () => {
          const active = document.activeElement;
          return active instanceof HTMLElement && active.matches('input, textarea, [contenteditable="true"]');
        };
        const resetScroll = () => {
          if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
        };
        const updateKeyboardShift = () => {
          const viewport = window.visualViewport;
          if (!viewport || !window.matchMedia("(max-width: 768px)").matches || !isTextInputFocused()) {
            root.style.setProperty("--keyboard-shift", "0px");
            resetScroll();
            return;
          }
          const visibleBottom = viewport.height + viewport.offsetTop;
          const obscuredHeight = Math.max(0, window.innerHeight - visibleBottom);
          const partialShift = obscuredHeight > 0 ? obscuredHeight * 0.14 : 0;
          const maxShift = viewport.height * 0.05;
          root.style.setProperty("--keyboard-shift", Math.min(Math.round(maxShift), Math.round(partialShift)) + "px");
          resetScroll();
        };
        if (window.visualViewport) {
          window.visualViewport.addEventListener("resize", updateKeyboardShift);
          window.visualViewport.addEventListener("scroll", updateKeyboardShift);
        }
        window.addEventListener("resize", updateKeyboardShift);
        document.addEventListener("focusin", updateKeyboardShift);
        document.addEventListener("focusout", () => window.setTimeout(updateKeyboardShift, 0));
        updateKeyboardShift();

        /* The same switch the title bar carries once the agent is through, and
           the same two places it writes to: the key the bundle reads on boot,
           and the cookie the server reads to render this page. Choosing the
           theme before signing in has to survive signing in. */
        const applyTheme = (next) => {
          root.classList.add("fd-theme-swap");
          root.dataset.theme = next;
          root.classList.toggle("dark", next === "dark");
          void root.offsetHeight;
          window.requestAnimationFrame(() => root.classList.remove("fd-theme-swap"));
          try {
            window.localStorage.setItem("flydesk-theme", next);
          } catch {}
          document.cookie = "flydesk_theme=" + next + "; Path=/; Max-Age=31536000; SameSite=Lax";
        };
        document.getElementById("theme-toggle")?.addEventListener("click", () => {
          applyTheme(root.classList.contains("dark") ? "light" : "dark");
        });
      })();
    </script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
