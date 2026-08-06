import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  applyCostamarB2bKeyboardInput,
  buildCostamarB2bWarmupPayload,
  applyCostamarContextToBrandedSearchUrl,
  buildCostamarBrandedSearchUrl,
  buildCostamarSearchBody,
  buildCostamarSearchWarning,
  cleanupTemporaryCostamarChromeProfileForTests,
  collectCostamarCandidatesFromPageForTests,
  COSTAMAR_CONCURRENCY,
  createLocalCostamarMatrixDraft,
  detectCostamarB2bAuthChallenge,
  ensureCostamarB2bSessionForTests,
  generateCostamarRedirectContextViaB2BHttpForTests,
  isCostamarB2bAirlineSearchResponse,
  mapCostamarLocationSuggestion,
  mapCostamarRecommendationToOffer,
  resetCostamarWarmupStateForTests,
  resolveCostamarChromeExecutableCandidatesForTests,
  resolveCostamarSessionWarmupTimeoutMsForTests,
  resolveLocalCostamarMatrixProgressive,
  resolveLocalCostamarRangeProgressive,
  resolveCostamarRedirectForRequest,
  readCostamarJsonResponse,
  searchLocalCostamarExact,
  searchLocalCostamarRange,
  prepareTemporaryCostamarChromeProfileForTests,
  setCostamarWarmupGeneratorForTests,
  setCostamarWarmupOpenerForTests,
  shouldWarnCostamarRedirectUnavailable,
  verifyCostamarRedirectCandidate,
  warmCostamarRedirectContext,
} from "../src/local-costamar";
import {
  buildProviderContext,
  extractCostamarSessionCandidates,
  pickLatestCostamarSessionCandidate,
  resetCostamarSessionCacheForTests,
  resolveLatestCostamarProviderContext,
  resolveCostamarProviderContext,
  resolveUsableCostamarBrandedToken,
} from "../src/provider-context";
import { createProviderStatusTracker } from "../src/provider-status";
import type { CanonicalOffer, SearchRequest } from "../src/core/types";
import { generateTotpCode, generateTotpCodeWithMetadata, totpCanSubmitSafely } from "../src/totp";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function buildRequest(): SearchRequest {
  return {
    providerId: "costamar",
    tripType: "round-trip",
    searchMode: "roundtrip-grid",
    flexibleMode: "exact-stay",
    legs: [
      {
        origin: "LIM",
        destination: "MAD",
        departureStart: "2026-04-01",
        departureEnd: "2026-04-03",
        returnStart: "2026-04-10",
        returnEnd: "2026-04-13",
        stayNights: 10,
      },
    ],
    passengers: {
      adults: 1,
      children: 1,
      infants: 1,
    },
    cabin: "ECONOMY",
    filters: {},
    coverageMode: "core",
    redirectMode: "best-effort",
    currencyCode: "USD",
    locale: "es-PE",
    market: "PE",
  };
}

test("Costamar autocomplete maps only explicit city and airport suggestion types", () => {
  const airport = mapCostamarLocationSuggestion({
    code: "LIM",
    cityCode: "LIM",
    cityName: "Lima",
    countryCode: "PE",
    type: " airport ",
    name: "LIM - Lima, Perú",
  });
  const unknown = mapCostamarLocationSuggestion({
    code: "RIO",
    cityCode: "RIO",
    cityName: "Río de Janeiro",
    countryCode: "BR",
    type: "METROPOLITAN",
    name: "RIO - Río de Janeiro, Brasil",
  });

  assert.equal(airport?.type, "AIRPORT");
  assert.equal(airport?.searchType, "airport");
  assert.equal(unknown?.type, undefined);
  assert.equal(unknown?.searchType, "METROPOLITAN");
});

test("Costamar JSON errors never expose provider response bodies", async () => {
  const secretFixture = "token=secret-fixture";
  const response = new Response(`${secretFixture}${"x".repeat(32_000)}`, {
    status: 500,
    statusText: "Upstream Failure",
  });

  await assert.rejects(
    readCostamarJsonResponse(response, "Click and Book Plus fixture"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /failed with HTTP 500/);
      assert.doesNotMatch(error.message, /secret-fixture|token=/);
      assert.ok(error.message.length < 200);
      return true;
    },
  );
});

test("Costamar JSON errors are stable for empty and non-JSON success bodies", async () => {
  await assert.rejects(
    readCostamarJsonResponse(new Response("<html>login</html>", { status: 200 }), "Costamar HTML fixture"),
    /Costamar HTML fixture returned invalid JSON\./,
  );
  await assert.rejects(
    readCostamarJsonResponse(new Response("", { status: 200 }), "Costamar empty fixture"),
    /Costamar empty fixture returned an empty JSON response\./,
  );
});

test("Costamar transport errors never expose fetch diagnostics", async () => {
  const previousFetch = global.fetch;
  global.fetch = (async () => {
    throw new Error("request failed with token=secret-fixture at https://provider.invalid/private");
  }) as typeof fetch;

  try {
    await assert.rejects(
      searchLocalCostamarExact(buildRequest(), {
        costamar: {
          apiBaseUrl: "https://air-search-service-zneith.zdev.tech/v2",
          brandBaseUrl: "https://flights.zdev.tech/vuelos/pro",
          engineBaseUrl: "https://api-zneith.zdev.tech/api-engine",
          terminalId: "0721808110",
          token: "secret-token",
          lang: "es",
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /failed before receiving a response/);
        assert.doesNotMatch(error.message, /secret-fixture|provider\.invalid|token=/);
        return true;
      },
    );
  } finally {
    global.fetch = previousFetch;
  }
});

function buildJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value))
    .toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

function encodeProtoVarint(value: number): number[] {
  const bytes: number[] = [];
  let current = BigInt(value);

  while (current >= 0x80n) {
    bytes.push(Number((current & 0x7fn) | 0x80n));
    current >>= 7n;
  }

  bytes.push(Number(current));
  return bytes;
}

function encodeProtoBytesField(fieldNumber: number, value: Buffer | string): Buffer {
  const payload = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return Buffer.from([
    ...encodeProtoVarint((fieldNumber << 3) | 2),
    ...encodeProtoVarint(payload.length),
    ...payload,
  ]);
}

function encodeProtoVarintField(fieldNumber: number, value: number): Buffer {
  return Buffer.from([
    ...encodeProtoVarint(fieldNumber << 3),
    ...encodeProtoVarint(value),
  ]);
}

function decodeBase32Secret(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = secret.replace(/=+$/g, "").toUpperCase();
  let bits = "";

  for (const char of normalized) {
    const index = alphabet.indexOf(char);
    if (index < 0) {
      throw new Error(`Invalid Base32 test secret: ${secret}`);
    }
    bits += index.toString(2).padStart(5, "0");
  }

  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }

  return Buffer.from(bytes);
}

function buildOtpauthMigrationUri(entries: Array<{
  secret: string;
  name: string;
  issuer: string;
}>): string {
  const payload = Buffer.concat(entries.map((entry) => {
    const otpParameters = Buffer.concat([
      encodeProtoBytesField(1, decodeBase32Secret(entry.secret)),
      encodeProtoBytesField(2, entry.name),
      encodeProtoBytesField(3, entry.issuer),
      encodeProtoVarintField(4, 1),
      encodeProtoVarintField(5, 1),
      encodeProtoVarintField(6, 2),
    ]);

    return encodeProtoBytesField(1, otpParameters);
  }));

  return `otpauth-migration://offline?data=${payload.toString("base64url")}`;
}

function buildExactRequest(): SearchRequest {
  return {
    providerId: "costamar",
    tripType: "one-way",
    searchMode: "exact",
    legs: [
      {
        origin: "LIM",
        destination: "MAD",
        departureDate: "2026-06-01",
      },
    ],
    passengers: {
      adults: 1,
      children: 0,
      infants: 0,
    },
    cabin: "ECONOMY",
    filters: {},
    coverageMode: "core",
    redirectMode: "best-effort",
    currencyCode: "USD",
    locale: "es-PE",
    market: "PE",
  };
}

function buildRecommendation() {
  return {
    id: "rec-1",
    itinerary: [
      {
        flights: [
          {
            departureAirport: {
              code: "LIM",
              cityName: "Lima",
            },
            arrivalAirport: {
              code: "MAD",
              cityName: "Madrid",
            },
            departureDateTime: "2026-06-01T10:00:00-05:00",
            arrivalDateTime: "2026-06-01T22:00:00+02:00",
            marketingAirline: {
              code: "UX",
              name: "Air Europa",
            },
            flightNumber: "75",
          },
        ],
      },
    ],
    pricing: {
      total: 950,
      base: 700,
      taxes: 250,
      validatingAirline: "UX",
    },
  };
}

function buildEngine() {
  return {
    profile: {
      currencyCode: "USD",
    },
  };
}

function buildEngineWithCurrency(currencyCode: string) {
  return {
    profile: {
      currencyCode,
    },
  };
}

test("Costamar does not invent carrier or flight number when the provider omits them", () => {
  const recommendation = buildRecommendation();
  const providerSegment = recommendation.itinerary[0]?.flights[0] as {
    marketingAirline?: { code?: string; name?: string };
    flightNumber?: string;
  } | undefined;
  assert.ok(providerSegment);
  delete providerSegment.marketingAirline;
  delete providerSegment.flightNumber;

  const normalized = mapCostamarRecommendationToOffer(
    recommendation,
    buildExactRequest(),
    {
      apiBaseUrl: "https://costamar.example/api",
      brandBaseUrl: "https://booking.clickandbook.com/vuelos",
      terminalId: "0721808110",
      token: "secret-token",
      lang: "es",
    },
    buildEngine(),
  );
  const segment = normalized.offer?.itineraries[0]?.segments[0];

  assert.ok(segment);
  assert.equal(segment.marketingCarrier, "");
  assert.equal(segment.flightNumber, "");
});

test("buildProviderContext normalizes Costamar defaults and overrides", () => {
  const context = buildProviderContext("costamar", {
    costamar: {
      terminalId: "0721808110",
      token: "secret-token",
      lang: "es",
    },
  });

  assert.deepEqual(context, {
    costamar: {
      apiBaseUrl: "https://air-search-service-zneith.zdev.tech/v2",
      brandBaseUrl: "https://flights.zdev.tech/vuelos/pro",
      engineBaseUrl: "https://api-zneith.zdev.tech/api-engine",
      markupBaseUrl: "https://commons-service-b-zneith.zdev.tech/markup-service",
      terminalId: "0721808110",
      token: "secret-token",
      lang: "es",
    },
  });
});

test("resolveUsableCostamarBrandedToken enforces terminal match and JWT freshness", () => {
  const validToken = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  const expiredToken = buildJwt({
    id: "0721808110",
    iat: 1700000000,
    exp: 1700003600,
  });
  const wrongTerminalToken = buildJwt({
    id: "9999999999",
    iat: 1893456000,
    exp: 1893459600,
  });

  assert.equal(resolveUsableCostamarBrandedToken(validToken, "0721808110", 1893457000000), validToken);
  assert.equal(resolveUsableCostamarBrandedToken(expiredToken, "0721808110", 1893457000000), undefined);
  assert.equal(resolveUsableCostamarBrandedToken(wrongTerminalToken, "0721808110", 1893457000000), undefined);
  assert.equal(resolveUsableCostamarBrandedToken("opaque-token", "0721808110", 1893457000000), "opaque-token");
});

test("resolveUsableCostamarBrandedToken rejects HTML and oversized opaque responses", () => {
  assert.equal(
    resolveUsableCostamarBrandedToken(
      "<!doctype html><html><body>Login required</body></html>",
      "0721808110",
      1893457000000,
    ),
    undefined,
  );
  assert.equal(
    resolveUsableCostamarBrandedToken("a".repeat(4097), "0721808110", 1893457000000),
    undefined,
  );
});

test("extractCostamarSessionCandidates reads branded urls from Chrome session text", () => {
  const older = buildJwt({
    id: "0721808110",
    iat: 1774720000,
    exp: 1774723600,
  });
  const newer = buildJwt({
    id: "0721808110",
    iat: 1774723284,
    exp: 1774726884,
  });
  const text = [
    `https://flights.zdev.tech/vuelos/pro/b/LIM/PEM/2026-03-31/1/0/0?terminalId=0721808110&token=${older}`,
    `https://flights.zdev.tech/vuelos/pro/b/LIM/MAD/2026-06-01/2026-06-08/1/1/1?terminalId=0721808110&lang=es&token=${newer}`,
  ].join("\n");

  const candidates = extractCostamarSessionCandidates(text, "test");
  assert.equal(candidates.length, 2);
  const best = pickLatestCostamarSessionCandidate(
    candidates,
    new Date("2026-03-28T18:50:00.000Z").getTime(),
  );

  assert.equal(best?.terminalId, "0721808110");
  assert.equal(best?.token, newer);
});

test("extractCostamarSessionCandidates trims trailing noise from Chrome artifacts", () => {
  const token = buildJwt({
    id: "0721808110",
    iat: 1775071689,
    exp: 1775075289,
  });
  const text =
    `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-04-22/3/1/0?terminalId=0721808110&lang=es&token=${token}{`
    + "\"visit_count\":1}";

  const candidates = extractCostamarSessionCandidates(text, "History");

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.token, token);
});

test("extractCostamarSessionCandidates trims trailing jwt-safe noise from Chrome artifacts", () => {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    id: "0721808110",
    iat: 1775509448,
    exp: 1775513048,
  })).toString("base64url");
  const token = `${header}.${payload}.7lDSbfWjiMdEiuYkHt7b7K9ZTRVmbkL7Jn8Y02gAVsM`;
  const text =
    `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-07-06/1/0/0?terminalId=0721808110&lang=es&token=${token}0`
    + "\"visit_count\":1}";

  const candidates = extractCostamarSessionCandidates(text, "History");

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.token, token);
});

test("extractCostamarSessionCandidates reads percent-encoded branded urls from Chrome storage", () => {
  const token = buildJwt({
    id: "0721808110",
    iat: 1775657759,
    exp: 1775661359,
  });
  const encodedUrl = encodeURIComponent(
    `https://booking.clickandbook.com/vuelos/b/LIM/TPP/2026-04-21/2026-04-25/2/0/0?terminalId=0721808110&lang=es&token=${token}`,
  );
  const text = `adroll_dqs=arrfrr=${encodedUrl}&_s=tracking`;

  const candidates = extractCostamarSessionCandidates(text, "Session Storage");

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.terminalId, "0721808110");
  assert.equal(candidates[0]?.token, token);
});

test("detectCostamarB2bAuthChallenge recognizes a single authenticator input", () => {
  const challenge = detectCostamarB2bAuthChallenge({
    text: "Enter your Google Authenticator code to continue.",
    inputs: [
      {
        index: 0,
        id: "email",
        name: "email",
        type: "text",
        autocomplete: "",
        maxLength: 0,
        visible: true,
      },
      {
        index: 1,
        id: "authcode",
        name: "authcode",
        type: "text",
        autocomplete: "one-time-code",
        maxLength: 6,
        visible: true,
      },
    ],
  });

  assert.deepEqual(challenge, {
    kind: "single",
    inputIndexes: [1],
  });
});

test("detectCostamarB2bAuthChallenge recognizes split OTP inputs from the challenge text", () => {
  const challenge = detectCostamarB2bAuthChallenge({
    text: "Ingresa tu codigo de verificacion para continuar.",
    inputs: Array.from({ length: 6 }, (_, index) => ({
      index,
      id: `digit-${index + 1}`,
      name: `digit-${index + 1}`,
      type: "tel",
      autocomplete: "one-time-code",
      maxLength: 1,
      visible: true,
    })),
  });

  assert.deepEqual(challenge, {
    kind: "split",
    inputIndexes: [0, 1, 2, 3, 4, 5],
  });
});

test("applyCostamarB2bKeyboardInput clears the field and types like a user", async () => {
  const calls: string[] = [];
  await applyCostamarB2bKeyboardInput(
    {
      async click() {
        calls.push("click");
      },
      async press(key: string) {
        calls.push(`press:${key}`);
      },
      async type(text: string, options?: { delay?: number }) {
        calls.push(`type:${text}:${options?.delay ?? 0}`);
      },
    },
    "secret",
  );

  assert.deepEqual(calls, [
    "click",
    `press:${process.platform === "darwin" ? "Meta+A" : "Control+A"}`,
    "press:Backspace",
    "type:secret:35",
  ]);
});

test("isCostamarB2bAirlineSearchResponse accepts localized B2B token responses", () => {
  assert.equal(
    isCostamarB2bAirlineSearchResponse(
      "POST",
      "https://www.clickandbook.plus/es/airlinesearch",
    ),
    true,
  );
  assert.equal(
    isCostamarB2bAirlineSearchResponse(
      "POST",
      "https://www.clickandbook.plus/en/airlinesearch",
    ),
    true,
  );
  assert.equal(
    isCostamarB2bAirlineSearchResponse(
      "GET",
      "https://www.clickandbook.plus/es/airlinesearch",
    ),
    false,
  );
  assert.equal(
    isCostamarB2bAirlineSearchResponse(
      "POST",
      "https://www.clickandbook.plus/es/hotelssearch",
    ),
    false,
  );
});

test("totpCanSubmitSafely rejects codes too close to the end of their window", () => {
  const secret = "JBSWY3DPEHPK3PXP";
  const result = generateTotpCodeWithMetadata(secret, 29000);

  assert.equal(result.periodSeconds, 30);
  assert.equal(result.remainingSeconds, 1);
  assert.equal(totpCanSubmitSafely(29000, result.periodSeconds, 5), false);
  assert.equal(totpCanSubmitSafely(25000, result.periodSeconds, 5), true);
});

test("generateTotpCode supports Base32 secrets and otpauth URIs", () => {
  const base32Secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(generateTotpCode(base32Secret, 59000), "287082");
  assert.equal(
    generateTotpCode(`otpauth://totp/Costamar?secret=${base32Secret}&digits=6&period=30&algorithm=SHA1`, 59000),
    "287082",
  );
});

test("generateTotpCode supports otpauth-migration exports and prefers the Costamar entry", () => {
  const costamarSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const migrationUri = buildOtpauthMigrationUri([
    {
      secret: "JBSWY3DPEHPK3PXP",
      name: "Correo personal",
      issuer: "Otro",
    },
    {
      secret: costamarSecret,
      name: "Click & Book",
      issuer: "Costamar",
    },
  ]);

  assert.equal(generateTotpCode(migrationUri, 59000), "287082");
});

test("generateTotpCode can extract a Proton Pass style totpUri from JSON", () => {
  const base32Secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const protonPassJson = JSON.stringify({
    metadata: {
      name: "Costamar",
    },
    content: {
      totpUri: `otpauth://totp/Costamar?secret=${base32Secret}&issuer=Costamar`,
    },
  });

  assert.equal(generateTotpCode(protonPassJson, 59000), "287082");
});

test("keeps Costamar range searches lighter than matrix fan-out by default", () => {
  assert.equal(COSTAMAR_CONCURRENCY.matrixMinimum, 4);
  assert.equal(COSTAMAR_CONCURRENCY.rangeMinimum, 2);
  assert.ok(COSTAMAR_CONCURRENCY.matrixCell >= COSTAMAR_CONCURRENCY.matrixMinimum);
  assert.ok(COSTAMAR_CONCURRENCY.rangeSearch >= COSTAMAR_CONCURRENCY.rangeMinimum);
  assert.ok(COSTAMAR_CONCURRENCY.rangeSearch < COSTAMAR_CONCURRENCY.matrixCell);
});

test("resolveCostamarProviderContext can recover the freshest token from Chrome sessions", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-session-"));
  const profileName = "Profile 40";
  const sessionsDir = join(tempRoot, profileName, "Sessions");
  mkdirSync(sessionsDir, { recursive: true });

  const token = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  writeFileSync(
    join(sessionsDir, "Tabs_1"),
    `https://booking.clickandbook.com/vuelos/b/LIM/PEM/2026-03-31/1/0/0?terminalId=0721808110&token=${token}`,
    "utf8",
  );

  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;

  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = profileName;
  resetCostamarSessionCacheForTests();

  try {
    const context = resolveCostamarProviderContext({
      apiBaseUrl: "https://costamar.example/api",
      brandBaseUrl: "https://booking.clickandbook.com/vuelos",
      lang: "es",
    });

    assert.equal(context.terminalId, "0721808110");
    assert.equal(context.token, token);
  } finally {
    resetCostamarSessionCacheForTests();
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveCostamarProviderContext ignores encoded Costamar URLs from Chrome session storage", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-session-storage-"));
  const profileName = "Profile 41";
  const sessionStorageDir = join(tempRoot, profileName, "Session Storage");
  mkdirSync(sessionStorageDir, { recursive: true });

  const token = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  const encodedUrl = encodeURIComponent(
    `https://booking.clickandbook.com/vuelos/b/LIM/TPP/2026-04-21/2026-04-25/2/0/0?terminalId=0721808110&lang=es&token=${token}`,
  );
  writeFileSync(
    join(sessionStorageDir, "000001.log"),
    `namespace-booking=adroll_dqs=arrfrr=${encodedUrl}&_s=tracking`,
    "utf8",
  );

  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;

  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = profileName;
  resetCostamarSessionCacheForTests();

  try {
    const context = resolveCostamarProviderContext({
      apiBaseUrl: "https://costamar.example/api",
      brandBaseUrl: "https://booking.clickandbook.com/vuelos",
      lang: "es",
    });

    assert.equal(context.terminalId, "0721808110");
    assert.equal(context.token, "");
  } finally {
    resetCostamarSessionCacheForTests();
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveCostamarProviderContext refreshes an expired token with a newer Chrome session token", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-refresh-current-"));
  const profileName = "Profile 40";
  const sessionsDir = join(tempRoot, profileName, "Sessions");
  mkdirSync(sessionsDir, { recursive: true });

  const staleToken = buildJwt({
    id: "0721808110",
    iat: 1775522371,
    exp: 1775525971,
  });
  const freshToken = buildJwt({
    id: "0721808110",
    iat: 1775574618,
    exp: 1775578218,
  });
  writeFileSync(
    join(sessionsDir, "Tabs_1"),
    `https://booking.clickandbook.com/vuelos/b/LIM/BUE/2026-04-10/2026-05-10/1/0/0?terminalId=0721808110&lang=es&token=${freshToken}`,
    "utf8",
  );

  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;

  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = profileName;
  resetCostamarSessionCacheForTests();

  try {
    const context = resolveCostamarProviderContext({
      terminalId: "0721808110",
      token: staleToken,
      lang: "es",
    });

    assert.equal(context.terminalId, "0721808110");
    assert.equal(context.token, freshToken);
  } finally {
    resetCostamarSessionCacheForTests();
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveCostamarProviderContext replaces a token from another terminal", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-terminal-mismatch-"));
  const profileName = "Profile 44";
  const sessionsDir = join(tempRoot, profileName, "Sessions");
  mkdirSync(sessionsDir, { recursive: true });

  const wrongTerminalToken = buildJwt({
    id: "9999999999",
    iat: 1775574618,
    exp: 1775578218,
  });
  const freshToken = buildJwt({
    id: "0721808110",
    iat: 1775578218,
    exp: 1775581818,
  });
  writeFileSync(
    join(sessionsDir, "Tabs_1"),
    `https://booking.clickandbook.com/vuelos/b/LIM/BUE/2026-04-10/2026-05-10/1/0/0?terminalId=0721808110&lang=es&token=${freshToken}`,
    "utf8",
  );

  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;

  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = profileName;
  resetCostamarSessionCacheForTests();

  try {
    const context = resolveCostamarProviderContext({
      terminalId: "0721808110",
      token: wrongTerminalToken,
      lang: "es",
    });

    assert.equal(context.terminalId, "0721808110");
    assert.equal(context.token, freshToken);
  } finally {
    resetCostamarSessionCacheForTests();
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveCostamarProviderContext can recover the freshest token from utf16 Chrome sessions", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-session-utf16-"));
  const profileName = "Profile 41";
  const sessionsDir = join(tempRoot, profileName, "Sessions");
  mkdirSync(sessionsDir, { recursive: true });

  const token = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  writeFileSync(
    join(sessionsDir, "Session_1"),
    Buffer.from(
      `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&token=${token}`,
      "utf16le",
    ),
  );

  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;

  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = profileName;
  resetCostamarSessionCacheForTests();

  try {
    const context = resolveCostamarProviderContext({
      apiBaseUrl: "https://costamar.example/api",
      brandBaseUrl: "https://booking.clickandbook.com/vuelos",
      lang: "es",
    });

    assert.equal(context.terminalId, "0721808110");
    assert.equal(context.token, token);
  } finally {
    resetCostamarSessionCacheForTests();
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveLatestCostamarProviderContext refreshes a cached token from Chrome sessions", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-refresh-"));
  const profileName = "Profile 40";
  const sessionsDir = join(tempRoot, profileName, "Sessions");
  mkdirSync(sessionsDir, { recursive: true });

  const freshToken = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  writeFileSync(
    join(sessionsDir, "Tabs_1"),
    `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&token=${freshToken}`,
    "utf8",
  );

  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;

  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = profileName;
  resetCostamarSessionCacheForTests();

  try {
    const context = resolveLatestCostamarProviderContext({
      terminalId: "0721808110",
      token: "stale-token",
      lang: "es",
    });

    assert.equal(context.terminalId, "0721808110");
    assert.equal(context.token, freshToken);
  } finally {
    resetCostamarSessionCacheForTests();
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveLatestCostamarProviderContext keeps the newest token for the requested terminal", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-terminal-scope-"));
  const profileName = "Profile 43";
  const sessionsDir = join(tempRoot, profileName, "Sessions");
  mkdirSync(sessionsDir, { recursive: true });

  const matchingTerminalToken = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  const otherTerminalToken = buildJwt({
    id: "9999999999",
    iat: 1893463200,
    exp: 1893466800,
  });
  writeFileSync(
    join(sessionsDir, "Tabs_1"),
    [
      `https://booking.clickandbook.com/vuelos/b/LIM/BUE/2026-04-10/2026-05-10/1/0/0?terminalId=9999999999&lang=es&token=${otherTerminalToken}`,
      `https://booking.clickandbook.com/vuelos/b/LIM/BUE/2026-04-10/2026-05-10/1/0/0?terminalId=0721808110&lang=es&token=${matchingTerminalToken}`,
    ].join("\n"),
    "utf8",
  );

  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;

  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = profileName;
  resetCostamarSessionCacheForTests();

  try {
    const context = resolveLatestCostamarProviderContext({
      terminalId: "0721808110",
      token: "stale-token",
      lang: "es",
    });

    assert.equal(context.terminalId, "0721808110");
    assert.equal(context.token, matchingTerminalToken);
  } finally {
    resetCostamarSessionCacheForTests();
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveLatestCostamarProviderContext can recover the freshest token from Chrome history", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-history-"));
  const profileName = "Profile 40";
  const profileDir = join(tempRoot, profileName);
  mkdirSync(profileDir, { recursive: true });

  const token = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  writeFileSync(
    join(profileDir, "History"),
    `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${token}{`
      + "\"visit_count\":1}",
    "utf8",
  );

  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;

  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = profileName;
  resetCostamarSessionCacheForTests();

  try {
    const context = resolveLatestCostamarProviderContext({
      terminalId: "0721808110",
      lang: "es",
    });

    assert.equal(context.terminalId, "0721808110");
    assert.equal(context.token, token);
  } finally {
    resetCostamarSessionCacheForTests();
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveLatestCostamarProviderContext ignores Costamar URLs from Chrome session storage", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-storage-"));
  const profileName = "Profile 42";
  const storageDir = join(tempRoot, profileName, "Session Storage");
  mkdirSync(storageDir, { recursive: true });

  const token = buildJwt({
    id: "0721808110",
    iat: 1893459600,
    exp: 1893463200,
  });
  writeFileSync(
    join(storageDir, "001217.log"),
    Buffer.from(
      `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&token=${token}`,
      "utf16le",
    ),
  );

  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;

  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = profileName;
  resetCostamarSessionCacheForTests();

  try {
    const context = resolveLatestCostamarProviderContext({
      terminalId: "0721808110",
      lang: "es",
    });

    assert.equal(context.terminalId, "0721808110");
    assert.equal(context.token, "");
  } finally {
    resetCostamarSessionCacheForTests();
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveLatestCostamarProviderContext rescans Chrome after an empty cached lookup", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-cache-refresh-"));
  const profileName = "Profile 43";
  const profileDir = join(tempRoot, profileName);
  mkdirSync(profileDir, { recursive: true });

  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;
  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = profileName;
  resetCostamarSessionCacheForTests();

  try {
    const first = resolveLatestCostamarProviderContext({
      terminalId: "0721808110",
      lang: "es",
    });
    assert.equal(first.token, "");

    const sessionsDir = join(profileDir, "Sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const freshToken = buildJwt({
      id: "0721808110",
      iat: 1893463200,
      exp: 1893466800,
    });
    writeFileSync(
      join(sessionsDir, "Tabs_1"),
      `https://booking.clickandbook.com/vuelos/b/CCS/MAD/2026-05-12/2026-05-22/1/0/0?terminalId=0721808110&lang=es&token=${freshToken}`,
      "utf8",
    );

    const refreshed = resolveLatestCostamarProviderContext({
      terminalId: "0721808110",
      lang: "es",
    });
    assert.equal(refreshed.terminalId, "0721808110");
    assert.equal(refreshed.token, freshToken);
  } finally {
    resetCostamarSessionCacheForTests();
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("buildCostamarBrandedSearchUrl keeps the branded round-trip path shape", () => {
  const request = buildRequest();
  request.searchMode = "exact";
  request.legs[0].departureDate = "2026-06-01";
  request.legs[0].returnDate = "2026-06-08";

  const url = buildCostamarBrandedSearchUrl(request, {
    apiBaseUrl: "https://air-search-service-zneith.zdev.tech/v2",
    brandBaseUrl: "https://flights.zdev.tech/vuelos/pro",
    engineBaseUrl: "https://api-zneith.zdev.tech/api-engine",
    markupBaseUrl: "https://commons-service-b-zneith.zdev.tech/markup-service",
    terminalId: "0721808110",
    token: "secret-token",
    lang: "es",
  });

  const parsed = new URL(url);
  assert.equal(
    parsed.pathname,
    "/vuelos/pro/b/LIM/MAD/2026-06-01/2026-06-08/1/1/1",
  );
  assert.equal(parsed.searchParams.get("terminalId"), "0721808110");
  assert.equal(parsed.searchParams.get("lang"), "es");
  assert.equal(parsed.searchParams.get("token"), "secret-token");
});

test("buildCostamarBrandedSearchUrl drops expired JWTs from the external link", () => {
  const request = buildRequest();
  request.searchMode = "exact";
  request.legs[0].departureDate = "2026-06-01";
  request.legs[0].returnDate = "2026-06-08";

  const expiredToken = buildJwt({
    id: "0721808110",
    iat: 1700000000,
    exp: 1700003600,
  });
  const url = buildCostamarBrandedSearchUrl(request, {
    apiBaseUrl: "https://costamar.example/api",
    brandBaseUrl: "https://booking.clickandbook.com/vuelos",
    terminalId: "0721808110",
    token: expiredToken,
    lang: "es",
  });

  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("token"), null);
});

test("buildCostamarBrandedSearchUrl trims trailing token noise from direct context", () => {
  const request = buildRequest();
  request.searchMode = "exact";
  request.legs[0].departureDate = "2026-06-01";
  request.legs[0].returnDate = "2026-06-08";

  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  })).toString("base64url");
  const cleanToken = `${header}.${payload}.7lDSbfWjiMdEiuYkHt7b7K9ZTRVmbkL7Jn8Y02gAVsM`;
  const noisyToken = `${cleanToken}0}`;
  const url = buildCostamarBrandedSearchUrl(request, {
    apiBaseUrl: "https://costamar.example/api",
    brandBaseUrl: "https://booking.clickandbook.com/vuelos",
    terminalId: "0721808110",
    token: noisyToken,
    lang: "es",
  });

  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("token"), cleanToken);
});

test("buildCostamarBrandedSearchUrl drops a JWT token from another terminal", () => {
  const request = buildRequest();
  request.searchMode = "exact";
  request.legs[0].departureDate = "2026-06-01";
  request.legs[0].returnDate = "2026-06-08";

  const wrongTerminalToken = buildJwt({
    id: "9999999999",
    iat: 1893456000,
    exp: 1893459600,
  });
  const url = buildCostamarBrandedSearchUrl(request, {
    apiBaseUrl: "https://costamar.example/api",
    brandBaseUrl: "https://booking.clickandbook.com/vuelos",
    terminalId: "0721808110",
    token: wrongTerminalToken,
    lang: "es",
  });

  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("token"), null);
});

test("applyCostamarContextToBrandedSearchUrl refreshes terminal and token query params", () => {
  const staleToken = buildJwt({
    id: "0721808110",
    iat: 1700000000,
    exp: 1700003600,
  });
  const freshToken = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });

  const refreshed = applyCostamarContextToBrandedSearchUrl(
    `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=OLD&lang=en&token=${staleToken}`,
    {
      apiBaseUrl: "https://costamar.example/api",
      brandBaseUrl: "https://booking.clickandbook.com/vuelos",
      terminalId: "0721808110",
      token: freshToken,
      lang: "es",
    },
  );

  const parsed = new URL(refreshed);
  assert.equal(parsed.searchParams.get("terminalId"), "0721808110");
  assert.equal(parsed.searchParams.get("lang"), "es");
  assert.equal(parsed.searchParams.get("token"), freshToken);
});

test("mapCostamarRecommendationToOffer keeps a Costamar redirect when the branded token is expired", () => {
  const normalized = mapCostamarRecommendationToOffer(
    buildRecommendation(),
    buildExactRequest(),
    {
      apiBaseUrl: "https://costamar.example/api",
      brandBaseUrl: "https://booking.clickandbook.com/vuelos",
      terminalId: "0721808110",
      token: buildJwt({
        id: "0721808110",
        iat: 1700000000,
        exp: 1700003600,
      }),
      lang: "es",
    },
    buildEngine(),
  );

  assert.ok(normalized.offer);
  assert.equal(normalized.offer?.purchasePaths.length, 1);
  const path = normalized.offer?.purchasePaths[0];
  assert.equal(path?.provider, "costamar");
  assert.equal(path?.type, "search-redirect");
  const parsed = new URL(path?.url ?? "");
  assert.equal(parsed.searchParams.get("terminalId"), "0721808110");
  assert.equal(parsed.searchParams.get("lang"), "es");
  assert.equal(parsed.searchParams.get("token"), null);
});

test("mapCostamarRecommendationToOffer keeps the Costamar redirect when a fresh token is recovered", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-purchase-path-"));
  const profileName = "Profile 45";
  const sessionsDir = join(tempRoot, profileName, "Sessions");
  mkdirSync(sessionsDir, { recursive: true });

  const staleToken = buildJwt({
    id: "0721808110",
    iat: 1700000000,
    exp: 1700003600,
  });
  const freshToken = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  writeFileSync(
    join(sessionsDir, "Tabs_1"),
    `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/1/0/0?terminalId=0721808110&token=${freshToken}`,
    "utf8",
  );

  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;
  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = profileName;
  resetCostamarSessionCacheForTests();

  try {
    const refreshedContext = resolveLatestCostamarProviderContext({
      apiBaseUrl: "https://costamar.example/api",
      brandBaseUrl: "https://booking.clickandbook.com/vuelos",
      terminalId: "0721808110",
      token: staleToken,
      lang: "es",
    });
    const normalized = mapCostamarRecommendationToOffer(
      buildRecommendation(),
      buildExactRequest(),
      refreshedContext,
      buildEngine(),
    );

    assert.ok(normalized.offer);
    assert.equal(normalized.offer?.purchasePaths.length, 1);
    assert.equal(
      new URL(normalized.offer?.purchasePaths[0]?.url ?? "").searchParams.get("token"),
      freshToken,
    );
  } finally {
    resetCostamarSessionCacheForTests();
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("mapCostamarRecommendationToOffer reads carry-on and checked baggage from the selected Costamar flight", () => {
  const recommendation = buildRecommendation();
  const firstFlight = recommendation.itinerary?.[0]?.flights?.[0];
  if (!firstFlight) {
    throw new Error("Test fixture must include at least one flight.");
  }

  firstFlight.baggage = {
    description: "BAGG DYN",
    pieces: "2",
  };
  firstFlight.handBaggage = {
    description: "HAND DYN",
    pieces: "1",
  };
  firstFlight.segments = [
    {
      departureAirport: {
        code: "LIM",
        cityName: "Lima",
      },
      arrivalAirport: {
        code: "MAD",
        cityName: "Madrid",
      },
      departureDateTime: "2026-06-01T10:00:00-05:00",
      arrivalDateTime: "2026-06-01T22:00:00+02:00",
      marketingAirline: {
        code: "UX",
        name: "Air Europa",
      },
      flightNumber: "75",
    },
  ];

  const normalized = mapCostamarRecommendationToOffer(
    recommendation,
    buildExactRequest(),
    {
      apiBaseUrl: "https://costamar.example/api",
      brandBaseUrl: "https://booking.clickandbook.com/vuelos",
      terminalId: "0721808110",
      token: "secret-token",
      lang: "es",
    },
    buildEngine(),
  );

  assert.ok(normalized.offer);
  assert.equal(normalized.offer?.baggage?.carryOnIncluded, true);
  assert.equal(normalized.offer?.baggage?.checkedIncluded, true);
  assert.equal(normalized.offer?.baggage?.checkedBags, 2);
});

test("mapCostamarRecommendationToOffer normalizes Costamar IATA-only city names", () => {
  const recommendation = buildRecommendation();
  const firstFlight = recommendation.itinerary?.[0]?.flights?.[0];
  if (!firstFlight) {
    throw new Error("Test fixture must include at least one flight.");
  }

  firstFlight.departureAirport = {
    code: "LIM",
    cityName: "LIM",
  };
  firstFlight.arrivalAirport = {
    code: "CUZ",
    cityName: "CUZ",
  };

  const normalized = mapCostamarRecommendationToOffer(
    recommendation,
    {
      ...buildExactRequest(),
      legs: [
        {
          origin: "LIM",
          destination: "CUZ",
          departureDate: "2026-06-01",
        },
      ],
    },
    {
      apiBaseUrl: "https://costamar.example/api",
      brandBaseUrl: "https://booking.clickandbook.com/vuelos",
      terminalId: "0721808110",
      token: "secret-token",
      lang: "es",
    },
    buildEngine(),
  );

  const segment = normalized.offer?.itineraries[0]?.segments[0];
  assert.equal(segment?.originName, "Lima");
  assert.equal(segment?.destinationName, "Cusco");
});

test("mapCostamarRecommendationToOffer keeps checked baggage disabled when Costamar reports zero pieces", () => {
  const recommendation = buildRecommendation();
  const firstFlight = recommendation.itinerary?.[0]?.flights?.[0];
  if (!firstFlight) {
    throw new Error("Test fixture must include at least one flight.");
  }

  firstFlight.baggage = {
    description: "BAGG DYN",
    pieces: "0",
  };
  firstFlight.handBaggage = {
    description: "HAND DYN",
    pieces: "1",
  };
  firstFlight.segments = [
    {
      departureAirport: {
        code: "LIM",
        cityName: "Lima",
      },
      arrivalAirport: {
        code: "MAD",
        cityName: "Madrid",
      },
      departureDateTime: "2026-06-01T10:00:00-05:00",
      arrivalDateTime: "2026-06-01T22:00:00+02:00",
      marketingAirline: {
        code: "UX",
        name: "Air Europa",
      },
      flightNumber: "75",
    },
  ];

  const normalized = mapCostamarRecommendationToOffer(
    recommendation,
    buildExactRequest(),
    {
      apiBaseUrl: "https://costamar.example/api",
      brandBaseUrl: "https://booking.clickandbook.com/vuelos",
      terminalId: "0721808110",
      token: "secret-token",
      lang: "es",
    },
    buildEngine(),
  );

  assert.ok(normalized.offer);
  assert.equal(normalized.offer?.baggage?.carryOnIncluded, true);
  assert.equal(normalized.offer?.baggage?.checkedIncluded, false);
  assert.equal(normalized.offer?.baggage?.checkedBags, undefined);
});

test("mapCostamarRecommendationToOffer keeps carry-on disabled when Costamar reports zero hand pieces", () => {
  const recommendation = buildRecommendation();
  const firstFlight = recommendation.itinerary?.[0]?.flights?.[0];
  if (!firstFlight) {
    throw new Error("Test fixture must include at least one flight.");
  }

  firstFlight.baggage = {
    description: "BAGG DYN",
    pieces: "0",
  };
  firstFlight.handBaggage = {
    description: "HAND DYN",
    pieces: "0",
  };

  const normalized = mapCostamarRecommendationToOffer(
    recommendation,
    buildExactRequest(),
    {
      apiBaseUrl: "https://costamar.example/api",
      brandBaseUrl: "https://booking.clickandbook.com/vuelos",
      terminalId: "0721808110",
      token: "secret-token",
      lang: "es",
    },
    buildEngine(),
  );

  assert.ok(normalized.offer);
  assert.equal(normalized.offer?.baggage?.carryOnIncluded, false);
  assert.equal(normalized.offer?.baggage?.checkedIncluded, false);
  assert.equal(normalized.offer?.baggage?.checkedBags, undefined);
});

test("buildCostamarSearchBody matches the live booking frontend payload shape", () => {
  const request = buildRequest();
  request.searchMode = "exact";
  request.legs[0].departureDate = "2026-06-01";
  request.legs[0].returnDate = "2026-06-08";

  const payload = buildCostamarSearchBody(request, {
    apiBaseUrl: "https://air-search-service-zneith.zdev.tech/v2",
    brandBaseUrl: "https://flights.zdev.tech/vuelos/pro",
    engineBaseUrl: "https://api-zneith.zdev.tech/api-engine",
    markupBaseUrl: "https://commons-service-b-zneith.zdev.tech/markup-service",
    terminalId: "0721808110",
    token: "secret-token",
    lang: "es",
  });

  const pos = payload.pos as { source?: Array<{ requestorID?: { instance?: string } }> };
  assert.equal(typeof pos.source?.[0]?.requestorID?.instance, "string");
  if (pos.source?.[0]?.requestorID) {
    pos.source[0].requestorID.instance = "__dynamic__";
  }

  assert.deepEqual(payload, {
    pos: {
      source: [
        {
          requestorID: {
            id: "0721808110",
            instance: "__dynamic__",
          },
        },
      ],
    },
    originDestinationInformation: [
      {
        departureDateTime: {
          value: "20260601",
        },
        originLocation: {
          locationCode: "LIM",
        },
        destinationLocation: {
          locationCode: "MAD",
        },
      },
      {
        departureDateTime: {
          value: "20260608",
        },
        originLocation: {
          locationCode: "MAD",
        },
        destinationLocation: {
          locationCode: "LIM",
        },
      },
    ],
    travelPreferences: [],
    travelerInfoSummary: {
      airTravelerAvail: [
        {
          airTraveler: {
            passengerTypeQuantity: {
              code: "ADT",
              quantity: 1,
            },
          },
        },
        {
          airTraveler: {
            passengerTypeQuantity: {
              code: "CHD",
              quantity: 1,
            },
          },
        },
        {
          airTraveler: {
            passengerTypeQuantity: {
              code: "INF",
              quantity: 1,
            },
          },
        },
      ],
      priceRequestInformation: null,
    },
    isValidDates: true,
    processingInfo: {
      searchType: "RT",
    },
    token: "secret-token",
    terminalId: "0721808110",
  });
});

test("buildCostamarSearchBody requires a branded validation token", () => {
  const request = buildRequest();
  request.searchMode = "exact";
  request.legs[0].departureDate = "2026-06-01";
  request.legs[0].returnDate = "2026-06-08";

  assert.throws(
    () => buildCostamarSearchBody(request, {
      apiBaseUrl: "https://costamar.example/api",
      brandBaseUrl: "https://booking.clickandbook.com/vuelos",
      terminalId: "0721808110",
      token: "",
      lang: "es",
    }),
    /Click and Book Plus token is required\./,
  );
});

test("buildCostamarSearchBody rejects expired branded validation tokens", () => {
  const request = buildRequest();
  request.searchMode = "exact";
  request.legs[0].departureDate = "2026-06-01";
  request.legs[0].returnDate = "2026-06-08";

  assert.throws(
    () => buildCostamarSearchBody(request, {
      apiBaseUrl: "https://costamar.example/api",
      brandBaseUrl: "https://booking.clickandbook.com/vuelos",
      terminalId: "0721808110",
      token: buildJwt({
        id: "0721808110",
        iat: 1700000000,
        exp: 1700003600,
      }),
      lang: "es",
    }),
    /Click and Book Plus token is required\./,
  );
});

test("buildCostamarB2bWarmupPayload matches the real flights form contract", () => {
  const payload = buildCostamarB2bWarmupPayload(buildExactRequest(), {
    apiBaseUrl: "https://costamar.example/api",
    brandBaseUrl: "https://booking.clickandbook.com/vuelos",
    terminalId: "0721808110",
    token: "",
    lang: "es",
  });

  assert.deepEqual(payload, {
    tripType: "one-way",
    terminalId: "0721808110",
    origin: "LIM",
    destination: "MAD",
    departureDate: "2026-06-01",
    departureDisplayDate: "01/06/2026",
    adults: 1,
    children: 0,
    infants: 0,
  });
});

test("buildCostamarB2bWarmupPayload keeps round-trip dates and rejects unsupported requests", () => {
  const roundTripRequest: SearchRequest = {
    ...buildExactRequest(),
    tripType: "round-trip",
    legs: [
      {
        origin: "PIU",
        destination: "LIM",
        departureDate: "2026-10-06",
        returnDate: "2026-10-08",
      },
    ],
    passengers: {
      adults: 3,
      children: 0,
      infants: 0,
    },
  };

  assert.deepEqual(buildCostamarB2bWarmupPayload(roundTripRequest, {
    apiBaseUrl: "https://costamar.example/api",
    brandBaseUrl: "https://booking.clickandbook.com/vuelos",
    terminalId: "0721808110",
    token: "",
    lang: "es",
  }), {
    tripType: "round-trip",
    terminalId: "0721808110",
    origin: "PIU",
    destination: "LIM",
    departureDate: "2026-10-06",
    departureDisplayDate: "06/10/2026",
    returnDate: "2026-10-08",
    returnDisplayDate: "08/10/2026",
    adults: 3,
    children: 0,
    infants: 0,
  });

  assert.equal(buildCostamarB2bWarmupPayload({
    ...buildExactRequest(),
    tripType: "multi-city",
  }, {
    apiBaseUrl: "https://costamar.example/api",
    brandBaseUrl: "https://booking.clickandbook.com/vuelos",
    terminalId: "0721808110",
    token: "",
    lang: "es",
  }), undefined);

  assert.equal(buildCostamarB2bWarmupPayload({
    ...buildExactRequest(),
    tripType: "round-trip",
    legs: [
      {
        origin: "LIM",
        destination: "MAD",
        departureDate: "2026-06-01",
      },
    ],
  }, {
    apiBaseUrl: "https://costamar.example/api",
    brandBaseUrl: "https://booking.clickandbook.com/vuelos",
    terminalId: "0721808110",
    token: "",
    lang: "es",
  }), undefined);
});

test("buildCostamarSearchBody rejects tokens that belong to another terminal", () => {
  const request = buildRequest();
  request.searchMode = "exact";
  request.legs[0].departureDate = "2026-06-01";
  request.legs[0].returnDate = "2026-06-08";

  assert.throws(
    () => buildCostamarSearchBody(request, {
      apiBaseUrl: "https://costamar.example/api",
      brandBaseUrl: "https://booking.clickandbook.com/vuelos",
      terminalId: "0721808110",
      token: buildJwt({
        id: "9999999999",
        iat: 1893456000,
        exp: 1893459600,
      }),
      lang: "es",
    }),
    /Click and Book Plus token is required\./,
  );
});

test("buildCostamarSearchWarning exposes closed failures without provider payload text", () => {
  assert.equal(
    buildCostamarSearchWarning({ status: 401, data: [] }),
    "Click and Book Plus rejected this search: the branded token is invalid, expired, or no longer belongs to this agency.",
  );
  assert.equal(
    buildCostamarSearchWarning({ status: 402, data: [] }),
    "Click and Book Plus rejected this search: the validation token is missing for this branded flow.",
  );
  assert.equal(
    buildCostamarSearchWarning({
      status: 403,
      data: [],
      message: "Agency mismatch token=short-secret https://provider.invalid",
    }),
    "Click and Book Plus rejected this search: agency or permission validation failed.",
  );
  assert.equal(
    buildCostamarSearchWarning({ status: 429, data: [], message: "raw throttling detail" }),
    "Click and Book Plus temporarily rate-limited this search.",
  );
  assert.equal(
    buildCostamarSearchWarning({ status: 503, data: [], message: "internal trace secret" }),
    "Click and Book Plus is temporarily unavailable.",
  );
  assert.equal(buildCostamarSearchWarning({ status: 200, data: [] }), undefined);
});

test("Costamar Playwright authentication writes no credentials after a cross-origin navigation", async () => {
  const previousBaseUrl = process.env.CBPLUS_B2B_BASE_URL;
  process.env.CBPLUS_B2B_BASE_URL = "https://www.clickandbook.plus/es/login";
  let currentUrl = "about:blank";
  let locatorCalls = 0;
  let gotoCalls = 0;

  const page = {
    url: () => currentUrl,
    async goto() {
      gotoCalls += 1;
      currentUrl = "https://attacker.invalid/login";
    },
    async waitForTimeout() {},
    async waitForLoadState() {},
    locator() {
      locatorCalls += 1;
      throw new Error("No locator may be read or written on an untrusted origin.");
    },
  };

  try {
    const authenticated = await ensureCostamarB2bSessionForTests(page);
    assert.equal(authenticated, false);
    assert.equal(gotoCalls, 1);
    assert.equal(locatorCalls, 0);
  } finally {
    if (previousBaseUrl === undefined) delete process.env.CBPLUS_B2B_BASE_URL;
    else process.env.CBPLUS_B2B_BASE_URL = previousBaseUrl;
  }
});

test("Costamar browser automation defaults to enough time for login and 2FA", () => {
  const previousPrimary = process.env.CBPLUS_SESSION_WARMUP_TIMEOUT_MS;
  const previousLegacy = process.env.COSTAMAR_SESSION_WARMUP_TIMEOUT_MS;
  delete process.env.CBPLUS_SESSION_WARMUP_TIMEOUT_MS;
  delete process.env.COSTAMAR_SESSION_WARMUP_TIMEOUT_MS;

  try {
    assert.equal(resolveCostamarSessionWarmupTimeoutMsForTests(), 30_000);
    process.env.CBPLUS_SESSION_WARMUP_TIMEOUT_MS = "12000";
    assert.equal(resolveCostamarSessionWarmupTimeoutMsForTests(), 12_000);
  } finally {
    if (previousPrimary === undefined) delete process.env.CBPLUS_SESSION_WARMUP_TIMEOUT_MS;
    else process.env.CBPLUS_SESSION_WARMUP_TIMEOUT_MS = previousPrimary;
    if (previousLegacy === undefined) delete process.env.COSTAMAR_SESSION_WARMUP_TIMEOUT_MS;
    else process.env.COSTAMAR_SESSION_WARMUP_TIMEOUT_MS = previousLegacy;
  }
});

test("Costamar Playwright authentication supports the current name-based login form", async () => {
  const previousBaseUrl = process.env.CBPLUS_B2B_BASE_URL;
  const previousEmail = process.env.CBPLUS_B2B_EMAIL;
  const previousPassword = process.env.CBPLUS_B2B_PASSWORD;
  process.env.CBPLUS_B2B_BASE_URL = "https://www.clickandbook.plus/lang/es/b2b";
  process.env.CBPLUS_B2B_EMAIL = "agent@example.test";
  process.env.CBPLUS_B2B_PASSWORD = "fixture-password";
  let currentUrl = "about:blank";
  let loginVisible = true;
  let submitted = false;
  const navigatedUrls: string[] = [];
  const typed: Record<string, string> = {};

  const absentLocator = {
    first() { return this; },
    async count() { return 0; },
    async isVisible() { return false; },
    async click() {},
    async press() {},
    async type() {},
  };
  const inputLocator = (field: "email" | "password") => ({
    first() { return this; },
    async count() { return 1; },
    async isVisible() { return loginVisible; },
    async click() {},
    async press() {},
    async type(value: string) { typed[field] = value; },
  });
  const submitLocator = {
    first() { return this; },
    async count() { return 1; },
    async isVisible() { return loginVisible; },
    async click() {
      submitted = true;
      loginVisible = false;
      currentUrl = "https://www.clickandbook.plus/es/b2b";
    },
    async press() {},
    async type() {},
  };
  const page = {
    url: () => currentUrl,
    async goto(url: string) {
      navigatedUrls.push(url);
      currentUrl = navigatedUrls.length === 1
        ? "https://www.clickandbook.plus/en/login"
        : url;
    },
    async waitForTimeout() {},
    async waitForLoadState() {},
    async evaluate() {
      return { text: "", inputs: [] };
    },
    locator(selector: string) {
      if (selector.includes("input[name='email']")) return inputLocator("email");
      if (selector.includes("input[name='password']")) return inputLocator("password");
      if (selector.includes("button[type='submit']")) return submitLocator;
      return absentLocator;
    },
  };

  try {
    const authenticated = await ensureCostamarB2bSessionForTests(page);
    assert.equal(authenticated, true);
    assert.equal(submitted, true);
    assert.deepEqual(navigatedUrls, [
      "https://www.clickandbook.plus/lang/es/b2b",
      "https://www.clickandbook.plus/es/login",
    ]);
    assert.deepEqual(typed, {
      email: "agent@example.test",
      password: "fixture-password",
    });
  } finally {
    if (previousBaseUrl === undefined) delete process.env.CBPLUS_B2B_BASE_URL;
    else process.env.CBPLUS_B2B_BASE_URL = previousBaseUrl;
    if (previousEmail === undefined) delete process.env.CBPLUS_B2B_EMAIL;
    else process.env.CBPLUS_B2B_EMAIL = previousEmail;
    if (previousPassword === undefined) delete process.env.CBPLUS_B2B_PASSWORD;
    else process.env.CBPLUS_B2B_PASSWORD = previousPassword;
  }
});

test("Costamar isolated automation can resolve the Linux system Chrome", () => {
  assert.deepEqual(
    resolveCostamarChromeExecutableCandidatesForTests("linux", {
      CBPLUS_CHROME_EXECUTABLE: "/opt/custom/chrome",
    }).slice(0, 4),
    [
      "/opt/custom/chrome",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
    ],
  );
});

test("Costamar temporary Chrome profile staging is private and avoids broad storage copies", async () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-source-profile-"));
  const profileName = "Profile 77";
  mkdirSync(join(sourceRoot, profileName, "Network"), { recursive: true });
  mkdirSync(join(sourceRoot, profileName, "Local Storage", "leveldb"), { recursive: true });
  mkdirSync(join(sourceRoot, profileName, "Session Storage"), { recursive: true });
  mkdirSync(join(sourceRoot, profileName, "IndexedDB"), { recursive: true });
  mkdirSync(join(sourceRoot, profileName, "Service Worker"), { recursive: true });
  mkdirSync(join(sourceRoot, profileName, "Sessions"), { recursive: true });
  writeFileSync(join(sourceRoot, "Local State"), "local-state", "utf8");
  writeFileSync(join(sourceRoot, profileName, "Preferences"), "preferences", "utf8");
  writeFileSync(join(sourceRoot, profileName, "Secure Preferences"), "secure-preferences", "utf8");
  writeFileSync(join(sourceRoot, profileName, "Network", "Cookies"), "cookie-store", "utf8");
  writeFileSync(join(sourceRoot, profileName, "Local Storage", "leveldb", "000001.log"), "local-storage", "utf8");
  writeFileSync(join(sourceRoot, profileName, "Session Storage", "000002.log"), "session-storage", "utf8");
  writeFileSync(join(sourceRoot, profileName, "IndexedDB", "000003.ldb"), "indexed-db", "utf8");
  writeFileSync(join(sourceRoot, profileName, "Service Worker", "ScriptCache"), "worker-cache", "utf8");
  writeFileSync(join(sourceRoot, profileName, "Sessions", "Tabs_1"), "session-tabs", "utf8");

  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  process.env.COSTAMAR_CHROME_USER_DATA_DIR = sourceRoot;

  const tempProfile = prepareTemporaryCostamarChromeProfileForTests(profileName, { cloneSourceProfile: true });

  try {
    assert.equal(existsSync(join(tempProfile, "Local State")), true);
    assert.equal(existsSync(join(tempProfile, profileName, "Preferences")), true);
    assert.equal(existsSync(join(tempProfile, profileName, "Network", "Cookies")), true);
    assert.equal(existsSync(join(tempProfile, profileName, "Secure Preferences")), false);
    assert.equal(existsSync(join(tempProfile, profileName, "Local Storage")), false);
    assert.equal(existsSync(join(tempProfile, profileName, "Session Storage")), false);
    assert.equal(existsSync(join(tempProfile, profileName, "IndexedDB")), false);
    assert.equal(existsSync(join(tempProfile, profileName, "Service Worker")), false);
    assert.equal(existsSync(join(tempProfile, profileName, "Sessions")), false);

    if (process.platform !== "win32") {
      assert.equal(statSync(tempProfile).mode & 0o777, 0o700);
      assert.equal(statSync(join(tempProfile, "Local State")).mode & 0o777, 0o600);
      assert.equal(statSync(join(tempProfile, profileName, "Network", "Cookies")).mode & 0o777, 0o600);
    }
  } finally {
    await cleanupTemporaryCostamarChromeProfileForTests(tempProfile);
    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }
    rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test("Costamar live browser collection skips unrelated tabs", async () => {
  let evaluated = false;
  const candidates = await collectCostamarCandidatesFromPageForTests({
    url: () => "https://private.example.test/inbox",
    evaluate: async () => {
      evaluated = true;
      return JSON.stringify({
        href: "https://private.example.test/inbox",
        html: "",
        localStorage: [
          "token=https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/1/0/0?terminalId=0721808110&token=fake.token.value",
        ],
        sessionStorage: [],
      });
    },
  });

  assert.equal(evaluated, false);
  assert.equal(candidates.length, 0);
});

test("mapCostamarRecommendationToOffer keeps USD as the offer currency for quotation math", () => {
  const normalized = mapCostamarRecommendationToOffer(
    buildRecommendation(),
    buildExactRequest(),
    {
      apiBaseUrl: "https://costamar.example/api",
      brandBaseUrl: "https://booking.clickandbook.com/vuelos",
      terminalId: "0721808110",
      token: "secret-token",
      lang: "es",
    },
    buildEngineWithCurrency("PEN"),
  );

  assert.ok(normalized.offer);
  assert.equal(normalized.offer?.price.total.currencyCode, "USD");
  assert.equal(normalized.offer?.price.base?.currencyCode, "USD");
  assert.equal(normalized.offer?.price.taxes?.currencyCode, "USD");
});

test("mapCostamarRecommendationToOffer parses formatted money strings", () => {
  const recommendation = buildRecommendation() as ReturnType<typeof buildRecommendation> & {
    pricing: Record<string, unknown>;
  };
  recommendation.pricing.total = "USD 1,001.16";
  recommendation.pricing.base = "700.00";
  recommendation.pricing.taxes = "301.16";

  const normalized = mapCostamarRecommendationToOffer(
    recommendation,
    buildExactRequest(),
    {
      apiBaseUrl: "https://costamar.example/api",
      brandBaseUrl: "https://booking.clickandbook.com/vuelos",
      terminalId: "0721808110",
      token: "secret-token",
      lang: "es",
    },
    buildEngine(),
  );

  assert.ok(normalized.offer);
  assert.equal(normalized.offer?.price.total.amount, 1001.16);
  assert.equal(normalized.offer?.price.base?.amount, 700);
  assert.equal(normalized.offer?.price.taxes?.amount, 301.16);
});

test("searchLocalCostamarExact keeps the Costamar search total without applying markups", async () => {
  const previousFetch = global.fetch;
  const request = buildExactRequest();

  global.fetch = (async (input) => {
    const url = String(input);

    if (url === "https://api-zneith.zdev.tech/api-engine/engines/0721808110") {
      return new Response(
        JSON.stringify({
          code: "0721808110",
          profile: {
            id: "profile-1",
            currencyCode: "USD",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "https://air-search-service-zneith.zdev.tech/v2/searchFlights") {
      return new Response(
        JSON.stringify({
          status: 200,
          data: [
            {
              ...buildRecommendation(),
              pricing: {
                ...buildRecommendation().pricing,
                total: "950.00",
                base: "700.00",
                taxes: "300.00",
                discounts: [
                  {
                    amount: "50.00",
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "https://commons-service-b-zneith.zdev.tech/markup-service/markups/apply") {
      throw new Error("Click and Book Plus markup endpoint should not be called for displayed search totals.");
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    const result = await searchLocalCostamarExact(request, {
      costamar: {
        apiBaseUrl: "https://costamar.com.pe/vuelos/api",
        brandBaseUrl: "https://booking.clickandbook.com/vuelos",
        terminalId: "0721808110",
        token: "secret-token",
        lang: "es",
      },
    });

    assert.equal(result.offers.length, 1);
    assert.equal(result.offers[0]?.price.total.amount, 950);
  } finally {
    global.fetch = previousFetch;
  }
});

test("searchLocalCostamarExact does not retry token-protected searches without a token", async () => {
  const previousFetch = global.fetch;
  const previousWarmupEnabled = process.env.CBPLUS_SESSION_WARMUP_ENABLED;
  const terminalId = "9990004440";
  const request = buildExactRequest();
  const token = buildJwt({
    id: terminalId,
    iat: 1893456000,
    exp: 1893459600,
  });
  const searchBodies: Array<{ token?: string }> = [];

  process.env.CBPLUS_SESSION_WARMUP_ENABLED = "0";

  global.fetch = (async (input, init) => {
    const url = String(input);

    if (url === `https://api-zneith.zdev.tech/api-engine/engines/${terminalId}`) {
      return new Response(
        JSON.stringify(buildEngine()),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "https://air-search-service-zneith.zdev.tech/v2/searchFlights") {
      searchBodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(
        JSON.stringify({
          status: 401,
          data: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    const result = await searchLocalCostamarExact(request, {
      costamar: {
        apiBaseUrl: "https://costamar.com.pe/vuelos/api",
        brandBaseUrl: "https://booking.clickandbook.com/vuelos",
        terminalId,
        token,
        lang: "es",
      },
    });

    assert.equal(searchBodies.length, 1);
    assert.equal(searchBodies[0]?.token, token);
    assert.equal(result.offers.length, 0);
    assert.equal(result.partial, true);
    assert.ok(result.warnings.some((warning) => /branded token is invalid/i.test(warning)));

    const tracker = createProviderStatusTracker({ clock: () => 1_000 });
    tracker.recordSearchResult("costamar", result.partial);
    assert.deepEqual(tracker.snapshot()[1], {
      id: "costamar",
      label: "Click and Book Plus",
      configured: true,
      state: "degraded",
      evidence: "search",
      reasonCode: "partial_results",
      observedAtMs: 1_000,
      stale: false,
    });
  } finally {
    global.fetch = previousFetch;
    if (previousWarmupEnabled === undefined) {
      delete process.env.CBPLUS_SESSION_WARMUP_ENABLED;
    } else {
      process.env.CBPLUS_SESSION_WARMUP_ENABLED = previousWarmupEnabled;
    }
    resetCostamarWarmupStateForTests();
    resetCostamarSessionCacheForTests();
  }
});

test("mapCostamarRecommendationToOffer interprets compact HHMM elapsed times correctly", () => {
  const recommendation = buildRecommendation();
  const firstFlight = recommendation.itinerary?.[0]?.flights?.[0];
  if (!firstFlight) {
    throw new Error("Test fixture must include at least one flight segment.");
  }

  firstFlight.departureDateTime = "2026-06-12T22:05:00-05:00";
  firstFlight.arrivalDateTime = "2026-06-13T17:50:00+02:00";
  firstFlight.elapsedTime = "1245";

  const normalized = mapCostamarRecommendationToOffer(
    recommendation,
    {
      ...buildExactRequest(),
      legs: [
        {
          origin: "LIM",
          destination: "BCN",
          departureDate: "2026-06-12",
        },
      ],
    },
    {
      apiBaseUrl: "https://costamar.example/api",
      brandBaseUrl: "https://booking.clickandbook.com/vuelos",
      terminalId: "0721808110",
      token: "secret-token",
      lang: "es",
    },
    buildEngine(),
  );

  assert.ok(normalized.offer);
  assert.equal(normalized.offer?.itineraries[0]?.durationMinutes, 765);
  assert.equal(normalized.offer?.itineraries[0]?.segments[0]?.durationMinutes, 765);
});

test("searchLocalCostamarExact can warm a missing branded token from a seeded Chrome session", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-warmup-"));
  const profileName = "Profile 40";
  const sessionsDir = join(tempRoot, profileName, "Sessions");
  mkdirSync(sessionsDir, { recursive: true });

  const freshToken = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });

  const previousFetch = global.fetch;
  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;
  const previousWarmupEnabled = process.env.COSTAMAR_SESSION_WARMUP_ENABLED;
  const previousOpenBrowserFallback = process.env.COSTAMAR_SESSION_WARMUP_OPEN_BROWSER_FALLBACK;
  const previousWarmupTimeout = process.env.COSTAMAR_SESSION_WARMUP_TIMEOUT_MS;
  const previousWarmupCooldown = process.env.COSTAMAR_SESSION_WARMUP_COOLDOWN_MS;

  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = profileName;
  process.env.COSTAMAR_SESSION_WARMUP_ENABLED = "1";
  process.env.COSTAMAR_SESSION_WARMUP_OPEN_BROWSER_FALLBACK = "1";
  process.env.COSTAMAR_SESSION_WARMUP_TIMEOUT_MS = "2000";
  process.env.COSTAMAR_SESSION_WARMUP_COOLDOWN_MS = "0";

  resetCostamarSessionCacheForTests();
  resetCostamarWarmupStateForTests();

  setCostamarWarmupGeneratorForTests(async () => undefined);
  const openedUrls: string[] = [];
  setCostamarWarmupOpenerForTests(async (targetUrl, preferredBrowser, chromeOptions) => {
    openedUrls.push(targetUrl);
    assert.equal(preferredBrowser, "chrome");
    assert.equal(chromeOptions?.userDataDir, tempRoot);
    assert.equal(chromeOptions?.profileDirectory, profileName);

    writeFileSync(
      join(sessionsDir, "Tabs_1"),
      `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/1/0/0?terminalId=0721808110&lang=es&token=${freshToken}`,
      "utf8",
    );

    return { launcher: "chrome" };
  });

  global.fetch = (async (input, init) => {
    const url = String(input);

    if (url === "https://api-zneith.zdev.tech/api-engine/engines/0721808110") {
      return new Response(
        JSON.stringify(buildEngine()),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "https://air-search-service-zneith.zdev.tech/v2/searchFlights") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { token?: string };
      assert.equal(body.token, freshToken);

      return new Response(
        JSON.stringify({
          status: 200,
          data: [buildRecommendation()],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "https://commons-service-b-zneith.zdev.tech/markup-service/markups/apply") {
      return new Response(
        JSON.stringify({
          apply: false,
          markupsApplied: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    const result = await searchLocalCostamarExact(
      buildExactRequest(),
      {
        costamar: {
          apiBaseUrl: "https://costamar.com.pe/vuelos/api",
          brandBaseUrl: "https://booking.clickandbook.com/vuelos",
          terminalId: "0721808110",
          token: "",
          lang: "es",
        },
      },
    );

    assert.equal(openedUrls.length, 2);
    assert.equal(openedUrls[0], "https://www.clickandbook.plus/es/login");
    assert.equal(new URL(openedUrls[1] ?? "").searchParams.get("token"), null);
    assert.equal(result.offers.length, 1);
    assert.equal(result.offers[0]?.purchasePaths.length, 1);
    assert.equal(
      new URL(result.offers[0]?.purchasePaths[0]?.url ?? "").searchParams.get("token"),
      freshToken,
    );
  } finally {
    global.fetch = previousFetch;
    resetCostamarWarmupStateForTests();
    resetCostamarSessionCacheForTests();
    rmSync(tempRoot, { recursive: true, force: true });

    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }

    if (previousWarmupEnabled === undefined) {
      delete process.env.COSTAMAR_SESSION_WARMUP_ENABLED;
    } else {
      process.env.COSTAMAR_SESSION_WARMUP_ENABLED = previousWarmupEnabled;
    }

    if (previousOpenBrowserFallback === undefined) {
      delete process.env.COSTAMAR_SESSION_WARMUP_OPEN_BROWSER_FALLBACK;
    } else {
      process.env.COSTAMAR_SESSION_WARMUP_OPEN_BROWSER_FALLBACK = previousOpenBrowserFallback;
    }

    if (previousWarmupTimeout === undefined) {
      delete process.env.COSTAMAR_SESSION_WARMUP_TIMEOUT_MS;
    } else {
      process.env.COSTAMAR_SESSION_WARMUP_TIMEOUT_MS = previousWarmupTimeout;
    }

    if (previousWarmupCooldown === undefined) {
      delete process.env.COSTAMAR_SESSION_WARMUP_COOLDOWN_MS;
    } else {
      process.env.COSTAMAR_SESSION_WARMUP_COOLDOWN_MS = previousWarmupCooldown;
    }
  }
});

test("warmCostamarRedirectContext forces refresh when requested even if the token is locally usable", async () => {
  const request = buildExactRequest();
  const existingToken = buildJwt({
    id: "0721808110",
    iat: 1893455000,
    exp: 1893459600,
  });
  const refreshedToken = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893463200,
  });
  const previousWarmupTimeout = process.env.COSTAMAR_SESSION_WARMUP_TIMEOUT_MS;
  const previousWarmupFallback = process.env.COSTAMAR_SESSION_WARMUP_OPEN_BROWSER_FALLBACK;

  process.env.COSTAMAR_SESSION_WARMUP_TIMEOUT_MS = "50";
  process.env.COSTAMAR_SESSION_WARMUP_OPEN_BROWSER_FALLBACK = "0";
  resetCostamarWarmupStateForTests();

  let calls = 0;
  setCostamarWarmupGeneratorForTests(async (_request, context) => {
    calls += 1;
    return {
      ...context,
      token: refreshedToken,
    };
  });

  const context = {
    apiBaseUrl: "https://costamar.com.pe/vuelos/api",
    brandBaseUrl: "https://booking.clickandbook.com/vuelos",
    terminalId: "0721808110",
    token: existingToken,
    lang: "es",
  };

  try {
    const unforced = await warmCostamarRedirectContext(request, context);
    assert.equal(unforced.token, existingToken);
    assert.equal(calls, 0);

    const forced = await warmCostamarRedirectContext(request, context, { force: true });
    assert.equal(forced.token, refreshedToken);
    assert.equal(calls, 1);
  } finally {
    resetCostamarWarmupStateForTests();
    if (previousWarmupTimeout === undefined) {
      delete process.env.COSTAMAR_SESSION_WARMUP_TIMEOUT_MS;
    } else {
      process.env.COSTAMAR_SESSION_WARMUP_TIMEOUT_MS = previousWarmupTimeout;
    }
    if (previousWarmupFallback === undefined) {
      delete process.env.COSTAMAR_SESSION_WARMUP_OPEN_BROWSER_FALLBACK;
    } else {
      process.env.COSTAMAR_SESSION_WARMUP_OPEN_BROWSER_FALLBACK = previousWarmupFallback;
    }
  }
});

test("verifyCostamarRedirectCandidate verifies only branded redirects that do not show auth failure", async () => {
  const previousFetch = global.fetch;
  const request = buildExactRequest();
  const token = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  const context = {
    apiBaseUrl: "https://costamar.com.pe/vuelos/api",
    brandBaseUrl: "https://booking.clickandbook.com/vuelos",
    terminalId: "0721808110",
    token,
    lang: "es",
  };

  try {
    global.fetch = (async () => new Response("<html>flight results</html>", { status: 200 })) as typeof fetch;
    const accepted = await verifyCostamarRedirectCandidate(request, context);
    assert.equal(accepted.verified, true);
    assert.equal(accepted.state, "verified");

    global.fetch = (async () =>
      new Response('<html><head><title>Click And Book Plus</title><meta name="author" content="Click And Book Plus"></head><body></body></html>', {
        status: 200,
      })) as typeof fetch;
    const validShell = await verifyCostamarRedirectCandidate(request, context);
    assert.equal(validShell.verified, true);
    assert.equal(validShell.state, "verified");

    global.fetch = (async () => new Response("<html>login required</html>", { status: 200 })) as typeof fetch;
    const blocked = await verifyCostamarRedirectCandidate(request, context);
    assert.equal(blocked.verified, false);
    assert.equal(blocked.state, "blocked");
  } finally {
    global.fetch = previousFetch;
  }
});

test("resolveCostamarRedirectForRequest separates redirect verification from local token usability", async () => {
  const previousFetch = global.fetch;
  const request = buildExactRequest();
  const token = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  const context = {
    apiBaseUrl: "https://costamar.com.pe/vuelos/api",
    brandBaseUrl: "https://booking.clickandbook.com/vuelos",
    terminalId: "0721808110",
    token,
    lang: "es",
  };

  try {
    global.fetch = (async () => new Response("<html>login required</html>", { status: 200 })) as typeof fetch;
    resetCostamarWarmupStateForTests();
    setCostamarWarmupGeneratorForTests(async (_request, seedContext) => ({
      ...seedContext,
      token,
    }));

    const unverified = await resolveCostamarRedirectForRequest(request, context, { validateLive: false });
    assert.equal(unverified.redirectVerification.state, "fresh_unverified");
    assert.equal(unverified.redirectVerification.verified, false);
    assert.equal(shouldWarnCostamarRedirectUnavailable(1, unverified.redirectVerification), false);

    const blocked = await resolveCostamarRedirectForRequest(request, context, {
      validateLive: true,
      forceOnUnverified: true,
    });
    assert.equal(blocked.redirectVerification.verified, false);
    assert.equal(blocked.redirectVerification.state, "blocked");
    assert.equal(shouldWarnCostamarRedirectUnavailable(1, blocked.redirectVerification), true);
  } finally {
    global.fetch = previousFetch;
    resetCostamarWarmupStateForTests();
  }
});

test("resolveCostamarRedirectForRequest live-validates a fresh token before forced warmup", async () => {
  const previousFetch = global.fetch;
  const request = buildExactRequest();
  const token = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  const context = {
    apiBaseUrl: "https://costamar.com.pe/vuelos/api",
    brandBaseUrl: "https://booking.clickandbook.com/vuelos",
    terminalId: "0721808110",
    token,
    lang: "es",
  };
  let warmupCalls = 0;

  try {
    global.fetch = (async () => new Response("<html>flight results</html>", { status: 200 })) as typeof fetch;
    resetCostamarWarmupStateForTests();
    setCostamarWarmupGeneratorForTests(async (_request, seedContext) => {
      warmupCalls += 1;
      return seedContext;
    });

    const resolution = await resolveCostamarRedirectForRequest(request, context, {
      validateLive: true,
      forceOnUnverified: true,
    });

    assert.equal(resolution.redirectVerification.verified, true);
    assert.equal(resolution.redirectVerification.state, "verified");
    assert.equal(warmupCalls, 0);
    assert.deepEqual(
      resolution.diagnostics?.steps.map((step) => step.name),
      ["live-validation"],
    );
  } finally {
    global.fetch = previousFetch;
    resetCostamarWarmupStateForTests();
  }
});

test("searchLocalCostamarExact reuses a token generated by the B2B warm-up flow", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-b2b-generated-"));
  const profileName = "Profile 40";
  mkdirSync(join(tempRoot, profileName), { recursive: true });
  const freshToken = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  const previousFetch = global.fetch;
  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;

  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = profileName;

  resetCostamarSessionCacheForTests();
  resetCostamarWarmupStateForTests();

  let openerCalls = 0;
  setCostamarWarmupGeneratorForTests(async (_request, context) => ({
    ...context,
    token: freshToken,
  }));
  setCostamarWarmupOpenerForTests(async () => {
    openerCalls += 1;
    return { launcher: "chrome" };
  });

  global.fetch = (async (input, init) => {
    const url = String(input);

    if (url === "https://api-zneith.zdev.tech/api-engine/engines/0721808110") {
      return new Response(
        JSON.stringify(buildEngine()),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "https://air-search-service-zneith.zdev.tech/v2/searchFlights") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { token?: string };
      assert.equal(body.token, freshToken);

      return new Response(
        JSON.stringify({
          status: 200,
          data: [buildRecommendation()],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "https://commons-service-b-zneith.zdev.tech/markup-service/markups/apply") {
      return new Response(
        JSON.stringify({
          apply: false,
          markupsApplied: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    const result = await searchLocalCostamarExact(buildExactRequest(), {
      costamar: {
        apiBaseUrl: "https://costamar.com.pe/vuelos/api",
        brandBaseUrl: "https://booking.clickandbook.com/vuelos",
        terminalId: "0721808110",
        token: "",
        lang: "es",
      },
    });

    assert.equal(openerCalls, 0);
    assert.equal(result.offers.length, 1);
    assert.equal(
      new URL(result.offers[0]?.purchasePaths[0]?.url ?? "").searchParams.get("token"),
      freshToken,
    );
  } finally {
    global.fetch = previousFetch;
    resetCostamarWarmupStateForTests();
    resetCostamarSessionCacheForTests();
    rmSync(tempRoot, { recursive: true, force: true });

    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }
  }
});

test("searchLocalCostamarExact prefers a fresher manual Costamar token on every search", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-fresh-manual-"));
  const profileName = "Profile 40";
  const sessionsDir = join(tempRoot, profileName, "Sessions");
  mkdirSync(sessionsDir, { recursive: true });

  const olderToken = buildJwt({
    id: "0721808110",
    iat: 1893452400,
    exp: 1893456000,
  });
  const freshToken = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });

  writeFileSync(
    join(sessionsDir, "Tabs_1"),
    `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/1/0/0?terminalId=0721808110&lang=es&token=${freshToken}`,
    "utf8",
  );

  const previousFetch = global.fetch;
  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;

  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = profileName;

  resetCostamarSessionCacheForTests();
  resetCostamarWarmupStateForTests();

  setCostamarWarmupOpenerForTests(async () => {
    throw new Error("Warm-up opener should not run when a fresher manual token already exists.");
  });

  global.fetch = (async (input, init) => {
    const url = String(input);

    if (url === "https://api-zneith.zdev.tech/api-engine/engines/0721808110") {
      return new Response(
        JSON.stringify(buildEngine()),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "https://air-search-service-zneith.zdev.tech/v2/searchFlights") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { token?: string };
      assert.equal(body.token, freshToken);

      return new Response(
        JSON.stringify({
          status: 200,
          data: [buildRecommendation()],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "https://commons-service-b-zneith.zdev.tech/markup-service/markups/apply") {
      return new Response(
        JSON.stringify({
          apply: false,
          markupsApplied: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    const result = await searchLocalCostamarExact(
      buildExactRequest(),
      {
        costamar: {
          apiBaseUrl: "https://costamar.com.pe/vuelos/api",
          brandBaseUrl: "https://booking.clickandbook.com/vuelos",
          terminalId: "0721808110",
          token: olderToken,
          lang: "es",
        },
      },
    );

    assert.equal(result.offers.length, 1);
    assert.equal(
      new URL(result.offers[0]?.purchasePaths[0]?.url ?? "").searchParams.get("token"),
      freshToken,
    );
  } finally {
    global.fetch = previousFetch;
    resetCostamarWarmupStateForTests();
    resetCostamarSessionCacheForTests();
    rmSync(tempRoot, { recursive: true, force: true });

    if (previousUserDataDir === undefined) {
      delete process.env.COSTAMAR_CHROME_USER_DATA_DIR;
    } else {
      process.env.COSTAMAR_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.COSTAMAR_CHROME_PROFILE;
    } else {
      process.env.COSTAMAR_CHROME_PROFILE = previousProfile;
    }
  }
});

test("searchLocalCostamarExact does not add Costamar markup fees to displayed prices", async () => {
  const previousFetch = global.fetch;
  const request = {
    providerId: "costamar",
    tripType: "round-trip",
    searchMode: "exact",
    legs: [
      {
        origin: "LIM",
        destination: "CTG",
        departureDate: "2026-09-07",
        returnDate: "2026-09-10",
      },
    ],
    passengers: {
      adults: 3,
      children: 0,
      infants: 0,
    },
    cabin: "ECONOMY",
    filters: {},
    coverageMode: "core",
    redirectMode: "best-effort",
    currencyCode: "USD",
    locale: "es-PE",
    market: "PE",
  } satisfies SearchRequest;

  global.fetch = (async (input, init) => {
    const url = String(input);

    if (url === "https://api-zneith.zdev.tech/api-engine/engines/0721808110") {
      return new Response(
        JSON.stringify({
          code: "0721808110",
          profile: {
            id: "profile-1",
            currencyCode: "USD",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "https://air-search-service-zneith.zdev.tech/v2/searchFlights") {
      return new Response(
        JSON.stringify({
          status: 200,
          data: [
            {
              id: "rec-markup",
              itinerary: [
                {
                  flights: [
                    {
                      departureAirport: { code: "LIM" },
                      arrivalAirport: { code: "CTG" },
                      departureDateTime: "2026-09-07T09:45:00.000-0500",
                      arrivalDateTime: "2026-09-07T13:31:00.000-0500",
                      elapsedTime: "0346",
                      flightNumber: "7780",
                      operatingAirline: { code: "JA", name: "JetSmart Airlines" },
                      marketingAirline: { code: "JA", name: "JetSmart Airlines" },
                      fareBasisCode: "SLRDCL",
                      bookingClass: { code: "S" },
                      cabinType: "Y",
                    },
                  ],
                },
                {
                  flights: [
                    {
                      departureAirport: { code: "CTG" },
                      arrivalAirport: { code: "LIM" },
                      departureDateTime: "2026-09-10T14:26:00.000-0500",
                      arrivalDateTime: "2026-09-10T18:05:00.000-0500",
                      elapsedTime: "0339",
                      flightNumber: "7781",
                      operatingAirline: { code: "JA", name: "JetSmart Airlines" },
                      marketingAirline: { code: "JA", name: "JetSmart Airlines" },
                      fareBasisCode: "SLRDCL",
                      bookingClass: { code: "S" },
                      cabinType: "Y",
                    },
                  ],
                },
              ],
              pricing: {
                base: "552.00",
                taxes: "449.16",
                total: "1001.16",
                fees: [],
                discounts: [],
                passengers: {
                  adults: {
                    base: "184.00",
                    total: "333.72",
                    contextCode: "ADT",
                  },
                },
                source: "PUBLISHED",
                fareQualifier: "INTERNATIONAL",
                validatingAirline: "JZ",
                totalAmount: 1001.16,
              },
              pos: {
                systemProviderCode: "112",
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "https://commons-service-b-zneith.zdev.tech/markup-service/markups/apply") {
      throw new Error("Click and Book Plus markup endpoint should not be called for displayed search totals.");
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    const result = await searchLocalCostamarExact(
      request,
      {
        costamar: {
          apiBaseUrl: "https://costamar.com.pe/vuelos/api",
          brandBaseUrl: "https://booking.clickandbook.com/vuelos",
          terminalId: "0721808110",
          token: "secret-token",
          lang: "es",
        },
      },
    );

    assert.equal(result.offers.length, 1);
    assert.equal(result.offers[0]?.price.total.amount, 1001.16);
    assert.equal(result.offers[0]?.itineraries[0]?.durationMinutes, 226);
    assert.equal(result.offers[0]?.itineraries[1]?.durationMinutes, 219);
    assert.equal(result.warnings.length, 0);
  } finally {
    global.fetch = previousFetch;
  }
});

test("searchLocalCostamarExact maps Click and Book Plus priced itineraries, alternatives and redirect links", async () => {
  const previousFetch = global.fetch;
  const terminalId = "9990003330";
  const request = {
    ...buildExactRequest(),
    tripType: "round-trip",
    legs: [
      {
        origin: "LIM",
        destination: "MAD",
        departureDate: "2026-06-17",
        returnDate: "2026-06-24",
      },
    ],
  } satisfies SearchRequest;

  const segment = (
    origin: string,
    destination: string,
    departureDateTime: string,
    arrivalDateTime: string,
    flightNumber: string,
  ) => ({
    departureAirport: { locationCode: origin, codeContext: origin === "LIM" ? "Lima" : "Madrid" },
    arrivalAirport: { locationCode: destination, codeContext: destination === "MAD" ? "Madrid" : "Lima" },
    departureDateTime,
    arrivalDateTime,
    elapsedTime: "0200",
    flightNumber,
    marketingAirline: { code: "AV", companyShortName: "Avianca" },
    operatingAirline: { code: " la ", companyShortName: "LATAM Airlines" },
    bookingClassAvails: [
      {
        bookingClassAvail: [
          {
            resBookDesigCode: "S",
          },
        ],
      },
    ],
    fareBasisCode: "SPLUS",
    cabinType: "Y",
    tpaextensions: {
      any: [
        '<baggageInformation pieces="1" description="1 maleta"/>',
        '<handBaggage pieces="1" description="1 equipaje de mano"/>',
      ],
    },
  });
  const aggregateSegment = (
    origin: string,
    destination: string,
    departureDateTime: string,
    arrivalDateTime: string,
  ) => ({
    departureAirport: { locationCode: origin, codeContext: origin === "LIM" ? "Lima" : "Madrid" },
    arrivalAirport: { locationCode: destination, codeContext: destination === "MAD" ? "Madrid" : "Lima" },
    departureDateTime,
    arrivalDateTime,
    marketingAirline: { code: "AV", companyShortName: "Avianca" },
    tpaextensions: {
      any: [
        '<flightDetails><elapsedTime>0200</elapsedTime><brandedFare brandName="Plus"/><baggageInformationList><baggageInformation pieces="1" description="1 maleta"/></baggageInformationList><handBaggage pieces="1" description="1 equipaje de mano"/></flightDetails>',
      ],
    },
  });

  global.fetch = (async (input, init) => {
    const url = String(input);

    if (url === `https://api-zneith.zdev.tech/api-engine/engines/${terminalId}`) {
      return new Response(
        JSON.stringify({
          code: terminalId,
          profile: {
            id: "profile-cbplus",
            currencyCode: "USD",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "https://air-search-service-zneith.zdev.tech/v2/searchFlights") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      assert.equal(body.terminalId, terminalId);
      assert.equal(body.token, "secret-token");
      return new Response(
        JSON.stringify({
          pricedItineraries: {
            pricedItinerary: [
              {
                sequenceNumber: "1",
                airItinerary: {
                  originDestinationOptions: {
                    originDestinationOption: [
                      {
                        refNumber: 0,
                        rph: 1,
                        flightSegment: [
                          segment("LIM", "MAD", "2026-06-17T08:00:00-05:00", "2026-06-17T16:00:00+02:00", "100"),
                          aggregateSegment("LIM", "MAD", "2026-06-17T08:00:00-05:00", "2026-06-17T16:00:00+02:00"),
                        ],
                      },
                      {
                        refNumber: 0,
                        rph: 2,
                        flightSegment: [
                          segment("LIM", "MAD", "2026-06-17T10:00:00-05:00", "2026-06-17T18:00:00+02:00", "102"),
                          aggregateSegment("LIM", "MAD", "2026-06-17T10:00:00-05:00", "2026-06-17T18:00:00+02:00"),
                        ],
                      },
                      {
                        refNumber: 1,
                        rph: 3,
                        flightSegment: [
                          segment("MAD", "LIM", "2026-06-24T09:00:00+02:00", "2026-06-24T15:00:00-05:00", "101"),
                          aggregateSegment("MAD", "LIM", "2026-06-24T09:00:00+02:00", "2026-06-24T15:00:00-05:00"),
                        ],
                      },
                    ],
                  },
                },
                airItineraryPricingInfo: {
                  itinTotalFare: [
                    {
                      baseFare: { amount: "800.00", currencyCode: "USD" },
                      taxes: { amount: "350.00", currencyCode: "USD" },
                      totalFare: { amount: "1150.00", currencyCode: "USD" },
                      fees: {
                        fee: [{ amount: "17.87", description: "SERVICE" }],
                      },
                      discounts: {
                        discount: [{ amount: "10.00", description: "DISCOUNT" }],
                      },
                    },
                  ],
                  validatingAirlineCode: "AV",
                },
                ticketingInfo: {
                  pricingSystem: {
                    code: "108",
                    codeContext: "CBPLUS",
                  },
                  pseudoCityCode: "LIM",
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    const result = await searchLocalCostamarExact(request, {
      costamar: {
        apiBaseUrl: "https://air-search-service-zneith.zdev.tech/v2",
        brandBaseUrl: "https://flights.zdev.tech/vuelos/pro",
        engineBaseUrl: "https://api-zneith.zdev.tech/api-engine",
        markupBaseUrl: "https://commons-service-b-zneith.zdev.tech/markup-service",
        terminalId,
        token: "secret-token",
        lang: "es",
      },
    });

    assert.equal(result.offers.length, 2);
    assert.deepEqual(
      result.offers.map((offer) => offer.itineraries.map((itinerary) => itinerary.segments[0]?.flightNumber)).sort(),
      [
        ["100", "101"],
        ["102", "101"],
      ],
    );
    assert.equal(result.offers[0]?.price.total.amount, 1157.87);
    assert.equal(result.offers[0]?.price.base?.amount, 800);
    assert.equal(result.offers[0]?.price.taxes?.amount, 350);
    assert.equal(result.offers[0]?.itineraries[0]?.segments.length, 1);
    assert.equal(result.offers[0]?.itineraries[1]?.segments.length, 1);
    assert.equal(result.offers[0]?.itineraries[0]?.segments[0]?.marketingCarrier, "AV");
    assert.equal(result.offers[0]?.itineraries[0]?.segments[0]?.operatingCarrier, "LA");
    assert.equal(result.offers[0]?.itineraries[0]?.segments[0]?.operatingCarrierName, "LATAM");
    assert.equal(result.offers[0]?.fareMeta?.seatsRemaining, undefined);
    assert.equal(result.offers[0]?.baggage?.checkedBags, 1);
    assert.equal(result.offers[0]?.baggage?.carryOnIncluded, true);
    assert.equal(result.offers[0]?.purchasePaths[0]?.label, "Buscar en Click and Book Plus");
    assert.equal(result.offers[0]?.purchasePaths[0]?.url.startsWith(
      `https://flights.zdev.tech/vuelos/pro/b/LIM/MAD/2026-06-17/2026-06-24/1/0/0?`,
    ), true);
    assert.equal(new URL(result.offers[0]?.purchasePaths[0]?.url ?? "").searchParams.get("terminalId"), terminalId);
    assert.equal(new URL(result.offers[0]?.purchasePaths[0]?.url ?? "").searchParams.get("token"), "secret-token");
    assert.equal(result.warnings.length, 0);
  } finally {
    global.fetch = previousFetch;
    resetCostamarWarmupStateForTests();
    resetCostamarSessionCacheForTests();
  }
});

function buildCostamarAlternativeRequest(tripType: "one-way" | "round-trip"): SearchRequest {
  return {
    ...buildExactRequest(),
    tripType,
    legs: [
      {
        origin: "LIM",
        destination: "MAD",
        departureDate: "2026-06-01",
        ...(tripType === "round-trip" ? { returnDate: "2026-06-08" } : {}),
      },
    ],
  };
}

function buildCostamarAlternativeFlight(
  origin: string,
  destination: string,
  departureDateTime: string,
  arrivalDateTime: string,
  flightNumber: string,
) {
  return {
    departureAirport: { code: origin },
    arrivalAirport: { code: destination },
    departureDateTime,
    arrivalDateTime,
    elapsedTime: "0200",
    flightNumber,
    marketingAirline: { code: "AF", name: "Air France" },
    operatingAirline: { code: "AF", name: "Air France" },
    bookingClass: { code: "N" },
    fareBasisCode: "NFLEX",
    cabinType: "Y",
  };
}

function buildCostamarRecommendationWithAlternatives(tripType: "one-way" | "round-trip") {
  return {
    id: tripType === "round-trip" ? "rec-options" : "rec-one-way-options",
    itinerary: [
      {
        flights: [
          buildCostamarAlternativeFlight(
            "LIM",
            "MAD",
            "2026-06-01T08:00:00-05:00",
            "2026-06-01T16:00:00+02:00",
            "100",
          ),
          buildCostamarAlternativeFlight(
            "LIM",
            "MAD",
            "2026-06-01T10:00:00-05:00",
            "2026-06-01T18:00:00+02:00",
            "102",
          ),
        ],
      },
      ...(tripType === "round-trip"
        ? [
          {
            flights: [
              buildCostamarAlternativeFlight(
                "MAD",
                "LIM",
                "2026-06-08T09:00:00+02:00",
                "2026-06-08T15:00:00-05:00",
                "101",
              ),
              buildCostamarAlternativeFlight(
                "MAD",
                "LIM",
                "2026-06-08T11:00:00+02:00",
                "2026-06-08T17:00:00-05:00",
                "103",
              ),
            ],
          },
        ]
        : []),
    ],
    pricing: {
      base: "700.00",
      taxes: "250.00",
      total: "950.00",
      validatingAirline: "AF",
    },
  };
}

function buildCostamarAlternativeContext(terminalId: string) {
  return {
    costamar: {
      apiBaseUrl: "https://costamar.com.pe/vuelos/api",
      brandBaseUrl: "https://booking.clickandbook.com/vuelos",
      terminalId,
      token: "secret-token",
      lang: "es",
    },
  };
}

async function withMockedCostamarExactSearch<T>(
  terminalId: string,
  recommendation: unknown,
  run: () => Promise<T>,
): Promise<T> {
  const previousFetch = global.fetch;

  global.fetch = (async (input) => {
    const url = String(input);

    if (url === `https://api-zneith.zdev.tech/api-engine/engines/${terminalId}`) {
      return new Response(
        JSON.stringify({
          code: terminalId,
          profile: {
            currencyCode: "USD",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "https://air-search-service-zneith.zdev.tech/v2/searchFlights") {
      return new Response(
        JSON.stringify({
          status: 200,
          data: [recommendation],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    return await run();
  } finally {
    global.fetch = previousFetch;
  }
}

function offerFlightNumbers(offer: CanonicalOffer): Array<string | undefined> {
  return offer.itineraries.map((itinerary) => itinerary.segments[0]?.flightNumber);
}

test("searchLocalCostamarExact expands Costamar flight alternatives", async () => {
  const scenarios = [
    {
      name: "round-trip",
      terminalId: "9990002223",
      request: buildCostamarAlternativeRequest("round-trip"),
      recommendation: buildCostamarRecommendationWithAlternatives("round-trip"),
      expected: [
        ["100", "101"],
        ["100", "103"],
        ["102", "101"],
        ["102", "103"],
      ],
    },
    {
      name: "one-way",
      terminalId: "9990002224",
      request: buildCostamarAlternativeRequest("one-way"),
      recommendation: buildCostamarRecommendationWithAlternatives("one-way"),
      expected: [
        ["100"],
        ["102"],
      ],
    },
  ];

  for (const scenario of scenarios) {
    await withMockedCostamarExactSearch(scenario.terminalId, scenario.recommendation, async () => {
      const result = await searchLocalCostamarExact(
        scenario.request,
        buildCostamarAlternativeContext(scenario.terminalId),
      );

      assert.equal(result.offers.length, scenario.expected.length, scenario.name);
      assert.deepEqual(result.offers.map(offerFlightNumbers).sort(), scenario.expected, scenario.name);
      const expectedScope = JSON.stringify([
        "costamar",
        scenario.request.tripType,
        "LIM",
        "MAD",
        "2026-06-01",
        scenario.request.tripType === "round-trip" ? "2026-06-08" : null,
      ]);
      assert.ok(result.offers.every((offer) => offer.rawRefs?.scheduleGroupScope === expectedScope));
      assert.ok(result.offers.every((offer) => offer.rawRefs?.scheduleVariantsTruncated === false));
    });
  }
});

test("Costamar 5xx payloads remain partial through range and matrix aggregation", async () => {
  const previousFetch = global.fetch;
  const terminalId = "9990004441";
  const token = buildJwt({
    id: terminalId,
    iat: 1893456000,
    exp: 1893459600,
  });
  const request: SearchRequest = {
    ...buildExactRequest(),
    searchMode: "stay-range",
    legs: [
      {
        origin: "LIM",
        destination: "MAD",
        departureStart: "2026-06-01",
        departureEnd: "2026-06-01",
      },
    ],
  };
  const providerContext = {
    costamar: {
      apiBaseUrl: "https://costamar.com.pe/vuelos/api",
      brandBaseUrl: "https://booking.clickandbook.com/vuelos",
      terminalId,
      token,
      lang: "es",
    },
  };

  global.fetch = (async (input) => {
    const url = String(input);
    if (url === `https://api-zneith.zdev.tech/api-engine/engines/${terminalId}`) {
      return new Response(JSON.stringify(buildEngine()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === "https://air-search-service-zneith.zdev.tech/v2/searchFlights") {
      return new Response(JSON.stringify({
        status: 503,
        data: [],
        message: "private upstream body token=must-not-leak",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    const rangeResult = await searchLocalCostamarRange(request, providerContext);
    assert.equal(rangeResult.partial, true);
    assert.deepEqual(rangeResult.warnings, ["Click and Book Plus is temporarily unavailable."]);
    assert.doesNotMatch(rangeResult.warnings.join(" "), /private upstream body|must-not-leak/i);

    const progressiveRangeResult = await resolveLocalCostamarRangeProgressive(
      request,
      providerContext,
    );
    assert.equal(progressiveRangeResult.partial, true);
    assert.deepEqual(
      progressiveRangeResult.warnings,
      ["Click and Book Plus is temporarily unavailable."],
    );

    const matrixDraft = createLocalCostamarMatrixDraft(request, {
      exactProvider: "costamar",
      coverageMode: "core",
    });
    const matrixResult = await resolveLocalCostamarMatrixProgressive(
      request,
      providerContext,
      matrixDraft,
    );
    assert.equal(matrixResult.searchMeta.partial, true);
    assert.equal(matrixResult.searchMeta.searchState, "search_partial");

    const tracker = createProviderStatusTracker({ clock: () => 2_000 });
    tracker.recordSearchResult("costamar", rangeResult.partial);
    assert.deepEqual(
      {
        state: tracker.snapshot()[1]?.state,
        reasonCode: tracker.snapshot()[1]?.reasonCode,
      },
      { state: "degraded", reasonCode: "partial_results" },
    );
  } finally {
    global.fetch = previousFetch;
  }
});

test("verifyCostamarRedirectCandidate never returns a token-bearing transport error", async () => {
  const previousFetch = global.fetch;
  const request = buildExactRequest();
  const token = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });

  try {
    global.fetch = (async (input) => {
      throw new Error(`private redirect failed at ${String(input)}&internal=private-redirect-secret`);
    }) as typeof fetch;

    const result = await verifyCostamarRedirectCandidate(request, {
      apiBaseUrl: "https://costamar.com.pe/vuelos/api",
      brandBaseUrl: "https://booking.clickandbook.com/vuelos",
      terminalId: "0721808110",
      token,
      lang: "es",
    });

    assert.equal(result.verified, false);
    assert.equal(result.state, "fresh_unverified");
    assert.equal(result.reason, "Click and Book Plus redirect validation could not be completed.");
    assert.doesNotMatch(result.reason ?? "", /token=|private-redirect-secret|booking\.clickandbook\.com/i);
  } finally {
    global.fetch = previousFetch;
  }
});

test("Costamar B2B rejects non-official and retired origins before sending credentials", async () => {
  const previousFetch = global.fetch;
  const previousBaseUrl = process.env.CBPLUS_B2B_BASE_URL;
  const previousEmail = process.env.CBPLUS_B2B_EMAIL;
  const previousPassword = process.env.CBPLUS_B2B_PASSWORD;
  const fetchedUrls: string[] = [];
  process.env.CBPLUS_B2B_EMAIL = "agent@example.test";
  process.env.CBPLUS_B2B_PASSWORD = "fixture-password";
  global.fetch = (async (input) => {
    fetchedUrls.push(String(input));
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    for (const rejectedBaseUrl of [
      "http://attacker.invalid/lang/es/b2b",
      "https://b2b.clickandbook.com/lang/es/b2b",
    ]) {
      process.env.CBPLUS_B2B_BASE_URL = rejectedBaseUrl;
      await assert.rejects(
        () => generateCostamarRedirectContextViaB2BHttpForTests({
          apiBaseUrl: "https://costamar.com.pe/vuelos/api",
          brandBaseUrl: "https://booking.clickandbook.com/vuelos",
          terminalId: "0721808110",
          token: "",
          lang: "es",
        }),
        /official HTTPS origin/i,
      );
    }
    assert.deepEqual(fetchedUrls, []);
  } finally {
    global.fetch = previousFetch;
    if (previousBaseUrl === undefined) delete process.env.CBPLUS_B2B_BASE_URL;
    else process.env.CBPLUS_B2B_BASE_URL = previousBaseUrl;
    if (previousEmail === undefined) delete process.env.CBPLUS_B2B_EMAIL;
    else process.env.CBPLUS_B2B_EMAIL = previousEmail;
    if (previousPassword === undefined) delete process.env.CBPLUS_B2B_PASSWORD;
    else process.env.CBPLUS_B2B_PASSWORD = previousPassword;
  }
});

test("Costamar B2B sends no credentials unless the official login form is confirmed", async () => {
  const previousFetch = global.fetch;
  const previousBaseUrl = process.env.CBPLUS_B2B_BASE_URL;
  const previousEmail = process.env.CBPLUS_B2B_EMAIL;
  const previousPassword = process.env.CBPLUS_B2B_PASSWORD;
  const fetchedUrls: string[] = [];
  process.env.CBPLUS_B2B_BASE_URL = "https://www.clickandbook.plus/es/login";
  process.env.CBPLUS_B2B_EMAIL = "agent@example.test";
  process.env.CBPLUS_B2B_PASSWORD = "fixture-password";
  global.fetch = (async (input) => {
    const url = String(input);
    fetchedUrls.push(url);
    if (url === "https://www.clickandbook.plus/es/login") {
      return new Response("Forbidden", { status: 403 });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  try {
    const result = await generateCostamarRedirectContextViaB2BHttpForTests({
      apiBaseUrl: "https://costamar.com.pe/vuelos/api",
      brandBaseUrl: "https://booking.clickandbook.com/vuelos",
      terminalId: "0721808110",
      token: "",
      lang: "es",
    });
    assert.equal(result, undefined);
    assert.deepEqual(fetchedUrls, ["https://www.clickandbook.plus/es/login"]);
  } finally {
    global.fetch = previousFetch;
    if (previousBaseUrl === undefined) delete process.env.CBPLUS_B2B_BASE_URL;
    else process.env.CBPLUS_B2B_BASE_URL = previousBaseUrl;
    if (previousEmail === undefined) delete process.env.CBPLUS_B2B_EMAIL;
    else process.env.CBPLUS_B2B_EMAIL = previousEmail;
    if (previousPassword === undefined) delete process.env.CBPLUS_B2B_PASSWORD;
    else process.env.CBPLUS_B2B_PASSWORD = previousPassword;
  }
});

test("Costamar B2B completes 2FA when login redirects to the authenticator page", async () => {
  const previousFetch = global.fetch;
  const previousBaseUrl = process.env.CBPLUS_B2B_BASE_URL;
  const previousEmail = process.env.CBPLUS_B2B_EMAIL;
  const previousPassword = process.env.CBPLUS_B2B_PASSWORD;
  const previousTotpSecret = process.env.CBPLUS_B2B_TOTP_SECRET;
  const fetchedUrls: string[] = [];
  const token = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  process.env.CBPLUS_B2B_BASE_URL = "https://www.clickandbook.plus/es/login";
  process.env.CBPLUS_B2B_EMAIL = "agent@example.test";
  process.env.CBPLUS_B2B_PASSWORD = "fixture-password";
  process.env.CBPLUS_B2B_TOTP_SECRET = "JBSWY3DPEHPK3PXP";
  global.fetch = (async (input, init) => {
    const url = String(input);
    fetchedUrls.push(url);
    if (url === "https://www.clickandbook.plus/es/login" && init?.method !== "POST") {
      return new Response('<form action="/es/login"><input name="csrf" value="fixture-login-csrf"></form>', {
        status: 200,
        headers: { "Set-Cookie": "session=fixture-session; Path=/; Secure; HttpOnly" },
      });
    }
    if (url === "https://www.clickandbook.plus/es/login" && init?.method === "POST") {
      return new Response("", {
        status: 302,
        headers: { Location: "/es/login2factor" },
      });
    }
    if (url === "https://www.clickandbook.plus/es/login2factor" && init?.method !== "POST") {
      return new Response(
        '<form><input name="csrf" value="fixture-csrf"><input name="secretcode">Google Authenticator</form>',
        { status: 200 },
      );
    }
    if (url === "https://www.clickandbook.plus/es/login2factor" && init?.method === "POST") {
      const body = new URLSearchParams(String(init.body));
      assert.equal(body.get("csrf"), "fixture-csrf");
      assert.match(body.get("secretcode") ?? "", /^\d{6}$/);
      return new Response("", {
        status: 302,
        headers: { Location: "/es/b2b" },
      });
    }
    if (url === "https://www.clickandbook.plus/es/b2b") {
      return new Response("authenticated", { status: 200 });
    }
    if (url === "https://www.clickandbook.plus/es/airlinesearch") {
      return new Response(JSON.stringify({ token }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  try {
    const result = await generateCostamarRedirectContextViaB2BHttpForTests({
      apiBaseUrl: "https://costamar.com.pe/vuelos/api",
      brandBaseUrl: "https://booking.clickandbook.com/vuelos",
      terminalId: "0721808110",
      token: "",
      lang: "es",
    });
    assert.equal(result?.token, token);
    assert.deepEqual(fetchedUrls, [
      "https://www.clickandbook.plus/es/login",
      "https://www.clickandbook.plus/es/login",
      "https://www.clickandbook.plus/es/login2factor",
      "https://www.clickandbook.plus/es/login2factor",
      "https://www.clickandbook.plus/es/b2b",
      "https://www.clickandbook.plus/es/airlinesearch",
    ]);
  } finally {
    global.fetch = previousFetch;
    if (previousBaseUrl === undefined) delete process.env.CBPLUS_B2B_BASE_URL;
    else process.env.CBPLUS_B2B_BASE_URL = previousBaseUrl;
    if (previousEmail === undefined) delete process.env.CBPLUS_B2B_EMAIL;
    else process.env.CBPLUS_B2B_EMAIL = previousEmail;
    if (previousPassword === undefined) delete process.env.CBPLUS_B2B_PASSWORD;
    else process.env.CBPLUS_B2B_PASSWORD = previousPassword;
    if (previousTotpSecret === undefined) delete process.env.CBPLUS_B2B_TOTP_SECRET;
    else process.env.CBPLUS_B2B_TOTP_SECRET = previousTotpSecret;
  }
});

test("Costamar B2B refuses cross-origin redirects without forwarding its cookie jar", async () => {
  const previousFetch = global.fetch;
  const previousBaseUrl = process.env.CBPLUS_B2B_BASE_URL;
  const previousEmail = process.env.CBPLUS_B2B_EMAIL;
  const previousPassword = process.env.CBPLUS_B2B_PASSWORD;
  const fetchedUrls: string[] = [];
  process.env.CBPLUS_B2B_BASE_URL = "https://www.clickandbook.plus/es/login";
  process.env.CBPLUS_B2B_EMAIL = "agent@example.test";
  process.env.CBPLUS_B2B_PASSWORD = "fixture-password";
  global.fetch = (async (input) => {
    const url = String(input);
    fetchedUrls.push(url);
    if (url === "https://www.clickandbook.plus/es/login" && !fetchedUrls.slice(0, -1).includes(url)) {
      return new Response('<form action="/es/login"></form>', { status: 200 });
    }
    if (url === "https://www.clickandbook.plus/es/login") {
      return new Response("", {
        status: 302,
        headers: { Location: "https://attacker.invalid/collect" },
      });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  try {
    const result = await generateCostamarRedirectContextViaB2BHttpForTests({
      apiBaseUrl: "https://costamar.com.pe/vuelos/api",
      brandBaseUrl: "https://booking.clickandbook.com/vuelos",
      terminalId: "0721808110",
      token: "",
      lang: "es",
    });
    assert.equal(result, undefined);
    assert.deepEqual(fetchedUrls, [
      "https://www.clickandbook.plus/es/login",
      "https://www.clickandbook.plus/es/login",
    ]);
  } finally {
    global.fetch = previousFetch;
    if (previousBaseUrl === undefined) delete process.env.CBPLUS_B2B_BASE_URL;
    else process.env.CBPLUS_B2B_BASE_URL = previousBaseUrl;
    if (previousEmail === undefined) delete process.env.CBPLUS_B2B_EMAIL;
    else process.env.CBPLUS_B2B_EMAIL = previousEmail;
    if (previousPassword === undefined) delete process.env.CBPLUS_B2B_PASSWORD;
    else process.env.CBPLUS_B2B_PASSWORD = previousPassword;
  }
});

test("searchLocalCostamarExact marks schedule variants truncated only when the native product exceeds 50", async () => {
  const terminalId = "9990002225";
  const recommendation = buildCostamarRecommendationWithAlternatives("round-trip");
  const outboundJourney = recommendation.itinerary[0];
  const inboundJourney = recommendation.itinerary[1];
  assert.ok(outboundJourney);
  assert.ok(inboundJourney);

  outboundJourney.flights = Array.from({ length: 6 }, (_, index) => {
    const hour = String(6 + index).padStart(2, "0");
    const arrivalHour = String(7 + index).padStart(2, "0");
    return buildCostamarAlternativeFlight(
      "LIM",
      "MAD",
      `2026-06-01T${hour}:00:00-05:00`,
      `2026-06-01T${arrivalHour}:00:00+02:00`,
      String(200 + index),
    );
  });
  inboundJourney.flights = Array.from({ length: 10 }, (_, index) => {
    const hour = String(6 + index).padStart(2, "0");
    const arrivalHour = String(7 + index).padStart(2, "0");
    return buildCostamarAlternativeFlight(
      "MAD",
      "LIM",
      `2026-06-08T${hour}:00:00+02:00`,
      `2026-06-08T${arrivalHour}:00:00-05:00`,
      String(300 + index),
    );
  });

  await withMockedCostamarExactSearch(terminalId, recommendation, async () => {
    const result = await searchLocalCostamarExact(
      buildCostamarAlternativeRequest("round-trip"),
      buildCostamarAlternativeContext(terminalId),
    );

    assert.equal(result.offers.length, 50);
    assert.ok(result.offers.every((offer) => offer.rawRefs?.scheduleVariantsTruncated === true));
    assert.ok(result.offers.every((offer) => offer.rawRefs?.scheduleGroupScope === JSON.stringify([
      "costamar",
      "round-trip",
      "LIM",
      "MAD",
      "2026-06-01",
      "2026-06-08",
    ])));
  });
});

test("createLocalCostamarMatrixDraft leaves only useful stay combinations active", () => {
  const draft = createLocalCostamarMatrixDraft(buildRequest(), {
    exactProvider: "costamar",
    coverageMode: "core",
  });

  const loadingKeys = draft.cells
    .filter((cell) => cell.confidence === "loading")
    .map((cell) => cell.key)
    .sort();

  assert.deepEqual(loadingKeys, [
    "2026-04-01_2026-04-11",
    "2026-04-02_2026-04-12",
    "2026-04-03_2026-04-13",
  ]);
  assert.equal(draft.cells.some((cell) => cell.confidence === "empty"), false);
});
