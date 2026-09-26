import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { envNumber } from "./env";

export const WEB_SESSION_COOKIE_NAME = "flydesk_session";
const REDIRECT_SESSION_COOKIE_NAME = "flydesk_redirect_session";
const WEB_THEME_COOKIE_NAME = "flydesk_theme";

const DEFAULT_WEB_SESSION_TTL_SECONDS = 12 * 60 * 60;
const MIN_WEB_SESSION_TTL_SECONDS = 5 * 60;
const MAX_WEB_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/*
 * Two limits, because they answer different questions. The window above is how
 * long a session survives with nobody touching it, and it slides forward while
 * the agent works. The cap below is measured from the sign-in itself and never
 * slides, so a tab left open indefinitely still has to authenticate again.
 */
const DEFAULT_WEB_SESSION_MAX_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const MIN_WEB_SESSION_MAX_LIFETIME_SECONDS = 5 * 60;
const MAX_WEB_SESSION_MAX_LIFETIME_SECONDS = 90 * 24 * 60 * 60;
const MAX_NEXT_PATH_LENGTH = 512;

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

function hasForwardedClientMarker(request: Request): boolean {
  return Boolean(
    request.headers.get("x-forwarded-for")?.trim()
      || request.headers.get("forwarded")?.trim()
      || request.headers.get("x-real-ip")?.trim(),
  );
}

/* A request trusted without a session because it came from this machine. Each
   server stamps `x-flydesk-client-loopback` from the socket's own address; a
   request a proxy relayed counts only when the reverse proxy is trusted too. */
export function isTrustedLocalRequest(request: Request): boolean {
  if (!shouldTrustLoopbackClient() || request.headers.get("x-flydesk-client-loopback") !== "1") {
    return false;
  }

  return !hasForwardedClientMarker(request) || shouldTrustReverseProxyLoopbackClient();
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
  return Math.trunc(envNumber("FLY_DESK_WEB_SESSION_TTL_SECONDS", DEFAULT_WEB_SESSION_TTL_SECONDS, {
    min: MIN_WEB_SESSION_TTL_SECONDS,
    max: MAX_WEB_SESSION_TTL_SECONDS,
  }));
}

export function resolveWebSessionMaxLifetimeSeconds(): number {
  return Math.trunc(envNumber("FLY_DESK_WEB_SESSION_MAX_LIFETIME_SECONDS", DEFAULT_WEB_SESSION_MAX_LIFETIME_SECONDS, {
    min: MIN_WEB_SESSION_MAX_LIFETIME_SECONDS,
    max: MAX_WEB_SESSION_MAX_LIFETIME_SECONDS,
  }));
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

/*
 * The web session carries two stamps. `expiresAtMs` is the sliding one: it is
 * pushed forward while the agent works, so a session dies of inactivity rather
 * than of the clock it was born on. `issuedAtMs` is the sign-in itself and
 * never moves, which is what keeps the sliding from becoming perpetual — see
 * `renewWebSessionCookies`.
 *
 * Both are inside the signature, so neither can be edited by the browser. The
 * older `v1.<expiresAtMs>.<nonce>.<signature>` shape had no `issuedAtMs`, and
 * so no cap that could be trusted; a cookie still in that shape is rejected
 * rather than upgraded, which costs its holder one sign-in and nothing else.
 */
const WEB_SESSION_COOKIE_VERSION = "v2";

interface WebSession {
  issuedAtMs: number;
  expiresAtMs: number;
}

function signWebSessionPayload(
  issuedAtMs: number,
  expiresAtMs: number,
  nonce: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`${WEB_SESSION_COOKIE_VERSION}.${issuedAtMs}.${expiresAtMs}.${nonce}`)
    .digest("base64url");
}

function signRedirectSessionPayload(expiresAtMs: number, nonce: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`redirect.${expiresAtMs}.${nonce}`)
    .digest("base64url");
}

function readWebSession(request: Request, nowMs: number): WebSession | undefined {
  const secret = resolveWebSessionSecret();
  if (!secret) {
    return undefined;
  }

  const session = parseCookies(request.headers.get("cookie")).get(WEB_SESSION_COOKIE_NAME);
  const parts = session?.split(".") ?? [];
  if (parts.length !== 5 || parts[0] !== WEB_SESSION_COOKIE_VERSION) {
    return undefined;
  }

  const issuedAtMs = Number(parts[1]);
  const expiresAtMs = Number(parts[2]);
  const nonce = parts[3];
  const signature = parts[4];
  if (
    !Number.isFinite(issuedAtMs)
    || issuedAtMs <= 0
    || !Number.isFinite(expiresAtMs)
    || expiresAtMs <= nowMs
    || !nonce
    || !signature
  ) {
    return undefined;
  }

  const expected = signWebSessionPayload(issuedAtMs, expiresAtMs, nonce, secret);
  if (!safeEqualString(signature, expected)) {
    return undefined;
  }

  /* Belt and braces. The cap is already applied wherever the cookie is
     written, so a signed value can only fail this if the operator shortened
     the limit since — and then the shorter limit takes effect at once. */
  if (nowMs >= issuedAtMs + resolveWebSessionMaxLifetimeSeconds() * 1000) {
    return undefined;
  }

  return { issuedAtMs, expiresAtMs };
}

function validRedirectSessionExpiry(request: Request, nowMs: number): number | undefined {
  const secret = resolveWebSessionSecret();
  if (!secret) {
    return undefined;
  }

  const session = parseCookies(request.headers.get("cookie")).get(REDIRECT_SESSION_COOKIE_NAME);
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

  const expected = signRedirectSessionPayload(expiresAtMs, nonce, secret);
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

function writeWebSessionCookie(
  request: Request,
  issuedAtMs: number,
  expiresAtMs: number,
  nowMs: number,
): string {
  const secret = resolveWebSessionSecret();
  if (!secret) {
    throw new Error("Fly Desk web session secret is not configured.");
  }

  const nonce = randomBytes(18).toString("base64url");
  const signature = signWebSessionPayload(issuedAtMs, expiresAtMs, nonce, secret);
  const maxAgeSeconds = Math.max(0, Math.floor((expiresAtMs - nowMs) / 1000));
  const secure = isCookieSecure(request) ? "; Secure" : "";
  return `${WEB_SESSION_COOKIE_NAME}=${WEB_SESSION_COOKIE_VERSION}.${issuedAtMs}.${expiresAtMs}.${nonce}.${signature}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

/* The window a session gets from `nowMs`, never reaching past the cap that
   `issuedAtMs` fixed at sign-in. */
function slidingExpiryMs(issuedAtMs: number, nowMs: number): number {
  return Math.min(
    nowMs + resolveWebSessionTtlSeconds() * 1000,
    issuedAtMs + resolveWebSessionMaxLifetimeSeconds() * 1000,
  );
}

export function createWebSessionCookie(request: Request, nowMs = Date.now()): string {
  return writeWebSessionCookie(request, nowMs, slidingExpiryMs(nowMs, nowMs), nowMs);
}

interface WebSessionRenewal {
  sessionCookie: string;
  redirectSessionCookie: string;
  expiresAtMs: number;
}

/*
 * Re-issue an authenticated session once it is past the halfway mark of its
 * window, and only then. Renewing on every request would put a `Set-Cookie` on
 * every API response and make each one uncacheable for no gain; renewing only
 * near the very end would let a tab that polls quietly expire anyway. Half is
 * far enough from the edge that someone working never meets the expiry, and
 * far enough from the start that the header stays rare — in practice once per
 * half-window per browser.
 *
 * Returns nothing when there is no session, when the window is not yet half
 * spent, or when the absolute cap has already pinned the expiry. That last
 * case is the point of the cap: sliding is refused, and the session ends on
 * the schedule the sign-in set.
 */
export function renewWebSessionCookies(
  request: Request,
  nowMs = Date.now(),
): WebSessionRenewal | undefined {
  if (!isWebAuthEnabled()) {
    return undefined;
  }

  const session = readWebSession(request, nowMs);
  if (!session) {
    return undefined;
  }

  if ((session.expiresAtMs - nowMs) * 2 >= resolveWebSessionTtlSeconds() * 1000) {
    return undefined;
  }

  const expiresAtMs = slidingExpiryMs(session.issuedAtMs, nowMs);
  if (expiresAtMs <= session.expiresAtMs) {
    return undefined;
  }

  return {
    sessionCookie: writeWebSessionCookie(request, session.issuedAtMs, expiresAtMs, nowMs),
    redirectSessionCookie: createRedirectSessionCookie(request, nowMs, expiresAtMs),
    expiresAtMs,
  };
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
  const session = readWebSession(request, nowMs);
  return session === undefined
    ? undefined
    : createRedirectSessionCookie(request, nowMs, session.expiresAtMs);
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
  return readWebSession(request, nowMs) !== undefined;
}

/*
 * Which signed-in browser sent a request, stable while its session slides: the
 * moment it signed in, which a renewal keeps. The two agents share a password,
 * so this, not a user name, is what tells their searches apart when capacity
 * is shared out. It is a timestamp, not a secret, and only a valid session
 * has one.
 */
export function webSessionHolder(request: Request, nowMs = Date.now()): string | undefined {
  if (!isWebAuthEnabled()) {
    return undefined;
  }
  const session = readWebSession(request, nowMs);
  return session ? `web-${session.issuedAtMs}` : undefined;
}

export function hasValidRedirectSession(request: Request, nowMs = Date.now()): boolean {
  if (!isWebAuthEnabled()) {
    return false;
  }
  return validRedirectSessionExpiry(request, nowMs) !== undefined;
}

/*
 * Where to send someone once they have signed in. The value arrives in a query
 * string, which means it arrives from anyone able to put a link in front of the
 * user, so it is treated as hostile: only a path on this very origin is ever
 * returned. An absolute URL, a protocol-relative `//host`, a backslash that
 * browsers fold into one, a control character, or anything not beginning with a
 * single `/` is discarded, and the caller falls back to `/`.
 *
 * The parse is what enforces it. Resolving against a throwaway base and then
 * insisting the origin came back unchanged catches the shapes a prefix test
 * misses, because the URL parser normalises them the way a browser would.
 */
const NEXT_PATH_BASE = "https://next-path.invalid";

export function resolveSafeNextPath(rawNext: unknown): string | undefined {
  if (typeof rawNext !== "string") {
    return undefined;
  }

  const candidate = rawNext.trim();
  if (
    !candidate
    || candidate.length > MAX_NEXT_PATH_LENGTH
    || !candidate.startsWith("/")
    || candidate.startsWith("//")
    || candidate.startsWith("/\\")
    || /[\u0000-\u001f\u007f]/.test(candidate)
  ) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate, NEXT_PATH_BASE);
  } catch {
    return undefined;
  }

  /* Dot segments are resolved by the parse, so `/.//host` only becomes the
     protocol-relative `//host` afterwards: the result is checked again. */
  if (
    parsed.origin !== NEXT_PATH_BASE
    || parsed.pathname.startsWith("//")
    || parsed.pathname.startsWith("/\\")
  ) {
    return undefined;
  }

  /* Returning to the gate would loop, and returning to the handler that
     clears the session would undo the sign-in that just happened. */
  if (parsed.pathname === "/login" || parsed.pathname === "/logout") {
    return undefined;
  }

  return `${parsed.pathname}${parsed.search}`;
}

/* The gate's own URL, carrying whatever of the return path survived. */
export function loginPageLocation(next?: string, error = false): string {
  const params = new URLSearchParams();
  if (error) {
    params.set("error", "1");
  }

  /* `/` is where the sign-in lands anyway, so carrying it would add a query
     parameter that changes nothing. */
  const safeNext = resolveSafeNextPath(next);
  if (safeNext && safeNext !== "/") {
    params.set("next", safeNext);
  }

  const query = params.toString();
  return query ? `/login?${query}` : "/login";
}

export function resolveWebTheme(request: Request): WebTheme {
  const theme = parseCookies(request.headers.get("cookie")).get(WEB_THEME_COOKIE_NAME);
  return theme === "dark" || theme === "light" ? theme : DEFAULT_WEB_THEME;
}

/* The sign-in page is served before any bundle, so it borrows the faces the
   frontend build wrote into frontend/dist/index.html; without a build it falls
   back to system fonts. */
function loginFontHead(): string {
  let html: string;
  try {
    html = readFileSync(path.resolve(process.cwd(), "frontend", "dist", "index.html"), "utf8");
  } catch {
    return "";
  }
  const preload = html.match(/<link rel="preload"[^>]*data-fd-font="sans"[^>]*>/)?.[0] ?? "";
  const faces = html.match(/<style data-fd-fonts>[^<]*<\/style>/)?.[0] ?? "";
  return [preload, faces].filter(Boolean).join("\n    ");
}

/*
 * The gate renders from one string with no build step, so it cannot import the
 * frontend's stylesheets. Its tokens and classes are transcribed from the
 * application under the same names, so a value that drifts shows as a name.
 */
export function renderLoginPage(
  error?: string,
  theme: WebTheme = DEFAULT_WEB_THEME,
  next?: string,
): string {
  const errorMarkup = error
    ? `<p class="fd-alert-line" role="alert" aria-live="assertive">
          <svg class="fd-alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
          <span>${escapeHtml(error)}</span>
        </p>`
    : "";
  const initialTheme = theme === "dark" ? "dark" : "light";
  /* Sanitised again on the way out: only a same-origin path is ever written. */
  const safeNext = resolveSafeNextPath(next);
  const nextMarkup = safeNext
    ? `<input type="hidden" name="next" value="${escapeHtml(safeNext)}">`
    : "";

  return `<!doctype html>
<html lang="es" class="${initialTheme === "dark" ? "dark" : ""}" data-theme="${initialTheme}">
  <head>
    <meta charset="utf-8">
    <!-- resizes-content: the keyboard shrinks the layout viewport, so the
         centred form stays above it. -->
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
    <title>Fly Desk</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    ${loginFontHead()}
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
      :root {
        color-scheme: light;

        --color-background: #f8f8f6;
        --color-foreground: #121212;
        --color-card: #ffffff;
        --color-primary: #d97757;
        --color-primary-foreground: #ffffff;
        --color-primary-hover: #c36b4e;
        --color-secondary: #efeeeb;
        --color-muted-foreground: #6e6c67;
        --color-accent: #e9e8e3;
        --color-input: #1f1f1e26;
        --color-warning-soft: #d977571a;
        --color-warning-soft-foreground: #6f321f;
        --color-destructive-border: #d9775780;
        --color-hover: #12121212;
        --color-pressed: #0000001f;
        --color-focus: #d977578c;
        --color-glow: #d977572e;
        --color-border-hover: #b7674d7d;
        --color-border-active: #c56d519d;

        --fd-control-standard: 32px;
        --fd-control-touch-sm: 34px;
        --fd-control-primary: 52px;
        --fd-radius-10: 10px;
        --fd-radius-12: 12px;
        --fd-icon-16: 16px;
        --fd-text-sheet: 17px;
        --fd-text-body: 14px;
        --fd-text-base: 13px;
        --fd-text-label: 11px;
        --fd-weight-label: 600;
        --fd-weight-title: 700;
        --fd-dur-tacto: 90ms;
        --fd-ease-tacto: cubic-bezier(0.2, 0, 0.4, 1);

        --keyboard-shift: 0px;
        font-family: "Inter", "Inter Fallback", ui-sans-serif, system-ui, sans-serif;
        background: var(--color-background);
        color: var(--color-foreground);
      }
      :root.dark {
        color-scheme: dark;

        --color-background: #1f1f1e;
        --color-foreground: #f8f8f6;
        --color-card: #1f1f1e;
        --color-secondary: #2c2c2a;
        --color-muted-foreground: #97958c;
        --color-accent: #121212;
        --color-input: #e2e1da26;
        --color-warning-soft: #d9775726;
        --color-warning-soft-foreground: #f2c3b3;
        --color-hover: #f8f8f612;
        --color-border-hover: #db8a6f7d;
        --color-border-active: #da82659d;
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

      /* The application's title bar, so signing in does not change the chrome. */
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
      .fd-capsule { display: inline-flex; }
      .fd-capsule-cell {
        display: grid;
        width: var(--fd-control-standard);
        height: var(--fd-control-standard);
        place-items: center;
        border: 0;
        border-radius: var(--fd-radius-10);
        background: transparent;
        color: var(--color-muted-foreground);
        cursor: pointer;
        transition:
          background-color var(--fd-dur-tacto) var(--fd-ease-tacto),
          color var(--fd-dur-tacto) var(--fd-ease-tacto);
      }
      .fd-capsule-cell svg { width: var(--fd-icon-16); height: var(--fd-icon-16); }
      /* It shows the theme it switches to, as the application's does. */
      :root:not(.dark) .fd-theme-sun, :root.dark .fd-theme-moon { display: none; }

      /* Two unequal spacers leave the form slightly above centre. */
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
        line-height: 1.2;
      }
      form { display: grid; gap: 10px; }

      /* The label stays up and the value has its own band, so nothing moves
         when typing starts. */
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
      /* Inset, so the glow does not eat into the gap above the button. */
      .fd-field-control:focus-within {
        border-color: var(--color-border-active);
        box-shadow: inset 0 0 0 2px var(--color-glow);
      }
      .fd-field-label {
        position: absolute;
        top: 9px;
        left: 12px;
        color: var(--color-muted-foreground);
        font-size: var(--fd-text-label);
        font-weight: var(--fd-weight-label);
        line-height: 1;
        pointer-events: none;
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
      /* Chrome paints autofill in its own colours, white on white in the dark
         palette; a full-height inset shadow keeps the surface ours. */
      .fd-field-value:-webkit-autofill,
      .fd-field-value:-webkit-autofill:focus {
        -webkit-text-fill-color: var(--color-foreground);
        box-shadow: inset 0 0 0 60px var(--color-card);
      }

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
        transition: background-color var(--fd-dur-tacto) var(--fd-ease-tacto);
      }
      .fd-button:active { background-image: linear-gradient(var(--color-pressed) 0 0); }

      @media (hover: hover) {
        .fd-capsule-cell:hover {
          background: var(--color-hover);
          color: var(--color-foreground);
        }
        .fd-field-control:not(:focus-within):hover { border-color: var(--color-border-hover); }
        .fd-button:hover { background-color: var(--color-primary-hover); }
      }

      /* Inside the border, so a focused control never looks larger than its
         neighbour; an outline, because high contrast mode keeps outlines. */
      .fd-focus-ring:focus-visible {
        outline: 2px solid var(--color-focus);
        outline-offset: -2px;
      }
      .fd-button.fd-focus-ring:focus-visible {
        outline-color: var(--color-primary-foreground);
      }

      /* The application's alert line, allowed to wrap: an error nobody can
         read is worse than a notice two lines tall. */
      .fd-alert-line {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        margin: 0;
        min-height: 36px;
        padding: 9px 12px;
        border: 1px solid var(--color-destructive-border);
        border-radius: var(--fd-radius-10);
        background: var(--color-warning-soft);
        color: var(--color-warning-soft-foreground);
        font-size: var(--fd-text-base);
        font-weight: var(--fd-weight-label);
        line-height: 1.35;
      }
      .fd-alert-icon { width: var(--fd-icon-16); height: var(--fd-icon-16); flex-shrink: 0; margin-top: 1px; }

      /* A phone, portrait or sideways: the icon button becomes a touch tile. */
      @media (max-width: 719.98px), (pointer: coarse) and (max-height: 500px) {
        .fd-capsule-cell {
          width: var(--fd-control-touch-sm);
          height: var(--fd-control-touch-sm);
          border: 1px solid var(--color-input);
          background: var(--color-secondary);
          color: var(--color-foreground);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        main { transition: none; }
      }

      /* A theme change never animates: every transition here is on colour. */
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
          ${nextMarkup}
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
        /* iOS ignores interactive-widget, so there the keyboard only shrinks
           the visual viewport: lift the form by a fraction of what it covers.
           Where the meta works nothing is covered and the shift is 0. */
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

        /* Written where the bundle and the server read it, so a theme chosen
           here survives signing in. */
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
