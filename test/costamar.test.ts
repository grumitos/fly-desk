import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  applyCostamarB2bKeyboardInput,
  buildCostamarB2bWarmupPayload,
  applyCostamarContextToBrandedSearchUrl,
  buildCostamarBrandedSearchUrl,
  buildCostamarSearchBody,
  buildCostamarSearchWarning,
  COSTAMAR_CONCURRENCY,
  createLocalCostamarMatrixDraft,
  detectCostamarB2bAuthChallenge,
  isCostamarB2bAirlineSearchResponse,
  mapCostamarRecommendationToOffer,
  resetCostamarWarmupStateForTests,
  resolveCostamarRedirectForRequest,
  searchLocalCostamarExact,
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
import type { CanonicalOffer, SearchRequest } from "../src/core/types";
import { generateTotpCode, generateTotpCodeWithMetadata, totpCanSubmitSafely } from "../src/totp";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
      apiBaseUrl: "https://costamar.com.pe/vuelos/api",
      brandBaseUrl: "https://booking.clickandbook.com/vuelos",
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
    `https://booking.clickandbook.com/vuelos/b/LIM/PEM/2026-03-31/1/0/0?terminalId=0721808110&token=${older}`,
    `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/1/1?terminalId=0721808110&lang=es&token=${newer}`,
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
      "https://b2b.clickandbook.com/lang/es/airlinesearch",
    ),
    true,
  );
  assert.equal(
    isCostamarB2bAirlineSearchResponse(
      "POST",
      "https://b2b.clickandbook.com/lang/en/airlinesearch",
    ),
    true,
  );
  assert.equal(
    isCostamarB2bAirlineSearchResponse(
      "GET",
      "https://b2b.clickandbook.com/lang/es/airlinesearch",
    ),
    false,
  );
  assert.equal(
    isCostamarB2bAirlineSearchResponse(
      "POST",
      "https://b2b.clickandbook.com/lang/es/hotelssearch",
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

test("resolveCostamarProviderContext can recover a token from encoded Chrome session storage", () => {
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

test("resolveLatestCostamarProviderContext can recover the freshest token from Chrome session storage", () => {
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
    apiBaseUrl: "https://costamar.example/api",
    brandBaseUrl: "https://booking.clickandbook.com/vuelos",
    terminalId: "0721808110",
    token: "secret-token",
    lang: "es",
  });

  const parsed = new URL(url);
  assert.equal(
    parsed.pathname,
    "/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/1/1",
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
    apiBaseUrl: "https://costamar.example/api",
    brandBaseUrl: "https://booking.clickandbook.com/vuelos",
    terminalId: "0721808110",
    token: "secret-token",
    lang: "es",
  });

  assert.deepEqual(payload, {
    flightType: "RT",
    terminalId: "0721808110",
    itinerary: [
      {
        origin: "LIM",
        destination: "MAD",
        date: "20260601",
      },
      {
        origin: "MAD",
        destination: "LIM",
        date: "20260608",
      },
    ],
    passengers: {
      adults: 1,
      children: 1,
      infants: 1,
    },
    startDate: "2026-06-01T05:00:00.000Z",
    endDate: "2026-06-08T05:00:00.000Z",
    token: "secret-token",
    hasValidationToken: true,
    flexible: false,
  });
});

test("buildCostamarSearchBody skips expired branded validation tokens", () => {
  const request = buildRequest();
  request.searchMode = "exact";
  request.legs[0].departureDate = "2026-06-01";
  request.legs[0].returnDate = "2026-06-08";

  const payload = buildCostamarSearchBody(request, {
    apiBaseUrl: "https://costamar.example/api",
    brandBaseUrl: "https://booking.clickandbook.com/vuelos",
    terminalId: "0721808110",
    token: buildJwt({
      id: "0721808110",
      iat: 1700000000,
      exp: 1700003600,
    }),
    lang: "es",
  });

  assert.deepEqual(payload, {
    flightType: "RT",
    terminalId: "0721808110",
    itinerary: [
      {
        origin: "LIM",
        destination: "MAD",
        date: "20260601",
      },
      {
        origin: "MAD",
        destination: "LIM",
        date: "20260608",
      },
    ],
    passengers: {
      adults: 1,
      children: 1,
      infants: 1,
    },
    startDate: "2026-06-01T05:00:00.000Z",
    endDate: "2026-06-08T05:00:00.000Z",
    hasValidationToken: false,
    flexible: false,
  });
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

test("buildCostamarSearchBody skips tokens that belong to another terminal", () => {
  const request = buildRequest();
  request.searchMode = "exact";
  request.legs[0].departureDate = "2026-06-01";
  request.legs[0].returnDate = "2026-06-08";

  const payload = buildCostamarSearchBody(request, {
    apiBaseUrl: "https://costamar.example/api",
    brandBaseUrl: "https://booking.clickandbook.com/vuelos",
    terminalId: "0721808110",
    token: buildJwt({
      id: "9999999999",
      iat: 1893456000,
      exp: 1893459600,
    }),
    lang: "es",
  });

  assert.deepEqual(payload, {
    flightType: "RT",
    terminalId: "0721808110",
    itinerary: [
      {
        origin: "LIM",
        destination: "MAD",
        date: "20260601",
      },
      {
        origin: "MAD",
        destination: "LIM",
        date: "20260608",
      },
    ],
    passengers: {
      adults: 1,
      children: 1,
      infants: 1,
    },
    startDate: "2026-06-01T05:00:00.000Z",
    endDate: "2026-06-08T05:00:00.000Z",
    hasValidationToken: false,
    flexible: false,
  });
});

test("buildCostamarSearchWarning exposes token failures clearly", () => {
  assert.equal(
    buildCostamarSearchWarning({ status: 401, data: [] }),
    "Costamar rejected this search: the branded token is invalid, expired, or no longer belongs to this agency.",
  );
  assert.equal(
    buildCostamarSearchWarning({ status: 402, data: [] }),
    "Costamar rejected this search: the validation token is missing for this branded flow.",
  );
  assert.equal(
    buildCostamarSearchWarning({ status: 403, data: [], message: "Agency mismatch" }),
    "Costamar rejected this search (403): Agency mismatch",
  );
  assert.equal(buildCostamarSearchWarning({ status: 200, data: [] }), undefined);
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

    if (url === "https://costamar.com.pe/vuelos/api/engines/0721808110") {
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

    if (url === "https://costamar.com.pe/vuelos/api/flights/search") {
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

    if (url === "https://costamar.com.pe/vuelos/api/flights/markups/apply") {
      throw new Error("Costamar markup endpoint should not be called for displayed search totals.");
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

    if (url === "https://costamar.com.pe/vuelos/api/engines/0721808110") {
      return new Response(
        JSON.stringify(buildEngine()),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "https://costamar.com.pe/vuelos/api/flights/search") {
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

    if (url === "https://costamar.com.pe/vuelos/api/flights/markups/apply") {
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
    assert.match(openedUrls[0] ?? "", /^https:\/\/b2b\.clickandbook\.com\/lang\/es\/b2b/);
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

    if (url === "https://costamar.com.pe/vuelos/api/engines/0721808110") {
      return new Response(
        JSON.stringify(buildEngine()),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "https://costamar.com.pe/vuelos/api/flights/search") {
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

    if (url === "https://costamar.com.pe/vuelos/api/flights/markups/apply") {
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

    if (url === "https://costamar.com.pe/vuelos/api/engines/0721808110") {
      return new Response(
        JSON.stringify(buildEngine()),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "https://costamar.com.pe/vuelos/api/flights/search") {
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

    if (url === "https://costamar.com.pe/vuelos/api/flights/markups/apply") {
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

    if (url === "https://costamar.com.pe/vuelos/api/engines/0721808110") {
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

    if (url === "https://costamar.com.pe/vuelos/api/flights/search") {
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

    if (url === "https://costamar.com.pe/vuelos/api/flights/markups/apply") {
      throw new Error("Costamar markup endpoint should not be called for displayed search totals.");
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

    if (url === `https://costamar.com.pe/vuelos/api/engines/${terminalId}`) {
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

    if (url === "https://costamar.com.pe/vuelos/api/flights/search") {
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
    });
  }
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
