import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGIL_CONCURRENCY,
  buildLocalAgilSearchRedirectUrl,
  computeAgilTotalAmountForTests,
  createLocalAgilMatrixDraft,
  extractAgilChromeDebugPortsFromCommandLinesForTests,
  extractAgilChromeUserDataDirsFromCommandLinesForTests,
  extractAgilBrowserStorageSnapshotForTests,
  parseAgilApimSubscriptionKeyFromFrontendBundle,
  parseAgilRefreshTokenPayload,
  parseAgilSessionData,
  readAgilChromeProfileCandidatesForTests,
  readAgilStorageSnapshotFromPage,
  resetAgilSessionCacheForTests,
  resolveLocalAgilMatrixProgressive,
  resolveAgilChromeDevToolsBrowserWsEndpointForTests,
  sameAgilSessionIdentity,
  resetAgilApimSubscriptionKeyCacheForTests,
  setAgilSessionForTests,
  searchLocalAgilExact,
  shouldReuseAgilSession,
  suggestLocalAgilLocations,
  extractAgilUsdToPenRate,
} from "../src/local-agil";
import type { SearchRequest } from "../src/core/types";

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

test("Agil profile discovery tries the configured Chrome profile before automatic profiles", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-agil-profiles-"));
  mkdirSync(join(tempRoot, "Profile 10"), { recursive: true });
  mkdirSync(join(tempRoot, "Profile 40"), { recursive: true });
  writeFileSync(
    join(tempRoot, "Local State"),
    JSON.stringify({
      profile: {
        last_used: "Profile 10",
        last_active_profiles: ["Profile 10"],
        info_cache: {
          "Profile 10": {},
          "Profile 40": {},
        },
      },
    }),
    "utf8",
  );

  const previousUserDataDir = process.env.AGIL_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.AGIL_CHROME_PROFILE;
  process.env.AGIL_CHROME_USER_DATA_DIR = tempRoot;
  process.env.AGIL_CHROME_PROFILE = "Profile 40";

  try {
    assert.deepEqual(readAgilChromeProfileCandidatesForTests().slice(0, 2), [
      "Profile 40",
      "Profile 10",
    ]);
  } finally {
    if (previousUserDataDir === undefined) {
      delete process.env.AGIL_CHROME_USER_DATA_DIR;
    } else {
      process.env.AGIL_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.AGIL_CHROME_PROFILE;
    } else {
      process.env.AGIL_CHROME_PROFILE = previousProfile;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Agil user data discovery reads active Chrome process profile roots", () => {
  assert.deepEqual(extractAgilChromeUserDataDirsFromCommandLinesForTests([
    '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir=D:\\ChromeRuns\\live-profile --new-window about:blank',
    '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir="D:\\Chrome Runs\\profile with spaces" --profile-directory=Default',
    '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=renderer --lang=es-419',
  ]), [
    "D:\\ChromeRuns\\live-profile",
    "D:\\Chrome Runs\\profile with spaces",
  ]);
});

test("Agil DevTools discovery reads active Chrome remote debugging ports", () => {
  assert.deepEqual(extractAgilChromeDebugPortsFromCommandLinesForTests([
    '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir=D:\\ChromeRuns\\live-profile',
    '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=renderer --remote-debugging-port=9222 --user-data-dir=D:\\ChromeRuns\\live-profile',
    '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=not-a-port --user-data-dir=D:\\ChromeRuns\\bad',
  ]), [9222]);
});

test("Agil can resolve an active Chrome DevTools browser endpoint from a user data dir", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-agil-devtools-"));
  writeFileSync(join(tempRoot, "DevToolsActivePort"), "9222\n/devtools/browser/session-id\n", "utf8");

  try {
    assert.equal(
      resolveAgilChromeDevToolsBrowserWsEndpointForTests(tempRoot),
      "ws://127.0.0.1:9222/devtools/browser/session-id",
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Agil session extraction prefers fresher Chrome storage over a stale configured profile", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "flydesk-agil-storage-freshness-"));
  const staleProfile = "Profile 40";
  const freshProfile = "Profile 41";

  const writeAgilStorage = (
    profileName: string,
    userCode: number,
    internalCode: string,
    ip: string,
    mtime: Date,
    token = "",
  ) => {
    const storageDir = join(tempRoot, profileName, "Local Storage", "leveldb");
    mkdirSync(storageDir, { recursive: true });
    const userPayload = Buffer.from(JSON.stringify({
      Usuario: {
        CodigoUsuario: userCode,
      },
      Cliente: {
        Vendedor: {
          CodigoVendedor: internalCode,
        },
      },
    })).toString("base64");
    const ipPayload = Buffer.from(ip).toString("base64");
    const filePath = join(storageDir, "000001.log");
    writeFileSync(filePath, `tokenTravelC ${token} user_data ${userPayload} ip ${ipPayload}`, "utf8");
    utimesSync(filePath, mtime, mtime);
  };

  writeFileSync(
    join(tempRoot, "Local State"),
    JSON.stringify({
      profile: {
        last_used: staleProfile,
        last_active_profiles: [staleProfile, freshProfile],
        info_cache: {
          [staleProfile]: {},
          [freshProfile]: {},
        },
      },
    }),
    "utf8",
  );

  const tokenPayload = Buffer.from(JSON.stringify({ exp: 1893459600 })).toString("base64url");
  const freshToken = `header.${tokenPayload}.signature`;
  writeAgilStorage(staleProfile, 1111, "STALE", "1.1.1.1", new Date("2026-01-01T00:00:00Z"));
  writeAgilStorage(freshProfile, 2222, "FRESH", "2.2.2.2", new Date("2026-02-01T00:00:00Z"), freshToken);

  const previousUserDataDir = process.env.AGIL_CHROME_USER_DATA_DIR;
  const previousProfile = process.env.AGIL_CHROME_PROFILE;
  const previousBrowserUrl = process.env.AGIL_BROWSER_URL;
  const previousBrowserWsEndpoint = process.env.AGIL_BROWSER_WS_ENDPOINT;
  const previousProcessDiscovery = process.env.AGIL_CHROME_PROCESS_DISCOVERY;
  process.env.AGIL_CHROME_USER_DATA_DIR = tempRoot;
  process.env.AGIL_CHROME_PROFILE = staleProfile;
  process.env.AGIL_CHROME_PROCESS_DISCOVERY = "0";
  delete process.env.AGIL_BROWSER_URL;
  delete process.env.AGIL_BROWSER_WS_ENDPOINT;

  try {
    const snapshot = await extractAgilBrowserStorageSnapshotForTests();
    const session = parseAgilSessionData(snapshot);

    assert.equal(session.userCode, 2222);
    assert.equal(session.internalCode, "FRESH");
    assert.equal(session.ip, "2.2.2.2");
    assert.equal(session.token, freshToken);
  } finally {
    if (previousUserDataDir === undefined) {
      delete process.env.AGIL_CHROME_USER_DATA_DIR;
    } else {
      process.env.AGIL_CHROME_USER_DATA_DIR = previousUserDataDir;
    }

    if (previousProfile === undefined) {
      delete process.env.AGIL_CHROME_PROFILE;
    } else {
      process.env.AGIL_CHROME_PROFILE = previousProfile;
    }

    if (previousBrowserUrl === undefined) {
      delete process.env.AGIL_BROWSER_URL;
    } else {
      process.env.AGIL_BROWSER_URL = previousBrowserUrl;
    }

    if (previousBrowserWsEndpoint === undefined) {
      delete process.env.AGIL_BROWSER_WS_ENDPOINT;
    } else {
      process.env.AGIL_BROWSER_WS_ENDPOINT = previousBrowserWsEndpoint;
    }

    if (previousProcessDiscovery === undefined) {
      delete process.env.AGIL_CHROME_PROCESS_DISCOVERY;
    } else {
      process.env.AGIL_CHROME_PROCESS_DISCOVERY = previousProcessDiscovery;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
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

test("Agil pricing prefers the provider total when fare breakdowns disagree", () => {
  const amount = computeAgilTotalAmountForTests({
    totalFare: "521.22",
    itinTotalFare: {
      fareBreakDowns: [
        {
          passengerType: { quantity: 1 },
          passengerFare: {
            totalFare: "510.22",
            feeNMV: "0",
            feePTA: "0",
            dsctoTaxes: "0",
          },
        },
      ],
    },
  });

  assert.equal(amount, 521.22);
});

test("Agil pricing does not add provider fee fields on top of fare breakdown totals", () => {
  const amount = computeAgilTotalAmountForTests({
    itinTotalFare: {
      fareBreakDowns: [
        {
          passengerType: { quantity: 2 },
          passengerFare: {
            totalFare: "USD 1,001.16",
            feeNMV: "11.80",
            feePTA: "0",
            dsctoTaxes: "0",
          },
        },
      ],
    },
  });

  assert.equal(amount, 2002.32);
});

test("Agil exchange rate parsing preserves four decimal rates", () => {
  const rate = extractAgilUsdToPenRate({
    tipoCambio: {
      code: "USD",
      rate: "3.7531",
    },
  } as never);

  assert.equal(rate, 3.7531);
});

function buildAgilExactRequest(tripType: "one-way" | "round-trip"): SearchRequest {
  return {
    tripType,
    searchMode: "exact",
    legs: [
      {
        origin: "LIM",
        destination: "MAD",
        departureDate: "2026-05-21",
        ...(tripType === "round-trip" ? { returnDate: "2026-05-28" } : {}),
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

function buildAgilCandidate(
  segmentId: number,
  origin: string,
  destination: string,
  departureDateTime: string,
  arrivalDateTime: string,
  flightNumber: number,
) {
  return {
    segmentId,
    startDateTime: departureDateTime,
    endDateTime: arrivalDateTime,
    stops: 0,
    flightDuration: "0200",
    flightSegments: [
      {
        flightNumber,
        departureDateTime,
        arrivalDateTime,
        elapsedTime: "0200",
        seatsRemaining: 4,
        departureAirport: { code: origin, name: origin },
        arrivalAirport: { code: destination, name: destination },
        marketingAirline: { code: "UX", name: "Air Europa" },
        operatingAirline: { code: "UX", name: "Air Europa" },
      },
    ],
  };
}

function buildAgilOptionsGroup(returnSegments = true) {
  return {
    id: returnSegments ? "agil-options" : "agil-one-way-options",
    display: true,
    airline: { code: "UX", name: "Air Europa" },
    departure: [
      {
        segments: [
          buildAgilCandidate(10, "LIM", "MAD", "2026-05-21T08:00:00", "2026-05-21T16:00:00", 100),
          buildAgilCandidate(12, "LIM", "MAD", "2026-05-21T10:00:00", "2026-05-21T18:00:00", 102),
        ],
      },
    ],
    ...(returnSegments
      ? {
        returns: [
          {
            segments: [
              buildAgilCandidate(11, "MAD", "LIM", "2026-05-28T09:00:00", "2026-05-28T15:00:00", 101),
              buildAgilCandidate(13, "MAD", "LIM", "2026-05-28T11:00:00", "2026-05-28T17:00:00", 103),
            ],
          },
        ],
      }
      : {}),
    pricingInfo: {
      totalFare: 950,
      itinTotalFare: {
        validatingCarrier: "UX",
        fareBreakDowns: [
          {
            passengerType: { quantity: 1 },
            passengerFare: {
              baseFare: 700,
              taxes: 250,
              totalFare: 950,
              feeNMV: 0,
              feePTA: 0,
              dsctoTaxes: 0,
            },
          },
        ],
      },
      tipoCambio: {
        code: "USD",
        rate: 3.7531,
      },
    },
  };
}

function applyAgilBaggageToGroup(group: unknown, equipaje: Record<string, unknown>): void {
  const record = group as Record<string, unknown>;
  const journeyGroups = [record.departure, record.returns];

  journeyGroups.forEach((journeyGroup) => {
    const slices = Array.isArray(journeyGroup) ? journeyGroup : journeyGroup ? [journeyGroup] : [];
    slices.forEach((slice) => {
      const segments = Array.isArray((slice as { segments?: unknown }).segments)
        ? (slice as { segments: Array<Record<string, unknown>> }).segments
        : [];
      segments.forEach((segment) => {
        segment.equipaje = equipaje;
      });
    });
  });
}

async function withMockedAgilExactSearch<T>(group: unknown, run: () => Promise<T>): Promise<T> {
  const previousFetch = global.fetch;
  const previousKey = process.env.AGIL_APIM_SUBSCRIPTION_KEY;

  resetAgilSessionCacheForTests();
  resetAgilApimSubscriptionKeyCacheForTests();
  process.env.AGIL_APIM_SUBSCRIPTION_KEY = "test-subscription-key";
  setAgilSessionForTests();
  global.fetch = (async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Ocp-Apim-Subscription-Key"), "test-subscription-key");

    if (url === "https://motorvuelos.expertiatravel.com/mv/start-search") {
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === "https://motorvuelos.expertiatravel.com/mv/search") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { gds?: number };
      return new Response(JSON.stringify({
        groups: body.gds === 0 ? [group] : [],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    return await run();
  } finally {
    global.fetch = previousFetch;
    resetAgilSessionCacheForTests();
    resetAgilApimSubscriptionKeyCacheForTests();
    if (previousKey === undefined) {
      delete process.env.AGIL_APIM_SUBSCRIPTION_KEY;
    } else {
      process.env.AGIL_APIM_SUBSCRIPTION_KEY = previousKey;
    }
  }
}

test("Agil exact search expands candidate combinations inside a group", async () => {
  const scenarios = [
    {
      name: "round-trip",
      request: buildAgilExactRequest("round-trip"),
      group: buildAgilOptionsGroup(true),
      expected: [
        ["100", "101"],
        ["100", "103"],
        ["102", "101"],
        ["102", "103"],
      ],
    },
    {
      name: "one-way",
      request: buildAgilExactRequest("one-way"),
      group: buildAgilOptionsGroup(false),
      expected: [
        ["100"],
        ["102"],
      ],
    },
  ];

  for (const scenario of scenarios) {
    await withMockedAgilExactSearch(scenario.group, async () => {
      const result = await searchLocalAgilExact(scenario.request);
      const flightNumbers = result.offers
        .map((offer) => offer.itineraries.map((itinerary) => itinerary.segments[0]?.flightNumber))
        .sort();

      assert.equal(result.offers.length, scenario.expected.length, scenario.name);
      assert.deepEqual(flightNumbers, scenario.expected, scenario.name);
    });
  }
});

test("Agil exact search treats zero pieces without cabina as no included baggage", async () => {
  const group = buildAgilOptionsGroup(true);
  applyAgilBaggageToGroup(group, { piezas: 0 });

  await withMockedAgilExactSearch(group, async () => {
    const result = await searchLocalAgilExact(buildAgilExactRequest("round-trip"));

    assert.ok(result.offers.length > 0);
    result.offers.forEach((offer) => {
      assert.equal(offer.baggage?.carryOnIncluded, false);
      assert.equal(offer.baggage?.checkedIncluded, false);
      assert.equal(offer.baggage?.description, "Sin equipaje incluido");
    });
  });
});

test("Agil exact search treats positive cabina pieces as carry-on included", async () => {
  const group = buildAgilOptionsGroup(true);
  applyAgilBaggageToGroup(group, {
    piezas: 0,
    cabina: {
      piezas: 1,
      descripcion1: "Equipaje de mano",
    },
  });

  await withMockedAgilExactSearch(group, async () => {
    const result = await searchLocalAgilExact(buildAgilExactRequest("round-trip"));

    assert.ok(result.offers.length > 0);
    result.offers.forEach((offer) => {
      assert.equal(offer.baggage?.carryOnIncluded, true);
      assert.equal(offer.baggage?.checkedIncluded, false);
      assert.equal(offer.baggage?.description, "Equipaje de mano incluido");
    });
  });
});

test("Agil matrix cells include the canonical offer schedules", async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.AGIL_APIM_SUBSCRIPTION_KEY;
  const request: SearchRequest = {
    tripType: "round-trip",
    searchMode: "roundtrip-grid",
    flexibleMode: "exact-stay",
    legs: [
      {
        origin: "LIM",
        destination: "CUZ",
        departureStart: "2026-10-16",
        departureEnd: "2026-10-16",
        stayNights: 3,
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
  const agilGroup = {
    id: "agil-lim-cuz-10341",
    display: true,
    airline: {
      code: "JA",
      name: "JetSMART",
    },
    departure: [
      {
        segments: [
          {
            segmentId: 10,
            startDateTime: "2026-10-16T06:15:00",
            endDateTime: "2026-10-16T07:35:00",
            stops: 0,
            flightDuration: "01:20",
            equipaje: {
              piezas: 0,
              cabina: {
                piezas: 1,
                descripcion1: "Equipaje de mano",
              },
            },
            flightSegments: [
              {
                flightNumber: 123,
                departureDateTime: "2026-10-16T06:15:00",
                arrivalDateTime: "2026-10-16T07:35:00",
                elapsedTime: "01:20",
                seatsRemaining: 4,
                departureAirport: {
                  code: "LIM",
                  name: "Lima",
                },
                arrivalAirport: {
                  code: "CUZ",
                  name: "Cusco",
                },
                marketingAirline: {
                  code: "JA",
                  name: "JetSMART",
                },
                operatingAirline: {
                  code: "JA",
                  name: "JetSMART",
                },
              },
            ],
          },
        ],
      },
    ],
    returns: {
      segments: [
        {
          segmentId: 20,
          startDateTime: "2026-10-19T18:10:00",
          endDateTime: "2026-10-19T19:35:00",
          stops: 0,
          flightDuration: "01:25",
          equipaje: {
            piezas: 0,
            cabina: {
              piezas: 1,
              descripcion1: "Equipaje de mano",
            },
          },
          flightSegments: [
            {
              flightNumber: 124,
              departureDateTime: "2026-10-19T18:10:00",
              arrivalDateTime: "2026-10-19T19:35:00",
              elapsedTime: "01:25",
              seatsRemaining: 3,
              departureAirport: {
                code: "CUZ",
                name: "Cusco",
              },
              arrivalAirport: {
                code: "LIM",
                name: "Lima",
              },
              marketingAirline: {
                code: "JA",
                name: "JetSMART",
              },
              operatingAirline: {
                code: "JA",
                name: "JetSMART",
              },
            },
          ],
        },
      ],
    },
    pricingInfo: {
      totalFare: 103.41,
      itinTotalFare: {
        validatingCarrier: "JA",
        fareBreakDowns: [
          {
            passengerType: {
              quantity: 1,
            },
            passengerFare: {
              baseFare: 75,
              taxes: 28.41,
              totalFare: 103.41,
              feeNMV: 0,
              feePTA: 0,
              dsctoTaxes: 0,
            },
          },
        ],
      },
      tipoCambio: {
        code: "USD",
        rate: 3.7531,
      },
    },
  };

  resetAgilSessionCacheForTests();
  resetAgilApimSubscriptionKeyCacheForTests();
  process.env.AGIL_APIM_SUBSCRIPTION_KEY = "test-subscription-key";
  setAgilSessionForTests();
  global.fetch = (async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Ocp-Apim-Subscription-Key"), "test-subscription-key");

    if (url === "https://motorvuelos.expertiatravel.com/mv/start-search") {
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === "https://motorvuelos.expertiatravel.com/mv/search") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { gds?: number };
      return new Response(JSON.stringify({
        groups: body.gds === 0 ? [agilGroup] : [],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    const draft = createLocalAgilMatrixDraft(request, {
      exactProvider: "agil-local",
      coverageMode: "core",
    });
    const result = await resolveLocalAgilMatrixProgressive(request, draft);
    const cell = result.cells[0];
    const offer = cell?.offer;

    assert.equal(cell?.providerSource, "agil-local");
    assert.equal(cell?.price?.amount, 103.41);
    assert.equal(cell?.price?.currencyCode, "USD");
    assert.equal(offer?.providerSource, "agil-local");
    assert.equal(offer?.price.total.amount, 103.41);
    assert.equal(offer?.itineraries.length, 2);
    assert.equal(offer?.itineraries[0]?.segments[0]?.departureAt, "2026-10-16T06:15:00");
    assert.equal(offer?.itineraries[0]?.segments[0]?.arrivalAt, "2026-10-16T07:35:00");
    assert.equal(offer?.itineraries[1]?.segments[0]?.departureAt, "2026-10-19T18:10:00");
    assert.equal(offer?.itineraries[1]?.segments[0]?.arrivalAt, "2026-10-19T19:35:00");
  } finally {
    global.fetch = previousFetch;
    resetAgilSessionCacheForTests();
    resetAgilApimSubscriptionKeyCacheForTests();
    if (previousKey === undefined) {
      delete process.env.AGIL_APIM_SUBSCRIPTION_KEY;
    } else {
      process.env.AGIL_APIM_SUBSCRIPTION_KEY = previousKey;
    }
  }
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
