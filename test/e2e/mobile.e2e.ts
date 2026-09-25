import assert from "node:assert/strict";
import type { Page } from "playwright";
import { runSearch, waitForResults, waitForSweep } from "./support/flows.ts";
import { defineSuite, type ContextOptions } from "./support/harness.ts";
import type { OfferSpec } from "./support/fixtures.ts";
import { addMonths, day, eventually, monthKey, providerSearches, TODAY } from "./support/scenario.ts";
import {
  detail,
  filters,
  horizontalOverflow,
  isDarkTheme,
  isFullyInViewport,
  isOnScreen,
  isUnclipped,
  migration,
  oneStopLabels,
  readResultCount,
  results,
  searchForm,
  searchLink,
  topBar,
  type SearchLink,
} from "./support/ui.ts";

/*
 * The phone and the in-between sizes: the sheets that stand in for the desk's
 * popovers and columns, the system back, and a page that never scrolls
 * sideways.
 */

const suite = defineSuite({ file: import.meta.filename });

const PHONE: ContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const SMALL_PHONE: ContextOptions = { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const TABLET: ContextOptions = { viewport: { width: 1024, height: 768 } };
const LANDSCAPE_PHONE: ContextOptions = { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

async function assertNoHorizontalOverflow(page: Page, step: string): Promise<void> {
  assert.ok(await horizontalOverflow(page) <= 0, `the page scrolls sideways at: ${step}`);
}

const CUSCO: OfferSpec[] = [
  { outbound: ["LA2045 LIM-CUZ 05:40-07:05"], inbound: ["LA2046 CUZ-LIM 08:10-09:35"], price: 142.8, baggage: { carryOn: true, checked: 0 }, seats: 7 },
  { outbound: ["H2 5102 LIM-AQP 06:25-07:50", "H2 5110 AQP-CUZ 09:00-10:05"], inbound: ["H2 5103 CUZ-LIM 09:15-10:40"], price: 118.4, baggage: { carryOn: true, checked: 1 }, seats: 4 },
];

suite.test("on a phone the whole search runs through sheets, the back button closes them, and nothing scrolls sideways", async (scope) => {
  const { fake, stack } = scope;
  fake.setFlights("both", { origin: "LIM", destination: "CUZ" }, CUSCO);
  const tracked = await scope.newContext({ ...PHONE, signedIn: true, clipboard: true });
  const page = await tracked.newPage();
  /* Something to go back to that is not the desk. */
  const before = `${stack.baseUrl}/favicon.svg`;
  await page.goto(before);
  await page.goto(stack.baseUrl);
  await searchForm.location(page, "Origen").waitFor();
  await assertNoHorizontalOverflow(page, "idle");

  /* Dark, chosen at rest: the title bar steps aside once a search exists. */
  await topBar.themeToggle(page).tap();
  await eventually(async () => assert.equal(await isDarkTheme(page), true));

  /* Origin and destination, each in its own full-screen sheet. */
  for (const [field, typed, code] of [["Origen", "lim", "LIM"], ["Destino", "cus", "CUZ"]] as const) {
    await searchForm.location(page, field).tap();
    const sheet = searchForm.locationSheet(page, field);
    await sheet.waitFor();
    await searchForm.locationSheetInput(page, field).fill(typed);
    await searchForm.suggestion(page, code).waitFor();
    await assertNoHorizontalOverflow(page, `${field} sheet`);
    await searchForm.suggestion(page, code).tap();
    await sheet.waitFor({ state: "hidden" });
    await eventually(async () => assert.match(await searchForm.location(page, field).inputValue(), new RegExp(`^${code}\\b`)));
  }

  /* Dates in the calendar sheet. */
  const departure = day(20);
  const returning = day(24);
  await searchForm.departureHalf(page).tap();
  const calendar = searchForm.calendarSheet(page);
  await calendar.waitFor();
  await assertNoHorizontalOverflow(page, "calendar sheet");
  for (const date of [departure, returning]) {
    const cell = searchForm.calendarDay(calendar, date);
    await cell.scrollIntoViewIfNeeded();
    await cell.tap();
  }
  await searchForm.applySheet(calendar).tap();
  await calendar.waitFor({ state: "hidden" });

  /* Two adults in the passenger sheet. */
  await searchForm.passengers(page).tap();
  const passengers = searchForm.passengerSheet(page);
  await passengers.waitFor();
  await assertNoHorizontalOverflow(page, "passenger sheet");
  await searchForm.addPassenger(passengers, "adultos").tap();
  await searchForm.applySheet(passengers).tap();
  await passengers.waitFor({ state: "hidden" });
  assert.match(await searchForm.passengers(page).innerText(), /2\s+pasajeros/);

  /* The search: collapsed to its one-line summary, four fares. */
  await runSearch(page);
  const cards = await waitForResults(page, 4);
  await searchForm.editSummary(page).waitFor();
  await assertNoHorizontalOverflow(page, "results");
  assert.ok(await isDarkTheme(page), "the theme did not survive the search");
  const route = { origin: "LIM", destination: "CUZ", departureDate: departure, returnDate: returning };
  const asked = providerSearches(fake, route);
  assert.ok(asked.length > 0 && asked.every((request) => request.query?.adults === 2), "the providers were not asked for two adults");
  assert.ok(cards.every((card) => /USD [\d.,]+ total, USD [\d.,]+ por persona/.test(card.label)));

  /* The fare in its sheet, quoted: the confirmation is a line, not a panel. */
  const cbplusBefore = fake.requests("cbplus.search").length;
  await results.card(page, /USD 285\.60 total.*Click and Book Plus$/).tap();
  const offerSheet = detail.surface(page);
  await offerSheet.waitFor();
  await assertNoHorizontalOverflow(page, "offer sheet");
  await detail.quote(offerSheet).tap();
  await detail.copied(offerSheet).waitFor();
  assert.equal(fake.requests("cbplus.search").length, cbplusBefore + 1, "the quote did not ask the provider");
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /COTIZACI[OÓ]N/);
  await detail.close(offerSheet).tap();
  await offerSheet.waitFor({ state: "hidden" });

  /* Filters in their sheet; the system back closes it and keeps the change. */
  const searchUrl = page.url();
  await results.openFilters(page).tap();
  const filterSheet = filters.sheet(page);
  await filterSheet.waitFor();
  await assertNoHorizontalOverflow(page, "filter sheet");
  await filters.stops(filterSheet, "Directo").tap();
  await filters.showFlights(filterSheet).filter({ hasText: /Ver 2 vuelos/ }).waitFor();
  await page.goBack();
  await filterSheet.waitFor({ state: "hidden" });
  assert.equal(new URL(page.url()).pathname, new URL(searchUrl).pathname, "the back left the desk instead of closing the sheet");
  assert.equal(await page.evaluate(() => (history.state as { fdSheet?: unknown } | null)?.fdSheet ?? null), null, "the sheet's history entry was left behind");
  await eventually(async () => assert.deepEqual(await readResultCount(page), { visible: 2, total: 4 }));
  await filters.removeChip(page, "Directo").waitFor();
  await assertNoHorizontalOverflow(page, "filtered results");

  /* One more back leaves the desk: no step of a closed sheet is in the way. */
  await page.goBack();
  await page.waitForURL(before);
});

/* ---- The in-between sizes ---- */

const MIAMI: OfferSpec[] = [
  {
    outbound: ["LA2400 LIM-BOG 06:00-09:40", "LA2402 BOG-MIA 11:00-15:30"],
    inbound: ["LA2403 MIA-BOG 16:30-19:45", "LA2401 BOG-LIM 21:00-00:40+1"],
    price: 540,
    baggage: { carryOn: true, checked: 0 },
  },
  { outbound: ["AA918 LIM-MIA 23:35-06:05+1"], inbound: ["AA917 MIA-LIM 16:35-21:55"], price: 612, baggage: { carryOn: true, checked: 1 } },
];

const MODES: Array<{ name: string; link: SearchLink; launchesItself: boolean; rows: number }> = [
  { name: "exact round trip", link: { mode: "exact", trip: "round-trip", origin: "LIM", destination: "MIA", departure: day(20), return: day(27) }, launchesItself: true, rows: 4 },
  { name: "exact one way", link: { mode: "exact", trip: "one-way", origin: "LIM", destination: "MIA", departure: day(21) }, launchesItself: true, rows: 4 },
  { name: "flexible", link: { mode: "flexible", trip: "one-way", origin: "LIM", destination: "MIA", departureStart: day(22), departureEnd: day(24) }, launchesItself: false, rows: 12 },
  { name: "migratory", link: { mode: "migration", trip: "one-way", origin: "LIM", destination: "MIA", months: [monthKey(TODAY), addMonths(monthKey(TODAY), 1)] }, launchesItself: false, rows: 2 },
];

suite.test("at 360 wide every mode fits, keeps its search action in reach, and names the stopover airport", async (scope) => {
  const { fake, stack } = scope;
  fake.setFlights("both", { origin: "LIM", destination: "MIA" }, MIAMI);
  const tracked = await scope.newContext({ ...SMALL_PHONE, signedIn: true });
  const page = await tracked.newPage();
  for (const mode of MODES) {
    await page.goto(`${stack.baseUrl}${searchLink(mode.link)}`);
    if (mode.launchesItself) {
      await waitForResults(page, mode.rows);
    } else {
      /* A sweep or a range waits for the gesture; the gesture has to be reachable. */
      await searchForm.submit(page).waitFor();
      assert.ok(await isOnScreen(searchForm.submit(page)), `${mode.name}: «Buscar» is off screen or covered`);
      await assertNoHorizontalOverflow(page, `${mode.name}, filled form`);
      await runSearch(page);
      if (mode.link.mode === "migration") {
        await waitForSweep(page, mode.rows, mode.rows);
      } else {
        await waitForResults(page, mode.rows);
      }
    }
    await assertNoHorizontalOverflow(page, `${mode.name}, results`);
    /* Back to the form stays one tap away. */
    assert.ok(await isOnScreen(searchForm.editSummary(page)), `${mode.name}: the summary that reopens the form is out of reach`);

    const stopLabels = mode.link.mode === "migration" ? migration.monthCards(page).getByText(/1 esc · [A-Z]{3}/) : oneStopLabels(results.viewport(page));
    const count = await stopLabels.count();
    assert.ok(count > 0, `${mode.name}: no one-stop label on screen`);
    for (let index = 0; index < count; index += 1) {
      const label = stopLabels.nth(index);
      await label.scrollIntoViewIfNeeded();
      assert.match(await label.innerText(), /BOG/, `${mode.name}: a one-stop label lost its airport`);
      assert.ok(await isUnclipped(label), `${mode.name}: a one-stop label is cut off`);
    }
  }
});

suite.test("a 1024-wide desk keeps its three parts and the offer sheet's actions on screen", async (scope) => {
  const { fake } = scope;
  fake.setFlights("both", { origin: "LIM", destination: "MIA" }, MIAMI);
  const { page } = await scope.signedInPage(searchLink(MODES[0]!.link), TABLET);
  await waitForResults(page, 4);
  await assertNoHorizontalOverflow(page, "tablet results");
  await filters.stops(page, "Todos").waitFor();
  assert.ok(await isOnScreen(searchForm.submit(page)), "«Buscar» is out of reach");
  const label = oneStopLabels(results.viewport(page)).first();
  assert.match(await label.innerText(), /BOG/);
  assert.ok(await isUnclipped(label));

  await results.card(page, /USD 540\.00 total.*Agilsmart$/).click();
  const offer = detail.surface(page);
  await offer.waitFor();
  assert.ok(await isFullyInViewport(detail.quote(offer)), "«Cotizar» is not fully visible");
  await assertNoHorizontalOverflow(page, "tablet offer sheet");
});

suite.test("a phone held sideways shows the offer's itinerary with «Cotizar» fully visible", async (scope) => {
  const { fake } = scope;
  fake.setFlights("both", { origin: "LIM", destination: "MIA" }, MIAMI);
  const { page } = await scope.signedInPage(searchLink(MODES[0]!.link), LANDSCAPE_PHONE);
  await waitForResults(page, 4);
  await assertNoHorizontalOverflow(page, "landscape results");
  assert.ok(await isOnScreen(searchForm.submit(page).or(searchForm.editSummary(page)).first()), "the search action is out of reach");
  const label = oneStopLabels(results.viewport(page)).first();
  assert.match(await label.innerText(), /BOG/);
  assert.ok(await isUnclipped(label));

  await results.card(page, /USD 540\.00 total.*Agilsmart$/).tap();
  const offer = detail.surface(page);
  await offer.waitFor();
  await assertNoHorizontalOverflow(page, "landscape offer sheet");
  const quote = detail.quote(offer);
  assert.ok(await isFullyInViewport(quote) && await isUnclipped(quote), "«Cotizar» is cut off in landscape");
  /* The itinerary is there to be read: both legs, every flight of them. */
  const outbound = detail.legTitle(offer, "Ida");
  await outbound.waitFor();
  assert.ok(await isOnScreen(outbound), "the itinerary is hidden behind the sheet's header");
  await detail.legTitle(offer, "Vuelta").waitFor();
  for (const flight of ["LATAM 2400", "LATAM 2402", "LATAM 2403", "LATAM 2401"]) {
    await detail.flightRow(offer, flight).waitFor();
  }
}, {
  todo: "landscape fix in progress: at 844×390 the offer side sheet spends its height on the header, the fare and the actions, leaves the itinerary a strip with nothing legible in it, and its container clips the bottom of «Cotizar»",
});

suite.test("a filter changed in the phone's filter sheet stays on the address bar after back closes the sheet", async (scope) => {
  const { fake } = scope;
  fake.setFlights("both", { origin: "LIM", destination: "CUZ" }, CUSCO);
  const { page } = await scope.signedInPage(searchLink({ mode: "exact", trip: "round-trip", origin: "LIM", destination: "CUZ", departure: day(40), return: day(44) }), PHONE);
  await waitForResults(page, 4);
  await results.openFilters(page).tap();
  const filterSheet = filters.sheet(page);
  await filterSheet.waitFor();
  await filters.stops(filterSheet, "Directo").tap();
  await eventually(() => assert.equal(new URL(page.url()).searchParams.get("nonStop"), "1"));
  await page.goBack();
  await filterSheet.waitFor({ state: "hidden" });
  await filters.removeChip(page, "Directo").waitFor();
  assert.equal(new URL(page.url()).searchParams.get("nonStop"), "1", "the list is filtered but the address bar no longer says so");
}, {
  todo: "production bug: the filter change is written with replaceState onto the history entry the open sheet pushed (frontend/src/lib/search-share.ts:107, frontend/src/hooks/useOverlayHistory.ts:115), so the back that closes the sheet returns to the entry from before the change: the list stays filtered while the address bar — the shareable link — drops the filter",
});
