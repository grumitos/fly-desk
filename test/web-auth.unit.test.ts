import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import {
  createRedirectSessionCookie,
  createRedirectSessionCookieForWebSession,
  createScryptPasswordHash,
  createWebSessionCookie,
  getWebAuthConfigError,
  hasValidRedirectSession,
  hasValidWebSession,
  loginPageLocation,
  REDIRECT_SESSION_COOKIE_NAME,
  renderLoginPage,
  renewWebSessionCookies,
  resolveSafeNextPath,
  shouldTrustLoopbackClient,
  verifyWebPassword,
  WEB_SESSION_COOKIE_NAME,
} from "../src/web-auth";
import { applyEnvironment } from "./helpers/environment";
import { withServer } from "./helpers/server";

test("login errors are announced without rendering unescaped content", () => {
  const html = renderLoginPage('<strong>Contraseña inválida</strong>');

  assert.match(html, /class="fd-alert-line fd-alert-line-error" role="alert" aria-live="assertive"/);
  assert.match(html, /&lt;strong&gt;Contraseña inválida&lt;\/strong&gt;/);
  assert.doesNotMatch(html, /<strong>Contraseña inválida<\/strong>/);
});

/* The gate cannot import the bundle's stylesheet, so the values are
   transcribed. This is the check that the transcription is of the catalogues
   and not of whatever looked right: the field is the 52px input of 5b, the
   focus ring is 3d's, and the theme survives the page it was chosen on. */
test("the login page is drawn from the design catalogues", () => {
  const html = renderLoginPage();

  assert.match(html, /--fd-control-primary: 52px/);
  assert.match(html, /--fd-radius-12: 12px/);
  assert.match(html, /class="fd-field-control"/);
  assert.match(html, /class="fd-field-label"/);
  // 5b's mobile column is 34 / 40 / 46, and the 36 this page used to give its
  // one square control belonged to the column this one replaced.
  assert.match(html, /--fd-control-touch-sm: 34px/);
  assert.doesNotMatch(html, /width: 36px/);
  /* 3d's ring, drawn inside the border box. An outline rather than a shadow so
     that Windows high contrast keeps it, and inset so that a focused control
     cannot paint into the gap it shares with the control beside it —
     `test/ui/login.playwright.ts` measures that it does not. */
  assert.match(html, /\.fd-focus-ring:focus-visible \{\s*outline: 2px solid color-mix\(in srgb, var\(--color-primary\) 55%, transparent\);\s*outline-offset: -2px;/);
  assert.doesNotMatch(html, /\.fd-focus-ring:focus-visible \{[^}]*box-shadow/);
  // The switch writes both places, so the choice survives signing in.
  assert.match(html, /flydesk-theme/);
  assert.match(html, /flydesk_theme=/);
  // Nothing off-catalogue: the old gate had its own 48px field and 8px radius.
  assert.doesNotMatch(html, /height: 48px/);
});

/* Without this the keyboard shrinks the visual viewport only: the layout
   viewport keeps the full height of the phone, the card centres itself in a box
   twice the visible area, and the foot of the form goes under the keyboard.
   Measured at 360x400 in `test/ui/login.playwright.ts`; asserted here because
   it is one attribute and every render carries it. */
test("the gate lets the virtual keyboard shrink the layout viewport", () => {
  assert.match(
    renderLoginPage(),
    /<meta name="viewport" content="[^"]*interactive-widget=resizes-content[^"]*">/,
  );
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

/* Everything below turns on one clock: `nowMs` is passed explicitly so the
   window can be walked through without waiting for it. */
const SESSION_TEST_SECRET = "test-session-secret-with-at-least-32-characters";

function slidingSessionEnvironment(overrides: Record<string, string | undefined> = {}) {
  return applyEnvironment({
    FLY_DESK_WEB_AUTH: "1",
    FLY_DESK_WEB_SESSION_SECRET: SESSION_TEST_SECRET,
    FLY_DESK_WEB_PASSWORD: undefined,
    FLY_DESK_WEB_PASSWORD_HASH: createScryptPasswordHash("test-password", Buffer.alloc(16, 11)),
    FLY_DESK_WEB_SESSION_TTL_SECONDS: "300",
    FLY_DESK_WEB_SESSION_MAX_LIFETIME_SECONDS: undefined,
    ...overrides,
  });
}

function requestWithSession(setCookie: string): Request {
  return new Request("https://fly-desk.test/api/search", {
    headers: { cookie: setCookie.split(";", 1)[0]! },
  });
}

function sessionExpiryMs(setCookie: string): number {
  return Number(setCookie.split("=")[1]!.split(".")[2]);
}

test("an active session slides forward, but only past the halfway mark", { concurrency: false }, () => {
  const restore = slidingSessionEnvironment();
  const loginMs = 1_800_000_000_000;

  try {
    const login = createWebSessionCookie(new Request("https://fly-desk.test/"), loginMs);
    assert.equal(sessionExpiryMs(login), loginMs + 300_000);

    /* One millisecond on the early side of half: nothing is written, so the
       ordinary response carries no Set-Cookie at all. */
    assert.equal(renewWebSessionCookies(requestWithSession(login), loginMs + 149_999), undefined);

    const renewal = renewWebSessionCookies(requestWithSession(login), loginMs + 151_000);
    assert.ok(renewal, "a session more than half spent should be re-issued");
    assert.equal(renewal.expiresAtMs, loginMs + 151_000 + 300_000);
    assert.match(renewal.sessionCookie, /^flydesk_session=v2\./);
    assert.match(renewal.sessionCookie, /HttpOnly; Path=\/; SameSite=Lax; Max-Age=300; Secure/);
    assert.match(renewal.redirectSessionCookie, /^flydesk_redirect_session=v1\./);
    assert.match(renewal.redirectSessionCookie, /Path=\/r/);

    /* The renewed cookie is a session in its own right, and is not due again
       until its own window is half spent. */
    const renewed = requestWithSession(renewal.sessionCookie);
    assert.equal(hasValidWebSession(renewed, loginMs + 400_000), true);
    assert.equal(renewWebSessionCookies(renewed, loginMs + 251_000), undefined);
  } finally {
    restore();
  }
});

test("sliding never reaches past the cap the sign-in fixed", { concurrency: false }, () => {
  const restore = slidingSessionEnvironment({
    FLY_DESK_WEB_SESSION_MAX_LIFETIME_SECONDS: "600",
  });
  const loginMs = 1_800_000_000_000;

  try {
    const login = createWebSessionCookie(new Request("https://fly-desk.test/"), loginMs);

    const first = renewWebSessionCookies(requestWithSession(login), loginMs + 151_000);
    assert.ok(first);
    assert.equal(first.expiresAtMs, loginMs + 451_000);

    /* The second is clamped: 302_000 + 300_000 would be 602_000, and the cap
       is 600_000 from the sign-in. */
    const second = renewWebSessionCookies(requestWithSession(first.sessionCookie), loginMs + 302_000);
    assert.ok(second);
    assert.equal(second.expiresAtMs, loginMs + 600_000);

    /* Pinned at the cap, an otherwise ideal moment to renew produces nothing.
       Working through it does not buy another window. */
    const capped = requestWithSession(second.sessionCookie);
    assert.equal(hasValidWebSession(capped, loginMs + 599_000), true);
    assert.equal(renewWebSessionCookies(capped, loginMs + 599_000), undefined);
    assert.equal(hasValidWebSession(capped, loginMs + 600_001), false);
  } finally {
    restore();
  }
});

test("shortening the cap retires sessions already signed", { concurrency: false }, () => {
  const restore = slidingSessionEnvironment({
    FLY_DESK_WEB_SESSION_MAX_LIFETIME_SECONDS: "86400",
  });
  const loginMs = 1_800_000_000_000;

  try {
    const login = createWebSessionCookie(new Request("https://fly-desk.test/"), loginMs);
    assert.equal(hasValidWebSession(requestWithSession(login), loginMs + 200_000), true);

    process.env.FLY_DESK_WEB_SESSION_MAX_LIFETIME_SECONDS = "300";
    assert.equal(hasValidWebSession(requestWithSession(login), loginMs + 299_000), true);
    assert.equal(hasValidWebSession(requestWithSession(login), loginMs + 300_000), false);
  } finally {
    restore();
  }
});

test("a session cookie in the retired v1 format is refused, not upgraded", { concurrency: false }, () => {
  const restore = slidingSessionEnvironment();
  const nowMs = 1_800_000_000_000;
  const expiresAtMs = nowMs + 300_000;
  const nonce = "legacy-nonce";

  try {
    /* Signed exactly as the old code signed it, so this is the shape a browser
       would still be holding across the deploy, not a forgery. */
    const signature = createHmac("sha256", SESSION_TEST_SECRET)
      .update(`${expiresAtMs}.${nonce}`)
      .digest("base64url");
    const legacy = `${WEB_SESSION_COOKIE_NAME}=v1.${expiresAtMs}.${nonce}.${signature}`;

    assert.equal(
      hasValidWebSession(new Request("https://fly-desk.test/", { headers: { cookie: legacy } }), nowMs),
      false,
    );

    for (const malformed of [
      `${WEB_SESSION_COOKIE_NAME}=v2`,
      `${WEB_SESSION_COOKIE_NAME}=v2.${nowMs}.${expiresAtMs}`,
      `${WEB_SESSION_COOKIE_NAME}=v2.not-a-number.${expiresAtMs}.${nonce}.${signature}`,
      `${WEB_SESSION_COOKIE_NAME}=v3.${nowMs}.${expiresAtMs}.${nonce}.${signature}`,
      `${WEB_SESSION_COOKIE_NAME}=`,
    ]) {
      assert.equal(
        hasValidWebSession(new Request("https://fly-desk.test/", { headers: { cookie: malformed } }), nowMs),
        false,
        `expected ${malformed} to be refused`,
      );
    }
  } finally {
    restore();
  }
});

test("the return path accepts a path on this origin and nothing else", () => {
  assert.equal(resolveSafeNextPath("/"), "/");
  assert.equal(resolveSafeNextPath("/?mode=exact&trip=one-way&origin=LIM"), "/?mode=exact&trip=one-way&origin=LIM");
  assert.equal(resolveSafeNextPath("/index.html?a=1"), "/index.html?a=1");
  /* A fragment never reaches the server, so it is dropped rather than echoed. */
  assert.equal(resolveSafeNextPath("/a?b=1#c"), "/a?b=1");

  for (const hostile of [
    "//evil.com",
    "//evil.com/path",
    "///evil.com",
    "/\\evil.com",
    "/\\/evil.com",
    "\\\\evil.com",
    "https://evil.com/x",
    "http://evil.com",
    "//",
    "javascript:alert(1)",
    "evil.com",
    "",
    "   ",
    "/login",
    "/login?next=/",
    "/logout",
    `/${"a".repeat(600)}`,
    `/path${String.fromCharCode(0)}/x`,
    "/path\nLocation: https://evil.com",
    undefined,
    null,
    42,
    { pathname: "/" },
  ]) {
    assert.equal(resolveSafeNextPath(hostile), undefined, `expected ${JSON.stringify(hostile)} to be refused`);
  }
});

test("the login URL carries only what survived the check", () => {
  assert.equal(loginPageLocation(), "/login");
  assert.equal(loginPageLocation(undefined, true), "/login?error=1");
  /* The default destination is not worth a query parameter. */
  assert.equal(loginPageLocation("/"), "/login");
  assert.equal(loginPageLocation("/", true), "/login?error=1");
  assert.equal(loginPageLocation("/?origin=LIM&destination=MIA"), "/login?next=%2F%3Forigin%3DLIM%26destination%3DMIA");
  assert.equal(loginPageLocation("/?origin=LIM", true), "/login?error=1&next=%2F%3Forigin%3DLIM");
  assert.equal(loginPageLocation("https://evil.com/"), "/login");
  assert.equal(loginPageLocation("//evil.com", true), "/login?error=1");
});

test("the gate carries the return path as a posted field, escaped", { concurrency: false }, () => {
  /* Two layers, and both carry weight: the URL parse percent-encodes the quote
     and the angle brackets, and escapeHtml then takes the ampersands. */
  const html = renderLoginPage(undefined, "light", `/?origin=LIM&destination="MIA"&x=<b>`);

  assert.match(html, /<input type="hidden" name="next" value="\/\?origin=LIM&amp;destination=%22MIA%22&amp;x=%3Cb%3E">/);
  /* An off-origin value never reaches the page, even by this route. */
  assert.doesNotMatch(renderLoginPage(undefined, "light", "https://evil.com/"), /name="next"/);
  assert.doesNotMatch(renderLoginPage(), /name="next"/);
});
