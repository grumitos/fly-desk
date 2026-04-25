import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { routeRequest } from "./http-router";
import { getPublicRuntimeConfig } from "./search-date-policy";

const publicDir = path.resolve(__dirname, "..", "frontend", "dist");
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

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

function noStoreHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  };
}

async function serveStaticFile(response: ServerResponse, filePath: string): Promise<void> {
  const content = await readFile(filePath);
  const contentType = contentTypeForExtension(path.extname(filePath));

  response.writeHead(200, noStoreHeaders(contentType));
  response.end(content);
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

async function serveIndexHtml(response: ServerResponse): Promise<void> {
  const filePath = path.join(publicDir, "index.html");
  const template = await readFile(filePath, "utf8");
  const runtimeConfig = escapeInlineScriptJson(JSON.stringify(getPublicRuntimeConfig()));
  const content = template.replace(
    "<!-- __FLYDESK_RUNTIME_CONFIG__ -->",
    `<script>window.__FLYDESK_RUNTIME__ = ${runtimeConfig};</script>`,
  );

  response.writeHead(200, noStoreHeaders("text/html; charset=utf-8"));
  response.end(content);
}

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    throw new RequestBodyTooLargeError(MAX_REQUEST_BODY_BYTES);
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const normalized = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += normalized.byteLength;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      throw new RequestBodyTooLargeError(MAX_REQUEST_BODY_BYTES);
    }

    chunks.push(normalized);
  }

  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

function isLoopbackRemoteAddress(value: string | undefined): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "::ffff:127.0.0.1";
}

async function proxyToRouter(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readBody(request);
  const forwardedProto = request.headers["x-forwarded-proto"];
  const isEncryptedSocket = "encrypted" in request.socket && Boolean(request.socket.encrypted);
  const protocol = typeof forwardedProto === "string"
    ? forwardedProto.split(",")[0]?.trim() || "http"
    : isEncryptedSocket
      ? "https"
      : "http";
  const host = request.headers.host ?? "localhost";
  const url = `${protocol}://${host}${request.url ?? "/"}`;
  const headers: [string, string][] = [];

  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      if (key.toLowerCase().startsWith("x-flydesk-")) {
        continue;
      }
      headers.push([key, value]);
    }
  }

  headers.push([
    "x-flydesk-client-loopback",
    isLoopbackRemoteAddress(request.socket.remoteAddress) ? "1" : "0",
  ]);

  if (typeof request.socket.remoteAddress === "string" && request.socket.remoteAddress.length > 0) {
    headers.push(["x-flydesk-client-address", request.socket.remoteAddress]);
  }

  const requestInit: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: new Headers(headers),
    body: body && request.method !== "GET" && request.method !== "HEAD"
      ? new Uint8Array(body)
      : undefined,
    duplex: "half",
  };

  const webRequest = new Request(url, requestInit);

  let webResponse: Response;
  try {
    webResponse = await routeRequest(webRequest);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new BadRequestError("Invalid JSON payload.");
    }
    throw error;
  }

  response.writeHead(
    webResponse.status,
    Object.fromEntries(webResponse.headers.entries()),
  );

  const responseBody = Buffer.from(await webResponse.arrayBuffer());
  response.end(responseBody);
}

export function createServer() {
  return createHttpServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

      if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        await serveIndexHtml(response);
        return;
      }

      if (request.method === "GET") {
        const assetPath = await resolvePublicAsset(pathname);
        if (assetPath) {
          await serveStaticFile(response, assetPath);
          return;
        }
      }

      if (request.method === "GET" && pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }

      await proxyToRouter(request, response);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        response.writeHead(413, noStoreHeaders("application/json; charset=utf-8"));
        response.end(JSON.stringify({ error: error.message }));
        return;
      }

      if (error instanceof BadRequestError) {
        response.writeHead(400, noStoreHeaders("application/json; charset=utf-8"));
        response.end(JSON.stringify({ error: error.message }));
        return;
      }

      const message = error instanceof Error ? error.message : "Unexpected server error";
      response.writeHead(500, noStoreHeaders("application/json; charset=utf-8"));
      response.end(JSON.stringify({ error: message }));
    }
  });
}
