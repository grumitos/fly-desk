import { useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { AppIcon } from "@/components/ui/app-icon"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { DayRangeCalendar, type RangePreset } from "@/components/ui/range-calendar"
import { Sheet } from "@/components/ui/sheet"
import { scrollCalendarMonthIntoView } from "@/lib/calendar-scroll"
import { addDays, clampIsoDate, isIsoDate, monthKeyOf, nightsBetween } from "@/lib/iso-date"
import { cn } from "@/lib/utils"

/*
 * Plate 2e — "fechas fusionadas".
 *
 * If the calendar is one popover showing both months, keeping two separate date
 * cards duplicates a border for a single piece of data. So this is one control
 * with two halves, each focusable, split by a 1px line, and the primary ring
 * appears only on the half being chosen.
 */

/* es-PE abbreviates months with a trailing dot ("12 ago. 2026"); the plates
   write them without it, so it is stripped everywhere a date is rendered. */
const DATE_LABEL_FORMATTER = new Intl.DateTimeFormat("es-PE", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
})

const RANGE_LABEL_FORMATTER = new Intl.DateTimeFormat("es-PE", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
})

function formatDay(iso: string): string {
  return DATE_LABEL_FORMATTER.format(new Date(`${iso}T00:00:00Z`)).replace(".", "")
}

function formatDayShort(iso: string): string {
  return RANGE_LABEL_FORMATTER.format(new Date(`${iso}T00:00:00Z`)).replace(".", "")
}

const STAY_PRESETS: RangePreset[] = [
  { label: "7 n", value: 7 },
  { label: "14 n", value: 14 },
  { label: "30 n", value: 30 },
]

type Half = "start" | "end"

export function DateRangeField({
  startLabel,
  endLabel,
  startDate,
  endDate,
  minDate,
  maxDate,
  maxStayNights,
  endDisabled = false,
  endDisabledLabel = "No aplica",
  startInvalid = false,
  endInvalid = false,
  errorId,
  onChange,
  onTouch,
  mobile = false,
}: {
  startLabel: string
  endLabel: string
  startDate: string
  endDate: string
  minDate: string
  maxDate: string
  maxStayNights: number
  endDisabled?: boolean
  endDisabledLabel?: string
  startInvalid?: boolean
  endInvalid?: boolean
  errorId?: string
  onChange: (next: { startDate: string; endDate: string }) => void
  onTouch?: (half: Half) => void
  mobile?: boolean
}) {
  const [openHalf, setOpenHalf] = useState<Half | null>(null)
  const [draftStartDate, setDraftStartDate] = useState("")
  const [draftEndDate, setDraftEndDate] = useState("")
  /* The date under the pointer. It is written into the return half and erased
     when the pointer leaves — it is never a choice (11 §2.2, moment 3). */
  const [tentativeEnd, setTentativeEnd] = useState<string | undefined>(undefined)
  const mobileCalendarRef = useRef<HTMLDivElement | null>(null)
  const validStart = isIsoDate(startDate) ? startDate : undefined
  const validEnd = !endDisabled && isIsoDate(endDate) ? endDate : undefined
  const draftStart = isIsoDate(draftStartDate) ? draftStartDate : undefined
  const draftEnd = !endDisabled && isIsoDate(draftEndDate) ? draftEndDate : undefined
  const calendarStart = mobile ? draftStart : validStart
  const calendarEnd = mobile ? draftEnd : validEnd
  const [visibleMonth, setVisibleMonth] = useState(() => monthKeyOf(validStart ?? minDate))
  /* A one-way trip has no return half, so the second half can never be the open
     one. Derived rather than corrected in an effect: switching to one-way should
     close it in the same render, not one render later. */
  const activeHalf = endDisabled && openHalf === "end" ? null : openHalf
  const nights = nightsBetween(calendarStart, calendarEnd)
  /* 11 §2.2 moment 3: while the pointer is over a later day the range is
     already written — the field does it, and the calendar header has to do it
     too, or the agent picks a return without ever seeing how many nights it
     buys. It is a preview, not a choice: leaving the pointer erases it. */
  const previewEnd = !endDisabled && calendarStart && tentativeEnd && tentativeEnd >= calendarStart
    ? tentativeEnd
    : undefined
  const summaryEnd = calendarEnd ?? previewEnd
  const summaryNights = nights ?? nightsBetween(calendarStart, previewEnd)
  const endCeiling = useMemo(
    () => calendarStart
      ? clampIsoDate(addDays(calendarStart, maxStayNights), minDate, maxDate)
      : maxDate,
    [calendarStart, maxDate, maxStayNights, minDate],
  )

  const handleSelectDay = (day: string) => {
    if (mobile) {
      if (activeHalf === "end") {
        if (calendarStart && day < calendarStart) {
          setDraftStartDate(day)
          setDraftEndDate("")
          setOpenHalf("end")
          return
        }

        setDraftEndDate(clampIsoDate(day, minDate, endCeiling))
        setOpenHalf("end")
        return
      }

      const nextCeiling = clampIsoDate(addDays(day, maxStayNights), minDate, maxDate)
      const keptEnd = calendarEnd && calendarEnd >= day && calendarEnd <= nextCeiling ? calendarEnd : ""
      setDraftStartDate(day)
      setDraftEndDate(keptEnd)
      setOpenHalf(endDisabled ? "start" : "end")
      return
    }

    if (activeHalf === "end") {
      // Choosing a return before the departure means the agent is re-anchoring
      // the trip, not asking for a negative stay.
      if (validStart && day < validStart) {
        onChange({ startDate: day, endDate: "" })
        setOpenHalf("end")
        return
      }

      onChange({ startDate: startDate, endDate: clampIsoDate(day, minDate, endCeiling) })
      /* 11 §2.2 moment 4 is a thing the agent has to be able to see: the fill
         grows towards the chosen end, the ends round off and «12 ago → 19 ago ·
         7 noches» appears in the header. Closing here meant none of it was ever
         on screen — the summary only showed up if they reopened the calendar.
         03 §7 says the desk calendar has no actions because «se confirma al
         cerrar», so leaving it open is also what that clause describes. */
      setTentativeEnd(undefined)
      return
    }

    const nextCeiling = clampIsoDate(addDays(day, maxStayNights), minDate, maxDate)
    const keptEnd = validEnd && validEnd >= day && validEnd <= nextCeiling ? validEnd : ""
    onChange({ startDate: day, endDate: keptEnd })
    // Departure chosen and no return yet: the next thing the agent wants is the
    // return, so hand them the second half instead of closing.
    setOpenHalf(endDisabled || keptEnd ? null : "end")
  }

  const handlePreset = (presetNights: number) => {
    if (!calendarStart) return
    const nextEnd = clampIsoDate(addDays(calendarStart, presetNights), minDate, endCeiling)
    // Shortcuts move the return without closing anything (§2, calendar).
    if (mobile) {
      setDraftEndDate(nextEnd)
    } else {
      onChange({ startDate: calendarStart, endDate: nextEnd })
    }
  }

  const startTriggerRef = useRef<HTMLButtonElement | null>(null)

  /* Opening is an event, so the pager is aimed here rather than in an effect:
     it should land on the month you are about to edit, not on wherever the
     previous visit left it. */
  const openHalfFor = (half: Half) => {
    onTouch?.(half)
    const anchorDate = half === "end" ? validEnd ?? validStart : validStart
    if (mobile) {
      setDraftStartDate(validStart ?? "")
      setDraftEndDate(validEnd ?? "")
    }
    setVisibleMonth(monthKeyOf(anchorDate ?? minDate))
    setOpenHalf(half)
  }

  useEffect(() => {
    if (!mobile || activeHalf === null) return
    const anchorMonth = monthKeyOf((activeHalf === "end" ? calendarEnd ?? calendarStart : calendarStart) ?? minDate)
    const frame = window.requestAnimationFrame(() => {
      scrollCalendarMonthIntoView(mobileCalendarRef.current, anchorMonth)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeHalf, calendarEnd, calendarStart, minDate, mobile])

  const control = (
    <div
      className={cn("fd-daterange-control", (startInvalid || endInvalid) && "fd-field-invalid")}
      data-open={activeHalf !== null}
    >
      <RangeHalf
        half="start"
        label={startLabel}
        value={validStart ? formatDay(validStart) : "Elegir"}
        placeholder={!validStart}
        active={activeHalf === "start"}
        invalid={startInvalid}
        errorId={errorId}
        triggerRef={startTriggerRef}
        onOpen={() => openHalfFor("start")}
      />
      <span className="fd-daterange-divider" aria-hidden="true" />
      <RangeHalf
        half="end"
        label={endLabel}
        /* Moments 2 and 3 of plate 9a, in order: once the outbound is chosen
           the half says «Elegir vuelta» in primary, and while the pointer holds
           a later day it already writes that date. Neither is a selection. */
        value={endDisabled
          ? endDisabledLabel
          : validEnd
            ? formatDay(validEnd)
            : tentativeEnd
              ? formatDay(tentativeEnd)
              : calendarStart
                ? "Elegir vuelta"
                : "Elegir"}
        tentative={!endDisabled && !validEnd && Boolean(tentativeEnd || calendarStart)}
        placeholder={endDisabled || (!validEnd && !tentativeEnd)}
        active={activeHalf === "end"}
        disabled={endDisabled}
        invalid={endInvalid}
        errorId={errorId}
        onOpen={() => openHalfFor("end")}
        /* 03 §7 and 11 §2.2: the cross clears **both** dates, leaves the two
           halves on «Elegir» and hands the focus back to departure. Clearing
           only the return left a control that said «12 sep — Elegir» after the
           agent had asked for a blank one, and the next click landed on
           whichever half they happened to hit.

           It still only *appears* with a return date on it — that is the half
           it belongs to, and 11 §2.2 fixes what it does, not when it shows. */
        onClear={validEnd
          ? () => {
              onChange({ startDate: "", endDate: "" })
              setDraftStartDate("")
              setDraftEndDate("")
              setTentativeEnd(undefined)
              openHalfFor("start")
              /* The cross is its own trigger and it stops existing the moment
                 it works — it only renders with a return date on it. Without
                 this the focus falls to `<body>`, which 11 §0.4 forbids by
                 name, so it is handed to the half the ficha names: departure.
                 On the next frame, because the half re-renders first. */
              requestAnimationFrame(() => startTriggerRef.current?.focus())
            }
          : undefined}
      />
    </div>
  )

  const calendar = (
    <DayRangeCalendar
      start={calendarStart}
      end={calendarEnd}
      minDate={minDate}
      maxDate={activeHalf === "end" ? endCeiling : maxDate}
      visibleMonth={visibleMonth}
      presets={endDisabled ? undefined : STAY_PRESETS}
      activePreset={nights}
      rangeSummary={(
        <RangeSummary
          start={calendarStart}
          end={summaryEnd}
          nights={summaryNights}
          tentative={!calendarEnd && Boolean(previewEnd)}
        />
      )}
      onVisibleMonthChange={setVisibleMonth}
      onSelectDay={handleSelectDay}
      onPreset={endDisabled ? undefined : handlePreset}
      onHoverDay={mobile ? undefined : setTentativeEnd}
      layout={mobile ? "continuous" : "paged"}
    />
  )

  if (mobile) {
    const canApply = Boolean(calendarStart && (endDisabled || calendarEnd))
    return (
      <>
        {control}
        <Sheet
          open={activeHalf !== null}
          /* 11 §2.2: «Cerrar con el aspa **conserva** lo elegido: no hay
             cancelar». Every way out of the sheet — cross, scrim, `Esc`, the
             back button, the drag — commits the draft, so the only thing that
             discards a choice is «Borrar», which says so. It used to keep the
             draft local until «Aplicar», which meant closing the sheet threw
             away the dates the agent had just picked. */
          onOpenChange={(next) => {
            if (next) return
            if (calendarStart) {
              onChange({ startDate: calendarStart, endDate: endDisabled ? "" : calendarEnd ?? "" })
            }
            setOpenHalf(null)
          }}
          title="Fechas"
          meta={nights !== undefined ? `${nights} ${nights === 1 ? "noche" : "noches"}` : undefined}
          placement="bottom"
          size="full"
          className="fd-calendar-sheet"
          footer={(
            <>
              {/* 03 §7: both actions at the sheet's own 46 here, unlike the
                  filter sheet where «Limpiar» drops to 40 and is the lesser of
                  the two. (This said 52, which is the desktop primary, not the
                  mobile one a sheet is drawn at.) */}
              <button
                type="button"
                className="fd-sheet-action fd-sheet-action--secondary fd-focus-ring"
                onClick={() => {
                  setDraftStartDate("")
                  setDraftEndDate("")
                  setOpenHalf("start")
                }}
              >
                Borrar
              </button>
              <button
                type="button"
                className="fd-sheet-action fd-focus-ring"
                disabled={!canApply}
                onClick={() => {
                  if (!calendarStart) return
                  onChange({ startDate: calendarStart, endDate: endDisabled ? "" : calendarEnd ?? "" })
                  setOpenHalf(null)
                }}
              >
                Aplicar
              </button>
            </>
          )}
        >
          <div ref={mobileCalendarRef}>{calendar}</div>
        </Sheet>
      </>
    )
  }

  return (
    <Popover open={activeHalf !== null} onOpenChange={(next) => { if (!next) setOpenHalf(null) }}>
      <PopoverAnchor asChild>{control}</PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[min(552px,calc(100vw-2rem))] border-0 bg-transparent p-0 shadow-none"
        aria-label="Calendario de fechas"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {calendar}
      </PopoverContent>
    </Popover>
  )
}

function RangeHalf({
  half,
  label,
  value,
  placeholder,
  active,
  disabled = false,
  invalid = false,
  errorId,
  triggerRef,
  onOpen,
  onClear,
  tentative,
}: {
  half: Half
  label: string
  value: string
  placeholder: boolean
  active: boolean
  disabled?: boolean
  invalid?: boolean
  errorId?: string
  /** So the cross can hand the focus back after erasing itself (11 §2.2). */
  triggerRef?: RefObject<HTMLButtonElement | null>
  onOpen: () => void
  onClear?: () => void
  /** Moment 3 of plate 9a: the half already writes the date under the pointer,
      in primary, before anything is chosen. */
  tentative?: boolean
}) {
  return (
    <div className="fd-daterange-half" data-active={active} data-half={half} data-tentative={tentative || undefined}>
      <button
        ref={triggerRef}
        type="button"
        className="absolute inset-0 rounded-none fd-focus-ring"
        aria-label={`${label}: ${value}`}
        aria-haspopup="dialog"
        aria-expanded={active}
        aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
        disabled={disabled}
        onClick={onOpen}
      />
      <span className="fd-field-label">{label}</span>
      <AppIcon name="calendar" className="fd-daterange-icon" />
      <span className={cn("fd-field-value", placeholder && "fd-field-value-placeholder")}>{value}</span>
      {onClear && !disabled && (
        <button
          type="button"
          className="fd-daterange-clear fd-focus-ring relative z-10"
          aria-label={`Quitar ${label.toLowerCase()}`}
          onClick={onClear}
        >
          <AppIcon name="x" size={14} />
        </button>
      )}
    </div>
  )
}

function RangeSummary({
  start,
  end,
  nights,
  tentative = false,
}: {
  start?: string
  end?: string
  nights?: number
  tentative?: boolean
}) {
  if (!start) {
    return <span className="fd-cal-range text-muted-foreground">Elige la salida</span>
  }

  return (
    <div className="flex items-center gap-2.5">
      <span className="fd-cal-range" data-tentative={tentative || undefined}>
        {formatDayShort(start)}
        {end && (
          <>
            <AppIcon name="oneWay" size={14} className="self-center text-muted-foreground" />
            {formatDayShort(end)}
          </>
        )}
      </span>
      {nights !== undefined && (
        <span className="fd-status-pill fd-mono">
          {nights} {nights === 1 ? "noche" : "noches"}
        </span>
      )}
    </div>
  )
}
