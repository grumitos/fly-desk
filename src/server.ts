import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { routeRequest } from "./http-router";
import { getPublicRuntimeConfig } from "./search-date-policy";

const publicDir = path.resolve(__dirname, "..", "public");
const MAX_JSON_BODY_BYTES = Math.max(
  1024,
  Number(process.env.FLYDESK_MAX_JSON_BODY_BYTES ?? 256 * 1024),
);
const BODY_READ_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.FLYDESK_BODY_READ_TIMEOUT_MS ?? 15000),
);
const HTTP_REQUEST_TIMEOUT_MS = Math.max(
  BODY_READ_TIMEOUT_MS,
  Number(process.env.FLYDESK_REQUEST_TIMEOUT_MS ?? 30000),
);

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};

class RequestBodyTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes.`);
    this.name = "RequestBodyTooLargeError";
  }
}

class RequestBodyTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Request body read timed out after ${timeoutMs}ms.`);
    this.name = "RequestBodyTimeoutError";
  }
}

function contentTypeForExtension(extension: string): string {
  return CONTENT_TYPE_BY_EXTENSION[extension] ?? "application/octet-stream";
}

function noStoreHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
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

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer | undefined> {
  const declaredLength = Number(request.headers["content-length"] ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RequestBodyTooLargeError(maxBytes);
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const bodyTimeout = setTimeout(() => {
    request.destroy(new RequestBodyTimeoutError(BODY_READ_TIMEOUT_MS));
  }, BODY_READ_TIMEOUT_MS);

  try {
    for await (const chunk of request) {
      const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += nextChunk.byteLength;
      if (totalBytes > maxBytes) {
        throw new RequestBodyTooLargeError(maxBytes);
      }

      chunks.push(nextChunk);
    }
  } catch (error) {
    if (error instanceof RequestBodyTimeoutError || error instanceof RequestBodyTooLargeError) {
      throw error;
    }

    if (error instanceof Error && error.name === "AbortError") {
      throw new RequestBodyTimeoutError(BODY_READ_TIMEOUT_MS);
    }

    throw error;
  } finally {
    clearTimeout(bodyTimeout);
  }

  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

async function proxyToRouter(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readBody(request, MAX_JSON_BODY_BYTES);
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
      headers.push([key, value]);
    }
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

  const webResponse = await routeRequest(webRequest);

  response.writeHead(
    webResponse.status,
    Object.fromEntries(webResponse.headers.entries()),
  );

  const responseBody = Buffer.from(await webResponse.arrayBuffer());
  response.end(responseBody);
}

export function createServer() {
  const server = createHttpServer(async (request, response) => {
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
        response.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({
          errors: [`Request body exceeds ${error.maxBytes} bytes.`],
        }));
        return;
      }

      if (error instanceof RequestBodyTimeoutError) {
        response.writeHead(408, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({
          errors: [`Request body read timed out after ${error.timeoutMs}ms.`],
        }));
        return;
      }

      const message = error instanceof Error ? error.message : "Unexpected server error";
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ errors: [message] }));
    }
  });

  server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  server.headersTimeout = Math.max(server.headersTimeout, HTTP_REQUEST_TIMEOUT_MS + 5000);
  return server;
}
