import assert from "node:assert/strict";
import {
  readMatrixJob,
  readSearchJob,
  type JobProviderDiagnostics,
  type MatrixJob,
  type SearchJob,
} from "./support/api-client.ts";
import type { RecordedRequest } from "./support/fake-upstream.ts";
import { runSearch, waitForResults } from "./support/flows.ts";
import { defineSuite, type TestScope } from "./support/harness.ts";
import type { OfferSpec, SearchQuery } from "./support/fixtures.ts";
import { addDays, AGIL_GDS_IDS, day, providerSearches } from "./support/scenario.ts";
import { notice, searchForm, searchLink } from "./support/ui.ts";

/*
 * A provider that answers only in part. Agil answers per GDS, and a GDS whose
 * connection drops is asked once more, on a connection of its own, so the
 * list keeps every fare. A GDS that never answers a day, a cell, or before
 * Agil's deadline leaves the list short, and the desk says so in its one line
 * instead of presenting the search as complete. Agil's deadline is the
 * shortest the backend accepts, so a stalled GDS costs five seconds.
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

function agilSearchFor(departureDate: string, gds: number): (request: RecordedRequest) => boolean {
  return (request) => request.op === "agil.search" && request.query?.departureDate === departureDate && request.query?.gds === gds;
}

/** `providerId:status`, and `:partial` for one that completed without part of the search. */
function providerOutcomes(job: { providerDiagnostics?: JobProviderDiagnostics[] }): string[] {
  return (job.providerDiagnostics ?? [])
    .map((entry) => `${entry.providerId}:${entry.status}${entry.partial ? ":partial" : ""}`)
    .sort();
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

suite.test("a GDS that drops every connection for a day is named in the notice, and the rest of the range stays", async (scope) => {
  const { fake } = scope;
  const days = [day(140), day(141), day(142)];
  fake.setFlights("agil", { origin: "LIM", destination: "SCL" }, oneFarePerGds(days));
  const dropped = agilSearchFor(days[2]!, 7);
  fake.fail("agil.search", { reset: true }, { where: dropped });

  const { page, started } = await searchRange(scope, days);
  await waitForResults(page, days.length * AGIL_GDS_IDS.length - 1);
  /* A warning, not an error: the list is real, only short. */
  await notice.line(page).waitFor({ timeout: 3_000 });
  assert.equal(await notice.error(page).count(), 0);
  const line = await notice.line(page).innerText();
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
    new RegExp(`Agil GDS 7 omitted: LIM-SCL ${days[2]} reason=\\S+ afterMs=\\d+ detail=AgilUnansweredError: Agil search GDS 7 failed before receiving a response`),
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

  const job = (await tracked.apiBodies())
    .filter((entry) => new URL(entry.url).pathname.startsWith("/api/search"))
    .map((entry) => JSON.parse(entry.body) as SearchJob)
    .find((candidate) => candidate.searchComplete);
  assert.ok(job, "the finished job never reached the page");
  assert.deepEqual(providerOutcomes(job), ["agil-local:completed:partial", "costamar:completed"]);
  assert.match(scope.stack.logs("runner", scope.logMark), new RegExp(`Agil GDS 10 omitted: LIM-SCL ${departure} reason=timeout`));
});

suite.test("a flexible round trip names Agil when a GDS never answers one of its cells", async (scope) => {
  const { fake } = scope;
  const days = [day(160), day(161), day(162), day(163)];
  const fares = oneFarePerGds(days);
  /* Each cell's fare comes from GDS 0 only. */
  fake.setFlights("agil", { origin: "LIM", destination: "SCL" }, (query) => (query.gds === 0 ? fares(query) : []));
  const dropped = agilSearchFor(days[1]!, 0);
  fake.fail("agil.search", { reset: true }, { where: dropped });

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
  await waitForResults(page, days.length - 1);
  await notice.line(page).waitFor({ timeout: 3_000 });
  assert.match(await notice.line(page).innerText(), /Agilsmart respondió en parte/);

  assert.deepEqual(fake.requests(dropped).map((request) => request.status), [0, 0]);
  const job = await readMatrixJob(await scope.api(), started.matrixJobId);
  assert.equal(job.matrixStatus, "completed");
  assert.deepEqual(providerOutcomes(job), ["agil-local:completed:partial", "costamar:completed"]);
  assert.match(
    scope.stack.logs("runner", scope.logMark),
    new RegExp(`Agil matrix cell omitted: LIM-SCL ${days[1]} -> ${addDays(days[1]!, STAY_NIGHTS)} reason=\\S+ afterMs=\\d+ detail=AgilUnansweredError`),
  );
});
