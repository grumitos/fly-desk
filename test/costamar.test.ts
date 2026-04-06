import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCostamarContextToBrandedSearchUrl,
  buildCostamarBrandedSearchUrl,
  buildCostamarSearchBody,
  buildCostamarSearchWarning,
  COSTAMAR_CONCURRENCY,
  createLocalCostamarMatrixDraft,
} from "../src/local-costamar";
import {
  buildProviderContext,
  extractCostamarSessionCandidates,
  pickLatestCostamarSessionCandidate,
  resetCostamarSessionCacheForTests,
  resolveLatestCostamarProviderContext,
  resolveCostamarProviderContext,
} from "../src/provider-context";
import type { SearchRequest } from "../src/core/types";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function buildRequest(): SearchRequest {
  return {
    providerId: "costamar",
    tripType: "round-trip",
    searchMode: "roundtrip-grid",
    legs: [
      {
        origin: "LIM",
        destination: "MAD",
        departureStart: "2026-04-01",
        departureEnd: "2026-04-03",
        returnStart: "2026-04-10",
        returnEnd: "2026-04-13",
        minNights: 10,
        maxNights: 10,
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

test("keeps Costamar range searches lighter than matrix fan-out by default", () => {
  assert.equal(COSTAMAR_CONCURRENCY.matrixMinimum, 10);
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

test("buildCostamarBrandedSearchUrl keeps the token in the external link even if it is expired", () => {
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
  assert.equal(parsed.searchParams.get("token"), expiredToken);
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

test("createLocalCostamarMatrixDraft leaves only useful stay combinations active", () => {
  const draft = createLocalCostamarMatrixDraft(buildRequest(), {
    exactProvider: "costamar",
    coverageMode: "core",
  });

  const loadingKeys = draft.cells
    .filter((cell) => cell.confidence === "loading")
    .map((cell) => cell.key)
    .sort();
  const emptyKeys = draft.cells
    .filter((cell) => cell.confidence === "empty")
    .map((cell) => cell.key)
    .sort();

  assert.deepEqual(loadingKeys, [
    "2026-04-01_2026-04-11",
    "2026-04-02_2026-04-12",
    "2026-04-03_2026-04-13",
  ]);
  assert.ok(emptyKeys.includes("2026-04-01_2026-04-10"));
  assert.ok(emptyKeys.includes("2026-04-02_2026-04-11"));
  assert.ok(emptyKeys.includes("2026-04-03_2026-04-12"));
});
