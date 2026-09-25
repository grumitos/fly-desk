/*
 * Proves the E2E foundation end to end, over HTTP only:
 *
 *   node --experimental-strip-types test/e2e/support/prove-stack.ts [--cbplus-delay=4000] [--today=YYYY-MM-DD] [--keep] [--verbose]
 *
 * (Node 22.18+ strips types without the flag.) Exit code 0 means every claim held.
 */
import assert from "node:assert/strict";
import type { CanonicalOffer, LocationSuggestion, ProviderId } from "../../../src/core/types.ts";
import {
  followMatrixJob,
  followSearchJob,
  matrixOffers,
  openPurchasePath,
  searchOffers,
  signIn,
  type ApiSession,
  type JobRevision,
  type MatrixJob,
  type SearchJob,
} from "./api-client.ts";
import { startFakeUpstream, type FakeOp, type FakeUpstream, type RecordedRequest } from "./fake-upstream.ts";
import { FAKE_CBPLUS_TERMINAL_ID, type OfferSpec } from "./fixtures.ts";
import { startStack, type Stack } from "./stack.ts";

const options = new Map(process.argv.slice(2).map((arg) => {
  const [key = "", value = "1"] = arg.replace(/^--/, "").split("=");
  return [key, value] as const;
}));
const cbplusDelayMs = Number(options.get("cbplus-delay") ?? 0);

function localIsoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDays(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const today = options.get("today") ?? localIsoDate(new Date());
const day = (offset: number) => addDays(today, offset);
const PROVIDER_SEARCH_OPS: readonly FakeOp[] = ["agil.token", "agil.startSearch", "agil.search", "cbplus.engine", "cbplus.search"];
/* Only a fallback path calls these: Agil bundle scraping, B2B automation, Chrome discovery. */
const FALLBACK_OPS: readonly FakeOp[] = ["agil.web", "cbplus.b2b", "cbplus.markup", "cdp", "unknown"];

const LIM_CUZ_CBPLUS: OfferSpec[] = [
  { outbound: ["LA2047 LIM-CUZ 07:15-08:40"], inbound: ["LA2048 CUZ-LIM 16:00-17:25"], price: 151.3, baggage: { carryOn: true, checked: 1 }, brand: "Plus" },
  { outbound: ["H2 5104 LIM-CUZ 12:05-13:30"], inbound: ["H2 5105 CUZ-LIM 18:20-19:45"], price: 124.9, baggage: { carryOn: true, checked: 0 }, brand: "Light" },
];

function installScenario(fake: FakeUpstream): void {
  fake.setFlights("agil", { origin: "LIM", destination: "CUZ" }, [
    { outbound: ["LA2045 LIM-CUZ 05:40-07:05"], inbound: ["LA2046 CUZ-LIM 08:10-09:35"], price: 142.8, baggage: { carryOn: true, checked: 0 }, seats: 7 },
    { outbound: ["H2 5102 LIM-CUZ 06:25-07:50"], inbound: ["H2 5103 CUZ-LIM 09:15-10:40"], price: 118.4, baggage: { carryOn: true, checked: 0 }, seats: 4, gds: 1 },
    { outbound: ["JA7010 LIM-CUZ 10:30-11:55"], inbound: ["JA7011 CUZ-LIM 12:40-14:05"], price: 96.2, baggage: { carryOn: false, checked: 0 }, seats: 9, gds: 3 },
  ]);
  fake.setFlights("cbplus", { origin: "LIM", destination: "CUZ" }, LIM_CUZ_CBPLUS);

  fake.setFlights("agil", { origin: "LIM", destination: "MAD" }, [
    { outbound: ["IB6650 LIM-MAD 17:25-11:50+1"], price: 749, baggage: { carryOn: true, checked: 1 }, seats: 5 },
    { outbound: ["AV50 LIM-BOG 04:55-08:30", "AV10 BOG-MAD 11:10-04:40+1"], price: 612, baggage: { carryOn: true, checked: 1 }, seats: 3, gds: 7 },
  ]);
  fake.setFlights("cbplus", { origin: "LIM", destination: "MAD" }, [
    { outbound: ["UX172 LIM-MAD 12:40-06:55+1"], price: 689, baggage: { carryOn: true, checked: 1 }, brand: "Lite" },
    { outbound: ["IB6652 LIM-MAD 23:40-17:45+1"], price: 802, baggage: { carryOn: true, checked: 2 }, brand: "Flex" },
  ]);

  /* Prices move with the date, so the aggregated matrix takes cells from both. */
  fake.setFlights("agil", { origin: "LIM", destination: "MIA" }, (query) => [{
    outbound: ["AA918 LIM-MIA 23:35-06:05+1"],
    inbound: ["AA917 MIA-LIM 16:35-21:55"],
    price: query.departureDate === day(41) ? 655 : 612,
    baggage: { carryOn: true, checked: 1 },
    seats: 6,
    gds: 10,
  }]);
  fake.setFlights("cbplus", { origin: "LIM", destination: "MIA" }, (query) => [{
    outbound: ["CM472 LIM-PTY 05:59-09:18", "CM208 PTY-MIA 10:36-14:32"],
    inbound: ["CM105 MIA-PTY 09:30-11:20", "CM471 PTY-LIM 13:05-16:25"],
    price: query.departureDate === day(41) ? 598 : 640,
    baggage: { carryOn: true, checked: 1 },
    brand: "Economy Classic",
  }]);

  fake.setFlights("both", { origin: "LIM", destination: "SCL" }, [
    { outbound: ["LA2371 LIM-SCL 07:50-13:25"], price: 214, baggage: { carryOn: true, checked: 0 }, seats: 8 },
    { outbound: ["H2 5561 LIM-SCL 01:20-06:55"], price: 176, baggage: { carryOn: true, checked: 0 }, seats: 5, gds: 1 },
  ]);
}

function searchPayload(request: Record<string, unknown>, legs: Record<string, unknown>): Record<string, unknown> {
  return {
    sortMode: "cheapest",
    clientSessionId: "e2e-prove-stack-session",
    request: {
      passengers: { adults: 1, children: 0, infants: 0 },
      filters: {},
      currencyCode: "USD",
      locale: "es-PE",
      market: "PE",
      ...request,
      legs: [legs],
    },
  };
}

function providersIn(offers: readonly CanonicalOffer[]): ProviderId[] {
  return [...new Set(offers.map((offer) => offer.providerSource))].sort();
}

function formatRevisions(revisions: readonly JobRevision[]): string {
  return revisions
    .map((entry) => `      t=${(entry.elapsedMs / 1000).toFixed(1)}s rev=${entry.revision} ${entry.status} results=${entry.results} [${entry.providers.join(",") || "-"}]`)
    .join("\n");
}

function flightNumbers(offer: CanonicalOffer): string {
  return offer.itineraries.map((itinerary) => itinerary.segments.map((segment) => `${segment.marketingCarrier}${segment.flightNumber}`).join("+")).join(" / ");
}

async function step(name: string, run: () => Promise<string | void>): Promise<void> {
  const startedAt = Date.now();
  const detail = await run();
  console.log(`PASS ${name} (${Date.now() - startedAt} ms)${detail ? `\n${detail}` : ""}`);
}

async function prove(fake: FakeUpstream, stack: Stack, session: ApiSession): Promise<void> {
  const webPort = Number(new URL(stack.urls.web).port);
  const runnerPort = Number(new URL(stack.urls.runner).port);
  const redirectPort = Number(new URL(stack.urls.redirect).port);
  let exactJob: SearchJob | undefined;

  await step("(a) autocomplete merges Agil and Click and Book Plus suggestions", async () => {
    const answer = await session.json<{ suggestions: LocationSuggestion[] }>("GET", "/api/locations?q=buenos&limit=8");
    const codes = answer.suggestions.map((suggestion) => suggestion.code);
    assert.ok(codes.includes("BUE"), `Agil-only city BUE missing from ${codes.join(",")}`);
    assert.ok(codes.includes("AEP"), `Click and Book Plus-only AEP missing from ${codes.join(",")}`);
    const calls = fake.requests((request) => request.op === "agil.locations" || request.op === "cbplus.locations");
    assert.deepEqual([...new Set(calls.map((request) => request.op))].sort(), ["agil.locations", "cbplus.locations"]);
    assert.ok(calls.every((request) => request.caller?.script === "index.ts" && request.caller.port === webPort), "autocomplete must run in the web unit");
    return `      suggestions: ${answer.suggestions.map((suggestion) => `${suggestion.code}(${suggestion.type ?? "?"})`).join(" ")}`;
  });

  const removeCbplusDelay = cbplusDelayMs > 0 ? fake.delay("cbplus.search", cbplusDelayMs) : () => undefined;

  await step(`(b) exact round trip LIM-CUZ ${day(21)}/${day(25)} completes with both providers`, async () => {
    const started = await session.json<SearchJob>("POST", "/api/search", searchPayload(
      { tripType: "round-trip", searchMode: "exact" },
      { origin: "LIM", destination: "CUZ", departureDate: day(21), returnDate: day(25) },
    ));
    const { job, revisions } = await followSearchJob(session, started);
    assert.equal(job.searchStatus, "completed");
    const offers = searchOffers(job);
    assert.deepEqual(providersIn(offers), ["agil-local", "costamar"]);
    assert.equal(offers.length, 5);
    assert.ok(offers.every((offer) => offer.purchasePaths.some((path) => path.url?.startsWith("/r/"))));
    exactJob = job;
    return [
      formatRevisions(revisions),
      ...offers.map((offer) => `      ${offer.providerSource.padEnd(10)} ${flightNumbers(offer).padEnd(24)} ${offer.price.total.currencyCode} ${offer.price.total.amount}`),
    ].join("\n");
  });

  removeCbplusDelay();

  await step(`(c) one-way stay-range LIM-MAD ${day(30)}..${day(32)} completes with offers`, async () => {
    const started = await session.json<SearchJob>("POST", "/api/search", searchPayload(
      { tripType: "one-way", searchMode: "stay-range" },
      { origin: "LIM", destination: "MAD", departureStart: day(30), departureEnd: day(32) },
    ));
    const { job, revisions } = await followSearchJob(session, started);
    assert.equal(job.searchStatus, "completed");
    const offers = searchOffers(job);
    assert.deepEqual(providersIn(offers), ["agil-local", "costamar"]);
    const dates = new Set(offers.map((offer) => offer.itineraries[0]?.segments[0]?.departureAt.slice(0, 10)));
    assert.deepEqual([...dates].sort(), [day(30), day(31), day(32)]);
    return formatRevisions(revisions);
  });

  await step(`(c) round-trip roundtrip-grid LIM-MIA ${day(40)}..${day(42)} x 7 nights completes with offers`, async () => {
    const started = await session.json<MatrixJob>("POST", "/api/matrix", searchPayload(
      { tripType: "round-trip", searchMode: "roundtrip-grid", flexibleMode: "exact-stay" },
      { origin: "LIM", destination: "MIA", departureStart: day(40), departureEnd: day(42), stayNights: 7 },
    ));
    const { job, revisions } = await followMatrixJob(session, started);
    assert.equal(job.matrixStatus, "completed");
    const offers = matrixOffers(job);
    assert.equal(offers.length, 3);
    assert.deepEqual(providersIn(offers), ["agil-local", "costamar"]);
    return [
      formatRevisions(revisions),
      ...(job.cells ?? []).map((cell) => `      ${cell.key} ${cell.providerSource} ${cell.price?.currencyCode} ${cell.price?.amount}`),
    ].join("\n");
  });

  assert.ok(exactJob);
  const exactOffers = searchOffers(exactJob);
  const agilOffer = exactOffers.find((offer) => offer.providerSource === "agil-local");
  const cbplusOffer = exactOffers.find((offer) => offer.providerSource === "costamar" && flightNumbers(offer).startsWith("LA2047"));
  assert.ok(agilOffer && cbplusOffer);

  await step("(d) quotation revalidates one offer of each provider against the fake", async () => {
    /* Reprice the Click and Book Plus fare: the verified quote can only carry it after a new provider call. */
    fake.setFlights("cbplus", { origin: "LIM", destination: "CUZ" }, LIM_CUZ_CBPLUS.map((offer, index) => index === 0 ? { ...offer, price: 156.8 } : offer));
    const lines: string[] = [];
    for (const [offer, op, expectedAmount] of [[agilOffer, "agil.search", agilOffer.price.total.amount], [cbplusOffer, "cbplus.search", 156.8]] as const) {
      const before = fake.requests(op).length;
      const quote = await session.json<{ searchSessionId: string; offer: CanonicalOffer; commercialText: string }>(
        "POST",
        "/api/quotation",
        { searchSessionId: exactJob!.searchJobId, offerId: offer.id },
      );
      assert.equal(quote.offer.id, offer.id);
      assert.equal(quote.offer.priceStatus, "verified");
      assert.equal(quote.offer.priceConfidence, "validated");
      assert.equal(quote.offer.price.total.amount, expectedAmount);
      assert.ok(fake.requests(op).length > before, `${op} was not called again`);
      assert.match(quote.commercialText, /COTIZACI/);
      assert.match(quote.commercialText, /S\/ /, "a domestic quote is priced in soles");
      lines.push(`      ${offer.providerSource}: ${quote.commercialText.split("\n").filter((line) => /S\/|Aerol/.test(line)).join(" | ")}`);
    }
    return lines.join("\n");
  });

  await step("(e) /r/<id> answers 302 through the redirect service for both providers", async () => {
    const agilPath = agilOffer.purchasePaths.find((path) => path.type === "search-redirect")?.url ?? "";
    const cbplusPath = cbplusOffer.purchasePaths.find((path) => path.type === "search-redirect")?.url ?? "";
    const expectedBrandPath = `/vuelos/pro/b/LIM/CUZ/${day(21)}/${day(25)}/1/0/0`;

    const agil = await openPurchasePath(session, agilPath);
    assert.equal(agil.response.status, 302);
    const agilLocation = new URL(agil.response.headers.get("location") ?? "");
    assert.equal(`${agilLocation.origin}${agilLocation.pathname}`, "https://www.agilsmart.com/home-user/flight-result");
    assert.equal(agilLocation.searchParams.get("departureDate"), day(21).split("-").reverse().join("/"));

    const openBrandRedirect = async () => {
      const { response, waitedMs } = await openPurchasePath(session, cbplusPath);
      assert.equal(response.status, 302, await response.text());
      const location = new URL(response.headers.get("location") ?? "");
      assert.equal(`${location.origin}${location.pathname}`, `https://flights.zdev.tech${expectedBrandPath}`);
      assert.equal(location.searchParams.get("terminalId"), FAKE_CBPLUS_TERMINAL_ID);
      assert.ok(location.searchParams.get("token")?.split(".").length === 3);
      return waitedMs;
    };
    const cbplusWaitedMs = await openBrandRedirect();
    assert.equal(fake.requests((request) => request.caller?.port === redirectPort).length, 0, "a usable token needs no provider call");

    /* Live validation against the brand host, after a restart: the purchase paths
       come back from the SQLite the runner wrote. */
    await stack.restart("redirect", { env: { CBPLUS_REDIRECT_TRUST_USABLE_TOKEN: "0" } });
    await openBrandRedirect();
    const validations = fake.requests((request) => request.op === "cbplus.brand" && request.caller?.script === "redirect-index.ts");
    assert.equal(validations.length, 1);
    assert.equal(validations[0]!.path.split("?")[0], expectedBrandPath);
    return [
      `      agil   -> ${agilLocation.origin}${agilLocation.pathname}?departureLocation=${agilLocation.searchParams.get("departureLocation")}&... (resolvable after ${agil.waitedMs} ms)`,
      `      cbplus -> https://flights.zdev.tech${expectedBrandPath}?terminalId=...&lang=es&token=<fake jwt> (resolvable after ${cbplusWaitedMs} ms; live-validated after a redirect restart)`,
    ].join("\n");
  });

  await step("(f) cancelling a delayed stay-range search stops it and its upstream fan-out", async () => {
    const removeAgilDelay = fake.delay("agil.search", 1_500);
    const removeCbplusDelay = fake.delay("cbplus.search", 1_500);
    try {
      const since = Date.now();
      const started = await session.json<SearchJob>("POST", "/api/search", searchPayload(
        { tripType: "one-way", searchMode: "stay-range" },
        { origin: "LIM", destination: "SCL", departureStart: day(50), departureEnd: day(55) },
      ));
      await fake.waitForRequest((request) => request.op === "agil.search" && request.receivedAt >= since);
      const cancelledAt = Date.now();
      const cancelled = await session.json<SearchJob>("POST", `/api/search/${encodeURIComponent(started.searchJobId)}/cancel`, {});
      assert.equal(cancelled.searchStatus, "cancelled");
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      const after = await session.json<SearchJob>("GET", `/api/search/${encodeURIComponent(started.searchJobId)}`);
      assert.equal(after.searchStatus, "cancelled");

      const calls = fake.requests((request) => (request.op === "agil.search" || request.op === "cbplus.search") && request.receivedAt >= since);
      const dates = new Set(calls.map((request) => request.query?.departureDate));
      /* The pool polls for cancellation every 500 ms; a day that finishes inside
         that window may still start one more. */
      const late = calls.filter((request) => request.receivedAt > cancelledAt + 1_500);
      assert.ok(dates.size < 6, `all ${dates.size} days were still searched`);
      assert.equal(late.length, 0, `${late.length} provider searches started more than 1.5 s after the cancel`);
      return `      ${calls.length} provider searches over ${dates.size} of 6 days, none started later than 1.5 s after the cancel`;
    } finally {
      removeAgilDelay();
      removeCbplusDelay();
    }
  });

  await step("failure injection: a 503 GDS, a logical error in a 200 and an expired bearer degrade the search", async () => {
    const removers = [
      fake.fail("agil.search", { status: 503, body: { message: "Service Unavailable" } }, { where: (request) => request.query?.gds === 1 }),
      fake.fail("cbplus.search", { status: 200, body: { status: 500, message: "Error interno del motor" } }),
    ];
    fake.expireAgilTokens();
    const mintsBefore = fake.requests("agil.token").length;
    try {
      const started = await session.json<SearchJob>("POST", "/api/search", searchPayload(
        { tripType: "round-trip", searchMode: "exact" },
        { origin: "LIM", destination: "CUZ", departureDate: day(60), returnDate: day(64) },
      ));
      const { job } = await followSearchJob(session, started);
      assert.equal(job.searchStatus, "completed");
      assert.deepEqual(providersIn(searchOffers(job)), ["agil-local"]);
      assert.equal(searchOffers(job).length, 2, "the offer behind the failing GDS is missing");
      const warnings = job.warnings ?? [];
      assert.ok(warnings.some((warning) => warning.includes("GDS 1")), warnings.join(" / "));
      assert.ok(warnings.some((warning) => warning.includes("Click and Book Plus")), warnings.join(" / "));
      assert.equal(fake.requests("agil.token").length, mintsBefore + 1, "the expired bearer is re-minted once");
      return `      warnings: ${warnings.join(" / ")}`;
    } finally {
      removers.forEach((remove) => remove());
    }
  });

  await step("(g) provider searches ran in pooled worker children of the runner", async () => {
    const calls = fake.requests((request) => PROVIDER_SEARCH_OPS.includes(request.op));
    const unitPids = new Set([stack.pid("runner"), stack.pid("web"), stack.pid("redirect")]);
    const offenders = calls.filter((request: RecordedRequest) =>
      request.caller?.script !== "search-worker.ts" || request.caller.port !== runnerPort || unitPids.has(request.caller.pid));
    assert.equal(offenders.length, 0, `not from a worker: ${offenders.map((request) => `${request.op}@${request.caller?.script}`).join(", ")}`);
    const workers = (prefix: string) => [...new Set(calls.filter((request) => request.op.startsWith(prefix)).map((request) => request.caller!.pid))];
    assert.equal(workers("agil.").length, 1, "one pooled Agil worker served every search");
    assert.equal(workers("cbplus.").length, 1, "one pooled Click and Book Plus worker served every search");
    return `      ${calls.length} provider calls; runner pid ${stack.pid("runner")}, agil worker pid ${workers("agil.")[0]}, cbplus worker pid ${workers("cbplus.")[0]}`;
  });

  await step("no egress outside the fake, no fallback path taken, no fixture error", async () => {
    assert.deepEqual(fake.blocked, []);
    assert.deepEqual(fake.requests((request) => FALLBACK_OPS.includes(request.op)).map((request) => `${request.op} ${request.origin}${request.path}`), []);
    assert.deepEqual(fake.requests((request) => request.error !== undefined).map((request) => request.error), []);
  });
}

async function main(): Promise<void> {
  const fake = await startFakeUpstream();
  installScenario(fake);
  let stack: Stack | undefined;
  const shutdown = async () => {
    const stoppingAt = Date.now();
    await stack?.stop();
    await fake.close();
    const retries = stack?.logs().split("\n").filter((line) => line.includes("survived kill attempt")) ?? [];
    console.log(`stack stopped in ${Date.now() - stoppingAt} ms${retries.length ? `; kill retries:\n${retries.join("\n")}` : ""}`);
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(130)));

  try {
    const bootStartedAt = Date.now();
    stack = await startStack({
      fakeUpstreamUrl: fake.url,
      today,
      keepData: options.has("keep"),
      onLog: options.has("verbose") ? (service, line) => console.log(`[${service}] ${line}`) : undefined,
    });
    console.log(`stack up in ${Date.now() - bootStartedAt} ms: proxy ${stack.baseUrl}, runner ${stack.urls.runner}, web ${stack.urls.web}, redirect ${stack.urls.redirect}, today ${today}${cbplusDelayMs ? `, cbplus delay ${cbplusDelayMs} ms` : ""}`);
    const session = await signIn(stack.baseUrl, stack.password);
    await prove(fake, stack, session);
    console.log(`ALL PASS${options.has("keep") ? ` (data kept in ${stack.root})` : ""}`);
  } catch (error) {
    console.error(`FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    if (stack) {
      console.error(stack.logs());
    }
    console.error(fake.requests().slice(-30).map((request) => `  #${request.seq} ${request.op} ${request.path} -> ${request.status ?? "pending"} ${request.caller ? `${request.caller.script}#${request.caller.pid}` : ""}`).join("\n"));
    process.exitCode = 1;
  } finally {
    await shutdown();
  }
}

await main();
