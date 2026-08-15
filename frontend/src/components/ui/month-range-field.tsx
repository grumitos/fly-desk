import { useEffect, useRef, useState } from "react"
import { AppIcon } from "@/components/ui/app-icon"
import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { MonthRangeCalendar, type RangePreset } from "@/components/ui/range-calendar"
import { Sheet } from "@/components/ui/sheet"
import { scrollCalendarMonthIntoView } from "@/lib/calendar-scroll"
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
  mobile = false,
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
  mobile?: boolean
}) {
  const [open, setOpen] = useState(false)
  // While the agent is mid-sweep we hold the first end they clicked, so the
  // second click can extend either forwards or backwards from it.
  const [anchorMonth, setAnchorMonth] = useState<string | null>(null)
  const [draftStartMonth, setDraftStartMonth] = useState("")
  const [draftEndMonth, setDraftEndMonth] = useState("")
  /* Which end the agent anchored on, so movement 5 grows away from it: picking
     a later month first and an earlier one second fills right to left. */
  const [sweepFrom, setSweepFrom] = useState<"start" | "end">("start")
  const mobileCalendarRef = useRef<HTMLDivElement | null>(null)
  const validStart = isIsoMonth(startMonth) ? startMonth : undefined
  const validEnd = isIsoMonth(endMonth) ? endMonth : undefined
  const draftStart = isIsoMonth(draftStartMonth) ? draftStartMonth : undefined
  const draftEnd = isIsoMonth(draftEndMonth) ? draftEndMonth : undefined
  const calendarStart = mobile ? draftStart : validStart
  const calendarEnd = mobile ? draftEnd : validEnd
  const [visibleYear, setVisibleYear] = useState(() => Number((validStart ?? minMonth).slice(0, 4)))
  const span = calendarStart && calendarEnd ? monthSpan(calendarStart, calendarEnd) : undefined

  /* Opening and closing are events, so the pager and the half-finished sweep are
     reset here rather than in an effect. */
  const handleOpenChange = (next: boolean) => {
    if (next) {
      onTouch?.()
      if (mobile) {
        setDraftStartMonth(validStart ?? "")
        setDraftEndMonth(validEnd ?? "")
      }
      setVisibleYear(Number((validStart ?? minMonth).slice(0, 4)))
    } else {
      setAnchorMonth(null)
    }
    setOpen(next)
  }

  const handleSelectMonth = (monthKey: string) => {
    if (!anchorMonth) {
      setAnchorMonth(monthKey)
      if (mobile) {
        setDraftStartMonth(monthKey)
        setDraftEndMonth(monthKey)
      } else {
        onChange({ startMonth: monthKey, endMonth: monthKey })
      }
      return
    }

    const [start, end] = anchorMonth <= monthKey ? [anchorMonth, monthKey] : [monthKey, anchorMonth]
    setSweepFrom(anchorMonth === start ? "start" : "end")
    // The ceiling is a hard product limit, not a hint: clamp rather than let a
    // 30-month sweep through and fail at search time.
    const cappedEnd = monthSpan(start, end) > maxSpan ? addMonths(start, maxSpan - 1) : end
    setAnchorMonth(null)
    if (mobile) {
      setDraftStartMonth(start)
      setDraftEndMonth(cappedEnd)
    } else {
      onChange({ startMonth: start, endMonth: cappedEnd })
      // Confirmed on close, exactly like the range of days.
      setOpen(false)
    }
  }

  const handlePreset = (months: number) => {
    const start = calendarStart ?? minMonth
    const end = addMonths(start, months - 1)
    setAnchorMonth(null)
    const cappedEnd = end > maxMonth ? maxMonth : end
    if (mobile) {
      setDraftStartMonth(start)
      setDraftEndMonth(cappedEnd)
    } else {
      onChange({ startMonth: start, endMonth: cappedEnd })
    }
  }

  useEffect(() => {
    if (!mobile || !open) return
    const anchorYear = String((calendarStart ?? minMonth).slice(0, 4))
    const frame = window.requestAnimationFrame(() => {
      scrollCalendarMonthIntoView(mobileCalendarRef.current, anchorYear)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [calendarStart, minMonth, mobile, open])

  const control = (
    <div className={cn("fd-field-control relative", invalid && "fd-field-invalid")} data-active={open}>
      <button
        type="button"
        className="absolute inset-0 rounded-xl fd-focus-ring"
        aria-label={`${label}: ${rangeLabel(validStart, validEnd)}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => handleOpenChange(true)}
      />
      <span className="fd-field-label" data-active={open || undefined}>{label}</span>
      <AppIcon name="calendar" className={open ? "text-primary" : "text-muted-foreground"} />
      <span className={cn("fd-field-value", !validStart && "fd-field-value-placeholder")}>
        {rangeLabel(validStart, validEnd)}
      </span>
    </div>
  )

  const calendar = (
    <MonthRangeCalendar
      start={anchorMonth ?? calendarStart}
      end={anchorMonth ? anchorMonth : calendarEnd}
      minMonth={minMonth}
      maxMonth={maxMonth}
      maxSpan={maxSpan}
      visibleYear={visibleYear}
      presets={SPAN_PRESETS}
      activePreset={span}
      rangeSummary={<MonthRangeSummary start={calendarStart} end={calendarEnd} span={span} />}
      onVisibleYearChange={setVisibleYear}
      onSelectMonth={handleSelectMonth}
      onPreset={handlePreset}
      layout={mobile ? "continuous" : "paged"}
      sweepFrom={sweepFrom}
    />
  )

  if (mobile) {
    return (
      <>
        {control}
        <Sheet
          open={open}
          onOpenChange={handleOpenChange}
          title="Meses"
          meta={`Migratorio · ${span ?? 0} de ${maxSpan} meses`}
          placement="bottom"
          size="full"
          className="fd-calendar-sheet"
          footer={(
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="secondary"
                size="xl"
                onClick={() => {
                  setAnchorMonth(null)
                  setDraftStartMonth("")
                  setDraftEndMonth("")
                }}
              >
                Borrar
              </Button>
              <Button
                type="button"
                size="xl"
                disabled={!calendarStart || !calendarEnd}
                onClick={() => {
                  if (!calendarStart || !calendarEnd) return
                  onChange({ startMonth: calendarStart, endMonth: calendarEnd })
                  handleOpenChange(false)
                }}
              >
                Aplicar
              </Button>
            </div>
          )}
        >
          <div ref={mobileCalendarRef}>{calendar}</div>
        </Sheet>
      </>
    )
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverAnchor asChild>{control}</PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[min(552px,calc(100vw-2rem))] border-0 bg-transparent p-0 shadow-none"
        aria-label="Selector de meses"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {calendar}
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
  // 03 §2 gives the empty date control one word, «Elegir». The month picker is
  // the same control with a different grid (06 §4), so it uses the same word.
  if (!start) return "Elegir"
  if (!end || end === start) return monthYearLabel(start)
  return `${monthYearLabel(start)} – ${monthYearLabel(end)}`
}
