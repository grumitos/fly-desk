/*
 * Every date and number label the desk draws. Month names are written out
 * rather than asked of `Intl`: the ICU build decides whether es-PE abbreviates
 * with a dot and whether a standalone month is capitalised, and a desk in Lima
 * writes «set» for setiembre everywhere.
 */

const MONTH_NAMES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "setiembre", "octubre", "noviembre", "diciembre",
] as const

const MONTH_ABBREVIATIONS = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "set", "oct", "nov", "dic",
] as const

const WEEKDAY_ABBREVIATIONS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"] as const

const COUNT_FORMATTER = new Intl.NumberFormat("es-PE")
const AMOUNT_FORMATTERS = [0, 1, 2].map((digits) => new Intl.NumberFormat("es-PE", {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
}))

type DateParts = { year: number; month: number; day: number }

function dateParts(isoDate: string): DateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate)
  if (!match) return null
  const month = Number(match[2])
  if (month < 1 || month > 12) return null
  return { year: Number(match[1]), month, day: Number(match[3]) }
}

function monthParts(monthKey: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey)
  if (!match) return null
  const month = Number(match[2])
  return month >= 1 && month <= 12 ? { year: Number(match[1]), month } : null
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export function formatCount(value: number): string {
  return COUNT_FORMATTER.format(value)
}

export function formatAmount(amount: number, digits: 0 | 1 | 2 = 2): string {
  return AMOUNT_FORMATTERS[digits]!.format(amount)
}

export function formatMoney(money: { amount: number; currencyCode?: string }, digits: 0 | 2 = 2): string {
  return `${money.currencyCode || "USD"} ${formatAmount(money.amount, digits)}`
}

/** «05/09», the date beside a leg. */
export function formatDayMonthNumeric(isoDate: string): string {
  const parts = dateParts(isoDate)
  return parts ? `${String(parts.day).padStart(2, "0")}/${String(parts.month).padStart(2, "0")}` : ""
}

/** «5 set» */
export function formatDayMonth(isoDate: string): string {
  const parts = dateParts(isoDate)
  return parts ? `${parts.day} ${MONTH_ABBREVIATIONS[parts.month - 1]}` : ""
}

/** «05 set 2026», the form's date fields; «26 set 2026» with `padDay: false`. */
export function formatDate(isoDate: string, { padDay = true }: { padDay?: boolean } = {}): string {
  const parts = dateParts(isoDate)
  if (!parts) return ""
  const day = padDay ? String(parts.day).padStart(2, "0") : String(parts.day)
  return `${day} ${MONTH_ABBREVIATIONS[parts.month - 1]} ${parts.year}`
}

/** «05 set 26», for the phone's policy line. */
export function formatDateShortYear(isoDate: string): string {
  const parts = dateParts(isoDate)
  if (!parts) return ""
  return `${String(parts.day).padStart(2, "0")} ${MONTH_ABBREVIATIONS[parts.month - 1]} ${String(parts.year).slice(2)}`
}

/** «5 de setiembre de 2026», what a screen reader hears for a day cell. */
export function formatDateLong(isoDate: string): string {
  const parts = dateParts(isoDate)
  return parts ? `${parts.day} de ${MONTH_NAMES[parts.month - 1]} de ${parts.year}` : ""
}

/** «sáb 5» */
export function formatWeekdayDay(isoDate: string): string {
  const parts = dateParts(isoDate)
  if (!parts) return ""
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
  return `${WEEKDAY_ABBREVIATIONS[weekday]} ${parts.day}`
}

/** «set» */
export function monthAbbreviation(monthKey: string): string {
  const parts = monthParts(monthKey)
  return parts ? MONTH_ABBREVIATIONS[parts.month - 1] : ""
}

/** «set 2026» */
export function monthYearLabel(monthKey: string): string {
  const parts = monthParts(monthKey)
  return parts ? `${MONTH_ABBREVIATIONS[parts.month - 1]} ${parts.year}` : ""
}

/** «setiembre de 2026»; «Setiembre de 2026» at the start of a line. */
export function monthCaption(monthKey: string, { capitalized = false }: { capitalized?: boolean } = {}): string {
  const parts = monthParts(monthKey)
  if (!parts) return ""
  const label = `${MONTH_NAMES[parts.month - 1]} de ${parts.year}`
  return capitalized ? capitalize(label) : label
}

/** «Setiembre» */
export function monthName(monthKey: string): string {
  const parts = monthParts(monthKey)
  return parts ? capitalize(MONTH_NAMES[parts.month - 1]!) : ""
}

export function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`
}
