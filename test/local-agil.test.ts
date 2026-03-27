import test from "node:test";
import assert from "node:assert/strict";
import {
  AGIL_CONCURRENCY,
  buildLocalAgilSearchRedirectUrl,
  parseAgilRefreshTokenPayload,
  parseAgilSessionData,
  readAgilStorageSnapshotFromPage,
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

test("keeps flexible Agil searches at a minimum of ten concurrent requests", () => {
  assert.equal(AGIL_CONCURRENCY.flexibleMinimum, 10);
  assert.ok(AGIL_CONCURRENCY.rangeSearch >= 10);
  assert.ok(AGIL_CONCURRENCY.matrixCell >= 10);
});
