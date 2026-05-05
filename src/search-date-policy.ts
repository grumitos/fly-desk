export const DEFAULT_SEARCH_MAX_FUTURE_DAYS = 365;
export const SEARCH_TODAY_OVERRIDE_ENV = "SEARCH_TODAY_OVERRIDE";

export interface SearchDatePolicy {
  minSearchDate: string;
  maxSearchDate: string;
  maxFutureDays: number;
}

export interface PublicRuntimeConfig {
  searchDatePolicy: SearchDatePolicy;
}

export interface SearchDateValidationOptions {
  enforceMaxDate?: boolean;
}

function formatLocalIsoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function isIsoDateString(value: string): boolean {
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

export function addDaysIso(value: string, days: number): string {
  if (!isIsoDateString(value)) {
    throw new Error(`Cannot add days to invalid ISO date: ${value}`);
  }

  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function resolveSearchMaxFutureDays(): number {
  const raw = Number(process.env.SEARCH_MAX_FUTURE_DAYS ?? DEFAULT_SEARCH_MAX_FUTURE_DAYS);
  if (!Number.isFinite(raw)) {
    return DEFAULT_SEARCH_MAX_FUTURE_DAYS;
  }

  return Math.max(0, Math.trunc(raw));
}

export function resolveSearchTodayIso(now = new Date()): string {
  const override = process.env[SEARCH_TODAY_OVERRIDE_ENV]?.trim();
  if (override && isIsoDateString(override)) {
    return override;
  }

  return formatLocalIsoDate(now);
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
    searchDatePolicy: getSearchDatePolicy(now),
  };
}
