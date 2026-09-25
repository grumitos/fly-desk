import assert from "node:assert/strict";
import { readSearchJob, type SearchJob } from "./support/api-client.ts";
import { waitForResults } from "./support/flows.ts";
import { defineSuite } from "./support/harness.ts";
import type { OfferSpec, SearchQuery } from "./support/fixtures.ts";
import {
  addMonths,
  daysInMonth,
  eventually,
  locationUses,
  monthKey,
  sweepMonthLabel,
  TODAY,
} from "./support/scenario.ts";
import { migration, results, searchForm, searchLink } from "./support/ui.ts";

/*
 * The migratory sweep: every day of every chosen month against both
 * providers, one search per month, drawn as a grid of months.
 */

const suite = defineSuite({ file: import.meta.filename });

const NOVEMBER = monthKey(TODAY);
const DECEMBER = addMonths(NOVEMBER, 1);
const JANUARY = addMonths(NOVEMBER, 2);

/* November has a fare every third day, from both providers. December: Agil
   has nothing and Click and Book Plus is down. January: nobody has anything. */
function madridWinter(query: SearchQuery): OfferSpec[] {
  if (!query.departureDate.startsWith(NOVEMBER)) return [];
  const dayOfMonth = Number(query.departureDate.slice(8));
  return dayOfMonth % 3 === 0
    ? [{ outbound: ["IB6650 LIM-MAD 17:25-11:50+1"], price: 700 + dayOfMonth, baggage: { carryOn: true, checked: 1 } }]
    : [];
}

suite.test("a sweep across the year boundary marks each month priced, failed or empty, opens a month without searching again, and counts once", async (scope) => {
  const { fake, stack } = scope;
  fake.setFlights("both", { origin: "LIM", destination: "MAD" }, madridWinter);
  fake.fail("cbplus.search", { status: 503, body: { message: "Servicio no disponible" } }, {
    where: (request) => Boolean(request.query?.departureDate.startsWith(DECEMBER)),
  });
  const usesBefore = locationUses(stack.appDataDir);

  /* The link fills the route and the mode; the months are chosen by hand,
     because a sweep never starts from a link. */
  const { tracked, page } = await scope.signedInPage(searchLink({ mode: "migration", trip: "one-way", origin: "LIM", destination: "MAD" }));
  await searchForm.months(page).click();
  const picker = searchForm.monthPicker(page);
  await searchForm.monthCell(picker, NOVEMBER).click();
  await searchForm.monthCell(picker, JANUARY).click();
  await page.keyboard.press("Escape");
  await picker.waitFor({ state: "hidden" });
  assert.equal(await searchForm.months(page).getAttribute("aria-label"), `Meses: Nov ${NOVEMBER.slice(0, 4)} – Ene ${JANUARY.slice(0, 4)}`);
  assert.equal(fake.requests((request) => request.op === "agil.search" || request.op === "cbplus.search").length, 0, "the link searched on its own");

  await searchForm.submit(page).click();
  const november = sweepMonthLabel(NOVEMBER);
  const december = sweepMonthLabel(DECEMBER);
  const january = sweepMonthLabel(JANUARY);
  await eventually(async () => {
    assert.equal(await searchForm.stop(page).count(), 0, "the sweep is still running");
    assert.match(await results.headerLine(page).innerText(), /1 de 3 meses con tarifa/);
    assert.equal(await migration.monthCards(page).count(), 3);
  }, { timeoutMs: 60_000, message: "the sweep settles" });

  /* Priced: the cheapest day, and how many of the month's days had a fare. */
  const novemberDays = daysInMonth(NOVEMBER) - Number(TODAY.slice(8)) + 1;
  const pricedDays = Array.from({ length: novemberDays }, (_, index) => Number(TODAY.slice(8)) + index).filter((value) => value % 3 === 0);
  const cheapest = 700 + pricedDays[0]!;
  const novemberCard = await migration.monthCard(page, november).innerText();
  assert.match(novemberCard, new RegExp(`USD ${cheapest}\\.00`));
  assert.match(novemberCard, new RegExp(`${pricedDays.length} de ${novemberDays} días con tarifa`));
  await migration.pricedMonth(page, november).waitFor();

  /* Failed: the provider that fell, and no coverage figure a partial scan
     could not honestly give. */
  const decemberCard = await migration.monthCard(page, december).innerText();
  assert.match(decemberCard, /Click and Book Plus/);
  assert.match(decemberCard, /sin tarifa en el mes/);
  assert.doesNotMatch(decemberCard, /días con tarifa/);
  assert.equal(await migration.pricedMonth(page, december).count(), 0);

  /* Empty: every day asked, none with a fare. */
  const januaryCard = await migration.monthCard(page, january).innerText();
  assert.match(januaryCard, new RegExp(`0 de ${daysInMonth(JANUARY)} días con tarifa`));
  assert.equal(await migration.pricedMonth(page, january).count(), 0);

  /* Every day of every month went to both providers; December's answers
     from Click and Book Plus were all failures. */
  const startedDays = new Set(fake.requests("agil.startSearch").map((request) => request.query?.departureDate));
  assert.equal(startedDays.size, novemberDays + daysInMonth(DECEMBER) + daysInMonth(JANUARY));
  const cbplusDecember = fake.requests((request) => request.op === "cbplus.search" && Boolean(request.query?.departureDate.startsWith(DECEMBER)));
  assert.equal(new Set(cbplusDecember.map((request) => request.query?.departureDate)).size, daysInMonth(DECEMBER));
  assert.ok(cbplusDecember.every((request) => request.status === 503));

  /* One sweep, three month searches, and the route counted once. */
  const monthSearches = tracked.apiRequests.filter((request) => request.method === "POST" && new URL(request.url).pathname === "/api/search");
  assert.equal(monthSearches.length, 3);
  assert.deepEqual(
    monthSearches.map((request) => JSON.parse(request.body ?? "{}").recordLocationUsage).sort(),
    [false, false, true],
  );
  const usesAfter = locationUses(stack.appDataDir);
  assert.equal((usesAfter.get("origin:LIM") ?? 0) - (usesBefore.get("origin:LIM") ?? 0), 1);
  assert.equal((usesAfter.get("destination:MAD") ?? 0) - (usesBefore.get("destination:MAD") ?? 0), 1);

  /* Opening a month reads the job the sweep already ran for it. */
  const novemberJob = (await tracked.apiBodies())
    .filter((entry) => new URL(entry.url).pathname === "/api/search" && entry.status === 200)
    .map((entry) => JSON.parse(entry.body) as SearchJob & { request?: { legs?: Array<{ departureStart?: string }> } })
    .find((job) => job.request?.legs?.[0]?.departureStart === TODAY);
  assert.ok(novemberJob, "the November search was not seen");
  const providerCallsBefore = fake.requests().length;
  const opened = tracked.context.waitForEvent("page");
  await migration.openMonth(page, november).click();
  const monthTab = await opened;
  await monthTab.waitForLoadState();
  assert.equal(new URL(monthTab.url()).searchParams.get("job"), novemberJob.searchJobId);
  const api = await scope.api();
  const storedMonth = await readSearchJob(api, novemberJob.searchJobId);
  await waitForResults(monthTab, storedMonth.allOffers?.length ?? -1);
  assert.equal(storedMonth.allOffers?.length, pricedDays.length * 2, "each priced day holds one fare per provider");
  assert.equal(fake.requests().length, providerCallsBefore, "opening a month asked the providers again");
});
