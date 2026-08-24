import { isIP } from "node:net";
import * as path from "node:path";
import type { Server as BunServer } from "bun";
import { ensureAirlineMark } from "./airline-mark-store";
import { routeRequest } from "./http-router";
import { logPerfSpan, startPerfTimer } from "./perf";
import { getPublicRuntimeConfig } from "./search-date-policy";
import {
  hasValidWebSession,
  isWebAuthEnabled,
  loginPageLocation,
  renderLoginPage,
  renewWebSessionCookies,
  resolveSafeNextPath,
  resolveWebTheme,
} from "./web-auth";

const publicDir = path.resolve(process.cwd(), "frontend", "dist");
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const LOGIN_CLIENT_IP_HEADER = "x-fly-desk-login-client-ip";
const DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS = 120;
const MAX_SERVER_IDLE_TIMEOUT_SECONDS = 255;

interface CreateServerOptions {
  port?: number;
  hostname?: string;
  idleTimeoutSeconds?: number;
}

class RequestBodyTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(`Request body exceeds the ${limitBytes} byte limit.`);
  }
}

class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function contentTypeForExtension(extension: string): string {
  if (extension === ".svg") {
    return "image/svg+xml; charset=utf-8";
  }

  if (extension === ".ico") {
    return "image/x-icon";
  }

  if (extension === ".png") {
    return "image/png";
  }

  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }

  if (extension === ".webp") {
    return "image/webp";
  }

  if (extension === ".gif") {
    return "image/gif";
  }

  if (extension === ".css") {
    return "text/css; charset=utf-8";
  }

  if (extension === ".js") {
    return "application/javascript; charset=utf-8";
  }

  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }

  if (extension === ".woff2") {
    return "font/woff2";
  }

  if (extension === ".woff") {
    return "font/woff";
  }

  if (extension === ".ttf") {
    return "font/ttf";
  }

  if (extension === ".json") {
    return "application/json; charset=utf-8";
  }

  return "application/octet-stream";
}

function responseHeaders(contentType: string, cacheControl: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  };
}

function redirect(location: string, status = 302): Response {
  return new Response(null, {
    status,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
    },
  });
}

function withWebSessionRenewal(request: Request, response: Response): Response {
  const renewal = renewWebSessionCookies(request);
  if (renewal) {
    response.headers.append("Set-Cookie", renewal.sessionCookie);
    response.headers.append("Set-Cookie", renewal.redirectSessionCookie);
  }
  return response;
}

function noStoreHeaders(contentType: string): Record<string, string> {
  return responseHeaders(contentType, "no-store");
}

function staticAssetHeaders(contentType: string, immutable: boolean): Record<string, string> {
  return responseHeaders(
    contentType,
    immutable ? "public, max-age=31536000, immutable" : "no-cache",
  );
}

async function serveStaticFile(filePath: string, immutable: boolean): Promise<Response> {
  const file = Bun.file(filePath);
  const contentType = file.type || contentTypeForExtension(path.extname(filePath));

  return new Response(file, {
    status: 200,
    headers: staticAssetHeaders(contentType, immutable),
  });
}

async function resolvePublicAsset(pathname: string): Promise<string | undefined> {
  const normalizedPath = pathname.replace(/^\/+/, "");
  if (!normalizedPath) {
    return undefined;
  }

  const filePath = path.resolve(publicDir, normalizedPath);
  if (!filePath.startsWith(`${publicDir}${path.sep}`) && filePath !== publicDir) {
    return undefined;
  }

  try {
    return await Bun.file(filePath).exists() ? filePath : undefined;
  } catch {
    return undefined;
  }
}

const AIRLINE_MARK_PATH_PATTERN = /^\/assets\/airline-icons\/([A-Z0-9]{2})\.png$/;

async function resolveHarvestedAirlineMark(pathname: string): Promise<string | undefined> {
  const code = AIRLINE_MARK_PATH_PATTERN.exec(pathname)?.[1];
  return code ? ensureAirlineMark(code) : undefined;
}

function escapeInlineScriptJson(value: string): string {
  return value.replace(/</g, "\\u003c");
}

async function serveIndexHtml(): Promise<Response> {
  const filePath = path.join(publicDir, "index.html");
  const template = await Bun.file(filePath).text();
  const runtimeConfig = escapeInlineScriptJson(JSON.stringify(getPublicRuntimeConfig()));
  const content = template.replace(
    "<!-- __FLYDESK_RUNTIME_CONFIG__ -->",
    `<script>window.__FLYDESK_RUNTIME__ = ${runtimeConfig};</script>`,
  );

  return new Response(content, {
    status: 200,
    headers: noStoreHeaders("text/html; charset=utf-8"),
  });
}

async function readBody(request: Request): Promise<ArrayBuffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    throw new RequestBodyTooLargeError(MAX_REQUEST_BODY_BYTES);
  }

  if (!request.body) {
    return undefined;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (!value || value.byteLength === 0) {
      continue;
    }

    totalBytes += value.byteLength;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel();
      throw new RequestBodyTooLargeError(MAX_REQUEST_BODY_BYTES);
    }

    chunks.push(value);
  }

  if (totalBytes === 0) {
    return undefined;
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body.buffer;
}

function isLoopbackRemoteAddress(value: string | undefined): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "::ffff:127.0.0.1";
}

function resolveClientAddress(request: Request, remoteAddress: string | undefined): string | undefined {
  if (!isLoopbackRemoteAddress(remoteAddress)) {
    return remoteAddress;
  }

  const loginClientAddress = request.headers.get(LOGIN_CLIENT_IP_HEADER)?.trim();
  return loginClientAddress && isIP(loginClientAddress) !== 0
    ? loginClientAddress
    : remoteAddress;
}

function parseRequestUrl(request: Request): URL {
  try {
    return new URL(request.url);
  } catch {
    throw new BadRequestError("Malformed request URL.");
  }
}

async function proxyToRouter(request: Request, server: BunServer<undefined>): Promise<Response> {
  const body = await readBody(request);
  const headers = new Headers();

  request.headers.forEach((value, key) => {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.startsWith("x-flydesk-") || normalizedKey === LOGIN_CLIENT_IP_HEADER) {
      return;
    }
    headers.append(key, value);
  });

  const remoteAddress = server.requestIP(request)?.address;
  const clientAddress = resolveClientAddress(request, remoteAddress);
  headers.set(
    "x-flydesk-client-loopback",
    isLoopbackRemoteAddress(remoteAddress) ? "1" : "0",
  );

  if (clientAddress) {
    headers.set("x-flydesk-client-address", clientAddress);
  }

  const requestInit: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    body,
    duplex: body ? "half" : undefined,
  };

  let webResponse: Response;
  try {
    webResponse = await routeRequest(new Request(request.url, requestInit));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new BadRequestError("Invalid JSON payload.");
    }
    throw error;
  }

  return webResponse;
}

async function routeServerRequest(request: Request, server: BunServer<undefined>, url: URL): Promise<Response> {
  const pathname = url.pathname;

  if (request.method === "GET" && pathname === "/login") {
    const next = resolveSafeNextPath(url.searchParams.get("next"));

    if (!isWebAuthEnabled()) {
      return redirect(next ?? "/");
    }

    if (hasValidWebSession(request)) {
      return redirect(next ?? "/");
    }

    const error = url.searchParams.get("error")
      ? "Password invalido."
      : undefined;
    return new Response(renderLoginPage(error, resolveWebTheme(request), next), {
      status: 200,
      headers: noStoreHeaders("text/html; charset=utf-8"),
    });
  }

  if (
    isWebAuthEnabled()
    && request.method === "GET"
    && (pathname === "/" || pathname === "/index.html")
    && !hasValidWebSession(request)
  ) {
    /* The query string is the whole of a shared search link, so the gate
       carries it and hands it back after the sign-in rather than dropping
       the user on an empty workspace. */
    return redirect(loginPageLocation(`${pathname}${url.search}`));
  }

  if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    /* Loading the workspace is activity too, so a session more than half
       spent slides forward here as well as on the API calls. */
    return withWebSessionRenewal(request, await serveIndexHtml());
  }

  if (request.method === "GET") {
    const assetPath = await resolvePublicAsset(pathname);
    if (assetPath) {
      return serveStaticFile(assetPath, pathname.startsWith("/assets/"));
    }

    /* A carrier the release has no mark for: the provider that returned the
       flight also publishes the artwork, so it is fetched once here and is a
       local file from then on. Only after the release has been asked, so a
       bundled mark is never reached for over the network. */
    const harvestedMark = await resolveHarvestedAirlineMark(pathname);
    if (harvestedMark) {
      return serveStaticFile(harvestedMark, true);
    }
  }

  if (request.method === "GET" && pathname === "/favicon.ico") {
    return new Response(null, { status: 204 });
  }

  return proxyToRouter(request, server);
}

export async function handleRequest(request: Request, server: BunServer<undefined>): Promise<Response> {
  const requestStart = startPerfTimer();
  let pathname = "<malformed>";
  let status = 500;

  try {
    const url = parseRequestUrl(request);
    pathname = url.pathname;
    const response = await routeServerRequest(request, server, url);
    status = response.status;
    return response;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      status = 413;
      return Response.json(
        { error: error.message },
        { status, headers: noStoreHeaders("application/json; charset=utf-8") },
      );
    }

    if (error instanceof BadRequestError) {
      status = 400;
      return Response.json(
        { error: error.message },
        { status, headers: noStoreHeaders("application/json; charset=utf-8") },
      );
    }

    console.error("Fly Desk request failed", {
      method: request.method,
      path: pathname,
      errorName: error instanceof Error ? error.name : "Error",
    });
    status = 500;
    return Response.json(
      { error: "Unexpected server error." },
      { status, headers: noStoreHeaders("application/json; charset=utf-8") },
    );
  } finally {
    logPerfSpan("http.request", requestStart, {
      method: request.method,
      path: pathname,
      status,
    });
  }
}

export function resolveServerIdleTimeoutSeconds(
  input = process.env.FLY_DESK_SERVER_IDLE_TIMEOUT_SECONDS,
): number {
  const normalized = String(input ?? "").trim();
  if (!normalized) {
    return DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS;
  }

  return Math.max(0, Math.min(MAX_SERVER_IDLE_TIMEOUT_SECONDS, Math.trunc(parsed)));
}

export function createServer(options: CreateServerOptions = {}): BunServer<undefined> {
  return Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname,
    idleTimeout: options.idleTimeoutSeconds ?? resolveServerIdleTimeoutSeconds(),
    fetch: handleRequest,
  });
}
