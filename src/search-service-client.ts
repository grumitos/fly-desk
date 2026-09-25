import { resolveSearchServiceProxyApiToken } from "./service-auth";
import { envNumber } from "./env";

export const SEARCH_SERVICE_PROXY_HEADER = "x-flydesk-search-proxy";
const DEFAULT_SEARCH_SERVICE_TIMEOUT_MS = 15_000;
const MIN_ENV_SEARCH_SERVICE_TIMEOUT_MS = DEFAULT_SEARCH_SERVICE_TIMEOUT_MS;
export const MAX_SEARCH_SERVICE_TIMEOUT_MS = 60_000;
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type FetchImpl = typeof fetch;

interface ProxySearchServiceOptions {
  serviceUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "0:0:0:0:0:0:0:1";
}

function resolveSearchServiceBaseUrl(input = process.env.FLY_DESK_SEARCH_SERVICE_URL): URL | undefined {
  const raw = input?.trim();
  if (!raw) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== "http:" || !isLoopbackHostname(parsed.hostname)) {
    return undefined;
  }

  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed;
}

/* The header the web unit stamps on what it hands to the runner. The runner
   reads it to know that the request is already accounted for upstream — the
   location-usage ranking is written by the process that serves it, not by the
   one that happens to execute the search. */
export function isSearchServiceProxiedRequest(request: Request): boolean {
  return request.headers.get(SEARCH_SERVICE_PROXY_HEADER) === "1";
}

export function isSearchServiceDelegationConfigured(): boolean {
  return Boolean(resolveSearchServiceBaseUrl());
}

export function isSearchServiceRoute(method: string, pathname: string): boolean {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "POST" && pathname === "/api/search") {
    return true;
  }
  if (normalizedMethod === "POST" && pathname === "/api/matrix") {
    return true;
  }
  if (normalizedMethod === "POST" && pathname === "/api/quotation") {
    return true;
  }
  if (normalizedMethod === "GET" && pathname === "/api/provider-status") {
    return true;
  }
  if (normalizedMethod === "GET" && /^\/api\/search\/[^/]+$/.test(pathname)) {
    return true;
  }
  if (normalizedMethod === "GET" && /^\/api\/matrix\/[^/]+$/.test(pathname)) {
    return true;
  }
  if (normalizedMethod === "POST" && /^\/api\/search\/[^/]+\/cancel$/.test(pathname)) {
    return true;
  }
  if (normalizedMethod === "POST" && /^\/api\/matrix\/[^/]+\/cancel$/.test(pathname)) {
    return true;
  }

  return false;
}

function joinTargetPath(basePathname: string, requestPathname: string): string {
  const normalizedBase = basePathname === "/" ? "" : basePathname.replace(/\/+$/, "");
  return `${normalizedBase}${requestPathname}`;
}

function responseHeadersFromProxy(response: Response): Headers {
  const headers = new Headers();
  const connectionHeaders = new Set(
    (response.headers.get("connection") ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  response.headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (HOP_BY_HOP_RESPONSE_HEADERS.has(normalized) || connectionHeaders.has(normalized)) {
      return;
    }
    headers.set(key, value);
  });
  return headers;
}

function logSearchServiceProxyFailure(
  error: unknown,
  target: URL,
  request: Request,
  hasApiToken: boolean,
): void {
  console.warn("Fly Desk search service proxy failed", {
    method: request.method,
    path: target.pathname,
    target: target.origin,
    apiTokenConfigured: hasApiToken,
    errorKind: error instanceof Error && error.name === "AbortError"
      ? "request_aborted"
      : "request_failed",
  });
}

function resolveSearchServiceTimeoutMs(input?: number): number {
  if (typeof input === "number" && Number.isFinite(input)) {
    return Math.max(1, Math.min(MAX_SEARCH_SERVICE_TIMEOUT_MS, Math.trunc(input)));
  }

  return Math.trunc(envNumber(
    "FLY_DESK_SEARCH_SERVICE_TIMEOUT_MS",
    DEFAULT_SEARCH_SERVICE_TIMEOUT_MS,
    { min: MIN_ENV_SEARCH_SERVICE_TIMEOUT_MS, max: MAX_SEARCH_SERVICE_TIMEOUT_MS },
  ));
}

/**
 * How long this hop waits. A job poll carries `wait=<ms>`, and the runner holds
 * the answer for that long, so the hold is added to the base budget. A
 * quotation revalidates the fare with a live provider search, which gets the
 * whole ceiling: the runner stops it before this hop gives up.
 */
export function resolveProxyTimeoutMsForRequest(url: URL, configured?: number): number {
  if (url.pathname === "/api/quotation") {
    return MAX_SEARCH_SERVICE_TIMEOUT_MS;
  }

  const base = resolveSearchServiceTimeoutMs(configured);
  const requestedWait = Number.parseInt(url.searchParams.get("wait") ?? "", 10);
  if (!Number.isFinite(requestedWait) || requestedWait <= 0) {
    return base;
  }

  return Math.min(MAX_SEARCH_SERVICE_TIMEOUT_MS, base + requestedWait);
}

/* A runner that is restarting refuses connections for a moment. A read is
   asked once more after this pause; a write is never sent twice. */
const REFUSED_READ_RETRY_DELAY_MS = 500;

function isConnectionRefused(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ConnectionRefused" || code === "ECONNREFUSED";
}

async function fetchSearchService(
  fetchImpl: FetchImpl,
  target: URL,
  init: RequestInit,
  isRead: boolean,
): Promise<Response> {
  try {
    return await fetchImpl(target, init);
  } catch (error) {
    if (!isRead || !isConnectionRefused(error)) {
      throw error;
    }
  }

  await new Promise((resolve) => setTimeout(resolve, REFUSED_READ_RETRY_DELAY_MS));
  return fetchImpl(target, init);
}

function searchServiceUnavailableResponse(): Response {
  return Response.json(
    { error: "Search service is unavailable." },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}

export async function maybeProxySearchServiceRequest(
  request: Request,
  url: URL,
  options: ProxySearchServiceOptions = {},
): Promise<Response | undefined> {
  if (isSearchServiceProxiedRequest(request)) {
    return undefined;
  }

  if (!isSearchServiceRoute(request.method, url.pathname)) {
    return undefined;
  }

  const serviceBaseUrl = resolveSearchServiceBaseUrl(options.serviceUrl);
  if (!serviceBaseUrl) {
    return undefined;
  }

  const target = new URL(serviceBaseUrl.toString());
  target.pathname = joinTargetPath(serviceBaseUrl.pathname, url.pathname);
  target.search = url.search;

  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  const accept = request.headers.get("accept");
  const cookie = request.headers.get("cookie");
  const apiToken = resolveSearchServiceProxyApiToken();
  const hasApiToken = Boolean(apiToken);

  if (contentType) {
    headers.set("content-type", contentType);
  }
  if (accept) {
    headers.set("accept", accept);
  }
  if (cookie) {
    headers.set("cookie", cookie);
  }
  if (apiToken) {
    headers.set("x-flydesk-api-token", apiToken);
    headers.set("authorization", `Bearer ${apiToken}`);
  }
  headers.set(SEARCH_SERVICE_PROXY_HEADER, "1");

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? request.body : undefined;
  const requestInit: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    body,
    signal: AbortSignal.timeout(resolveProxyTimeoutMsForRequest(url, options.timeoutMs)),
    duplex: body ? "half" : undefined,
  };

  try {
    const response = await fetchSearchService(options.fetchImpl ?? fetch, target, requestInit, request.method === "GET");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeadersFromProxy(response),
    });
  } catch (error) {
    logSearchServiceProxyFailure(error, target, request, hasApiToken);
    return searchServiceUnavailableResponse();
  }
}
