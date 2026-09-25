import assert from "node:assert/strict";
import { defineSuite } from "./support/harness.ts";
import { fakeCbplusToken, FAKE_CBPLUS_TERMINAL_ID, type OfferSpec } from "./support/fixtures.ts";
import { AGIL_GDS_IDS, day, eventually, providerSearches } from "./support/scenario.ts";
import {
  detail,
  filters,
  login,
  quotation,
  readCards,
  readResultCount,
  results,
  searchForm,
  searchLink,
  signInThroughGate,
} from "./support/ui.ts";

/*
 * The desk at 1440×900: a shared link through the sign-in gate, a flexible
 * round trip over the matrix, and a week-long range that returns hundreds of
 * fares.
 */

const CBPLUS_TOKEN = fakeCbplusToken();
const suite = defineSuite({
  file: import.meta.filename,
  stack: { env: { CBPLUS_TOKEN } },
});

/* LIM–MIA round trip: four Agil fares on four GDS ids and two Click and Book
   Plus fares, LATAM on both providers. */
const LIM_MIA_AGIL: OfferSpec[] = [
  { outbound: ["AA918 LIM-MIA 23:35-06:05+1"], inbound: ["AA917 MIA-LIM 16:35-21:55"], price: 612, baggage: { carryOn: true, checked: 1 }, seats: 6, gds: 0 },
  { outbound: ["AA940 LIM-MIA 10:05-16:40"], inbound: ["AA941 MIA-LIM 07:00-12:30"], price: 700, baggage: { carryOn: true, checked: 1 }, seats: 4, gds: 7 },
  {
    outbound: ["LA2400 LIM-BOG 06:00-09:40", "LA2402 BOG-MIA 11:00-15:30"],
    inbound: ["LA2403 MIA-BOG 16:30-19:45", "LA2401 BOG-LIM 21:00-00:40+1"],
    price: 540,
    baggage: { carryOn: true, checked: 0 },
    seats: 5,
    gds: 1,
  },
  {
    outbound: ["CM472 LIM-PTY 05:59-09:18", "CM208 PTY-MIA 10:36-14:32"],
    inbound: ["CM105 MIA-PTY 09:30-11:20", "CM471 PTY-LIM 13:05-16:25"],
    price: 498,
    baggage: { carryOn: true, checked: 1 },
    seats: 9,
    gds: 3,
  },
];
const LIM_MIA_CBPLUS: OfferSpec[] = [
  { outbound: ["LA2472 LIM-MIA 08:20-15:40"], inbound: ["LA2473 MIA-LIM 17:20-22:50"], price: 689, baggage: { carryOn: true, checked: 1 }, brand: "Plus" },
  {
    outbound: ["AV50 LIM-BOG 04:55-08:30", "AV10 BOG-MIA 10:00-14:00"],
    inbound: ["AV11 MIA-BOG 15:00-18:30", "AV51 BOG-LIM 20:00-23:30"],
    price: 455,
    baggage: { carryOn: true, checked: 0 },
    brand: "Basic",
  },
];

suite.test("a shared round-trip link survives the sign-in gate and carries the search to both providers' purchase pages", async (scope) => {
  const { fake, stack } = scope;
  const departure = day(20);
  const returning = day(27);
  fake.setFlights("agil", { origin: "LIM", destination: "MIA" }, LIM_MIA_AGIL);
  fake.setFlights("cbplus", { origin: "LIM", destination: "MIA" }, LIM_MIA_CBPLUS);
  const link = searchLink({ mode: "exact", trip: "round-trip", origin: "LIM", destination: "MIA", departure, return: returning, sort: "cheapest" });

  const tracked = await scope.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await tracked.newPage();

  /* Signed out, the link lands on the gate and the gate keeps the link. */
  await page.goto(`${stack.baseUrl}${link}`);
  assert.equal(new URL(page.url()).pathname, "/login");
  assert.equal(new URL(page.url()).searchParams.get("next"), link);
  assert.equal(fake.requests().length, 0, "nothing is searched before the sign-in");

  /* A wrong password is announced and costs the attempt, not the link. */
  await signInThroughGate(page, `${stack.password}-wrong`);
  await login.error(page).waitFor();
  assert.equal(new URL(page.url()).pathname, "/login");
  assert.equal(new URL(page.url()).searchParams.get("next"), link);

  /* The right one lands back on the link, which runs its search. */
  await signInThroughGate(page, stack.password);
  await page.waitForURL((url) => url.pathname === "/" && url.searchParams.get("origin") === "LIM");
  const landed = new URL(page.url()).searchParams;
  assert.equal(landed.get("destination"), "MIA");
  assert.equal(landed.get("departure"), departure);
  assert.equal(landed.get("return"), returning);

  await eventually(async () => assert.deepEqual(await readResultCount(page), { visible: 6, total: 6 }), { message: "six merged results" });
  await searchForm.submit(page).waitFor();
  await page.waitForLoadState("networkidle");

  /* Exactly one search reached each provider: one Agil start, one call per
     GDS id, one Click and Book Plus call. */
  const route = { origin: "LIM", destination: "MIA", departureDate: departure, returnDate: returning };
  assert.equal(fake.requests("agil.startSearch").length, 1);
  const agilCalls = fake.requests("agil.search");
  assert.deepEqual(agilCalls.map((request) => request.query?.gds).sort((a, b) => a! - b!), [...AGIL_GDS_IDS]);
  assert.ok(agilCalls.every((request) => request.query?.origin === "LIM" && request.query.returnDate === returning));
  assert.equal(providerSearches(fake, route).filter((request) => request.op === "cbplus.search").length, 1);

  /* Merged: both providers in one list, cheapest first. */
  const merged = await readCards(page);
  assert.deepEqual([...new Set(merged.map((card) => card.provider))].sort(), ["Agilsmart", "Click and Book Plus"]);
  assert.deepEqual(merged.map((card) => card.amount), [455, 498, 540, 612, 689, 700]);

  /* An airline, then stops: the count and the rows move together. */
  await filters.airline(page, "LATAM").click();
  await eventually(async () => assert.deepEqual(await readResultCount(page), { visible: 2, total: 6 }));
  assert.match(await results.headerLine(page).innerText(), /4 vuelos ocultos por filtros/);
  let rows = await readCards(page);
  assert.deepEqual(rows.map((card) => card.airline), ["LATAM", "LATAM"]);
  assert.deepEqual(rows.map((card) => card.provider).sort(), ["Agilsmart", "Click and Book Plus"]);

  await filters.stops(page, "Directo").click();
  await eventually(async () => assert.deepEqual(await readResultCount(page), { visible: 1, total: 6 }));
  rows = await readCards(page);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.legs.map((leg) => leg.stops), ["Directo", "Directo"]);
  assert.equal(new URL(page.url()).searchParams.get("nonStop"), "1");
  assert.equal(new URL(page.url()).searchParams.get("airlines"), "LA");

  await filters.stops(page, "Todos").click();
  await eventually(async () => assert.deepEqual(await readResultCount(page), { visible: 2, total: 6 }));
  assert.deepEqual((await readCards(page)).map((card) => card.amount), [540, 689]);

  /* Duration: the address bar says so and the direct LATAM moves up. */
  await results.sort(page, "duración").click();
  await page.waitForURL((url) => url.searchParams.get("sort") === "fastest");
  assert.equal(await results.sort(page, "duración").getAttribute("aria-checked"), "true");
  await eventually(async () => assert.deepEqual((await readCards(page)).map((card) => card.amount), [689, 540]));

  /* Detail and quotation: the provider is asked again, and the text quotes
     the fare per adult. */
  await results.card(page, /Click and Book Plus$/).click();
  const offerPanel = detail.surface(page);
  await offerPanel.waitFor();
  const cbplusBefore = fake.requests("cbplus.search").length;
  await detail.quote(offerPanel).click();
  const quoteDialog = quotation.dialog(page);
  await quoteDialog.waitFor();
  assert.equal(fake.requests("cbplus.search").length, cbplusBefore + 1, "the quotation revalidated the fare with the provider");
  const revalidation = fake.requests("cbplus.search").at(-1)!;
  assert.equal(revalidation.query?.departureDate, departure);
  assert.equal(revalidation.query?.returnDate, returning);
  const quoteText = await quoteDialog.innerText();
  assert.match(quoteText, /US\$\s*689(?:\.00)? por adulto/);
  await quotation.close(page).click();
  await quoteDialog.waitFor({ state: "hidden" });

  /* Each provider's purchase page, through `/r/<id>` and its 302. */
  const expectedCbplus = `https://flights.zdev.tech/vuelos/pro/b/LIM/MIA/${departure}/${returning}/1/0/0`;
  const cbplusPopup = tracked.context.waitForEvent("page");
  await detail.purchase(offerPanel).click();
  const cbplusPage = await cbplusPopup;
  const cbplusRedirect = await eventually(() => {
    const found = tracked.redirects.at(-1);
    assert.ok(found, "the Click and Book Plus purchase path was not opened");
    return found;
  });
  assert.match(new URL(cbplusRedirect.from).pathname, /^\/r\/[A-Za-z0-9._:-]+$/);
  assert.equal(new URL(cbplusRedirect.from).origin, stack.baseUrl);
  assert.equal(cbplusRedirect.status, 302);
  const cbplusLocation = new URL(cbplusRedirect.location);
  assert.equal(`${cbplusLocation.origin}${cbplusLocation.pathname}`, expectedCbplus);
  assert.equal(cbplusLocation.searchParams.get("terminalId"), FAKE_CBPLUS_TERMINAL_ID);
  await cbplusPage.close();

  await results.card(page, /Agilsmart$/).click();
  await eventually(async () => assert.match(await offerPanel.innerText(), /Agilsmart/));
  const agilPopup = tracked.context.waitForEvent("page");
  await detail.purchase(offerPanel).click();
  const agilPage = await agilPopup;
  const agilRedirect = await eventually(() => {
    assert.equal(tracked.redirects.length, 2, "the Agil purchase path was not opened");
    return tracked.redirects[1]!;
  });
  assert.equal(agilRedirect.status, 302);
  assert.match(new URL(agilRedirect.from).pathname, /^\/r\//);
  assert.notEqual(agilRedirect.from, cbplusRedirect.from);
  const agilLocation = new URL(agilRedirect.location);
  assert.equal(`${agilLocation.origin}${agilLocation.pathname}`, "https://www.agilsmart.com/home-user/flight-result");
  assert.equal(agilLocation.searchParams.get("departureLocation"), "LIM");
  assert.equal(agilLocation.searchParams.get("departureDate"), departure.split("-").reverse().join("/"));
  await agilPage.close();

  /* The Click and Book Plus token only ever travels inside that 302. */
  const html = await page.content();
  assert.ok(!html.includes(CBPLUS_TOKEN), "the token reached the DOM");
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.ok(!storage.includes(CBPLUS_TOKEN), "the token reached web storage");
  const bodies = await tracked.apiBodies();
  assert.ok(bodies.length > 0);
  assert.deepEqual(bodies.filter((entry) => entry.body.includes(CBPLUS_TOKEN)).map((entry) => entry.url), [], "the token reached an /api answer");
  assert.ok(cbplusLocation.searchParams.get("token") === CBPLUS_TOKEN, "the 302 is where the token belongs");
});
