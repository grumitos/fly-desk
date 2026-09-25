import assert from "node:assert/strict";
import type { CanonicalOffer } from "../../src/core/types.ts";
import {
  readMatrixJob,
  readSearchJob,
  searchOffers,
  type MatrixJob,
  type QuotationAnswer,
  type SearchJob,
} from "./support/api-client.ts";
import { readWholeList, rowKey, runSearch, waitForMotion, waitForResults } from "./support/flows.ts";
import { defineSuite, type TestScope } from "./support/harness.ts";
import { fakeCbplusToken, FAKE_CBPLUS_TERMINAL_ID, type OfferSpec, type SearchQuery } from "./support/fixtures.ts";
import {
  AGIL_GDS_IDS,
  addDays,
  addMonths,
  day,
  deskDate,
  deskMonth,
  eventually,
  monthKey,
  providerSearches,
  spanishDayName,
  spanishMonthName,
  TODAY,
  weekday,
} from "./support/scenario.ts";
import {
  announcement,
  detail,
  drawnOpacity,
  filters,
  isFocused,
  isWithin,
  login,
  quotation,
  readCards,
  readResultCount,
  results,
  searchForm,
  searchLink,
  signInThroughGate,
  topBar,
} from "./support/ui.ts";

/*
 * The desk at 1440×900: a shared link through the sign-in gate, a flexible
 * round trip over the matrix, a week-long range that returns hundreds of
 * fares, and the list, the form and both calendars from the keyboard.
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

  /* The link's two stations were each looked up once. */
  const lookedUp = tracked.apiRequests
    .filter((request) => new URL(request.url).pathname === "/api/locations")
    .map((request) => new URL(request.url).searchParams.get("q"));
  assert.deepEqual(lookedUp.sort(), ["LIM", "MIA"], "a station of the link was looked up more than once");

  /* Merged: both providers in one list, cheapest first, and read out. */
  const merged = await readCards(page);
  assert.deepEqual([...new Set(merged.map((card) => card.provider))].sort(), ["Agilsmart", "Click and Book Plus"]);
  assert.deepEqual(merged.map((card) => card.amount), [455, 498, 540, 612, 689, 700]);
  await announcement.status(page, "6 vuelos").waitFor({ timeout: 5_000 });

  /* An airline, then stops: the count, the rows and what is read out move together. */
  await filters.airline(page, "LATAM").click();
  await eventually(async () => assert.deepEqual(await readResultCount(page), { visible: 2, total: 6 }));
  assert.match(await results.headerLine(page).innerText(), /4 vuelos ocultos por filtros/);
  await announcement.status(page, "2 vuelos de 6").waitFor({ timeout: 5_000 });
  let rows = await readCards(page);
  assert.deepEqual(rows.map((card) => card.airline), ["LATAM", "LATAM"]);
  assert.deepEqual(rows.map((card) => card.provider).sort(), ["Agilsmart", "Click and Book Plus"]);

  await filters.stops(page, "Directo").click();
  await eventually(async () => assert.deepEqual(await readResultCount(page), { visible: 1, total: 6 }));
  await announcement.status(page, "1 vuelo de 6").waitFor({ timeout: 5_000 });
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

  /* A popup blocker is named on the panel, and nothing is asked for. */
  await page.evaluate(() => {
    window.open = () => null;
  });
  await detail.purchase(offerPanel).click();
  await detail.purchaseFeedback(offerPanel).filter({ hasText: /^El navegador bloqueó la ventana del proveedor\./ }).waitFor({ timeout: 5_000 });
  assert.equal(tracked.redirects.length, 2, "a blocked window still asked for its purchase path");

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

/* ---- The flexible round trip: `/api/matrix`, one cell per departure day ---- */

const STAY_NIGHTS = 7;
const MATRIX_DAYS = [day(60), day(61), day(62), day(63)] as const;
const back = (departure: string) => addDays(departure, STAY_NIGHTS);

function mexicoByAgil(query: SearchQuery): OfferSpec[] {
  const price = query.departureDate === MATRIX_DAYS[0] ? 612 : query.departureDate === MATRIX_DAYS[2] ? 655 : undefined;
  return price === undefined ? [] : [{
    outbound: ["AM 57 LIM-MEX 01:10-06:40"],
    inbound: ["AM 56 MEX-LIM 13:35-20:45"],
    price,
    baggage: { carryOn: true, checked: 1 },
    gds: 7,
  }];
}

function mexicoByCbplus(price: number | undefined): OfferSpec[] {
  return price === undefined ? [] : [{
    outbound: ["CM 472 LIM-PTY 05:59-09:18", "CM 145 PTY-MEX 10:40-13:55"],
    inbound: ["CM 146 MEX-PTY 15:00-19:10", "CM 471 PTY-LIM 20:40-23:59"],
    price,
    baggage: { carryOn: true, checked: 1 },
    brand: "Economy",
  }];
}

suite.test("a flexible round trip fills in cell by cell, keeps the cards it drew, and quotes the fare the provider confirms", async (scope) => {
  const { fake } = scope;
  const cbplusFares = new Map<string, number>([[MATRIX_DAYS[1], 598], [MATRIX_DAYS[3], 640]]);
  fake.setFlights("agil", { origin: "LIM", destination: "MEX" }, mexicoByAgil);
  fake.setFlights("cbplus", { origin: "LIM", destination: "MEX" }, (query) => mexicoByCbplus(cbplusFares.get(query.departureDate)));
  /* Two cells answer at once; the other two stay with their providers until
     the test lets them go, so the partial milestone is the test's, not a
     clock's. (Progress is published at geometric milestones — 1, 2, 4, 8 —
     plus the final state, so a single late cell is not a milestone of its own.) */
  const lateAgil = fake.hold("agil.search", (request) => request.query?.departureDate === MATRIX_DAYS[2]);
  const lateCbplus = fake.hold("cbplus.search", (request) => request.query?.departureDate === MATRIX_DAYS[3]);

  const link = searchLink({
    mode: "flexible",
    trip: "round-trip",
    origin: "LIM",
    destination: "MEX",
    departureStart: MATRIX_DAYS[0],
    departureEnd: MATRIX_DAYS[3],
    stayNights: STAY_NIGHTS,
    flexible: "exact-stay",
  });
  const { tracked, page } = await scope.signedInPage(link);

  /* A price with no flight behind it is coverage, not an offer. The backend
     never emits one today, so the browser is handed one on every matrix answer
     — what a cached row or a future provider could send — and must not draw it. */
  const priceOnlyDeparture = day(64);
  let priceOnlyCellsServed = 0;
  await tracked.context.route((url) => url.pathname === "/api/matrix" || url.pathname.startsWith("/api/matrix/"), async (route) => {
    try {
      const answer = await route.fetch();
      const body = await answer.json() as { cells?: unknown[] };
      if (Array.isArray(body.cells)) {
        body.cells.push({
          key: `${priceOnlyDeparture}_${back(priceOnlyDeparture)}`,
          departureDate: priceOnlyDeparture,
          returnDate: back(priceOnlyDeparture),
          stayNights: STAY_NIGHTS,
          price: { amount: 199, currencyCode: "USD" },
          confidence: "indicative",
          providerSource: "costamar",
          selectable: false,
          requiresRequery: true,
          stateCode: "ind",
        });
        priceOnlyCellsServed += 1;
      }
      const headers = { ...answer.headers() };
      delete headers["content-length"];
      await route.fulfill({ status: answer.status(), headers, body: JSON.stringify(body) });
    } catch {
      /* The page gave up on a long poll (a new search, the end of the test). */
    }
  });

  await searchForm.submit(page).waitFor();
  const started = await runSearch<MatrixJob>(page, "/api/matrix");

  /* A partial milestone: cards from the cells whose providers answered, and
     the pill. Which of the two early cells a milestone has caught depends on
     when it flushed, so any of them will do; the late ones must be absent. */
  const partial = await eventually(async () => {
    const cards = await readCards(page);
    assert.ok(cards.length > 0, "no card yet");
    return cards;
  });
  await results.partialPill(page).waitFor();
  assert.ok(partial.every((card) => card.amount === 598 || card.amount === 612), `a held cell was drawn: ${partial.map((card) => card.amount)}`);
  assert.ok(lateAgil.seen > 0 && lateCbplus.seen > 0, "the two late cells are still with their providers");
  const keptAmount = partial[0]!.amount.toFixed(2);
  const drawnFirst = results.card(page, new RegExp(`USD ${keptAmount.replace(".", "\\.")} total`));
  await drawnFirst.evaluate((element) => element.setAttribute("data-e2e-identity", "drawn-at-the-first-milestone"));

  lateAgil.release();
  lateCbplus.release();
  const settled = await waitForResults(page, 4);
  assert.deepEqual(settled.map((card) => card.amount), [598, 612, 640, 655]);
  await results.partialPill(page).waitFor({ state: "hidden" });
  assert.equal(
    await drawnFirst.getAttribute("data-e2e-identity"),
    "drawn-at-the-first-milestone",
    "the card drawn at the first milestone was rebuilt instead of kept",
  );
  assert.ok(priceOnlyCellsServed > 0, "the price-only cell never reached the page");
  assert.equal(await results.card(page, /USD 199\.00 total/).count(), 0, "a price-only cell became a card");

  /* The job as the backend holds it: four cells with a flight each, every
     cell asked of both providers exactly once. */
  const api = await scope.api();
  const job = await readMatrixJob(api, started.matrixJobId);
  assert.equal(job.matrixStatus, "completed");
  assert.deepEqual(
    (job.cells ?? []).filter((cell) => cell.offer).map((cell) => `${cell.departureDate}:${cell.providerSource}:${cell.price?.amount}`).sort(),
    [`${MATRIX_DAYS[0]}:agil-local:612`, `${MATRIX_DAYS[1]}:costamar:598`, `${MATRIX_DAYS[2]}:agil-local:655`, `${MATRIX_DAYS[3]}:costamar:640`],
  );
  for (const departure of MATRIX_DAYS) {
    const route = { origin: "LIM", destination: "MEX", departureDate: departure, returnDate: back(departure) };
    assert.equal(providerSearches(fake, route).filter((request) => request.op === "cbplus.search").length, 1, `cbplus calls for ${departure}`);
    assert.deepEqual(
      providerSearches(fake, route).filter((request) => request.op === "agil.search").map((request) => request.query?.gds).sort((a, b) => a! - b!),
      [...AGIL_GDS_IDS],
      `agil calls for ${departure}`,
    );
  }

  /* The provider now asks 603.50 for the 598 fare: the quote goes back to
     it, and both the card and the text carry the new figure. */
  cbplusFares.set(MATRIX_DAYS[1], 603.5);
  const cbplusBefore = fake.requests("cbplus.search").length;
  await results.card(page, /USD 598\.00 total/).click();
  const panel = detail.surface(page);
  await eventually(async () => assert.match(await panel.innerText(), /Click and Book Plus/));
  await detail.quote(panel).click();
  const quoteDialog = quotation.dialog(page);
  await quoteDialog.waitFor();
  assert.match(await quoteDialog.innerText(), /US\$\s*603\.50 por adulto/);
  const revalidations = fake.requests("cbplus.search").slice(cbplusBefore);
  assert.equal(revalidations.length, 1, "the quote asked the provider once");
  assert.equal(revalidations[0]!.query?.departureDate, MATRIX_DAYS[1]);
  assert.equal(revalidations[0]!.query?.returnDate, back(MATRIX_DAYS[1]));
  await eventually(async () => assert.deepEqual((await readCards(page)).map((card) => card.amount), [603.5, 612, 640, 655]));
  const validatedCell = (await readMatrixJob(api, started.matrixJobId)).cells?.find((cell) => cell.departureDate === MATRIX_DAYS[1]);
  assert.equal(validatedCell?.confidence, "validated");
  assert.equal(validatedCell?.price?.amount, 603.5);
  await quotation.close(page).click();
  await quoteDialog.waitFor({ state: "hidden" });

  /* Within fifteen minutes the confirmed fare is reused, not asked for again. */
  assert.ok(validatedCell?.offer?.quotationPreparedAt, "the matrix keeps the quoted offer unprepared for quoting");
  await eventually(async () => assert.equal(await detail.quote(panel).isEnabled(), true, "«Cotizar» stays disabled after a quote"), { timeoutMs: 5_000 });
  await detail.quote(panel).click();
  await quoteDialog.waitFor();
  assert.match(await quoteDialog.innerText(), /US\$\s*603\.50 por adulto/);
  assert.equal(fake.requests("cbplus.search").length, cbplusBefore + 1, "a second quote within 15 minutes asked the provider again");
  assert.equal(tracked.apiRequests.filter((request) => new URL(request.url).pathname === "/api/quotation").length, 2);
});

/**
 * Quotes the fare on `card` from its panel, then quotes it again. The fare was
 * confirmed a moment ago, so the second quote reuses it. Returns the first
 * answer and the quoted offer as the job keeps it.
 */
async function quoteTwice(
  scope: TestScope,
  link: string,
  fares: number,
  card: RegExp,
): Promise<{ answer: QuotationAnswer; stored: CanonicalOffer | undefined }> {
  const { fake } = scope;
  const { tracked, page } = await scope.signedInPage(link);
  await waitForResults(page, fares);
  await results.card(page, card).click();
  const panel = detail.surface(page);
  await detail.quote(panel).click();
  const quoteDialog = quotation.dialog(page);
  await quoteDialog.waitFor();
  await quotation.close(page).click();
  await quoteDialog.waitFor({ state: "hidden" });
  const calls = fake.requests("cbplus.search").length;

  await eventually(async () => assert.equal(await detail.quote(panel).isEnabled(), true, "«Cotizar» stays disabled after a quote"), { timeoutMs: 5_000 });
  await detail.quote(panel).click();
  await quoteDialog.waitFor();
  assert.equal(fake.requests("cbplus.search").length, calls, "the second quote asked the provider again");
  const answers = (await tracked.apiBodies()).filter((entry) => new URL(entry.url).pathname === "/api/quotation");
  assert.equal(answers.length, 2);

  const answer = JSON.parse(answers[0]!.body) as QuotationAnswer;
  const job = await readSearchJob(await scope.api(), answer.searchSessionId);
  return { answer, stored: searchOffers(job).find((offer) => offer.id === answer.offer.id) };
}

suite.test("an offer the desk has just quoted can be quoted again from its panel", async (scope) => {
  scope.fake.setFlights("cbplus", { origin: "LIM", destination: "MIA" }, LIM_MIA_CBPLUS);
  const link = searchLink({ mode: "exact", trip: "round-trip", origin: "LIM", destination: "MIA", departure: day(34), return: day(41) });
  const { answer, stored } = await quoteTwice(scope, link, 2, /USD 689\.00 total/);
  assert.ok(answer.offer.quotationPreparedAt, "the quotation answered with an offer not prepared for quoting");
  assert.ok(stored, "the job lost the quoted offer");
  assert.equal(stored.priceStatus, "verified");
  assert.ok(stored.quotationPreparedAt, "the job keeps the quoted offer unprepared for quoting");
});

suite.test("a fare inside Peru the desk has just quoted keeps its exchange rate and can be quoted again", async (scope) => {
  /* Quoted in soles: the fare is quotable only with the rate the list gave it,
     which the provider's confirmation does not carry. */
  scope.fake.setFlights("cbplus", { origin: "LIM", destination: "CUZ" }, [
    { outbound: ["LA2047 LIM-CUZ 07:15-08:40"], price: 151.3, baggage: { carryOn: true, checked: 1 }, brand: "Plus" },
  ]);
  const link = searchLink({ mode: "exact", trip: "one-way", origin: "LIM", destination: "CUZ", departure: day(35) });
  const { stored } = await quoteTwice(scope, link, 1, /USD 151\.30 total/);
  assert.ok(stored, "the job lost the quoted offer");
  assert.equal(stored.priceStatus, "verified");
  assert.ok(stored.quotationPreparedAt, "the job keeps the quoted offer unprepared for quoting");
  assert.equal(typeof stored.usdToPenRate, "number", "the quoted offer lost the exchange rate the list gave it");
});

/* ---- A week-long one-way range: some three hundred fares ---- */

const RANGE_DAYS = [day(50), day(51), day(52)] as const;
const OFFERS_PER_DAY = { agilPerGds: 10, cbplus: 30 } as const;
const RANGE_TOTAL = RANGE_DAYS.length * (AGIL_GDS_IDS.length * OFFERS_PER_DAY.agilPerGds + OFFERS_PER_DAY.cbplus);

function clockOf(minutes: number): string {
  const days = Math.floor(minutes / 1440);
  const inDay = minutes % 1440;
  return `${String(Math.floor(inDay / 60)).padStart(2, "0")}:${String(inDay % 60).padStart(2, "0")}${days > 0 ? `+${days}` : ""}`;
}

/*
 * LIM–MIA in January: Miami keeps Lima's UTC-5 then, so a wall clock is a
 * duration and every figure below is what the row shows. Built so that the
 * count is exact and the order has to work for it:
 *
 *  - every fare has flights of its own (a provider dedupes on the flight and
 *    the fare), and one itinerary per fare, so no provider schedule group can
 *    fold two rows into one;
 *  - prices repeat every nine fares, departures every twelve and stops every
 *    three, so every order is decided by its tie-breaks most of the time;
 *  - durations never repeat, so two rows never read alike and a swap shows.
 */
function januaryRange(query: SearchQuery): OfferSpec[] {
  const dayIndex = RANGE_DAYS.indexOf(query.departureDate as (typeof RANGE_DAYS)[number]);
  if (dayIndex < 0) return [];
  const fare = (n: number) => 500 + (n % 9) * 25;
  const duration = (n: number) => 600 + dayIndex * 100 + n;

  if (query.provider === "agil") {
    const gdsIndex = AGIL_GDS_IDS.indexOf((query.gds ?? 0) as (typeof AGIL_GDS_IDS)[number]);
    return Array.from({ length: OFFERS_PER_DAY.agilPerGds }, (_, index): OfferSpec => {
      const n = gdsIndex * OFFERS_PER_DAY.agilPerGds + index;
      const departs = 300 + (n % 12) * 60;
      const arrives = departs + duration(n);
      const flight = 1000 + dayIndex * 300 + n * 3;
      const stops = n % 3;
      const outbound = stops === 0
        ? [`LA${flight} LIM-MIA ${clockOf(departs)}-${clockOf(arrives)}`]
        : stops === 1
          ? [`LA${flight} LIM-BOG ${clockOf(departs)}-${clockOf(departs + 200)}`, `LA${flight + 1} BOG-MIA ${clockOf(departs + 260)}-${clockOf(arrives)}`]
          : [
            `LA${flight} LIM-BOG ${clockOf(departs)}-${clockOf(departs + 200)}`,
            `LA${flight + 1} BOG-PTY ${clockOf(departs + 260)}-${clockOf(departs + 360)}`,
            `LA${flight + 2} PTY-MIA ${clockOf(departs + 420)}-${clockOf(arrives)}`,
          ];
      return { outbound, price: fare(n), baggage: { carryOn: true, checked: n % 2 }, gds: query.gds ?? 0 };
    });
  }

  return Array.from({ length: OFFERS_PER_DAY.cbplus }, (_, index): OfferSpec => {
    const n = AGIL_GDS_IDS.length * OFFERS_PER_DAY.agilPerGds + index;
    const departs = 330 + (index % 10) * 60;
    return {
      outbound: [`AV${3000 + dayIndex * 100 + index} LIM-MIA ${clockOf(departs)}-${clockOf(departs + duration(n))}`],
      price: fare(n),
      baggage: { carryOn: true, checked: 1 },
    };
  });
}

suite.test("a week of one-way fares keeps every one of three hundred, in the same order twice, growing as it scrolls", async (scope) => {
  const { fake } = scope;
  fake.setFlights("both", { origin: "LIM", destination: "MIA" }, januaryRange);
  const api = await scope.api();

  /* An order the catalogue does not know falls back to price, on screen and
     in what the backend is asked for. */
  const link = searchLink({ mode: "flexible", trip: "one-way", origin: "LIM", destination: "MIA", departureStart: RANGE_DAYS[0], departureEnd: RANGE_DAYS[2], sort: "bogus" });
  const { page } = await scope.signedInPage(link);
  await searchForm.submit(page).waitFor();
  const first = await runSearch<SearchJob>(page);
  assert.equal(first.sortMode, "cheapest");
  await waitForResults(page, RANGE_TOTAL);
  assert.equal(await results.sort(page, "precio").getAttribute("aria-checked"), "true");
  assert.equal(new URL(page.url()).searchParams.get("sort"), "cheapest");

  /* Nothing is dropped between the providers and the list. */
  const firstJob = await readSearchJob(api, first.searchJobId);
  assert.equal(firstJob.searchStatus, "completed");
  assert.equal(firstJob.allOffers?.length, RANGE_TOTAL);
  for (const departureDate of RANGE_DAYS) {
    const route = { origin: "LIM", destination: "MIA", departureDate };
    assert.equal(providerSearches(fake, route).filter((request) => request.op === "cbplus.search").length, 1);
    assert.equal(providerSearches(fake, route).filter((request) => request.op === "agil.search").length, AGIL_GDS_IDS.length);
  }

  /* The list opens on what the column holds and grows as it is scrolled. */
  const opened = await results.cards(page).count();
  assert.ok(opened > 0 && opened < RANGE_TOTAL, `the list opened with ${opened} rows`);
  const byPrice = await readWholeList(page, RANGE_TOTAL);
  const amounts = byPrice.map((card) => card.amount);
  assert.deepEqual(amounts, [...amounts].sort((left, right) => left - right), "not ordered by price");

  /* A filter is a new list, read from its first row. */
  await results.viewport(page).evaluate((element) => element.scrollTo({ top: element.scrollHeight / 2 }));
  await eventually(async () => assert.ok(await results.viewport(page).evaluate((element) => element.scrollTop) > 0));
  await filters.stops(page, "1").click();
  const oneStopOrLess = byPrice.filter((card) => card.legs[0]!.stops === "Directo" || card.legs[0]!.stops.startsWith("1 escala"));
  await eventually(async () => assert.deepEqual(await readResultCount(page), { visible: oneStopOrLess.length, total: RANGE_TOTAL }));
  assert.equal(await results.viewport(page).evaluate((element) => element.scrollTop), 0, "the filtered list did not start at its first row");
  assert.equal((await readCards(page))[0]!.label, oneStopOrLess[0]!.label);

  /* So is another value of the same filter. */
  await results.viewport(page).evaluate((element) => element.scrollTo({ top: element.scrollHeight / 2 }));
  await eventually(async () => assert.ok(await results.viewport(page).evaluate((element) => element.scrollTop) > 0));
  await filters.stops(page, "Directo").click();
  const direct = byPrice.filter((card) => card.legs[0]!.stops === "Directo");
  await eventually(async () => assert.deepEqual(await readResultCount(page), { visible: direct.length, total: RANGE_TOTAL }));
  assert.equal(await results.viewport(page).evaluate((element) => element.scrollTop), 0, "another value of the same filter kept the scroll");
  assert.equal((await readCards(page))[0]!.label, direct[0]!.label);
  await filters.clear(page).click();
  await eventually(async () => assert.deepEqual(await readResultCount(page), { visible: RANGE_TOTAL, total: RANGE_TOTAL }));

  /* Departure and stops, read whole. */
  await results.sort(page, "hora de salida").click();
  const firstByDeparture = await readWholeList(page, RANGE_TOTAL);
  await results.sort(page, "número de escalas").click();
  const firstByStops = await readWholeList(page, RANGE_TOTAL);

  /* The same search again, with the providers answering in another order:
     reversed lists, Click and Book Plus first, Agil's GDS ids one by one. */
  fake.setFlights("both", { origin: "LIM", destination: "MIA" }, (query) => [...januaryRange(query)].reverse());
  AGIL_GDS_IDS.forEach((gds, index) => fake.delay("agil.search", 40 * (AGIL_GDS_IDS.length - index), (request) => request.query?.gds === gds));
  const second = await runSearch<SearchJob>(page);
  assert.equal(second.sortMode, "stops");
  await waitForResults(page, RANGE_TOTAL);
  const secondByStops = await readWholeList(page, RANGE_TOTAL);
  await results.sort(page, "hora de salida").click();
  const secondByDeparture = await readWholeList(page, RANGE_TOTAL);
  assert.deepEqual(secondByStops.map((card) => card.label), firstByStops.map((card) => card.label), "the stops order changed between two runs");
  assert.deepEqual(secondByDeparture.map((card) => card.label), firstByDeparture.map((card) => card.label), "the departure order changed between two runs");

  /* And the desk draws the order the backend computed. */
  const secondJob = await readSearchJob(api, second.searchJobId);
  const backendByStops = (secondJob.allOffers ?? []).map((offer) => {
    const segments = offer.itineraries[0]!.segments;
    return `${offer.providerSource === "costamar" ? "Click and Book Plus" : "Agilsmart"}|${segments[0]!.departureAt.slice(11, 16)}|${segments.at(-1)!.arrivalAt.slice(11, 16)}|${offer.itineraries[0]!.stops}|${offer.price.total.amount.toFixed(2)}`;
  });
  assert.deepEqual(secondByStops.map(rowKey), backendByStops, "the desk and the backend disagree about the stops order");
});

/* ---- The keyboard ---- */

/* Fifteen direct fares a provider on one day, one row each: more than the
   column shows at once. */
const BOGOTA: OfferSpec[] = Array.from({ length: 15 }, (_, index): OfferSpec => {
  const departs = 360 + index * 45;
  return {
    outbound: [`AV${8100 + index} LIM-BOG ${clockOf(departs)}-${clockOf(departs + 200)}`],
    price: 300 + index * 11,
    baggage: { carryOn: true, checked: index % 2 },
  };
});

suite.test("the list, its column head and the passenger popover answer the keyboard, and a filter or an order keeps an edit of the form", async (scope) => {
  const { fake } = scope;
  fake.setFlights("both", { origin: "LIM", destination: "BOG" }, BOGOTA);
  const providers = fake.hold("*", (request) => request.op === "agil.search" || request.op === "cbplus.search");
  const { page } = await scope.signedInPage(searchLink({ mode: "exact", trip: "one-way", origin: "LIM", destination: "BOG", departure: day(45) }));

  /* Busy, the search button says «Detener» with no pointer over it. */
  const stop = searchForm.stop(page);
  await stop.waitFor();
  await waitForMotion(page);
  assert.equal(await drawnOpacity(stop.getByText("Detener", { exact: true })), 1, "«Detener» shows only under a pointer");
  providers.release();
  await waitForResults(page, BOGOTA.length * 2);

  /* The column head is one tab stop; an arrow changes the order and takes the focus with it. */
  const tabStops = await results.sorts(page).evaluateAll((radios) => radios.filter((radio) => (radio as HTMLElement).tabIndex === 0).length);
  assert.equal(tabStops, 1, "the column head is more than one tab stop");
  await results.sort(page, "precio").focus();
  await page.keyboard.press("ArrowLeft");
  await page.waitForURL((url) => url.searchParams.get("sort") === "stops");
  assert.equal(await results.sort(page, "número de escalas").getAttribute("aria-checked"), "true");
  assert.ok(await isFocused(results.sort(page, "número de escalas")), "the arrow left the focus behind");
  await page.keyboard.press("ArrowRight");
  await page.waitForURL((url) => url.searchParams.get("sort") === "cheapest");

  /* ↓ walks the list and keeps the offer it lands on in view; ↑ too. */
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const list = results.viewport(page);
  const selected = results.selectedCard(page);
  const visited = new Set<string>();
  for (const [key, presses] of [["ArrowDown", 20], ["ArrowUp", 6]] as const) {
    for (let press = 1; press <= presses; press += 1) {
      await page.keyboard.press(key);
      await eventually(async () => assert.ok(await isWithin(selected, list), `${key} ${press} left the offer it chose out of view`), { timeoutMs: 2_000 });
      visited.add(await selected.getAttribute("aria-label") ?? "");
    }
  }
  assert.equal(visited.size, 20, "the arrows did not move the selection one row at a time");

  /* ↓ inside the passenger popover is the popover's; Esc closes it and keeps the offer. */
  const chosen = await selected.getAttribute("aria-label");
  await searchForm.passengers(page).click();
  const addChild = searchForm.addPassenger(page, "niños");
  await addChild.waitFor();
  await page.keyboard.press("ArrowDown");
  assert.equal(await selected.getAttribute("aria-label"), chosen, "↓ in the passenger popover moved the list's selection");
  await page.keyboard.press("Escape");
  await addChild.waitFor({ state: "hidden" });
  assert.equal(await selected.getAttribute("aria-label"), chosen, "Esc in the passenger popover dropped the offer");

  /* A filter and an order leave a destination being typed as it is. */
  const destination = searchForm.location(page, "Destino");
  await destination.fill("CUZ");
  await filters.stops(page, "Directo").click();
  await page.waitForURL((url) => url.searchParams.get("nonStop") === "1");
  assert.match(await destination.inputValue(), /^CUZ\b/, "a filter discarded the destination being typed");
  await results.sort(page, "duración").click();
  await page.waitForURL((url) => url.searchParams.get("sort") === "fastest");
  assert.match(await destination.inputValue(), /^CUZ\b/, "an order discarded the destination being typed");
});

suite.test("at rest the desk is worked from the keyboard: a copy button with nothing to copy, both calendars, and «hoy» on the desk's day whatever the browser's clock says", async (scope) => {
  const tracked = await scope.newContext({ signedIn: true });
  /* Eight in the evening in Lima, when UTC is already on the next day. */
  await tracked.context.clock.install({ time: new Date(`${addDays(TODAY, 1)}T01:00:00Z`) });
  const page = await tracked.newPage();
  await page.goto(scope.stack.baseUrl);

  /* With nothing to copy yet, «Copiar configuración» says so and still takes
     the focus, for the tooltip that tells why. */
  const copy = topBar.copyConfig(page);
  assert.equal(await copy.getAttribute("aria-disabled"), "true", "«Copiar configuración» does not say it has nothing to copy");
  await copy.focus();
  assert.ok(await isFocused(copy), "«Copiar configuración» cannot take the focus");

  /* Enter opens the days on today, the one day in the tab order. */
  const departureHalf = searchForm.departureHalf(page);
  await departureHalf.focus();
  await page.keyboard.press("Enter");
  const calendar = searchForm.calendarPopover(page);
  await calendar.waitFor();
  const today = searchForm.calendarToday(calendar);
  assert.equal(await today.getAttribute("aria-label"), `${spanishDayName(TODAY)}, hoy`, "the calendar marks another day as today");
  await eventually(async () => assert.ok(await isFocused(today), "the calendar opened with the focus elsewhere"), { timeoutMs: 2_000 });

  /* Two days on, a week down, a month on and back to Monday: the departure.
     November's 29th has a twin in December. */
  const weekDown = addDays(TODAY, 2 + 7);
  const monthOn = `${addMonths(monthKey(weekDown), 1)}-${weekDown.slice(8)}`;
  const outbound = addDays(monthOn, -weekday(monthOn));
  for (const key of ["ArrowRight", "ArrowRight", "ArrowDown", "PageDown", "Home"]) {
    await page.keyboard.press(key);
  }
  assert.ok(await isFocused(searchForm.calendarDay(calendar, outbound)), "the keys did not lead to the departure");
  await page.keyboard.press("Enter");
  assert.equal(await departureHalf.getAttribute("aria-label"), `Salida: ${deskDate(outbound)}`);

  /* A week down and on to Sunday: the return. */
  for (const key of ["ArrowDown", "End", "Enter"]) {
    await page.keyboard.press(key);
  }
  assert.equal(await searchForm.returnHalf(page).getAttribute("aria-label"), `Regreso: ${deskDate(addDays(outbound, 13))}`);

  /* Esc gives the focus back to the half that opened the calendar, and the
     cross is named for both dates it empties. */
  await page.keyboard.press("Escape");
  await calendar.waitFor({ state: "hidden" });
  assert.ok(await isFocused(departureHalf), "Esc did not give the focus back to the departure");
  await searchForm.clearDates(page).waitFor();

  /* The months the same way: this month, one on, then a row down. */
  await searchForm.mode(page, "Migratorio").click();
  const months = searchForm.months(page);
  await months.focus();
  await page.keyboard.press("Enter");
  const picker = searchForm.monthPicker(page);
  await picker.waitFor();
  const thisMonth = searchForm.calendarToday(picker);
  assert.equal(await thisMonth.getAttribute("aria-label"), `${spanishMonthName(monthKey(TODAY))}, hoy`);
  await eventually(async () => assert.ok(await isFocused(thisMonth), "the month picker opened with the focus elsewhere"), { timeoutMs: 2_000 });
  for (const key of ["ArrowRight", "Enter", "ArrowDown", "Enter"]) {
    await page.keyboard.press(key);
  }
  await picker.waitFor({ state: "hidden" });
  const first = addMonths(monthKey(TODAY), 1);
  assert.equal(await months.getAttribute("aria-label"), `Meses: ${deskMonth(first)} – ${deskMonth(addMonths(first, 4))}`);
  assert.ok(await isFocused(months), "the months were chosen but the focus did not come back to the field");
});
