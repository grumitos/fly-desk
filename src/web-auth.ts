import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const WEB_SESSION_COOKIE_NAME = "flydesk_session";
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

function resolveWebPassword(): string | undefined {
  return readEnv("FLY_DESK_WEB_PASSWORD");
}

export function getWebAuthConfigError(): string | undefined {
  if (!isWebAuthEnabled()) {
    return undefined;
  }

  const sessionSecret = resolveWebSessionSecret();
  if (!sessionSecret || sessionSecret.length < 32) {
    return "FLY_DESK_WEB_SESSION_SECRET must be set to at least 32 characters.";
  }

  if (!resolveWebPasswordHash() && !resolveWebPassword()) {
    return "FLY_DESK_WEB_PASSWORD_HASH or FLY_DESK_WEB_PASSWORD must be set.";
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
  const [, saltValue, expectedValue] = encodedHash.split(":");
  if (!saltValue || !expectedValue) {
    return false;
  }

  const salt = Buffer.from(saltValue, "base64url");
  const expected = Buffer.from(expectedValue, "base64url");
  if (salt.length < 8 || expected.length < 16 || expected.length > 128) {
    return false;
  }

  const actual = scryptSync(password, salt, expected.length);
  return safeEqual(actual, expected);
}

function verifySha256Password(password: string, encodedHash: string): boolean {
  const expectedHex = encodedHash.slice("sha256:".length).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedHex)) {
    return false;
  }

  const actualHex = createHash("sha256").update(password, "utf8").digest("hex");
  return safeEqualString(actualHex, expectedHex);
}

export function verifyWebPassword(password: string): PasswordVerificationResult {
  const configError = getWebAuthConfigError();
  if (configError) {
    return { ok: false, configError };
  }

  const encodedHash = resolveWebPasswordHash();
  if (encodedHash?.startsWith("scrypt:")) {
    return { ok: verifyScryptPassword(password, encodedHash) };
  }

  if (encodedHash?.startsWith("sha256:")) {
    return { ok: verifySha256Password(password, encodedHash) };
  }

  const configuredPassword = resolveWebPassword();
  if (configuredPassword) {
    return { ok: safeEqualString(password, configuredPassword) };
  }

  return { ok: false, configError: "Unsupported web password configuration." };
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

export function clearWebSessionCookie(request: Request): string {
  const secure = isCookieSecure(request) ? "; Secure" : "";
  return `${WEB_SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`;
}

export function hasValidWebSession(request: Request, nowMs = Date.now()): boolean {
  if (!isWebAuthEnabled()) {
    return false;
  }

  const secret = resolveWebSessionSecret();
  if (!secret) {
    return false;
  }

  const session = parseCookies(request.headers.get("cookie")).get(WEB_SESSION_COOKIE_NAME);
  const parts = session?.split(".") ?? [];
  if (parts.length !== 4 || parts[0] !== "v1") {
    return false;
  }

  const expiresAtMs = Number(parts[1]);
  const nonce = parts[2];
  const signature = parts[3];
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs || !nonce || !signature) {
    return false;
  }

  const expected = signSessionPayload(expiresAtMs, nonce, secret);
  return safeEqualString(signature, expected);
}

export function resolveWebTheme(request: Request): WebTheme {
  const theme = parseCookies(request.headers.get("cookie")).get(WEB_THEME_COOKIE_NAME);
  return theme === "dark" || theme === "light" ? theme : DEFAULT_WEB_THEME;
}

export function renderLoginPage(error?: string, theme: WebTheme = DEFAULT_WEB_THEME): string {
  const errorMarkup = error
    ? `<p class="error">${escapeHtml(error)}</p>`
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
      :root {
        color-scheme: light;
        --background: #f8f8f6;
        --foreground: #121212;
        --field-background: #ffffff;
        --muted: #7b7974;
        --border: #1f1f1e26;
        --input: #1f1f1e26;
        --primary: #d97757;
        --primary-foreground: #ffffff;
        --danger: #7a2e18;
        --ring: #d97757;
        --keyboard-shift: 0px;
        font-family: Inter, "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: var(--background);
        color: var(--foreground);
      }
      :root.dark {
        color-scheme: dark;
        --background: #1f1f1e;
        --foreground: #f8f8f6;
        --field-background: #2c2c2a;
        --muted: #97958c;
        --border: #e2e1da26;
        --input: #e2e1da26;
        --danger: #f2c3b3;
        --ring: #d97757;
      }
      *, *::before, *::after { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; overflow: hidden; overscroll-behavior: none; }
      html { background: var(--background); }
      body {
        position: fixed;
        inset: 0;
        margin: 0;
        display: grid;
        place-items: center;
        overflow: clip;
        background: var(--background);
        color: var(--foreground);
        padding:
          calc(20px + env(safe-area-inset-top, 0px))
          calc(16px + env(safe-area-inset-right, 0px))
          calc(20px + env(safe-area-inset-bottom, 0px))
          calc(16px + env(safe-area-inset-left, 0px));
        text-rendering: geometricPrecision;
        -webkit-font-smoothing: antialiased;
      }
      main {
        width: min(100%, 344px);
        max-height: 100%;
        display: grid;
        gap: 20px;
        justify-items: stretch;
        transform: translateY(calc(var(--keyboard-shift) * -1));
        transition: transform 220ms ease;
      }
      .brand {
        display: grid;
        justify-items: center;
        gap: 10px;
      }
      .brand-icon {
        width: 34px;
        height: 34px;
        color: var(--primary);
      }
      h1 {
        margin: 0;
        font-size: 22px;
        line-height: 1;
        font-weight: 700;
        letter-spacing: 0;
      }
      form {
        display: grid;
        gap: 12px;
        width: 100%;
      }
      .field {
        position: relative;
        display: block;
      }
      .floating-label {
        position: absolute;
        left: 12px;
        top: 50%;
        transform: translateY(-50%);
        color: var(--muted);
        pointer-events: none;
        transition:
          color 160ms ease,
          font-size 160ms ease,
          font-weight 160ms ease,
          top 160ms ease,
          transform 160ms ease;
        font-size: 13px;
        font-weight: 500;
        line-height: 1;
      }
      .field:focus-within .floating-label,
      .field input:-webkit-autofill + .floating-label,
      .field input:not(:placeholder-shown) + .floating-label {
        top: 8px;
        transform: none;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
      }
      .field:focus-within .floating-label {
        color: var(--foreground);
      }
      input {
        width: 100%;
        height: 48px;
        border: 1px solid var(--input);
        border-radius: 8px;
        background: var(--field-background);
        color: var(--foreground);
        padding: 17px 12px 5px;
        font: inherit;
        font-size: 14px;
        transition:
          border-color 160ms ease,
          box-shadow 160ms ease,
          background-color 160ms ease;
      }
      .field:hover input {
        border-color: color-mix(in srgb, var(--primary) 38%, var(--input));
      }
      input:focus {
        outline: 2px solid var(--ring);
        outline-offset: 2px;
        border-color: color-mix(in srgb, var(--primary) 50%, var(--input));
      }
      button {
        height: 44px;
        border: 0;
        border-radius: 8px;
        background: var(--primary);
        color: var(--primary-foreground);
        padding: 0 14px;
        font: inherit;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
      }
      button:hover { filter: brightness(0.98); }
      button:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
      .error {
        margin: 0;
        border-left: 2px solid var(--primary);
        color: var(--danger);
        padding: 2px 0 2px 10px;
        font-size: 13px;
        line-height: 1.4;
      }
      @media (max-height: 440px) {
        main { gap: 14px; }
        .brand-icon { width: 30px; height: 30px; }
        h1 { font-size: 20px; }
      }
      @media (prefers-reduced-motion: reduce) {
        main { transition: none; }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="brand" aria-label="Fly Desk">
        <svg class="brand-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M21.96 3.05c.76-.3 1.51.42 1.25 1.19l-5.36 15.7c-.26.77-1.24.98-1.79.38l-4.2-4.57-2.45 3.43c-.47.66-1.5.44-1.67-.36l-1.02-4.9-4.52-1.5c-.84-.28-.88-1.46-.05-1.78l19.81-7.59ZM19.46 6.45l-10.3 6.2 3.25 1.07 7.05-7.27Zm-5.94 8.62 2.86 3.13 2.75-8.12-5.61 4.99Z"/>
        </svg>
        <h1>Fly Desk</h1>
      </div>
      <form method="post" action="/login">
        ${errorMarkup}
        <label class="field" for="password">
          <input id="password" name="password" type="password" autocomplete="current-password" placeholder=" " required autofocus>
          <span class="floating-label">Contraseña</span>
        </label>
        <button type="submit">Entrar</button>
      </form>
    </main>
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
