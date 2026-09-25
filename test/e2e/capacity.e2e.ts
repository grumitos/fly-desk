import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import {
  followMatrixJob,
  followSearchJob,
  matrixOffers,
  openPurchasePath,
  purchasePathOf,
  readMatrixJob,
  readSearchJob,
  searchOffers,
  searchPayloads,
  startMatrix,
  startSearch,
  type ApiSession,
  type SearchJob,
} from "./support/api-client.ts";
import { startedJob, waitForResults } from "./support/flows.ts";
import { defineSuite } from "./support/harness.ts";
import { fakeCbplusToken, FAKE_CBPLUS_TERMINAL_ID, type OfferSpec } from "./support/fixtures.ts";
import type { RecordedRequest } from "./support/fake-upstream.ts";
import { day, eventually, matchesRoute, maxInFlight, sleep, type RouteFilter } from "./support/scenario.ts";
import { searchForm, searchLink } from "./support/ui.ts";

/*
 * The runner under load and across restarts: the admission budget and its
 * queue, the Agil in-flight ceiling, what survives a restart of every unit,
 * and a Click and Book Plus token renewed on disk while everything runs.
 */

/* The token file the whole stack reads (`CBPLUS_TOKEN_FILE`), written before
   the stack starts so every process begins with token A. */
const tokenDir = mkdtempSync(join(tmpdir(), "fly-desk-e2e-token-"));
const TOKEN_FILE = join(tokenDir, "cbplus-token");
const TOKEN_A = fakeCbplusToken(FAKE_CBPLUS_TERMINAL_ID, Date.now() - 60_000);
writeFileSync(TOKEN_FILE, TOKEN_A);
after(() => rmSync(tokenDir, { recursive: true, force: true }));

const MAX_QUEUED = 3;
const suite = defineSuite({
  file: import.meta.filename,
  stack: {
    env: { CBPLUS_TOKEN_FILE: TOKEN_FILE, CBPLUS_TOKEN: undefined },
    serviceEnv: {
      runner: { FLY_DESK_SEARCH_MAX_QUEUED: String(MAX_QUEUED) },
      /* Always check the brand host, so the token a redirect carries is seen. */
      redirect: { CBPLUS_REDIRECT_TRUST_USABLE_TOKEN: "0" },
    },
  },
});

const isProviderSearch = (request: RecordedRequest) => request.op === "agil.search" || request.op === "cbplus.search";

/** The provider searches of one job, identified by its route. */
function callsFor(requests: readonly RecordedRequest[], route: RouteFilter): RecordedRequest[] {
  return requests.filter((request) => isProviderSearch(request) && matchesRoute(request, route));
}

async function providerStatuses(api: ApiSession, jobId: string): Promise<string[]> {
  const job = await readSearchJob(api, jobId);
  return (job.providerDiagnostics ?? []).map((entry) => entry.status);
}

/* ---- Admission ---- */

/** Two range searches (2 units each) that fill the budget of 4 until released. */
async function fillTheBudget(api: ApiSession, fake: typeof suite.fake, first: number) {
  const blockers = [
    { origin: "LIM", destination: "SCL", days: [day(first), day(first + 1)] },
    { origin: "LIM", destination: "BOG", days: [day(first + 2), day(first + 3)] },
  ];
  const gates = blockers.map((blocker) => fake.hold("*", (request) =>
    isProviderSearch(request)
    && request.query?.origin === blocker.origin
    && request.query.destination === blocker.destination
    && blocker.days.includes(request.query.departureDate)));
  const jobs: SearchJob[] = [];
  for (const blocker of blockers) {
    jobs.push(await startSearch(api, searchPayloads.range(blocker.origin, blocker.destination, blocker.days[0]!, blocker.days[1]!)));
  }
  await eventually(() => assert.ok(gates.every((gate) => gate.seen > 0), "a blocker never reached its providers"));
  return { jobs, gates };
}

suite.test("searches beyond the capacity budget wait in arrival order, and a small one never overtakes a large one", async (scope) => {
  const { fake } = scope;
  const api = await scope.api();
  const { jobs: blockers, gates } = await fillTheBudget(api, fake, 100);

  /* Queued behind the budget, in this order: an exact search (1 unit), a
     range (2 units), another exact search (1 unit). */
  const routes = {
    a: { origin: "LIM", destination: "CUZ", departureDate: day(120) },
    b: { origin: "LIM", destination: "AQP" },
    c: { origin: "LIM", destination: "PIU", departureDate: day(123) },
  };
  const holdA = fake.hold("*", (request) => isProviderSearch(request) && matchesRoute(request, routes.a));
  const a = await startSearch(api, searchPayloads.exact("LIM", "CUZ", day(120)));
  const b = await startSearch(api, searchPayloads.range("LIM", "AQP", day(121), day(122)));
  const c = await startSearch(api, searchPayloads.exact("LIM", "PIU", day(123)));
  for (const job of [a, b, c]) {
    assert.deepEqual(await providerStatuses(api, job.searchJobId), ["queued", "queued"], "a search started past the budget");
  }
  assert.equal(fake.requests((request) => isProviderSearch(request) && [routes.a, routes.b, routes.c].some((route) => matchesRoute(request, route))).length, 0);

  /* One blocker ends: two units free. A takes one and is held by its
     provider; B needs two, so it waits — and C, which would fit, waits
     behind B rather than overtaking it. */
  gates[0]!.release();
  await eventually(() => assert.ok(holdA.seen > 0, "A never started"));
  assert.deepEqual(await providerStatuses(api, c.searchJobId), ["queued", "queued"], "C overtook B");
  assert.deepEqual(await providerStatuses(api, b.searchJobId), ["queued", "queued"]);

  gates[1]!.release();
  holdA.release();
  for (const job of [...blockers, a, b, c]) {
    const { job: finished } = await followSearchJob(api, job);
    assert.equal(finished.searchStatus, "completed");
  }
  const firstCall = (route: RouteFilter) => Math.min(...callsFor(fake.requests(), route).map((request) => request.seq));
  assert.ok(firstCall(routes.a) < firstCall(routes.b), "A did not reach its providers before B");
  assert.ok(firstCall(routes.b) < firstCall(routes.c), "B did not reach its providers before C");
});

suite.test("a full queue refuses the next search, and a cancelled waiter gives its place back at once", async (scope) => {
  const { fake } = scope;
  const api = await scope.api();
  const { jobs: blockers, gates } = await fillTheBudget(api, fake, 130);

  const waiting: SearchJob[] = [];
  for (let index = 0; index < MAX_QUEUED; index += 1) {
    waiting.push(await startSearch(api, searchPayloads.exact("LIM", "CUZ", day(140 + index))));
  }
  const overflow = await startSearch(api, searchPayloads.exact("LIM", "CUZ", day(150)));
  const refused = await eventually(async () => {
    const job = await readSearchJob(api, overflow.searchJobId);
    assert.equal(job.searchStatus, "failed");
    return job;
  });
  assert.match(refused.error ?? "", /cola de busquedas esta llena/);

  /* The second waiter leaves; the next search takes its place instead of
     being refused. */
  const leaving = waiting[1]!;
  const cancelled = await api.json<SearchJob>("POST", `/api/search/${encodeURIComponent(leaving.searchJobId)}/cancel`, {});
  assert.equal(cancelled.searchStatus, "cancelled");
  const replacement = await startSearch(api, searchPayloads.exact("LIM", "CUZ", day(151)));
  assert.equal((await readSearchJob(api, replacement.searchJobId)).searchStatus, "running");
  assert.deepEqual(await providerStatuses(api, replacement.searchJobId), ["queued", "queued"]);

  gates.forEach((gate) => gate.release());
  for (const job of [...blockers, waiting[0]!, waiting[2]!, replacement]) {
    const { job: finished } = await followSearchJob(api, job);
    assert.equal(finished.searchStatus, "completed");
  }
  assert.equal((await readSearchJob(api, leaving.searchJobId)).searchStatus, "cancelled");
  assert.equal((await readSearchJob(api, overflow.searchJobId)).searchStatus, "failed");
  for (const neverRan of [leaving, overflow]) {
    const departureDate = (neverRan === leaving ? day(141) : day(150));
    assert.equal(callsFor(fake.requests(), { origin: "LIM", destination: "CUZ", departureDate }).length, 0, `${departureDate} reached a provider`);
  }
});

suite.test("a search that waits past the queue timeout fails with its reason", async (scope) => {
  const { fake, stack } = scope;
  /* The timeout is the runner's; a short one for this test only. */
  await stack.restart("runner", { env: { FLY_DESK_SEARCH_QUEUE_TIMEOUT_MS: "1500" } });
  try {
    const api = await scope.api();
    const { jobs: blockers, gates } = await fillTheBudget(api, fake, 160);
    const waiter = await startSearch(api, searchPayloads.exact("LIM", "CUZ", day(170)));
    const timedOut = await eventually(async () => {
      const job = await readSearchJob(api, waiter.searchJobId);
      assert.equal(job.searchStatus, "failed");
      return job;
    }, { timeoutMs: 10_000 });
    assert.match(timedOut.error ?? "", /espero demasiado/);
    assert.equal(callsFor(fake.requests(), { origin: "LIM", destination: "CUZ", departureDate: day(170) }).length, 0);
    gates.forEach((gate) => gate.release());
    for (const job of blockers) {
      assert.equal((await followSearchJob(api, job)).job.searchStatus, "completed");
    }
  } finally {
    await stack.restart("runner", { env: { FLY_DESK_SEARCH_QUEUE_TIMEOUT_MS: undefined } });
  }
});

suite.test("Agil never has more /mv/search calls in flight than its ceiling", async (scope) => {
  const { fake } = scope;
  /* Six cells, seven GDS ids each: 42 calls wanted at once, 32 allowed. */
  fake.setFlights("agil", { origin: "LIM", destination: "MIA" }, [
    { outbound: ["AA918 LIM-MIA 23:35-06:05+1"], inbound: ["AA917 MIA-LIM 16:35-21:55"], price: 612, baggage: { carryOn: true, checked: 1 } },
  ]);
  fake.delay("agil.search", 700);
  const api = await scope.api();
  const started = await startMatrix(api, searchPayloads.matrix("LIM", "MIA", day(180), day(185), 7));
  const { job } = await followMatrixJob(api, started);
  assert.equal(job.matrixStatus, "completed");
  assert.equal(matrixOffers(job).length, 6);
  const calls = fake.requests("agil.search");
  assert.equal(calls.length, 42);
  assert.equal(maxInFlight(calls), 32, "the Agil in-flight ceiling was not the limit");
});

/* ---- Restart ---- */

const CUSCO: OfferSpec[] = [
  { outbound: ["LA2045 LIM-CUZ 05:40-07:05"], inbound: ["LA2046 CUZ-LIM 08:10-09:35"], price: 142.8, baggage: { carryOn: true, checked: 0 }, seats: 7 },
  { outbound: ["H2 5102 LIM-CUZ 06:25-07:50"], inbound: ["H2 5103 CUZ-LIM 09:15-10:40"], price: 118.4, baggage: { carryOn: true, checked: 0 }, seats: 4, gds: 1 },
];

suite.test("results, purchase paths and suggestions survive a restart of every unit", async (scope) => {
  const { fake, stack } = scope;
  fake.setFlights("both", { origin: "LIM", destination: "CUZ" }, CUSCO);
  fake.setFlights("both", { origin: "LIM", destination: "MIA" }, (query) => query.departureDate === day(191)
    ? []
    : [{ outbound: ["AA918 LIM-MIA 23:35-06:05+1"], inbound: ["AA917 MIA-LIM 16:35-21:55"], price: 612, baggage: { carryOn: true, checked: 1 } }]);

  /* A suggestion the desk asked for, and an exact search from the desk. */
  const link = searchLink({ mode: "exact", trip: "round-trip", origin: "LIM", destination: "CUZ", departure: day(186), return: day(190) });
  const { page } = await scope.signedInPage("/");
  await searchForm.location(page, "Destino").fill("cus");
  await searchForm.suggestion(page, "CUZ").waitFor();
  const suggestionCalls = fake.requests((request) => request.op === "agil.locations" || request.op === "cbplus.locations");
  assert.ok(suggestionCalls.some((request) => /cus/i.test(request.path)), "the suggestion never reached a provider");
  const exactJob = await startedJob<SearchJob>(page, async () => {
    await page.goto(`${stack.baseUrl}${link}`);
  });
  const exactCards = await waitForResults(page, 4);

  /* A flexible round trip over the matrix, through the API. */
  const api = await scope.api();
  const matrix = await followMatrixJob(api, await startMatrix(api, searchPayloads.matrix("LIM", "MIA", day(191), day(192), 7)));
  assert.equal(matrixOffers(matrix.job).length, 1);

  const pids = { runner: stack.pid("runner"), web: stack.pid("web"), redirect: stack.pid("redirect") };
  await stack.restart("runner");
  await stack.restart("web");
  await stack.restart("redirect");
  assert.notEqual(stack.pid("runner"), pids.runner);
  assert.notEqual(stack.pid("web"), pids.web);
  assert.notEqual(stack.pid("redirect"), pids.redirect);
  fake.clearRequests();

  /* The job reads back from SQLite: same rows, no provider asked. */
  await page.goto(`${stack.baseUrl}/?job=${encodeURIComponent(exactJob.searchJobId)}`);
  const restored = await waitForResults(page, 4);
  assert.deepEqual(restored.map((card) => card.label), exactCards.map((card) => card.label));
  const storedMatrix = await readMatrixJob(api, matrix.job.matrixJobId);
  assert.deepEqual(matrixOffers(storedMatrix).map((offer) => offer.price.total.amount), [612]);

  /* The suggestion answers from the web unit's SQLite cache. */
  await page.goto(stack.baseUrl);
  await searchForm.location(page, "Destino").fill("cus");
  await searchForm.suggestion(page, "CUZ").waitFor();
  assert.deepEqual(fake.requests().map((request) => request.op), [], "reading back after the restart called a provider");

  /* Both providers' purchase paths, and the matrix cell's, still resolve. */
  const storedExact = await readSearchJob(api, exactJob.searchJobId);
  const agilOffer = searchOffers(storedExact).find((offer) => offer.providerSource === "agil-local");
  const cbplusOffer = searchOffers(storedExact).find((offer) => offer.providerSource === "costamar");
  assert.ok(agilOffer && cbplusOffer);
  for (const path of [purchasePathOf(agilOffer), purchasePathOf(cbplusOffer), purchasePathOf(matrixOffers(storedMatrix)[0]!)]) {
    const { response } = await openPurchasePath(api, path);
    assert.equal(response.status, 302, `${path} answered ${response.status}`);
  }
  assert.deepEqual(
    [...new Set(fake.requests().map((request) => request.op))].sort(),
    ["cbplus.brand"],
    "resolving the purchase paths did more than validate the Click and Book Plus link",
  );
});

/* ---- The Click and Book Plus token, renewed on disk ---- */

/* `src/provider-context.ts` re-stats `CBPLUS_TOKEN_FILE` at most once a second,
   so a rewrite is seen by every process within that interval and not before:
   nothing observable changes until a process next reads the token. */
const TOKEN_FILE_STAT_INTERVAL_MS = 1_000;

suite.test("a renewed Click and Book Plus token file reaches searches and redirects with nothing restarted", async (scope) => {
  const { fake, stack } = scope;
  fake.setFlights("cbplus", { origin: "LIM", destination: "CUZ" }, [
    { outbound: ["LA2047 LIM-CUZ 07:15-08:40"], price: 151.3, baggage: { carryOn: true, checked: 1 }, brand: "Plus" },
  ]);
  const pids = { runner: stack.pid("runner"), web: stack.pid("web"), redirect: stack.pid("redirect") };
  const api = await scope.api();
  const { page } = await scope.signedInPage("/");
  const searchOn = async (departure: string): Promise<string> => {
    const link = searchLink({ mode: "exact", trip: "one-way", origin: "LIM", destination: "CUZ", departure });
    const job = await startedJob<SearchJob>(page, async () => {
      await page.goto(`${stack.baseUrl}${link}`);
    });
    await waitForResults(page, 1);
    return job.searchJobId;
  };
  const searchTokens = () => fake.requests("cbplus.search").map((request) => String((request.body as { token?: unknown }).token));
  const brandTokens = () => fake.requests("cbplus.brand").map((request) => new URL(request.path, "https://brand.invalid").searchParams.get("token"));
  const redirectTokenOf = async (jobId: string) => {
    const offer = searchOffers(await readSearchJob(api, jobId)).find((candidate) => candidate.providerSource === "costamar");
    assert.ok(offer, "no Click and Book Plus fare");
    const { response } = await openPurchasePath(api, purchasePathOf(offer));
    assert.equal(response.status, 302);
    return new URL(response.headers.get("location") ?? "").searchParams.get("token");
  };

  const tokenB = fakeCbplusToken(FAKE_CBPLUS_TERMINAL_ID, Date.now());
  assert.notEqual(tokenB, TOKEN_A);
  try {
    const firstJob = await searchOn(day(200));
    assert.deepEqual(searchTokens(), [TOKEN_A]);
    assert.equal(await redirectTokenOf(firstJob), TOKEN_A);
    assert.deepEqual(brandTokens(), [TOKEN_A]);
    const cbplusWorker = fake.requests("cbplus.search")[0]!.caller?.pid;
    assert.ok(cbplusWorker);

    /* The renewal: a new token for the same terminal, written over the old one. */
    writeFileSync(TOKEN_FILE, tokenB);
    await sleep(TOKEN_FILE_STAT_INTERVAL_MS + 200);

    const secondJob = await searchOn(day(201));
    assert.equal(searchTokens().at(-1), tokenB, "the search after the renewal still used the old token");
    assert.equal(await redirectTokenOf(secondJob), tokenB, "the redirect after the renewal still carries the old token");
    assert.equal(brandTokens().at(-1), tokenB, "the redirect service validated the old token");

    /* Nothing was restarted to get there. */
    assert.deepEqual({ runner: stack.pid("runner"), web: stack.pid("web"), redirect: stack.pid("redirect") }, pids);
    assert.equal(fake.requests("cbplus.search").at(-1)!.caller?.pid, cbplusWorker, "the Click and Book Plus worker was replaced");
  } finally {
    writeFileSync(TOKEN_FILE, TOKEN_A);
  }
});
