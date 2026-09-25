/*
 * Shared by the Bun preload (inside every process of the stack) and by the
 * Node-side fake upstream: the provider origins the stack may reach, each with
 * the path prefix the fake serves it under. An origin missing here is blocked.
 */
export const FAKE_UPSTREAM_ENV = "FLY_DESK_E2E_FAKE_UPSTREAM";
export const CALLER_HEADER = "x-fly-desk-e2e-caller";
export const ORIGIN_HEADER = "x-fly-desk-e2e-origin";
export const BLOCKED_EGRESS_PATH = "/__e2e/blocked";
/* Where `AGIL_BROWSER_URL` points: a Chrome fallback that probes it gets a 404. */
export const FAKE_CDP_PATH = "/__cdp";

export const PROVIDER_ORIGIN_TAGS: Readonly<Record<string, string>> = {
  "https://motorvuelos.expertiatravel.com": "agil",
  "https://www.agilsmart.com": "agil-web",
  "https://agilsmart.com": "agil-web",
  "https://air-search-service-zneith.zdev.tech": "cbplus-search",
  "https://test-api-zneith.zdev.tech": "cbplus-search",
  "https://api-zneith.zdev.tech": "cbplus-api",
  "https://commons-service-b-zneith.zdev.tech": "cbplus-markup",
  "https://flights.zdev.tech": "cbplus-brand",
  "https://booking.clickandbook.com": "cbplus-booking",
  "https://b2b.clickandbook.com": "cbplus-b2b",
  "https://free.e-api.net.pe": "exchange-rate",
  "https://static.costamar.com.pe": "airline-marks",
};

export interface Caller {
  script: string;
  port?: number;
  pid: number;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized === "::1"
    || normalized === "127.0.0.1"
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

/* `<script>:<port>#<pid>`, as the preload stamps it. Workers inherit the
   runner's PORT, which is what ties a worker to the runner that spawned it. */
export function formatCaller(caller: Caller): string {
  return `${caller.script}:${caller.port ?? "-"}#${caller.pid}`;
}

export function parseCaller(value: string | null | undefined): Caller | undefined {
  const match = /^(.+):(\d+|-)#(\d+)$/.exec(String(value ?? "").trim());
  if (!match) {
    return undefined;
  }

  return {
    script: match[1]!,
    port: match[2] === "-" ? undefined : Number(match[2]),
    pid: Number(match[3]),
  };
}
