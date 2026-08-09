/*
 * Calendar arithmetic on `YYYY-MM-DD` strings.
 *
 * Everything here treats a date as a civil date in UTC. Search dates are days,
 * not instants: if we parsed them in the browser's zone, a Lima agent looking
 * at a Madrid-bound flight would see the departure day shift under them.
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

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export function isoToUtcDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`)
}

export function utcDateToIso(date: Date): string {
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

/** Nights between two dates — the number the stay presets and the header count. */
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

export function firstDayOfMonth(monthKey: string): string {
  return `${monthKey}-01`
}

export function lastDayOfMonth(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number)
  return utcDateToIso(new Date(Date.UTC(year, month, 0)))
}

/**
 * The cells of one month, Monday-first, padded with blanks so that column
 * position always means weekday. Blanks are how plate 2e renders "other month":
 * not drawn at all, rather than drawn faintly and confused with "unavailable".
 */
export function monthDayCells(monthKey: string): Array<string | null> {
  const first = firstDayOfMonth(monthKey)
  const firstWeekday = (isoToUtcDate(first).getUTCDay() + 6) % 7
  const dayCount = Number(lastDayOfMonth(monthKey).slice(8))

  return [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: dayCount }, (_, index) => `${monthKey}-${String(index + 1).padStart(2, "0")}`),
  ]
}

/**
 * Where a value sits inside the selected range. Drives the sweep: rounded ends,
 * flat middle. `single` is a range whose two ends are the same value, which has
 * to stay fully rounded rather than picking up one flat side.
 */
/*
 * The contract of plate 9a, as 11 §8 writes it: one pure function decides how a
 * cell is painted, and the cell component only translates the answer into the
 * mixes of 01 §1.
 *
 * `pmid` and `pend` are the tentative sweep under the pointer, and they are
 * separate values on purpose. If the tentative and the confirmed share a
 * painting code the 7% and the 12% blend into each other and the bug is
 * invisible on a desk and obvious on a phone — where there is no pointer at all
 * and moment 3 never happens.
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
    /** The day under the pointer. Desktop only; leaving the calendar clears it. */
    hover?: string
    today?: string
    min?: string
    max?: string
  },
): DayKind {
  const { start, end, hover, today, min, max } = state

  // One state, two causes — in the past or beyond the one-year window. They
  // read the same because the agent's next move is the same either way.
  if ((min && value < min) || (max && value > max)) return "past"

  if (start && end && start !== end) {
    if (value === start) return "start"
    if (value === end) return "end"
    if (value > start && value < end) return "mid"
  } else if (start) {
    // Moment 3: an outbound is chosen and the pointer is on a later day. The
    // chosen day is already an end of the sweep, so it stops being `solo`.
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

/* Labels. Kept next to the arithmetic so a month is formatted the same way in
   the picker, the field, the results header and the migration grid. */

const MONTH_CAPTION_FORMATTER = new Intl.DateTimeFormat("es-PE", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
})

const MONTH_SHORT_FORMATTER = new Intl.DateTimeFormat("es-PE", {
  month: "short",
  timeZone: "UTC",
})

/** "agosto 2026" — the calendar caption. */
export function monthCaption(monthKey: string): string {
  return MONTH_CAPTION_FORMATTER.format(new Date(`${monthKey}-01T00:00:00Z`))
}

/** "ago" — the month cell. The trailing dot some locales add is dropped. */
export function monthShortLabel(monthKey: string): string {
  return MONTH_SHORT_FORMATTER.format(new Date(`${monthKey}-01T00:00:00Z`)).replace(".", "")
}

/** "ago 2026" — the field value and the range summary. */
export function monthYearLabel(monthKey: string): string {
  return `${monthShortLabel(monthKey)} ${monthKey.slice(0, 4)}`
}

/** Nights in the current selection, for the header counter and the presets. */
export function nightsBetween(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined
  const nights = diffDays(start, end)
  return nights >= 0 ? nights : undefined
}
