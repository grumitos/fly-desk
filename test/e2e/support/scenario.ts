import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { FakeOp, FakeUpstream, RecordedRequest } from "./fake-upstream.ts";

/*
 * What every spec shares that is not a selector: the calendar the stack runs
 * on, polling instead of sleeping, and readings of the fake's request log.
 */

/* ---- The calendar ---- */

function limaToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(now);
}

/**
 * The desk's "today" for every stack (`SEARCH_TODAY_OVERRIDE`): the next
 * 20 November on or after Lima's real date. Fixed, so a calendar and a
 * migratory sweep look the same on every run, and a year boundary is always
 * six weeks away; never in the real past, so no provider date ever is.
 */
export const TODAY = (() => {
  const real = limaToday();
  const year = Number(real.slice(0, 4));
  const candidate = `${year}-11-20`;
  return candidate >= real ? candidate : `${year + 1}-11-20`;
})();

export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** `TODAY + offset`, as an ISO date. */
export function day(offset: number): string {
  return addDays(TODAY, offset);
}

export function monthKey(isoDate: string): string {
  return isoDate.slice(0, 7);
}

export function addMonths(month: string, delta: number): string {
  const [year, monthIndex] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year!, monthIndex! - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** «10 de diciembre de 2026», as the calendar names a day. */
export function spanishDayName(isoDate: string): string {
  return new Intl.DateTimeFormat("es-PE", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${isoDate}T00:00:00Z`));
}

/** «diciembre de 2026», as the month picker names a month (`2026-12`). */
export function spanishMonthName(month: string): string {
  return new Intl.DateTimeFormat("es-PE", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${month}-01T00:00:00Z`));
}

/** «Diciembre de 2026», as a month of the sweep is titled. */
export function sweepMonthLabel(month: string): string {
  const name = spanishMonthName(month);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const MONTH_ABBREVIATIONS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "set", "oct", "nov", "dic"] as const;

/** «abr 2027», as the month field writes a month (`2027-04`). */
export function deskMonth(month: string): string {
  return `${MONTH_ABBREVIATIONS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/** «28 dic 2026», as the date field writes a day. */
export function deskDate(isoDate: string): string {
  return `${isoDate.slice(8, 10)} ${deskMonth(isoDate.slice(0, 7))}`;
}

/** The day of the week, Monday 0 to Sunday 6, as the calendar lays weeks out. */
export function weekday(isoDate: string): number {
  return (new Date(`${isoDate}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/** Days in `month` (`2026-12`). */
export function daysInMonth(month: string): number {
  const [year, monthIndex] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, monthIndex!, 0)).getUTCDate();
}

/* ---- Waiting ---- */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries `check` until it stops throwing, then returns its value. The
 * polling interval is short; the timeout is the budget, not a wait.
 */
export async function eventually<T>(
  check: () => T | Promise<T>,
  options: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() >= deadline) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${options.message ?? "Condition not met"} within ${timeoutMs} ms: ${reason}`, { cause: error });
      }
    }
    await sleep(intervalMs);
  }
}

/* ---- The fake's request log ---- */

export const AGIL_GDS_IDS = [0, 1, 3, 7, 10, 21, 22] as const;
export const PROVIDER_SEARCH_OPS: readonly FakeOp[] = ["agil.startSearch", "agil.search", "cbplus.search"];
/* Only a fallback path would call these: Agil bundle scraping, B2B automation,
   Chrome discovery, or something the fake does not know. */
export const FALLBACK_OPS: readonly FakeOp[] = ["agil.web", "cbplus.b2b", "cbplus.markup", "cdp", "unknown"];

export interface RouteFilter {
  origin?: string;
  destination?: string;
  departureDate?: string;
  returnDate?: string;
}

export function matchesRoute(request: RecordedRequest, route: RouteFilter): boolean {
  const query = request.query;
  return Boolean(query)
    && (!route.origin || query!.origin === route.origin)
    && (!route.destination || query!.destination === route.destination)
    && (!route.departureDate || query!.departureDate === route.departureDate)
    && (!route.returnDate || query!.returnDate === route.returnDate);
}

/** Provider search calls (Agil `/mv/search`, Click and Book Plus `searchFlights`) for a route. */
export function providerSearches(fake: FakeUpstream, route: RouteFilter = {}, since = 0): RecordedRequest[] {
  return fake.requests((request) =>
    (request.op === "agil.search" || request.op === "cbplus.search")
    && request.receivedAt >= since
    && matchesRoute(request, route));
}

/** The most requests of `op` the fake held open at once. */
export function maxInFlight(requests: readonly RecordedRequest[]): number {
  const events = requests.flatMap((request) => [
    { at: request.receivedAt, delta: 1 },
    { at: request.respondedAt ?? Number.POSITIVE_INFINITY, delta: -1 },
  ]).sort((left, right) => left.at - right.at || left.delta - right.delta);
  let current = 0;
  let peak = 0;
  for (const event of events) {
    current += event.delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

export function describeRequests(requests: readonly RecordedRequest[]): string {
  return requests
    .map((request) => `#${request.seq} ${request.op} ${request.query ? `${request.query.origin}-${request.query.destination} ${request.query.departureDate}${request.query.returnDate ? `/${request.query.returnDate}` : ""}${request.query.gds !== undefined ? ` gds=${request.query.gds}` : ""}` : request.path} -> ${request.status ?? "pending"}${request.aborted ? " (aborted)" : ""}`)
    .join("\n");
}

/* ---- SQLite, read the way an operator would ---- */

/**
 * The lifetime use counters of the global station ranking, keyed
 * `origin:LIM` / `destination:MAD`. What a search "counting once" is measured in.
 */
export function locationUses(appDataDir: string): Map<string, number> {
  const rows = querySqlite<{ role: string; code: string; total_uses: number }>(
    join(appDataDir, "location-usage.sqlite"),
    "SELECT role, code, total_uses FROM location_usage",
  );
  return new Map(rows.map((row) => [`${row.role}:${row.code}`, Number(row.total_uses)]));
}

/**
 * Runs one read-only query against a stack database with Bun's SQLite, the
 * engine that wrote it. A subprocess, so the test process never holds a
 * handle on a file a service is writing.
 */
export function querySqlite<T>(dbPath: string, sql: string): T[] {
  const script = [
    "const { Database } = require('bun:sqlite');",
    `const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });`,
    "try {",
    `  process.stdout.write(JSON.stringify(db.query(${JSON.stringify(sql)}).all()));`,
    "} finally { db.close(); }",
  ].join("\n");
  const result = spawnSync(process.env.BUN_EXECUTABLE_PATH?.trim() || "bun", ["--no-env-file", "-e", script], {
    encoding: "utf8",
    windowsHide: true,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
  });
  if (result.status !== 0) {
    throw new Error(`SQLite read failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout || "[]") as T[];
}
