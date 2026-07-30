import { useState } from "react"
import { AppIcon } from "@/components/ui/app-icon"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { MonthRangeCalendar, type RangePreset } from "@/components/ui/range-calendar"
import { addMonths, isIsoMonth, monthSpan, monthYearLabel } from "@/lib/iso-date"
import { cn } from "@/lib/utils"

/*
 * Plate 6c — the Migratorio month picker.
 *
 * In Migratorio the calendar of days gives up its place to this. The frame is
 * the day calendar's frame; only the grid changes. Picking is a sweep, so the
 * month that used to be a button with a check mark is now a cell with rounded
 * ends and a flat middle, exactly like a day.
 */

const SPAN_PRESETS: RangePreset[] = [
  { label: "3 m", value: 3 },
  { label: "6 m", value: 6 },
  { label: "12 m", value: 12 },
]

export function MonthRangeField({
  label,
  startMonth,
  endMonth,
  minMonth,
  maxMonth,
  maxSpan,
  invalid = false,
  onChange,
  onTouch,
}: {
  label: string
  startMonth: string
  endMonth: string
  minMonth: string
  maxMonth: string
  maxSpan: number
  invalid?: boolean
  onChange: (next: { startMonth: string; endMonth: string }) => void
  onTouch?: () => void
}) {
  const [open, setOpen] = useState(false)
  // While the agent is mid-sweep we hold the first end they clicked, so the
  // second click can extend either forwards or backwards from it.
  const [anchorMonth, setAnchorMonth] = useState<string | null>(null)
  const validStart = isIsoMonth(startMonth) ? startMonth : undefined
  const validEnd = isIsoMonth(endMonth) ? endMonth : undefined
  const [visibleYear, setVisibleYear] = useState(() => Number((validStart ?? minMonth).slice(0, 4)))
  const span = validStart && validEnd ? monthSpan(validStart, validEnd) : undefined

  /* Opening and closing are events, so the pager and the half-finished sweep are
     reset here rather than in an effect. */
  const handleOpenChange = (next: boolean) => {
    if (next) {
      onTouch?.()
      setVisibleYear(Number((validStart ?? minMonth).slice(0, 4)))
    } else {
      setAnchorMonth(null)
    }
    setOpen(next)
  }

  const handleSelectMonth = (monthKey: string) => {
    if (!anchorMonth) {
      setAnchorMonth(monthKey)
      onChange({ startMonth: monthKey, endMonth: monthKey })
      return
    }

    const [start, end] = anchorMonth <= monthKey ? [anchorMonth, monthKey] : [monthKey, anchorMonth]
    // The ceiling is a hard product limit, not a hint: clamp rather than let a
    // 30-month sweep through and fail at search time.
    const cappedEnd = monthSpan(start, end) > maxSpan ? addMonths(start, maxSpan - 1) : end
    setAnchorMonth(null)
    onChange({ startMonth: start, endMonth: cappedEnd })
    // Confirmed on close, exactly like the range of days.
    setOpen(false)
  }

  const handlePreset = (months: number) => {
    const start = validStart ?? minMonth
    const end = addMonths(start, months - 1)
    setAnchorMonth(null)
    onChange({
      startMonth: start,
      endMonth: end > maxMonth ? maxMonth : end,
    })
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverAnchor asChild>
        <div className={cn("fd-field-control relative", invalid && "fd-field-invalid")} data-active={open}>
          <button
            type="button"
            className="absolute inset-0 rounded-xl fd-focus-ring"
            aria-label={`${label}: ${rangeLabel(validStart, validEnd)}`}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen(true)}
          />
          <span className="fd-field-label" data-active={open || undefined}>{label}</span>
          <AppIcon name="calendar" className={open ? "text-primary" : "text-muted-foreground"} />
          <span className={cn("fd-field-value", !validStart && "fd-field-value-placeholder")}>
            {rangeLabel(validStart, validEnd)}
          </span>
        </div>
      </PopoverAnchor>

      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[min(552px,calc(100vw-2rem))] border-0 bg-transparent p-0 shadow-none"
        aria-label="Selector de meses"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <MonthRangeCalendar
          start={anchorMonth ?? validStart}
          end={anchorMonth ? anchorMonth : validEnd}
          minMonth={minMonth}
          maxMonth={maxMonth}
          maxSpan={maxSpan}
          visibleYear={visibleYear}
          presets={SPAN_PRESETS}
          activePreset={span}
          rangeSummary={<MonthRangeSummary start={validStart} end={validEnd} span={span} />}
          onVisibleYearChange={setVisibleYear}
          onSelectMonth={handleSelectMonth}
          onPreset={handlePreset}
        />
      </PopoverContent>
    </Popover>
  )
}

function MonthRangeSummary({
  start,
  end,
  span,
}: {
  start?: string
  end?: string
  span?: number
}) {
  if (!start) {
    return <span className="fd-cal-range text-muted-foreground">Elige el primer mes</span>
  }

  return (
    <div className="flex items-center gap-2.5">
      <span className="fd-cal-range">
        {monthYearLabel(start)}
        {end && end !== start && (
          <>
            <AppIcon name="oneWay" size={14} className="self-center text-muted-foreground" />
            {monthYearLabel(end)}
          </>
        )}
      </span>
      {span !== undefined && (
        <span className="fd-status-pill fd-mono">
          {span} {span === 1 ? "mes" : "meses"}
        </span>
      )}
    </div>
  )
}

function rangeLabel(start?: string, end?: string): string {
  if (!start) return "Seleccionar"
  if (!end || end === start) return monthYearLabel(start)
  return `${monthYearLabel(start)} – ${monthYearLabel(end)}`
}
