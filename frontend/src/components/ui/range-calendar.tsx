import { useMemo, useState, type CSSProperties, type ReactNode } from "react"
import { AppIcon } from "@/components/ui/app-icon"
import {
  addMonths,
  dayKind,
  monthCaption,
  monthDayCells,
  monthKeyOf,
  monthShortLabel,
  monthSpan,
  todayIso,
  type DayKind,
} from "@/lib/iso-date"
import { cn } from "@/lib/utils"

/*
 * Plates 1g / 2e (days) and 6c / 7a (months).
 *
 * Four calendars, one frame. What differs between them is the grid — seven
 * columns of days or four of months — and the cell height, 32px on desktop and
 * 44px on mobile. Everything around the grid is identical: the live range and
 * its counter in the header, 26px shortcut chips, chevron paging, and a legend
 * at the foot. The month picker used to be a list of buttons with a check mark;
 * that is gone, because a range of months is a sweep just like a range of days.
 */

const WEEKDAYS = ["lu", "ma", "mi", "ju", "vi", "sá", "do"]

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
  sweepFrom = "start",
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
  /** Moment 3 of plate 9a: the field writes the tentative date while the
      pointer holds it, and clears it when the pointer leaves. */
  onHoverDay?: (day: string | undefined) => void
  layout?: "paged" | "continuous"
  /** Which end the agent picked first: movement 5 grows away from it. */
  sweepFrom?: "start" | "end"
}) {
  const today = useMemo(() => todayIso(), [])
  /* Only a pointer can produce moment 3, so a touch screen simply never sets
     this and the range paints on the second tap (03 §7). */
  const [hover, setHover] = useState<string | undefined>(undefined)
  const tentativeOpen = Boolean(start) && !end
  const sweep = useRangeSweep(start, end, sweepFrom)

  const setHoverDay = (day: string | undefined) => {
    setHover(day)
    onHoverDay?.(day)
  }
  const months = layout === "continuous"
    ? inclusiveMonthKeys(monthKeyOf(minDate), monthKeyOf(maxDate))
    : [visibleMonth, addMonths(visibleMonth, 1)]
  // Paging stops where the window stops: a chevron that leads nowhere is worse
  // than a chevron that is plainly spent.
  const canStepBack = months[0] > monthKeyOf(minDate)
  const canStepForward = months[1] < monthKeyOf(maxDate)

  return (
    <div
      /* No movement of its own: this card is always inside something that has
         one — the popover on a desk, the sheet on a phone — and two nested
         6px entrances travel twelve. */
      className="fd-cal-popover"
      data-layout={layout}
      onPointerLeave={() => setHoverDay(undefined)}
    >
      <CalendarHeader
        summary={rangeSummary}
        presets={presets}
        activePreset={activePreset}
        onPreset={onPreset}
      />

      {layout === "continuous" && <WeekdayRow sticky />}

      <div className="fd-cal-months">
        {layout === "paged" && (
          <>
            <CalendarStep
              direction="back"
              disabled={!canStepBack}
              onClick={() => onVisibleMonthChange(addMonths(visibleMonth, -1))}
            />
            <CalendarStep
              direction="forward"
              disabled={!canStepForward}
              onClick={() => onVisibleMonthChange(addMonths(visibleMonth, 1))}
            />
          </>
        )}

        {months.map((monthKey) => (
          <div key={monthKey} data-calendar-key={monthKey}>
            <div className="fd-cal-caption">{monthCaption(monthKey)}</div>
            {layout === "paged" && <WeekdayRow />}
            <div className="fd-cal-grid" role="grid" aria-label={monthCaption(monthKey)}>
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
                    className="fd-cal-cell"
                    data-kind={kind}
                    {...sweep.cellProps(day, kind)}
                    disabled={unavailable}
                    aria-label={dayAriaLabel(day, kind)}
                    aria-pressed={isChosen(kind)}
                    /* An unavailable day does not respond: no hover, no
                       tentative, no cursor (11 §2.2). */
                    onPointerEnter={tentativeOpen && !unavailable ? () => setHoverDay(day) : undefined}
                    onClick={() => onSelectDay(day)}
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
        {/* No «otro mes» entry: 03 §7 says a day from a neighbouring month is
            not drawn at all, so the grid has no dashed cell for this legend to
            explain. A legend that names a state the grid never shows sends the
            agent looking for it. */}
      </div>
    </div>
  )
}

function WeekdayRow({ sticky = false }: { sticky?: boolean }) {
  return (
    <div className="fd-cal-weekdays" data-sticky={sticky || undefined} aria-hidden="true">
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
  const currentMonth = useMemo(() => monthKeyOf(todayIso()), [])
  const [monthHover, setMonthHover] = useState<string | undefined>(undefined)
  const tentativeOpen = Boolean(start) && !end
  const sweep = useRangeSweep(start, end, sweepFrom, monthSpan)
  const years = layout === "continuous"
    ? inclusiveYears(Number(minMonth.slice(0, 4)), Number(maxMonth.slice(0, 4)))
    : [visibleYear, visibleYear + 1]
  const canStepBack = years[0] > Number(minMonth.slice(0, 4))
  const canStepForward = years[1] < Number(maxMonth.slice(0, 4))

  return (
    <div
      /* No movement of its own: this card is always inside something that has
         one — the popover on a desk, the sheet on a phone — and two nested
         6px entrances travel twelve. */
      className="fd-cal-popover"
      data-layout={layout}
      onPointerLeave={() => setMonthHover(undefined)}
    >
      <CalendarHeader
        summary={rangeSummary}
        presets={presets}
        activePreset={activePreset}
        onPreset={onPreset}
      />

      <div className="fd-cal-months">
        {layout === "paged" && (
          <>
            <CalendarStep
              direction="back"
              disabled={!canStepBack}
              onClick={() => onVisibleYearChange(visibleYear - 1)}
            />
            <CalendarStep
              direction="forward"
              disabled={!canStepForward}
              onClick={() => onVisibleYearChange(visibleYear + 1)}
            />
          </>
        )}

        {years.map((year) => (
          <div key={year} data-calendar-key={String(year)}>
            <div className="fd-cal-caption">{year}</div>
            <div className="fd-cal-grid-months" role="grid" aria-label={`Meses de ${year}`}>
              {Array.from({ length: 12 }, (_, index) => {
                const monthKey = `${year}-${String(index + 1).padStart(2, "0")}`
                /* A month cell is a day cell (06 §4): same sweep, same rounded
                   ends, same code path — only the grid changes. */
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
                    className="fd-cal-cell fd-cal-cell-month"
                    data-kind={kind}
                    {...sweep.cellProps(monthKey, kind)}
                    disabled={unavailable}
                    aria-label={monthAriaLabel(monthKey, kind)}
                    aria-pressed={isChosen(kind)}
                    onPointerEnter={tentativeOpen && !unavailable ? () => setMonthHover(monthKey) : undefined}
                    onClick={() => onSelectMonth(monthKey)}
                  >
                    <span className="fd-cal-cell-label">{monthShortLabel(monthKey)}</span>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="fd-cal-legend">
        <LegendItem swatch={<span className="fd-cal-legend-swatch" style={todaySwatchStyle}>{monthShortLabel(currentMonth)}</span>}>
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
  disabled,
  onClick,
}: {
  direction: "back" | "forward"
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={cn("fd-cal-step fd-focus-ring", direction === "back" ? "left-0" : "right-0")}
      disabled={disabled}
      aria-label={direction === "back" ? "Mes anterior" : "Mes siguiente"}
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

/* The legend swatches restate the three cell states rather than reusing the
   live cell, so a legend never reads as something you can click. */
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
 * Movement 5 (07 §4, drawn as moment 4 of 9a): the range fills from the end the
 * agent picked towards the other, in 140ms.
 *
 * It is done cell by cell rather than as one band over the grid because the
 * grid wraps: a confirmed range crosses weeks, and a single band would have to
 * be three bands with three geometries. Each cell holds its own share of the
 * 140ms — position `i` of `n` starts at `140·i/n` and lasts `140/n` — so the
 * whole fill still takes exactly one `emergente` from end to end.
 *
 * The parity is what makes it replay. A CSS animation restarts when its name
 * changes and not when an attribute does, so a second range of the same length
 * would otherwise paint in silence.
 */
function useRangeSweep(
  start: string | undefined,
  end: string | undefined,
  from: "start" | "end",
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

function dayAriaLabel(day: string, kind: DayKind): string {
  const parts = [new Intl.DateTimeFormat("es-PE", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`))]

  const label = KIND_LABEL[kind]
  if (label) parts.push(label)
  return parts.join(", ")
}

function monthAriaLabel(monthKey: string, kind: DayKind): string {
  const parts = [monthCaption(monthKey)]
  const label = KIND_LABEL[kind]
  if (label) parts.push(label)
  return parts.join(", ")
}

