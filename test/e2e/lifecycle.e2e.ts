import assert from "node:assert/strict";
import { buildCommercialQuotation } from "../../src/core/quotation.ts";
import type { SearchRequest } from "../../src/core/types.ts";
import {
  followSearchJob,
  readSearchJob,
  searchOffers,
  searchPayloads,
  startSearch,
  type ApiSession,
  type SearchJob,
} from "./support/api-client.ts";
import { runSearch, startedJob, waitForIdleCapacity, waitForResults } from "./support/flows.ts";
import { defineSuite, type TestScope } from "./support/harness.ts";
import type { OfferSpec } from "./support/fixtures.ts";
import {
  assertProviderWorkStopped,
  day,
  eventually,
  holdProviderSearches,
  providerSearches,
} from "./support/scenario.ts";
import { pastedQuotation, searchForm, searchLink, topBar } from "./support/ui.ts";

/*
 * Every way a search ends gives its capacity back once, and stops the work
 * behind it: it completes or its providers fail, the agent replaces it, its
 * page goes silent or loses its session, it waits for capacity and its page
 * goes away, a provider hangs, the runner restarts or is stopped the way a
 * deployment stops it. «Detener» and a closed tab are in `resilience.e2e.ts`.
 *
 * The runner stops a job nobody has followed for its lease, here 3 s instead
 * of 90. A page that goes silent can leave a poll parked for its 15 s, so the
 * providers' deadlines are a minute here, where a held request cannot end a
 * search first; the test of a hanging provider sets them to their shortest.
 */
const suite = defineSuite({
  file: import.meta.filename,
  stack: {
    serviceEnv: {
      runner: {
        FLY_DESK_SEARCH_JOB_LEASE_MS: "3000",
        AGIL_HTTP_TIMEOUT_MS: "60000",
        CBPLUS_HTTP_TIMEOUT_MS: "60000",
      },
    },
  },
});

/* The runner's words for a job it stopped because nobody followed it, and
   for the jobs a restart stopped. */
const UNFOLLOWED = "Search stopped because its page stopped following it.";
const RESTARTED = "Search stopped because Fly Desk was restarted.";

const CUSCO: OfferSpec[] = [
  { outbound: ["LA2045 LIM-CUZ 05:40-07:05"], inbound: ["LA2046 CUZ-LIM 08:10-09:35"], price: 142.8, baggage: { carryOn: true, checked: 0 }, seats: 7 },
  { outbound: ["H2 5102 LIM-CUZ 06:25-07:50"], inbound: ["H2 5103 CUZ-LIM 09:15-10:40"], price: 118.4, baggage: { carryOn: true, checked: 0 }, seats: 4, gds: 1 },
];

function providerStatuses(job: SearchJob): string[] {
  return (job.providerDiagnostics ?? []).map((entry) => `${entry.providerId}:${entry.status}`);
}

/** A one-way range the desk runs from its link, held at its providers until the test lets it go. */
async function deskRangeHeldAtItsProviders(scope: TestScope, route: { origin: string; destination: string }, first: number) {
  const held = holdProviderSearches(scope.fake, route);
  const { tracked, page } = await scope.signedInPage(searchLink({
    mode: "flexible",
    trip: "one-way",
    ...route,
    departureStart: day(first),
    departureEnd: day(first + 5),
  }));
  await searchForm.submit(page).waitFor();
  const job = await runSearch<SearchJob>(page);
  return { held, tracked, page, job };
}

async function stoppedByTheRunner(api: ApiSession, jobId: string): Promise<SearchJob> {
  const job = await eventually(async () => {
    const current = await readSearchJob(api, jobId);
    assert.notEqual(current.searchStatus, "running", "the runner still runs a search nobody follows");
    return current;
  }, { timeoutMs: 40_000, message: "the runner stopped the search nobody followed" });
  assert.ok((job.searchMeta?.warnings ?? []).includes(UNFOLLOWED), `stopped for another reason: ${job.searchMeta?.warnings?.join(" | ")}`);
  return job;
}

suite.test("a search that completes, and one whose providers both fail, give their capacity back", async (scope) => {
  const { fake } = scope;
  fake.setFlights("both", { origin: "LIM", destination: "CUZ" }, CUSCO);
  const api = await scope.api();
  const completed = await followSearchJob(api, await startSearch(api, searchPayloads.exact("LIM", "CUZ", day(30), day(34))));
  assert.equal(completed.job.searchStatus, "completed");
  assert.equal(searchOffers(completed.job).length, 4);
  await waitForIdleCapacity(api);

  fake.fail("agil.search", { status: 503 });
  fake.fail("cbplus.search", { status: 503 });
  const failed = await followSearchJob(api, await startSearch(api, searchPayloads.range("LIM", "CUZ", day(35), day(36))));
  assert.deepEqual(providerStatuses(failed.job), ["agil-local:failed", "costamar:failed"]);
  await waitForIdleCapacity(api);
});

suite.test("a new search in the same tab stops the one it replaces, which asks its providers nothing more", async (scope) => {
  const { fake, stack } = scope;
  fake.setFlights("both", { origin: "LIM", destination: "CUZ" }, CUSCO);
  const api = await scope.api();
  /* What the agent pastes: a fare quoted from an earlier search, dated in full. */
  const departure = day(40);
  const returning = day(44);
  const quoted = await followSearchJob(api, await startSearch(api, searchPayloads.exact("LIM", "CUZ", departure, returning)));
  const request = (quoted.job as SearchJob & { request: SearchRequest }).request;
  const dated = (text: string, iso: string) =>
    text.replace(new RegExp(`· (0?${Number(iso.slice(8))} [a-záéíóú]+) ·`, "g"), `· $1 ${iso.slice(0, 4)} ·`);
  const quotationText = dated(dated(buildCommercialQuotation(searchOffers(quoted.job)[0]!, request), departure), returning);

  const route = { origin: "LIM", destination: "SCL" };
  const tracked = await scope.newContext({ signedIn: true, clipboard: true });
  const page = await tracked.newPage();
  const held = holdProviderSearches(fake, route);
  await page.goto(`${stack.baseUrl}${searchLink({ mode: "flexible", trip: "one-way", ...route, departureStart: day(50), departureEnd: day(55) })}`);
  await searchForm.submit(page).waitFor();
  const replaced = await runSearch<SearchJob>(page);
  await eventually(() => assert.ok(held.seen > 0, "the first search never reached its providers"));

  await page.evaluate((text) => navigator.clipboard.writeText(text), quotationText);
  await topBar.pasteConfig(page).click();
  await pastedQuotation.search(page).waitFor();
  const replacing = await startedJob<SearchJob>(page, () => pastedQuotation.search(page).click());
  assert.notEqual(replacing.searchJobId, replaced.searchJobId);

  assert.equal((await readSearchJob(api, replaced.searchJobId)).searchStatus, "cancelled");
  await assertProviderWorkStopped(fake, route);
  await waitForResults(page, 4);
  await waitForIdleCapacity(api);
  held.release();
});

suite.test("a page that goes silent, its network lost or its laptop asleep, has its search stopped once nobody follows it", async (scope) => {
  const route = { origin: "LIM", destination: "SCL" };
  const { held, tracked, job } = await deskRangeHeldAtItsProviders(scope, route, 60);
  await eventually(() => assert.ok(held.seen > 0, "the search never reached its providers"));
  await tracked.context.setOffline(true);

  const api = await scope.api();
  await stoppedByTheRunner(api, job.searchJobId);
  await assertProviderWorkStopped(scope.fake, route);
  await waitForIdleCapacity(api);
  held.release();
});

suite.test("a page whose session ends, signed out or expired, has its search stopped once nobody follows it", async (scope) => {
  const { stack } = scope;
  const route = { origin: "LIM", destination: "SCL" };
  const { held, page, job } = await deskRangeHeldAtItsProviders(scope, route, 70);
  await eventually(() => assert.ok(held.seen > 0, "the search never reached its providers"));
  const out = await page.request.post(`${stack.baseUrl}/logout`, { maxRedirects: 0 });
  assert.equal(out.status(), 303);

  /* The page's next poll is refused and sends it to the sign-in; its search
     goes on until the runner sees nobody follows it. */
  await page.waitForURL((url) => url.pathname === "/login", { timeout: 30_000 });
  const api = await scope.api();
  await stoppedByTheRunner(api, job.searchJobId);
  await assertProviderWorkStopped(scope.fake, route);
  await waitForIdleCapacity(api);
  held.release();
});

suite.test("a search waiting for capacity whose page goes silent leaves the queue once nobody follows it, and never starts", async (scope) => {
  const { fake } = scope;
  /* The other agent's two short ranges fill heavy work, followed all along. */
  const other = await scope.api();
  const blockers = [{ origin: "LIM", destination: "BOG" }, { origin: "LIM", destination: "AQP" }];
  const gates = blockers.map((route) => holdProviderSearches(fake, route));
  const followed: Array<Promise<unknown>> = [];
  for (const [index, route] of blockers.entries()) {
    const job = await startSearch(other, searchPayloads.range(route.origin, route.destination, day(80 + index * 2), day(81 + index * 2)));
    followed.push(followSearchJob(other, job, 120_000));
  }
  await eventually(() => assert.ok(gates.every((gate) => gate.seen > 0), "a blocker never reached its providers"));

  const route = { origin: "LIM", destination: "SCL" };
  const { tracked, job } = await deskRangeHeldAtItsProviders(scope, route, 90);
  assert.equal(job.queued, true, "the search did not wait for capacity");
  await tracked.context.setOffline(true);

  await stoppedByTheRunner(other, job.searchJobId);
  await eventually(async () => assert.equal((await readSearchJob(other, job.searchJobId)).queued, false));
  gates.forEach((gate) => gate.release());
  await Promise.all(followed);
  await waitForIdleCapacity(other);
  assert.deepEqual(providerSearches(fake, route).map((request) => request.seq), [], "the search that left the queue reached a provider");
});

suite.test("a provider that hangs is hung up on at its deadline, and the search gives its capacity back", async (scope) => {
  const { fake, stack } = scope;
  await stack.restart("runner", { env: { AGIL_HTTP_TIMEOUT_MS: "5000", CBPLUS_HTTP_TIMEOUT_MS: "5000" } });
  try {
    fake.fail("agil.search", { hang: true });
    fake.fail("cbplus.search", { hang: true });
    const api = await scope.api();
    const route = { origin: "LIM", destination: "CUZ", departureDate: day(100) };
    const startedAt = Date.now();
    const { job } = await followSearchJob(api, await startSearch(api, searchPayloads.exact("LIM", "CUZ", day(100))), 30_000);
    assert.deepEqual(providerStatuses(job), ["agil-local:failed", "costamar:failed"]);
    assert.ok(Date.now() - startedAt < 12_000, `the search took ${Date.now() - startedAt} ms against a 5 s deadline`);
    const made = await assertProviderWorkStopped(fake, route);
    assert.ok(made.length > 0 && made.every((request) => request.aborted), "a hung provider request was never hung up on");
    await waitForIdleCapacity(api);
  } finally {
    await stack.restart("runner", { env: { AGIL_HTTP_TIMEOUT_MS: undefined, CBPLUS_HTTP_TIMEOUT_MS: undefined } });
  }
});

suite.test("a runner restarted mid-search starts idle, asks nothing more for that search, and restores only finished ones", async (scope) => {
  const { fake, stack } = scope;
  fake.setFlights("both", { origin: "LIM", destination: "CUZ" }, CUSCO);
  const api = await scope.api();
  const finished = await followSearchJob(api, await startSearch(api, searchPayloads.exact("LIM", "CUZ", day(110), day(114))));

  const route = { origin: "LIM", destination: "SCL" };
  const held = holdProviderSearches(fake, route);
  const running = await startSearch(api, searchPayloads.range("LIM", "SCL", day(120), day(125)));
  const followed = followSearchJob(api, running, 60_000).catch(() => undefined);
  await eventually(() => assert.ok(held.seen > 0, "the search never reached its providers"));

  await stack.restart("runner");
  await assertProviderWorkStopped(fake, route);
  await waitForIdleCapacity(api);
  /* It is not running any more: stopped with the runner, or gone with it. */
  const after = await api.fetch(`/api/search/${encodeURIComponent(running.searchJobId)}`);
  const body = await after.text();
  assert.ok(after.status === 404 || (JSON.parse(body) as SearchJob).searchStatus !== "running", `the search still runs after the restart: ${after.status}`);
  await followed;

  /* The finished search reads back from the new runner, which holds nothing for it. */
  const restored = await readSearchJob(api, finished.job.searchJobId);
  assert.equal(restored.searchStatus, "completed");
  assert.equal(searchOffers(restored).length, 4);
  await waitForIdleCapacity(api);
  held.release();
});

suite.test("a runner stopped the way a deployment stops it tells a running search's page what it found and why it stopped, blaming no provider", async (scope) => {
  const { fake, stack } = scope;
  const route = { origin: "LIM", destination: "CUZ" };
  fake.setFlights("both", route, CUSCO);
  const [answered, waiting] = [day(130), day(131)];
  const held = holdProviderSearches(fake, { ...route, departureDate: waiting });
  const api = await scope.api();
  const started = await startSearch(api, searchPayloads.range("LIM", "CUZ", answered, waiting));
  const followed = followSearchJob(api, started, 60_000);
  /* Its first day is in from both providers; its second waits at both. */
  const found = await eventually(async () => {
    const job = await readSearchJob(api, started.searchJobId);
    assert.deepEqual([...new Set(searchOffers(job).map((offer) => offer.providerSource))].sort(), ["agil-local", "costamar"]);
    const asked = providerSearches(fake, { ...route, departureDate: waiting }).map((request) => request.op);
    assert.deepEqual([...new Set(asked)].sort(), ["agil.search", "cbplus.search"]);
    return searchOffers(job).length;
  }, { message: "the first day answered by both providers and the second asked of both" });

  /* What a deployment does: SIGTERM, to the runner and its workers at once. */
  await stack.restart("runner");

  /* The page following it was answered before the runner went, and the new
     runner reads the same. */
  const { job: told } = await followed;
  const restored = await readSearchJob(api, started.searchJobId);
  for (const job of [told, restored]) {
    assert.equal(job.searchStatus, "completed");
    assert.equal(job.searchMeta?.searchState, "search_partial");
    assert.ok(job.searchMeta?.warnings?.includes(RESTARTED), `stopped for another reason: ${job.searchMeta?.warnings?.join(" | ")}`);
    assert.equal(searchOffers(job).length, found, "the restart lost fares the search had found");
    assert.deepEqual(providerStatuses(job).filter((status) => status.endsWith(":failed")), [], "the restart was read as a provider failure");
  }
  await assertProviderWorkStopped(fake, { ...route, departureDate: waiting });
  await waitForIdleCapacity(api);
  held.release();
}, process.platform === "win32" ? { skip: "a stop on Windows is TerminateProcess, which no process can intercept" } : {});
