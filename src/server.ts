import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { routeRequest } from "./http-router";
import { getPublicRuntimeConfig } from "./search-date-policy";

const publicDir = path.resolve(__dirname, "..", "public");

function contentTypeForExtension(extension: string): string {
  if (extension === ".css") {
    return "text/css; charset=utf-8";
  }

  if (extension === ".js") {
    return "application/javascript; charset=utf-8";
  }

  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }

  return "application/octet-stream";
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

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
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
      const message = error instanceof Error ? error.message : "Unexpected server error";
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: message }));
    }
  });
}
