import {
  DEFAULT_MIGRATION_CONCURRENT_MONTHS,
  DEFAULT_SEARCH_MAX_FUTURE_DAYS,
  MAX_MIGRATION_CONCURRENT_MONTHS,
  deskIsoDate,
  type PublicRuntimeConfig,
  type SearchDatePolicy,
} from "../../../src/core/runtime-config"
import {
  MAX_FLEXIBLE_STAY_NIGHTS,
  MAX_LAP_INFANTS_PER_ADULT,
  MAX_SEARCH_PASSENGERS,
} from "../../../src/core/search-limits"
import { addDays, isIsoDate } from "@/lib/iso-date"

declare global {
  interface Window {
    __FLYDESK_RUNTIME__?: Partial<PublicRuntimeConfig>
  }
}

/* The server writes the global into `<head>` before this bundle runs, so it is
   read once; the fallbacks are the backend's own defaults. */
const runtime: Partial<PublicRuntimeConfig> = typeof window === "undefined" ? {} : window.__FLYDESK_RUNTIME__ ?? {}

function positiveInteger(value: unknown): number | undefined {
  const numeric = Number(value)
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined
}

/** Lima's calendar day as the backend's date policy states it. */
export function deskToday(): string {
  const configured = runtime.searchDatePolicy?.minSearchDate
  return isIsoDate(configured) ? configured : deskIsoDate()
}

export const SEARCH_DATE_POLICY: SearchDatePolicy = (() => {
  const configured = runtime.searchDatePolicy
  const minSearchDate = deskToday()
  const maxFutureDays = positiveInteger(configured?.maxFutureDays) ?? DEFAULT_SEARCH_MAX_FUTURE_DAYS
  const maxSearchDate = isIsoDate(configured?.maxSearchDate)
    ? configured.maxSearchDate
    : addDays(minSearchDate, maxFutureDays)
  return { minSearchDate, maxSearchDate, maxFutureDays }
})()

export const SEARCH_LIMITS = {
  maxStayNights: positiveInteger(runtime.maxStayNights) ?? MAX_FLEXIBLE_STAY_NIGHTS,
  maxPassengers: positiveInteger(runtime.maxPassengers) ?? MAX_SEARCH_PASSENGERS,
  maxLapInfantsPerAdult: positiveInteger(runtime.maxLapInfantsPerAdult) ?? MAX_LAP_INFANTS_PER_ADULT,
} as const

export const MIGRATION_CONCURRENT_MONTHS = Math.min(
  MAX_MIGRATION_CONCURRENT_MONTHS,
  positiveInteger(runtime.migrationConcurrentMonths) ?? DEFAULT_MIGRATION_CONCURRENT_MONTHS,
)
