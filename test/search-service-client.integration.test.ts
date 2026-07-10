import assert from "node:assert/strict";
import {
  isSearchServiceRoute,
  maybeProxySearchServiceRequest,
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
  assert.equal(resolveSearchServiceBaseUrl("https://127.0.0.1:32125"), undefined);
  assert.equal(resolveSearchServiceBaseUrl("http://example.com:32125"), undefined);
  assert.equal(resolveSearchServiceBaseUrl("not-a-url"), undefined);
  assert.equal(resolveSearchServiceBaseUrl("http://127.0.0.1:32125")?.toString(), "http://127.0.0.1:32125/");
  assert.equal(resolveSearchServiceBaseUrl("http://localhost:32125/search")?.toString(), "http://localhost:32125/search");
});

test("search service route detection includes quotation sessions owned by the runner", () => {
  assert.equal(isSearchServiceRoute("POST", "/api/search"), true);
  assert.equal(isSearchServiceRoute("GET", "/api/search/job-1"), true);
  assert.equal(isSearchServiceRoute("POST", "/api/search/job-1/cancel"), true);
  assert.equal(isSearchServiceRoute("POST", "/api/matrix"), true);
  assert.equal(isSearchServiceRoute("GET", "/api/matrix/job-1"), true);
  assert.equal(isSearchServiceRoute("POST", "/api/matrix/job-1/cancel"), true);
  assert.equal(isSearchServiceRoute("POST", "/api/quotation"), true);

  assert.equal(isSearchServiceRoute("GET", "/api/health"), false);
  assert.equal(isSearchServiceRoute("GET", "/api/locations"), false);
  assert.equal(isSearchServiceRoute("POST", "/api/auth/login"), false);
  assert.equal(isSearchServiceRoute("GET", "/r/path-id"), false);
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
      serviceUrl: "http://127.0.0.1:32125",
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
    assert.equal(forwardedUrl, "http://127.0.0.1:32125/api/search?sinceRevision=4");
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
      serviceUrl: "http://127.0.0.1:32125",
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
      serviceUrl: "http://127.0.0.1:32125",
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
    serviceUrl: "http://127.0.0.1:32125",
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
      serviceUrl: "http://127.0.0.1:32125",
      timeoutMs: 1_000,
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED token-test-api-token-value");
      },
    });

    assert.equal(response?.status, 503);
    assert.deepEqual(await response?.json(), { error: "Search service is unavailable." });
    assert.equal(warnings.length, 1);
    const logged = JSON.stringify(warnings[0]);
    assert.match(logged, /apiTokenConfigured/);
    assert.doesNotMatch(logged, /test-api-token-value/);
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
      serviceUrl: "http://127.0.0.1:32125",
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
