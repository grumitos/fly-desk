import test from "node:test";
import assert from "node:assert/strict";
import {
  AGIL_CONCURRENCY,
  buildLocalAgilSearchRedirectUrl,
  parseAgilApimSubscriptionKeyFromFrontendBundle,
  parseAgilRefreshTokenPayload,
  parseAgilSessionData,
  readAgilStorageSnapshotFromPage,
  sameAgilSessionIdentity,
  resetAgilApimSubscriptionKeyCacheForTests,
  shouldReuseAgilSession,
  suggestLocalAgilLocations,
} from "../src/local-agil";

test("reads Agil session storage after DOM content is ready without waiting for network idle", async () => {
  const calls: Array<{ kind: string; args: unknown[] }> = [];
  const page = {
    async goto(url: string, options: Record<string, unknown>) {
      calls.push({ kind: "goto", args: [url, options] });
    },
    async waitForFunction(fn: unknown, options: Record<string, unknown>) {
      calls.push({ kind: "waitForFunction", args: [fn, options] });
    },
    async evaluate() {
      calls.push({ kind: "evaluate", args: [] });
      return {
        tokenSearchFlight: "",
        userData: "user",
        ip: "ip",
      };
    },
  };

  const snapshot = await readAgilStorageSnapshotFromPage(page as never);

  assert.deepEqual(snapshot, {
    tokenSearchFlight: "",
    userData: "user",
    ip: "ip",
  });

  assert.deepEqual(calls[0], {
    kind: "goto",
    args: [
      "https://www.agilsmart.com/home-user",
      {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      },
    ],
  });
  assert.equal(calls[1]?.kind, "waitForFunction");
  assert.equal(calls[2]?.kind, "evaluate");
});

test("can derive a refreshable Agil session without tokenSearchFlight", () => {
  const userPayload = Buffer.from(JSON.stringify({
    Usuario: {
      CodigoUsuario: 1234,
    },
    Cliente: {
      Vendedor: {
        CodigoVendedor: "ABCD",
      },
    },
  })).toString("base64");
  const ipPayload = Buffer.from("1.2.3.4").toString("base64");

  const session = parseAgilSessionData({
    tokenSearchFlight: "",
    userData: userPayload,
    ip: ipPayload,
  });

  assert.equal(session.token, "");
  assert.equal(session.expiresAtMs, 0);
  assert.equal(session.userCode, 1234);
  assert.equal(session.internalCode, "ABCD");
  assert.equal(session.ip, "1.2.3.4");
  assert.equal(typeof session.capturedAtMs, "number");
});

test("Agil session cache forces a browser revalidation after a short interval", () => {
  const now = 1_710_000_000_000;

  assert.equal(shouldReuseAgilSession({
    expiresAtMs: now + (10 * 60 * 1000),
    capturedAtMs: now - 30_000,
  }, now), true);

  assert.equal(shouldReuseAgilSession({
    expiresAtMs: now + (10 * 60 * 1000),
    capturedAtMs: now - 120_000,
  }, now), false);
});

test("Agil session identity changes when the browser switches account or seller", () => {
  assert.equal(sameAgilSessionIdentity({
    userCode: 1234,
    internalCode: "ABCD",
    ip: "1.2.3.4",
  }, {
    userCode: 1234,
    internalCode: "ABCD",
    ip: "1.2.3.4",
  }), true);

  assert.equal(sameAgilSessionIdentity({
    userCode: 1234,
    internalCode: "ABCD",
    ip: "1.2.3.4",
  }, {
    userCode: 5678,
    internalCode: "WXYZ",
    ip: "1.2.3.4",
  }), false);
});

test("falls back to the motorvuelos origin when tokenSearchFlight is missing on agilsmart", async () => {
  const snapshots = [
    {
      tokenSearchFlight: "",
      userData: "user",
      ip: "ip",
    },
    {
      tokenSearchFlight: "token-from-motorvuelos",
      userData: "",
      ip: "",
    },
  ];
  const visitedUrls: string[] = [];
  const page = {
    async goto(url: string) {
      visitedUrls.push(url);
    },
    async waitForFunction() {
      return undefined;
    },
    async evaluate() {
      return snapshots.shift();
    },
  };

  const snapshot = await readAgilStorageSnapshotFromPage(page as never);

  assert.deepEqual(visitedUrls, [
    "https://www.agilsmart.com/home-user",
    "https://motorvuelos.expertiatravel.com/",
  ]);
  assert.equal(snapshot.tokenSearchFlight, "token-from-motorvuelos");
  assert.equal(snapshot.userData, "user");
  assert.equal(snapshot.ip, "ip");
});

test("continues to motorvuelos when agilsmart navigation fails", async () => {
  let evaluations = 0;
  const visitedUrls: string[] = [];
  const page = {
    async goto(url: string) {
      visitedUrls.push(url);
      if (url.includes("agilsmart.com")) {
        throw new Error("DNS failure");
      }
    },
    async waitForFunction() {
      return undefined;
    },
    async evaluate() {
      evaluations += 1;
      return {
        tokenSearchFlight: "token-from-motorvuelos",
        userData: "user",
        ip: "ip",
      };
    },
  };

  const snapshot = await readAgilStorageSnapshotFromPage(page as never);

  assert.deepEqual(visitedUrls, [
    "https://www.agilsmart.com/home-user",
    "https://motorvuelos.expertiatravel.com/",
  ]);
  assert.equal(evaluations, 1);
  assert.equal(snapshot.tokenSearchFlight, "token-from-motorvuelos");
  assert.equal(snapshot.userData, "user");
  assert.equal(snapshot.ip, "ip");
});

test("accepts accessToken from the Agil refresh payload", () => {
  const token = "header.payload.signature";

  assert.equal(
    parseAgilRefreshTokenPayload({
      accessToken: token,
      expiresIn: 86400,
    }),
    token,
  );
});

test("builds Agil redirect URLs with human-readable origin and destination labels when present", () => {
  const url = buildLocalAgilSearchRedirectUrl({
    tripType: "round-trip",
    searchMode: "exact",
    legs: [
      {
        origin: "LIM",
        destination: "MIA",
        originLabel: "LIM - Lima, Peru",
        destinationLabel: "MIA - Miami, Usa",
        departureDate: "2026-04-15",
        returnDate: "2026-04-22",
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
  });

  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("departureLocation"), "LIM Lima, Peru");
  assert.equal(parsed.searchParams.get("arrivalLocation"), "MIA Miami, Usa");
  assert.equal(parsed.searchParams.get("departureDate"), "15/04/2026");
  assert.equal(parsed.searchParams.get("arrivalDate"), "22/04/2026");
});

test("keeps Agil range searches lighter than matrix fan-out by default", () => {
  assert.equal(AGIL_CONCURRENCY.matrixMinimum, 4);
  assert.equal(AGIL_CONCURRENCY.rangeMinimum, 2);
  assert.ok(AGIL_CONCURRENCY.matrixCell >= AGIL_CONCURRENCY.matrixMinimum);
  assert.ok(AGIL_CONCURRENCY.rangeSearch >= AGIL_CONCURRENCY.rangeMinimum);
  assert.ok(AGIL_CONCURRENCY.rangeSearch < AGIL_CONCURRENCY.matrixCell);
  assert.ok(AGIL_CONCURRENCY.gdsSearch >= 1);
});

test("extracts the Agil subscription key from the public frontend bundle", () => {
  const key = parseAgilApimSubscriptionKeyFromFrontendBundle(
    'const env={urlHeaderMotor:"e9c66b5e1b4348ae9de63ff98d66cbbe"};',
  );

  assert.equal(key, "e9c66b5e1b4348ae9de63ff98d66cbbe");
});

test("recovers AGIL_APIM_SUBSCRIPTION_KEY from the Agil frontend bundle when env is missing", async () => {
  const previousKey = process.env.AGIL_APIM_SUBSCRIPTION_KEY;
  const previousFetch = global.fetch;
  const calls: string[] = [];

  resetAgilApimSubscriptionKeyCacheForTests();
  delete process.env.AGIL_APIM_SUBSCRIPTION_KEY;
  global.fetch = (async (input, init) => {
    const url = String(input);
    calls.push(url);

    if (url === "https://www.agilsmart.com/home-user") {
      return new Response(
        '<html><head><script src="/runtime.js"></script><script src="/main.js"></script></head></html>',
        { status: 200, headers: { "Content-Type": "text/html" } },
      );
    }

    if (url === "https://www.agilsmart.com/main.js") {
      return new Response(
        'const env={urlHeaderMotor:"dynamic-subscription-key-123456"};',
        { status: 200, headers: { "Content-Type": "application/javascript" } },
      );
    }

    if (url === "https://motorvuelos.expertiatravel.com/mv/ubigeo/geotree/Lima") {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Ocp-Apim-Subscription-Key"), "dynamic-subscription-key-123456");
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    const suggestions = await suggestLocalAgilLocations("Lima");
    assert.deepEqual(suggestions, []);
    assert.deepEqual(calls, [
      "https://www.agilsmart.com/home-user",
      "https://www.agilsmart.com/main.js",
      "https://motorvuelos.expertiatravel.com/mv/ubigeo/geotree/Lima",
    ]);
  } finally {
    resetAgilApimSubscriptionKeyCacheForTests();
    global.fetch = previousFetch;
    if (previousKey === undefined) {
      delete process.env.AGIL_APIM_SUBSCRIPTION_KEY;
    } else {
      process.env.AGIL_APIM_SUBSCRIPTION_KEY = previousKey;
    }
  }
});

test("fails clearly when neither env nor the Agil frontend expose the subscription key", async () => {
  const previousKey = process.env.AGIL_APIM_SUBSCRIPTION_KEY;
  const previousFetch = global.fetch;
  let apiFetchCalled = false;

  resetAgilApimSubscriptionKeyCacheForTests();
  delete process.env.AGIL_APIM_SUBSCRIPTION_KEY;
  global.fetch = (async (input) => {
    const url = String(input);
    if (url === "https://www.agilsmart.com/home-user") {
      return new Response(
        '<html><head><script src="/main.js"></script></head></html>',
        { status: 200, headers: { "Content-Type": "text/html" } },
      );
    }

    if (url === "https://www.agilsmart.com/main.js") {
      return new Response(
        "const env={urlApiMotorVuelos:\"https://motorvuelos.expertiatravel.com\"};",
        { status: 200, headers: { "Content-Type": "application/javascript" } },
      );
    }

    if (url === "https://motorvuelos.expertiatravel.com/mv/ubigeo/geotree/Lima") {
      apiFetchCalled = true;
      throw new Error("API fetch should not run without a subscription key");
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => suggestLocalAgilLocations("Lima"),
      /AGIL_APIM_SUBSCRIPTION_KEY is required for live Agil requests and could not be recovered from the Agil frontend\./,
    );
    assert.equal(apiFetchCalled, false);
  } finally {
    resetAgilApimSubscriptionKeyCacheForTests();
    global.fetch = previousFetch;
    if (previousKey === undefined) {
      delete process.env.AGIL_APIM_SUBSCRIPTION_KEY;
    } else {
      process.env.AGIL_APIM_SUBSCRIPTION_KEY = previousKey;
    }
  }
});
