import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react"
import { AppIcon } from "@/components/ui/app-icon"
import { formatDateLong, monthAbbreviation, monthCaption } from "@/lib/format"
import {
  addDays,
  addMonths,
  clampIsoDate,
  dayKind,
  lastDayOfMonth,
  minIsoDate,
  monthDayCells,
  monthKeyOf,
  monthSpan,
  type DayKind,
} from "@/lib/iso-date"
import { deskToday } from "@/lib/runtime-config"
import { cn } from "@/lib/utils"

/*
 * Plates 1g / 2e (days) and 6c / 7a (months): one frame, two grids. The desk
 * pages two months or two years at a time; the phone scrolls them all.
 *
 * Each grid is one tab stop: the arrows move the focus a day (or a month) and
 * a week (or a row), Home/End go to the ends of the row, PageUp/PageDown page a
 * month (a year with Shift, and always for months), and Enter or Space chooses.
 */

const WEEKDAYS = ["lu", "ma", "mi", "ju", "vi", "sá", "do"]
const MONTHS_PER_ROW = 4

export type RangePreset = {
  label: string
  /** Nights for a day range, months for a month range. */
  value: number
}

export function DayRangeCalendar({
  start,
  end,
  minDate,
  maxDate,
  visibleMonth,
  presets,
  activePreset,
  rangeSummary,
  onVisibleMonthChange,
  onSelectDay,
  onPreset,
  onHoverDay,
  layout = "paged",
}: {
  start?: string
  end?: string
  minDate: string
  maxDate: string
  visibleMonth: string
  presets?: RangePreset[]
  activePreset?: number
  rangeSummary: ReactNode
  onVisibleMonthChange: (monthKey: string) => void
  onSelectDay: (day: string) => void
  onPreset?: (nights: number) => void
  /** Moment 3 of plate 9a: the day under the pointer or the focus, while an end is being chosen. */
  onHoverDay?: (day: string | undefined) => void
  layout?: "paged" | "continuous"
}) {
  const today = deskToday()
  /* Only a pointer or the keyboard produce moment 3; a touch screen paints the
     range on the second tap (03 §7). */
  const [hover, setHover] = useState<string | undefined>(undefined)
  const [focusDay, setFocusDay] = useState(() => clampIsoDate(start ?? maxDateOf(today, minDate), minDate, maxDate))
  const tentativeOpen = Boolean(start) && !end
  const sweep = useRangeSweep(start, end)
  const { rootRef, focusAfterRender } = useFocusAfterRender("data-day")

  const setHoverDay = (day: string | undefined) => {
    setHover(day)
    onHoverDay?.(day)
  }
  const months = layout === "continuous"
    ? inclusiveMonthKeys(monthKeyOf(minDate), monthKeyOf(maxDate))
    : [visibleMonth, addMonths(visibleMonth, 1)]
  /* Paging stops where the window stops. */
  const canStepBack = months[0] > monthKeyOf(minDate)
  const canStepForward = months[1] < monthKeyOf(maxDate)
  /* The one day in the tab order: the focused day while it is drawn, the
     first choosable day of the first month drawn otherwise. */
  const clampedFocus = clampIsoDate(focusDay, minDate, maxDate)
  const rovingDay = months.includes(monthKeyOf(clampedFocus))
    ? clampedFocus
    : clampIsoDate(`${months[0]}-01`, minDate, maxDate)

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement) || !event.target.dataset.day) return
    const next = dayForKey(event, rovingDay)
    if (!next) return
    event.preventDefault()

    const day = clampIsoDate(next, minDate, maxDate)
    setFocusDay(day)
    if (tentativeOpen) setHoverDay(day)
    if (layout === "paged") {
      const month = monthKeyOf(day)
      if (month < visibleMonth) onVisibleMonthChange(month)
      else if (month > addMonths(visibleMonth, 1)) onVisibleMonthChange(addMonths(month, -1))
    }
    focusAfterRender(day)
  }

  return (
    <div
      /* No movement of its own: the popover or the sheet around it has one. */
      className="fd-cal-popover"
      data-layout={layout}
      onPointerLeave={() => setHoverDay(undefined)}
    >
      <CalendarTop layout={layout}>
        <CalendarHeader
          summary={rangeSummary}
          presets={presets}
          activePreset={activePreset}
          onPreset={onPreset}
        />
        {layout === "continuous" && <WeekdayRow />}
      </CalendarTop>

      <div className="fd-cal-months" onKeyDown={handleKeyDown} ref={rootRef}>
        {layout === "paged" && (
          <>
            <CalendarStep
              direction="back"
              label="Mes anterior"
              disabled={!canStepBack}
              onClick={() => onVisibleMonthChange(addMonths(visibleMonth, -1))}
            />
            <CalendarStep
              direction="forward"
              label="Mes siguiente"
              disabled={!canStepForward}
              onClick={() => onVisibleMonthChange(addMonths(visibleMonth, 1))}
            />
          </>
        )}

        {months.map((monthKey) => (
          <div key={monthKey} data-calendar-key={monthKey}>
            <div className="fd-cal-caption">{monthCaption(monthKey)}</div>
            {layout === "paged" && <WeekdayRow />}
            <div className="fd-cal-grid" role="group" aria-label={monthCaption(monthKey)}>
              {monthDayCells(monthKey).map((day, index) => {
                if (!day) {
                  return <span key={`blank-${index}`} className="fd-cal-cell" data-blank="true" aria-hidden="true" />
                }

                const kind = dayKind(day, { start, end, hover, today, min: minDate, max: maxDate })
                const unavailable = kind === "past"
                return (
                  <button
                    key={day}
                    type="button"
                    className="fd-cal-cell fd-focus-ring"
                    data-kind={kind}
                    data-day={day}
                    {...sweep.cellProps(day, kind)}
                    disabled={unavailable}
                    tabIndex={day === rovingDay ? 0 : -1}
                    aria-label={cellAriaLabel(formatDateLong(day), kind)}
                    aria-pressed={isChosen(kind)}
                    /* An unavailable day does not respond (11 §2.2). */
                    onPointerEnter={tentativeOpen && !unavailable ? () => setHoverDay(day) : undefined}
                    onClick={() => {
                      setFocusDay(day)
                      onSelectDay(day)
                    }}
                  >
                    <span className="fd-cal-cell-label">{Number(day.slice(8))}</span>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="fd-cal-legend">
        <LegendItem swatch={<span className="fd-cal-legend-swatch" style={todaySwatchStyle}>{Number(today.slice(8))}</span>}>
          hoy
        </LegendItem>
        <LegendItem swatch={<span className="fd-cal-legend-swatch" style={unavailableSwatchStyle}>12</span>}>
          no disponible
        </LegendItem>
      </div>
    </div>
  )
}

/* On the phone the header and the weekday row stay pinned as one block, whose
   height changes with the summary line; the desk pages and pins nothing. */
function CalendarTop({ layout, children }: { layout: "paged" | "continuous"; children: ReactNode }) {
  if (layout !== "continuous") return <>{children}</>

  return <div className="fd-cal-sticky">{children}</div>
}

function WeekdayRow() {
  return (
    <div className="fd-cal-weekdays" aria-hidden="true">
      {WEEKDAYS.map((weekday) => (
        <span key={weekday} className="fd-cal-weekday">{weekday}</span>
      ))}
    </div>
  )
}

export function MonthRangeCalendar({
  start,
  end,
  minMonth,
  maxMonth,
  visibleYear,
  maxSpan,
  presets,
  activePreset,
  rangeSummary,
  onVisibleYearChange,
  onSelectMonth,
  onPreset,
  layout = "paged",
  sweepFrom = "start",
}: {
  start?: string
  end?: string
  minMonth: string
  maxMonth: string
  visibleYear: number
  maxSpan: number
  presets?: RangePreset[]
  activePreset?: number
  rangeSummary: ReactNode
  onVisibleYearChange: (year: number) => void
  onSelectMonth: (monthKey: string) => void
  onPreset?: (months: number) => void
  layout?: "paged" | "continuous"
  /** Which end the agent picked first: movement 5 grows away from it. */
  sweepFrom?: "start" | "end"
}) {
  const currentMonth = monthKeyOf(deskToday())
  const [monthHover, setMonthHover] = useState<string | undefined>(undefined)
  const [focusMonth, setFocusMonth] = useState(() => clampMonth(start ?? minMonth, minMonth, maxMonth))
  const tentativeOpen = Boolean(start) && !end
  const sweep = useRangeSweep(start, end, sweepFrom, monthSpan)
  const { rootRef, focusAfterRender } = useFocusAfterRender("data-month")
  const years = layout === "continuous"
    ? inclusiveYears(Number(minMonth.slice(0, 4)), Number(maxMonth.slice(0, 4)))
    : [visibleYear, visibleYear + 1]
  const canStepBack = years[0] > Number(minMonth.slice(0, 4))
  const canStepForward = years[1] < Number(maxMonth.slice(0, 4))
  const clampedFocus = clampMonth(focusMonth, minMonth, maxMonth)
  const rovingMonth = years.includes(Number(clampedFocus.slice(0, 4)))
    ? clampedFocus
    : clampMonth(`${years[0]}-01`, minMonth, maxMonth)

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement) || !event.target.dataset.month) return
    const next = monthForKey(event, rovingMonth)
    if (!next) return
    event.preventDefault()

    const month = clampMonth(next, minMonth, maxMonth)
    setFocusMonth(month)
    if (tentativeOpen) setMonthHover(month)
    if (layout === "paged") {
      const year = Number(month.slice(0, 4))
      if (year < visibleYear) onVisibleYearChange(year)
      else if (year > visibleYear + 1) onVisibleYearChange(year - 1)
    }
    focusAfterRender(month)
  }

  return (
    <div
      className="fd-cal-popover"
      data-layout={layout}
      onPointerLeave={() => setMonthHover(undefined)}
    >
      <CalendarTop layout={layout}>
        <CalendarHeader
          summary={rangeSummary}
          presets={presets}
          activePreset={activePreset}
          onPreset={onPreset}
        />
      </CalendarTop>

      <div className="fd-cal-months" onKeyDown={handleKeyDown} ref={rootRef}>
        {layout === "paged" && (
          <>
            <CalendarStep
              direction="back"
              label="Año anterior"
              disabled={!canStepBack}
              onClick={() => onVisibleYearChange(visibleYear - 1)}
            />
            <CalendarStep
              direction="forward"
              label="Año siguiente"
              disabled={!canStepForward}
              onClick={() => onVisibleYearChange(visibleYear + 1)}
            />
          </>
        )}

        {years.map((year) => (
          <div key={year} data-calendar-key={String(year)}>
            <div className="fd-cal-caption">{year}</div>
            <div className="fd-cal-grid-months" role="group" aria-label={`Meses de ${year}`}>
              {Array.from({ length: 12 }, (_, index) => {
                const monthKey = `${year}-${String(index + 1).padStart(2, "0")}`
                /* A month cell is a day cell (06 §4): same sweep, same ends. */
                const kind = dayKind(monthKey, {
                  start,
                  end,
                  hover: monthHover,
                  today: currentMonth,
                  min: minMonth,
                  max: maxMonth,
                })
                const unavailable = kind === "past"

                return (
                  <button
                    key={monthKey}
                    type="button"
                    className="fd-cal-cell fd-cal-cell-month fd-focus-ring"
                    data-kind={kind}
                    data-month={monthKey}
                    {...sweep.cellProps(monthKey, kind)}
                    disabled={unavailable}
                    tabIndex={monthKey === rovingMonth ? 0 : -1}
                    aria-label={cellAriaLabel(monthCaption(monthKey), kind)}
                    aria-pressed={isChosen(kind)}
                    onPointerEnter={tentativeOpen && !unavailable ? () => setMonthHover(monthKey) : undefined}
                    onClick={() => {
                      setFocusMonth(monthKey)
                      onSelectMonth(monthKey)
                    }}
                  >
                    <span className="fd-cal-cell-label">{monthAbbreviation(monthKey)}</span>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="fd-cal-legend">
        <LegendItem swatch={<span className="fd-cal-legend-swatch" style={todaySwatchStyle}>{monthAbbreviation(currentMonth)}</span>}>
          mes en curso
        </LegendItem>
        <LegendItem swatch={<span className="fd-cal-legend-swatch" style={unavailableSwatchStyle}>may</span>}>
          no disponible
        </LegendItem>
        <LegendItem swatch={<span className="fd-cal-legend-swatch" style={inRangeSwatchStyle}>set</span>}>
          en el rango · máx. {maxSpan}
        </LegendItem>
      </div>
    </div>
  )
}

/* Moves the focus to the cell a key named once it is drawn: paging renders it
   a commit later. */
function useFocusAfterRender(attribute: "data-day" | "data-month") {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const pendingRef = useRef<string | null>(null)

  useLayoutEffect(() => {
    const key = pendingRef.current
    if (!key) return
    pendingRef.current = null
    rootRef.current?.querySelector<HTMLElement>(`[${attribute}="${key}"]`)?.focus()
  })

  const focusAfterRender = useCallback((key: string) => {
    pendingRef.current = key
  }, [])

  return { rootRef, focusAfterRender }
}

/** Where a key moves the focus from `day`, or `undefined` when it is not a calendar key. */
function dayForKey(event: KeyboardEvent, day: string): string | undefined {
  const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7
  switch (event.key) {
    case "ArrowLeft": return addDays(day, -1)
    case "ArrowRight": return addDays(day, 1)
    case "ArrowUp": return addDays(day, -7)
    case "ArrowDown": return addDays(day, 7)
    case "Home": return addDays(day, -weekday)
    case "End": return addDays(day, 6 - weekday)
    case "PageUp": return sameDayInMonth(day, event.shiftKey ? -12 : -1)
    case "PageDown": return sameDayInMonth(day, event.shiftKey ? 12 : 1)
    default: return undefined
  }
}

function monthForKey(event: KeyboardEvent, month: string): string | undefined {
  const column = (Number(month.slice(5, 7)) - 1) % MONTHS_PER_ROW
  switch (event.key) {
    case "ArrowLeft": return addMonths(month, -1)
    case "ArrowRight": return addMonths(month, 1)
    case "ArrowUp": return addMonths(month, -MONTHS_PER_ROW)
    case "ArrowDown": return addMonths(month, MONTHS_PER_ROW)
    case "Home": return addMonths(month, -column)
    case "End": return addMonths(month, MONTHS_PER_ROW - 1 - column)
    case "PageUp": return addMonths(month, -12)
    case "PageDown": return addMonths(month, 12)
    default: return undefined
  }
}

/* The 31st of a month that has 30 lands on the 30th. */
function sameDayInMonth(day: string, months: number): string {
  const month = addMonths(monthKeyOf(day), months)
  return minIsoDate(`${month}-${day.slice(8)}`, lastDayOfMonth(month))
}

function clampMonth(month: string, min: string, max: string): string {
  if (month < min) return min
  return month > max ? max : month
}

function maxDateOf(left: string, right: string): string {
  return left > right ? left : right
}

function inclusiveMonthKeys(start: string, end: string): string[] {
  const months: string[] = []
  for (let month = start; month <= end; month = addMonths(month, 1)) {
    months.push(month)
  }
  return months
}

function inclusiveYears(start: number, end: number): number[] {
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index)
}

function CalendarHeader({
  summary,
  presets,
  activePreset,
  onPreset,
}: {
  summary: ReactNode
  presets?: RangePreset[]
  activePreset?: number
  onPreset?: (value: number) => void
}) {
  return (
    <div className="fd-cal-head">
      {summary}
      {presets && onPreset && (
        <div className="flex items-center gap-1.5">
          {presets.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="fd-cal-preset fd-focus-ring"
              aria-pressed={activePreset === preset.value}
              onClick={() => onPreset(preset.value)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function CalendarStep({
  direction,
  label,
  disabled,
  onClick,
}: {
  direction: "back" | "forward"
  label: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={cn("fd-cal-step fd-focus-ring", direction === "back" ? "left-0" : "right-0")}
      disabled={disabled}
      aria-label={label}
      onClick={onClick}
    >
      <AppIcon name={direction === "back" ? "chevronLeft" : "chevronRight"} />
    </button>
  )
}

function LegendItem({ swatch, children }: { swatch: ReactNode; children: ReactNode }) {
  return (
    <span className="fd-cal-legend-item">
      {swatch}
      {children}
    </span>
  )
}

/* The legend restates the cell states rather than reusing a live cell, so it
   never reads as something to click. */
const todaySwatchStyle = {
  boxShadow: "inset 0 0 0 1.5px color-mix(in srgb, var(--color-primary) 55%, transparent)",
  color: "var(--color-foreground)",
} as const

const unavailableSwatchStyle = {
  color: "color-mix(in srgb, var(--color-muted-foreground) 38%, transparent)",
  fontWeight: 400,
} as const

const inRangeSwatchStyle = {
  background: "color-mix(in srgb, var(--color-primary) 12%, transparent)",
  color: "color-mix(in srgb, var(--color-primary) 78%, var(--color-foreground))",
} as const

/** Confirmed choices only. A tentative sweep is not a selection. */
function isChosen(kind: DayKind): boolean {
  return kind === "solo" || kind === "start" || kind === "mid" || kind === "end"
}

type SweepCellProps = {
  "data-sweep"?: 0 | 1
  style?: CSSProperties
}

/*
 * Movement 5 (07 §4): the range fills from the end picked first in 140ms,
 * cell by cell because a range wraps across weeks; position `i` of `n` starts
 * at `140·i/n`. The parity flips per range so an equal-length range replays.
 */
function useRangeSweep(
  start: string | undefined,
  end: string | undefined,
  from: "start" | "end" = "start",
  span: (from: string, to: string) => number = inclusiveDayCount,
) {
  const key = start && end && start !== end ? `${start}|${end}` : ""
  const [state, setState] = useState({ key, parity: 0 as 0 | 1 })

  if (state.key !== key) setState({ key, parity: state.parity === 0 ? 1 : 0 })

  const days = key && start && end ? span(start, end) : 0

  return {
    cellProps(day: string, kind: DayKind): SweepCellProps {
      if (!key || !start || !end || days < 2) return {}
      if (kind !== "start" && kind !== "mid" && kind !== "end") return {}

      const offset = span(start, day) - 1
      const index = from === "start" ? offset : days - 1 - offset
      return {
        "data-sweep": state.parity,
        style: {
          "--fd-sweep-index": String(index),
          "--fd-sweep-count": String(days),
          "--fd-sweep-origin": from === "start" ? "left" : "right",
        } as CSSProperties,
      }
    },
  }
}

function inclusiveDayCount(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00Z`)
  const toMs = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 0
  return Math.round((toMs - fromMs) / 86_400_000) + 1
}

const KIND_LABEL: Partial<Record<DayKind, string>> = {
  past: "no disponible",
  today: "hoy",
  solo: "fecha elegida",
  start: "inicio del rango",
  mid: "en el rango",
  end: "fin del rango",
}

function cellAriaLabel(name: string, kind: DayKind): string {
  const label = KIND_LABEL[kind]
  return label ? `${name}, ${label}` : name
}
