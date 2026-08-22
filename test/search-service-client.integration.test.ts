import assert from "node:assert/strict";
import {
  isSearchServiceRoute,
  maybeProxySearchServiceRequest,
  resolveProxyTimeoutMsForRequest,
  resolveSearchServiceBaseUrl,
} from "../src/search-service-client";
import { resolveSearchServiceProxyApiToken } from "../src/service-auth";

function overrideEnv(values: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

test("search service base URL only accepts loopback HTTP targets", () => {
  assert.equal(resolveSearchServiceBaseUrl("https://127.0.0.1:8101"), undefined);
  assert.equal(resolveSearchServiceBaseUrl("http://example.com:8101"), undefined);
  assert.equal(resolveSearchServiceBaseUrl("not-a-url"), undefined);
  assert.equal(resolveSearchServiceBaseUrl("http://127.0.0.1:8101")?.toString(), "http://127.0.0.1:8101/");
  assert.equal(resolveSearchServiceBaseUrl("http://localhost:8101/search")?.toString(), "http://localhost:8101/search");
});

test("search service route detection includes provider status and quotation sessions owned by the runner", () => {
  assert.equal(isSearchServiceRoute("POST", "/api/search"), true);
  assert.equal(isSearchServiceRoute("GET", "/api/search/job-1"), true);
  assert.equal(isSearchServiceRoute("POST", "/api/search/job-1/cancel"), true);
  assert.equal(isSearchServiceRoute("POST", "/api/matrix"), true);
  assert.equal(isSearchServiceRoute("GET", "/api/matrix/job-1"), true);
  assert.equal(isSearchServiceRoute("POST", "/api/matrix/job-1/cancel"), true);
  assert.equal(isSearchServiceRoute("POST", "/api/quotation"), true);
  assert.equal(isSearchServiceRoute("GET", "/api/provider-status"), true);

  assert.equal(isSearchServiceRoute("POST", "/api/provider-status"), false);

  assert.equal(isSearchServiceRoute("GET", "/api/health"), false);
  assert.equal(isSearchServiceRoute("GET", "/api/locations"), false);
  assert.equal(isSearchServiceRoute("POST", "/api/auth/login"), false);
  assert.equal(isSearchServiceRoute("GET", "/r/path-id"), false);
});

test("search service proxy forwards provider status reads to the configured runner", async () => {
  const restoreEnv = overrideEnv({
    FLY_DESK_API_TOKEN: "test-api-token",
    FLY_DESK_SEARCH_SERVICE_API_TOKEN: undefined,
  });

  try {
    let forwardedUrl = "";
    let forwardedMethod = "";
    const request = new Request("http://fly-desk.test/api/provider-status", {
      headers: {
        Accept: "application/json",
        Cookie: "flydesk_session=test",
      },
    });
    const response = await maybeProxySearchServiceRequest(request, new URL(request.url), {
      serviceUrl: "http://127.0.0.1:8101",
      fetchImpl: async (input, init) => {
        forwardedUrl = String(input);
        forwardedMethod = String(init?.method ?? "");
        return Response.json({ providers: [] }, {
          headers: { "Cache-Control": "no-store" },
        });
      },
    });

    assert.equal(response?.status, 200);
    assert.deepEqual(await response?.json(), { providers: [] });
    assert.equal(response?.headers.get("cache-control"), "no-store");
    assert.equal(forwardedUrl, "http://127.0.0.1:8101/api/provider-status");
    assert.equal(forwardedMethod, "GET");
  } finally {
    restoreEnv();
  }
});

test("search service proxy forwards search requests to the configured runner", async () => {
  const restoreEnv = overrideEnv({
    FLY_DESK_API_TOKEN: "test-api-token",
    FLY_DESK_SEARCH_SERVICE_API_TOKEN: undefined,
  });

  try {
    let forwardedUrl = "";
    let forwardedMethod = "";
    let forwardedBody = "";
    let forwardedHeaders = new Headers();
    const request = new Request("http://fly-desk.test/api/search?sinceRevision=4", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Cookie": "flydesk_session=test",
      },
      body: JSON.stringify({ route: "LIM-MAD" }),
    });
    const response = await maybeProxySearchServiceRequest(request, new URL(request.url), {
      serviceUrl: "http://127.0.0.1:8101",
      timeoutMs: 1_000,
      fetchImpl: async (input, init) => {
        forwardedUrl = String(input);
        forwardedMethod = String(init?.method ?? "");
        forwardedHeaders = new Headers(init?.headers);
        forwardedBody = await new Response(init?.body).text();
        return Response.json({ ok: true }, { status: 202 });
      },
    });

    assert.equal(response?.status, 202);
    assert.deepEqual(await response?.json(), { ok: true });
    assert.equal(forwardedUrl, "http://127.0.0.1:8101/api/search?sinceRevision=4");
    assert.equal(forwardedMethod, "POST");
    assert.equal(forwardedBody, "{\"route\":\"LIM-MAD\"}");
    assert.equal(forwardedHeaders.get("accept"), "application/json");
    assert.equal(forwardedHeaders.get("content-type"), "application/json");
    assert.equal(forwardedHeaders.get("cookie"), "flydesk_session=test");
    assert.equal(forwardedHeaders.get("x-flydesk-api-token"), "test-api-token");
    assert.equal(forwardedHeaders.get("authorization"), "Bearer test-api-token");
    assert.equal(forwardedHeaders.get("x-flydesk-search-proxy"), "1");
  } finally {
    restoreEnv();
  }
});

test("search service proxy forwards the request stream without calling arrayBuffer", async () => {
  const request = new Request("http://fly-desk.test/api/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: "{\"route\":\"LIM-MAD\"}",
  });
  let arrayBufferCalls = 0;
  Object.defineProperty(request, "arrayBuffer", {
    value: async () => {
      arrayBufferCalls += 1;
      throw new Error("proxied request must not be buffered again");
    },
  });

  let forwardedBody = "";
  const response = await maybeProxySearchServiceRequest(request, new URL(request.url), {
    serviceUrl: "http://127.0.0.1:8101",
    fetchImpl: async (_input, init) => {
      forwardedBody = await new Response(init?.body).text();
      return Response.json({ ok: true });
    },
  });

  assert.equal(response?.status, 200);
  assert.equal(forwardedBody, "{\"route\":\"LIM-MAD\"}");
  assert.equal(arrayBufferCalls, 0);
});

test("search service proxy streams runner responses without buffering and strips hop-by-hop headers", async () => {
  let arrayBufferCalls = 0;
  const upstream = new Response("first\nsecond\n", {
    status: 206,
    statusText: "Partial Content",
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/x-ndjson",
      Connection: "keep-alive, X-Remove",
      "Keep-Alive": "timeout=5",
      "Transfer-Encoding": "chunked",
      Upgrade: "websocket",
      "X-Remove": "hidden",
      "X-Runner-Trace": "trace-1",
    },
  });
  Object.defineProperty(upstream, "arrayBuffer", {
    value: async () => {
      arrayBufferCalls += 1;
      throw new Error("runner response must not be buffered");
    },
  });

  const request = new Request("http://fly-desk.test/api/search/job-1");
  const response = await maybeProxySearchServiceRequest(request, new URL(request.url), {
    serviceUrl: "http://127.0.0.1:8101",
    fetchImpl: async () => upstream,
  });

  assert.equal(response?.status, 206);
  assert.equal(response?.statusText, "Partial Content");
  assert.equal(response?.headers.get("cache-control"), "no-store");
  assert.equal(response?.headers.get("content-type"), "application/x-ndjson");
  assert.equal(response?.headers.get("x-runner-trace"), "trace-1");
  assert.equal(response?.headers.has("connection"), false);
  assert.equal(response?.headers.has("keep-alive"), false);
  assert.equal(response?.headers.has("transfer-encoding"), false);
  assert.equal(response?.headers.has("upgrade"), false);
  assert.equal(response?.headers.has("x-remove"), false);
  assert.equal(arrayBufferCalls, 0);
  assert.equal(await response?.text(), "first\nsecond\n");
});

test("search service proxy keeps its timeout active while the runner body streams", async () => {
  let bodyAborted = false;
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const fallback = setTimeout(() => bodyController?.error(new Error("runner body was not aborted")), 100);
  const request = new Request("http://fly-desk.test/api/search/job-1");

  try {
    const response = await maybeProxySearchServiceRequest(request, new URL(request.url), {
      serviceUrl: "http://127.0.0.1:8101",
      timeoutMs: 5,
      fetchImpl: async (_input, init) => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
          init?.signal?.addEventListener("abort", () => {
            bodyAborted = true;
            controller.error(init.signal?.reason);
          }, { once: true });
        },
      })),
    });

    await assert.rejects(response!.text());
    assert.equal(bodyAborted, true);
  } finally {
    clearTimeout(fallback);
  }
});

test("search service proxy uses an internal token fallback when explicit api tokens are absent", async () => {
  const restoreEnv = overrideEnv({
    FLY_DESK_API_TOKEN: undefined,
    FLY_DESK_SEARCH_SERVICE_API_TOKEN: undefined,
    FLY_DESK_WEB_SESSION_SECRET: "test-session-secret-32-characters-minimum",
  });

  try {
    let forwardedHeaders = new Headers();
    const request = new Request("http://fly-desk.test/api/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const response = await maybeProxySearchServiceRequest(request, new URL(request.url), {
      serviceUrl: "http://127.0.0.1:8101",
      fetchImpl: async (_input, init) => {
        forwardedHeaders = new Headers(init?.headers);
        return Response.json({ ok: true });
      },
    });

    assert.equal(response?.status, 200);
    const expectedToken = resolveSearchServiceProxyApiToken();
    assert.equal(forwardedHeaders.get("x-flydesk-api-token"), expectedToken);
    assert.equal(forwardedHeaders.get("authorization"), `Bearer ${expectedToken}`);
  } finally {
    restoreEnv();
  }
});

test("search service proxy leaves api token absent without an explicit token or internal secret", async () => {
  const restoreEnv = overrideEnv({
    FLY_DESK_API_TOKEN: undefined,
    FLY_DESK_SEARCH_SERVICE_API_TOKEN: undefined,
    FLY_DESK_WEB_SESSION_SECRET: undefined,
  });

  try {
    let forwardedHeaders = new Headers();
    const request = new Request("http://fly-desk.test/api/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const response = await maybeProxySearchServiceRequest(request, new URL(request.url), {
      serviceUrl: "http://127.0.0.1:8101",
      fetchImpl: async (_input, init) => {
        forwardedHeaders = new Headers(init?.headers);
        return Response.json({ ok: true });
      },
    });

    assert.equal(response?.status, 200);
    assert.equal(forwardedHeaders.has("x-flydesk-api-token"), false);
  } finally {
    restoreEnv();
  }
});

test("search service proxy skips already proxied requests", async () => {
  const request = new Request("http://fly-desk.test/api/search", {
    method: "POST",
    headers: {
      "x-flydesk-search-proxy": "1",
    },
    body: "{}",
  });

  const response = await maybeProxySearchServiceRequest(request, new URL(request.url), {
    serviceUrl: "http://127.0.0.1:8101",
    fetchImpl: async () => {
      throw new Error("proxy loop should not call fetch");
    },
  });

  assert.equal(response, undefined);
});

test("search service proxy returns a safe unavailable response when the runner request fails", async () => {
  const restoreEnv = overrideEnv({
    FLY_DESK_API_TOKEN: "test-api-token-value",
    FLY_DESK_SEARCH_SERVICE_API_TOKEN: undefined,
  });
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    const request = new Request("http://fly-desk.test/api/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ route: "LIM-MAD" }),
    });
    const response = await maybeProxySearchServiceRequest(request, new URL(request.url), {
      serviceUrl: "http://127.0.0.1:8101",
      timeoutMs: 1_000,
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED token-test-api-token-value password=s3cr3t");
      },
    });

    assert.equal(response?.status, 503);
    assert.deepEqual(await response?.json(), { error: "Search service is unavailable." });
    assert.equal(warnings.length, 1);
    const logged = JSON.stringify(warnings[0]);
    assert.match(logged, /apiTokenConfigured/);
    assert.doesNotMatch(logged, /test-api-token-value/);
    assert.doesNotMatch(logged, /s3cr3t/);
  } finally {
    console.warn = originalWarn;
    restoreEnv();
  }
});

test("search service proxy clamps env timeout to avoid immediate production aborts", async () => {
  const restoreEnv = overrideEnv({
    FLY_DESK_API_TOKEN: "test-api-token",
    FLY_DESK_SEARCH_SERVICE_API_TOKEN: undefined,
    FLY_DESK_SEARCH_SERVICE_TIMEOUT_MS: "1",
  });

  try {
    const request = new Request("http://fly-desk.test/api/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ route: "LIM-MAD" }),
    });
    let aborted = false;
    const response = await maybeProxySearchServiceRequest(request, new URL(request.url), {
      serviceUrl: "http://127.0.0.1:8101",
      fetchImpl: async (_input, init) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => {
          aborted = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        assert.equal(signal?.aborted, false);
        return Response.json({ ok: true });
      },
    });

    assert.equal(aborted, false);
    assert.equal(response?.status, 200);
    assert.deepEqual(await response?.json(), { ok: true });
  } finally {
    restoreEnv();
  }
});

test("the proxy outlasts the hold it is forwarding, for every wait the runner honours", async () => {
  /*
   * The defect this pins: a long-haul search whose providers went quiet for
   * fifteen seconds reached the agent as «Search service is unavailable» while
   * the runner was still working. The poll asks the runner to hold for `wait`,
   * and the proxy was aborting at its own base timeout — 15s against a 15s
   * hold, decided by whichever fired first, and a certain failure for the 20s
   * the runner permits.
   */
  const { JOB_POLL_MAX_WAIT_MS } = await import("../src/http-router");
  const { POLL_LONG_WAIT_MS } = await import("../frontend/src/lib/poll-schedule");
  const restoreEnv = overrideEnv({ FLY_DESK_SEARCH_SERVICE_TIMEOUT_MS: undefined });

  try {
    for (const wait of [POLL_LONG_WAIT_MS, JOB_POLL_MAX_WAIT_MS]) {
      const url = new URL(`http://fly-desk.test/api/search/job-1?sinceRevision=2&wait=${wait}`);
      assert.ok(
        resolveProxyTimeoutMsForRequest(url) > wait,
        `a hold of ${wait}ms is not covered by ${resolveProxyTimeoutMsForRequest(url)}ms`,
      );
    }

    // A request that asks for no hold keeps the base budget, unchanged.
    const plain = new URL("http://fly-desk.test/api/search");
    assert.equal(resolveProxyTimeoutMsForRequest(plain), 15_000);
    // And a client asking for more than the runner will ever hold cannot push
    // this past the ceiling the proxy is allowed.
    const greedy = new URL("http://fly-desk.test/api/search/job-1?sinceRevision=2&wait=600000");
    assert.equal(resolveProxyTimeoutMsForRequest(greedy), 60_000);
  } finally {
    restoreEnv();
  }
});

test("a poll parked for longer than the base timeout still reaches the agent", async () => {
  const restoreEnv = overrideEnv({
    FLY_DESK_API_TOKEN: "test-api-token",
    FLY_DESK_SEARCH_SERVICE_API_TOKEN: undefined,
    /* The floor the env clamp allows, so the case runs in milliseconds while
       standing for the production shape: a hold longer than the base budget. */
    FLY_DESK_SEARCH_SERVICE_TIMEOUT_MS: "1",
  });

  try {
    const request = new Request("http://fly-desk.test/api/search/job-1?sinceRevision=2&wait=120", {
      method: "GET",
    });
    let aborted = false;
    const response = await maybeProxySearchServiceRequest(request, new URL(request.url), {
      serviceUrl: "http://127.0.0.1:8101",
      timeoutMs: 40,
      fetchImpl: async (_input, init) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => { aborted = true; });
        // Parked past the 40ms budget, inside the 40 + 120 the hold is worth.
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (signal?.aborted) throw new Error("aborted");
        return Response.json({ unchanged: true });
      },
    });

    assert.equal(aborted, false);
    assert.equal(response?.status, 200);
    assert.deepEqual(await response?.json(), { unchanged: true });
  } finally {
    restoreEnv();
  }
});
