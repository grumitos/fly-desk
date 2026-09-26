import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/*
 * What `vps-platform/caddy/sites-available/fly-desk.caddy` does in front of the
 * origin, reduced to what the application can observe: `/r/*` goes to the
 * redirect service and everything else to web; the client address is written
 * into X-Real-IP / X-Forwarded-For with X-Forwarded-Proto https; the country
 * headers are dropped, and so are Authorization and X-Flydesk-Api-Token on the
 * way to `/r/*`; bodies over 1 MB answer 413; and a refused dial is retried for
 * 5 s every 250 ms (`lb_try_duration`, `lb_try_interval`), which is what keeps
 * a restarting unit invisible to the browser.
 */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const ALWAYS_STRIPPED = new Set(["x-fly-desk-visitor-country", "x-fly-desk-visitor-country-token", "cf-ipcountry"]);
const REDIRECT_STRIPPED = new Set(["authorization", "x-flydesk-api-token"]);
const MAX_BODY_BYTES = 1024 * 1024;
const RETRY_WINDOW_MS = 5_000;
const RETRY_INTERVAL_MS = 250;

export interface FrontProxy {
  url: string;
  close: () => Promise<void>;
}

export interface FrontProxyOptions {
  webUrl: string;
  redirectUrl: string;
  /** A Chromium-safe port chosen by the caller; 0 lets the OS pick. */
  port?: number;
}

class BodyTooLargeError extends Error {}

function readLimited(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError());
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function clientAddress(request: IncomingMessage): string {
  return (request.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
}

function upstreamHeaders(request: IncomingMessage, toRedirect: boolean, body: Buffer): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const key = name.toLowerCase();
    if (
      value === undefined
      || key === "content-length"
      || HOP_BY_HOP.has(key)
      || ALWAYS_STRIPPED.has(key)
      || (toRedirect && REDIRECT_STRIPPED.has(key))
    ) {
      continue;
    }
    headers[key] = value;
  }

  const client = clientAddress(request);
  headers["x-real-ip"] = client;
  headers["x-forwarded-for"] = client;
  headers["x-forwarded-proto"] = "https";
  headers["x-forwarded-host"] = request.headers.host;
  if (body.length > 0 || !["GET", "HEAD"].includes(request.method ?? "GET")) {
    headers["content-length"] = String(body.length);
  }
  return headers;
}

function downstreamHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const filtered: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) {
      filtered[name] = value;
    }
  }
  return filtered;
}

/* Resolves once the upstream answer has been relayed; rejects only when the
   upstream could not be dialled, which is the one failure worth retrying. */
function forward(
  target: URL,
  request: IncomingMessage,
  response: ServerResponse,
  headers: OutgoingHttpHeaders,
  body: Buffer,
  track: (upstream: ClientRequest) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let answered = false;
    const upstream = httpRequest({
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: request.url,
      headers,
    }, (upstreamResponse) => {
      answered = true;
      response.writeHead(upstreamResponse.statusCode ?? 502, downstreamHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(response);
      upstreamResponse.on("close", resolve);
      upstreamResponse.on("error", () => response.destroy());
    });

    upstream.on("error", (error: NodeJS.ErrnoException) => {
      if (!answered) {
        reject(error);
        return;
      }
      response.destroy();
      resolve();
    });
    track(upstream);
    upstream.end(body);
  });
}

export async function startFrontProxy(options: FrontProxyOptions): Promise<FrontProxy> {
  const web = new URL(options.webUrl);
  const redirect = new URL(options.redirectUrl);

  const server = createServer(async (request, response) => {
    const toRedirect = (request.url ?? "/").startsWith("/r/");
    let body: Buffer;
    try {
      body = await readLimited(request);
    } catch (error) {
      response.writeHead(error instanceof BodyTooLargeError ? 413 : 400).end();
      return;
    }

    const headers = upstreamHeaders(request, toRedirect, body);
    let current: ClientRequest | undefined;
    /* A client that hangs up (a cancelled long poll) takes the upstream call with it. */
    response.on("close", () => {
      if (!response.writableFinished) {
        current?.destroy();
      }
    });
    const deadline = Date.now() + RETRY_WINDOW_MS;
    for (;;) {
      try {
        await forward(toRedirect ? redirect : web, request, response, headers, body, (upstream) => {
          current = upstream;
        });
        return;
      } catch (error) {
        const refused = (error as NodeJS.ErrnoException).code === "ECONNREFUSED";
        if (refused && Date.now() < deadline && !response.destroyed) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
          continue;
        }
        if (!response.headersSent) {
          response.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end("Bad Gateway");
        }
        return;
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
