import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { routeRequest } from "./http-router";

const publicDir = path.resolve(__dirname, "..", "public");

async function serveStaticFile(response: ServerResponse, fileName: string): Promise<void> {
  const filePath = path.join(publicDir, fileName);
  const content = await readFile(filePath);
  const extension = path.extname(fileName);
  const contentType = extension === ".css"
    ? "text/css; charset=utf-8"
    : extension === ".js"
      ? "application/javascript; charset=utf-8"
      : "text/html; charset=utf-8";

  response.writeHead(200, { "Content-Type": contentType });
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
        await serveStaticFile(response, "index.html");
        return;
      }

      if (request.method === "GET" && pathname === "/app.css") {
        await serveStaticFile(response, "app.css");
        return;
      }

      if (request.method === "GET" && pathname === "/app.js") {
        await serveStaticFile(response, "app.js");
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
