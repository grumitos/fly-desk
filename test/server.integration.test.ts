import { test } from "bun:test";
import assert from "node:assert/strict";
import { handleRequest, resolveServerIdleTimeoutSeconds } from "../src/server";
import { resetWebLoginAdmission } from "../src/login-admission";
import { createScryptPasswordHash } from "../src/web-auth";
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
