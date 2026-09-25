import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { followSearchJob, searchOffers, searchPayloads, startSearch } from "./support/api-client.ts";
import { agilBrowserStorage, FAKE_AGIL_IDENTITY, type OfferSpec } from "./support/fixtures.ts";
import { defineSuite, type TestScope } from "./support/harness.ts";
import { day, eventually } from "./support/scenario.ts";

/*
 * Where an Agil search gets its bearer when no identity is stored: the
 * platform Chrome, read over DevTools one tab at a time. The tab is closed
 * whether the read finishes or the worker holding it is stopped, and what the
 * read found is kept, so the next start needs no browser.
 */

const suite = defineSuite({ file: import.meta.filename });

/* The page the runtime reads the session from, holding a signed-in agent. */
const AGIL_HOME = "https://www.agilsmart.com/home-user";
const SIGNED_IN = { "https://www.agilsmart.com": agilBrowserStorage() };
/* Longer than the runtime's budget for one DevTools command (2.5 s): Chrome
   answers a navigation only once the page has responded. */
const SLOW_PAGE_MS = 3_000;

const CUSCO: OfferSpec[] = [
  { outbound: ["LA2045 LIM-CUZ 05:40-07:05"], price: 142.8, baggage: { carryOn: true, checked: 0 } },
];

function identityPath(scope: TestScope): string {
  return join(scope.stack.appDataDir, "agil-identity.json");
}

/** A runner with no identity on disk or in memory: a new host, or one whose identity was refused. */
async function forgetIdentity(scope: TestScope): Promise<void> {
  rmSync(identityPath(scope), { force: true });
  await scope.stack.restart("runner");
}

function restoreIdentity(scope: TestScope): void {
  writeFileSync(identityPath(scope), JSON.stringify(FAKE_AGIL_IDENTITY));
}

function agilFares(offers: ReturnType<typeof searchOffers>): number {
  return offers.filter((offer) => offer.providerSource === "agil-local").length;
}

suite.test("with no stored identity a search reads the Agil session from the platform Chrome, closes the tab, and keeps the identity", async (scope) => {
  const { fake, stack } = scope;
  fake.setFlights("agil", { origin: "LIM", destination: "CUZ" }, CUSCO);
  try {
    await forgetIdentity(scope);
    fake.chrome.open(SIGNED_IN, { pageDelayMs: SLOW_PAGE_MS });
    const api = await scope.api();
    const { job } = await followSearchJob(api, await startSearch(api, searchPayloads.exact("LIM", "CUZ", day(30))));
    assert.equal(job.searchStatus, "completed");
    assert.equal(agilFares(searchOffers(job)), 1, "no Agil fare without a stored identity");

    /* One tab, sent to the page that holds the session, read and closed. */
    assert.deepEqual(fake.chrome.tabs().map((tab) => ({ urls: tab.urls, closed: tab.closed })), [{ urls: [AGIL_HOME], closed: true }]);
    /* The fake mints a bearer only for the identity that page holds. */
    assert.ok(fake.requests("agil.token").some((request) => request.status === 200), "no bearer was minted");
    assert.deepEqual(JSON.parse(readFileSync(identityPath(scope), "utf8")), { ...FAKE_AGIL_IDENTITY }, "the identity was not kept");

    /* The next start mints from the file and never asks the browser. */
    fake.chrome.reset();
    await stack.restart("runner");
    fake.clearRequests();
    const { job: next } = await followSearchJob(api, await startSearch(api, searchPayloads.exact("LIM", "CUZ", day(31))));
    assert.equal(agilFares(searchOffers(next)), 1);
    assert.deepEqual(fake.requests("cdp").map((request) => request.path), [], "a start with a stored identity asked the browser");
  } finally {
    restoreIdentity(scope);
  }
}, { allowedFallbacks: ["cdp"] });

suite.test("a worker stopped while its tab loads closes that tab in the platform Chrome", async (scope) => {
  const { fake, stack } = scope;
  fake.setFlights("agil", { origin: "LIM", destination: "CUZ" }, CUSCO);
  try {
    await forgetIdentity(scope);
    fake.chrome.open(SIGNED_IN, { hangPages: true });
    const api = await scope.api();
    await startSearch(api, searchPayloads.exact("LIM", "CUZ", day(32)));
    await eventually(() => assert.deepEqual(fake.chrome.tabs().map((tab) => tab.urls), [[AGIL_HOME]]), {
      message: "the worker's tab reaches the Agil page",
    });

    /* What a deployment does to the runner: SIGTERM, to it and to its workers. */
    await stack.restart("runner");
    assert.deepEqual(fake.chrome.tabs().map((tab) => tab.closed), [true], "the stopped worker left its tab open in the shared Chrome");
  } finally {
    restoreIdentity(scope);
  }
}, {
  allowedFallbacks: ["cdp"],
  ...(process.platform === "win32" ? { skip: "a stop on Windows is TerminateProcess, which no process can intercept" } : {}),
});
