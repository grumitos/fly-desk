import { useMemo, type ReactNode } from "react"
import { AppIcon } from "@/components/ui/app-icon"
import {
  addMonths,
  monthCaption,
  monthDayCells,
  monthKeyOf,
  monthShortLabel,
  rangePosition,
  todayIso,
  type RangePosition,
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

/** A cell whose value cannot be chosen, with the reason it cannot. */
type CellState = {
  position: RangePosition
  disabled: boolean
  today: boolean
}

function dayCellState(
  day: string,
  { start, end, minDate, maxDate }: { start?: string; end?: string; minDate: string; maxDate: string },
  today: string,
): CellState {
  return {
    position: rangePosition(day, start, end),
    // "Unavailable" is one state with two causes — in the past, or beyond the
    // one-year window. Both read the same because the agent's next move is the
    // same either way: pick another day.
    disabled: day < minDate || day > maxDate,
    today: day === today,
  }
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
}) {
  const today = useMemo(() => todayIso(), [])
  const months = [visibleMonth, addMonths(visibleMonth, 1)]
  // Paging stops where the window stops: a chevron that leads nowhere is worse
  // than a chevron that is plainly spent.
  const canStepBack = months[0] > monthKeyOf(minDate)
  const canStepForward = months[1] < monthKeyOf(maxDate)

  return (
    <div className="fd-cal-popover fd-motion-emergente">
      <CalendarHeader
        summary={rangeSummary}
        presets={presets}
        activePreset={activePreset}
        onPreset={onPreset}
      />

      <div className="fd-cal-months">
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

        {months.map((monthKey) => (
          <div key={monthKey}>
            <div className="fd-cal-caption">{monthCaption(monthKey)}</div>
            <div className="fd-cal-weekdays" aria-hidden="true">
              {WEEKDAYS.map((weekday) => (
                <span key={weekday} className="fd-cal-weekday">{weekday}</span>
              ))}
            </div>
            <div className="fd-cal-grid" role="grid" aria-label={monthCaption(monthKey)}>
              {monthDayCells(monthKey).map((day, index) => {
                if (!day) {
                  return <span key={`blank-${index}`} className="fd-cal-cell" data-blank="true" aria-hidden="true" />
                }

                const state = dayCellState(day, { start, end, minDate, maxDate }, today)
                return (
                  <button
                    key={day}
                    type="button"
                    className="fd-cal-cell"
                    data-in-range={state.position}
                    data-today={state.today}
                    disabled={state.disabled}
                    aria-label={dayAriaLabel(day, state)}
                    aria-pressed={Boolean(state.position)}
                    onClick={() => onSelectDay(day)}
                  >
                    {Number(day.slice(8))}
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
        <LegendItem swatch={<span className="fd-cal-legend-swatch" style={otherMonthSwatchStyle} />}>
          otro mes
        </LegendItem>
      </div>
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
}) {
  const currentMonth = useMemo(() => monthKeyOf(todayIso()), [])
  const years = [visibleYear, visibleYear + 1]
  const canStepBack = years[0] > Number(minMonth.slice(0, 4))
  const canStepForward = years[1] < Number(maxMonth.slice(0, 4))

  return (
    <div className="fd-cal-popover fd-motion-emergente">
      <CalendarHeader
        summary={rangeSummary}
        presets={presets}
        activePreset={activePreset}
        onPreset={onPreset}
      />

      <div className="fd-cal-months">
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

        {years.map((year) => (
          <div key={year}>
            <div className="fd-cal-caption">{year}</div>
            <div className="fd-cal-grid-months" role="grid" aria-label={`Meses de ${year}`}>
              {Array.from({ length: 12 }, (_, index) => {
                const monthKey = `${year}-${String(index + 1).padStart(2, "0")}`
                const position = rangePosition(monthKey, start, end)
                const disabled = monthKey < minMonth || monthKey > maxMonth

                return (
                  <button
                    key={monthKey}
                    type="button"
                    className="fd-cal-cell fd-cal-cell-month"
                    data-in-range={position}
                    data-today={monthKey === currentMonth}
                    disabled={disabled}
                    aria-label={monthAriaLabel(monthKey, disabled, position)}
                    aria-pressed={Boolean(position)}
                    onClick={() => onSelectMonth(monthKey)}
                  >
                    {monthShortLabel(monthKey)}
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

const otherMonthSwatchStyle = {
  border: "1px dashed var(--color-input)",
} as const

const inRangeSwatchStyle = {
  background: "color-mix(in srgb, var(--color-primary) 12%, transparent)",
  color: "color-mix(in srgb, var(--color-primary) 78%, var(--color-foreground))",
} as const

function dayAriaLabel(day: string, state: CellState): string {
  const parts = [new Intl.DateTimeFormat("es-PE", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`))]

  if (state.today) parts.push("hoy")
  if (state.disabled) parts.push("no disponible")
  if (state.position === "start") parts.push("inicio del rango")
  if (state.position === "end") parts.push("fin del rango")
  if (state.position === "middle") parts.push("en el rango")

  return parts.join(", ")
}

function monthAriaLabel(monthKey: string, disabled: boolean, position: RangePosition): string {
  const parts = [monthCaption(monthKey)]
  if (disabled) parts.push("no disponible")
  if (position === "start") parts.push("inicio del rango")
  if (position === "end") parts.push("fin del rango")
  if (position === "middle") parts.push("en el rango")
  return parts.join(", ")
}

