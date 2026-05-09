import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import type { Server as BunServer } from "bun";
import { routeRequest } from "./http-router";
import { logPerfSpan, startPerfTimer } from "./perf";
import { getPublicRuntimeConfig } from "./search-date-policy";

const publicDir = path.resolve(process.cwd(), "frontend", "dist");
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

interface CachedFile {
  filePath: string;
  mtimeMs: number;
  size: number;
  contentType: string;
  content: Buffer;
}

interface CreateServerOptions {
  port?: number;
  hostname?: string;
}

const fileCache = new Map<string, CachedFile>();

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

function noStoreHeaders(contentType: string): Record<string, string> {
  return responseHeaders(contentType, "no-store");
}

function staticAssetHeaders(contentType: string, immutable: boolean): Record<string, string> {
  return responseHeaders(
    contentType,
    immutable ? "public, max-age=31536000, immutable" : "no-cache",
  );
}

async function readCachedFile(filePath: string): Promise<CachedFile> {
  const fileStat = await stat(filePath);
  const cached = fileCache.get(filePath);
  if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
    return cached;
  }

  const content = await readFile(filePath);
  const contentType = contentTypeForExtension(path.extname(filePath));
  const next = {
    filePath,
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    contentType,
    content,
  };
  fileCache.set(filePath, next);
  return next;
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

async function serveStaticFile(filePath: string, immutable: boolean): Promise<Response> {
  const cached = await readCachedFile(filePath);

  return new Response(bufferToArrayBuffer(cached.content), {
    status: 200,
    headers: staticAssetHeaders(cached.contentType, immutable),
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
    const fileStat = await stat(filePath);
    return fileStat.isFile() ? filePath : undefined;
  } catch {
    return undefined;
  }
}

function escapeInlineScriptJson(value: string): string {
  return value.replace(/</g, "\\u003c");
}

async function serveIndexHtml(): Promise<Response> {
  const filePath = path.join(publicDir, "index.html");
  const template = (await readCachedFile(filePath)).content.toString("utf8");
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

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_REQUEST_BODY_BYTES) {
    throw new RequestBodyTooLargeError(MAX_REQUEST_BODY_BYTES);
  }

  return body.byteLength > 0 ? body : undefined;
}

function isLoopbackRemoteAddress(value: string | undefined): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "::ffff:127.0.0.1";
}

async function proxyToRouter(request: Request, server: BunServer<undefined>): Promise<Response> {
  const body = await readBody(request);
  const headers = new Headers();

  request.headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith("x-flydesk-")) {
      return;
    }
    headers.append(key, value);
  });

  const remoteAddress = server.requestIP(request)?.address;
  headers.set(
    "x-flydesk-client-loopback",
    isLoopbackRemoteAddress(remoteAddress) ? "1" : "0",
  );

  if (remoteAddress) {
    headers.set("x-flydesk-client-address", remoteAddress);
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

async function routeServerRequest(request: Request, server: BunServer<undefined>): Promise<Response> {
  const pathname = new URL(request.url).pathname;

  if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    return serveIndexHtml();
  }

  if (request.method === "GET") {
    const assetPath = await resolvePublicAsset(pathname);
    if (assetPath) {
      return serveStaticFile(assetPath, pathname.startsWith("/assets/"));
    }
  }

  if (request.method === "GET" && pathname === "/favicon.ico") {
    return new Response(null, { status: 204 });
  }

  return proxyToRouter(request, server);
}

export async function handleRequest(request: Request, server: BunServer<undefined>): Promise<Response> {
  const requestStart = startPerfTimer();
  const pathname = new URL(request.url).pathname;
  let status = 500;

  try {
    const response = await routeServerRequest(request, server);
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

    const message = error instanceof Error ? error.message : "Unexpected server error";
    status = 500;
    return Response.json(
      { error: message },
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

export function createServer(options: CreateServerOptions = {}): BunServer<undefined> {
  return Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname,
    fetch: handleRequest,
  });
}
