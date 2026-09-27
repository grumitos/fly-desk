import assert from "node:assert/strict";
import { join } from "node:path";
import type { Page, Response as PlaywrightResponse } from "playwright";
import { QUOTATION_FARE_FRESHNESS_MS } from "../../../src/core/quotation.ts";
import { readCapacity, type ApiSession, type MatrixJob, type SearchJob } from "./api-client.ts";
import { eventually, querySqlite, writeSqlite } from "./scenario.ts";
import type { Stack } from "./stack.ts";
import { readCards, readResultCount, results, searchForm, type CardReading } from "./ui.ts";

/*
 * Gestures and waits the specs share. Selectors stay in `ui.ts`; this file only
 * strings them into the few sequences every spec repeats.
 */

/** Waits until the runner's shared capacity is idle: nothing running, nothing waiting. */
export async function waitForIdleCapacity(api: ApiSession, timeoutMs = 15_000): Promise<void> {
  await eventually(async () => {
    const capacity = await readCapacity(api);
    assert.deepEqual(
      { activeUnits: capacity.activeUnits, activeSearches: capacity.activeSearches, queuedSearches: capacity.queuedSearches },
      { activeUnits: 0, activeSearches: 0, queuedSearches: 0 },
    );
  }, { timeoutMs, message: "the capacity came back to idle" });
}

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

type StoredFare = { quotationPreparedAt?: string };

/**
 * Makes a finished job's fares older than a quote takes as they are, the way
 * an operator would: with the runner stopped, the job's stored row has each
 * fare's `quotationPreparedAt`, when its search answered, moved a minute past
 * the window, and the runner reads the row back as it starts. A quote of one
 * of them then confirms it with the provider first.
 */
export async function ageStoredFares(stack: Stack, jobId: string): Promise<void> {
  const dbPath = join(stack.appDataDir, "fly-desk-cache.sqlite");
  const storedRow = () => querySqlite<{ kind: string; payload: string }>(
    dbPath,
    "SELECT 'search_jobs' AS kind, payload FROM search_jobs WHERE id = ?1 UNION ALL SELECT 'matrix_jobs' AS kind, payload FROM matrix_jobs WHERE id = ?1",
    [jobId],
  )[0];
  /* A finished job reaches its row on the store's write debounce. */
  await eventually(() => {
    assert.equal((JSON.parse(storedRow()?.payload ?? "{}") as { status?: string }).status, "completed");
  }, { message: `job ${jobId} stored as finished` });

  await stack.restart("runner", {
    beforeLaunch: () => {
      const row = storedRow()!;
      const job = JSON.parse(row.payload) as { allOffers?: StoredFare[]; cells?: Array<{ offer?: StoredFare }> };
      const fares = [...job.allOffers ?? [], ...(job.cells ?? []).flatMap((cell) => cell.offer ? [cell.offer] : [])];
      for (const fare of fares) {
        if (fare.quotationPreparedAt) {
          fare.quotationPreparedAt = new Date(Date.parse(fare.quotationPreparedAt) - QUOTATION_FARE_FRESHNESS_MS - 60_000).toISOString();
        }
      }
      assert.ok(fares.some((fare) => fare.quotationPreparedAt), `job ${jobId} holds no fare prepared for quoting`);
      writeSqlite(dbPath, [{ sql: `UPDATE ${row.kind} SET payload = ? WHERE id = ?`, params: [JSON.stringify(job), jobId] }]);
    },
  });
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

/**
 * Waits until every animation on the page that has an end has reached it, so
 * what is measured next is where things rest and not a frame of an entrance.
 */
export async function waitForMotion(page: Page): Promise<void> {
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((animation) => animation.playState === "running" && animation.effect?.getComputedTiming().endTime !== Infinity)
    .map((animation) => animation.finished.catch(() => undefined))).then(() => undefined));
}

/**
 * Waits for the page to draw two more frames: what a gesture left for its next
 * frame (a scroll, a measurement) has run by then. The window to let pass
 * before asserting that a gesture moved nothing.
 */
export async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
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
