/*
 * Bun preload for every process of the E2E stack, worker children included
 * (the stack hands it over through `BUN_OPTIONS`, which Bun reads in every
 * process it starts). Provider origins are rewritten to the fake upstream,
 * loopback passes through, and anything else throws: no test reaches the
 * internet. Nothing here may write to stdout, which is the worker protocol.
 */
import { basename } from "node:path";
import {
  BLOCKED_EGRESS_PATH,
  CALLER_HEADER,
  FAKE_UPSTREAM_ENV,
  formatCaller,
  isLoopbackHostname,
  ORIGIN_HEADER,
  PROVIDER_ORIGIN_TAGS,
} from "./provider-origins.ts";

const configuredUpstream = process.env[FAKE_UPSTREAM_ENV]?.trim() ?? "";
if (!configuredUpstream || !isLoopbackHostname(new URL(configuredUpstream).hostname)) {
  throw new Error(`${FAKE_UPSTREAM_ENV} must point at the loopback fake upstream.`);
}

const upstream = configuredUpstream.replace(/\/+$/, "");
const portValue = Number(process.env.PORT ?? process.env.FLY_DESK_REDIRECT_PORT);
const caller = formatCaller({
  script: basename(process.argv[1] ?? "bun"),
  port: Number.isInteger(portValue) && portValue > 0 ? portValue : undefined,
  pid: process.pid,
});
const passthroughFetch = globalThis.fetch;
const PassthroughWebSocket = globalThis.WebSocket;

function blockEgress(kind: string, target: URL): Error {
  process.stderr.write(`[e2e-egress] blocked ${kind} to ${target.origin}${target.pathname} from ${caller}\n`);
  void passthroughFetch(`${upstream}${BLOCKED_EGRESS_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", [CALLER_HEADER]: caller },
    body: JSON.stringify({ kind, origin: target.origin, path: target.pathname }),
  }).catch(() => undefined);
  return new Error(`E2E egress blocked: ${target.origin} is not a known provider origin.`);
}

function targetOf(input: RequestInfo | URL): URL {
  if (input instanceof Request) {
    return new URL(input.url);
  }

  return new URL(input instanceof URL ? input.href : String(input));
}

async function guardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const target = targetOf(input);
  if ((target.protocol !== "http:" && target.protocol !== "https:") || isLoopbackHostname(target.hostname)) {
    return passthroughFetch(input, init);
  }

  const tag = PROVIDER_ORIGIN_TAGS[target.origin];
  if (!tag) {
    throw blockEgress("fetch", target);
  }

  const rewritten = `${upstream}/${tag}${target.pathname}${target.search}`;
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  headers.set(CALLER_HEADER, caller);
  headers.set(ORIGIN_HEADER, target.origin);
  return passthroughFetch(
    input instanceof Request ? new Request(rewritten, input) : rewritten,
    { ...init, headers },
  );
}

/* `preconnect` would open a socket to the real host, so it becomes a no-op. */
globalThis.fetch = Object.assign(guardedFetch, {
  preconnect: (_url: string | URL) => undefined,
}) as typeof fetch;

class GuardedWebSocket extends PassthroughWebSocket {
  constructor(...args: ConstructorParameters<typeof WebSocket>) {
    const target = new URL(String(args[0]));
    if (!isLoopbackHostname(target.hostname)) {
      throw blockEgress("websocket", target);
    }
    super(...args);
  }
}

globalThis.WebSocket = GuardedWebSocket as typeof WebSocket;
