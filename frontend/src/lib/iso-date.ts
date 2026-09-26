/*
 * Calendar arithmetic on `YYYY-MM-DD` strings, as civil dates in UTC: search
 * dates are days, not instants, and parsing them in the browser's zone would
 * shift a departure day under an agent whose machine is set elsewhere.
 */

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const ISO_MONTH_PATTERN = /^\d{4}-\d{2}$/

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function isIsoMonth(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_MONTH_PATTERN.test(value)) return false
  const month = Number(value.slice(5, 7))
  return month >= 1 && month <= 12
}

function isoToUtcDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`)
}

function utcDateToIso(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function addDays(value: string, days: number): string {
  const date = isoToUtcDate(value)
  date.setUTCDate(date.getUTCDate() + days)
  return utcDateToIso(date)
}

export function addMonths(monthKey: string, months: number): string {
  const [year, month] = monthKey.split("-").map(Number)
  const date = new Date(Date.UTC(year, month - 1 + months, 1))
  return date.toISOString().slice(0, 7)
}

export function maxIsoDate(left: string, right: string): string {
  return left > right ? left : right
}

export function minIsoDate(left: string, right: string): string {
  return left < right ? left : right
}

export function diffDays(fromIso: string, toIso: string): number {
  return Math.round(
    (isoToUtcDate(toIso).getTime() - isoToUtcDate(fromIso).getTime()) / 86_400_000,
  )
}

export function clampIsoDate(value: string, minDate: string, maxDate?: string): string {
  if (!isIsoDate(value)) return value
  if (value < minDate) return minDate
  if (maxDate && value > maxDate) return maxDate
  return value
}

export function monthKeyOf(isoDate: string): string {
  return isoDate.slice(0, 7)
}

export function lastDayOfMonth(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number)
  return utcDateToIso(new Date(Date.UTC(year, month, 0)))
}

/** Monday-first, padded with blanks so a column always means a weekday. */
export function monthDayCells(monthKey: string): Array<string | null> {
  const firstWeekday = (isoToUtcDate(`${monthKey}-01`).getUTCDay() + 6) % 7
  const dayCount = Number(lastDayOfMonth(monthKey).slice(8))

  return [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: dayCount }, (_, index) => `${monthKey}-${String(index + 1).padStart(2, "0")}`),
  ]
}

/*
 * How a cell is painted, decided in one place (11 §8). `pmid`/`pend` are the
 * tentative sweep under the pointer and must not share a code with the
 * confirmed range: the two tints differ by 5%.
 */
export type DayKind =
  | "normal"
  | "past"
  | "today"
  | "solo"
  | "start"
  | "mid"
  | "end"
  | "pmid"
  | "pend"

export function dayKind(
  value: string,
  state: {
    start?: string
    end?: string
    hover?: string
    today?: string
    min?: string
    max?: string
  },
): DayKind {
  const { start, end, hover, today, min, max } = state

  if ((min && value < min) || (max && value > max)) return "past"

  if (start && end && start !== end) {
    if (value === start) return "start"
    if (value === end) return "end"
    if (value > start && value < end) return "mid"
  } else if (start) {
    const tentative = hover && hover > start
    if (value === start) return tentative ? "start" : "solo"
    if (tentative) {
      if (value === hover) return "pend"
      if (value > start && value < hover) return "pmid"
    }
  }

  if (today && value === today) return "today"
  return "normal"
}

/** Inclusive month count — what "8 de 12 meses" counts. */
export function monthSpan(start: string, end: string): number {
  const [startYear, startMonth] = start.split("-").map(Number)
  const [endYear, endMonth] = end.split("-").map(Number)
  return (endYear - startYear) * 12 + (endMonth - startMonth) + 1
}

export function nightsBetween(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined
  const nights = diffDays(start, end)
  return nights >= 0 ? nights : undefined
}
