import { test } from "bun:test";
import assert from "node:assert/strict";
import { handleRequest, resolveServerIdleTimeoutSeconds } from "../src/server";
import { withServer } from "./helpers/server";

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
  const previousWebPassword = process.env.FLY_DESK_WEB_PASSWORD;
  const previousSessionSecret = process.env.FLY_DESK_WEB_SESSION_SECRET;

  process.env.FLY_DESK_WEB_AUTH = "1";
  process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = "0";
  process.env.FLY_DESK_WEB_PASSWORD = "test-password";
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

    if (previousWebPassword === undefined) {
      delete process.env.FLY_DESK_WEB_PASSWORD;
    } else {
      process.env.FLY_DESK_WEB_PASSWORD = previousWebPassword;
    }

    if (previousSessionSecret === undefined) {
      delete process.env.FLY_DESK_WEB_SESSION_SECRET;
    } else {
      process.env.FLY_DESK_WEB_SESSION_SECRET = previousSessionSecret;
    }
  }
});

test("web auth login page uses the persisted Fly Desk theme", { concurrency: false }, async () => {
  const previousWebAuth = process.env.FLY_DESK_WEB_AUTH;
  const previousTrustLoopback = process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
  const previousWebPassword = process.env.FLY_DESK_WEB_PASSWORD;
  const previousSessionSecret = process.env.FLY_DESK_WEB_SESSION_SECRET;

  process.env.FLY_DESK_WEB_AUTH = "1";
  process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = "0";
  process.env.FLY_DESK_WEB_PASSWORD = "test-password";
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
      assert.match(html, /class="floating-label">Contraseña<\/span>/);
      assert.doesNotMatch(html, /Cambiar tema/i);
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

    if (previousWebPassword === undefined) {
      delete process.env.FLY_DESK_WEB_PASSWORD;
    } else {
      process.env.FLY_DESK_WEB_PASSWORD = previousWebPassword;
    }

    if (previousSessionSecret === undefined) {
      delete process.env.FLY_DESK_WEB_SESSION_SECRET;
    } else {
      process.env.FLY_DESK_WEB_SESSION_SECRET = previousSessionSecret;
    }
  }
});
