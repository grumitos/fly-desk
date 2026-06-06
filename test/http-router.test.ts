import { test } from "bun:test";
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
import {
  resetCostamarWarmupStateForTests,
  setCostamarWarmupGeneratorForTests,
} from "../src/local-costamar";
import { routeRequest, SEARCH_REVALIDATION_CACHE_TTL_MS, setQuotationOfferValidatorForTests } from "../src/http-router";
import { resolveSearchServiceProxyApiToken } from "../src/service-auth";
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
    usdToPenRate: 3.5,
    priceConfidence: "live",
    priceStatus: "unverified",
    purchasePaths: [
      {
        id: "offer-costamar-1-path",
        type: "search-redirect",
        provider: "costamar",
        label: "Buscar en Click and Book Plus",
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
  };
}

test("search revalidation cache ttl is four hours", () => {
  assert.equal(SEARCH_REVALIDATION_CACHE_TTL_MS, 4 * 60 * 60 * 1000);
});

function buildCostamarMatrixCell(url: string): MatrixCell {
  const offer = buildCostamarOffer(url);

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
    tooltip: "Click and Book Plus live search.",
    derivedRequest: buildCostamarRequest(),
    purchasePaths: [
      {
        id: "matrix-costamar-path",
        type: "search-redirect",
        provider: "costamar",
        label: "Buscar en Click and Book Plus",
        url,
        precision: "exact-search",
        score: 0.9,
        requiresNewTab: true,
        commercialMode: "provider",
        state: "search_redirect",
      },
    ],
    offer: {
      ...offer,
      id: "matrix-offer-costamar-1",
      purchasePaths: [
        {
          ...offer.purchasePaths[0],
          id: "matrix-offer-costamar-1-path",
        },
      ],
    },
  };
}

async function withAcceptedCostamarRedirectValidation<T>(run: () => Promise<T>): Promise<T> {
  const previousFetch = global.fetch;
  global.fetch = (async (input, init) => {
    const url = typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url;
    if (url.startsWith("https://booking.clickandbook.com/") || url.startsWith("https://flights.zdev.tech/")) {
      return new Response("<html><body>Click and Book Plus search accepted</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return previousFetch(input, init);
  }) as typeof fetch;

  try {
    return await run();
  } finally {
    global.fetch = previousFetch;
  }
}

async function withLoopbackTrustForTests<T>(run: () => Promise<T>): Promise<T> {
  const previousTrustLoopback = process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
  process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = "1";

  try {
    return await run();
  } finally {
    if (previousTrustLoopback === undefined) {
      delete process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
    } else {
      process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = previousTrustLoopback;
    }
  }
}

test("quotation uses the stored exact offer when the selected result belongs to a search job", async () => {
  const runtime = getRuntime();
  const offer = {
    ...buildCostamarOffer("https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0"),
    priceConfidence: "validated" as const,
    priceStatus: "verified" as const,
  };
  const searchMeta = buildSearchMeta();
  const now = new Date().toISOString();
  const job = runtime.sessions.createSearchJob({
    request: buildCostamarRequest(),
    offers: [offer],
    allOffers: [offer],
    searchMeta: {
      ...searchMeta,
      requestedAt: now,
      completedAt: now,
    },
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/quotation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        searchSessionId: job.id,
        offerId: offer.id,
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as { commercialText?: string };
    assert.match(payload.commercialText ?? "", /COTIZACIÓN BOLETO AÉREO/);
    assert.match(payload.commercialText ?? "", /US\$ 1,234 por adulto/);
    assert.doesNotMatch(payload.commercialText ?? "", /S\/|aprox|Tipo de cambio|Fuente:|Fecha:/);
  });
});

test("quotation rejects client-supplied offer snapshots without a stored server offer", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/quotation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        offer: {
          id: "2026-06-01_2026-06-08",
          providerSource: "costamar",
          airline: "Flexible",
          origin: "LIM",
          destination: "MAD",
          departureDate: "2026-06-01",
          returnDate: "2026-06-08",
          price: {
            total: {
              amount: 498,
              currencyCode: "USD",
            },
          },
          priceConfidence: "live",
          priceStatus: "unverified",
          usdToPenRate: 3.5,
        },
        request: buildCostamarRequest(),
      }),
    });

    assert.equal(response.status, 400);
    const payload = await response.json() as { errors?: string[] };
    assert.ok(payload.errors?.includes("searchSessionId and offerId are required."));
  });
});

test("quotation rejects forged snapshots when the session offer id does not exist", async () => {
  const runtime = getRuntime();
  const storedOffer = {
    ...buildCostamarOffer("https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0"),
    priceConfidence: "validated" as const,
    priceStatus: "verified" as const,
  };
  const job = runtime.sessions.createSearchJob({
    request: buildCostamarRequest(),
    offers: [storedOffer],
    allOffers: [storedOffer],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/quotation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        searchSessionId: job.id,
        offerId: "attacker-offer",
        offer: {
          id: "attacker-offer",
          providerSource: "costamar",
          airline: "Bogus Air",
          origin: "LIM",
          destination: "MAD",
          departureDate: "2026-06-01",
          returnDate: "2026-06-08",
          price: { total: { amount: 33.3, currencyCode: "USD" } },
          usdToPenRate: 7.7,
        },
        request: buildCostamarRequest(),
      }),
    });

    assert.equal(response.status, 404);
    const payload = await response.json() as { errors?: string[] };
    assert.ok(payload.errors?.includes("Session or offer not found."));
  });
});

test("quotation refuses cached offers that have not been provider validated", async () => {
  const runtime = getRuntime();
  const offer = buildCostamarOffer("https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0");
  const job = runtime.sessions.createSearchJob({
    request: buildCostamarRequest(),
    offers: [offer],
    allOffers: [offer],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/quotation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        searchSessionId: job.id,
        offerId: offer.id,
      }),
    });

    assert.equal(response.status, 409);
    const payload = await response.json() as { errors?: string[] };
    assert.ok(payload.errors?.includes("Selected offer could not be validated for quotation."));
  });
});

test("quotation validates an unverified stored offer before rendering", { concurrency: false }, async () => {
  const runtime = getRuntime();
  const offer = buildCostamarOffer("https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0");
  const job = runtime.sessions.createSearchJob({
    request: buildCostamarRequest(),
    offers: [offer],
    allOffers: [offer],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });
  let validatorCalls = 0;

  setQuotationOfferValidatorForTests(async (source) => {
    validatorCalls += 1;
    assert.equal(source.sessionId, job.id);
    assert.equal(source.offer.id, offer.id);
    return {
      ...source.offer,
      price: {
        ...source.offer.price,
        total: {
          amount: 1500,
          currencyCode: "USD",
        },
      },
      priceConfidence: "validated",
      priceStatus: "verified",
    };
  });

  try {
    const response = await withLoopbackTrustForTests(() =>
      routeRequest(new Request("http://127.0.0.1:32123/api/quotation", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-flydesk-client-loopback": "1",
        },
        body: JSON.stringify({
          searchSessionId: job.id,
          offerId: offer.id,
        }),
      }))
    );

    assert.equal(response.status, 200);
    const payload = await response.json() as { commercialText?: string; offer?: CanonicalOffer };
    assert.equal(validatorCalls, 1);
    assert.equal(payload.offer?.price.total.amount, 1500);
    assert.match(payload.commercialText ?? "", /US\$ 1,500 por adulto/);
    assert.equal(runtime.sessions.getOffer(job.id, offer.id)?.priceStatus, "verified");
  } finally {
    setQuotationOfferValidatorForTests();
  }
});

test("quotation revalidates a prepared live result before rendering", { concurrency: false }, async () => {
  const runtime = getRuntime();
  const offer = {
    ...buildCostamarOffer("https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0"),
    quotationPreparedAt: new Date().toISOString(),
  };
  const job = runtime.sessions.createSearchJob({
    request: buildCostamarRequest(),
    offers: [offer],
    allOffers: [offer],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });
  let validatorCalls = 0;

  setQuotationOfferValidatorForTests(async () => {
    validatorCalls += 1;
    return undefined;
  });

  try {
    const response = await withLoopbackTrustForTests(() =>
      routeRequest(new Request("http://127.0.0.1:32123/api/quotation", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-flydesk-client-loopback": "1",
        },
        body: JSON.stringify({
          searchSessionId: job.id,
          offerId: offer.id,
        }),
      }))
    );

    assert.equal(response.status, 409);
    const payload = await response.json() as { errors?: string[] };
    assert.equal(validatorCalls, 1);
    assert.ok(payload.errors?.includes("Selected offer could not be validated for quotation."));
  } finally {
    setQuotationOfferValidatorForTests();
  }
});

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

test("rejects non-loopback location requests without a valid api token", { concurrency: false }, async () => {
  const previousApiToken = process.env.FLY_DESK_API_TOKEN;
  process.env.FLY_DESK_API_TOKEN = "test-token";

  try {
    const response = await routeRequest(new Request("http://fly-desk.local/api/locations?q=", {
      method: "GET",
      headers: {
        "x-flydesk-client-loopback": "0",
      },
    }));

    assert.equal(response.status, 403);
    const payload = await response.json() as { error?: string };
    assert.match(payload.error ?? "", /localhost access or a valid API token/i);
  } finally {
    if (previousApiToken === undefined) {
      delete process.env.FLY_DESK_API_TOKEN;
    } else {
      process.env.FLY_DESK_API_TOKEN = previousApiToken;
    }
  }
});

test("accepts non-loopback location requests with a valid api token", { concurrency: false }, async () => {
  const previousApiToken = process.env.FLY_DESK_API_TOKEN;
  process.env.FLY_DESK_API_TOKEN = "test-token";

  try {
    const response = await routeRequest(new Request("http://fly-desk.local/api/locations?q=", {
      method: "GET",
      headers: {
        "x-flydesk-client-loopback": "0",
        "x-flydesk-api-token": "test-token",
      },
    }));

    assert.equal(response.status, 200);
    const payload = await response.json() as { query?: string; suggestions?: unknown[] };
    assert.equal(payload.query, "");
    assert.deepEqual(payload.suggestions, []);
  } finally {
    if (previousApiToken === undefined) {
      delete process.env.FLY_DESK_API_TOKEN;
    } else {
      process.env.FLY_DESK_API_TOKEN = previousApiToken;
    }
  }
});

test("accepts non-loopback location requests with the internal search service token", { concurrency: false }, async () => {
  const previousApiToken = process.env.FLY_DESK_API_TOKEN;
  const previousSearchToken = process.env.FLY_DESK_SEARCH_SERVICE_API_TOKEN;
  const previousSessionSecret = process.env.FLY_DESK_WEB_SESSION_SECRET;
  delete process.env.FLY_DESK_API_TOKEN;
  delete process.env.FLY_DESK_SEARCH_SERVICE_API_TOKEN;
  process.env.FLY_DESK_WEB_SESSION_SECRET = "test-session-secret-32-characters-minimum";

  try {
    const internalToken = resolveSearchServiceProxyApiToken();
    assert.ok(internalToken);
    const response = await routeRequest(new Request("http://fly-desk.local/api/locations?q=", {
      method: "GET",
      headers: {
        "x-flydesk-client-loopback": "0",
        "x-flydesk-api-token": internalToken,
      },
    }));

    assert.equal(response.status, 200);
    const payload = await response.json() as { query?: string; suggestions?: unknown[] };
    assert.equal(payload.query, "");
    assert.deepEqual(payload.suggestions, []);
  } finally {
    if (previousApiToken === undefined) {
      delete process.env.FLY_DESK_API_TOKEN;
    } else {
      process.env.FLY_DESK_API_TOKEN = previousApiToken;
    }

    if (previousSearchToken === undefined) {
      delete process.env.FLY_DESK_SEARCH_SERVICE_API_TOKEN;
    } else {
      process.env.FLY_DESK_SEARCH_SERVICE_API_TOKEN = previousSearchToken;
    }

    if (previousSessionSecret === undefined) {
      delete process.env.FLY_DESK_WEB_SESSION_SECRET;
    } else {
      process.env.FLY_DESK_WEB_SESSION_SECRET = previousSessionSecret;
    }
  }
});

test("loopback trust does not authorize forwarded proxy clients unless proxy loopback trust is explicit", { concurrency: false }, async () => {
  const previousTrustLoopback = process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
  const previousProxyTrust = process.env.FLY_DESK_TRUST_REVERSE_PROXY_LOOPBACK;
  process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = "1";
  delete process.env.FLY_DESK_TRUST_REVERSE_PROXY_LOOPBACK;

  try {
    const forwarded = new Request("http://fly-desk.local/api/diagnostics", {
      method: "GET",
      headers: {
        "x-flydesk-client-loopback": "1",
        "x-forwarded-for": "203.0.113.77",
      },
    });

    const denied = await routeRequest(forwarded);
    assert.equal(denied.status, 403);

    process.env.FLY_DESK_TRUST_REVERSE_PROXY_LOOPBACK = "1";
    const accepted = await routeRequest(forwarded);
    assert.equal(accepted.status, 200);
  } finally {
    if (previousTrustLoopback === undefined) {
      delete process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
    } else {
      process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = previousTrustLoopback;
    }

    if (previousProxyTrust === undefined) {
      delete process.env.FLY_DESK_TRUST_REVERSE_PROXY_LOOPBACK;
    } else {
      process.env.FLY_DESK_TRUST_REVERSE_PROXY_LOOPBACK = previousProxyTrust;
    }
  }
});

test("web auth cookie allows API access when loopback trust is disabled", { concurrency: false }, async () => {
  const previousWebAuth = process.env.FLY_DESK_WEB_AUTH;
  const previousTrustLoopback = process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
  const previousWebPassword = process.env.FLY_DESK_WEB_PASSWORD;
  const previousSessionSecret = process.env.FLY_DESK_WEB_SESSION_SECRET;
  const previousCookieSecure = process.env.FLY_DESK_COOKIE_SECURE;

  process.env.FLY_DESK_WEB_AUTH = "1";
  process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = "0";
  process.env.FLY_DESK_WEB_PASSWORD = "test-password";
  process.env.FLY_DESK_WEB_SESSION_SECRET = "test-session-secret-32-characters-minimum";
  process.env.FLY_DESK_COOKIE_SECURE = "1";

  try {
    const denied = await routeRequest(new Request("https://fly-desk.local/api/locations?q=", {
      method: "GET",
      headers: {
        "x-flydesk-client-loopback": "1",
      },
    }));

    assert.equal(denied.status, 401);

    const login = await routeRequest(new Request("https://fly-desk.local/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ password: "test-password" }).toString(),
    }));

    assert.equal(login.status, 303);
    const cookie = login.headers.get("set-cookie");
    assert.match(cookie ?? "", /flydesk_session=/);
    assert.match(cookie ?? "", /HttpOnly/);
    assert.match(cookie ?? "", /Secure/);

    const accepted = await routeRequest(new Request("https://fly-desk.local/api/locations?q=", {
      method: "GET",
      headers: {
        "x-flydesk-client-loopback": "0",
        Cookie: cookie ?? "",
      },
    }));

    assert.equal(accepted.status, 200);
    const payload = await accepted.json() as { query?: string; suggestions?: unknown[] };
    assert.equal(payload.query, "");
    assert.deepEqual(payload.suggestions, []);
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

    if (previousCookieSecure === undefined) {
      delete process.env.FLY_DESK_COOKIE_SECURE;
    } else {
      process.env.FLY_DESK_COOKIE_SECURE = previousCookieSecure;
    }
  }
});

test("rejects non-loopback purchase path redirects without a valid api token", { concurrency: false }, async () => {
  const previousApiToken = process.env.FLY_DESK_API_TOKEN;
  process.env.FLY_DESK_API_TOKEN = "test-token";

  try {
    const response = await routeRequest(new Request("http://fly-desk.local/r/missing-path", {
      method: "GET",
      headers: {
        "x-flydesk-client-loopback": "0",
      },
    }));

    assert.equal(response.status, 403);
    const payload = await response.json() as { error?: string };
    assert.match(payload.error ?? "", /localhost access or a valid API token/i);
  } finally {
    if (previousApiToken === undefined) {
      delete process.env.FLY_DESK_API_TOKEN;
    } else {
      process.env.FLY_DESK_API_TOKEN = previousApiToken;
    }
  }
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

test("search endpoint defaults unsupported sort mode to cheapest", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sortMode: "unsupported",
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
    assert.equal(payload.sortMode, "cheapest");
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
  resetCostamarWarmupStateForTests();
  setCostamarWarmupGeneratorForTests(async () => undefined);

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

    await withAcceptedCostamarRedirectValidation(async () => withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}${redirectPath}`, { redirect: "manual" });

      assert.equal(response.status, 302);
      const location = response.headers.get("location");
      assert.ok(location);

      const parsed = new URL(location);
      assert.equal(parsed.searchParams.get("terminalId"), "0721808110");
      assert.equal(parsed.searchParams.get("lang"), "es");
      assert.equal(parsed.searchParams.get("token"), freshToken);
    }));
  } finally {
    resetCostamarWarmupStateForTests();
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

test("costamar redirect refreshes an unverified stored token before opening Costamar", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-redirect-fast-"));
  const profileName = "Profile 41";
  const sessionsDir = join(tempRoot, profileName, "Sessions");
  mkdirSync(sessionsDir, { recursive: true });

  const usableToken = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  const newerToken = buildJwt({
    id: "0721808110",
    iat: 1893459600,
    exp: 1893463200,
  });
  writeFileSync(
    join(sessionsDir, "Tabs_1"),
    `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&token=${newerToken}`,
    "utf8",
  );

  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;
  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = profileName;
  resetCostamarSessionCacheForTests();
  resetCostamarWarmupStateForTests();
  setCostamarWarmupGeneratorForTests(async () => undefined);

  try {
    const runtime = getRuntime();
    const job = runtime.sessions.createSearchJob({
      request: buildCostamarRequest(),
      providerContext: {
        costamar: {
          apiBaseUrl: "https://costamar.com.pe/vuelos/api",
          brandBaseUrl: "https://booking.clickandbook.com/vuelos",
          terminalId: "0721808110",
          token: usableToken,
          lang: "es",
        },
      },
      offers: [buildCostamarOffer(
        `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${usableToken}`,
      )],
      allOffers: [buildCostamarOffer(
        `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${usableToken}`,
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

    await withAcceptedCostamarRedirectValidation(async () => withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}${redirectPath}`, { redirect: "manual" });

      assert.equal(response.status, 302);
      const location = response.headers.get("location");
      assert.ok(location);

      const parsed = new URL(location);
      assert.equal(parsed.searchParams.get("terminalId"), "0721808110");
      assert.equal(parsed.searchParams.get("lang"), "es");
      assert.equal(parsed.searchParams.get("token"), newerToken);
    }));

    assert.ok(getCostamarChromeSessionScanCountForTests() > 0);
  } finally {
    resetCostamarWarmupStateForTests();
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

test("costamar redirect warms a missing token through the B2B flow", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-redirect-warmup-"));
  const profileName = "Profile 43";
  const freshToken = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  const staleToken = buildJwt({
    id: "0721808110",
    iat: 1700000000,
    exp: 1700003600,
  });
  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;
  const previousWarmupEnabled = process.env.COSTAMAR_SESSION_WARMUP_ENABLED;
  const previousWarmupCooldown = process.env.COSTAMAR_SESSION_WARMUP_COOLDOWN_MS;
  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = profileName;
  process.env.COSTAMAR_SESSION_WARMUP_ENABLED = "1";
  process.env.COSTAMAR_SESSION_WARMUP_COOLDOWN_MS = "0";
  resetCostamarSessionCacheForTests();
  resetCostamarWarmupStateForTests();

  let warmedRequest: SearchRequest | undefined;
  setCostamarWarmupGeneratorForTests(async (request, context) => {
    warmedRequest = request;
    return {
      ...context,
      token: freshToken,
    };
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
        "https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es",
      )],
      allOffers: [buildCostamarOffer(
        "https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es",
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

    await withAcceptedCostamarRedirectValidation(async () => withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}${redirectPath}`, { redirect: "manual" });

      assert.equal(response.status, 302);
      const location = response.headers.get("location");
      assert.ok(location);

      const parsed = new URL(location);
      assert.equal(parsed.searchParams.get("terminalId"), "0721808110");
      assert.equal(parsed.searchParams.get("lang"), "es");
      assert.equal(parsed.searchParams.get("token"), freshToken);
    }));

    assert.equal(warmedRequest?.searchMode, "exact");
    assert.equal(warmedRequest?.tripType, "round-trip");
    assert.equal(warmedRequest?.legs[0]?.origin, "LIM");
    assert.equal(warmedRequest?.legs[0]?.destination, "MAD");
    assert.equal(warmedRequest?.legs[0]?.departureDate, "2026-06-01");
    assert.equal(warmedRequest?.legs[0]?.returnDate, "2026-06-08");
  } finally {
    resetCostamarWarmupStateForTests();
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

    if (previousWarmupEnabled === undefined) {
      delete process.env.COSTAMAR_SESSION_WARMUP_ENABLED;
    } else {
      process.env.COSTAMAR_SESSION_WARMUP_ENABLED = previousWarmupEnabled;
    }

    if (previousWarmupCooldown === undefined) {
      delete process.env.COSTAMAR_SESSION_WARMUP_COOLDOWN_MS;
    } else {
      process.env.COSTAMAR_SESSION_WARMUP_COOLDOWN_MS = previousWarmupCooldown;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("costamar redirect returns a controlled block when refresh hangs", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-redirect-timeout-"));
  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;
  const previousWarmupEnabled = process.env.COSTAMAR_SESSION_WARMUP_ENABLED;
  const previousWarmupCooldown = process.env.COSTAMAR_SESSION_WARMUP_COOLDOWN_MS;
  const previousWarmupFallback = process.env.COSTAMAR_SESSION_WARMUP_OPEN_BROWSER_FALLBACK;
  const previousWarmupTimeout = process.env.COSTAMAR_SESSION_WARMUP_TIMEOUT_MS;
  const previousRedirectTimeout = process.env.COSTAMAR_REDIRECT_TOTAL_TIMEOUT_MS;
  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = "Profile 44";
  process.env.COSTAMAR_SESSION_WARMUP_ENABLED = "1";
  process.env.COSTAMAR_SESSION_WARMUP_COOLDOWN_MS = "0";
  process.env.COSTAMAR_SESSION_WARMUP_OPEN_BROWSER_FALLBACK = "0";
  process.env.COSTAMAR_SESSION_WARMUP_TIMEOUT_MS = "1000";
  process.env.COSTAMAR_REDIRECT_TOTAL_TIMEOUT_MS = "1000";
  resetCostamarSessionCacheForTests();
  resetCostamarWarmupStateForTests();

  const staleToken = buildJwt({
    id: "0721808110",
    iat: 1700000000,
    exp: 1700003600,
  });

  setCostamarWarmupGeneratorForTests(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return undefined;
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

    const response = await withLoopbackTrustForTests(() =>
      routeRequest(new Request(`http://127.0.0.1:32123${redirectPath}`, {
        headers: {
          "x-flydesk-client-loopback": "1",
        },
      }))
    );

    assert.equal(response.status, 409);
    const body = await response.text();
    assert.match(body, /Renueva la sesion de Click and Book Plus/i);
    assert.match(body, /overflow:\s*hidden/i);
    assert.match(body, /place-items:\s*center/i);
    assert.match(body, /tardo mas de/i);
  } finally {
    resetCostamarWarmupStateForTests();
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

    if (previousWarmupEnabled === undefined) {
      delete process.env.COSTAMAR_SESSION_WARMUP_ENABLED;
    } else {
      process.env.COSTAMAR_SESSION_WARMUP_ENABLED = previousWarmupEnabled;
    }

    if (previousWarmupCooldown === undefined) {
      delete process.env.COSTAMAR_SESSION_WARMUP_COOLDOWN_MS;
    } else {
      process.env.COSTAMAR_SESSION_WARMUP_COOLDOWN_MS = previousWarmupCooldown;
    }

    if (previousWarmupFallback === undefined) {
      delete process.env.COSTAMAR_SESSION_WARMUP_OPEN_BROWSER_FALLBACK;
    } else {
      process.env.COSTAMAR_SESSION_WARMUP_OPEN_BROWSER_FALLBACK = previousWarmupFallback;
    }

    if (previousWarmupTimeout === undefined) {
      delete process.env.COSTAMAR_SESSION_WARMUP_TIMEOUT_MS;
    } else {
      process.env.COSTAMAR_SESSION_WARMUP_TIMEOUT_MS = previousWarmupTimeout;
    }

    if (previousRedirectTimeout === undefined) {
      delete process.env.COSTAMAR_REDIRECT_TOTAL_TIMEOUT_MS;
    } else {
      process.env.COSTAMAR_REDIRECT_TOTAL_TIMEOUT_MS = previousRedirectTimeout;
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
  resetCostamarWarmupStateForTests();
  setCostamarWarmupGeneratorForTests(async () => undefined);

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
    assert.equal(job.cells[0]?.offer?.purchasePaths[0]?.url, redirectPath);
    assert.doesNotMatch(JSON.stringify(job.cells), /token=/);

    await withAcceptedCostamarRedirectValidation(async () => withServer(async (baseUrl) => {
      const jobResponse = await fetch(`${baseUrl}/api/matrix/${job.id}`);
      assert.equal(jobResponse.status, 200);
      const jobBody = await jobResponse.text();
      assert.match(jobBody, /"offer"/);
      assert.doesNotMatch(jobBody, /token=/);

      const response = await fetch(`${baseUrl}${redirectPath}`, { redirect: "manual" });

      assert.equal(response.status, 302);
      const location = response.headers.get("location");
      assert.ok(location);

      const parsed = new URL(location);
      assert.equal(parsed.searchParams.get("terminalId"), "0721808110");
      assert.equal(parsed.searchParams.get("lang"), "es");
      assert.equal(parsed.searchParams.get("token"), freshToken);
    }));
  } finally {
    resetCostamarWarmupStateForTests();
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

test("agil search redirect returns the provider URL without local handoff page", async () => {
  const runtime = getRuntime();
  const agilUrl = "https://www.agilsmart.com/home-user/flight-result?origin=LIM&destination=MIA";
  const agilOffer: CanonicalOffer = {
    ...buildCostamarOffer(agilUrl),
    id: "offer-agil-local",
    providerSource: "agil-local",
    purchasePaths: [
      {
        id: "agil-path",
        type: "search-redirect",
        provider: "agil-local",
        label: "Buscar en Agil",
        url: agilUrl,
        precision: "exact-search",
        score: 0.9,
        requiresNewTab: true,
        commercialMode: "provider",
        state: "search_redirect",
      },
    ],
  };
  const job = runtime.sessions.createSearchJob({
    request: {
      ...buildCostamarRequest(),
      providerId: "agil-local",
    },
    offers: [agilOffer],
    allOffers: [agilOffer],
    searchMeta: {
      ...buildSearchMeta(),
      providersUsed: ["agil-local"],
    },
    providerMeta: {
      ...buildProviderMeta(),
      exactProvider: "agil-local",
    },
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });
  const redirectPath = runtime.sessions.getSession(job.id)?.offers[0]?.purchasePaths[0]?.url;

  assert.ok(redirectPath);
  assert.equal(redirectPath.includes("open=local"), false);

  const response = await withLoopbackTrustForTests(() =>
    routeRequest(new Request(`http://127.0.0.1:32123${redirectPath}?open=local`, {
      headers: {
        "x-flydesk-client-loopback": "1",
      },
    }))
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), agilUrl);
  assert.doesNotMatch(await response.text(), /Abriendo proveedor|Abrir manualmente/);
});

test("costamar redirect blocks locally when no fresh token is available", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-costamar-redirect-blocked-"));
  const previousUserDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.COSTAMAR_CHROME_PROFILE;
  const previousWarmupEnabled = process.env.COSTAMAR_SESSION_WARMUP_ENABLED;
  process.env.COSTAMAR_CHROME_USER_DATA_DIR = tempRoot;
  process.env.COSTAMAR_CHROME_PROFILE = "Profile 99";
  process.env.COSTAMAR_SESSION_WARMUP_ENABLED = "0";
  resetCostamarSessionCacheForTests();
  resetCostamarWarmupStateForTests();

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
      assert.match(body, /Renueva la sesion de Click and Book Plus/i);
      assert.match(body, /redirect verificado/i);
    });
  } finally {
    resetCostamarWarmupStateForTests();
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

    if (previousWarmupEnabled === undefined) {
      delete process.env.COSTAMAR_SESSION_WARMUP_ENABLED;
    } else {
      process.env.COSTAMAR_SESSION_WARMUP_ENABLED = previousWarmupEnabled;
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



test("rejects one-way stay-range searches outside the rolling date window", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request: {
          tripType: "one-way",
          searchMode: "stay-range",
          legs: [
            {
              origin: "LIM",
              destination: "MAD",
              departureStart: "2027-03-01",
              departureEnd: "2027-04-01",
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
    assert.ok(payload.errors?.some((message) => message.includes("Departure end must be on or before 2027-03-31.")));
  });
});
test("rejects round-trip stays longer than 90 nights", async () => {
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
              departureDate: "2026-06-01",
              returnDate: "2026-09-01",
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
    assert.ok(payload.errors?.some((message) => message.includes("Stay length cannot exceed 90 nights.")));
  });
});

test("rejects flexible exact-stay searches longer than 90 nights", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/matrix`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sortMode: "cheapest",
        request: {
          tripType: "round-trip",
          searchMode: "roundtrip-grid",
          flexibleMode: "exact-stay",
          legs: [
            {
              origin: "LIM",
              destination: "MIA",
              departureStart: "2026-06-01",
              departureEnd: "2026-06-10",
              stayNights: 91,
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
    assert.ok(payload.errors?.some((message) => message.includes("Stay length cannot exceed 90 nights.")));
  });
});

test("rejects fixed-ranges matrix searches with too many combinations", async () => {
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
          flexibleMode: "fixed-ranges",
          legs: [
            {
              origin: "LIM",
              destination: "MIA",
              departureStart: "2026-06-01",
              departureEnd: "2026-12-31",
              returnStart: "2026-06-02",
              returnEnd: "2026-12-31",
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
    assert.ok(payload.errors?.some((message) => message.includes("Round-trip matrix search cannot exceed 5000 combinations.")));
  });
});

test("accepts extended one-way month scans for migratory search beyond the normal stay limit", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sortMode: "cheapest",
        request: {
          tripType: "one-way",
          searchMode: "stay-range",
          legs: [
            {
              origin: "LIM",
              destination: "MIA",
              departureStart: "2026-07-01",
              departureEnd: "2026-07-31",
            },
          ],
          passengers: {
            adults: 1,
            children: 0,
            infants: 0,
          },
          filters: {
            compactAllOffers: true,
          },
        },
      }),
    });

    assert.equal(response.status, 200);
  });
});

test("public search ignores provider override and keeps provider token out of the job response", async () => {
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
      searchMeta?: { providersUsed?: string[] };
      warnings?: string[];
    };

    assert.equal(payload.request?.providerId, undefined);
    assert.equal(payload.providerMeta?.exactProvider, "agil-local");
    assert.deepEqual(payload.searchMeta?.providersUsed, ["agil-local", "costamar"]);
    assert.equal(JSON.stringify(payload).includes("super-secret-token"), false);
  });
});

test("public search cannot disable either provider with a top-level providerId", async () => {
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
      searchMeta?: { providersUsed?: string[] };
    };
    assert.equal(payload.request?.providerId, undefined);
    assert.deepEqual(payload.searchMeta?.providersUsed, ["agil-local", "costamar"]);
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
      providerDiagnostics?: Array<{
        providerId?: string;
        kind?: string;
        status?: string;
        events?: Array<{ name?: string; detail?: string }>;
      }>;
    };

    assert.deepEqual(payload.searchMeta?.providersUsed, ["agil-local", "costamar"]);
    assert.deepEqual(
      payload.providerDiagnostics?.map((entry) => entry.providerId),
      ["agil-local", "costamar"],
    );
    assert.deepEqual(
      payload.providerDiagnostics?.map((entry) => entry.kind),
      ["exact", "exact"],
    );
    assert.deepEqual(
      payload.providerDiagnostics?.map((entry) => entry.status),
      ["queued", "queued"],
    );
    assert.equal(
      payload.providerDiagnostics?.every((entry) =>
        entry.events?.some((event) => event.name === "queued")
        && !entry.events?.some((event) => /token/i.test(event.detail ?? ""))
      ),
      true,
    );
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

test("public matrix cannot disable either provider with a top-level providerId", async () => {
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
      searchMeta?: { providersUsed?: string[] };
    };
    assert.equal(payload.request?.providerId, undefined);
    assert.deepEqual(payload.searchMeta?.providersUsed, ["agil-local", "costamar"]);
  });
});

test("public matrix ignores top-level providerId even when provider config is present", async () => {
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
            token: buildJwt({
              id: "0721808110",
              iat: 1893456000,
              exp: 1893459600,
            }),
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

    assert.equal(payload.request?.providerId, undefined);
    assert.equal(payload.cells?.[0]?.derivedRequest?.providerId, undefined);
    assert.deepEqual(payload.searchMeta?.providersUsed, ["agil-local", "costamar"]);
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
        providerConfig: {
          costamar: {
            terminalId: "0721808110",
            token: buildJwt({
              id: "0721808110",
              iat: 1893456000,
              exp: 1893459600,
            }),
          },
        },
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
        filters?: { exhaustiveResults?: boolean; maxResults?: number };
        legs?: Array<{ minNights?: number; maxNights?: number }>;
      };
      searchMeta?: { providersUsed?: string[] };
      searchStatus?: string;
    };

    assert.equal(payload.searchStatus, "running");
    assert.deepEqual(payload.searchMeta?.providersUsed, ["agil-local", "costamar"]);
    assert.equal(payload.request?.filters?.exhaustiveResults, true);
    assert.equal(payload.request?.filters?.maxResults, undefined);
    assert.equal(payload.request?.legs?.[0]?.minNights, undefined);
    assert.equal(payload.request?.legs?.[0]?.maxNights, undefined);
  });
});

test("exact searches preserve omitted maxResults in the public request", async () => {
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

test("search jobs can be cancelled before polling completes", async () => {
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
    const accepted = await response.json() as {
      searchJobId?: string;
      searchStatus?: string;
    };
    assert.equal(accepted.searchStatus, "running");
    assert.ok(accepted.searchJobId);

    const cancelResponse = await fetch(`${baseUrl}/api/search/${accepted.searchJobId}/cancel`, {
      method: "POST",
    });
    assert.equal(cancelResponse.status, 200);
    const cancelled = await cancelResponse.json() as {
      searchComplete?: boolean;
      searchStatus?: string;
      searchMeta?: { searchState?: string; warnings?: string[] };
      warnings?: string[];
    };
    assert.equal(cancelled.searchStatus, "cancelled");
    assert.equal(cancelled.searchComplete, true);
    assert.equal(cancelled.searchMeta?.searchState, "search_cancelled");
    assert.ok(cancelled.warnings?.includes("Search cancelled by user."));

    const pollResponse = await fetch(`${baseUrl}/api/search/${accepted.searchJobId}`);
    assert.equal(pollResponse.status, 200);
    const polled = await pollResponse.json() as {
      searchComplete?: boolean;
      searchStatus?: string;
    };
    assert.equal(polled.searchStatus, "cancelled");
    assert.equal(polled.searchComplete, true);
  });
});

test("search cancel from page refresh completes partial results so they remain cacheable", async () => {
  const runtime = getRuntime();
  const request = buildCostamarRequest();
  const token = buildJwt({
    id: "0721808110",
    iat: 1893456000,
    exp: 1893459600,
  });
  const providerContext = buildProviderContext("costamar", {
    costamar: {
      apiBaseUrl: "https://costamar.com.pe/vuelos/api",
      brandBaseUrl: "https://booking.clickandbook.com/vuelos",
      terminalId: "0721808110",
      token,
      lang: "es",
    },
  });
  const offer = buildCostamarOffer(
    `https://booking.clickandbook.com/vuelos/b/LIM/MAD/2026-06-01/2026-06-08/1/0/0?terminalId=0721808110&lang=es&token=${token}`,
  );
  const job = runtime.sessions.createSearchJob({
    request,
    providerContext,
    offers: [offer],
    allOffers: [offer],
    searchMeta: buildSearchMeta(),
    providerMeta: buildProviderMeta(),
    warnings: [],
    sortMode: "cheapest",
    status: "running",
  });

  await withServer(async (baseUrl) => {
    const cancelResponse = await fetch(`${baseUrl}/api/search/${job.id}/cancel?cachePartial=1`, {
      method: "POST",
    });
    assert.equal(cancelResponse.status, 200);
    const cancelled = await cancelResponse.json() as {
      searchComplete?: boolean;
      searchStatus?: string;
      searchMeta?: { searchState?: string; partial?: boolean; warnings?: string[] };
      warnings?: string[];
    };
    assert.equal(cancelled.searchStatus, "completed");
    assert.equal(cancelled.searchComplete, true);
    assert.equal(cancelled.searchMeta?.searchState, "search_partial");
    assert.equal(cancelled.searchMeta?.partial, true);
    assert.ok(cancelled.warnings?.includes("Search stopped because the page was refreshed."));

    const cached = runtime.sessions.findRecentCompletedSearchJob({
      request,
      providerContext,
      providerIds: ["costamar"],
      sortMode: "cheapest",
      maxAgeMs: 5 * 60 * 1000,
    });
    assert.equal(cached?.id, job.id);
    assert.equal(cached?.offers.length, 1);
  });
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
    providerId: undefined,
    legs: [
      {
        origin: "LIM",
        destination: "BCN",
        originLabel: "",
        destinationLabel: "",
        departureDate: "2026-06-04",
        departureStart: "",
        departureEnd: "",
        returnDate: "2026-06-18",
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
  const cachedOffer = {
    ...buildCostamarOffer(
      `https://booking.clickandbook.com/vuelos/b/LIM/BCN/2026-06-04/2026-06-18/1/0/0?terminalId=${terminalId}&lang=es&token=${seededToken}`,
    ),
    purchasePaths: [],
  };
  const cachedJob = runtime.sessions.createSearchJob({
    request,
    providerContext: buildProviderContext("costamar", {
      costamar: {
        terminalId,
        token: seededToken,
        lang: "es",
      },
    }),
    offers: [cachedOffer],
    allOffers: [cachedOffer],
    searchMeta: {
      ...buildSearchMeta(),
      providersUsed: ["agil-local", "costamar"],
    },
    providerMeta: buildProviderMeta(),
    warnings: ["Snapshot cache listo"],
    sortMode: "cheapest",
    status: "completed",
  });

  const mismatchedTokenCacheHit = runtime.sessions.findRecentCompletedSearchJob({
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
    providerIds: ["agil-local", "costamar"],
    sortMode: "cheapest",
    maxAgeMs: 5 * 60 * 1000,
  });
  assert.equal(mismatchedTokenCacheHit, undefined);

  const previewCacheHit = runtime.sessions.findRecentCompletedSearchJob({
    request,
    providerContext: buildProviderContext("costamar", {
      costamar: {
        apiBaseUrl: "https://costamar.com.pe/vuelos/api",
        brandBaseUrl: "https://booking.clickandbook.com/vuelos",
        terminalId,
        token: seededToken,
        lang: "es",
      },
    }),
    providerIds: ["agil-local", "costamar"],
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
            token: seededToken,
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
      offers?: Array<{ purchasePaths?: Array<{ provider?: string; type?: string; url?: string }> }>;
    };

    assert.equal(payload.searchStatus, "running");
    assert.equal(payload.searchComplete, false);
    assert.equal(payload.searchJobId === cachedJob.id, false);
    assert.equal(payload.searchMeta?.searchState, "search_cached");
    assert.equal(payload.searchMeta?.partial, true);
    assert.ok((payload.offers?.length ?? 0) > 0);
    const purchasePath = payload.offers?.[0]?.purchasePaths?.[0];
    assert.equal(purchasePath?.provider, "costamar");
    assert.equal(purchasePath?.type, "search-redirect");
    assert.match(purchasePath?.url ?? "", /^\/r\//);
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
    carrier: 172,
    dates: 318,
    duration: 126,
    stops: 184,
    price: 189,
    links: 50,
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
      assert.equal(savePayload.layout?.version, 2);
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

test("results layout endpoints reject reverse-proxied clients even when loopback proxy trust is enabled", { concurrency: false }, async () => {
  const previousTrustLoopback = process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
  const previousProxyTrust = process.env.FLY_DESK_TRUST_REVERSE_PROXY_LOOPBACK;

  process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = "1";
  process.env.FLY_DESK_TRUST_REVERSE_PROXY_LOOPBACK = "1";

  try {
    const getResponse = await routeRequest(new Request("https://fly-desk.local/api/results-layout", {
      method: "GET",
      headers: {
        "x-flydesk-client-loopback": "1",
        "x-forwarded-for": "203.0.113.40",
      },
    }));
    assert.equal(getResponse.status, 403);

    const postResponse = await routeRequest(new Request("https://fly-desk.local/api/results-layout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-flydesk-client-loopback": "1",
        "x-forwarded-for": "203.0.113.40",
      },
      body: JSON.stringify({
        columns: {
          carrier: 172,
          dates: 318,
          duration: 126,
          stops: 184,
          price: 189,
          links: 50,
        },
      }),
    }));
    assert.equal(postResponse.status, 403);
  } finally {
    if (previousTrustLoopback === undefined) {
      delete process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT;
    } else {
      process.env.FLY_DESK_TRUST_LOOPBACK_CLIENT = previousTrustLoopback;
    }

    if (previousProxyTrust === undefined) {
      delete process.env.FLY_DESK_TRUST_REVERSE_PROXY_LOOPBACK;
    } else {
      process.env.FLY_DESK_TRUST_REVERSE_PROXY_LOOPBACK = previousProxyTrust;
    }
  }
});

test("results layout endpoint migrates legacy column widths to the current result width", async () => {
  const layoutFile = join(process.cwd(), "config", "results-layout.json");
  const previousLayout = existsSync(layoutFile) ? readFileSync(layoutFile, "utf8") : null;

  try {
    mkdirSync(join(process.cwd(), "config"), { recursive: true });
    writeFileSync(layoutFile, JSON.stringify({
      version: 1,
      savedAt: "2026-05-19T23:11:00.000Z",
      columns: {
        carrier: 112,
        dates: 314,
        duration: 98,
        stops: 147,
        price: 124,
        links: 44,
      },
    }, null, 2));

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/results-layout`);
      assert.equal(response.status, 200);
      const payload = await response.json() as {
        layout?: {
          version?: number;
          savedAt?: string;
          columns?: Record<string, number>;
        } | null;
      };

      assert.equal(payload.layout?.version, 2);
      assert.equal(payload.layout?.savedAt, "2026-05-19T23:11:00.000Z");
      assert.deepEqual(payload.layout?.columns, {
        carrier: 139,
        dates: 389,
        duration: 121,
        stops: 182,
        price: 154,
        links: 54,
      });

      const migratedFile = JSON.parse(readFileSync(layoutFile, "utf8")) as {
        version?: number;
        columns?: Record<string, number>;
      };
      assert.equal(migratedFile.version, 2);
      assert.deepEqual(migratedFile.columns, payload.layout?.columns);
    });
  } finally {
    if (previousLayout === null) {
      rmSync(layoutFile, { force: true });
    } else {
      mkdirSync(join(process.cwd(), "config"), { recursive: true });
      writeFileSync(layoutFile, previousLayout);
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
      searchAdmission?: { capacityUnits?: number; activeUnits?: number; queuedCount?: number };
      sessions?: { counts?: { searchJobs?: number; purchasePaths?: number } };
      tempArtifacts?: { totals?: { count?: number } };
    };

    assert.equal(payload.ok, true);
    assert.equal(typeof payload.memoryUsage?.rss, "number");
    assert.equal(typeof payload.searchAdmission?.capacityUnits, "number");
    assert.equal(typeof payload.searchAdmission?.activeUnits, "number");
    assert.equal(typeof payload.searchAdmission?.queuedCount, "number");
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
