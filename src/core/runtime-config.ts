/*
 * The public runtime contract `src/server.ts` injects as
 * `window.__FLYDESK_RUNTIME__`, with the defaults both sides fall back to.
 * Free of `process` so the browser can import it; `src/search-date-policy.ts`
 * builds the values.
 */

export const DEFAULT_SEARCH_MAX_FUTURE_DAYS = 365;
export const DEFAULT_MIGRATION_CONCURRENT_MONTHS = 2;
export const MAX_MIGRATION_CONCURRENT_MONTHS = 12;

export interface SearchDatePolicy {
  minSearchDate: string;
  maxSearchDate: string;
  maxFutureDays: number;
}

export interface PublicRuntimeConfig {
  migrationConcurrentMonths: number;
  maxStayNights: number;
  maxPassengers: number;
  maxLapInfantsPerAdult: number;
  searchDatePolicy: SearchDatePolicy;
}

/* The desk sells from Lima, and the VPS clock is UTC: from 19:00 in Lima the
   host's calendar day is already tomorrow. Every "today" is Lima's. */
export const DESK_TIME_ZONE = "America/Lima";

const deskDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: DESK_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function deskIsoDate(now = new Date()): string {
  return deskDateFormatter.format(now);
}
