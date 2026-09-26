import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";
import { searchPayloads, startSearch } from "./support/api-client.ts";
import { nextFrames, runSearch, waitForIdleCapacity, waitForMotion, waitForResults, waitForSweep } from "./support/flows.ts";
import { defineSuite, type ContextOptions } from "./support/harness.ts";
import type { OfferSpec } from "./support/fixtures.ts";
import { addMonths, day, deskMonth, eventually, monthKey, providerSearches, stationLookups, TODAY } from "./support/scenario.ts";
import { adoptBrowserClientId } from "./support/sessions.ts";
import {
  detail,
  duplicateIds,
  filters,
  horizontalOverflow,
  isDarkTheme,
  isFullyInViewport,
  isOnScreen,
  isUnclipped,
  migration,
  oneStopLabels,
  readResultCount,
  readSuggestion,
  readSuggestions,
  recordRemovedControls,
  results,
  scrollerOffset,
  searchForm,
  searchLink,
  textFontFamilies,
  topBar,
  watchOfferPanels,
  type SearchLink,
} from "./support/ui.ts";

/*
 * The phone and the in-between sizes: the sheets that stand in for the desk's
 * popovers and columns, the system back, a page that never scrolls sideways,
 * and a desk resized under a search.
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
  const removedControls = await recordRemovedControls(page);
  /* Something to go back to that is not the desk. */
  const before = `${stack.baseUrl}/favicon.svg`;
  await page.goto(before);
  await page.goto(stack.baseUrl);
  await searchForm.location(page, "Origen").waitFor();
  await assertNoHorizontalOverflow(page, "idle");
  /* The frequent stations and the policy line are set in the one family too. */
  assert.deepEqual((await textFontFamilies(page)).filter((family) => !family.startsWith("Inter")), [], "text set outside Inter");
  /* The phone's form is the first one built: no desk control is put up to be replaced. */
  assert.deepEqual(await removedControls(), [], "the phone built the desk's controls and then replaced them");

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

  /* Dates in the calendar sheet, which scrolls where the thumb leaves it: a
     tap chooses a day and moves nothing. */
  const departure = day(20);
  const returning = day(24);
  await searchForm.departureHalf(page).tap();
  const calendar = searchForm.calendarSheet(page);
  await calendar.waitFor();
  await assertNoHorizontalOverflow(page, "calendar sheet");
  for (const date of [departure, returning]) {
    const cell = searchForm.calendarDay(calendar, date);
    await cell.scrollIntoViewIfNeeded();
    const scrolled = await scrollerOffset(cell);
    await cell.tap();
    await nextFrames(page);
    assert.ok(Math.abs(await scrollerOffset(cell) - scrolled) < 2, `tapping ${date} scrolled the calendar`);
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

suite.test("on a phone the station sheet draws its history as it draws its matches, and a keyboard chooses from it", async (scope) => {
  const { fake, stack } = scope;
  /* Three origins of this browser, the oldest first: PIU, which the providers'
     catalogues name; AYP (Ayacucho), which only the desk's own list of certain
     codes names; and CHM (Chimbote), which nothing names. */
  const clientSessionId = "e2e-phone-station-history";
  const api = await scope.api();
  for (const [index, code] of ["PIU", "AYP", "CHM"].entries()) {
    await startSearch(api, searchPayloads.exact(code, "LIM", day(80 + index), undefined, { clientSessionId }));
  }
  await waitForIdleCapacity(api);
  /* Someone typed «pi» at the desk: the providers' answer is what it knows about PIU. */
  await api.json("GET", "/api/locations?q=pi&limit=8");

  const tracked = await scope.newContext({ ...PHONE, signedIn: true });
  await adoptBrowserClientId(tracked.context, clientSessionId);
  const page = await tracked.newPage();
  await page.goto(stack.baseUrl);
  await searchForm.location(page, "Origen").waitFor();
  await tracked.apiSettled();
  const lookupsBefore = stationLookups(fake).length;

  /* The sheet opens on the history: a code alone, the city and country of the
     desk's own list, and PIU as the providers named it. */
  await searchForm.location(page, "Origen").tap();
  const sheet = searchForm.locationSheet(page, "Origen");
  await sheet.waitFor();
  const recent = searchForm.suggestionGroup(page, "Recientes");
  await recent.waitFor();
  const history = await readSuggestions(recent);
  assert.deepEqual(history, ["CHM", "AYP Ayacucho Ayacucho, Perú", "PIU Piura Piura, Perú"]);
  await tracked.apiSettled();
  assert.equal(stationLookups(fake).length, lookupsBefore, "opening the sheet asked a provider");
  /* The keys are the same in both states: a phone shows none. */
  assert.equal(await searchForm.suggestionKeys(page).filter({ visible: true }).count(), 0, "the history shows keys on a phone");

  /* Two letters: the match draws PIU row for row as the history does. */
  const input = searchForm.locationSheetInput(page, "Origen");
  await input.fill("pi");
  const piuraMatch = searchForm.suggestion(page, "PIU");
  await piuraMatch.waitFor();
  assert.equal(await readSuggestion(piuraMatch), history[2]);
  assert.equal(await searchForm.suggestionKeys(page).filter({ visible: true }).count(), 0, "the matches show keys on a phone");

  /* Back to the history, chosen from a keyboard: the third row, PIU, taken
     the way a tap takes it, and the sheet closes. */
  await input.fill("");
  await recent.waitFor();
  for (let press = 0; press < 3; press += 1) {
    await page.keyboard.press("ArrowDown");
  }
  const third = recent.getByRole("option").nth(2);
  await eventually(async () => assert.equal(await input.getAttribute("aria-activedescendant"), await third.getAttribute("id")), { timeoutMs: 2_000 });
  assert.equal(await third.getAttribute("aria-selected"), "true");
  await page.keyboard.press("Enter");
  await sheet.waitFor({ state: "hidden" });
  await eventually(async () => assert.match(await searchForm.location(page, "Origen").inputValue(), /^PIU\b/));

  /* A match is taken from the keyboard the same way: the first is the one Enter takes. */
  await searchForm.location(page, "Destino").tap();
  const destinationSheet = searchForm.locationSheet(page, "Destino");
  await destinationSheet.waitFor();
  await searchForm.locationSheetInput(page, "Destino").fill("cu");
  await searchForm.suggestionGroup(page, "Coincidencias").waitFor();
  assert.match(await readSuggestion(searchForm.activeSuggestion(page)), /^CUZ\b/);
  await page.keyboard.press("Enter");
  await destinationSheet.waitFor({ state: "hidden" });
  await eventually(async () => assert.match(await searchForm.location(page, "Destino").inputValue(), /^CUZ\b/));
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
  await waitForMotion(page);
  await assertNoHorizontalOverflow(page, "landscape results");
  assert.ok(await isOnScreen(searchForm.submit(page).or(searchForm.editSummary(page)).first()), "the search action is out of reach");
  /* A list this wide lays the count and the airport out in tracks of their
     own, so the label is measured by its text. */
  const label = oneStopLabels(results.viewport(page)).first();
  assert.match(await label.innerText(), /BOG/);
  assert.ok(await isUnclipped(label), "a one-stop label is cut off in landscape");

  await results.card(page, /USD 540\.00 total.*Agilsmart$/).tap();
  const offer = detail.surface(page);
  await offer.waitFor();
  /* The sheet rises from below the window: measured once it has arrived. */
  await waitForMotion(page);
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
});

suite.test("the dates and the months ask for a choice once their calendar is left without one, and not while it is open", async (scope) => {
  const missingDate = "Selecciona una fecha de salida.";
  const missingMonths = "Selecciona al menos un mes.";
  const firstMonth = addMonths(monthKey(TODAY), 1);
  const lastMonth = addMonths(monthKey(TODAY), 3);
  /* Each left without a choice: the system back on a phone, Escape on a desk.
     With a choice, the phone's sheet keeps it on every way out, its cross
     included; on a desk the second month confirms the range and closes. */
  const surfaces = [
    {
      name: "phone sheet",
      options: PHONE,
      calendar: searchForm.calendarSheet,
      leave: (page: Page) => page.goBack(),
      leaveWithChoice: (picker: Locator) => searchForm.closeSheet(picker, "Meses").click(),
    },
    {
      name: "desk popover",
      options: TABLET,
      calendar: searchForm.calendarPopover,
      leave: (page: Page) => page.keyboard.press("Escape"),
      leaveWithChoice: async () => undefined,
    },
  ];
  for (const surface of surfaces) {
    const { page } = await scope.signedInPage("/", surface.options);
    const departure = searchForm.departureHalf(page);
    await departure.click();
    const calendar = surface.calendar(page);
    await calendar.waitFor();
    assert.equal(await searchForm.fieldMessage(page, missingDate).count(), 0, `${surface.name}: the calendar asked for a date as it opened`);
    assert.equal(await departure.getAttribute("aria-invalid"), "false", surface.name);

    await surface.leave(page);
    await calendar.waitFor({ state: "hidden" });
    await searchForm.fieldMessage(page, missingDate).waitFor();
    assert.equal(await departure.getAttribute("aria-invalid"), "true", surface.name);

    await searchForm.mode(page, "Migratorio").click();
    const months = searchForm.months(page);
    await months.click();
    const picker = searchForm.monthPicker(page);
    await picker.waitFor();
    assert.equal(await searchForm.fieldMessage(page, missingMonths).count(), 0, `${surface.name}: the month picker asked for a month as it opened`);
    await surface.leave(page);
    await picker.waitFor({ state: "hidden" });
    await searchForm.fieldMessage(page, missingMonths).waitFor();

    await months.click();
    await picker.waitFor();
    await searchForm.monthCell(picker, firstMonth).click();
    await searchForm.monthCell(picker, lastMonth).click();
    await surface.leaveWithChoice(picker);
    await picker.waitFor({ state: "hidden" });
    assert.equal(
      await months.getAttribute("aria-label"),
      `Meses: ${deskMonth(firstMonth)} – ${deskMonth(lastMonth)}`,
      `${surface.name}: the months chosen were lost on the way out`,
    );
    await searchForm.fieldMessage(page, missingMonths).waitFor({ state: "hidden" });
  }
});

/* ---- A window resized under a search ---- */

/* Twelve fares a provider, one row each: more than the column shows at once. */
const MEDELLIN: OfferSpec[] = Array.from({ length: 12 }, (_, index): OfferSpec => {
  const hour = String(6 + index).padStart(2, "0");
  return {
    outbound: [`AV${9300 + index} LIM-MDE ${hour}:10-${String(9 + index).padStart(2, "0")}:05`],
    price: 280 + index * 13,
    baggage: { carryOn: true, checked: 1 },
  };
});

suite.test("resizing the desk keeps the list and where it was read, and never holds two offer panels", async (scope) => {
  const { fake } = scope;
  fake.setFlights("both", { origin: "LIM", destination: "MDE" }, MEDELLIN);
  const { page } = await scope.signedInPage(searchLink({ mode: "exact", trip: "one-way", origin: "LIM", destination: "MDE", departure: day(55) }));
  await waitForResults(page, MEDELLIN.length * 2);

  /* Three columns to two: the offer column goes, the list stays the list it was, scrolled. */
  await detail.nothingSelected(page).waitFor();
  const list = results.viewport(page);
  await list.evaluate((element) => {
    element.setAttribute("data-e2e-identity", "read-before-the-resize");
    element.scrollTo({ top: 300 });
  });
  await eventually(async () => assert.ok(await list.evaluate((element) => element.scrollTop) > 0));
  await page.setViewportSize({ width: 900, height: 900 });
  await detail.nothingSelected(page).waitFor({ state: "hidden" });
  assert.equal(await list.getAttribute("data-e2e-identity"), "read-before-the-resize", "the resize built the list again");
  assert.ok(await list.evaluate((element) => element.scrollTop) > 0, "the resize lost the list's scroll");

  /* At 1300 an offer opens as a side sheet; widened to 1600 it moves to the
     third column, and the sheet is not kept beside it. */
  await page.setViewportSize({ width: 1300, height: 900 });
  await results.cards(page).first().click();
  const sheet = page.getByRole("dialog", { name: "Oferta", exact: true });
  await sheet.waitFor();
  const offerPanels = await watchOfferPanels(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await sheet.waitFor({ state: "detached" });
  await detail.quote(detail.surface(page)).waitFor();
  assert.equal(await offerPanels(), 1, "the offer was drawn twice while it moved to its column");
  assert.deepEqual(await duplicateIds(page), []);
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
});
