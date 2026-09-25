import type { CanonicalOffer, MatrixCell, ProviderId } from "../../../src/core/types.ts";

/*
 * A signed-in client for the stack's front proxy: a cookie jar that honours
 * cookie paths (the `/r` session cookie only travels to `/r/*`, as in a
 * browser), and job followers that long-poll the way the UI does.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(method: string, path: string, status: number, body: string) {
    super(`${method} ${path} answered ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

export interface StoredCookie {
  name: string;
  value: string;
  path: string;
}

export class ApiSession {
  readonly baseUrl: string;
  #cookies = new Map<string, StoredCookie>();

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  cookieHeader(pathname = "/"): string {
    return [...this.#cookies.values()]
      .filter(({ path }) => pathname === path || pathname.startsWith(path.endsWith("/") ? path : `${path}/`))
      .map(({ name, value }) => `${name}=${value}`)
      .join("; ");
  }

  /** The jar, for handing the same sign-in to a browser context. */
  cookies(): StoredCookie[] {
    return [...this.#cookies.values()].map((cookie) => ({ ...cookie }));
  }

  /** Never follows redirects: a `/r/<id>` answer is asserted, not visited. */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, this.baseUrl);
    const headers = new Headers(init.headers);
    const cookie = this.cookieHeader(url.pathname);
    if (cookie) {
      headers.set("cookie", cookie);
    }
    const response = await fetch(url, { redirect: "manual", ...init, headers });
    this.#remember(response.headers.getSetCookie());
    return response;
  }

  async json<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const response = await this.fetch(path, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new ApiError(method, path, response.status, text);
    }
    return JSON.parse(text) as T;
  }

  #remember(setCookies: string[]): void {
    for (const header of setCookies) {
      const [pair = "", ...attributes] = header.split(";").map((part) => part.trim());
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      const path = attributes.find((attribute) => /^path=/i.test(attribute))?.slice(5) || "/";
      const maxAge = attributes.find((attribute) => /^max-age=/i.test(attribute))?.slice(8);
      const key = `${name};${path}`;
      if (!value || (maxAge !== undefined && Number(maxAge) <= 0)) {
        this.#cookies.delete(key);
      } else {
        this.#cookies.set(key, { name, value, path });
      }
    }
  }
}

/**
 * `GET /r/<id>` until the redirect service can resolve it. The runner writes
 * purchase paths to SQLite on a 180 ms debounce and the redirect service waits
 * up to `FLY_DESK_REDIRECT_CACHE_LOOKUP_TIMEOUT_MS` (1000 ms by default) for
 * the row, so a 404 here is retried rather than trusted until `timeoutMs`.
 */
export async function openPurchasePath(
  session: ApiSession,
  path: string,
  timeoutMs = 2_000,
): Promise<{ response: Response; waitedMs: number }> {
  const startedAt = Date.now();
  for (;;) {
    const response = await session.fetch(path);
    if (response.status !== 404 || Date.now() - startedAt >= timeoutMs) {
      return { response, waitedMs: Date.now() - startedAt };
    }
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function signIn(baseUrl: string, password: string): Promise<ApiSession> {
  const session = new ApiSession(baseUrl);
  await session.json("POST", "/api/auth/login", { password });
  if (!session.cookieHeader("/r/probe").includes("flydesk_redirect_session=")) {
    throw new Error("Sign-in did not issue the /r session cookie.");
  }
  return session;
}

export interface SearchJob {
  searchJobId: string;
  searchComplete: boolean;
  searchStatus: string;
  revision: number;
  unchanged?: boolean;
  offers?: CanonicalOffer[];
  allOffers?: CanonicalOffer[];
  warnings?: string[];
  error?: string;
  searchMeta?: { partial?: boolean; searchState?: string };
}

export interface MatrixJob {
  matrixJobId: string;
  matrixComplete: boolean;
  matrixStatus: string;
  revision: number;
  unchanged?: boolean;
  cells?: MatrixCell[];
  warnings?: string[];
  error?: string;
}

/** One published revision, as a poller saw it. */
export interface JobRevision {
  elapsedMs: number;
  revision: number;
  status: string;
  results: number;
  providers: ProviderId[];
}

function providersOf(sources: Array<{ providerSource?: ProviderId } | undefined>): ProviderId[] {
  return [...new Set(sources.flatMap((source) => source?.providerSource ? [source.providerSource] : []))].sort();
}

export function searchOffers(job: SearchJob): CanonicalOffer[] {
  return job.allOffers ?? job.offers ?? [];
}

export function matrixOffers(job: MatrixJob): CanonicalOffer[] {
  return (job.cells ?? []).flatMap((cell) => cell.offer ? [cell.offer] : []);
}

async function follow<T extends { revision: number; unchanged?: boolean }>(
  started: T,
  poll: (job: T) => Promise<T>,
  complete: (job: T) => boolean,
  describe: (job: T) => Omit<JobRevision, "elapsedMs">,
  timeoutMs: number,
): Promise<{ job: T; revisions: JobRevision[] }> {
  const startedAt = Date.now();
  const revisions: JobRevision[] = [{ elapsedMs: 0, ...describe(started) }];
  let job = started;
  while (!complete(job)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Job still ${describe(job).status} after ${timeoutMs}ms (revision ${job.revision}).`);
    }
    const next = await poll(job);
    if (!next.unchanged) {
      job = next;
      revisions.push({ elapsedMs: Date.now() - startedAt, ...describe(job) });
    }
  }
  return { job, revisions };
}

/** Long-polls `GET /api/search/:id` as the UI does (`sinceRevision`, `wait=15000`). */
export function followSearchJob(session: ApiSession, started: SearchJob, timeoutMs = 60_000) {
  return follow(
    started,
    (job) => session.json<SearchJob>("GET", `/api/search/${encodeURIComponent(job.searchJobId)}?sinceRevision=${job.revision}&wait=15000`),
    (job) => job.searchComplete,
    (job) => ({ revision: job.revision, status: job.searchStatus, results: searchOffers(job).length, providers: providersOf(searchOffers(job)) }),
    timeoutMs,
  );
}

export function followMatrixJob(session: ApiSession, started: MatrixJob, timeoutMs = 60_000) {
  return follow(
    started,
    (job) => session.json<MatrixJob>("GET", `/api/matrix/${encodeURIComponent(job.matrixJobId)}?sinceRevision=${job.revision}&wait=15000`),
    (job) => job.matrixComplete,
    (job) => ({ revision: job.revision, status: job.matrixStatus, results: matrixOffers(job).length, providers: providersOf(matrixOffers(job)) }),
    timeoutMs,
  );
}
