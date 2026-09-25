import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SearchRequest } from "../../src/core/types";
import { isAllowedCostamarBrandedSearchLocation } from "../../src/local-costamar";
import { checkWebLoginAdmission, recordFailedWebLogin, resetWebLoginAdmission } from "../../src/login-admission";
import { normalizeCostamarProviderContext } from "../../src/provider-context";
import {
  WEB_SESSION_COOKIE_NAME,
  createScryptPasswordHash,
  createWebSessionCookie,
  getWebAuthConfigError,
  hasValidWebSession,
  loginPageLocation,
  renderLoginPage,
  renewWebSessionCookies,
  resolveSafeNextPath,
  verifyWebPassword,
} from "../../src/web-auth";

/*
 * Boundaries an end-to-end run cannot reach deterministically: forged and
 * aged cookies, hostile return paths, the admission table's memory bound, the
 * purchase-link allowlist and the token file's hot reload.
 */

const TTL_SECONDS = 3_600;
const MAX_LIFETIME_SECONDS = 7_200;
const managedEnv = [
  "FLY_DESK_WEB_AUTH",
  "FLY_DESK_WEB_SESSION_SECRET",
  "FLY_DESK_WEB_SESSION_TTL_SECONDS",
  "FLY_DESK_WEB_SESSION_MAX_LIFETIME_SECONDS",
  "FLY_DESK_WEB_PASSWORD_HASH",
  "FLY_DESK_COOKIE_SECURE",
  "CBPLUS_TOKEN",
  "CBPLUS_TOKEN_FILE",
  "CBPLUS_TERMINAL_ID",
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(managedEnv.map((name) => [name, process.env[name]]));
  process.env.FLY_DESK_WEB_AUTH = "1";
  process.env.FLY_DESK_WEB_SESSION_SECRET = "unit-test-session-secret-0123456789abcdef";
  process.env.FLY_DESK_WEB_SESSION_TTL_SECONDS = String(TTL_SECONDS);
  process.env.FLY_DESK_WEB_SESSION_MAX_LIFETIME_SECONDS = String(MAX_LIFETIME_SECONDS);
  process.env.FLY_DESK_COOKIE_SECURE = "0";
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

function cookieValue(setCookie: string): string {
  return setCookie.split(";")[0]!.slice(WEB_SESSION_COOKIE_NAME.length + 1);
}

function withSession(value: string): Request {
  return new Request("http://127.0.0.1/api/search", { headers: { cookie: `${WEB_SESSION_COOKIE_NAME}=${value}` } });
}

describe("web session cookie", () => {
  const signedInAt = Date.UTC(2026, 8, 1, 12, 0, 0);
  const request = new Request("http://127.0.0.1/login");

  test("is accepted only while signed, unexpired and in the current format", () => {
    const value = cookieValue(createWebSessionCookie(request, signedInAt));
    const [version, issuedAt, expiresAt, nonce, signature] = value.split(".");

    expect(hasValidWebSession(withSession(value), signedInAt + 1_000)).toBe(true);
    expect(hasValidWebSession(withSession(value), signedInAt + TTL_SECONDS * 1_000)).toBe(false);
    const forgedExpiry = [version, issuedAt, String(Number(expiresAt) + 86_400_000), nonce, signature].join(".");
    expect(hasValidWebSession(withSession(forgedExpiry), signedInAt + 1_000)).toBe(false);
    const forgedSignature = [version, issuedAt, expiresAt, nonce, `${signature!.slice(0, -2)}AA`].join(".");
    expect(hasValidWebSession(withSession(forgedSignature), signedInAt + 1_000)).toBe(false);
    const previousFormat = ["v1", expiresAt, nonce, signature].join(".");
    expect(hasValidWebSession(withSession(previousFormat), signedInAt + 1_000)).toBe(false);

    process.env.FLY_DESK_WEB_SESSION_SECRET = "a-different-secret-0123456789abcdefghij";
    expect(hasValidWebSession(withSession(value), signedInAt + 1_000)).toBe(false);
  });

  test("slides after half its window and never past the cap set at sign-in", () => {
    const value = cookieValue(createWebSessionCookie(request, signedInAt));
    expect(renewWebSessionCookies(withSession(value), signedInAt + TTL_SECONDS * 400)).toBeUndefined();

    const firstSlideAt = signedInAt + TTL_SECONDS * 600;
    const renewed = renewWebSessionCookies(withSession(value), firstSlideAt);
    expect(renewed?.expiresAtMs).toBe(firstSlideAt + TTL_SECONDS * 1_000);
    expect(renewed?.redirectSessionCookie).toContain("Path=/r");

    const capAt = signedInAt + MAX_LIFETIME_SECONDS * 1_000;
    const nearCap = renewWebSessionCookies(withSession(cookieValue(renewed!.sessionCookie)), signedInAt + TTL_SECONDS * 1_500);
    expect(nearCap?.expiresAtMs).toBe(capAt);
    const pinned = cookieValue(nearCap!.sessionCookie);
    expect(renewWebSessionCookies(withSession(pinned), capAt - 60_000)).toBeUndefined();
    expect(hasValidWebSession(withSession(pinned), capAt - 1)).toBe(true);
    expect(hasValidWebSession(withSession(pinned), capAt)).toBe(false);
  });
});

describe("sign-in gate", () => {
  test("returns only to a path on this origin", () => {
    const accepted: Array<[string, string]> = [
      ["/", "/"],
      ["/?origin=LIM&destination=CUZ", "/?origin=LIM&destination=CUZ"],
      ["/a/../b", "/b"],
    ];
    for (const [input, expected] of accepted) {
      expect(resolveSafeNextPath(input)).toBe(expected);
    }

    const rejected = [
      "//evil.example",
      "/.//evil.example",
      "/..//evil.example",
      "/%2e//evil.example",
      "/\\evil.example",
      "https://evil.example/",
      "javascript:alert(1)",
      "/login",
      "/logout",
      "relative/path",
      "/\u0000x",
      `/${"a".repeat(600)}`,
    ];
    for (const input of rejected) {
      expect(resolveSafeNextPath(input)).toBeUndefined();
    }
    expect(loginPageLocation("//evil.example", true)).toBe("/login?error=1");
  });

  test("escapes what it echoes back", () => {
    const html = renderLoginPage(
      "<img src=x onerror=alert(1)>",
      "light",
      `/?q="><script>alert(1)</script>`,
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain(`"><script>`);
  });

  test("accepts only a well-formed scrypt password hash", () => {
    process.env.FLY_DESK_WEB_PASSWORD_HASH = "plain-text-password";
    expect(getWebAuthConfigError()).toBeDefined();
    expect(verifyWebPassword("plain-text-password").ok).toBe(false);

    process.env.FLY_DESK_WEB_PASSWORD_HASH = "sha256:5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8";
    expect(getWebAuthConfigError()).toBeDefined();

    process.env.FLY_DESK_WEB_PASSWORD_HASH = createScryptPasswordHash("correct horse battery staple");
    expect(getWebAuthConfigError()).toBeUndefined();
    expect(verifyWebPassword("correct horse battery staple").ok).toBe(true);
    expect(verifyWebPassword("correct horse battery stapler").ok).toBe(false);
  });

  test("refuses the sixth failure per client for fifteen minutes, within a bounded table", () => {
    resetWebLoginAdmission();
    const at = Date.UTC(2026, 8, 1, 12, 0, 0);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(checkWebLoginAdmission("198.51.100.7", at + attempt).allowed).toBe(true);
      recordFailedWebLogin("198.51.100.7", at + attempt);
    }
    const refused = checkWebLoginAdmission("198.51.100.7", at + 10);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(890);
    expect(checkWebLoginAdmission("198.51.100.8", at + 10).allowed).toBe(true);
    expect(checkWebLoginAdmission("198.51.100.7", at + 15 * 60_000 + 1).allowed).toBe(true);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      recordFailedWebLogin("198.51.100.9", at + attempt);
    }
    for (let client = 0; client < 1_024; client += 1) {
      recordFailedWebLogin(`203.0.113.${client}`, at + 100);
    }
    expect(checkWebLoginAdmission("198.51.100.9", at + 200).allowed).toBe(true);
    resetWebLoginAdmission();
  });
});

describe("Click and Book Plus", () => {
  const request: SearchRequest = {
    tripType: "round-trip",
    searchMode: "exact",
    legs: [{ origin: "LIM", destination: "CUZ", departureDate: "2026-12-11", returnDate: "2026-12-15" }],
    passengers: { adults: 1, children: 0, infants: 0 },
  } as SearchRequest;

  test("a purchase link redirects only to the branded search it names", () => {
    const context = normalizeCostamarProviderContext({ terminalId: "0799000001", token: "" });
    const path = "/vuelos/pro/b/LIM/CUZ/2026-12-11/2026-12-15/1/0/0";
    expect(isAllowedCostamarBrandedSearchLocation(`https://flights.zdev.tech${path}?terminalId=0799000001&lang=es&token=x`, request, context)).toBe(true);
    for (const location of [
      `http://flights.zdev.tech${path}`,
      `https://flights.zdev.tech.evil.example${path}`,
      `https://user:pass@flights.zdev.tech${path}`,
      "https://flights.zdev.tech/vuelos/pro/b/LIM/MIA/2026-12-11/2026-12-15/1/0/0",
      "https://evil.example/vuelos/pro/b/LIM/CUZ/2026-12-11/2026-12-15/1/0/0",
      "not a url",
    ]) {
      expect(isAllowedCostamarBrandedSearchLocation(location, request, context)).toBe(false);
    }
  });

  test("a renewed token file is read without restarting the process", async () => {
    const directory = mkdtempSync(join(tmpdir(), "flydesk-token-"));
    const file = join(directory, "cbplus-token");
    const jwt = (id: string) => [
      Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify({ id: "0799000001", sub: id, exp: 4_102_444_800 })).toString("base64url"),
      "s".repeat(43),
    ].join(".");
    try {
      process.env.CBPLUS_TERMINAL_ID = "0799000001";
      process.env.CBPLUS_TOKEN = jwt("from-environment");
      process.env.CBPLUS_TOKEN_FILE = file;

      expect(normalizeCostamarProviderContext().token).toBe(jwt("from-environment"));
      writeFileSync(file, `${jwt("first-renewal")}\n`);
      await Bun.sleep(1_100);
      expect(normalizeCostamarProviderContext().token).toBe(jwt("first-renewal"));
      writeFileSync(file, `${jwt("second-renewal-longer")}\n`);
      await Bun.sleep(1_100);
      expect(normalizeCostamarProviderContext().token).toBe(jwt("second-renewal-longer"));
      unlinkSync(file);
      await Bun.sleep(1_100);
      expect(normalizeCostamarProviderContext().token).toBe(jwt("from-environment"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
