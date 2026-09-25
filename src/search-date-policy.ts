import {
  MAX_FLEXIBLE_STAY_NIGHTS,
  MAX_LAP_INFANTS_PER_ADULT,
  MAX_SEARCH_PASSENGERS,
} from "./core/search-limits";

const DEFAULT_SEARCH_MAX_FUTURE_DAYS = 365;
const DEFAULT_MIGRATION_CONCURRENT_MONTHS = 2;
const MAX_MIGRATION_CONCURRENT_MONTHS = 12;
const SEARCH_TODAY_OVERRIDE_ENV = "SEARCH_TODAY_OVERRIDE";

interface SearchDatePolicy {
  minSearchDate: string;
  maxSearchDate: string;
  maxFutureDays: number;
}

interface PublicRuntimeConfig {
  migrationConcurrentMonths: number;
  maxStayNights: number;
  maxPassengers: number;
  maxLapInfantsPerAdult: number;
  searchDatePolicy: SearchDatePolicy;
}

interface SearchDateValidationOptions {
  enforceMaxDate?: boolean;
}

/* The desk sells from Lima, and the VPS clock is UTC: from 19:00 in Lima the
   host's calendar day is already tomorrow. Every "today" is Lima's. */
const DESK_TIME_ZONE = "America/Lima";
const deskDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: DESK_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function deskIsoDate(now = new Date()): string {
  return deskDateFormatter.format(now);
}

function isIsoDateString(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }

  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= maxDay;
}

function addDaysIso(value: string, days: number): string {
  if (!isIsoDateString(value)) {
    throw new Error(`Cannot add days to invalid ISO date: ${value}`);
  }

  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function resolveSearchMaxFutureDays(): number {
  const raw = Number(process.env.SEARCH_MAX_FUTURE_DAYS ?? DEFAULT_SEARCH_MAX_FUTURE_DAYS);
  if (!Number.isFinite(raw)) {
    return DEFAULT_SEARCH_MAX_FUTURE_DAYS;
  }

  return Math.max(0, Math.trunc(raw));
}

function resolveSearchTodayIso(now = new Date()): string {
  const override = process.env[SEARCH_TODAY_OVERRIDE_ENV]?.trim();
  if (process.env.NODE_ENV === "test" && override && isIsoDateString(override)) {
    return override;
  }

  return deskIsoDate(now);
}

export function getSearchDatePolicy(now = new Date()): SearchDatePolicy {
  const minSearchDate = resolveSearchTodayIso(now);
  const maxFutureDays = resolveSearchMaxFutureDays();

  return {
    minSearchDate,
    maxSearchDate: addDaysIso(minSearchDate, maxFutureDays),
    maxFutureDays,
  };
}

function resolveMigrationConcurrentMonths(): number {
  const raw = Number(process.env.FLY_DESK_MIGRATION_CONCURRENT_MONTHS ?? DEFAULT_MIGRATION_CONCURRENT_MONTHS);
  if (!Number.isFinite(raw)) {
    return DEFAULT_MIGRATION_CONCURRENT_MONTHS;
  }

  return Math.min(MAX_MIGRATION_CONCURRENT_MONTHS, Math.max(1, Math.trunc(raw)));
}

export function validateSearchDateInPolicy(
  label: string,
  value: string | undefined,
  policy = getSearchDatePolicy(),
  options: SearchDateValidationOptions = {},
): string[] {
  if (!value) {
    return [];
  }

  if (!isIsoDateString(value)) {
    return [`${label} must be a valid ISO date (YYYY-MM-DD).`];
  }

  if (value < policy.minSearchDate) {
    return [`${label} must be on or after ${policy.minSearchDate}.`];
  }

  if (options.enforceMaxDate !== false && value > policy.maxSearchDate) {
    return [`${label} must be on or before ${policy.maxSearchDate}.`];
  }

  return [];
}

export function getPublicRuntimeConfig(now = new Date()): PublicRuntimeConfig {
  return {
    migrationConcurrentMonths: resolveMigrationConcurrentMonths(),
    maxStayNights: MAX_FLEXIBLE_STAY_NIGHTS,
    maxPassengers: MAX_SEARCH_PASSENGERS,
    maxLapInfantsPerAdult: MAX_LAP_INFANTS_PER_ADULT,
    searchDatePolicy: getSearchDatePolicy(now),
  };
}
