import { Database } from "bun:sqlite";
import type { Server as BunServer } from "bun";
import { timingSafeEqual } from "node:crypto";
import type { ProviderContext, PurchasePath, SearchRequest } from "./core/types";
import {
  applyCostamarContextToBrandedSearchUrl,
  resolveCostamarRedirectForRequest,
} from "./local-costamar";
import {
  normalizeCostamarProviderContext,
  resolveUsableCostamarBrandedToken,
} from "./provider-context";
import { resolvePersistPath } from "./runtime-paths";
import { COMPLETED_SEARCH_SESSION_TTL_MS } from "./session-store";
import {
  hasValidWebSession,
  isWebAuthEnabled,
  shouldTrustLoopbackClient,
  shouldTrustReverseProxyLoopbackClient,
} from "./web-auth";

const DEFAULT_REDIRECT_HOST = "127.0.0.1";
const DEFAULT_REDIRECT_PORT = 32124;
const DEFAULT_COSTAMAR_REDIRECT_TOTAL_TIMEOUT_MS = 55_000;
const MAX_COSTAMAR_REDIRECT_TOTAL_TIMEOUT_MS = 240_000;
const DEFAULT_CACHE_LOOKUP_TIMEOUT_MS = 1_000;
const MAX_CACHE_LOOKUP_TIMEOUT_MS = 5_000;

interface StoredPurchasePath {
  sessionId: string;
  ownerId: string;
  path: PurchasePath;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
}

interface StoredJobPayload {
  id: string;
  request?: SearchRequest;
  providerContext?: ProviderContext;
  status?: string;
  lastAccessedAt?: string;
  updatedAt?: string;
}

interface StoredRedirectRecord {
  purchasePath: StoredPurchasePath;
  job?: StoredJobPayload;
  idleAtMs?: number;
}

interface SqlPayloadRow {
  payload: string;
}

interface SqlJobRow extends SqlPayloadRow {
  idle_at_ms?: number;
}

export interface RedirectServiceOptions {
  dbPath?: string;
  cacheLookupTimeoutMs?: number;
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(init?.headers ?? {}),
    },
  });
}

function html(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    status: init?.status ?? 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      ...(init?.headers ?? {}),
    },
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function costamarRedirectBlockedResponse(reason?: string): Response {
  const reasonText = reason?.trim() ? escapeHtml(reason.trim()) : "No se pudo validar ni renovar el redirect de Click and Book Plus.";
  return html(`<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Renueva la sesion de Click and Book Plus</title>
    <style>
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      html { min-height: 100%; }
      body {
        margin: 0;
        min-height: 100dvh;
        overflow: hidden;
        display: grid;
        place-items: center;
        padding: 20px;
        font-family: "Segoe UI", Arial, sans-serif;
        background: #f8f8f6;
        color: #2d2a26;
      }
      main { width: min(560px, 100%); max-width: 560px; }
      section {
        background: rgba(255, 255, 255, 0.92);
        border: 1px solid rgba(112, 77, 31, 0.12);
        border-radius: 12px;
        padding: 24px;
        box-shadow: 0 20px 45px rgba(88, 59, 24, 0.08);
      }
      h1 { margin: 0 0 12px; font-size: 28px; line-height: 1.15; }
      p { margin: 0 0 12px; line-height: 1.55; }
      p:last-child { margin-bottom: 0; }
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>Renueva la sesion de Click and Book Plus</h1>
        <p>Fly Desk no encontro un redirect verificado para abrir esta busqueda en Click and Book Plus.</p>
        <p><strong>Motivo:</strong> ${reasonText}</p>
        <p>Abre Click and Book Plus B2B/Chrome, confirma que la sesion este activa y vuelve a intentar desde Fly Desk.</p>
      </section>
    </main>
  </body>
</html>`, { status: 409 });
}

function numberFromEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]?.trim() ?? "");
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function costamarRedirectTotalTimeoutMs(): number {
  const configured = Number(
    process.env.CBPLUS_REDIRECT_TOTAL_TIMEOUT_MS?.trim()
      ?? process.env.COSTAMAR_REDIRECT_TOTAL_TIMEOUT_MS
      ?? DEFAULT_COSTAMAR_REDIRECT_TOTAL_TIMEOUT_MS,
  );
  if (!Number.isFinite(configured)) {
    return DEFAULT_COSTAMAR_REDIRECT_TOTAL_TIMEOUT_MS;
  }

  return Math.max(
    1_000,
    Math.min(MAX_COSTAMAR_REDIRECT_TOTAL_TIMEOUT_MS, Math.trunc(configured)),
  );
}

async function withCostamarRedirectTotalTimeout<T>(promise: Promise<T>): Promise<T> {
  const timeoutMs = costamarRedirectTotalTimeoutMs();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`La validacion del redirect de Click and Book Plus tardo mas de ${timeoutMs}ms.`));
        }, timeoutMs);
        if (typeof timeout === "object" && timeout && "unref" in timeout) {
          (timeout as { unref: () => void }).unref();
        }
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function parseJsonPayload<T>(payload: string | undefined): T | undefined {
  if (!payload) {
    return undefined;
  }

  try {
    return JSON.parse(payload) as T;
  } catch {
    return undefined;
  }
}

function getSql<T>(db: Database, sql: string, ...params: any[]): T | undefined {
  const statement = db.prepare(sql);
  try {
    return statement.get(...params) as T | undefined;
  } finally {
    statement.finalize();
  }
}

function openReadOnlyDatabase(dbPath: string): Database {
  const db = new Database(dbPath, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 1000;");
  } catch {
    // A read-only redirect can still proceed without the pragma.
  }
  return db;
}

function resolveSessionDbPath(explicit?: string): string | undefined {
  return explicit?.trim() || resolvePersistPath("FLY_DESK_SESSION_DB_PATH", "fly-desk-cache.sqlite");
}

function readStoredRedirectRecord(dbPath: string, purchasePathId: string): StoredRedirectRecord | undefined {
  const db = openReadOnlyDatabase(dbPath);
  try {
    const pathRow = getSql<SqlPayloadRow>(
      db,
      "SELECT payload FROM purchase_paths WHERE id = ? LIMIT 1",
      purchasePathId,
    );
    const purchasePath = parseJsonPayload<StoredPurchasePath>(pathRow?.payload);
    if (!purchasePath?.path?.id || purchasePath.path.id !== purchasePathId) {
      return undefined;
    }

    const searchJobRow = getSql<SqlJobRow>(
      db,
      "SELECT idle_at_ms, payload FROM search_jobs WHERE id = ? LIMIT 1",
      purchasePath.sessionId,
    );
    if (searchJobRow?.payload) {
      return {
        purchasePath,
        job: parseJsonPayload<StoredJobPayload>(searchJobRow.payload),
        idleAtMs: Number(searchJobRow.idle_at_ms ?? 0) || undefined,
      };
    }

    const matrixJobRow = getSql<SqlJobRow>(
      db,
      "SELECT idle_at_ms, payload FROM matrix_jobs WHERE id = ? LIMIT 1",
      purchasePath.sessionId,
    );
    if (matrixJobRow?.payload) {
      return {
        purchasePath,
        job: parseJsonPayload<StoredJobPayload>(matrixJobRow.payload),
        idleAtMs: Number(matrixJobRow.idle_at_ms ?? 0) || undefined,
      };
    }

    return undefined;
  } finally {
    db.close(true);
  }
}

async function waitForStoredRedirectRecord(
  dbPath: string,
  purchasePathId: string,
  timeoutMs: number,
): Promise<StoredRedirectRecord | undefined> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const record = readStoredRedirectRecord(dbPath, purchasePathId);
    if (record) {
      return record;
    }

    if (Date.now() >= deadline) {
      return undefined;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function isExpiredRedirectRecord(record: StoredRedirectRecord): boolean {
  if (!record.idleAtMs || COMPLETED_SEARCH_SESSION_TTL_MS <= 0) {
    return false;
  }

  return Date.now() - record.idleAtMs > COMPLETED_SEARCH_SESSION_TTL_MS;
}

function isIsoDateValue(value: string | undefined): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function passengerCountFromPath(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function exactCostamarRequestFromFallback(fallback: SearchRequest | undefined): SearchRequest | undefined {
  const leg = fallback?.legs[0];
  if (!fallback || !leg || fallback.tripType === "multi-city" || !isIsoDateValue(leg.departureDate)) {
    return undefined;
  }

  if (fallback.tripType === "round-trip" && !isIsoDateValue(leg.returnDate)) {
    return undefined;
  }

  return {
    ...fallback,
    providerId: "costamar",
    searchMode: "exact",
    flexibleMode: undefined,
    legs: [
      {
        ...leg,
        departureStart: undefined,
        departureEnd: undefined,
        returnStart: undefined,
        returnEnd: undefined,
        stayNights: undefined,
        minNights: undefined,
        maxNights: undefined,
      },
    ],
  };
}

function costamarRedirectRequestFromUrl(
  location: string,
  fallback: SearchRequest | undefined,
): SearchRequest | undefined {
  try {
    const parsed = new URL(location);
    const pathParts = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
    const markerIndex = pathParts.lastIndexOf("b");
    if (markerIndex < 0) {
      return exactCostamarRequestFromFallback(fallback);
    }

    const parts = pathParts.slice(markerIndex + 1);
    if (parts.length !== 6 && parts.length !== 7) {
      return exactCostamarRequestFromFallback(fallback);
    }

    const isRoundTrip = parts.length === 7;
    const origin = parts[0]?.trim().toUpperCase();
    const destination = parts[1]?.trim().toUpperCase();
    const departureDate = parts[2]?.trim();
    const returnDate = isRoundTrip ? parts[3]?.trim() : undefined;
    const passengerOffset = isRoundTrip ? 4 : 3;
    const fallbackPassengers = fallback?.passengers ?? { adults: 1, children: 0, infants: 0 };

    if (!origin || !destination || !isIsoDateValue(departureDate)) {
      return exactCostamarRequestFromFallback(fallback);
    }

    if (isRoundTrip && !isIsoDateValue(returnDate)) {
      return exactCostamarRequestFromFallback(fallback);
    }

    const fallbackLeg = fallback?.legs[0];
    return {
      providerId: "costamar",
      tripType: isRoundTrip ? "round-trip" : "one-way",
      searchMode: "exact",
      legs: [
        {
          ...(fallbackLeg ?? {}),
          origin,
          destination,
          departureDate,
          departureStart: undefined,
          departureEnd: undefined,
          returnDate,
          returnStart: undefined,
          returnEnd: undefined,
          stayNights: undefined,
          minNights: undefined,
          maxNights: undefined,
        },
      ],
      passengers: {
        adults: passengerCountFromPath(parts[passengerOffset], fallbackPassengers.adults || 1),
        children: passengerCountFromPath(parts[passengerOffset + 1], fallbackPassengers.children || 0),
        infants: passengerCountFromPath(parts[passengerOffset + 2], fallbackPassengers.infants || 0),
      },
      cabin: fallback?.cabin ?? "ECONOMY",
      filters: fallback?.filters ?? {},
      coverageMode: fallback?.coverageMode ?? "core",
      redirectMode: fallback?.redirectMode ?? "best-effort",
      currencyCode: fallback?.currencyCode ?? "USD",
      locale: fallback?.locale ?? "es-PE",
      market: fallback?.market ?? "PE",
    };
  } catch {
    return exactCostamarRequestFromFallback(fallback);
  }
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
    },
  });
}

function hasForwardedClientMarker(request: Request): boolean {
  return Boolean(
    request.headers.get("x-forwarded-for")?.trim()
      || request.headers.get("forwarded")?.trim()
      || request.headers.get("x-real-ip")?.trim(),
  );
}

function isTrustedLocalRequest(request: Request): boolean {
  if (!shouldTrustLoopbackClient() || request.headers.get("x-flydesk-client-loopback") !== "1") {
    return false;
  }

  if (hasForwardedClientMarker(request) && !shouldTrustReverseProxyLoopbackClient()) {
    return false;
  }

  return true;
}

function resolveConfiguredApiAccessToken(): string | undefined {
  const configured = String(process.env.FLY_DESK_API_TOKEN ?? "").trim();
  return configured || undefined;
}

function resolveProvidedApiAccessToken(request: Request): string | undefined {
  const tokenHeader = String(request.headers.get("x-flydesk-api-token") ?? "").trim();
  if (tokenHeader) {
    return tokenHeader;
  }

  const authorizationHeader = String(request.headers.get("authorization") ?? "").trim();
  if (authorizationHeader.toLowerCase().startsWith("bearer ")) {
    const bearer = authorizationHeader.slice("bearer ".length).trim();
    return bearer || undefined;
  }

  return undefined;
}

function hasValidApiAccessToken(request: Request, expectedToken: string): boolean {
  const providedToken = resolveProvidedApiAccessToken(request);
  if (!providedToken) {
    return false;
  }

  const expected = Buffer.from(expectedToken, "utf8");
  const provided = Buffer.from(providedToken, "utf8");
  if (expected.length !== provided.length) {
    return false;
  }

  return timingSafeEqual(expected, provided);
}

function isTrustedRedirectRequest(request: Request): boolean {
  if (isTrustedLocalRequest(request)) {
    return true;
  }

  if (hasValidWebSession(request)) {
    return true;
  }

  const token = resolveConfiguredApiAccessToken();
  return token ? hasValidApiAccessToken(request, token) : false;
}

function redirectAuthRequiredResponse(): Response {
  if (isWebAuthEnabled()) {
    return json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  return json(
    { error: "This endpoint requires localhost access or a valid API token." },
    { status: 403 },
  );
}

async function resolveRedirectResponse(record: StoredRedirectRecord): Promise<Response> {
  const path = record.purchasePath.path;
  if (path.url) {
    let location = path.url;

    if (path.provider === "costamar" && path.type === "search-redirect") {
      const sessionContext = record.job?.providerContext?.costamar;
      let canRedirect = false;
      let blockedReason: string | undefined;

      try {
        const parsed = new URL(location);
        const parsedTerminalId = parsed.searchParams.get("terminalId")?.trim() || undefined;
        const parsedLang = parsed.searchParams.get("lang")?.trim() || undefined;
        const parsedToken = parsed.searchParams.get("token")?.trim() || undefined;
        const terminalId = parsedTerminalId || sessionContext?.terminalId;
        const lang = parsedLang || sessionContext?.lang;
        const parsedTokenIsUsable = Boolean(resolveUsableCostamarBrandedToken(parsedToken, terminalId));
        const fastContext = normalizeCostamarProviderContext({
          ...(sessionContext ?? {}),
          ...(terminalId ? { terminalId } : {}),
          ...(lang ? { lang } : {}),
          token: parsedTokenIsUsable ? parsedToken : sessionContext?.token,
        });
        const redirectRequest = costamarRedirectRequestFromUrl(location, record.job?.request);

        if (redirectRequest) {
          const redirectResolution = await withCostamarRedirectTotalTimeout(
            resolveCostamarRedirectForRequest(redirectRequest, fastContext, {
              force: !parsedTokenIsUsable,
              validateLive: true,
              forceOnUnverified: true,
            }),
          );
          blockedReason = redirectResolution.redirectVerification.reason;
          if (redirectResolution.redirectVerification.verified) {
            location = applyCostamarContextToBrandedSearchUrl(location, redirectResolution.context);
            canRedirect = true;
          }
        } else {
          blockedReason = "No se pudo reconstruir la busqueda Click and Book Plus desde el purchase path.";
        }
      } catch (error) {
        blockedReason = error instanceof Error ? error.message : "No se pudo validar el redirect de Click and Book Plus.";
        canRedirect = false;
      }

      if (!canRedirect) {
        return costamarRedirectBlockedResponse(blockedReason);
      }
    }

    return redirect(location);
  }

  if (path.referenceText) {
    return new Response(path.referenceText, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  return json({ error: "Purchase path is unavailable." }, { status: 410 });
}

export async function routeRedirectRequest(request: Request, options: RedirectServiceOptions = {}): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/health") {
    return json({ ok: true, service: "fly-desk-redirect" });
  }

  if (request.method !== "GET" || !url.pathname.startsWith("/r/")) {
    return json({ error: "Not found." }, { status: 404 });
  }

  if (!isTrustedRedirectRequest(request)) {
    return redirectAuthRequiredResponse();
  }

  const dbPath = resolveSessionDbPath(options.dbPath);
  if (!dbPath) {
    return json({ error: "Redirect cache is not configured." }, { status: 503 });
  }

  const purchasePathId = url.pathname.slice(3);
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(purchasePathId)) {
    return json({ error: "Purchase path not found." }, { status: 404 });
  }

  const lookupTimeoutMs = options.cacheLookupTimeoutMs
    ?? numberFromEnv(
      "FLY_DESK_REDIRECT_CACHE_LOOKUP_TIMEOUT_MS",
      DEFAULT_CACHE_LOOKUP_TIMEOUT_MS,
      0,
      MAX_CACHE_LOOKUP_TIMEOUT_MS,
    );
  let record: StoredRedirectRecord | undefined;
  try {
    record = lookupTimeoutMs > 0
      ? await waitForStoredRedirectRecord(dbPath, purchasePathId, lookupTimeoutMs)
      : readStoredRedirectRecord(dbPath, purchasePathId);
  } catch {
    return json({ error: "Redirect cache is unavailable." }, { status: 503 });
  }

  if (!record || isExpiredRedirectRecord(record)) {
    return json({ error: "Purchase path not found." }, { status: 404 });
  }

  return resolveRedirectResponse(record);
}

export function resolveRedirectServerHost(): string {
  return process.env.FLY_DESK_REDIRECT_HOST?.trim() || DEFAULT_REDIRECT_HOST;
}

export function resolveRedirectServerPort(): number {
  return numberFromEnv("FLY_DESK_REDIRECT_PORT", DEFAULT_REDIRECT_PORT, 1, 65535);
}

export function createRedirectServer(options: {
  port?: number;
  hostname?: string;
  dbPath?: string;
} = {}): BunServer<undefined> {
  return Bun.serve({
    port: options.port ?? resolveRedirectServerPort(),
    hostname: options.hostname ?? resolveRedirectServerHost(),
    fetch: (request) => routeRedirectRequest(request, { dbPath: options.dbPath }),
  });
}
