import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { CanonicalOffer, MatrixCell, ProviderMeta, SearchMeta, SearchRequest } from "../src/core/types";
import { requestWithServerTrustHeaders, routeRedirectRequest } from "../src/redirect-service";
import { SearchSessionStore } from "../src/session-store";
import { resetCostamarSessionCacheForTests } from "../src/provider-context";
import {
  resetCostamarWarmupStateForTests,
  setCostamarWarmupGeneratorForTests,
} from "../src/local-costamar";

function buildJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value))
    .toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

function buildRequest(providerId: "agil-local" | "costamar" = "costamar"): SearchRequest {
  return {
    providerId,
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

function buildSearchMeta(providerId: "agil-local" | "costamar" = "costamar"): SearchMeta {
  const now = "2026-03-31T00:00:00.000Z";
  return {
    requestedAt: now,
    completedAt: now,
    providersUsed: [providerId],
    warnings: [],
    partial: false,
    searchState: "search_live",
  };
}

function buildProviderMeta(providerId: "agil-local" | "costamar" = "costamar"): ProviderMeta {
  return {
    exactProvider: providerId,
    coverageMode: "core",
  };
}

function buildOffer(provider: "agil-local" | "costamar", url: string): CanonicalOffer {
  return {
    id: `offer-${provider}`,
    signature: `offer-${provider}-sig`,
    providerSource: provider,
    providerOfferRef: `offer-${provider}-ref`,
    tripType: "round-trip",
    validatingCarrier: "IB",
    mainCarrier: "IB",
    origin: "LIM",
    destination: "MAD",
    itineraries: [
      {
        id: `offer-${provider}-out`,
        direction: "outbound",
        durationMinutes: 720,
        stops: 0,
        layoverMinutes: [],
        segments: [
          {
            id: `offer-${provider}-out-seg`,
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
        id: `offer-${provider}-in`,
        direction: "inbound",
        durationMinutes: 720,
        stops: 0,
        layoverMinutes: [],
        segments: [
          {
            id: `offer-${provider}-in-seg`,
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
    priceStatus: "verified",
    baggage: {
      carryOnIncluded: true,
      checkedIncluded: true,
      pieces: 1,
    },
    refundability: "unknown",
    exchangeability: "unknown",
    purchasePaths: [
      {
        id: `${provider}-search`,
        type: "search-redirect",
        provider,
        label: provider === "agil-local" ? "Buscar en Agil" : "Buscar en Click and Book Plus",
        url,
        precision: "exact-search",
        score: 0.9,
        requiresNewTab: true,
        commercialMode: "provider",
        state: "search_redirect",
      },
    ],
    raw: {},
  };
}

function buildMatrixCell(
  provider: "agil-local" | "costamar",
  url: string,
  raw: Record<string, unknown> = {},
): MatrixCell {
  const offer = buildOffer(provider, url);
  offer.raw = raw;
  return {
    key: `${provider}-matrix-cell`,
    departureDate: "2026-06-01",
    returnDate: "2026-06-08",
    stayNights: 7,
    price: offer.price.total,
    confidence: "live",
    providerSource: provider,
    selectable: true,
    requiresRequery: false,
    stateCode: "live",
    tooltip: "Resultado exacto.",
    derivedRequest: buildRequest(provider),
    offer,
    purchasePaths: offer.purchasePaths,
  };
}

async function withTempDb<T>(run: (dbPath: string) => Promise<T> | T): Promise<T> {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-redirect-service-"));
  const dbPath = join(tempRoot, "cache.sqlite");

  try {
    return await run(dbPath);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function authenticatedRedirectRequest(url: string): Request {
  return new Request(url, {
    headers: {
      "x-flydesk-api-token": "redirect-test-token",
    },
  });
}

function overrideEnv(values: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

test("redirect service requires auth before reading purchase paths", async () => {
  const restoreEnv = overrideEnv({
    FLY_DESK_API_TOKEN: undefined,
    FLY_DESK_WEB_AUTH: undefined,
    FLY_DESK_TRUST_LOOPBACK_CLIENT: undefined,
  });

  try {
    const response = await routeRedirectRequest(
      new Request("http://127.0.0.1:32124/r/unknown"),
      { dbPath: "missing.sqlite", cacheLookupTimeoutMs: 0 },
    );

    assert.equal(response.status, 403);
  } finally {
    restoreEnv();
  }
});

test("redirect service ignores forged loopback trust headers from non-loopback clients", async () => {
  const restoreEnv = overrideEnv({
    FLY_DESK_API_TOKEN: undefined,
    FLY_DESK_WEB_AUTH: undefined,
    FLY_DESK_TRUST_LOOPBACK_CLIENT: "1",
    FLY_DESK_TRUST_REVERSE_PROXY_LOOPBACK: undefined,
  });

  try {
    const request = requestWithServerTrustHeaders(
      new Request("http://127.0.0.1:32124/r/unknown", {
        headers: {
          "x-flydesk-client-loopback": "1",
        },
      }),
      {
        requestIP: () => ({ address: "203.0.113.10", port: 54321, family: "IPv4" }),
      },
    );

    assert.equal(request.headers.get("x-flydesk-client-loopback"), "0");
    const response = await routeRedirectRequest(request, { dbPath: "missing.sqlite", cacheLookupTimeoutMs: 0 });
    assert.equal(response.status, 403);
  } finally {
    restoreEnv();
  }
});

test("redirect service resolves Agil purchase paths from SQLite without the main runtime", async () => {
  await withTempDb(async (dbPath) => {
    const restoreEnv = overrideEnv({ FLY_DESK_API_TOKEN: "redirect-test-token" });

    try {
      const agilUrl = "https://www.agilsmart.com/home-user/flight-result?origin=LIM&destination=MAD";
      const offer = buildOffer("agil-local", agilUrl);
      const store = new SearchSessionStore({ dbPath });
      const job = store.createSearchJob({
        request: buildRequest("agil-local"),
        offers: [offer],
        allOffers: [offer],
        searchMeta: buildSearchMeta("agil-local"),
        providerMeta: buildProviderMeta("agil-local"),
        warnings: [],
        sortMode: "cheapest",
        status: "completed",
      });
      const redirectPath = store.getSession(job.id)?.offers[0]?.purchasePaths[0]?.url;
      store.close();

      assert.ok(redirectPath);

      const response = await routeRedirectRequest(
        authenticatedRedirectRequest(`http://127.0.0.1:32124${redirectPath}`),
        { dbPath, cacheLookupTimeoutMs: 0 },
      );

      assert.equal(response.status, 302);
      assert.equal(response.headers.get("Location"), agilUrl);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
    } finally {
      restoreEnv();
    }
  });
});

test("redirect service does not parse the full search job payload", { concurrency: false }, async () => {
  await withTempDb(async (dbPath) => {
    const restoreEnv = overrideEnv({ FLY_DESK_API_TOKEN: "redirect-test-token" });
    const marker = "redirect-must-not-parse-search-job-payload";

    try {
      const agilUrl = "https://www.agilsmart.com/home-user/flight-result?origin=LIM&destination=MAD";
      const offer = buildOffer("agil-local", agilUrl);
      offer.raw = { marker, ballast: "x".repeat(1_000_000) };
      const store = new SearchSessionStore({ dbPath });
      const job = store.createSearchJob({
        request: buildRequest("agil-local"),
        offers: [offer],
        allOffers: [offer],
        searchMeta: buildSearchMeta("agil-local"),
        providerMeta: buildProviderMeta("agil-local"),
        warnings: [],
        sortMode: "cheapest",
        status: "completed",
      });
      const redirectPath = store.getSession(job.id)?.offers[0]?.purchasePaths[0]?.url;
      store.close();

      assert.ok(redirectPath);

      const parseSpy = spyOn(JSON, "parse");
      try {
        const response = await routeRedirectRequest(
          authenticatedRedirectRequest(`http://127.0.0.1:32124${redirectPath}`),
          { dbPath, cacheLookupTimeoutMs: 0 },
        );

        assert.equal(response.status, 302);
        assert.equal(response.headers.get("Location"), agilUrl);
        assert.equal(
          parseSpy.mock.calls.some(([payload]) => typeof payload === "string" && payload.includes(marker)),
          false,
        );
      } finally {
        parseSpy.mockRestore();
      }
    } finally {
      restoreEnv();
    }
  });
});

test("redirect service does not parse the full matrix job payload", { concurrency: false }, async () => {
  await withTempDb(async (dbPath) => {
    const restoreEnv = overrideEnv({ FLY_DESK_API_TOKEN: "redirect-test-token" });
    const marker = "redirect-must-not-parse-matrix-job-payload";

    try {
      const agilUrl = "https://www.agilsmart.com/home-user/flight-result?origin=LIM&destination=MAD";
      const store = new SearchSessionStore({ dbPath });
      const job = store.createMatrixJob({
        request: { ...buildRequest("agil-local"), searchMode: "roundtrip-grid" },
        providerContext: {
          costamar: {
            apiBaseUrl: "https://costamar.example/api",
            brandBaseUrl: "https://booking.example/vuelos",
            terminalId: "matrix-terminal",
            token: "matrix-ephemeral-token",
            lang: "es",
          },
        },
        cells: [buildMatrixCell("agil-local", agilUrl, {
          marker,
          ballast: "x".repeat(1_000_000),
        })],
        axes: {
          departureDates: ["2026-06-01"],
          returnDates: ["2026-06-08"],
        },
        confidenceSummary: { live: 1 },
        recommendations: [],
        providerMeta: buildProviderMeta("agil-local"),
        searchMeta: buildSearchMeta("agil-local"),
        warnings: [],
        status: "completed",
      });
      const redirectPath = store.getMatrixJob(job.id)?.cells[0]?.purchasePaths?.[0]?.url;
      store.close();

      assert.ok(redirectPath);
      const db = new Database(dbPath, { readonly: true });
      try {
        const persisted = db.query<{
          compactBytes: number;
          payloadBytes: number;
          requestKey: string;
          providerContextKey: string;
        }, [string]>(`
          SELECT
            length(CAST(request_key AS BLOB))
              + length(CAST(provider_context_key AS BLOB)) AS compactBytes,
            length(CAST(payload AS BLOB)) AS payloadBytes,
            request_key AS requestKey,
            provider_context_key AS providerContextKey
          FROM matrix_jobs
          WHERE id = ?
        `).get(job.id);
        assert.ok((persisted?.payloadBytes ?? 0) > 1_000_000);
        assert.ok((persisted?.compactBytes ?? Number.POSITIVE_INFINITY) < 4_096);
        assert.match(persisted?.requestKey ?? "", /roundtrip-grid/);
        assert.match(persisted?.providerContextKey ?? "", /matrix-terminal/);
        assert.equal((persisted?.providerContextKey ?? "").includes("matrix-ephemeral-token"), false);
      } finally {
        db.close();
      }

      const parseSpy = spyOn(JSON, "parse");
      try {
        const response = await routeRedirectRequest(
          authenticatedRedirectRequest(`http://127.0.0.1:32124${redirectPath}`),
          { dbPath, cacheLookupTimeoutMs: 0 },
        );

        assert.equal(response.status, 302);
        assert.equal(response.headers.get("Location"), agilUrl);
        assert.equal(
          parseSpy.mock.calls.some(([payload]) => typeof payload === "string" && payload.includes(marker)),
          false,
        );
      } finally {
        parseSpy.mockRestore();
      }
    } finally {
      restoreEnv();
    }
  });
});

test("redirect service falls back to the payload for a legacy matrix row", async () => {
  await withTempDb(async (dbPath) => {
    const restoreEnv = overrideEnv({ FLY_DESK_API_TOKEN: "redirect-test-token" });

    try {
      const agilUrl = "https://www.agilsmart.com/home-user/flight-result?origin=LIM&destination=MAD";
      const store = new SearchSessionStore({ dbPath });
      const job = store.createMatrixJob({
        request: { ...buildRequest("agil-local"), searchMode: "roundtrip-grid" },
        cells: [buildMatrixCell("agil-local", agilUrl)],
        axes: {
          departureDates: ["2026-06-01"],
          returnDates: ["2026-06-08"],
        },
        confidenceSummary: { live: 1 },
        recommendations: [],
        providerMeta: buildProviderMeta("agil-local"),
        searchMeta: buildSearchMeta("agil-local"),
        warnings: [],
        status: "completed",
      });
      const redirectPath = store.getMatrixJob(job.id)?.cells[0]?.purchasePaths?.[0]?.url;
      store.close();

      const db = new Database(dbPath);
      try {
        db.run(
          "UPDATE matrix_jobs SET request_key = NULL, provider_context_key = NULL WHERE id = ?",
          job.id,
        );
      } finally {
        db.close(true);
      }

      assert.ok(redirectPath);
      const response = await routeRedirectRequest(
        authenticatedRedirectRequest(`http://127.0.0.1:32124${redirectPath}`),
        { dbPath, cacheLookupTimeoutMs: 0 },
      );

      assert.equal(response.status, 302);
      assert.equal(response.headers.get("Location"), agilUrl);
    } finally {
      restoreEnv();
    }
  });
});

test("redirect service resolves visible running Agil purchase paths from SQLite", async () => {
  await withTempDb(async (dbPath) => {
    const restoreEnv = overrideEnv({ FLY_DESK_API_TOKEN: "redirect-test-token" });

    try {
      const agilUrl = "https://www.agilsmart.com/home-user/flight-result?origin=LIM&destination=MAD";
      const offer = buildOffer("agil-local", agilUrl);
      const store = new SearchSessionStore({ dbPath });
      const job = store.createSearchJob({
        request: buildRequest("agil-local"),
        offers: [offer],
        allOffers: [offer],
        searchMeta: buildSearchMeta("agil-local"),
        providerMeta: buildProviderMeta("agil-local"),
        warnings: [],
        sortMode: "cheapest",
        status: "running",
      });
      const redirectPath = store.getSession(job.id)?.offers[0]?.purchasePaths[0]?.url;
      store.close();

      assert.ok(redirectPath);

      const response = await routeRedirectRequest(
        authenticatedRedirectRequest(`http://127.0.0.1:32124${redirectPath}`),
        { dbPath, cacheLookupTimeoutMs: 0 },
      );

      assert.equal(response.status, 302);
      assert.equal(response.headers.get("Location"), agilUrl);
    } finally {
      restoreEnv();
    }
  });
});

test("redirect service keeps partial cached links after a running search is cancelled", async () => {
  await withTempDb(async (dbPath) => {
    const restoreEnv = overrideEnv({ FLY_DESK_API_TOKEN: "redirect-test-token" });

    try {
      const agilUrl = "https://www.agilsmart.com/home-user/flight-result?origin=LIM&destination=MAD";
      const offer = buildOffer("agil-local", agilUrl);
      const store = new SearchSessionStore({ dbPath });
      const job = store.createSearchJob({
        request: buildRequest("agil-local"),
        offers: [offer],
        allOffers: [offer],
        searchMeta: buildSearchMeta("agil-local"),
        providerMeta: buildProviderMeta("agil-local"),
        warnings: [],
        sortMode: "cheapest",
        status: "running",
      });
      const redirectPath = store.getSession(job.id)?.offers[0]?.purchasePaths[0]?.url;
      store.cancelSearchJob(job.id, "cancelled by test", { cachePartial: true });
      store.close();

      assert.ok(redirectPath);

      const response = await routeRedirectRequest(
        authenticatedRedirectRequest(`http://127.0.0.1:32124${redirectPath}`),
        { dbPath, cacheLookupTimeoutMs: 0 },
      );

      assert.equal(response.status, 302);
      assert.equal(response.headers.get("Location"), agilUrl);
    } finally {
      restoreEnv();
    }
  });
});

test("redirect service keeps Costamar token validation outside the main runtime", async () => {
  await withTempDb(async (dbPath) => {
    const emptyChromeDir = join(dbPath, "..", "chrome-empty");
    mkdirSync(emptyChromeDir, { recursive: true });
    const restoreEnv = overrideEnv({
      FLY_DESK_API_TOKEN: "redirect-test-token",
      CBPLUS_TOKEN: undefined,
      COSTAMAR_TOKEN: undefined,
      CBPLUS_CHROME_USER_DATA_DIR: emptyChromeDir,
      CBPLUS_AGENT_CHROME_USER_DATA_DIR: emptyChromeDir,
      COSTAMAR_CHROME_USER_DATA_DIR: emptyChromeDir,
      COSTAMAR_AGENT_CHROME_USER_DATA_DIR: emptyChromeDir,
      CBPLUS_CDP_TAB_SCAN_ENABLED: "0",
      COSTAMAR_CDP_TAB_SCAN_ENABLED: "0",
      CBPLUS_SESSION_WARMUP_ENABLED: "0",
      COSTAMAR_SESSION_WARMUP_ENABLED: "0",
      CBPLUS_SESSION_WARMUP_TIMEOUT_MS: "0",
      COSTAMAR_SESSION_WARMUP_TIMEOUT_MS: "0",
      CBPLUS_SESSION_WARMUP_OPEN_BROWSER_FALLBACK: "0",
      COSTAMAR_SESSION_WARMUP_OPEN_BROWSER_FALLBACK: "0",
      CBPLUS_B2B_AUTOMATION_ENABLED: "0",
      COSTAMAR_B2B_AUTOMATION_ENABLED: "0",
      CBPLUS_B2B_PROMPT_ENABLED: "0",
      COSTAMAR_B2B_PROMPT_ENABLED: "0",
      CBPLUS_B2B_USE_LIVE_BROWSER: "0",
      COSTAMAR_B2B_USE_LIVE_BROWSER: "0",
    });

    try {
      resetCostamarSessionCacheForTests();
      resetCostamarWarmupStateForTests();
      setCostamarWarmupGeneratorForTests(async () => undefined);

      const staleToken = buildJwt({
        id: "0721808110",
        iat: 1700000000,
        exp: 1700003600,
      });
      const costamarUrl = `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${staleToken}`;
      const offer = buildOffer("costamar", costamarUrl);
      const store = new SearchSessionStore({ dbPath });
      const job = store.createSearchJob({
        request: buildRequest("costamar"),
        providerContext: {
          costamar: {
            apiBaseUrl: "https://costamar.com.pe/vuelos/api",
            brandBaseUrl: "https://booking.clickandbook.com/vuelos",
            terminalId: "0721808110",
            token: staleToken,
            lang: "es",
          },
        },
        offers: [offer],
        allOffers: [offer],
        searchMeta: buildSearchMeta("costamar"),
        providerMeta: buildProviderMeta("costamar"),
        warnings: [],
        sortMode: "cheapest",
        status: "completed",
      });
      const redirectPath = store.getSession(job.id)?.offers[0]?.purchasePaths[0]?.url;
      store.close();

      assert.ok(redirectPath);

      const response = await routeRedirectRequest(
        authenticatedRedirectRequest(`http://127.0.0.1:32124${redirectPath}`),
        { dbPath, cacheLookupTimeoutMs: 0 },
      );

      assert.equal(response.status, 409);
      assert.match(response.headers.get("content-type") ?? "", /text\/html/i);
      assert.match(await response.text(), /Renueva la sesion de Click and Book Plus/i);
    } finally {
      resetCostamarWarmupStateForTests();
      resetCostamarSessionCacheForTests();
      restoreEnv();
    }
  });
});
