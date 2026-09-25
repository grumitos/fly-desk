/*
 * A provider request under one deadline, sent once more when it got no answer.
 *
 * Bun's fetch keeps an idle connection pooled until the far end closes it, and
 * can hand it out again while that close is on its way: the request then dies
 * with ECONNRESET before any response, the busier the host the more often.
 * Measured in isolation against a server closing idle connections, one more
 * attempt on a connection of its own recovered every request that died so.
 */

/* The provider sent nothing back: the connection failed before any response arrived. */
export class ProviderUnansweredError extends Error {
  override name = "ProviderUnansweredError";
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

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
