import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createRedirectSessionCookie,
  createRedirectSessionCookieForWebSession,
  createScryptPasswordHash,
  createWebSessionCookie,
  getWebAuthConfigError,
  hasValidRedirectSession,
  hasValidWebSession,
  REDIRECT_SESSION_COOKIE_NAME,
  renderLoginPage,
  shouldTrustLoopbackClient,
  verifyWebPassword,
  WEB_SESSION_COOKIE_NAME,
} from "../src/web-auth";
import { applyEnvironment } from "./helpers/environment";
import { withServer } from "./helpers/server";

test("login errors are announced without rendering unescaped content", () => {
  const html = renderLoginPage('<strong>Contraseña inválida</strong>');

  assert.match(html, /class="error" role="alert" aria-live="assertive"/);
  assert.match(html, /&lt;strong&gt;Contraseña inválida&lt;\/strong&gt;/);
  assert.doesNotMatch(html, /<strong>Contraseña inválida<\/strong>/);
});

test("web authentication accepts only the configured password hash", { concurrency: false }, () => {
  const restore = applyEnvironment({
    FLY_DESK_WEB_AUTH: "1",
    FLY_DESK_WEB_SESSION_SECRET: "test-session-secret-with-at-least-32-characters",
    FLY_DESK_WEB_PASSWORD: undefined,
    FLY_DESK_WEB_PASSWORD_HASH: createScryptPasswordHash("correct horse", Buffer.alloc(16, 7)),
  });

  try {
    assert.deepEqual(verifyWebPassword("correct horse"), { ok: true });
    assert.deepEqual(verifyWebPassword("wrong password"), { ok: false });
  } finally {
    restore();
  }
});
test("web authentication rejects legacy plaintext and SHA-256 password configuration", { concurrency: false }, () => {
  const restore = applyEnvironment({
    FLY_DESK_WEB_AUTH: "1",
    FLY_DESK_WEB_SESSION_SECRET: "test-session-secret-with-at-least-32-characters",
    FLY_DESK_WEB_PASSWORD: "legacy-password",
    FLY_DESK_WEB_PASSWORD_HASH: undefined,
  });
  const expectedError = "FLY_DESK_WEB_PASSWORD_HASH must contain a valid scrypt hash.";

  try {
    assert.equal(getWebAuthConfigError(), expectedError);
    assert.deepEqual(verifyWebPassword("legacy-password"), {
      ok: false,
      configError: expectedError,
    });

    delete process.env.FLY_DESK_WEB_PASSWORD;
    process.env.FLY_DESK_WEB_PASSWORD_HASH = `sha256:${createHash("sha256").update("legacy-password").digest("hex")}`;

    assert.equal(getWebAuthConfigError(), expectedError);
    assert.deepEqual(verifyWebPassword("legacy-password"), {
      ok: false,
      configError: expectedError,
    });
  } finally {
    restore();
  }
});

test("web authentication reports malformed scrypt hashes as configuration errors", { concurrency: false }, () => {
  const restore = applyEnvironment({
    FLY_DESK_WEB_AUTH: "1",
    FLY_DESK_WEB_SESSION_SECRET: "test-session-secret-with-at-least-32-characters",
    FLY_DESK_WEB_PASSWORD: undefined,
    FLY_DESK_WEB_PASSWORD_HASH: "scrypt:not-a-valid-salt:not-a-valid-key",
  });
  const expectedError = "FLY_DESK_WEB_PASSWORD_HASH must contain a valid scrypt hash.";

  try {
    assert.equal(getWebAuthConfigError(), expectedError);
    assert.deepEqual(verifyWebPassword("any-password"), {
      ok: false,
      configError: expectedError,
    });
  } finally {
    restore();
  }
});


test("web sessions reject tampering and expiration", { concurrency: false }, () => {
  const restore = applyEnvironment({
    FLY_DESK_WEB_AUTH: "1",
    FLY_DESK_WEB_SESSION_SECRET: "test-session-secret-with-at-least-32-characters",
    FLY_DESK_WEB_PASSWORD: undefined,
    FLY_DESK_WEB_PASSWORD_HASH: createScryptPasswordHash("test-password", Buffer.alloc(16, 8)),
    FLY_DESK_WEB_SESSION_TTL_SECONDS: "300",
  });
  const nowMs = 1_800_000_000_000;

  try {
    const request = new Request("https://fly-desk.test/");
    const setCookie = createWebSessionCookie(request, nowMs);
    const cookie = setCookie.split(";", 1)[0]!;
    const authenticated = new Request("https://fly-desk.test/", {
      headers: { cookie },
    });
    assert.equal(hasValidWebSession(authenticated, nowMs), true);

    const sessionValue = cookie.slice(`${WEB_SESSION_COOKIE_NAME}=`.length);
    const tampered = new Request("https://fly-desk.test/", {
      headers: { cookie: `${WEB_SESSION_COOKIE_NAME}=${sessionValue.slice(0, -1)}x` },
    });
    assert.equal(hasValidWebSession(tampered, nowMs), false);
    assert.equal(hasValidWebSession(authenticated, nowMs + 300_001), false);
  } finally {
    restore();
  }
});

test("redirect sessions use a distinct path-scoped credential", { concurrency: false }, () => {
  const restore = applyEnvironment({
    FLY_DESK_WEB_AUTH: "1",
    FLY_DESK_WEB_SESSION_SECRET: "test-session-secret-with-at-least-32-characters",
    FLY_DESK_WEB_PASSWORD: undefined,
    FLY_DESK_WEB_PASSWORD_HASH: createScryptPasswordHash("test-password", Buffer.alloc(16, 9)),
    FLY_DESK_WEB_SESSION_TTL_SECONDS: "300",
  });
  const nowMs = 1_800_000_000_000;

  try {
    const baseRequest = new Request("https://fly-desk.test/");
    const webCookie = createWebSessionCookie(baseRequest, nowMs).split(";", 1)[0]!;
    const redirectSetCookie = createRedirectSessionCookie(baseRequest, nowMs);
    const redirectCookie = redirectSetCookie.split(";", 1)[0]!;

    assert.match(redirectSetCookie, /HttpOnly; Path=\/r; SameSite=Lax; Max-Age=300; Secure/);
    assert.equal(hasValidWebSession(new Request(baseRequest, { headers: { cookie: webCookie } }), nowMs), true);
    assert.equal(hasValidRedirectSession(new Request(baseRequest, { headers: { cookie: webCookie } }), nowMs), false);
    assert.equal(hasValidRedirectSession(new Request(baseRequest, { headers: { cookie: redirectCookie } }), nowMs), true);
    assert.equal(hasValidWebSession(new Request(baseRequest, { headers: { cookie: redirectCookie } }), nowMs), false);

    const migrated = createRedirectSessionCookieForWebSession(
      new Request(baseRequest, { headers: { cookie: webCookie } }),
      nowMs + 1_000,
    );
    assert.match(migrated ?? "", new RegExp(`^${REDIRECT_SESSION_COOKIE_NAME}=`));
    assert.match(migrated ?? "", /Max-Age=299/);
  } finally {
    restore();
  }
});

test("loopback trust is disabled by default and enabled only when explicitly set", () => {
  const previous = process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;

  try {
    delete process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
    assert.equal(shouldTrustLoopbackClient(), false);

    process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = "1";
    assert.equal(shouldTrustLoopbackClient(), true);

    process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = "0";
    assert.equal(shouldTrustLoopbackClient(), false);

    process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = "yes";
    assert.equal(shouldTrustLoopbackClient(), false);
  } finally {
    if (previous === undefined) {
      delete process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
    } else {
      process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = previous;
    }
  }
});

test("test server defaults loopback trust only inside the harness", { concurrency: false }, async () => {
  const previous = process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;

  try {
    delete process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/locations?q=`);
      assert.equal(response.status, 200);
    });

    assert.equal(process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT, undefined);
  } finally {
    if (previous === undefined) {
      delete process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
    } else {
      process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = previous;
    }
  }
});

test("test server preserves explicit loopback trust opt-out", { concurrency: false }, async () => {
  const previous = process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;

  try {
    process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = "0";

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/locations?q=`);
      assert.equal(response.status, 403);
    });

    assert.equal(process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT, "0");
  } finally {
    if (previous === undefined) {
      delete process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
    } else {
      process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = previous;
    }
  }
});
