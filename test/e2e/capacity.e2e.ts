import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";
import {
  followMatrixJob,
  followSearchJob,
  matrixOffers,
  openPurchasePath,
  purchasePathOf,
  readCapacity,
  readMatrixJob,
  readSearchJob,
  searchOffers,
  searchPayloads,
  startMatrix,
  startSearch,
  type ApiSession,
  type SearchCapacity,
  type SearchJob,
} from "./support/api-client.ts";
import { startedJob, waitForResults } from "./support/flows.ts";
import { defineSuite } from "./support/harness.ts";
import { fakeCbplusToken, FAKE_CBPLUS_TERMINAL_ID, type OfferSpec } from "./support/fixtures.ts";
import type { Gate, RecordedRequest } from "./support/fake-upstream.ts";
import {
  day,
  eventually,
  matchesRoute,
  maxInFlight,
  pageStats,
  PROVIDER_SEARCH_OPS,
  querySqlite,
  sleep,
  writeSqlite,
  type RouteFilter,
} from "./support/scenario.ts";
import { searchForm, searchLink } from "./support/ui.ts";

/*
 * The runner under load and across restarts: the shared capacity and the queue
 * in front of it, the Agil in-flight ceiling, what survives a restart of every
 * unit and a rollback, the cache file compacted at start, and a Click and Book
 * Plus token renewed on disk while everything runs.
 */

/* The token as the platform installs it: in the file every process re-reads
   (`CBPLUS_TOKEN_FILE`) and in the environment it starts with (`CBPLUS_TOKEN`),
   token A in both before the stack starts. */
const tokenDir = mkdtempSync(join(tmpdir(), "fly-desk-e2e-token-"));
const TOKEN_FILE = join(tokenDir, "cbplus-token");
const TOKEN_A = fakeCbplusToken(FAKE_CBPLUS_TERMINAL_ID, Date.now() - 60_000);
writeFileSync(TOKEN_FILE, TOKEN_A);
afterAll(() => rmSync(tokenDir, { recursive: true, force: true }));

const suite = defineSuite({
  file: import.meta.filename,
  stack: {
    env: { CBPLUS_TOKEN_FILE: TOKEN_FILE, CBPLUS_TOKEN: TOKEN_A },
    serviceEnv: {
      /* Always check the brand host, so the token a redirect carries is seen. */
      redirect: { CBPLUS_REDIRECT_TRUST_USABLE_TOKEN: "0" },
    },
  },
});

const isProviderSearch = (request: RecordedRequest) => request.op === "agil.search" || request.op === "cbplus.search";

/* The search runner's cache file, which the web and redirect units read too. */
function sessionDbPath(): string {
  return join(suite.stack.appDataDir, "fly-desk-cache.sqlite");
}

/** The provider searches of one job, identified by its route. */
function callsFor(requests: readonly RecordedRequest[], route: RouteFilter): RecordedRequest[] {
  return requests.filter((request) => isProviderSearch(request) && matchesRoute(request, route));
}

/* ---- Capacity ---- */

/*
 * The runner's budget (`src/search-admission.ts`): 7 units, of which heavy
 * work holds at most 5 and 2 stay for exact searches. An exact search costs
 * 1, a matrix or a range of up to ten days 2, a range of up to a month 3.
 */

/** A search held at its providers: every provider request on `route` waits for `release`. */
function holdRoute(fake: typeof suite.fake, route: RouteFilter): Gate {
  return fake.hold("*", (request) => isProviderSearch(request) && matchesRoute(request, route));
}

/** The counts of a capacity reading, for comparing. */
function occupancy(capacity: SearchCapacity) {
  return {
    activeUnits: capacity.activeUnits,
    activeSearches: capacity.activeSearches,
    queuedSearches: capacity.queuedSearches,
  };
}

async function capacityBackToIdle(api: ApiSession): Promise<void> {
  await eventually(async () => {
    assert.deepEqual(occupancy(await readCapacity(api)), { activeUnits: 0, activeSearches: 0, queuedSearches: 0 });
  }, { message: "the capacity came back to idle" });
}

async function isQueued(api: ApiSession, job: SearchJob): Promise<boolean> {
  return (await readSearchJob(api, job.searchJobId)).queued === true;
}

suite.test("a search that does not fit waits instead of being refused, and one stopped while it waits leaves at once", async (scope) => {
  const { fake } = scope;
  const api = await scope.api();
  /* Two short ranges hold 4 of the 5 heavy units at their providers. */
  const gates = [holdRoute(fake, { origin: "LIM", destination: "SCL" }), holdRoute(fake, { origin: "LIM", destination: "BOG" })];
  const blockers = [
    await startSearch(api, searchPayloads.range("LIM", "SCL", day(100), day(101))),
    await startSearch(api, searchPayloads.range("LIM", "BOG", day(100), day(101))),
  ];
  await eventually(() => assert.ok(gates.every((gate) => gate.seen > 0), "a blocker never reached its providers"));
  assert.ok(blockers.every((job) => job.queued === false));

  /* Nine more: more than the runner ever let wait, and none of them refused. */
  const waiting: SearchJob[] = [];
  for (let index = 0; index < 9; index += 1) {
    waiting.push(await startSearch(api, searchPayloads.range("LIM", "CUZ", day(110 + index * 2), day(111 + index * 2))));
  }
  for (const job of waiting) {
    assert.equal(job.searchStatus, "running");
    assert.equal(job.queued, true, "a search past the budget started");
  }
  assert.deepEqual(occupancy(await readCapacity(api)), { activeUnits: 4, activeSearches: 2, queuedSearches: 9 });
  assert.equal(callsFor(fake.requests(), { origin: "LIM", destination: "CUZ" }).length, 0);

  /* One is stopped while it waits: it leaves the queue at once. */
  const leaving = waiting[3]!;
  const stopped = await api.json<SearchJob>("POST", `/api/search/${encodeURIComponent(leaving.searchJobId)}/cancel`, {});
  assert.equal(stopped.searchStatus, "cancelled");
  assert.equal(stopped.queued, false);
  assert.equal((await readCapacity(api)).queuedSearches, 8);

  gates.forEach((gate) => gate.release());
  for (const job of [...blockers, ...waiting.filter((candidate) => candidate !== leaving)]) {
    const { job: finished } = await followSearchJob(api, job);
    assert.equal(finished.searchStatus, "completed");
    assert.equal(finished.queued, false);
  }
  assert.equal(callsFor(fake.requests(), { origin: "LIM", destination: "CUZ", departureDate: day(116) }).length, 0, "the stopped search reached a provider");
  await capacityBackToIdle(api);
});

suite.test("each agent starts an exact search at once whatever runs, and the agent holding less capacity goes first", async (scope) => {
  const { fake } = scope;
  const agentA = await scope.api();
  const agentB = await scope.api();
  const route = (destination: string): RouteFilter => ({ origin: "LIM", destination });

  /* A's two short ranges hold 4 of the 5 heavy units. */
  const gateA1 = holdRoute(fake, route("SCL"));
  const gateA2 = holdRoute(fake, route("BOG"));
  await startSearch(agentA, searchPayloads.range("LIM", "SCL", day(120), day(121)));
  await startSearch(agentA, searchPayloads.range("LIM", "BOG", day(120), day(121)));
  await eventually(() => assert.ok(gateA1.seen > 0 && gateA2.seen > 0, "A's ranges never reached their providers"));

  /* A asks for a third range, then B for one: neither fits. */
  const gateA3 = holdRoute(fake, route("CUZ"));
  const gateB1 = holdRoute(fake, route("AQP"));
  const a3 = await startSearch(agentA, searchPayloads.range("LIM", "CUZ", day(122), day(123)));
  const b1 = await startSearch(agentB, searchPayloads.range("LIM", "AQP", day(122), day(123)));
  assert.equal(a3.queued, true);
  assert.equal(b1.queued, true);

  /* Exact searches keep two units of their own: one each starts at once. */
  const gateExactB = holdRoute(fake, route("PIU"));
  const gateExactA = holdRoute(fake, route("IQT"));
  const exactB = await startSearch(agentB, searchPayloads.exact("LIM", "PIU", day(124)));
  const exactA = await startSearch(agentA, searchPayloads.exact("LIM", "IQT", day(124)));
  assert.equal(exactB.queued, false, "B's exact search waited behind heavy work");
  assert.equal(exactA.queued, false, "A's exact search waited behind heavy work");
  await eventually(() => assert.ok(gateExactB.seen > 0 && gateExactA.seen > 0, "an exact search never reached its providers"));
  /* A third one would fit the budget, but not the reserve: while heavy work
     waits it does not take the units a waiting range needs. */
  const exactA2 = await startSearch(agentA, searchPayloads.exact("LIM", "TPP", day(124)));
  assert.equal(exactA2.queued, true, "an exact search past the reserve overtook waiting heavy work");

  /* One of A's ranges ends: B, who holds nothing heavy, goes before A's
     earlier range. */
  gateA1.release();
  await eventually(() => assert.ok(gateB1.seen > 0, "B's range never started"));
  assert.equal(await isQueued(agentA, a3), true, "A's range overtook B's");
  assert.equal(gateA3.seen, 0);
  assert.equal(await isQueued(agentA, exactA2), true);

  /* A's other range ends: now A's third one starts, and with no heavy work
     waiting any more, so does the exact search past the reserve. */
  gateA2.release();
  await eventually(() => assert.ok(gateA3.seen > 0, "A's third range never started"));
  await eventually(async () => assert.equal(await isQueued(agentA, exactA2), false, "the exact search past the reserve never started"));

  for (const gate of [gateA3, gateB1, gateExactA, gateExactB]) {
    gate.release();
  }
  await capacityBackToIdle(agentA);
});

suite.test("two month-long ranges never run at once, and the waiting one is not overtaken by a shorter one", async (scope) => {
  const { fake } = scope;
  const agentA = await scope.api();
  const agentB = await scope.api();
  const agentC = await scope.api();
  /* A's month holds 3 heavy units, its first day waiting at the providers. */
  const firstDayA = holdRoute(fake, { origin: "LIM", destination: "MIA", departureDate: day(130) });
  const monthA = await startSearch(agentA, searchPayloads.range("LIM", "MIA", day(130), day(159)));
  await eventually(() => assert.ok(firstDayA.seen > 0, "A's month never started"));
  assert.equal(monthA.queued, false);

  /* B's month does not fit beside it. C's short range would, but B asked
     first and holds as little as C: nothing heavy overtakes B's month. */
  const monthB = await startSearch(agentB, searchPayloads.range("LIM", "MAD", day(130), day(159)));
  const rangeC = await startSearch(agentC, searchPayloads.range("LIM", "BOG", day(130), day(136)));
  assert.equal(monthB.queued, true);
  assert.equal(rangeC.queued, true, "a shorter range overtook the waiting month");
  assert.deepEqual(occupancy(await readCapacity(agentA)), { activeUnits: 3, activeSearches: 1, queuedSearches: 2 });

  firstDayA.release();
  for (const [api, job] of [[agentA, monthA], [agentB, monthB], [agentC, rangeC]] as const) {
    assert.equal((await followSearchJob(api, job, 120_000)).job.searchStatus, "completed");
  }
  const lastOfA = Math.max(...callsFor(fake.requests(), { destination: "MIA" }).map((request) => request.respondedAt ?? Number.POSITIVE_INFINITY));
  const firstOfB = Math.min(...callsFor(fake.requests(), { destination: "MAD" }).map((request) => request.receivedAt));
  assert.ok(firstOfB >= lastOfA, "B's month reached a provider before A's month had finished");
  await capacityBackToIdle(agentA);
});

/* The unit's cgroup as the runner reads it (`src/unit-memory.ts`), written by
   the test: a limit of 900 MiB, like `MemoryHigh`, and the anonymous memory
   the test says the unit holds. */
function fakeCgroup(): { dir: string; holding: (mib: number) => void } {
  const dir = mkdtempSync(join(tmpdir(), "fly-desk-e2e-cgroup-"));
  writeFileSync(join(dir, "memory.high"), String(900 * 1024 * 1024));
  const holding = (mib: number) => writeFileSync(join(dir, "memory.stat"), `anon ${mib * 1024 * 1024}\nfile 0\n`);
  holding(100);
  return { dir, holding };
}

suite.test("beside other heavy work a heavy search waits while the unit's memory is short, and one alone starts anyway", async (scope) => {
  const { fake, stack } = scope;
  const cgroup = fakeCgroup();
  await stack.restart("runner", { env: { FLY_DESK_CGROUP_DIR: cgroup.dir } });
  try {
    const agentA = await scope.api();
    const agentB = await scope.api();
    const gateA = holdRoute(fake, { origin: "LIM", destination: "SCL" });
    await startSearch(agentA, searchPayloads.range("LIM", "SCL", day(220), day(221)));
    await eventually(() => assert.ok(gateA.seen > 0, "A's range never started"));

    /* The units would take B's range beside A's; the memory would not. */
    cgroup.holding(800);
    const gateB = holdRoute(fake, { origin: "LIM", destination: "BOG" });
    const rangeB = await startSearch(agentB, searchPayloads.range("LIM", "BOG", day(220), day(221)));
    assert.equal(rangeB.queued, true, "a heavy search started beside heavy work with the unit's memory short");
    const exactB = await startSearch(agentB, searchPayloads.exact("LIM", "CUZ", day(222)));
    assert.equal(exactB.queued, false, "an exact search waited for memory");

    /* The memory frees while A's range still runs: B's starts. */
    cgroup.holding(200);
    await eventually(() => assert.ok(gateB.seen > 0, "B's range never started once the memory freed"));

    /* Alone, a heavy search starts whatever the memory says. */
    gateA.release();
    gateB.release();
    await capacityBackToIdle(agentA);
    cgroup.holding(850);
    const lone = await startSearch(agentA, searchPayloads.range("LIM", "CUZ", day(225), day(226)));
    assert.equal(lone.queued, false, "a heavy search alone waited for memory");
    assert.equal((await followSearchJob(agentA, lone)).job.searchStatus, "completed");
    await capacityBackToIdle(agentA);
  } finally {
    await stack.restart("runner", { env: { FLY_DESK_CGROUP_DIR: undefined } });
    rmSync(cgroup.dir, { recursive: true, force: true });
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
  await stack.restart("runner", {
    beforeLaunch: () => {
      /* Every stored job keeps the `offers` list, empty: a release before this
         one maps over it when it restores a row, so a rollback boots on these. */
      const rows = querySqlite<{ id: string; payload: string }>(sessionDbPath(), "SELECT id, payload FROM search_jobs");
      assert.ok(rows.some((row) => row.id === exactJob.searchJobId), "the exact search was not stored");
      for (const row of rows) {
        assert.deepEqual((JSON.parse(row.payload) as { offers?: unknown }).offers, [], `job ${row.id} is stored without the empty list a rollback reads`);
      }
      /* A rollback and a new deployment later: the earlier release rewrote the
         row with the filtered copy it keeps, which is not read back. */
      const exactRow = rows.find((row) => row.id === exactJob.searchJobId)!;
      const payload = JSON.parse(exactRow.payload) as { allOffers: unknown[] };
      writeSqlite(sessionDbPath(), [{
        sql: "UPDATE search_jobs SET payload = ? WHERE id = ?",
        params: [JSON.stringify({ ...payload, offers: payload.allOffers.slice(0, 1) }), exactJob.searchJobId],
      }]);
    },
  });
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

    /* A job lives for hours and a token for one: quoting a fare of the job
       searched before the renewal asks the provider with the renewed token. */
    const firstFare = searchOffers(await readSearchJob(api, firstJob)).find((offer) => offer.providerSource === "costamar");
    assert.ok(firstFare, "no Click and Book Plus fare");
    const searchesBeforeQuote = fake.requests("cbplus.search").length;
    await api.json("POST", "/api/quotation", { searchSessionId: firstJob, offerId: firstFare.id });
    assert.equal(fake.requests("cbplus.search").length, searchesBeforeQuote + 1, "the quote did not revalidate the fare");
    assert.equal(searchTokens().at(-1), tokenB, "the quote on a job from before the renewal used the old token");

    /* Nothing was restarted to get there. */
    assert.deepEqual({ runner: stack.pid("runner"), web: stack.pid("web"), redirect: stack.pid("redirect") }, pids);
    assert.equal(fake.requests("cbplus.search").at(-1)!.caller?.pid, cbplusWorker, "the Click and Book Plus worker was replaced");
  } finally {
    writeFileSync(TOKEN_FILE, TOKEN_A);
  }
});

suite.test("after a platform rollback the token renewed in the environment outlives the file left behind", async (scope) => {
  const { fake, stack } = scope;
  fake.setFlights("cbplus", { origin: "LIM", destination: "CUZ" }, [
    { outbound: ["LA2047 LIM-CUZ 07:15-08:40"], price: 151.3, baggage: { carryOn: true, checked: 1 }, brand: "Plus" },
  ]);
  /* A rolled-back renewer writes only `CBPLUS_TOKEN` and restarts the units;
     the file keeps the last token the newer one installed, still valid but
     an hour older. */
  const leftBehind = fakeCbplusToken(FAKE_CBPLUS_TERMINAL_ID, Date.now() - 60 * 60_000);
  const renewed = fakeCbplusToken(FAKE_CBPLUS_TERMINAL_ID, Date.now());
  writeFileSync(TOKEN_FILE, leftBehind);
  try {
    await stack.restart("runner", { env: { CBPLUS_TOKEN: renewed } });
    await stack.restart("redirect", { env: { CBPLUS_TOKEN: renewed } });
    const api = await scope.api();
    const { job } = await followSearchJob(api, await startSearch(api, searchPayloads.exact("LIM", "CUZ", day(205))));
    assert.deepEqual(fake.requests("cbplus.search").map((request) => (request.body as { token?: unknown }).token), [renewed], "the search used the token left in the file");
    const fare = searchOffers(job).find((offer) => offer.providerSource === "costamar");
    assert.ok(fare, "no Click and Book Plus fare");
    const { response } = await openPurchasePath(api, purchasePathOf(fare));
    assert.equal(response.status, 302);
    assert.equal(new URL(response.headers.get("location") ?? "").searchParams.get("token"), renewed, "the redirect carries the token left in the file");
  } finally {
    writeFileSync(TOKEN_FILE, TOKEN_A);
    await stack.restart("runner", { env: { CBPLUS_TOKEN: TOKEN_A } });
    await stack.restart("redirect", { env: { CBPLUS_TOKEN: TOKEN_A } });
  }
});

/* ---- The cache file ---- */

suite.test("a cache file an earlier release left mostly free is compacted before the runner opens, and keeps its searches", async (scope) => {
  const { fake, stack } = scope;
  /* A file this release creates hands freed pages back from its first page. */
  assert.equal(pageStats(sessionDbPath()).autoVacuum, 2, "a new cache file has no incremental vacuum");
  fake.setFlights("both", { origin: "LIM", destination: "CUZ" }, CUSCO);
  const api = await scope.api();
  const { job } = await followSearchJob(api, await startSearch(api, searchPayloads.exact("LIM", "CUZ", day(210), day(214))));
  assert.equal(searchOffers(job).length, 4);
  const path = purchasePathOf(searchOffers(job).find((offer) => offer.providerSource === "agil-local")!);
  assert.equal((await openPurchasePath(api, path)).response.status, 302);

  /* What production ran on: a file written before the store chose a vacuum
     mode, which SQLite then fixes at none, and whose sweeps freed most of it. */
  let before = pageStats(sessionDbPath());
  await stack.restart("runner", {
    beforeLaunch: () => {
      writeSqlite(sessionDbPath(), [
        { sql: "PRAGMA auto_vacuum = NONE" },
        { sql: "VACUUM" },
        { sql: "CREATE TABLE e2e_swept (payload BLOB)" },
        { sql: "INSERT INTO e2e_swept (payload) SELECT randomblob(65536) FROM (WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400) SELECT i FROM n)" },
        { sql: "DROP TABLE e2e_swept" },
        { sql: "PRAGMA wal_checkpoint(TRUNCATE)" },
      ]);
      before = pageStats(sessionDbPath());
      assert.equal(before.autoVacuum, 0);
      assert.ok(before.freePages * 2 > before.pageCount, `only ${before.freePages} of ${before.pageCount} pages are free`);
    },
  });

  const after = pageStats(sessionDbPath());
  assert.equal(after.autoVacuum, 2, "the file was left without incremental vacuum");
  assert.ok(after.pageCount * 4 < before.pageCount, `the file went from ${before.pageCount} to ${after.pageCount} pages`);
  assert.match(stack.logs("runner"), /Fly Desk session cache compacted: .*autoVacuum=0->2/);

  /* The search and its purchase path read back from the compacted file. */
  fake.clearRequests();
  const stored = await readSearchJob(api, job.searchJobId);
  assert.deepEqual(searchOffers(stored).map((offer) => offer.id), searchOffers(job).map((offer) => offer.id));
  assert.equal((await openPurchasePath(api, path)).response.status, 302);
  assert.deepEqual(fake.requests((request) => PROVIDER_SEARCH_OPS.includes(request.op)).map((request) => request.op), [], "reading back searched again");
});
