import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalOffer, SearchRequest } from "../../src/core/types";
import { SearchSessionStore } from "../../src/session-store";

/*
 * The session cache on a real SQLite file: what it gives back to the
 * filesystem, and what survives a restart.
 */

const HOUR_MS = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);

const request: SearchRequest = {
  tripType: "one-way",
  searchMode: "exact",
  legs: [{ origin: "LIM", destination: "CUZ", departureDate: "2026-12-01" }],
  passengers: { adults: 1, children: 0, infants: 0 },
  cabin: "ECONOMY",
  filters: {},
  coverageMode: "core",
  redirectMode: "best-effort",
  currencyCode: "USD",
};

/* About 80 KiB of stored payload per job: enough pages to measure. */
function bulkyOffers(jobIndex: number): CanonicalOffer[] {
  return Array.from({ length: 20 }, (_, index) => ({
    id: `offer-${jobIndex}-${index}`,
    providerSource: "agil-local",
    price: { total: { amount: 100 + index, currencyCode: "USD" } },
    purchasePaths: [],
    note: `${jobIndex}:${index}:`.padEnd(4_000, "x"),
  }) as unknown as CanonicalOffer);
}

function createCompletedJob(store: SearchSessionStore, jobIndex: number) {
  return store.createSearchJob({
    request,
    offers: [],
    allOffers: bulkyOffers(jobIndex),
    searchMeta: {
      requestedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      providersUsed: ["agil-local"],
      warnings: [],
      partial: false,
      searchState: "search_live",
    },
    providerMeta: { exactProvider: "agil-local", coverageMode: "core" },
    warnings: [],
    sortMode: "cheapest",
    status: "completed",
  });
}

/* Read through a connection of its own, the way another unit sees the file. */
function fileStats(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const pragma = (name: string) => Number(Object.values(db.query(`PRAGMA ${name}`).get() as object)[0]);
    return {
      pageCount: pragma("page_count"),
      freePages: pragma("freelist_count"),
      autoVacuum: pragma("auto_vacuum"),
    };
  } finally {
    db.close();
  }
}

const directories: string[] = [];
const stores: SearchSessionStore[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "fly-desk-unit-cache-"));
  directories.push(dir);
  return join(dir, "fly-desk-cache.sqlite");
}

function openStore(dbPath: string): SearchSessionStore {
  const store = new SearchSessionStore({ dbPath });
  stores.push(store);
  return store;
}

afterEach(() => {
  setSystemTime();
  /* A failed test leaves its store open, and Windows keeps an open file. */
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("file size", () => {
  test("a file created before the store chose a vacuum mode is compacted once most of it is free, and stays compact", () => {
    const dbPath = tempDbPath();
    /* What production runs on: a WAL file written before the store asked for
       a vacuum mode, which SQLite then fixes at none. */
    const legacy = new Database(dbPath);
    legacy.run("PRAGMA journal_mode = WAL;");
    legacy.close();

    setSystemTime(new Date(T0));
    let store = openStore(dbPath);
    for (let index = 0; index < 24; index += 1) {
      createCompletedJob(store, index);
    }
    setSystemTime(new Date(T0 + 3 * HOUR_MS));
    const kept = Array.from({ length: 4 }, (_, index) => createCompletedJob(store, 100 + index));
    store.close();

    /* Little is free yet, so nothing is rewritten. */
    store = openStore(dbPath);
    store.vacuumIfWorthwhile();
    const full = fileStats(dbPath);
    expect(full.autoVacuum).toBe(0);
    store.close();

    /* The boot sweep takes the 24 jobs past their four hours. */
    setSystemTime(new Date(T0 + 5 * HOUR_MS));
    store = openStore(dbPath);
    const swept = fileStats(dbPath);
    expect(swept.autoVacuum).toBe(0);
    expect(swept.freePages * 2).toBeGreaterThan(swept.pageCount);

    store.vacuumIfWorthwhile();
    const compacted = fileStats(dbPath);
    expect(compacted.autoVacuum).toBe(2);
    expect(compacted.freePages).toBe(0);
    expect(compacted.pageCount * 3).toBeLessThan(swept.pageCount);
    for (const job of kept) {
      expect(store.getSearchJob(job.id)?.allOffers.length).toBe(20);
    }

    /* From now on each sweep hands back what it frees. */
    setSystemTime(new Date(T0 + 10 * HOUR_MS));
    expect(store.purgeExpired().searchJobs).toBe(kept.length);
    store.reclaimFreePages();
    const reclaimed = fileStats(dbPath);
    expect(reclaimed.freePages).toBe(0);
    expect(reclaimed.pageCount * 2).toBeLessThan(compacted.pageCount);
    store.close();
  });

  test("a new file is incremental from its first page", () => {
    const dbPath = tempDbPath();
    const store = openStore(dbPath);
    createCompletedJob(store, 1);
    store.close();
    expect(fileStats(dbPath).autoVacuum).toBe(2);
  });
});
