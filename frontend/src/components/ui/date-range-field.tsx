import { useMemo, useState } from "react"
import { AppIcon } from "@/components/ui/app-icon"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { DayRangeCalendar, type RangePreset } from "@/components/ui/range-calendar"
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
  invalid = false,
  onChange,
  onTouch,
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
  invalid?: boolean
  onChange: (next: { startDate: string; endDate: string }) => void
  onTouch?: (half: Half) => void
}) {
  const [openHalf, setOpenHalf] = useState<Half | null>(null)
  const validStart = isIsoDate(startDate) ? startDate : undefined
  const validEnd = !endDisabled && isIsoDate(endDate) ? endDate : undefined
  const [visibleMonth, setVisibleMonth] = useState(() => monthKeyOf(validStart ?? minDate))
  /* A one-way trip has no return half, so the second half can never be the open
     one. Derived rather than corrected in an effect: switching to one-way should
     close it in the same render, not one render later. */
  const activeHalf = endDisabled && openHalf === "end" ? null : openHalf
  const nights = nightsBetween(validStart, validEnd)
  const endCeiling = useMemo(
    () => validStart
      ? clampIsoDate(addDays(validStart, maxStayNights), minDate, maxDate)
      : maxDate,
    [maxDate, maxStayNights, minDate, validStart],
  )

  const handleSelectDay = (day: string) => {
    if (activeHalf === "end") {
      // Choosing a return before the departure means the agent is re-anchoring
      // the trip, not asking for a negative stay.
      if (validStart && day < validStart) {
        onChange({ startDate: day, endDate: "" })
        setOpenHalf("end")
        return
      }

      onChange({ startDate: startDate, endDate: clampIsoDate(day, minDate, endCeiling) })
      setOpenHalf(null)
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
    if (!validStart) return
    const nextEnd = clampIsoDate(addDays(validStart, presetNights), minDate, endCeiling)
    // Shortcuts move the return without closing anything (§2, calendar).
    onChange({ startDate: validStart, endDate: nextEnd })
  }

  /* Opening is an event, so the pager is aimed here rather than in an effect:
     it should land on the month you are about to edit, not on wherever the
     previous visit left it. */
  const openHalfFor = (half: Half) => {
    onTouch?.(half)
    const anchorDate = half === "end" ? validEnd ?? validStart : validStart
    setVisibleMonth(monthKeyOf(anchorDate ?? minDate))
    setOpenHalf(half)
  }

  return (
    <Popover open={activeHalf !== null} onOpenChange={(next) => { if (!next) setOpenHalf(null) }}>
      <PopoverAnchor asChild>
        <div
          className={cn("fd-daterange-control", invalid && "fd-field-invalid")}
          data-open={activeHalf !== null}
        >
          <RangeHalf
            half="start"
            label={startLabel}
            value={validStart ? formatDay(validStart) : "Seleccionar"}
            placeholder={!validStart}
            active={activeHalf === "start"}
            onOpen={() => openHalfFor("start")}
          />
          <span className="fd-daterange-divider" aria-hidden="true" />
          <RangeHalf
            half="end"
            label={endLabel}
            value={endDisabled
              ? endDisabledLabel
              : validEnd
                ? formatDay(validEnd)
                : "Seleccionar"}
            placeholder={endDisabled || !validEnd}
            active={activeHalf === "end"}
            disabled={endDisabled}
            onOpen={() => openHalfFor("end")}
            onClear={validEnd
              ? () => onChange({ startDate, endDate: "" })
              : undefined}
          />
        </div>
      </PopoverAnchor>

      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[min(552px,calc(100vw-2rem))] border-0 bg-transparent p-0 shadow-none"
        aria-label="Calendario de fechas"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DayRangeCalendar
          start={validStart}
          end={validEnd}
          minDate={minDate}
          maxDate={activeHalf === "end" ? endCeiling : maxDate}
          visibleMonth={visibleMonth}
          presets={endDisabled ? undefined : STAY_PRESETS}
          activePreset={nights}
          rangeSummary={<RangeSummary start={validStart} end={validEnd} nights={nights} />}
          onVisibleMonthChange={setVisibleMonth}
          onSelectDay={handleSelectDay}
          onPreset={endDisabled ? undefined : handlePreset}
        />
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
  onOpen,
  onClear,
}: {
  half: Half
  label: string
  value: string
  placeholder: boolean
  active: boolean
  disabled?: boolean
  onOpen: () => void
  onClear?: () => void
}) {
  return (
    <div className="fd-daterange-half" data-active={active} data-half={half}>
      <button
        type="button"
        className="absolute inset-0 rounded-none fd-focus-ring"
        aria-label={`${label}: ${value}`}
        aria-haspopup="dialog"
        aria-expanded={active}
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
}: {
  start?: string
  end?: string
  nights?: number
}) {
  if (!start) {
    return <span className="fd-cal-range text-muted-foreground">Elige la salida</span>
  }

  return (
    <div className="flex items-center gap-2.5">
      <span className="fd-cal-range">
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
