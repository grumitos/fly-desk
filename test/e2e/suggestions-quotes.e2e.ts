import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { LocationSuggestion } from "../../src/core/types.ts";
import { readSearchJob, searchOffers, type SearchJob } from "./support/api-client.ts";
import { startedJob, waitForResults } from "./support/flows.ts";
import { defineSuite } from "./support/harness.ts";
import type { OfferSpec } from "./support/fixtures.ts";
import { day, eventually, providerSearches } from "./support/scenario.ts";
import {
  announcement,
  detail,
  notice,
  pastedQuotation,
  quotation,
  results,
  searchForm,
  searchLink,
  topBar,
} from "./support/ui.ts";

/*
 * The desk's shortcuts: suggestions from both providers, the stations a
 * browser and the whole desk use most, a commercial quotation pasted back in,
 * prices quoted in soles for a domestic trip, and a search copied to share.
 */

const suite = defineSuite({ file: import.meta.filename });

const CUSCO: OfferSpec[] = [
  { outbound: ["LA2045 LIM-CUZ 05:40-07:05"], inbound: ["LA2046 CUZ-LIM 08:10-09:35"], price: 142.8, baggage: { carryOn: true, checked: 0 }, seats: 7 },
  { outbound: ["H2 5102 LIM-CUZ 06:25-07:50"], inbound: ["H2 5103 CUZ-LIM 09:15-10:40"], price: 118.4, baggage: { carryOn: true, checked: 0 }, seats: 4, gds: 1 },
];

suite.test("a city and its airports come back from both providers, typed by name or by code", async (scope) => {
  const { fake } = scope;
  const { page } = await scope.signedInPage("/");

  await searchForm.location(page, "Origen").fill("buenos");
  await searchForm.suggestion(page, "BUE").waitFor();
  await searchForm.suggestion(page, "EZE").waitFor();
  const asked = fake.requests((request) => request.op === "agil.locations" || request.op === "cbplus.locations");
  assert.deepEqual([...new Set(asked.map((request) => request.op))].sort(), ["agil.locations", "cbplus.locations"]);

  /* What the desk was given: the city from Agil's geotree, the airports from
     both catalogues, each typed. */
  const api = await scope.api();
  const answer = await api.json<{ suggestions: LocationSuggestion[] }>("GET", "/api/locations?q=buenos&limit=8");
  assert.deepEqual(answer.suggestions.map((entry) => `${entry.code}:${entry.type}`), ["BUE:CITY", "EZE:AIRPORT", "AEP:AIRPORT"]);

  /* Aeroparque is in Click and Book Plus's catalogue only. */
  await searchForm.location(page, "Origen").fill("aep");
  await searchForm.suggestion(page, "AEP").click();
  await eventually(async () => assert.match(await searchForm.location(page, "Origen").inputValue(), /^AEP\b/));
});

suite.test("typing a city lists an airport that only Click and Book Plus knows", async (scope) => {
  const { page } = await scope.signedInPage("/");
  await searchForm.location(page, "Origen").fill("buenos");
  await searchForm.suggestion(page, "BUE").waitFor();
  await searchForm.suggestion(page, "AEP").waitFor({ timeout: 3_000 });
  /* Its label is the airport's own name; the city comes from the suggestion. */
  assert.match(await searchForm.suggestion(page, "AEP").innerText(), /Buenos Aires/);
});

suite.test("a new tab offers this browser's recent stations and the desk's frequent ones; another browser only the frequent", async (scope) => {
  const { fake, stack } = scope;
  fake.setFlights("both", { origin: "LIM", destination: "CUZ" }, CUSCO);
  fake.setFlights("both", { origin: "AQP", destination: "CUZ" }, [
    { outbound: ["LA2120 AQP-CUZ 09:10-10:05"], inbound: ["LA2121 CUZ-AQP 11:00-11:55"], price: 99, baggage: { carryOn: true, checked: 0 } },
  ]);

  const { tracked, page } = await scope.signedInPage(searchLink({ mode: "exact", trip: "round-trip", origin: "LIM", destination: "CUZ", departure: day(40), return: day(44) }));
  await waitForResults(page, 4);
  await page.goto(`${stack.baseUrl}${searchLink({ mode: "exact", trip: "round-trip", origin: "AQP", destination: "CUZ", departure: day(41), return: day(45) })}`);
  await waitForResults(page, 2);
  const clientSessionId = await page.evaluate(() => localStorage.getItem("fly-desk:client-session-id"));
  assert.ok(clientSessionId);
  const sentWith = tracked.apiRequests
    .filter((request) => request.method === "POST" && new URL(request.url).pathname === "/api/search")
    .map((request) => (JSON.parse(request.body ?? "{}") as { clientSessionId?: string }).clientSessionId);
  assert.deepEqual(sentWith, [clientSessionId, clientSessionId]);

  /* A new tab of the same browser: its own history, most recent first, above
     the desk's ranking, whose last card is the station used last. */
  const tab = await tracked.newPage();
  await tab.goto(stack.baseUrl);
  await searchForm.location(tab, "Origen").click();
  const recent = searchForm.usageSection(tab, "Recientes");
  const frequent = searchForm.usageSection(tab, "Frecuentes");
  await recent.waitFor();
  await frequent.waitFor();
  assert.deepEqual(await recent.getByRole("option").allInnerTexts(), ["AQP", "LIM"]);
  assert.ok((await frequent.getByRole("option").allInnerTexts()).includes("AQP"), "the last station used is not among the frequent ones");

  /* Another browser: the desk's ranking, nobody else's history. */
  const other = await scope.signedInPage("/");
  await searchForm.location(other.page, "Origen").click();
  await searchForm.usageSection(other.page, "Frecuentes").waitFor();
  assert.equal(await searchForm.usageSection(other.page, "Recientes").count(), 0, "another browser was shown this browser's history");
  assert.deepEqual(
    await searchForm.usageSection(other.page, "Frecuentes").getByRole("option").allInnerTexts(),
    await frequent.getByRole("option").allInnerTexts(),
  );
});

suite.test("a domestic quote is priced in soles and ages while open, pasting it back searches only once confirmed, and copying the search says how it went", async (scope) => {
  const { fake, stack } = scope;
  fake.setFlights("both", { origin: "LIM", destination: "CUZ" }, CUSCO);
  const departure = day(50);
  const returning = day(54);
  const tracked = await scope.newContext({ signedIn: true, clipboard: true });
  /* The page's clock, so the fare's age can be moved on instead of waited for. */
  await tracked.context.clock.install();
  const page = await tracked.newPage();
  await page.goto(`${stack.baseUrl}${searchLink({ mode: "exact", trip: "round-trip", origin: "LIM", destination: "CUZ", departure, return: returning })}`);
  await waitForResults(page, 4);

  /* The quote: soles for a trip inside Peru, and a fare whose age moves while it is open. */
  await results.card(page, /USD 142\.80 total.*Agilsmart$/).click();
  const panel = detail.surface(page);
  await detail.quote(panel).click();
  const quoteDialog = quotation.dialog(page);
  await quoteDialog.waitFor();
  const quoted = await quoteDialog.innerText();
  assert.match(quoted, /S\/\s*[\d.,]+ por adulto/, "a domestic quote is not in soles");
  const fareAge = quotation.fareAge(page);
  assert.match(await fareAge.innerText(), /^Tarifa preparada hace menos de 1 min/);
  await page.clock.runFor(125_000);
  await eventually(async () => assert.match(await fareAge.innerText(), /^Tarifa preparada hace 2 min/), { timeoutMs: 3_000, message: "the fare's age stood still" });
  await quotation.close(page).click();
  await quoteDialog.waitFor({ state: "hidden" });

  /* What an agent gets back from a customer: the same text, dated in full. */
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(copied, /COTIZACI[OÓ]N/);
  const dated = (text: string, iso: string) =>
    text.replace(new RegExp(`· (0?${Number(iso.slice(8))} [a-záéíóú]+) ·`, "g"), `· $1 ${iso.slice(0, 4)} ·`);
  const pasted = dated(dated(copied, departure), returning);
  assert.equal(pasted.match(/ \d{4} ·/g)?.length, 4, "the quotation text did not carry the four stops to date");
  await page.evaluate((text) => navigator.clipboard.writeText(text), pasted);

  /* Pasting opens the reconstruction and runs nothing. */
  await page.goto(stack.baseUrl);
  const searchesBefore = tracked.apiRequests.filter((request) => request.method === "POST" && new URL(request.url).pathname === "/api/search").length;
  const providerCallsBefore = providerSearches(fake).length;
  await topBar.pasteConfig(page).click();
  const preview = pastedQuotation.dialog(page);
  await preview.waitFor();
  assert.match(await preview.innerText(), /LIM → CUZ → LIM/);
  await pastedQuotation.search(page).waitFor();
  assert.equal(await pastedQuotation.search(page).isEnabled(), true, "the reconstruction was not complete enough to search");
  assert.equal(
    tracked.apiRequests.filter((request) => request.method === "POST" && new URL(request.url).pathname === "/api/search").length,
    searchesBefore,
    "pasting searched before it was confirmed",
  );
  assert.equal(providerSearches(fake).length, providerCallsBefore);

  /* Confirmed: a new search of those dates, the fare in the text ignored. */
  const job = await startedJob<SearchJob>(page, () => pastedQuotation.search(page).click());
  await preview.waitFor({ state: "hidden" });
  await waitForResults(page, 4);
  const api = await scope.api();
  const stored = await readSearchJob(api, job.searchJobId);
  assert.equal(searchOffers(stored).length, 4);
  const route = { origin: "LIM", destination: "CUZ", departureDate: departure, returnDate: returning };
  assert.ok(providerSearches(fake, route).length > providerCallsBefore, "the confirmed paste did not reach the providers");
  const url = new URL(page.url());
  assert.equal(url.searchParams.get("departure"), departure);
  assert.equal(url.searchParams.get("return"), returning);

  /* Copying the search says so; a clipboard that refuses is named instead. */
  await topBar.copyConfig(page).click();
  await announcement.status(page, "Configuración copiada").waitFor({ timeout: 5_000 });
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /\bCUZ\b/);
  await page.evaluate(() => {
    navigator.clipboard.writeText = () => Promise.reject(new DOMException("Refused.", "NotAllowedError"));
    document.execCommand = () => false;
  });
  await topBar.copyConfig(page).click();
  await notice.error(page).filter({ hasText: /^No se pudo copiar la configuración\./ }).waitFor({ timeout: 5_000 });
});

suite.test("an exchange rate that never answers delays nothing and makes up no price in soles", async (scope) => {
  const { fake, stack } = scope;
  /* No rate anywhere: not on disk, not in the runner's memory, not in an
     Agil answer (Agil has no fare here), and the rate service hangs. */
  const cachedRate = join(stack.appDataDir, "fly-desk", "quotation-usd-pen-rate.json");
  rmSync(cachedRate, { force: true });
  await stack.restart("runner");
  assert.equal(existsSync(cachedRate), false);
  fake.setFlights("cbplus", { origin: "LIM", destination: "CUZ" }, [
    { outbound: ["LA2047 LIM-CUZ 07:15-08:40"], price: 151.3, baggage: { carryOn: true, checked: 1 }, brand: "Plus" },
  ]);
  fake.fail("rate", { hang: true });

  const { page } = await scope.signedInPage("/");
  const startedAt = Date.now();
  const job = await startedJob<SearchJob>(page, async () => {
    await page.goto(`${stack.baseUrl}${searchLink({ mode: "exact", trip: "one-way", origin: "LIM", destination: "CUZ", departure: day(60) })}`);
  });
  await waitForResults(page, 1);
  assert.ok(Date.now() - startedAt < 15_000, `the search took ${Date.now() - startedAt} ms`);
  const rateCalls = await eventually(() => {
    const calls = fake.requests("rate");
    assert.ok(calls.length > 0, "the rate was never asked for");
    assert.ok(calls.every((call) => call.aborted), "a rate request is still hanging");
    return calls;
  });
  assert.ok(rateCalls.length <= 2, `the rate was asked ${rateCalls.length} times`);

  /* Without a rate the fare cannot be quoted in soles, so it is not offered
     for quoting at all. */
  const api = await scope.api();
  const [offer] = searchOffers(await readSearchJob(api, job.searchJobId));
  assert.ok(offer);
  assert.equal(offer.quotationPreparedAt, undefined, "a fare with no rate was prepared for quoting");
  await results.card(page, /Click and Book Plus$/).click();
  const panel = detail.surface(page);
  await eventually(async () => assert.match(await panel.innerText(), /Click and Book Plus/));
  assert.equal(await detail.quote(panel).isEnabled(), false, "a fare without a rate was offered for quoting");

  /* Asked directly, the quotation endpoint answers in bounded time and does
     not invent soles. */
  const quoteStartedAt = Date.now();
  const answer = await api.fetch("/api/quotation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ searchSessionId: job.searchJobId, offerId: offer.id }),
  });
  assert.ok(Date.now() - quoteStartedAt < 8_000, `the quotation took ${Date.now() - quoteStartedAt} ms`);
  const text = await answer.text();
  assert.doesNotMatch(text, /S\/\s*\d/, "a price in soles was made up without a rate");
});
