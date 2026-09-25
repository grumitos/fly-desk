import assert from "node:assert/strict";
import { openPurchasePath, purchasePathOf, readSearchJob, searchOffers, type SearchJob } from "./support/api-client.ts";
import { runSearch, waitForResults } from "./support/flows.ts";
import { defineSuite, type TestScope, type TrackedContext } from "./support/harness.ts";
import type { OfferSpec } from "./support/fixtures.ts";
import { day, eventually, providerSearches, sleep } from "./support/scenario.ts";
import { notice, readCards, results, searchForm, searchLink } from "./support/ui.ts";

/*
 * What the desk does when providers fail and when the agent changes their
 * mind: one line that names the provider, nothing a provider said reaching
 * the page or the logs, and a stop that stops the work behind it.
 */

const suite = defineSuite({ file: import.meta.filename });

const SANTIAGO: OfferSpec[] = [
  { outbound: ["LA2371 LIM-SCL 07:50-13:25"], price: 214, baggage: { carryOn: true, checked: 0 }, seats: 8 },
  { outbound: ["JA150 LIM-SCL 09:00-14:30"], price: 199, baggage: { carryOn: true, checked: 0 }, seats: 6 },
  { outbound: ["H2 5561 LIM-SCL 01:20-06:55"], price: 176, baggage: { carryOn: true, checked: 0 }, seats: 5, gds: 3 },
];

/* A value no provider response should ever carry out of the backend. */
function canary(label: string): string {
  return `E2E-CANARY-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The canary appears nowhere a person or an operator could read it. */
async function assertCanaryContained(scope: TestScope, tracked: TrackedContext, secret: string): Promise<void> {
  for (const record of tracked.pages) {
    if (!record.page.isClosed()) {
      assert.ok(!(await record.page.content()).includes(secret), "the canary reached the DOM");
      assert.ok(!(await record.page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).includes(secret), "the canary reached web storage");
    }
  }
  assert.ok(!tracked.consoleText().includes(secret), "the canary reached the console");
  const leakingAnswers = (await tracked.apiBodies()).filter((entry) => entry.body.includes(secret)).map((entry) => entry.url);
  assert.deepEqual(leakingAnswers, [], "the canary reached an /api answer");
  assert.ok(!scope.stack.logs().includes(secret), "the canary reached a service log");
}

suite.test("a provider that falls is named in one line, and nothing it said reaches the desk", async (scope) => {
  const { fake } = scope;
  const secret = canary("503");
  fake.setFlights("both", { origin: "LIM", destination: "SCL" }, SANTIAGO);
  fake.fail("cbplus.search", { status: 503, body: { message: `Upstream maintenance ${secret}`, detail: secret } });
  fake.fail("agil.search", { reset: true }, { where: (request) => request.query?.gds === 3 });

  const departure = day(31);
  const { tracked, page } = await scope.signedInPage(searchLink({ mode: "exact", trip: "one-way", origin: "LIM", destination: "SCL", departure }));
  const cards = await waitForResults(page, 2);

  /* The list is Agil's, minus the GDS that dropped the connection. */
  assert.deepEqual(cards.map((card) => `${card.airline}:${card.amount}:${card.provider}`), ["JetSmart:199:Agilsmart", "LATAM:214:Agilsmart"]);
  const line = await notice.line(page).innerText();
  assert.match(line, /Resultados incompletos/);
  assert.match(line, /Click and Book Plus/);
  assert.doesNotMatch(line, /Agilsmart/, "a GDS that failed while the others answered is not a failed provider");

  /* The backend's account of the same search. */
  const job = (await tracked.apiBodies())
    .filter((entry) => new URL(entry.url).pathname.startsWith("/api/search"))
    .map((entry) => JSON.parse(entry.body) as SearchJob)
    .find((candidate) => candidate.searchComplete);
  assert.ok(job, "the finished job never reached the page");
  assert.deepEqual(
    (job.providerDiagnostics ?? []).map((entry) => `${entry.providerId}:${entry.status}`).sort(),
    ["agil-local:completed", "costamar:failed"],
  );
  assert.ok((job.warnings ?? []).some((warning) => /GDS 3/.test(warning)), JSON.stringify(job.warnings));
  const route = { origin: "LIM", destination: "SCL", departureDate: departure };
  assert.deepEqual(providerSearches(fake, route).filter((request) => request.op === "cbplus.search").map((request) => request.status), [503]);
  assert.deepEqual(providerSearches(fake, route).filter((request) => request.query?.gds === 3).map((request) => request.status), [0]);

  await assertCanaryContained(scope, tracked, secret);
});

suite.test("a token refused inside a 200 leaves the other provider's list and leaks nothing", async (scope) => {
  const { fake } = scope;
  const secret = canary("401");
  fake.setFlights("both", { origin: "LIM", destination: "SCL" }, SANTIAGO);
  fake.fail("cbplus.search", { status: 200, body: { status: 401, message: `Token invalido ${secret}` } });

  const departure = day(32);
  const { tracked, page } = await scope.signedInPage(searchLink({ mode: "exact", trip: "one-way", origin: "LIM", destination: "SCL", departure }));
  const cards = await waitForResults(page, 3);
  assert.ok(cards.every((card) => card.provider === "Agilsmart"));
  const job = (await tracked.apiBodies())
    .filter((entry) => new URL(entry.url).pathname.startsWith("/api/search"))
    .map((entry) => JSON.parse(entry.body) as SearchJob)
    .find((candidate) => candidate.searchComplete);
  assert.ok((job?.warnings ?? []).some((warning) => /Click and Book Plus rejected this search/.test(warning)), JSON.stringify(job?.warnings));
  assert.equal(job?.searchMeta?.partial, true);
  await assertCanaryContained(scope, tracked, secret);
});

suite.test("a token refused inside a 200 is named in the notice", async (scope) => {
  const { fake } = scope;
  fake.setFlights("both", { origin: "LIM", destination: "SCL" }, SANTIAGO);
  fake.fail("cbplus.search", { status: 200, body: { status: 401, message: "Token invalido" } });
  const { page } = await scope.signedInPage(searchLink({ mode: "exact", trip: "one-way", origin: "LIM", destination: "SCL", departure: day(33) }));
  await waitForResults(page, 3);
  await notice.line(page).waitFor({ timeout: 3_000 });
  assert.match(await notice.line(page).innerText(), /Click and Book Plus/);
}, {
  todo: "production bug: a Click and Book Plus rejection inside a 200 is recorded as a warning with the provider «completed» (src/local-costamar.ts:4205, src/http-router.ts:2681), and frontend/src/lib/search-outcome.ts:72 only names providers whose status is «failed», so the agent is never told a provider was left out",
});

suite.test("with both providers down the desk says nothing was searched instead of drawing an empty route", async (scope) => {
  const { fake } = scope;
  const secret = canary("down");
  fake.setFlights("both", { origin: "LIM", destination: "SCL" }, SANTIAGO);
  fake.fail("cbplus.search", { status: 503, body: { message: secret } });
  fake.fail("agil.startSearch", { status: 503, body: { message: secret } });
  fake.fail("agil.search", { status: 503, body: { message: secret } });

  const departure = day(34);
  const { tracked, page } = await scope.signedInPage(searchLink({ mode: "exact", trip: "one-way", origin: "LIM", destination: "SCL", departure }));
  await results.emptyTitle(page, "No se pudo consultar a los proveedores").waitFor({ timeout: 30_000 });
  await results.editSearchFromEmpty(page).waitFor();
  const line = await notice.line(page).innerText();
  assert.match(line, /No se pudo consultar a ningún proveedor/);
  assert.match(line, /Agilsmart/);
  assert.match(line, /Click and Book Plus/);
  assert.equal(await results.cards(page).count(), 0);
  assert.equal(await results.emptyTitle(page, "Sin resultados para esta consulta").count(), 0, "a failed search was drawn as an empty route");

  const route = { origin: "LIM", destination: "SCL", departureDate: departure };
  assert.ok(providerSearches(fake, route).length > 0);
  assert.ok(providerSearches(fake, route).every((request) => request.status === 503));
  await assertCanaryContained(scope, tracked, secret);
});

/* ---- Stopping ---- */

const STOP_DAYS = 6;
/* Agil answers the three flights over two GDS ids, Click and Book Plus all three. */
const FIRST_DAY_FARES = 6;

function stopRange(first: number): { link: string; days: string[] } {
  const days = Array.from({ length: STOP_DAYS }, (_, index) => day(first + index));
  return {
    days,
    link: searchLink({ mode: "flexible", trip: "one-way", origin: "LIM", destination: "SCL", departureStart: days[0], departureEnd: days.at(-1) }),
  };
}

/* The pooled worker hears about a cancellation on its client's 500 ms poll
   (`src/search-worker-client.ts`); there is nothing to observe until then. */
const CANCELLATION_PROPAGATION_MS = 1_200;

suite.test("stopping a search halts its fan-out, keeps what it had, and running it again starts from that", async (scope) => {
  const { fake } = scope;
  fake.setFlights("both", { origin: "LIM", destination: "SCL" }, SANTIAGO);
  const { days, link } = stopRange(60);
  /* The first day answers; every later day waits at its provider. */
  const later = fake.hold("*", (request) => (request.op === "agil.search" || request.op === "cbplus.search") && request.query?.departureDate !== days[0]);
  const { tracked, page } = await scope.signedInPage(link);
  await searchForm.submit(page).waitFor();
  const started = await runSearch<SearchJob>(page);
  await eventually(async () => assert.equal(await results.cards(page).count(), FIRST_DAY_FARES));
  await eventually(() => assert.ok(later.seen > 0, "no later day reached a provider"));

  await searchForm.stop(page).click();
  await results.stoppedPill(page).waitFor();
  assert.match(await notice.line(page).innerText(), /Búsqueda detenida/);
  const cancel = await eventually(() => {
    const request = tracked.apiRequests.find((entry) => entry.method === "POST" && new URL(entry.url).pathname === `/api/search/${started.searchJobId}/cancel`);
    assert.ok(request, "the stop sent no cancel");
    return request;
  });
  assert.equal(new URL(cancel.url).searchParams.get("cachePartial"), "1");

  /* Only once the worker has heard of it do the providers answer. */
  await sleep(CANCELLATION_PROPAGATION_MS);
  const asked = new Set(providerSearches(fake).map((request) => request.query?.departureDate));
  later.release();
  await eventually(() => assert.ok(providerSearches(fake).every((request) => request.status !== undefined), "a held request never answered"));
  await sleep(CANCELLATION_PROPAGATION_MS);
  const askedAfter = new Set(providerSearches(fake).map((request) => request.query?.departureDate));
  assert.deepEqual([...askedAfter].sort(), [...asked].sort(), "a stopped search asked a provider for another day");
  assert.ok(asked.size < STOP_DAYS, `all ${asked.size} days were asked`);
  /* In-flight provider calls are not aborted: the pooled worker cancels
     cooperatively, so what was asked runs to its answer. */
  assert.equal(fake.requests((request) => request.aborted).length, 0);

  /* The backend kept the partial list as a finished, reusable result. */
  const api = await scope.api();
  const stopped = await readSearchJob(api, started.searchJobId);
  assert.equal(stopped.searchStatus, "completed");
  assert.equal(stopped.searchMeta?.searchState, "search_partial");
  assert.equal(searchOffers(stopped).length, FIRST_DAY_FARES);
  assert.deepEqual((await readCards(page)).map((card) => card.amount), [176, 176, 199, 199, 214, 214]);

  /* Again: the partial list is on screen before any provider has answered. */
  fake.clearRequests();
  const everything = fake.hold("*", (request) => request.op === "agil.search" || request.op === "cbplus.search");
  const rerun = await runSearch<SearchJob>(page);
  assert.equal(rerun.searchMeta?.searchState, "search_cached");
  assert.equal(searchOffers(rerun).length, FIRST_DAY_FARES);
  await eventually(async () => assert.equal(await results.cards(page).count(), FIRST_DAY_FARES));
  assert.ok(providerSearches(fake).every((request) => request.status === undefined), "a provider answered before the cached list was drawn");
  everything.release();
  await waitForResults(page, STOP_DAYS * FIRST_DAY_FARES);
});

suite.test("closing the tab mid-search cancels it and keeps its purchase paths working", async (scope) => {
  const { fake } = scope;
  fake.setFlights("both", { origin: "LIM", destination: "SCL" }, SANTIAGO);
  const { days, link } = stopRange(70);
  fake.hold("*", (request) => (request.op === "agil.search" || request.op === "cbplus.search") && request.query?.departureDate !== days[0]);
  const { tracked, page } = await scope.signedInPage(link);
  await searchForm.submit(page).waitFor();
  const started = await runSearch<SearchJob>(page);
  await eventually(async () => assert.equal(await results.cards(page).count(), FIRST_DAY_FARES));

  await tracked.closeTabAsUser(page);
  const api = await scope.api();
  const closed = await eventually(async () => {
    const job = await readSearchJob(api, started.searchJobId);
    assert.notEqual(job.searchStatus, "running", "closing the tab left the search running");
    return job;
  }, { timeoutMs: 5_000 });
  assert.equal(closed.searchStatus, "completed");
  assert.equal(closed.searchMeta?.searchState, "search_partial");
  assert.ok((closed.searchMeta?.warnings ?? []).includes("Search stopped because the page was refreshed."));

  /* A fare the page had already shown can still be bought. */
  const agilOffer = searchOffers(closed).find((offer) => offer.providerSource === "agil-local");
  const cbplusOffer = searchOffers(closed).find((offer) => offer.providerSource === "costamar");
  assert.ok(agilOffer && cbplusOffer);
  for (const offer of [agilOffer, cbplusOffer]) {
    const { response } = await openPurchasePath(api, purchasePathOf(offer));
    assert.equal(response.status, 302, `${offer.providerSource} /r answered ${response.status}`);
    assert.match(response.headers.get("location") ?? "", /^https:\/\//);
  }
});

suite.test("stopping before the search request has returned still cancels the search", async (scope) => {
  const { fake } = scope;
  fake.setFlights("both", { origin: "LIM", destination: "SCL" }, SANTIAGO);
  const { link } = stopRange(80);
  fake.hold("*", (request) => request.op === "agil.search" || request.op === "cbplus.search");
  const { tracked, page } = await scope.signedInPage(link);

  /* The request reaches the server and starts the job; its answer is held
     back from the page, so «Detener» is pressed while it is still in flight. */
  let startedJobId = "";
  let answerPage: () => void = () => undefined;
  const pageMayHaveIt = new Promise<void>((resolve) => {
    answerPage = resolve;
  });
  await tracked.context.route((url) => url.pathname === "/api/search", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const answer = await route.fetch();
    const body = await answer.text();
    startedJobId = (JSON.parse(body) as SearchJob).searchJobId;
    await pageMayHaveIt;
    await route.fulfill({ response: answer, body }).catch(() => undefined);
  });
  await searchForm.submit(page).click();
  await eventually(() => assert.ok(startedJobId && providerSearches(fake).length > 0, "the search never reached a provider"));
  await searchForm.stop(page).click();
  answerPage();

  const api = await scope.api();
  await eventually(async () => {
    const job = await readSearchJob(api, startedJobId);
    assert.notEqual(job.searchStatus, "running", "the stopped search is still running on the server");
  }, { timeoutMs: 5_000 });
}, {
  todo: "frontend fix in progress: useSearch cancels only jobs registered by onJobStart (frontend/src/hooks/useSearch.ts:72, frontend/src/lib/api.ts:1510), which runs after POST /api/search answers, so a stop pressed while it is in flight aborts the fetch and never sends the cancel",
});
