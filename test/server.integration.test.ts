import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest, resolveServerIdleTimeoutSeconds } from "../src/server";
import { resetAirlineMarkStoreForTests } from "../src/airline-mark-store";
import { resetWebLoginAdmission } from "../src/login-admission";
import { createScryptPasswordHash } from "../src/web-auth";
import { realPng } from "./helpers/png";
import { withServer } from "./helpers/server";
import { removeTempRoot } from "./helpers/temp";

test("server idle timeout defaults above Bun's short request timeout", () => {
  assert.equal(resolveServerIdleTimeoutSeconds(undefined), 120);
  assert.equal(resolveServerIdleTimeoutSeconds("not-a-number"), 120);
  assert.equal(resolveServerIdleTimeoutSeconds("999"), 255);
  assert.equal(resolveServerIdleTimeoutSeconds("0"), 0);
  assert.equal(resolveServerIdleTimeoutSeconds("45"), 45);
});

test("malformed request URLs are handled with a controlled bad request response", async () => {
  const request = {
    url: "http://[",
    method: "GET",
    headers: new Headers(),
  } as Request;

  const response = await handleRequest(request, {} as never);
  const payload = await response.json() as { error?: string };

  assert.equal(response.status, 400);
  assert.match(payload.error ?? "", /malformed request url/i);
});

test("unexpected server failures return a generic error without leaking details", { concurrency: false }, async () => {
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const response = await handleRequest(
      new Request("http://fly-desk.test/api/health"),
      { requestIP: () => { throw new Error("sensitive internal failure"); } } as never,
    );
    const payload = await response.json() as { error?: string };

    assert.equal(response.status, 500);
    assert.equal(payload.error, "Unexpected server error.");
    assert.doesNotMatch(JSON.stringify(payload), /sensitive internal failure/);
  } finally {
    console.error = originalConsoleError;
  }
});

test("server accepts bearer API tokens after filtering internal x-flydesk headers", { concurrency: false }, async () => {
  const previousApiToken = process.env.FLY_DESK_API_TOKEN;
  const previousWebAuth = process.env.FLY_DESK_WEB_AUTH;
  const previousTrustLoopback = process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;

  process.env.FLY_DESK_API_TOKEN = "server-api-token";
  process.env.FLY_DESK_WEB_AUTH = "0";
  process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = "0";

  try {
    await withServer(async (baseUrl) => {
      const stripped = await fetch(`${baseUrl}/api/locations?q=`, {
        headers: {
          "x-flydesk-api-token": "server-api-token",
        },
      });
      assert.equal(stripped.status, 403);

      const accepted = await fetch(`${baseUrl}/api/locations?q=`, {
        headers: {
          Authorization: "Bearer server-api-token",
        },
      });
      assert.equal(accepted.status, 200);
    });
  } finally {
    if (previousApiToken === undefined) {
      delete process.env.FLY_DESK_API_TOKEN;
    } else {
      process.env.FLY_DESK_API_TOKEN = previousApiToken;
    }

    if (previousWebAuth === undefined) {
      delete process.env.FLY_DESK_WEB_AUTH;
    } else {
      process.env.FLY_DESK_WEB_AUTH = previousWebAuth;
    }

    if (previousTrustLoopback === undefined) {
      delete process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
    } else {
      process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = previousTrustLoopback;
    }
  }
});

test("web auth redirects the app shell to login before serving frontend assets", { concurrency: false }, async () => {
  const previousWebAuth = process.env.FLY_DESK_WEB_AUTH;
  const previousTrustLoopback = process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
  const previousPasswordHash = process.env.FLY_DESK_WEB_PASSWORD_HASH;
  const previousSessionSecret = process.env.FLY_DESK_WEB_SESSION_SECRET;

  process.env.FLY_DESK_WEB_AUTH = "1";
  process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = "0";
  process.env.FLY_DESK_WEB_PASSWORD_HASH = createScryptPasswordHash("test-password", Buffer.alloc(16, 8));
  process.env.FLY_DESK_WEB_SESSION_SECRET = "test-session-secret-32-characters-minimum";

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(baseUrl, { redirect: "manual" });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), "/login");
    });
  } finally {
    if (previousWebAuth === undefined) {
      delete process.env.FLY_DESK_WEB_AUTH;
    } else {
      process.env.FLY_DESK_WEB_AUTH = previousWebAuth;
    }

    if (previousTrustLoopback === undefined) {
      delete process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
    } else {
      process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = previousTrustLoopback;
    }

    if (previousPasswordHash === undefined) {
      delete process.env.FLY_DESK_WEB_PASSWORD_HASH;
    } else {
      process.env.FLY_DESK_WEB_PASSWORD_HASH = previousPasswordHash;
    }

    if (previousSessionSecret === undefined) {
      delete process.env.FLY_DESK_WEB_SESSION_SECRET;
    } else {
      process.env.FLY_DESK_WEB_SESSION_SECRET = previousSessionSecret;
    }
  }
});

/* The gate compares the pathname with `===` while `resolvePublicAsset` hands
   its argument to `path.resolve`, which collapses duplicate and trailing
   slashes. `//index.html` therefore missed the gate and was served the
   signed-out app shell. What is pinned here is the property that closes it —
   one spelling of a path reaches the routes — rather than the one spelling
   that was reported, because the next route written with `===` inherits the
   property and would not inherit a patched comparison. */
test("redundant slashes cannot step around the web auth gate", { concurrency: false }, async () => {
  const previousWebAuth = process.env.FLY_DESK_WEB_AUTH;
  const previousTrustLoopback = process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
  const previousPasswordHash = process.env.FLY_DESK_WEB_PASSWORD_HASH;
  const previousSessionSecret = process.env.FLY_DESK_WEB_SESSION_SECRET;

  process.env.FLY_DESK_WEB_AUTH = "1";
  process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = "0";
  process.env.FLY_DESK_WEB_PASSWORD_HASH = createScryptPasswordHash("test-password", Buffer.alloc(16, 8));
  process.env.FLY_DESK_WEB_SESSION_SECRET = "test-session-secret-32-characters-minimum";
  resetWebLoginAdmission();

  try {
    await withServer(async (baseUrl) => {
      /* Bun resolves `.` and `..` out of the request target while it parses,
         so the spellings that reach the server are the slashes. Each of these
         used to be served the shell; each has to arrive at the same gate, and
         at the same `next`, or there is still more than one path here. */
      for (const target of ["/index.html", "//index.html", "///index.html", "/index.html/", "//index.html//"]) {
        const gated = await fetch(`${baseUrl}${target}`, { redirect: "manual" });

        assert.equal(gated.status, 302, `${target} was not gated`);
        assert.equal(gated.headers.get("location"), "/login?next=%2Findex.html", `${target} carried a different next`);
      }

      for (const target of ["/", "//", "////"]) {
        const gated = await fetch(`${baseUrl}${target}`, { redirect: "manual" });

        assert.equal(gated.status, 302, `${target} was not gated`);
        assert.equal(gated.headers.get("location"), "/login", `${target} carried a different next`);
      }

      /* A percent-encoded slash is a character inside a segment and not a
         separator. Decoding it would manufacture the traversal the gate is
         closing, so it stays a filename, and there is no such file. */
      const encoded = await fetch(`${baseUrl}/%2Findex.html`, { redirect: "manual" });
      assert.equal(encoded.status, 404);

      /* The same one spelling has to reach the router behind the proxy, which
         compares its own pathnames with `===` as well. `//api/health` was a
         404 for exactly that reason. */
      for (const target of ["/api/health", "//api/health", "///api/health"]) {
        const health = await fetch(`${baseUrl}${target}`);

        assert.equal(health.status, 200, `${target} did not reach the router`);
        assert.deepEqual(await health.json(), { ok: true });
      }

      /* Assets stay public, and now carry the immutable header whichever way
         they are asked for — `//assets/...` used to fail the `startsWith`
         test that picks it and was served `no-cache`. */
      const assetName = readdirSync(join(process.cwd(), "frontend", "dist", "assets"))
        .find((name) => name.endsWith(".js"));
      assert.ok(assetName, "the built frontend has no JavaScript asset to serve");

      for (const prefix of ["/assets/", "//assets/"]) {
        const asset = await fetch(`${baseUrl}${prefix}${assetName}`);

        assert.equal(asset.status, 200, `${prefix} did not serve the asset`);
        assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
      }

      /* And the positive case: a real session still gets the workspace, at the
         canonical path and at the redundant one. */
      const login = await fetch(`${baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: "test-password" }).toString(),
        redirect: "manual",
      });
      assert.equal(login.status, 303);
      const sessionCookie = login.headers.getSetCookie()
        .map((value) => value.match(/flydesk_session=[^;,]+/)?.[0])
        .find(Boolean) ?? "";
      assert.match(sessionCookie, /^flydesk_session=./);

      for (const target of ["/", "/index.html", "//index.html"]) {
        const shell = await fetch(`${baseUrl}${target}`, {
          headers: { Cookie: sessionCookie },
          redirect: "manual",
        });

        assert.equal(shell.status, 200, `${target} was not served to a signed-in session`);
        assert.match(await shell.text(), /<div id="root">/);
      }

      /* Parameterised routes carry the same property, and it matters more
         there: the delegation predicate is a strict `^/api/search/[^/]+$`
         while the handler under it only asks `startsWith`, so a job id with a
         slash too many was answered by this unit instead of the runner that
         owns the job. The generic «Not found» is what a path that reached no
         route at all gets. */
      const job = await fetch(`${baseUrl}//api/search/absent-job`, {
        headers: { Cookie: sessionCookie },
      });

      assert.equal(job.status, 404);
      assert.deepEqual(await job.json(), { error: "Search job not found." });
    });
  } finally {
    if (previousWebAuth === undefined) {
      delete process.env.FLY_DESK_WEB_AUTH;
    } else {
      process.env.FLY_DESK_WEB_AUTH = previousWebAuth;
    }

    if (previousTrustLoopback === undefined) {
      delete process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
    } else {
      process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = previousTrustLoopback;
    }

    if (previousPasswordHash === undefined) {
      delete process.env.FLY_DESK_WEB_PASSWORD_HASH;
    } else {
      process.env.FLY_DESK_WEB_PASSWORD_HASH = previousPasswordHash;
    }

    if (previousSessionSecret === undefined) {
      delete process.env.FLY_DESK_WEB_SESSION_SECRET;
    } else {
      process.env.FLY_DESK_WEB_SESSION_SECRET = previousSessionSecret;
    }

    resetWebLoginAdmission();
  }
});

test("web auth login page uses the persisted Fly Desk theme", { concurrency: false }, async () => {
  const previousWebAuth = process.env.FLY_DESK_WEB_AUTH;
  const previousTrustLoopback = process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
  const previousPasswordHash = process.env.FLY_DESK_WEB_PASSWORD_HASH;
  const previousSessionSecret = process.env.FLY_DESK_WEB_SESSION_SECRET;

  process.env.FLY_DESK_WEB_AUTH = "1";
  process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = "0";
  process.env.FLY_DESK_WEB_PASSWORD_HASH = createScryptPasswordHash("test-password", Buffer.alloc(16, 9));
  process.env.FLY_DESK_WEB_SESSION_SECRET = "test-session-secret-32-characters-minimum";

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/login`, {
        headers: {
          cookie: "flydesk_theme=dark",
        },
      });
      const html = await response.text();

      assert.equal(response.status, 200);
      assert.match(html, /<html lang="es" class="dark" data-theme="dark">/);
      assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg">/);
      assert.match(html, /class="fd-field-label">Contraseña<\/span>/);
      /* The gate carries the title bar's switch. It used to have none, which
         meant the only way to reach the dark palette was to already be past
         the gate — and the cookie this test sets is the one it writes. */
      assert.match(html, /aria-label="Cambiar tema"/);
    });
  } finally {
    if (previousWebAuth === undefined) {
      delete process.env.FLY_DESK_WEB_AUTH;
    } else {
      process.env.FLY_DESK_WEB_AUTH = previousWebAuth;
    }

    if (previousTrustLoopback === undefined) {
      delete process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
    } else {
      process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = previousTrustLoopback;
    }

    if (previousPasswordHash === undefined) {
      delete process.env.FLY_DESK_WEB_PASSWORD_HASH;
    } else {
      process.env.FLY_DESK_WEB_PASSWORD_HASH = previousPasswordHash;
    }

    if (previousSessionSecret === undefined) {
      delete process.env.FLY_DESK_WEB_SESSION_SECRET;
    } else {
      process.env.FLY_DESK_WEB_SESSION_SECRET = previousSessionSecret;
    }
  }
});

test("server trusts the Worker login client IP only through a loopback peer", { concurrency: false }, async () => {
  const previousWebAuth = process.env.FLY_DESK_WEB_AUTH;
  const previousWebPassword = process.env.FLY_DESK_WEB_PASSWORD;
  const previousPasswordHash = process.env.FLY_DESK_WEB_PASSWORD_HASH;
  const previousSessionSecret = process.env.FLY_DESK_WEB_SESSION_SECRET;

  process.env.FLY_DESK_WEB_AUTH = "1";
  delete process.env.FLY_DESK_WEB_PASSWORD;
  process.env.FLY_DESK_WEB_PASSWORD_HASH = createScryptPasswordHash("correct-password", Buffer.alloc(16, 10));
  process.env.FLY_DESK_WEB_SESSION_SECRET = "test-session-secret-32-characters-minimum";
  resetWebLoginAdmission();

  const login = (
    remoteAddress: string,
    clientAddress: string,
    password: string,
  ) => handleRequest(
    new Request("http://fly-desk.test/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Fly-Desk-Login-Client-IP": clientAddress,
      },
      body: JSON.stringify({ password }),
    }),
    {
      requestIP: () => ({ address: remoteAddress, port: 443, family: "IPv4" }),
    } as never,
  );

  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal(
        (await login("127.0.0.1", "203.0.113.10", "wrong-password")).status,
        401,
      );
    }

    assert.equal(
      (await login("127.0.0.1", "203.0.113.11", "correct-password")).status,
      200,
    );

    resetWebLoginAdmission();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal(
        (await login("198.51.100.20", `203.0.113.${attempt + 20}`, "wrong-password")).status,
        401,
      );
    }

    assert.equal(
      (await login("198.51.100.20", "203.0.113.99", "correct-password")).status,
      429,
    );
  } finally {
    resetWebLoginAdmission();
    if (previousWebAuth === undefined) delete process.env.FLY_DESK_WEB_AUTH;
    else process.env.FLY_DESK_WEB_AUTH = previousWebAuth;
    if (previousWebPassword === undefined) delete process.env.FLY_DESK_WEB_PASSWORD;
    else process.env.FLY_DESK_WEB_PASSWORD = previousWebPassword;
    if (previousPasswordHash === undefined) delete process.env.FLY_DESK_WEB_PASSWORD_HASH;
    else process.env.FLY_DESK_WEB_PASSWORD_HASH = previousPasswordHash;
    if (previousSessionSecret === undefined) delete process.env.FLY_DESK_WEB_SESSION_SECRET;
    else process.env.FLY_DESK_WEB_SESSION_SECRET = previousSessionSecret;
  }
});

test("a carrier mark the release lacks is fetched once and then served locally", { concurrency: false }, async () => {
  /*
   * Eight ordinary routes return 38 carriers and a search can always return one
   * more, so the release cannot bundle them all. The provider that returns the
   * flight also publishes the artwork: the first card to ask for a mark the
   * release lacks pays for it, and every card after reads a file.
   *
   * `QR` on purpose — a carrier the bundle does not carry. A bundled code is
   * served by the release before this path is reached, which is the point of
   * bundling it.
   */
  const directory = mkdtempSync(join(tmpdir(), "flydesk-server-marks-"));
  const previousDir = process.env.FLY_DESK_AIRLINE_MARK_DIR;
  process.env.FLY_DESK_AIRLINE_MARK_DIR = directory;
  const realFetch = globalThis.fetch;
  let fetches = 0;
  /* A mark that really decodes. The guard this route harvests through reads
     past the header now, so a signature and an IHDR are no longer enough to
     stand in for artwork — which is the whole point of it. */
  const markBytes = await realPng(70);
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes("/web/airlines/")) {
      fetches += 1;
      return new Response(markBytes, { status: 200, headers: { "content-type": "image/png" } });
    }
    return realFetch(input as never);
  }) as typeof fetch;
  resetAirlineMarkStoreForTests();

  try {
    const ask = () => handleRequest(
      new Request("http://fly-desk.test/assets/airline-icons/QR.png"),
      { requestIP: () => null } as never,
    );

    const first = await ask();
    assert.equal(first.status, 200);
    assert.match(first.headers.get("content-type") ?? "", /image\/png/);
    assert.equal(fetches, 1);

    const second = await ask();
    assert.equal(second.status, 200);
    assert.equal(fetches, 1, "the second card read the file rather than the network");

    // A path that is not a carrier code is not a licence to fetch anything.
    const notACode = await handleRequest(
      new Request("http://fly-desk.test/assets/airline-icons/LATAM.png"),
      { requestIP: () => null } as never,
    );
    assert.equal(notACode.status, 404);
    assert.equal(fetches, 1);
  } finally {
    globalThis.fetch = realFetch;
    resetAirlineMarkStoreForTests();
    if (previousDir === undefined) delete process.env.FLY_DESK_AIRLINE_MARK_DIR;
    else process.env.FLY_DESK_AIRLINE_MARK_DIR = previousDir;
    removeTempRoot(directory);
  }
});
