import {
  DEFAULT_MIGRATION_CONCURRENT_MONTHS,
  DEFAULT_SEARCH_MAX_FUTURE_DAYS,
  MAX_MIGRATION_CONCURRENT_MONTHS,
  deskIsoDate,
  type PublicRuntimeConfig,
  type SearchDatePolicy,
} from "./core/runtime-config";
import { envNumber } from "./env";
import {
  MAX_FLEXIBLE_STAY_NIGHTS,
  MAX_LAP_INFANTS_PER_ADULT,
  MAX_SEARCH_PASSENGERS,
} from "./core/search-limits";

const SEARCH_TODAY_OVERRIDE_ENV = "SEARCH_TODAY_OVERRIDE";

interface SearchDateValidationOptions {
  enforceMaxDate?: boolean;
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
  return Math.trunc(envNumber("SEARCH_MAX_FUTURE_DAYS", DEFAULT_SEARCH_MAX_FUTURE_DAYS, { min: 0 }));
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
  return Math.trunc(envNumber(
    "FLY_DESK_MIGRATION_CONCURRENT_MONTHS",
    DEFAULT_MIGRATION_CONCURRENT_MONTHS,
    { min: 1, max: MAX_MIGRATION_CONCURRENT_MONTHS },
  ));
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
