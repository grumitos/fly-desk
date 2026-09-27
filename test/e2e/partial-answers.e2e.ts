import assert from "node:assert/strict";
import type { Page } from "playwright";
import {
  readMatrixJob,
  readSearchJob,
  type JobProviderDiagnostics,
  type MatrixJob,
  type SearchJob,
} from "./support/api-client.ts";
import type { RecordedRequest } from "./support/fake-upstream.ts";
import { ageStoredFares, runSearch, startedJob, waitForResults } from "./support/flows.ts";
import { defineSuite, type TestScope, type TrackedContext } from "./support/harness.ts";
import type { OfferSpec, SearchQuery } from "./support/fixtures.ts";
import { addDays, AGIL_GDS_IDS, day, providerSearches } from "./support/scenario.ts";
import { detail, notice, quotation, results, searchForm, searchLink } from "./support/ui.ts";

/*
 * A provider that answers only in part, and one that answers nothing. Agil
 * answers per GDS, and a GDS whose connection drops is asked once more, on a
 * connection of its own, so the list keeps every fare; a Click and Book Plus
 * search, a quote's revalidation among them, is asked again the same way. A
 * GDS that never answers a day, a cell, or before Agil's deadline leaves the
 * list short, and the desk says so in its one line instead of presenting the
 * search as complete. A provider none of whose parts answered (no GDS, no day
 * of a range, no cell of a flexible round trip) has failed, and the line
 * names it as one that did not answer. Agil's deadline is the shortest the
 * backend accepts, so a stalled GDS costs five seconds.
 */

const AGIL_DEADLINE_MS = 5_000;
const suite = defineSuite({
  file: import.meta.filename,
  stack: { env: { AGIL_HTTP_TIMEOUT_MS: String(AGIL_DEADLINE_MS) } },
});

const STAY_NIGHTS = 7;

/* One Agil fare a GDS a day, each on flights of its own, so a GDS that is left
   out of a day takes exactly one row with it. Click and Book Plus has none. */
function oneFarePerGds(days: readonly string[]): (query: SearchQuery) => OfferSpec[] {
  return (query) => {
    const dayIndex = days.indexOf(query.departureDate);
    const gdsIndex = AGIL_GDS_IDS.indexOf(query.gds as (typeof AGIL_GDS_IDS)[number]);
    if (dayIndex < 0 || gdsIndex < 0) return [];
    const departs = String(6 + gdsIndex).padStart(2, "0");
    const arrives = String(11 + gdsIndex).padStart(2, "0");
    const flight = 2400 + dayIndex * 10 + gdsIndex;
    return [{
      outbound: [`LA${flight} LIM-SCL ${departs}:00-${arrives}:30`],
      inbound: [`LA${flight + 1} SCL-LIM 15:00-17:40`],
      price: 180 + dayIndex * 10 + gdsIndex,
      baggage: { carryOn: true, checked: 0 },
      gds: query.gds,
    }];
  };
}

/* One fare a day, one way or there and back, from whichever provider is
   answering while the other fails; Agil's from its first GDS. */
const ONE_FARE: OfferSpec[] = [{
  outbound: ["JA150 LIM-SCL 09:00-14:30"],
  inbound: ["JA151 SCL-LIM 16:00-18:40"],
  price: 199,
  baggage: { carryOn: true, checked: 0 },
}];

function agilSearchFor(departureDate: string, gds: number): (request: RecordedRequest) => boolean {
  return (request) => request.op === "agil.search" && request.query?.departureDate === departureDate && request.query?.gds === gds;
}

function onDays(days: readonly string[]): (request: RecordedRequest) => boolean {
  return (request) => days.includes(request.query?.departureDate ?? "");
}

/** `providerId:status`, and `:partial` for one that completed without part of the search. */
function providerOutcomes(job: { providerDiagnostics?: JobProviderDiagnostics[] }): string[] {
  return (job.providerDiagnostics ?? [])
    .map((entry) => `${entry.providerId}:${entry.status}${entry.partial ? ":partial" : ""}`)
    .sort();
}

/** The finished job as the page last received it. */
async function finishedSearchJob(tracked: TrackedContext): Promise<SearchJob> {
  const job = (await tracked.apiBodies())
    .filter((entry) => new URL(entry.url).pathname.startsWith("/api/search"))
    .map((entry) => JSON.parse(entry.body) as SearchJob)
    .find((candidate) => candidate.searchComplete);
  assert.ok(job, "the finished job never reached the page");
  return job;
}

async function searchRange(scope: TestScope, days: readonly string[]) {
  const { page } = await scope.signedInPage(searchLink({
    mode: "flexible",
    trip: "one-way",
    origin: "LIM",
    destination: "SCL",
    departureStart: days[0],
    departureEnd: days.at(-1),
  }));
  await searchForm.submit(page).waitFor();
  const started = await runSearch<SearchJob>(page);
  return { page, started };
}

async function searchRoundTrips(scope: TestScope, days: readonly string[]) {
  const { page } = await scope.signedInPage(searchLink({
    mode: "flexible",
    trip: "round-trip",
    origin: "LIM",
    destination: "SCL",
    departureStart: days[0],
    departureEnd: days.at(-1),
    stayNights: STAY_NIGHTS,
    flexible: "exact-stay",
  }));
  await searchForm.submit(page).waitFor();
  const started = await runSearch<MatrixJob>(page, "/api/matrix");
  return { page, started };
}

/* A warning, not an error: the other provider's list is real. */
async function readWarningLine(page: Page): Promise<string> {
  await notice.line(page).waitFor({ timeout: 3_000 });
  assert.equal(await notice.error(page).count(), 0, "a list that stands was announced as an error");
  return notice.line(page).innerText();
}

suite.test("a GDS whose connection drops is asked once more on a connection of its own, and the range keeps every fare", async (scope) => {
  const { fake } = scope;
  const days = [day(130), day(131), day(132)];
  fake.setFlights("agil", { origin: "LIM", destination: "SCL" }, oneFarePerGds(days));
  const dropped = agilSearchFor(days[1]!, 3);
  fake.fail("agil.search", { reset: true }, { times: 1, where: dropped });

  const { page, started } = await searchRange(scope, days);
  await waitForResults(page, days.length * AGIL_GDS_IDS.length);
  assert.equal(await notice.line(page).count(), 0, "a GDS that answered the second time was reported");

  /* Dropped, then answered: the second attempt left the connection pool, so it
     does not ask the fake to keep its connection alive. */
  const attempts = fake.requests(dropped);
  assert.deepEqual(attempts.map((request) => request.status), [0, 200]);
  assert.notEqual(attempts[1]!.headers.connection, "keep-alive", "the second attempt went out on a pooled connection");
  const others = providerSearches(fake, { origin: "LIM", destination: "SCL" })
    .filter((request) => request.op === "agil.search" && !dropped(request));
  assert.equal(others.length, days.length * AGIL_GDS_IDS.length - 1, "another GDS was asked twice");
  assert.ok(others.every((request) => request.status === 200));

  const job = await readSearchJob(await scope.api(), started.searchJobId);
  assert.equal(job.searchStatus, "completed");
  assert.equal(job.searchMeta?.partial, false);
  assert.deepEqual(providerOutcomes(job), ["agil-local:completed", "costamar:completed"]);
  assert.match(scope.stack.logs("runner", scope.logMark), /Agil search GDS 3 sent again on a new connection/);
});

suite.test("a Click and Book Plus search whose connection drops is asked once more on a connection of its own, and so is a quote's revalidation", async (scope) => {
  const { fake } = scope;
  const departure = day(135);
  fake.setFlights("cbplus", { origin: "LIM", destination: "SCL" }, ONE_FARE);
  const dropTheNextSearch = () => fake.fail("cbplus.search", { reset: true }, { times: 1 });

  dropTheNextSearch();
  const { tracked, page } = await scope.signedInPage("/");
  const job = await startedJob<SearchJob>(page, async () => {
    await page.goto(`${scope.stack.baseUrl}${searchLink({ mode: "exact", trip: "one-way", origin: "LIM", destination: "SCL", departure })}`);
  });
  await waitForResults(page, ONE_FARE.length);
  assert.equal(await notice.line(page).count(), 0, "a search that answered the second time was reported");
  const searched = fake.requests("cbplus.search");
  assert.deepEqual(searched.map((request) => request.status), [0, 200]);
  assert.notEqual(searched[1]!.headers.connection, "keep-alive", "the second attempt went out on a pooled connection");

  /* A quote confirms a fare older than the window with a search of its own:
     dropped, it would leave the fare unconfirmed and the quote refused. */
  await ageStoredFares(scope.stack, job.searchJobId);
  dropTheNextSearch();
  await results.card(page, /Click and Book Plus$/).click();
  /* Read as it arrives: a body the restart cut off would never finish. */
  const quoted = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/quotation");
  await detail.quote(detail.surface(page)).click();
  await quotation.dialog(page).waitFor();
  assert.match(await quotation.dialog(page).innerText(), /US\$\s*199(?:\.00)? por adulto/);
  assert.deepEqual(fake.requests("cbplus.search").slice(searched.length).map((request) => request.status), [0, 200]);
  assert.equal((await quoted).status(), 200);
  assert.equal(tracked.apiRequests.filter((request) => new URL(request.url).pathname === "/api/quotation").length, 1);
  assert.equal(
    scope.stack.logs("runner", scope.logMark).match(/Click and Book Plus flight search sent again on a new connection/g)?.length,
    2,
  );
});

suite.test("a GDS that drops every connection for a day is named in the notice, and the rest of the range stays", async (scope) => {
  const { fake } = scope;
  const days = [day(140), day(141), day(142)];
  fake.setFlights("agil", { origin: "LIM", destination: "SCL" }, oneFarePerGds(days));
  const dropped = agilSearchFor(days[2]!, 7);
  fake.fail("agil.search", { reset: true }, { where: dropped });

  const { page, started } = await searchRange(scope, days);
  await waitForResults(page, days.length * AGIL_GDS_IDS.length - 1);
  const line = await readWarningLine(page);
  assert.match(line, /Resultados incompletos/);
  assert.match(line, /Agilsmart respondió en parte/);

  /* Asked once more after the first drop, and not again. */
  assert.deepEqual(fake.requests(dropped).map((request) => request.status), [0, 0]);

  const job = await readSearchJob(await scope.api(), started.searchJobId);
  assert.equal(job.searchStatus, "completed");
  assert.equal(job.searchMeta?.partial, true);
  assert.deepEqual(providerOutcomes(job), ["agil-local:completed:partial", "costamar:completed"]);
  assert.ok((job.warnings ?? []).some((warning) => /Agil GDS 7 omitted/.test(warning)), JSON.stringify(job.warnings));
  /* The service log names the day, the GDS and what became of it. */
  assert.match(
    scope.stack.logs("runner", scope.logMark),
    new RegExp(`Agil GDS 7 omitted: LIM-SCL ${days[2]} reason=\\S+ afterMs=\\d+ detail=ProviderUnansweredError: Agil search GDS 7 failed before receiving a response`),
  );
});

suite.test("a GDS that stalls past Agil's deadline is not asked again, and the desk says the answer came in part", async (scope) => {
  const { fake } = scope;
  const departure = day(150);
  fake.setFlights("agil", { origin: "LIM", destination: "SCL" }, oneFarePerGds([departure]));
  const stalled = agilSearchFor(departure, 10);
  fake.fail("agil.search", { hang: true }, { where: stalled });

  const { tracked, page } = await scope.signedInPage(searchLink({ mode: "exact", trip: "one-way", origin: "LIM", destination: "SCL", departure }));
  await waitForResults(page, AGIL_GDS_IDS.length - 1, AGIL_DEADLINE_MS + 30_000);
  await notice.line(page).waitFor({ timeout: 3_000 });
  assert.match(await notice.line(page).innerText(), /Agilsmart respondió en parte/);

  /* One request, which the backend gave up on at its deadline: a GDS that is
     slow to answer is left out, not asked again. */
  const attempts = fake.requests(stalled);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]!.aborted, true);

  const job = await finishedSearchJob(tracked);
  assert.deepEqual(providerOutcomes(job), ["agil-local:completed:partial", "costamar:completed"]);
  assert.match(scope.stack.logs("runner", scope.logMark), new RegExp(`Agil GDS 10 omitted: LIM-SCL ${departure} reason=timeout`));
});

suite.test("a flexible round trip names Agil when a GDS never answers one of its cells, and the cell keeps what another GDS answered", async (scope) => {
  const { fake } = scope;
  const days = [day(160), day(161), day(162), day(163)];
  const fares = oneFarePerGds(days);
  /* Each cell's fare comes from GDS 0; the second cell has a dearer one from
     GDS 1 as well. */
  fake.setFlights("agil", { origin: "LIM", destination: "SCL" }, (query) => (
    query.gds === 0 || (query.gds === 1 && query.departureDate === days[1]) ? fares(query) : []
  ));
  const dropped = agilSearchFor(days[1]!, 0);
  fake.fail("agil.search", { reset: true }, { where: dropped });

  const { page, started } = await searchRoundTrips(scope, days);
  const cards = await waitForResults(page, days.length);
  /* The second cell's fare is GDS 1's, the one that answered. */
  assert.deepEqual(cards.map((card) => card.amount).sort((left, right) => left - right), [180, 191, 200, 210]);
  assert.match(await readWarningLine(page), /Agilsmart respondió en parte/);

  assert.deepEqual(fake.requests(dropped).map((request) => request.status), [0, 0]);
  const job = await readMatrixJob(await scope.api(), started.matrixJobId);
  assert.equal(job.matrixStatus, "completed");
  assert.deepEqual(providerOutcomes(job), ["agil-local:completed:partial", "costamar:completed"]);
  assert.match(
    scope.stack.logs("runner", scope.logMark),
    new RegExp(`Agil GDS 0 omitted: LIM-SCL ${days[1]} -> ${addDays(days[1]!, STAY_NIGHTS)} reason=\\S+ afterMs=\\d+ detail=ProviderUnansweredError`),
  );
});

/* ---- A provider that answered nothing ---- */

suite.test("an exact search that no GDS answers fails Agil, named as not answering, and Click and Book Plus's list stands", async (scope) => {
  const { fake } = scope;
  const departure = day(170);
  fake.setFlights("cbplus", { origin: "LIM", destination: "SCL" }, ONE_FARE);
  fake.fail("agil.search", { reset: true }, { where: onDays([departure]) });

  const { tracked, page } = await scope.signedInPage(searchLink({ mode: "exact", trip: "one-way", origin: "LIM", destination: "SCL", departure }));
  const cards = await waitForResults(page, ONE_FARE.length);
  assert.ok(cards.every((card) => card.provider === "Click and Book Plus"));
  const line = await readWarningLine(page);
  assert.match(line, /Resultados incompletos/);
  assert.match(line, /Agilsmart no respondió/);
  assert.doesNotMatch(line, /respondió en parte/);

  /* Every GDS was asked, each once more on a connection of its own. */
  for (const gds of AGIL_GDS_IDS) {
    assert.deepEqual(fake.requests(agilSearchFor(departure, gds)).map((request) => request.status), [0, 0], `GDS ${gds}`);
  }
  const job = await finishedSearchJob(tracked);
  assert.deepEqual(providerOutcomes(job), ["agil-local:failed", "costamar:completed"]);
});

suite.test("a range day that no GDS answers is not asked again, and leaves Agil answering in part", async (scope) => {
  const { fake } = scope;
  const days = [day(180), day(181), day(182)];
  fake.setFlights("agil", { origin: "LIM", destination: "SCL" }, oneFarePerGds(days));
  fake.fail("agil.search", { reset: true }, { where: onDays([days[1]!]) });

  const { page, started } = await searchRange(scope, days);
  await waitForResults(page, (days.length - 1) * AGIL_GDS_IDS.length);
  assert.match(await readWarningLine(page), /Agilsmart respondió en parte/);

  /* The day was started once, and each of its GDS asked twice: on a pooled
     connection and on one of its own. */
  assert.equal(fake.requests((request) => request.op === "agil.startSearch" && request.query?.departureDate === days[1]).length, 1);
  for (const gds of AGIL_GDS_IDS) {
    assert.deepEqual(fake.requests(agilSearchFor(days[1]!, gds)).map((request) => request.status), [0, 0], `GDS ${gds}`);
  }
  const job = await readSearchJob(await scope.api(), started.searchJobId);
  assert.deepEqual(providerOutcomes(job), ["agil-local:completed:partial", "costamar:completed"]);
});

suite.test("a range that no day answers fails Agil, and Click and Book Plus's list stands", async (scope) => {
  const { fake } = scope;
  const days = [day(190), day(191), day(192)];
  fake.setFlights("cbplus", { origin: "LIM", destination: "SCL" }, ONE_FARE);
  fake.fail("agil.search", { reset: true }, { where: onDays(days) });

  const { page, started } = await searchRange(scope, days);
  const cards = await waitForResults(page, days.length * ONE_FARE.length);
  assert.ok(cards.every((card) => card.provider === "Click and Book Plus"));
  const line = await readWarningLine(page);
  assert.match(line, /Agilsmart no respondió/);
  assert.doesNotMatch(line, /respondió en parte/);

  /* No day was asked twice. */
  const startedDays = fake.requests("agil.startSearch").map((request) => request.query?.departureDate);
  assert.deepEqual(startedDays.sort(), [...days].sort());
  const job = await readSearchJob(await scope.api(), started.searchJobId);
  assert.deepEqual(providerOutcomes(job), ["agil-local:failed", "costamar:completed"]);
});

suite.test("a flexible round trip that no cell answers fails its provider, Agil or Click and Book Plus, an error status included", async (scope) => {
  const { fake } = scope;
  const unavailable = { status: 503, body: { message: "Service Unavailable" } };

  /* Every GDS of every cell answers 503: an answer, so each is asked once,
     and a failure, so no cell answered. */
  const agilDays = [day(200), day(201), day(202), day(203)];
  fake.setFlights("cbplus", { origin: "LIM", destination: "SCL" }, ONE_FARE);
  fake.fail("agil.search", unavailable, { where: onDays(agilDays) });
  const agilDown = await searchRoundTrips(scope, agilDays);
  const cards = await waitForResults(agilDown.page, agilDays.length);
  assert.ok(cards.every((card) => card.provider === "Click and Book Plus"));
  const agilLine = await readWarningLine(agilDown.page);
  assert.match(agilLine, /Agilsmart no respondió/);
  assert.doesNotMatch(agilLine, /respondió en parte/);
  const agilAsked = fake.requests((request) => request.op === "agil.search" && onDays(agilDays)(request));
  assert.equal(agilAsked.length, agilDays.length * AGIL_GDS_IDS.length, "a GDS that answered 503 was asked again");
  assert.ok(agilAsked.every((request) => request.status === 503));
  assert.deepEqual(providerOutcomes(await readMatrixJob(await scope.api(), agilDown.started.matrixJobId)), ["agil-local:failed", "costamar:completed"]);

  /* And the other way round. */
  const cbplusDays = [day(210), day(211), day(212), day(213)];
  fake.setFlights("agil", { origin: "LIM", destination: "SCL" }, ONE_FARE);
  fake.fail("cbplus.search", unavailable, { where: onDays(cbplusDays) });
  const cbplusDown = await searchRoundTrips(scope, cbplusDays);
  const agilCards = await waitForResults(cbplusDown.page, cbplusDays.length);
  assert.ok(agilCards.every((card) => card.provider === "Agilsmart"));
  const cbplusLine = await readWarningLine(cbplusDown.page);
  assert.match(cbplusLine, /Click and Book Plus no respondió/);
  assert.doesNotMatch(cbplusLine, /respondió en parte/);
  assert.deepEqual(providerOutcomes(await readMatrixJob(await scope.api(), cbplusDown.started.matrixJobId)), ["agil-local:completed", "costamar:failed"]);
});

suite.test("Click and Book Plus answers in part while one day of a range answers, and fails when none does", async (scope) => {
  const { fake } = scope;
  const unavailable = { status: 503, body: { message: "Service Unavailable" } };
  fake.setFlights("both", { origin: "LIM", destination: "SCL" }, ONE_FARE);

  const someDays = [day(220), day(221), day(222)];
  fake.fail("cbplus.search", unavailable, { where: onDays([someDays[1]!]) });
  const oneDayDown = await searchRange(scope, someDays);
  /* Agil's three days and Click and Book Plus's two. */
  await waitForResults(oneDayDown.page, someDays.length * 2 - 1);
  assert.match(await readWarningLine(oneDayDown.page), /Click and Book Plus respondió en parte/);
  assert.deepEqual(providerOutcomes(await readSearchJob(await scope.api(), oneDayDown.started.searchJobId)), ["agil-local:completed", "costamar:completed:partial"]);

  const noDays = [day(230), day(231), day(232)];
  fake.fail("cbplus.search", unavailable, { where: onDays(noDays) });
  const everyDayDown = await searchRange(scope, noDays);
  const cards = await waitForResults(everyDayDown.page, noDays.length);
  assert.ok(cards.every((card) => card.provider === "Agilsmart"));
  const line = await readWarningLine(everyDayDown.page);
  assert.match(line, /Click and Book Plus no respondió/);
  assert.doesNotMatch(line, /respondió en parte/);
  assert.deepEqual(providerOutcomes(await readSearchJob(await scope.api(), everyDayDown.started.searchJobId)), ["agil-local:completed", "costamar:failed"]);
});
