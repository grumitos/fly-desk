import assert from "node:assert/strict";
import type { Page, Response as PlaywrightResponse } from "playwright";
import type { MatrixJob, SearchJob } from "./api-client.ts";
import { eventually } from "./scenario.ts";
import { readCards, readResultCount, results, searchForm, type CardReading } from "./ui.ts";

/*
 * Gestures and waits the specs share. Selectors stay in `ui.ts`; this file only
 * strings them into the few sequences every spec repeats.
 */

/** The job the page's own `POST /api/search` (or `/api/matrix`) created. */
export async function startedJob<T extends SearchJob | MatrixJob = SearchJob>(
  page: Page,
  trigger: () => Promise<void>,
  path: "/api/search" | "/api/matrix" = "/api/search",
): Promise<T> {
  const answered = page.waitForResponse((response: PlaywrightResponse) =>
    new URL(response.url()).pathname === path && response.request().method() === "POST");
  await trigger();
  const response = await answered;
  assert.equal(response.status(), 200, `${path} answered ${response.status()}`);
  return await response.json() as T;
}

/** Presses «Buscar» and returns the job it started. */
export function runSearch<T extends SearchJob | MatrixJob = SearchJob>(
  page: Page,
  path: "/api/search" | "/api/matrix" = "/api/search",
): Promise<T> {
  return startedJob<T>(page, () => searchForm.submit(page).click(), path);
}

/**
 * Waits until the search on screen has finished: no stop control (the desk),
 * no «Parcial» pill (every armazón — a phone folds the form away), and the
 * header counts `count`.
 */
export async function waitForResults(page: Page, count: number, timeoutMs = 30_000): Promise<CardReading[]> {
  return eventually(async () => {
    assert.equal(await searchForm.stop(page).count(), 0, "the search is still running");
    assert.equal(await results.partialPill(page).count(), 0, "the list is still partial");
    assert.equal((await readResultCount(page))?.total, count);
    return readCards(page);
  }, { timeoutMs, message: `${count} results on screen` });
}

/** Waits until a migratory sweep has settled with `priced` of `months` months fared. */
export async function waitForSweep(page: Page, months: number, priced: number, timeoutMs = 60_000): Promise<void> {
  await eventually(async () => {
    const header = await results.headerLine(page).innerText();
    /* «con tarifa» is the desk's; a phone keeps the figures only. */
    assert.match(header, new RegExp(`\\b${priced} de ${months} (meses|mes)\\b`), header);
    assert.doesNotMatch(header, /buscando/i, "a month is still being searched");
    assert.equal(await searchForm.stop(page).count(), 0, "the sweep is still running");
  }, { timeoutMs, message: `the sweep settles with ${priced} of ${months} months fared` });
}

/**
 * Scrolls the list's own viewport until `expected` rows are built, and reads
 * them. The list is windowed: rows exist only once the reader gets near them.
 */
export async function readWholeList(page: Page, expected: number, timeoutMs = 30_000): Promise<CardReading[]> {
  const viewport = results.viewport(page);
  await eventually(async () => {
    await viewport.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
    assert.equal(await results.cards(page).count(), expected);
  }, { timeoutMs, intervalMs: 80, message: `${expected} rows built by scrolling` });
  const cards = await readCards(page);
  await viewport.evaluate((element) => element.scrollTo({ top: 0 }));
  return cards;
}

/** The part of a row that identifies it: who, when, how long, how many stops, how much. */
export function rowKey(card: CardReading): string {
  const leg = card.legs[0];
  const stops = leg ? leg.stops === "Directo" ? 0 : Number(/^(\d+)/.exec(leg.stops)?.[1] ?? Number.NaN) : Number.NaN;
  return `${card.provider}|${leg?.departs}|${leg?.arrives}|${stops}|${card.amount.toFixed(2)}`;
}
