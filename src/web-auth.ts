import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const WEB_SESSION_COOKIE_NAME = "flydesk_session";

const DEFAULT_WEB_SESSION_TTL_SECONDS = 12 * 60 * 60;
const MIN_WEB_SESSION_TTL_SECONDS = 5 * 60;
const MAX_WEB_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const SCRYPT_KEY_BYTES = 32;

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
  return readEnv("FLY_DESK_TRUST_LOOPBACK_CLIENT") !== "0";
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

export function renderLoginPage(error?: string): string {
  const errorMarkup = error
    ? `<p class="error">${escapeHtml(error)}</p>`
    : "";

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Fly Desk</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #101820; color: #f8fafc; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #101820; }
      main { width: min(92vw, 360px); }
      h1 { margin: 0 0 24px; font-size: 40px; line-height: 1; letter-spacing: 0; }
      form { display: grid; gap: 14px; }
      label { display: grid; gap: 8px; color: #cbd5e1; font-size: 14px; }
      input { width: 100%; border: 1px solid #334155; border-radius: 8px; background: #0f172a; color: #f8fafc; padding: 12px 14px; font: inherit; }
      input:focus { outline: 2px solid #38bdf8; outline-offset: 2px; }
      button { border: 0; border-radius: 8px; background: #14b8a6; color: #042f2e; padding: 12px 14px; font: inherit; font-weight: 700; cursor: pointer; }
      button:focus-visible { outline: 2px solid #99f6e4; outline-offset: 2px; }
      .error { margin: 0 0 16px; color: #fecaca; }
    </style>
  </head>
  <body>
    <main>
      <h1>Fly Desk</h1>
      ${errorMarkup}
      <form method="post" action="/login">
        <label>
          Password
          <input name="password" type="password" autocomplete="current-password" required autofocus>
        </label>
        <button type="submit">Entrar</button>
      </form>
    </main>
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
