import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CanonicalOffer,
  MatrixCell,
  ProviderMeta,
  SearchMeta,
  SearchRequest,
} from "../src/core/types";
import {
  buildProviderContext,
  getCostamarChromeSessionScanCountForTests,
  resetCostamarSessionCacheForTests,
} from "../src/provider-context";
import { getRuntime } from "../src/runtime";
import { withServer } from "./helpers/server";

function buildJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value))
    .toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

function buildCostamarRequest(): SearchRequest {
  return {
    providerId: "costamar",
    tripType: "round-trip",
    searchMode: "exact",
    legs: [
      {
        origin: "LIM",
        destination: "MAD",
        departureDate: "2026-06-01",
        returnDate: "2026-06-08",
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

function buildSearchMeta(): SearchMeta {
  const now = "2026-03-31T00:00:00.000Z";
  return {
    requestedAt: now,
    completedAt: now,
    providersUsed: ["costamar"],
    warnings: [],
    partial: false,
    searchState: "search_live",
  };
}

function buildProviderMeta(): ProviderMeta {
  return {
    exactProvider: "costamar",
    coverageMode: "core",
  };
}

function buildCostamarOffer(url: string): CanonicalOffer {
  return {
    id: "offer-costamar-1",
    signature: "offer-costamar-1-sig",
    providerSource: "costamar",
    providerOfferRef: "offer-costamar-1-ref",
    tripType: "round-trip",
    validatingCarrier: "IB",
    mainCarrier: "IB",
    origin: "LIM",
    destination: "MAD",
    itineraries: [
      {
        id: "offer-costamar-1-out",
        direction: "outbound",
        durationMinutes: 720,
        stops: 0,
        layoverMinutes: [],
        segments: [
          {
            id: "offer-costamar-1-out-seg",
            marketingCarrier: "IB",
            flightNumber: "6650",
            origin: "LIM",
            destination: "MAD",
            departureAt: "2026-06-01T10:00:00Z",
            arrivalAt: "2026-06-01T22:00:00Z",
            durationMinutes: 720,
          },
        ],
      },
      {
        id: "offer-costamar-1-in",
        direction: "inbound",
        durationMinutes: 720,
        stops: 0,
        layoverMinutes: [],
        segments: [
          {
            id: "offer-costamar-1-in-seg",
            marketingCarrier: "IB",
            flightNumber: "6651",
            origin: "MAD",
            destination: "LIM",
            departureAt: "2026-06-08T10:00:00Z",
            arrivalAt: "2026-06-08T22:00:00Z",
            durationMinutes: 720,
          },
        ],
      },
    ],
    price: {
      total: {
        amount: 1234,
        currencyCode: "USD",
      },
    },
    priceConfidence: "live",
    priceStatus: "unverified",
    purchasePaths: [
      {
        id: "offer-costamar-1-path",
        type: "search-redirect",
        provider: "costamar",
        label: "Buscar en Costamar",
        url,
        precision: "exact-search",
        score: 0.9,
        requiresNewTab: true,
        commercialMode: "provider",
        state: "search_redirect",
      },
    ],
    comparisonMetrics: {
      totalDurationMinutes: 1440,
      totalStops: 0,
      baggageScore: 0,
      purchasePathScore: 0,
    },
    tags: [],
    warnings: [],
    valueScore: 1,
  };
}

function buildCostamarMatrixCell(url: string): MatrixCell {
  return {
    key: "2026-06-01_2026-06-08",
    departureDate: "2026-06-01",
    returnDate: "2026-06-08",
    stayNights: 7,
    price: {
      amount: 498,
      currencyCode: "USD",
    },
    confidence: "live",
    providerSource: "costamar",
    selectable: true,
    requiresRequery: true,
    stateCode: "live",
    tooltip: "Costamar live search.",
    derivedRequest: buildCostamarRequest(),
    purchasePaths: [
      {
        id: "matrix-costamar-path",
        type: "search-redirect",
        provider: "costamar",
        label: "Buscar en Costamar",
        url,
        precision: "exact-search",
        score: 0.9,
        requiresNewTab: true,
        commercialMode: "provider",
        state: "search_redirect",
      },
    ],
  };
}

test("rejects exact searches when origin and destination are omitted", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sortMode: "cheapest",
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              departureDate: "2026-04-15",
              returnDate: "2026-04-22",
            },
          ],
        },
      }),
    });

    assert.equal(response.status, 400);
    const payload = await response.json() as { errors?: string[] };
    assert.ok(payload.errors?.some((message) => message.includes("Origin is required")));
    assert.ok(payload.errors?.some((message) => message.includes("Destination is required")));
  });
});

test("rejects invalid passenger counts", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sortMode: "cheapest",
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureDate: "2026-04-15",
              returnDate: "2026-04-22",
            },
          ],
          passengers: {
            adults: 1.5,
            children: -1,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 400);
    const payload = await response.json() as { errors?: string[] };
    assert.ok(payload.errors?.includes("Adults must be a non-negative integer."));
    assert.ok(payload.errors?.includes("Children must be a non-negative integer."));
  });
});

test("rejects unsupported multi-city searches", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sortMode: "cheapest",
        request: {
          tripType: "multi-city",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureDate: "2026-04-15",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 400);
    const payload = await response.json() as { errors?: string[] };
    assert.ok(payload.errors?.includes("Multi-city search is not supported."));
  });
});

test("search endpoint preserves best-value sort mode", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sortMode: "best-value",
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureDate: "2026-04-15",
              returnDate: "2026-04-22",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as { sortMode?: string };
    assert.equal(payload.sortMode, "best-value");
  });
});

test("costamar redirect refreshes the stored token with the latest Chrome session", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-redirect-"));
  const profileName = "Profile 40";
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
    `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&token=${freshToken}`,
    "utf8",
  );

  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;
  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = profileName;
  resetCostamarSessionCacheForTests();

  try {
    const runtime = getRuntime();
    const job = runtime.sessions.createSearchJob({
      request: buildCostamarRequest(),
      providerContext: {
        costamar: {
          apiBaseUrl: "https://costamar.com.pe/vuelos/api",
          brandBaseUrl: "https://booking.clickandbook.com/vuelos",
          terminalId: "0721808110",
          token: staleToken,
          lang: "es",
        },
      },
      offers: [buildCostamarOffer(
        `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${staleToken}`,
      )],
      allOffers: [buildCostamarOffer(
        `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${staleToken}`,
      )],
      searchMeta: buildSearchMeta(),
      providerMeta: buildProviderMeta(),
      warnings: [],
      sortMode: "cheapest",
      status: "completed",
    });

    const session = runtime.sessions.getSession(job.id);
    const redirectPath = session?.offers[0]?.purchasePaths[0]?.url;
    assert.ok(redirectPath);

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}${redirectPath}`, { redirect: "manual" });

      assert.equal(response.status, 302);
      const location = response.headers.get("location");
      assert.ok(location);

      const parsed = new URL(location);
      assert.equal(parsed.searchParams.get("terminalId"), "0721808110");
      assert.equal(parsed.searchParams.get("lang"), "es");
      assert.equal(parsed.searchParams.get("token"), freshToken);
    });
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

test("costamar matrix redirects refresh the stored token with the matrix job provider context", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-matrix-redirect-"));
  const profileName = "Profile 42";
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
    `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&token=${freshToken}`,
    "utf8",
  );

  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;
  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = profileName;
  resetCostamarSessionCacheForTests();

  try {
    const runtime = getRuntime();
    const job = runtime.sessions.createMatrixJob({
      request: {
        ...buildCostamarRequest(),
        searchMode: "roundtrip-grid",
        flexibleMode: "exact-stay",
        legs: [
          {
            origin: "LIM",
            destination: "MAD",
            departureStart: "2026-06-01",
            departureEnd: "2026-06-03",
            stayNights: 7,
          },
        ],
      },
      providerContext: {
        costamar: {
          apiBaseUrl: "https://costamar.com.pe/vuelos/api",
          brandBaseUrl: "https://booking.clickandbook.com/vuelos",
          terminalId: "0721808110",
          token: staleToken,
          lang: "es",
        },
      },
      cells: [buildCostamarMatrixCell(
        `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${staleToken}`,
      )],
      axes: {
        departureDates: ["2026-06-01"],
        returnDates: ["2026-06-08"],
      },
      confidenceSummary: {
        live: 1,
      },
      recommendations: [],
      providerMeta: buildProviderMeta(),
      searchMeta: buildSearchMeta(),
      warnings: [],
      status: "completed",
    });

    const redirectPath = job.cells[0]?.purchasePaths?.[0]?.url;
    assert.ok(redirectPath);

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}${redirectPath}`, { redirect: "manual" });

      assert.equal(response.status, 302);
      const location = response.headers.get("location");
      assert.ok(location);

      const parsed = new URL(location);
      assert.equal(parsed.searchParams.get("terminalId"), "0721808110");
      assert.equal(parsed.searchParams.get("lang"), "es");
      assert.equal(parsed.searchParams.get("token"), freshToken);
    });
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

test("costamar redirect blocks locally when no fresh token is available", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-redirect-blocked-"));
  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;
  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = "Profile 99";
  resetCostamarSessionCacheForTests();

  const staleToken = buildJwt({
    id: "0721808110",
    iat: 1700000000,
    exp: 1700003600,
  });
  try {
    const runtime = getRuntime();
    const job = runtime.sessions.createSearchJob({
      request: buildCostamarRequest(),
      providerContext: {
        costamar: {
          apiBaseUrl: "https://costamar.com.pe/vuelos/api",
          brandBaseUrl: "https://booking.clickandbook.com/vuelos",
          terminalId: "0721808110",
          token: staleToken,
          lang: "es",
        },
      },
      offers: [buildCostamarOffer(
        `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${staleToken}`,
      )],
      allOffers: [buildCostamarOffer(
        `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${staleToken}`,
      )],
      searchMeta: buildSearchMeta(),
      providerMeta: buildProviderMeta(),
      warnings: [],
      sortMode: "cheapest",
      status: "completed",
    });

    const session = runtime.sessions.getSession(job.id);
    const redirectPath = session?.offers[0]?.purchasePaths[0]?.url;
    assert.ok(redirectPath);

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}${redirectPath}`, { redirect: "manual" });

      assert.equal(response.status, 409);
      assert.match(response.headers.get("content-type") ?? "", /text\/html/i);
      const body = await response.text();
      assert.match(body, /Renueva la sesion de Costamar/i);
      assert.match(body, /token vigente/i);
    });
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

test("accepts exact searches inside the rolling date window", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sortMode: "cheapest",
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MIA",
              departureDate: "2027-01-01",
              returnDate: "2027-01-08",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
  });
});

test("rejects exact searches outside the rolling date window", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sortMode: "cheapest",
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MIA",
              departureDate: "2027-04-01",
              returnDate: "2027-04-08",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 400);
    const payload = await response.json() as { errors?: string[] };
    assert.ok(payload.errors?.some((message) => message.includes("Departure date must be on or before 2027-03-31.")));
  });
});

test("costamar search keeps provider token out of the public job response", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "costamar",
        providerConfig: {
          costamar: {
            terminalId: "0721808110",
            token: "super-secret-token",
            apiBaseUrl: "https://127.0.0.1:1/vuelos/api",
            brandBaseUrl: "https://booking.clickandbook.com/vuelos",
            lang: "es",
          },
        },
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureDate: "2026-06-01",
              returnDate: "2026-06-08",
            },
          ],
          passengers: {
            adults: 1,
            children: 1,
            infants: 1,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      request?: { providerId?: string };
      providerMeta?: { exactProvider?: string };
      warnings?: string[];
    };

    assert.equal(payload.request?.providerId, "costamar");
    assert.equal(payload.providerMeta?.exactProvider, "costamar");
    assert.equal(JSON.stringify(payload).includes("super-secret-token"), false);
  });
});

test("explicit costamar search accepts a terminal without token", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "costamar",
        providerConfig: {
          costamar: {
            terminalId: "0721808110",
            apiBaseUrl: "https://127.0.0.1:1/vuelos/api",
            brandBaseUrl: "https://booking.clickandbook.com/vuelos",
            lang: "es",
          },
        },
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureDate: "2026-06-01",
              returnDate: "2026-06-08",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      request?: { providerId?: string };
      providerMeta?: { exactProvider?: string };
    };

    assert.equal(payload.request?.providerId, "costamar");
    assert.equal(payload.providerMeta?.exactProvider, "costamar");
  });
});

test("explicit costamar search falls back to the default terminal when none is provided", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "costamar",
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureDate: "2026-06-01",
              returnDate: "2026-06-08",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      request?: { providerId?: string };
      providerMeta?: { exactProvider?: string };
    };

    assert.equal(payload.request?.providerId, "costamar");
    assert.equal(payload.providerMeta?.exactProvider, "costamar");
  });
});

test("default search keeps Costamar enabled even when its token is missing", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureDate: "2026-06-01",
              returnDate: "2026-06-08",
            },
          ],
          passengers: {
            adults: 1,
            children: 1,
            infants: 1,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      searchMeta?: { providersUsed?: string[] };
    };

    assert.deepEqual(payload.searchMeta?.providersUsed, ["agil-local", "costamar"]);
  });
});

test("default search ignores providerId nested inside the request payload", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request: {
          providerId: "costamar",
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureDate: "2026-06-01",
              returnDate: "2026-06-08",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      request?: { providerId?: string };
      searchMeta?: { providersUsed?: string[] };
    };

    assert.equal(payload.request?.providerId, undefined);
    assert.deepEqual(payload.searchMeta?.providersUsed, ["agil-local", "costamar"]);
  });
});

test("default matrix keeps both providers enabled when no providerId is specified", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/matrix`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request: {
          tripType: "round-trip",
          searchMode: "roundtrip-grid",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureStart: "2026-06-01",
              departureEnd: "2026-06-03",
              returnStart: "2026-06-08",
              returnEnd: "2026-06-10",
              minNights: 7,
              maxNights: 7,
            },
          ],
          passengers: {
            adults: 1,
            children: 1,
            infants: 1,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      request?: { providerId?: string };
      cells?: Array<{ derivedRequest?: { providerId?: string } }>;
      searchMeta?: { providersUsed?: string[] };
      matrixStatus?: string;
    };

    assert.equal(payload.request?.providerId, undefined);
    assert.equal(payload.cells?.[0]?.derivedRequest?.providerId, undefined);
    assert.deepEqual(payload.searchMeta?.providersUsed, ["agil-local", "costamar"]);
    assert.equal(payload.matrixStatus, "running");
  });
});

test("default matrix ignores providerId nested inside the request payload", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/matrix`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request: {
          providerId: "costamar",
          tripType: "round-trip",
          searchMode: "roundtrip-grid",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureStart: "2026-06-01",
              departureEnd: "2026-06-03",
              returnStart: "2026-06-08",
              returnEnd: "2026-06-10",
              minNights: 7,
              maxNights: 7,
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      request?: { providerId?: string };
      cells?: Array<{ derivedRequest?: { providerId?: string } }>;
      searchMeta?: { providersUsed?: string[] };
    };

    assert.equal(payload.request?.providerId, undefined);
    assert.equal(payload.cells?.[0]?.derivedRequest?.providerId, undefined);
    assert.deepEqual(payload.searchMeta?.providersUsed, ["agil-local", "costamar"]);
  });
});

test("explicit costamar matrix keeps the provider override in derived requests", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/matrix`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "costamar",
        providerConfig: {
          costamar: {
            terminalId: "0721808110",
          },
        },
        request: {
          tripType: "round-trip",
          searchMode: "roundtrip-grid",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureStart: "2026-06-01",
              departureEnd: "2026-06-03",
              returnStart: "2026-06-08",
              returnEnd: "2026-06-10",
              minNights: 7,
              maxNights: 7,
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      request?: { providerId?: string };
      cells?: Array<{ derivedRequest?: { providerId?: string } }>;
      searchMeta?: { providersUsed?: string[] };
    };

    assert.equal(payload.request?.providerId, "costamar");
    assert.equal(payload.cells?.[0]?.derivedRequest?.providerId, "costamar");
    assert.deepEqual(payload.searchMeta?.providersUsed, ["costamar"]);
  });
});

test("one-way stay-range preserves omitted maxResults and night bounds", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "costamar",
        request: {
          tripType: "one-way",
          searchMode: "stay-range",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureStart: "2026-05-01",
              departureEnd: "2026-05-31",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
          filters: {
            nonStop: false,
            baggageRequired: false,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      request?: {
        filters?: { maxResults?: number };
        legs?: Array<{ minNights?: number; maxNights?: number }>;
      };
      searchStatus?: string;
    };

    assert.equal(payload.searchStatus, "running");
    assert.equal(payload.request?.filters?.maxResults, undefined);
    assert.equal(payload.request?.legs?.[0]?.minNights, undefined);
    assert.equal(payload.request?.legs?.[0]?.maxNights, undefined);
  });
});

test("exact searches preserve omitted maxResults so page-based caps can be supplied by the client", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureDate: "2026-05-01",
              returnDate: "2026-05-31",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
          filters: {
            nonStop: false,
            baggageRequired: false,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      request?: {
        filters?: { maxResults?: number };
      };
      searchStatus?: string;
    };

    assert.equal(payload.searchStatus, "running");
    assert.equal(payload.request?.filters?.maxResults, undefined);
  });
});

test("agil-local searches skip Costamar context scans", async () => {
  resetCostamarSessionCacheForTests();

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "agil-local",
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureDate: "2026-05-01",
              returnDate: "2026-05-31",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
          filters: {},
        },
      }),
    });

    assert.equal(response.status, 200);
  });

  assert.equal(getCostamarChromeSessionScanCountForTests(), 0);
  resetCostamarSessionCacheForTests();
});

test("search endpoint serves cached results first for the same config while revalidating in background", async () => {
  const runtime = getRuntime();
  const terminalId = "9990001112";
  const seededToken = buildJwt({
    id: terminalId,
    iat: 1893456000,
    exp: 1893459600,
  });
  const refreshToken = buildJwt({
    id: terminalId,
    iat: 1893459600,
    exp: 1893463200,
  });
  const request: SearchRequest = {
    ...buildCostamarRequest(),
    legs: [
      {
        origin: "LIM",
        destination: "BCN",
        originLabel: "",
        destinationLabel: "",
        departureDate: "2026-09-04",
        departureStart: "",
        departureEnd: "",
        returnDate: "2026-09-18",
        returnStart: "",
        returnEnd: "",
      },
    ],
    filters: {
      nonStop: false,
      includedAirlineCodes: undefined,
      excludedAirlineCodes: undefined,
      maxPrice: undefined,
      maxResults: undefined,
      maxTotalDurationMinutes: undefined,
      maxLayoverMinutes: undefined,
      maxStops: undefined,
      minDepartureMinutes: undefined,
      maxDepartureMinutes: undefined,
      minArrivalMinutes: undefined,
      maxArrivalMinutes: undefined,
      baggageRequired: false,
      verifiedOnly: false,
      exactPurchasePathOnly: false,
    },
  };
  const cachedOffer = buildCostamarOffer(
    `https://booking.clickandbook.com/vuelos/b/LIM/BCN/2026-09-04/2026-09-18/1/0/0?terminalId=${terminalId}&lang=es&token=${seededToken}`,
  );
  const cachedJob = runtime.sessions.createSearchJob({
    request,
    providerContext: {
      costamar: {
        apiBaseUrl: "https://costamar.com.pe/vuelos/api",
        brandBaseUrl: "https://booking.clickandbook.com/vuelos",
        terminalId,
        token: seededToken,
        lang: "es",
      },
    },
    offers: [cachedOffer],
    allOffers: [cachedOffer],
    searchMeta: {
      ...buildSearchMeta(),
      providersUsed: ["costamar"],
    },
    providerMeta: buildProviderMeta(),
    warnings: ["Snapshot cache listo"],
    sortMode: "cheapest",
    status: "completed",
  });

  const previewCacheHit = runtime.sessions.findRecentCompletedSearchJob({
    request,
    providerContext: buildProviderContext("costamar", {
      costamar: {
        apiBaseUrl: "https://costamar.com.pe/vuelos/api",
        brandBaseUrl: "https://booking.clickandbook.com/vuelos",
        terminalId,
        token: refreshToken,
        lang: "es",
      },
    }),
    providerIds: ["costamar"],
    sortMode: "cheapest",
    maxAgeMs: 5 * 60 * 1000,
  });
  assert.equal(previewCacheHit?.id, cachedJob.id);

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "costamar",
        providerConfig: {
          costamar: {
            apiBaseUrl: "https://costamar.com.pe/vuelos/api",
            brandBaseUrl: "https://booking.clickandbook.com/vuelos",
            terminalId,
            token: refreshToken,
            lang: "es",
          },
        },
        sortMode: "cheapest",
        request,
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      searchJobId?: string;
      searchStatus?: string;
      searchComplete?: boolean;
      searchMeta?: { searchState?: string; partial?: boolean };
      warnings?: string[];
      offers?: unknown[];
    };

    assert.equal(payload.searchStatus, "running");
    assert.equal(payload.searchComplete, false);
    assert.equal(payload.searchJobId === cachedJob.id, false);
    assert.equal(payload.searchMeta?.searchState, "search_cached");
    assert.equal(payload.searchMeta?.partial, true);
    assert.ok((payload.offers?.length ?? 0) > 0);
    assert.ok(payload.warnings?.some((warning) => /cachead/i.test(warning)));
  });
});

test("search job polling returns a lightweight unchanged payload when revision has not moved", async () => {
  const runtime = getRuntime();
  const offer = buildCostamarOffer(
    "https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=test",
  );
  const job = runtime.sessions.createSearchJob({
    request: buildCostamarRequest(),
    offers: [offer],
    allOffers: [offer],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "running",
  });

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search/${job.id}?sinceRevision=${job.revision}`);
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      unchanged?: boolean;
      revision?: number;
      offers?: unknown[];
      allOffers?: unknown[];
      searchStatus?: string;
      searchComplete?: boolean;
    };

    assert.equal(payload.unchanged, true);
    assert.equal(payload.revision, job.revision);
    assert.equal(payload.searchStatus, "running");
    assert.equal(payload.searchComplete, false);
    assert.equal(payload.offers, undefined);
    assert.equal(payload.allOffers, undefined);
  });
});

test("matrix job polling returns a lightweight unchanged payload when revision has not moved", async () => {
  const runtime = getRuntime();
  const job = runtime.sessions.createMatrixJob({
    request: {
      ...buildCostamarRequest(),
      searchMode: "roundtrip-grid",
      flexibleMode: "exact-stay",
      tripType: "round-trip",
      legs: [
        {
          origin: "LIM",
          destination: "MAD",
          departureStart: "2026-06-01",
          departureEnd: "2026-06-03",
          stayNights: 7,
        },
      ],
    },
    cells: [buildCostamarMatrixCell(
      "https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=test",
    )],
    axes: {
      departureDates: ["2026-06-01"],
      returnDates: ["2026-06-08"],
    },
    confidenceSummary: { live: 1 },
    recommendations: [],
    providerMeta: buildProviderMeta(),
    searchMeta: buildSearchMeta(),
    warnings: [],
    status: "running",
  });

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/matrix/${job.id}?sinceRevision=${job.revision}`);
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      unchanged?: boolean;
      revision?: number;
      cells?: unknown[];
      matrixStatus?: string;
      matrixComplete?: boolean;
    };

    assert.equal(payload.unchanged, true);
    assert.equal(payload.revision, job.revision);
    assert.equal(payload.matrixStatus, "running");
    assert.equal(payload.matrixComplete, false);
    assert.equal(payload.cells, undefined);
  });
});

test("results layout endpoints persist and read back the saved column widths locally", async () => {
  const layoutFile = join(process.cwd(), "config", "results-layout.json");
  const previousLayout = existsSync(layoutFile) ? readFileSync(layoutFile, "utf8") : null;
  const columns = {
    carrier: 208,
    dates: 136,
    duration: 148,
    stops: 192,
    baggage: 108,
    price: 236,
    links: 160,
  };

  try {
    rmSync(layoutFile, { force: true });

    await withServer(async (baseUrl) => {
      const initialResponse = await fetch(`${baseUrl}/api/results-layout`);
      assert.equal(initialResponse.status, 200);
      const initialPayload = await initialResponse.json() as {
        layout?: null | { columns?: typeof columns };
      };
      assert.equal(initialPayload.layout, null);

      const saveResponse = await fetch(`${baseUrl}/api/results-layout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ columns }),
      });
      assert.equal(saveResponse.status, 200);
      const savePayload = await saveResponse.json() as {
        ok?: boolean;
        layout?: {
          version?: number;
          savedAt?: string;
          columns?: typeof columns;
        };
      };

      assert.equal(savePayload.ok, true);
      assert.equal(savePayload.layout?.version, 1);
      assert.deepEqual(savePayload.layout?.columns, columns);
      assert.match(savePayload.layout?.savedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

      const readBackResponse = await fetch(`${baseUrl}/api/results-layout`);
      assert.equal(readBackResponse.status, 200);
      const readBackPayload = await readBackResponse.json() as {
        layout?: {
          columns?: typeof columns;
        } | null;
      };
      assert.deepEqual(readBackPayload.layout?.columns, columns);
    });
  } finally {
    if (previousLayout === null) {
      rmSync(layoutFile, { force: true });
    } else {
      mkdirSync(join(process.cwd(), "config"), { recursive: true });
      writeFileSync(layoutFile, previousLayout, "utf8");
    }
  }
});

test("diagnostics endpoint exposes loopback-only runtime counters", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/diagnostics`);
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      ok?: boolean;
      memoryUsage?: { rss?: number };
      sessions?: { counts?: { searchJobs?: number; purchasePaths?: number } };
      tempArtifacts?: { totals?: { count?: number } };
    };

    assert.equal(payload.ok, true);
    assert.equal(typeof payload.memoryUsage?.rss, "number");
    assert.equal(typeof payload.sessions?.counts?.searchJobs, "number");
    assert.equal(typeof payload.sessions?.counts?.purchasePaths, "number");
    assert.equal(typeof payload.tempArtifacts?.totals?.count, "number");
  });
});

test("diagnostics endpoint ignores spoofed Host headers on loopback", async () => {
  await withServer(async (baseUrl) => {
    const url = new URL(baseUrl);
    const payload = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = httpRequest({
        host: url.hostname,
        port: Number(url.port),
        path: "/api/diagnostics",
        method: "GET",
        headers: {
          Host: "evil.example",
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      });

      req.on("error", reject);
      req.end();
    });

    assert.equal(payload.statusCode, 200);
    const json = JSON.parse(payload.body) as { ok?: boolean };
    assert.equal(json.ok, true);
  });
});

test("rejects oversized JSON bodies before routing", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request: {
          tripType: "round-trip",
          searchMode: "exact",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureDate: "2026-04-15",
              returnDate: "2026-04-22",
              originLabel: "X".repeat(1_100_000),
            },
          ],
        },
      }),
    });

    assert.equal(response.status, 413);
    const payload = await response.json() as { error?: string };
    assert.match(payload.error ?? "", /byte limit/i);
  });
});
