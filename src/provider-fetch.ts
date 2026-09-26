/*
 * A provider request under one deadline, sent once more when it got no answer.
 *
 * Bun's fetch keeps an idle connection pooled until the far end closes it, and
 * can hand it out again while that close is on its way: the request then dies
 * with ECONNRESET before any response, the busier the host the more often.
 * Measured in isolation against a server closing idle connections, one more
 * attempt on a connection of its own recovered every request that died so.
 *
 * A request also belongs to the search that asked for it. The search's stop
 * signal travels in an async context (`withProviderJobSignal`), so the fan-out
 * code between a job and its requests does not carry it: a stopped search
 * aborts the requests it has in flight and sends no new one.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/* The provider sent nothing back: the connection failed before any response arrived. */
export class ProviderUnansweredError extends Error {
  override name = "ProviderUnansweredError";
}

/* The search the request belonged to was stopped: it was aborted, or never sent. */
export class ProviderRequestCancelledError extends Error {
  override name = "ProviderRequestCancelledError";

  constructor(label: string) {
    super(`${label} was stopped with its search.`);
  }
}

const providerJobSignal = new AsyncLocalStorage<AbortSignal>();

/** Runs a search's provider work under its stop signal. */
export function withProviderJobSignal<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  return providerJobSignal.run(signal, run);
}

/** The stop signal of the search this code runs for, if it runs for one. */
export function currentProviderJobSignal(): AbortSignal | undefined {
  return providerJobSignal.getStore();
}

/*
 * Runs work that several searches share — a token mint, cached engine
 * metadata — outside any one search's signal: stopping the search that happened
 * to start it must not fail the others waiting on it.
 */
export function outsideProviderJob<T>(run: () => T): T {
  return providerJobSignal.exit(run);
}

export function isProviderRequestCancelled(error: unknown): boolean {
  return error instanceof ProviderRequestCancelledError
    || (error instanceof Error && error.cause instanceof ProviderRequestCancelledError);
}

export interface ProviderFetchOptions {
  /** Names the request in its errors and in the service log: «Agil search GDS 3». */
  label: string;
  /** One deadline for both attempts and for reading the body. */
  timeoutMs: number;
}

/*
 * The request, its body read under the same deadline: headers that arrive
 * before a body that stalls would otherwise hold the caller indefinitely. A
 * request that fails before any response arrives is sent once more, on a new
 * connection, within that deadline; an answer, an error status included, and
 * the deadline are final. Only for a request that is safe to send twice: the
 * one that got no answer most likely never reached the provider, but a
 * provider that read it before the connection died would read it again.
 */
export async function fetchProvider(url: string, init: RequestInit, options: ProviderFetchOptions): Promise<Response> {
  const jobSignal = providerJobSignal.getStore();
  const cancelled = () => new ProviderRequestCancelledError(options.label);
  if (jobSignal?.aborted) {
    throw cancelled();
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const abortWithJob = () => controller.abort();
  jobSignal?.addEventListener("abort", abortWithJob, { once: true });

  const attempt = async (connection: "pooled" | "new"): Promise<Response> => {
    let response: Response | undefined;
    try {
      response = await fetch(url, {
        ...init,
        signal: controller.signal,
        /* Bun's per-request way out of the connection pool. */
        ...(connection === "new" ? { keepalive: false } : {}),
      });
      const body = await response.arrayBuffer();
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      if (jobSignal?.aborted) {
        throw cancelled();
      }

      /* The transport error stays as the cause: the public reason is built
         from the message, and the service log names what actually failed. */
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new Error(`${options.label} timed out after ${options.timeoutMs}ms`, { cause: error });
      }

      if (response) {
        throw new Error(`${options.label} failed while reading the response.`, { cause: error });
      }

      throw new ProviderUnansweredError(`${options.label} failed before receiving a response.`, { cause: error });
    }
  };

  try {
    return await attempt("pooled");
  } catch (error) {
    if (!(error instanceof ProviderUnansweredError)) {
      throw error;
    }

    console.warn(`${options.label} sent again on a new connection: ${describeErrorChain(error.cause)}`);
    return await attempt("new");
  } finally {
    clearTimeout(timeout);
    jobSignal?.removeEventListener("abort", abortWithJob);
  }
}

/*
 * An error and the causes behind it, one `name[code]: message` a link, for the
 * service log. A SyntaxError keeps only its name: a JSON parse error quotes
 * the provider's body, and nothing a provider said belongs in a log.
 */
export function describeErrorChain(error: unknown): string {
  const links: string[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && links.length < 4) {
    if (!(current instanceof Error)) {
      links.push(typeof current);
      break;
    }

    const code = (current as { code?: unknown }).code;
    const name = typeof code === "string" && code ? `${current.name}[${code}]` : current.name;
    links.push(current instanceof SyntaxError ? name : `${name}: ${current.message}`);
    current = current.cause;
  }

  return links.join(" <- ").replace(/\s+/g, " ").slice(0, 400);
}
