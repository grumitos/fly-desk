import { useEffect, useEffectEvent, useRef, useState } from "react"
import { AppIcon } from "@/components/ui/app-icon"
import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { MonthRangeCalendar, type RangePreset } from "@/components/ui/range-calendar"
import { Sheet } from "@/components/ui/sheet"
import { scrollCalendarMonthIntoView } from "@/lib/calendar-scroll"
import { monthYearLabel } from "@/lib/format"
import { addMonths, isIsoMonth, monthSpan } from "@/lib/iso-date"
import { cn } from "@/lib/utils"

/*
 * Plate 6c — the Migratorio month picker: the day calendar's frame with a grid
 * of months, picked as a sweep with rounded ends like a range of days.
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
  /* The first end of a sweep in progress, so the second can extend it either way. */
  const [anchorMonth, setAnchorMonth] = useState<string | null>(null)
  const [draftStartMonth, setDraftStartMonth] = useState("")
  const [draftEndMonth, setDraftEndMonth] = useState("")
  /* Movement 5 grows away from the end picked first. */
  const [sweepFrom, setSweepFrom] = useState<"start" | "end">("start")
  const mobileCalendarRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const interactedOutsideRef = useRef(false)
  const validStart = isIsoMonth(startMonth) ? startMonth : undefined
  const validEnd = isIsoMonth(endMonth) ? endMonth : undefined
  const draftStart = isIsoMonth(draftStartMonth) ? draftStartMonth : undefined
  const draftEnd = isIsoMonth(draftEndMonth) ? draftEndMonth : undefined
  const calendarStart = mobile ? draftStart : validStart
  const calendarEnd = mobile ? draftEnd : validEnd
  const [visibleYear, setVisibleYear] = useState(() => Number((validStart ?? minMonth).slice(0, 4)))
  const span = calendarStart && calendarEnd ? monthSpan(calendarStart, calendarEnd) : undefined

  const handleOpenChange = (next: boolean) => {
    if (next) {
      if (mobile) {
        setDraftStartMonth(validStart ?? "")
        setDraftEndMonth(validEnd ?? "")
      }
      setVisibleYear(Number((validStart ?? minMonth).slice(0, 4)))
    } else {
      /* The field counts as visited once the picker is left, so its message
         waits until the agent has had the chance to choose. */
      onTouch?.()
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
    /* The ceiling is a product limit: clamped here rather than refused at search time. */
    const cappedEnd = monthSpan(start, end) > maxSpan ? addMonths(start, maxSpan - 1) : end
    setAnchorMonth(null)
    if (mobile) {
      setDraftStartMonth(start)
      setDraftEndMonth(cappedEnd)
    } else {
      onChange({ startMonth: start, endMonth: cappedEnd })
      /* Confirmed on close, like the range of days. */
      handleOpenChange(false)
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

  /* The phone's calendar scrolls to the year being edited when it opens. */
  const sheetOpen = mobile && open
  const anchorYear = (calendarStart ?? minMonth).slice(0, 4)
  const scrollToAnchorYear = useEffectEvent(() => {
    scrollCalendarMonthIntoView(mobileCalendarRef.current, anchorYear)
  })
  useEffect(() => {
    if (!sheetOpen) return
    const frame = window.requestAnimationFrame(() => scrollToAnchorYear())
    return () => window.cancelAnimationFrame(frame)
  }, [sheetOpen])

  const control = (
    <div className={cn("fd-field-control relative", invalid && "fd-field-invalid")} data-active={open}>
      <button
        ref={triggerRef}
        type="button"
        className="absolute inset-0 rounded-xl fd-focus-ring"
        aria-label={`${label}: ${rangeLabel(validStart, validEnd)}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => handleOpenChange(true)}
      />
      <span className="fd-field-label" data-active={open || undefined}>{label}</span>
      <AppIcon name="calendar" className={open ? "text-primary" : "text-muted-foreground"} />
      {/* Its own class so the sweep is written like the dates it replaces;
          `.fd-field-value` alone is the stations' sans. */}
      <span className={cn("fd-field-value fd-monthrange-value", !validStart && "fd-field-value-placeholder")}>
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
          /* Like the date sheet: every way out keeps the months chosen; only
             «Borrar» discards. */
          onOpenChange={(next) => {
            if (!next && calendarStart && calendarEnd) {
              onChange({ startMonth: calendarStart, endMonth: calendarEnd })
            }
            handleOpenChange(next)
          }}
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
        bare
        className="w-[min(552px,calc(100dvw-2rem))]"
        aria-label="Selector de meses"
        /* The focus goes to the month in the tab order, and back to the field
           unless the agent clicked elsewhere. */
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          interactedOutsideRef.current = false
          if (event.currentTarget instanceof HTMLElement) {
            event.currentTarget.querySelector<HTMLElement>(".fd-cal-cell[tabindex='0']")?.focus()
          }
        }}
        onInteractOutside={() => {
          interactedOutsideRef.current = true
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (!interactedOutsideRef.current) triggerRef.current?.focus()
        }}
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
        <span className="fd-status-pill fd-tabular">
          {span} {span === 1 ? "mes" : "meses"}
        </span>
      )}
    </div>
  )
}

/* 03 §2's one word for an empty date control, and this is one (06 §4). */
function rangeLabel(start?: string, end?: string): string {
  if (!start) return "Elegir"
  if (!end || end === start) return monthYearLabel(start)
  return `${monthYearLabel(start)} – ${monthYearLabel(end)}`
}
