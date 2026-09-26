import { useEffect, useEffectEvent, useMemo, useRef, useState, type RefObject } from "react"
import { AppIcon } from "@/components/ui/app-icon"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { DayRangeCalendar, type RangePreset } from "@/components/ui/range-calendar"
import { Sheet } from "@/components/ui/sheet"
import { scrollCalendarMonthIntoView } from "@/lib/calendar-scroll"
import { formatDate, formatDayMonth } from "@/lib/format"
import { addDays, clampIsoDate, isIsoDate, monthKeyOf, nightsBetween } from "@/lib/iso-date"
import { cn } from "@/lib/utils"

/*
 * Plate 2e — "fechas fusionadas": one control with two halves, each its own
 * trigger, split by a 1px line; the ring marks the half being chosen.
 */

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
  /* The date under the pointer or the focus, written into the return half
     until it leaves — never a choice (11 §2.2, moment 3). */
  const [tentativeEnd, setTentativeEnd] = useState<string | undefined>(undefined)
  const mobileCalendarRef = useRef<HTMLDivElement | null>(null)
  const startTriggerRef = useRef<HTMLButtonElement | null>(null)
  const endTriggerRef = useRef<HTMLButtonElement | null>(null)
  const openedFromRef = useRef<Half>("start")
  const interactedOutsideRef = useRef(false)
  const validStart = isIsoDate(startDate) ? startDate : undefined
  const validEnd = !endDisabled && isIsoDate(endDate) ? endDate : undefined
  const draftStart = isIsoDate(draftStartDate) ? draftStartDate : undefined
  const draftEnd = !endDisabled && isIsoDate(draftEndDate) ? draftEndDate : undefined
  const calendarStart = mobile ? draftStart : validStart
  const calendarEnd = mobile ? draftEnd : validEnd
  const [visibleMonth, setVisibleMonth] = useState(() => monthKeyOf(validStart ?? minDate))
  /* A one-way trip has no return half: derived, so switching closes it in the same render. */
  const activeHalf = endDisabled && openHalf === "end" ? null : openHalf
  const nights = nightsBetween(calendarStart, calendarEnd)
  /* Moment 3 writes the header too, so the nights a return buys are seen before choosing it. */
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
      /* A return before the departure re-anchors the trip. */
      if (validStart && day < validStart) {
        onChange({ startDate: day, endDate: "" })
        setOpenHalf("end")
        return
      }

      onChange({ startDate: startDate, endDate: clampIsoDate(day, minDate, endCeiling) })
      /* It stays open so moment 4 — the fill and «12 ago → 19 ago · 7 noches»
         — is seen; the desk calendar confirms on close (03 §7). */
      setTentativeEnd(undefined)
      return
    }

    const nextCeiling = clampIsoDate(addDays(day, maxStayNights), minDate, maxDate)
    const keptEnd = validEnd && validEnd >= day && validEnd <= nextCeiling ? validEnd : ""
    onChange({ startDate: day, endDate: keptEnd })
    /* A departure with no return hands over the second half instead of closing. */
    setOpenHalf(endDisabled || keptEnd ? null : "end")
  }

  const handlePreset = (presetNights: number) => {
    if (!calendarStart) return
    const nextEnd = clampIsoDate(addDays(calendarStart, presetNights), minDate, endCeiling)
    if (mobile) {
      setDraftEndDate(nextEnd)
    } else {
      onChange({ startDate: calendarStart, endDate: nextEnd })
    }
  }

  /* Opening aims the pager at the month about to be edited. */
  const openHalfFor = (half: Half) => {
    const anchorDate = half === "end" ? validEnd ?? validStart : validStart
    if (mobile) {
      setDraftStartDate(validStart ?? "")
      setDraftEndDate(validEnd ?? "")
    }
    openedFromRef.current = half
    setVisibleMonth(monthKeyOf(anchorDate ?? minDate))
    setOpenHalf(half)
  }

  /* A half counts as visited once the calendar is left, so its message waits
     until the agent has had the chance to choose. */
  const dismiss = () => {
    onTouch?.(openedFromRef.current)
    setOpenHalf(null)
  }

  /* The phone's calendar scrolls to the month being edited when it opens, not
     after every tap. */
  const sheetOpen = mobile && activeHalf !== null
  const anchorMonth = monthKeyOf((activeHalf === "end" ? calendarEnd ?? calendarStart : calendarStart) ?? minDate)
  const scrollToAnchorMonth = useEffectEvent(() => {
    scrollCalendarMonthIntoView(mobileCalendarRef.current, anchorMonth)
  })
  useEffect(() => {
    if (!sheetOpen) return
    const frame = window.requestAnimationFrame(() => scrollToAnchorMonth())
    return () => window.cancelAnimationFrame(frame)
  }, [sheetOpen])

  const control = (
    <div
      className={cn("fd-daterange-control", (startInvalid || endInvalid) && "fd-field-invalid")}
      data-open={activeHalf !== null}
    >
      <RangeHalf
        half="start"
        label={startLabel}
        value={validStart ? formatDate(validStart) : "Elegir"}
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
        /* Moments 2 and 3 of plate 9a: «Elegir vuelta» once the outbound is
           chosen, then the date under the pointer. Neither is a selection. */
        value={endDisabled
          ? "No aplica"
          : validEnd
            ? formatDate(validEnd)
            : tentativeEnd
              ? formatDate(tentativeEnd)
              : calendarStart
                ? "Elegir vuelta"
                : "Elegir"}
        tentative={!endDisabled && !validEnd && Boolean(tentativeEnd || calendarStart)}
        placeholder={endDisabled || (!validEnd && !tentativeEnd)}
        active={activeHalf === "end"}
        disabled={endDisabled}
        invalid={endInvalid}
        errorId={errorId}
        triggerRef={endTriggerRef}
        onOpen={() => openHalfFor("end")}
        /* 11 §2.2: the cross clears both dates and reopens the calendar on the
           departure, which takes the focus the vanished cross had (11 §0.4). It
           shows on the return half, the one it belongs to. */
        onClear={validEnd
          ? () => {
              onChange({ startDate: "", endDate: "" })
              setDraftStartDate("")
              setDraftEndDate("")
              setTentativeEnd(undefined)
              openHalfFor("start")
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
          /* 11 §2.2: every way out keeps what was chosen; only «Borrar» discards. */
          onOpenChange={(next) => {
            if (next) return
            if (calendarStart) {
              onChange({ startDate: calendarStart, endDate: endDisabled ? "" : calendarEnd ?? "" })
            }
            dismiss()
          }}
          title="Fechas"
          meta={nights !== undefined ? `${nights} ${nights === 1 ? "noche" : "noches"}` : undefined}
          placement="bottom"
          size="full"
          className="fd-calendar-sheet"
          footer={(
            <>
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
    <Popover open={activeHalf !== null} onOpenChange={(next) => { if (!next) dismiss() }}>
      <PopoverAnchor asChild>{control}</PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={6}
        bare
        className="w-[min(552px,calc(100dvw-2rem))]"
        aria-label="Calendario de fechas"
        /* The focus goes to the day in the tab order, and back to the half
           that opened the calendar unless the agent clicked elsewhere. */
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          interactedOutsideRef.current = false
          focusRovingCell(event.currentTarget)
        }}
        onInteractOutside={() => {
          interactedOutsideRef.current = true
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (interactedOutsideRef.current) return
          const trigger = openedFromRef.current === "end" && !endDisabled ? endTriggerRef : startTriggerRef
          trigger.current?.focus()
        }}
      >
        {calendar}
      </PopoverContent>
    </Popover>
  )
}

function focusRovingCell(root: EventTarget | null) {
  if (root instanceof HTMLElement) root.querySelector<HTMLElement>(".fd-cal-cell[tabindex='0']")?.focus()
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
  triggerRef: RefObject<HTMLButtonElement | null>
  onOpen: () => void
  onClear?: () => void
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
          aria-label="Borrar las fechas"
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
        {formatDayMonth(start)}
        {end && (
          <>
            <AppIcon name="oneWay" size={14} className="self-center text-muted-foreground" />
            {formatDayMonth(end)}
          </>
        )}
      </span>
      {nights !== undefined && (
        <span className="fd-status-pill fd-tabular">
          {nights} {nights === 1 ? "noche" : "noches"}
        </span>
      )}
    </div>
  )
}
