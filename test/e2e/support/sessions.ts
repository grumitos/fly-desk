import { createHmac, randomBytes } from "node:crypto";
import type { BrowserContext, Page } from "playwright";

/*
 * The id a browser keeps in `localStorage` (`frontend/src/lib/browser-client-session.ts`),
 * which its «Recientes» are recorded under.
 */
const BROWSER_CLIENT_ID_KEY = "fly-desk:client-session-id";

/** The id the desk gave the page's browser, or `null` before it gave one. */
export function readBrowserClientId(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), BROWSER_CLIENT_ID_KEY);
}

/** Every page of `context` is the browser `id`, and shows that browser's «Recientes». */
export async function adoptBrowserClientId(context: BrowserContext, id: string): Promise<void> {
  await context.addInitScript(([key, value]) => {
    /* A page's first document, `about:blank`, has no storage to write to. */
    if (location.protocol.startsWith("http")) localStorage.setItem(key, value);
  }, [BROWSER_CLIENT_ID_KEY, id] as const);
}

/*
 * A signed-in session as the web unit writes it, minted with the stack's own
 * secret: the way to hold a session that was signed in minutes ago without
 * waiting minutes. The shapes are the documented cookie contract
 * (`v2.<issuedAtMs>.<expiresAtMs>.<nonce>.<signature>` and the `/r` cookie's
 * `v1.<expiresAtMs>.<nonce>.<signature>`); the server still decides everything
 * from the stamps inside, exactly as it does for a cookie it issued itself.
 */

export const SESSION_COOKIE = "flydesk_session";
export const REDIRECT_COOKIE = "flydesk_redirect_session";

export interface MintedSession {
  session: string;
  redirect: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function mintSession(secret: string, stamps: { issuedAtMs: number; expiresAtMs: number }): MintedSession {
  const nonce = randomBytes(18).toString("base64url");
  const redirectNonce = randomBytes(18).toString("base64url");
  const { issuedAtMs, expiresAtMs } = stamps;
  return {
    session: `v2.${issuedAtMs}.${expiresAtMs}.${nonce}.${sign(secret, `v2.${issuedAtMs}.${expiresAtMs}.${nonce}`)}`,
    redirect: `v1.${expiresAtMs}.${redirectNonce}.${sign(secret, `redirect.${expiresAtMs}.${redirectNonce}`)}`,
    issuedAtMs,
    expiresAtMs,
  };
}

/** The two stamps inside a session cookie value. */
export function readSessionStamps(value: string): { issuedAtMs: number; expiresAtMs: number } | undefined {
  const parts = value.split(".");
  if (parts.length !== 5 || parts[0] !== "v2") return undefined;
  return { issuedAtMs: Number(parts[1]), expiresAtMs: Number(parts[2]) };
}

/** The expiry stamp inside a `/r` cookie value. */
export function readRedirectExpiry(value: string): number | undefined {
  const parts = value.split(".");
  return parts.length === 4 && parts[0] === "v1" ? Number(parts[1]) : undefined;
}
