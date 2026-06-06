import { resolveSearchServiceProxyApiToken } from "./service-auth";

const SEARCH_SERVICE_PROXY_HEADER = "x-flydesk-search-proxy";
const DEFAULT_SEARCH_SERVICE_TIMEOUT_MS = 15_000;
const MIN_ENV_SEARCH_SERVICE_TIMEOUT_MS = DEFAULT_SEARCH_SERVICE_TIMEOUT_MS;
const MAX_SEARCH_SERVICE_TIMEOUT_MS = 60_000;

type FetchImpl = typeof fetch;

interface ProxySearchServiceOptions {
  serviceUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
}

function numberFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name] ?? "");
  if (!Number.isFinite(raw)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.trunc(raw)));
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "0:0:0:0:0:0:0:1";
}

export function resolveSearchServiceBaseUrl(input = process.env.FLY_DESK_SEARCH_SERVICE_URL): URL | undefined {
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
  response.headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (normalized === "connection" || normalized === "keep-alive" || normalized === "transfer-encoding") {
      return;
    }
    headers.set(key, value);
  });
  return headers;
}

function summarizeProxyError(error: unknown): string {
  const raw = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
  return raw
    .replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]")
    .slice(0, 240);
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
    error: summarizeProxyError(error),
  });
}

function resolveSearchServiceTimeoutMs(input?: number): number {
  if (typeof input === "number" && Number.isFinite(input)) {
    return Math.max(1, Math.min(MAX_SEARCH_SERVICE_TIMEOUT_MS, Math.trunc(input)));
  }

  return numberFromEnv(
    "FLY_DESK_SEARCH_SERVICE_TIMEOUT_MS",
    DEFAULT_SEARCH_SERVICE_TIMEOUT_MS,
    MIN_ENV_SEARCH_SERVICE_TIMEOUT_MS,
    MAX_SEARCH_SERVICE_TIMEOUT_MS,
  );
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
  if (request.headers.get(SEARCH_SERVICE_PROXY_HEADER) === "1") {
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
  const body = hasBody ? await request.arrayBuffer() : undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), resolveSearchServiceTimeoutMs(options.timeoutMs));
  timeout.unref?.();

  try {
    const response = await (options.fetchImpl ?? fetch)(target, {
      method: request.method,
      headers,
      body,
      signal: controller.signal,
    });

    const responseBody = await response.arrayBuffer();
    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeadersFromProxy(response),
    });
  } catch (error) {
    logSearchServiceProxyFailure(error, target, request, hasApiToken);
    return searchServiceUnavailableResponse();
  } finally {
    clearTimeout(timeout);
  }
}
