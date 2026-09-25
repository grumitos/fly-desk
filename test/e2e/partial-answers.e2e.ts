import assert from "node:assert/strict";
import { readSearchJob, type SearchJob } from "./support/api-client.ts";
import type { RecordedRequest } from "./support/fake-upstream.ts";
import { runSearch, waitForResults } from "./support/flows.ts";
import { defineSuite, type TestScope } from "./support/harness.ts";
import type { OfferSpec, SearchQuery } from "./support/fixtures.ts";
import { AGIL_GDS_IDS, day, providerSearches } from "./support/scenario.ts";
import { notice, searchForm, searchLink } from "./support/ui.ts";

/*
 * A provider that answers only in part. Agil answers per GDS, and a GDS whose
 * connection drops is asked once more, on a connection of its own, so the
 * list keeps every fare.
 */

const suite = defineSuite({ file: import.meta.filename });

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
  assert.deepEqual(
    (job.providerDiagnostics ?? []).map((entry) => `${entry.providerId}:${entry.status}`).sort(),
    ["agil-local:completed", "costamar:completed"],
  );
  assert.match(scope.stack.logs("runner", scope.logMark), /Agil search GDS 3 sent again on a new connection/);
});
