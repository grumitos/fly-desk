import { test } from "bun:test";
import assert from "node:assert/strict";
import { resolveServerIdleTimeoutSeconds } from "../src/server";
import { withServer } from "./helpers/server";

test("server idle timeout defaults above Bun's short request timeout", () => {
  assert.equal(resolveServerIdleTimeoutSeconds(undefined), 120);
  assert.equal(resolveServerIdleTimeoutSeconds("not-a-number"), 120);
  assert.equal(resolveServerIdleTimeoutSeconds("999"), 255);
  assert.equal(resolveServerIdleTimeoutSeconds("0"), 0);
  assert.equal(resolveServerIdleTimeoutSeconds("45"), 45);
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
