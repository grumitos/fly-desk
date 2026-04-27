import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react"
import { Button } from "@/components/ui/button"
import { AppIcon, type AppIconName } from "@/components/ui/app-icon"
import { useAutocomplete } from "@/hooks/useAutocomplete"
import { cn } from "@/lib/utils"
import type { LocationSuggestion, SearchRequest, SortMode } from "@/types"

const DATE_LABEL_FORMATTER = new Intl.DateTimeFormat("es-PE", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
})

const MONTH_LABEL_FORMATTER = new Intl.DateTimeFormat("es-PE", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
})

const WEEKDAY_LABELS = ["L", "M", "M", "J", "V", "S", "D"]
type SearchModeControl = "exact" | "flexible" | "migration"

interface SearchShellProps {
  onSearch: (req: SearchRequest, sort?: SortMode) => void
  loading: boolean
}

export function SearchShell({ onSearch, loading }: SearchShellProps) {
  const [mode, setMode] = useState<SearchModeControl>("exact")
  const [trip, setTrip] = useState<"round-trip" | "one-way">("round-trip")
  const [originCode, setOriginCode] = useState("")
  const [destCode, setDestCode] = useState("")
  const [departureDate, setDepartureDate] = useState("")
  const [returnDate, setReturnDate] = useState("")
  const [stayNights, setStayNights] = useState(7)
  const [expandFlexibleWindow, setExpandFlexibleWindow] = useState(true)
  const [adults, setAdults] = useState(1)
  const [children, setChildren] = useState(0)
  const [infants, setInfants] = useState(0)
  const [paxOpen, setPaxOpen] = useState(false)
  const [touched, setTouched] = useState<Record<"origin" | "destination" | "departureDate" | "returnDate", boolean>>({
    origin: false,
    destination: false,
    departureDate: false,
    returnDate: false,
  })
  const datePolicy = useMemo(() => getRuntimeSearchDatePolicy(), [])
  const returnMinDate = maxIsoDate(datePolicy.minSearchDate, departureDate || datePolicy.minSearchDate)
  const departureLabel = mode === "flexible" ? "Salida desde" : "Salida"
  const endDateLabel = mode === "flexible" ? "Salida hasta" : "Regreso"
  const searchGridClassName = cn(
    "grid grid-cols-1 gap-1.5",
    mode === "migration"
      ? "lg:grid-cols-[minmax(180px,1.2fr)_34px_minmax(180px,1.2fr)_minmax(144px,.9fr)_124px]"
      : "lg:grid-cols-[minmax(150px,1.2fr)_34px_minmax(150px,1.2fr)_minmax(128px,.85fr)_minmax(128px,.85fr)_minmax(144px,.9fr)_124px]",
  )

  const origin = useAutocomplete("origin", (suggestion) => setOriginCode(suggestion.code))
  const destination = useAutocomplete("destination", (suggestion) => setDestCode(suggestion.code))
  const paxRef = useRef<HTMLDivElement>(null)

  const handleDepartureDateChange = (nextDate: string) => {
    const clampedDate = clampIsoDate(nextDate, datePolicy.minSearchDate, datePolicy.maxSearchDate)
    setDepartureDate(clampedDate)
    setReturnDate((current) => current && current < clampedDate ? clampedDate : current)
  }

  const handleReturnDateChange = (nextDate: string) => {
    setReturnDate(clampIsoDate(nextDate, returnMinDate, datePolicy.maxSearchDate))
  }

  const handleTripChange = (nextTrip: "round-trip" | "one-way") => {
    setTrip(nextTrip)
    if (nextTrip === "round-trip" && returnDate && returnDate < returnMinDate) {
      setReturnDate(returnMinDate)
    }
  }

  const handleModeChange = (nextMode: SearchModeControl) => {
    setMode(nextMode)
    setTouched((current) => ({
      ...current,
      departureDate: false,
      returnDate: false,
    }))
  }

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (paxRef.current && !paxRef.current.contains(e.target as Node)) setPaxOpen(false)
    }
    document.addEventListener("mousedown", onDocClick)
    return () => document.removeEventListener("mousedown", onDocClick)
  }, [])

  const swapRoute = () => {
    setOriginCode(destCode)
    setDestCode(originCode)
    origin.setQuery(destination.query)
    destination.setQuery(origin.query)
  }

  const validation = buildSearchValidation({
    originValue: origin.query,
    destinationValue: destination.query,
    departureDate,
    returnDate,
    trip,
    mode,
    minDepartureDate: datePolicy.minSearchDate,
    maxDate: datePolicy.maxSearchDate,
    minReturnDate: returnMinDate,
  })

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setTouched({
      origin: true,
      destination: true,
      departureDate: mode !== "migration",
      returnDate: mode !== "migration" && (trip === "round-trip" || mode === "flexible"),
    })

    if (hasBlockingValidationError(validation)) {
      return
    }

    const [resolvedOrigin, resolvedDestination] = await Promise.all([
      origin.resolveCurrentQuery(),
      destination.resolveCurrentQuery(),
    ])
    const resolvedRequest = {
      origin: (resolvedOrigin?.code ?? originCode).toUpperCase().trim(),
      destination: (resolvedDestination?.code ?? destCode).toUpperCase().trim(),
    }
    const resolvedValidation = buildSearchValidation({
      originValue: resolvedRequest.origin,
      destinationValue: resolvedRequest.destination,
      departureDate,
      returnDate,
      trip,
      mode,
      minDepartureDate: datePolicy.minSearchDate,
      maxDate: datePolicy.maxSearchDate,
      minReturnDate: returnMinDate,
    })
    if (hasBlockingValidationError(resolvedValidation)) {
      return
    }

    const flexiblePaddingDays = mode === "flexible" && expandFlexibleWindow ? 4 : 0
    const flexibleDepartureStart = mode === "migration"
      ? datePolicy.minSearchDate
      : mode === "flexible"
      ? clampIsoDate(addDays(departureDate, -flexiblePaddingDays), datePolicy.minSearchDate, datePolicy.maxSearchDate)
      : undefined
    const flexibleDepartureEnd = mode === "flexible"
      ? clampIsoDate(addDays(returnDate, flexiblePaddingDays), datePolicy.minSearchDate, datePolicy.maxSearchDate)
      : undefined
    const request: SearchRequest = {
      origin: resolvedRequest.origin,
      destination: resolvedRequest.destination,
      departureDate: mode === "exact" ? departureDate || undefined : undefined,
      departureStart: flexibleDepartureStart,
      departureEnd: flexibleDepartureEnd,
      returnDate: mode === "exact" && trip === "round-trip" ? returnDate || undefined : undefined,
      tripType: mode === "migration" ? "one-way" : trip,
      adults,
      children,
      infants,
      searchMode: mode === "migration"
        ? "month-view"
        : mode === "flexible"
          ? trip === "round-trip" ? "roundtrip-grid" : "stay-range"
          : "exact",
      flexibleMode: mode === "flexible" && trip === "round-trip" ? "exact-stay" : undefined,
      stayNights: mode === "flexible" && trip === "round-trip" ? stayNights : undefined,
    }
    onSearch(request)
  }

  const passengerTotal = adults + children + infants
  const tripTabs: { key: typeof trip; label: string; icon: AppIconName }[] = [
    { key: "round-trip", label: "Ida y vuelta", icon: "roundTrip" },
    { key: "one-way", label: "Solo ida", icon: "oneWay" },
  ]

  return (
    <section className="fd-panel overflow-visible p-2" aria-busy={loading}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl>
            <SegmentButton active={mode === "exact"} onClick={() => handleModeChange("exact")}>
              Exacto
            </SegmentButton>
            <SegmentButton active={mode === "flexible"} onClick={() => handleModeChange("flexible")}>
              Flexible
            </SegmentButton>
            <SegmentButton active={mode === "migration"} onClick={() => handleModeChange("migration")}>
              <AppIcon name="migration" />
              Migratorio
            </SegmentButton>
          </SegmentedControl>

          {mode !== "migration" && (
            <SegmentedControl>
              {tripTabs.map((item) => (
                <SegmentButton key={item.key} active={trip === item.key} onClick={() => handleTripChange(item.key)}>
                  <AppIcon name={item.icon} />
                  {item.label}
                </SegmentButton>
              ))}
            </SegmentedControl>
          )}
        </div>
      </div>

      {mode === "flexible" && (
        <FlexibleOptionsBar
          expandWindow={expandFlexibleWindow}
          onExpandWindowChange={setExpandFlexibleWindow}
          stayNights={stayNights}
          onStayNightsChange={setStayNights}
          showStayNights={trip === "round-trip"}
        />
      )}

      <form onSubmit={handleSubmit}>
        <div className={searchGridClassName}>
          <LocationField
            label="Origen"
            value={origin.query}
            inputRef={origin.inputRef}
            suggestions={origin.suggestions}
            open={origin.open}
            activeIndex={origin.activeIndex}
            placeholder="Ciudad o IATA"
            icon="location"
            roundedClass="lg:rounded-l-lg"
            onFocus={() => origin.setOpen(true)}
            onBlur={() => {
              setTouched((current) => ({ ...current, origin: true }))
              return origin.resolveCurrentQuery()
            }}
            onKeyDown={origin.onKeyDown}
            onChange={(value) => {
              origin.setQuery(value)
              setOriginCode(value)
              origin.setOpen(true)
              setTouched((current) => ({ ...current, origin: true }))
            }}
            onSelect={(suggestion) => {
              origin.selectSuggestion(suggestion)
              setOriginCode(suggestion.code)
              setTouched((current) => ({ ...current, origin: true }))
            }}
            invalid={touched.origin && Boolean(validation.origin)}
          />

          <div className="hidden items-center justify-center lg:flex">
            <button
              type="button"
              onClick={swapRoute}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-secondary text-muted-foreground transition-[background-color,color,transform] duration-150 hover:bg-accent hover:text-foreground active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Intercambiar ruta"
            >
              <AppIcon name="swap" />
            </button>
          </div>

          <LocationField
            label="Destino"
            value={destination.query}
            inputRef={destination.inputRef}
            suggestions={destination.suggestions}
            open={destination.open}
            activeIndex={destination.activeIndex}
            placeholder="Ciudad o IATA"
            icon="location"
            onFocus={() => destination.setOpen(true)}
            onBlur={() => {
              setTouched((current) => ({ ...current, destination: true }))
              return destination.resolveCurrentQuery()
            }}
            onKeyDown={destination.onKeyDown}
            onChange={(value) => {
              destination.setQuery(value)
              setDestCode(value)
              destination.setOpen(true)
              setTouched((current) => ({ ...current, destination: true }))
            }}
            onSelect={(suggestion) => {
              destination.selectSuggestion(suggestion)
              setDestCode(suggestion.code)
              setTouched((current) => ({ ...current, destination: true }))
            }}
            invalid={touched.destination && Boolean(validation.destination)}
          />

          {mode !== "migration" && (
            <>
              <DateField
                label={departureLabel}
                value={departureDate}
                minDate={datePolicy.minSearchDate}
                maxDate={datePolicy.maxSearchDate}
                onChange={(value) => {
                  handleDepartureDateChange(value)
                  setTouched((current) => ({ ...current, departureDate: true }))
                }}
                invalid={touched.departureDate && Boolean(validation.departureDate)}
                onTouch={() => setTouched((current) => ({ ...current, departureDate: true }))}
              />
              {mode === "flexible" || trip === "round-trip" ? (
                <DateField
                  label={endDateLabel}
                  value={returnDate}
                  minDate={returnMinDate}
                  maxDate={datePolicy.maxSearchDate}
                  onChange={(value) => {
                    handleReturnDateChange(value)
                    setTouched((current) => ({ ...current, returnDate: true }))
                  }}
                  invalid={touched.returnDate && Boolean(validation.returnDate)}
                  onTouch={() => setTouched((current) => ({ ...current, returnDate: true }))}
                />
              ) : (
                <div className="hidden lg:block" />
              )}
            </>
          )}

          <div className="relative" ref={paxRef}>
            <label className="fd-label absolute left-3 top-2 z-10">Pasajeros</label>
            <button
              type="button"
              aria-label="Seleccionar pasajeros"
              onClick={() => setPaxOpen((value) => !value)}
              className="fd-control flex h-[52px] w-full items-center gap-2 px-3 pt-4 text-left"
            >
              <AppIcon name="passengers" className="text-muted-foreground" />
              <span className="min-w-0 flex-1 text-sm font-semibold leading-none">
                {passengerTotal} pasajero{passengerTotal > 1 ? "s" : ""}
              </span>
              <AppIcon name="chevronDown" className={`text-muted-foreground transition-transform ${paxOpen ? "rotate-180" : ""}`} />
            </button>

            {paxOpen && (
              <div className="absolute right-0 z-50 mt-1 w-72 rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-lg">
                <PaxRow label="Adultos" detail="12+ años" value={adults} onInc={() => setAdults((v) => Math.min(v + 1, 9))} onDec={() => setAdults((v) => Math.max(v - 1, 1))} />
                <PaxRow label="Niños" detail="2-11 años" value={children} onInc={() => setChildren((v) => Math.min(v + 1, 8))} onDec={() => setChildren((v) => Math.max(v - 1, 0))} />
                <PaxRow label="Bebés" detail="Menos de 2 años" value={infants} onInc={() => setInfants((v) => Math.min(v + 1, adults))} onDec={() => setInfants((v) => Math.max(v - 1, 0))} />
              </div>
            )}
          </div>

          <Button
            type="submit"
            disabled={loading}
            className="h-[52px] rounded-lg text-sm"
          >
            <AppIcon name="search" />
            {loading ? "Buscando" : "Buscar"}
          </Button>
        </div>
      </form>

    </section>
  )
}

function LocationField({
  label,
  value,
  inputRef,
  suggestions,
  open,
  activeIndex,
  placeholder,
  icon,
  roundedClass = "",
  onFocus,
  onBlur,
  onKeyDown,
  onChange,
  onSelect,
  invalid = false,
}: {
  label: string
  value: string
  inputRef: RefObject<HTMLInputElement | null>
  suggestions: LocationSuggestion[]
  open: boolean
  activeIndex: number
  placeholder: string
  icon?: AppIconName
  roundedClass?: string
  onFocus: () => void
  onBlur: () => void | Promise<unknown>
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  onChange: (value: string) => void
  onSelect: (suggestion: LocationSuggestion) => void
  invalid?: boolean
}) {
  const fieldId = `location-${label.toLowerCase()}`
  const listboxId = `${fieldId}-suggestions`
  const activeOptionId = activeIndex >= 0 && suggestions[activeIndex]
    ? `${listboxId}-${activeIndex}`
    : undefined

  return (
    <div className="relative">
      <label htmlFor={fieldId} className="fd-label absolute left-3 top-2 z-10">{label}</label>
      {icon && (
        <AppIcon name={icon} className="pointer-events-none absolute left-3 top-[35px] z-10 -translate-y-1/2 text-muted-foreground" />
      )}
      <input
        id={fieldId}
        ref={inputRef}
        aria-label={label}
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={open && suggestions.length > 0}
        aria-activedescendant={activeOptionId}
        aria-invalid={invalid}
        autoComplete="off"
        name={fieldId}
        role="combobox"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={onFocus}
        onBlur={() => {
          void onBlur()
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className={cn(
          "fd-control h-[52px] w-full px-3 pb-2 pt-5 text-sm font-semibold placeholder:text-muted-foreground/60",
          icon && "pl-9",
          invalid && "fd-control-invalid",
          roundedClass,
        )}
      />
      {open && suggestions.length > 0 && (
        <div id={listboxId} role="listbox" className="fd-scrollbar absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg">
          {suggestions.map((suggestion, index) => (
            <button
              id={`${listboxId}-${index}`}
              key={`${suggestion.code}-${index}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              onMouseDown={() => onSelect(suggestion)}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                index === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-muted"
              }`}
            >
              <div className="font-bold">{suggestion.code}</div>
              <div className="truncate text-xs text-muted-foreground">{suggestion.label}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function DateField({
  label,
  value,
  minDate,
  maxDate,
  onChange,
  invalid = false,
  onTouch,
}: {
  label: string
  value: string
  minDate: string
  maxDate?: string
  onChange: (value: string) => void
  invalid?: boolean
  onTouch?: () => void
}) {
  const [open, setOpen] = useState(false)
  const fieldRef = useRef<HTMLDivElement>(null)
  const initialVisibleMonth = normalizeMonth(value || minDate)
  const [visibleMonth, setVisibleMonth] = useState(initialVisibleMonth)

  useEffect(() => {
    function onDocClick(event: MouseEvent) {
      if (fieldRef.current && !fieldRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener("mousedown", onDocClick)
    return () => document.removeEventListener("mousedown", onDocClick)
  }, [])

  const fieldId = `date-${toDomId(label)}`
  const selectedLabel = value ? formatDateLabel(value) : "Seleccionar"
  const days = getCalendarDays(visibleMonth)
  const previousMonth = addMonths(visibleMonth, -1)
  const nextMonth = addMonths(visibleMonth, 1)
  const canGoPrevious = monthEndIso(previousMonth) >= minDate
  const canGoNext = maxDate ? monthStartIso(nextMonth) <= maxDate : true

  return (
    <div ref={fieldRef} className="relative">
      <label id={`${fieldId}-label`} className="fd-label absolute left-3 top-2 z-10">{label}</label>
      <button
        type="button"
        aria-labelledby={`${fieldId}-label`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-invalid={invalid}
        onClick={() => {
          onTouch?.()
          setVisibleMonth(normalizeMonth(value || minDate))
          setOpen((current) => !current)
        }}
        className={cn(
          "fd-control flex h-[52px] w-full items-center gap-2 px-3 pt-4 text-left",
          invalid && "fd-control-invalid",
        )}
      >
        <AppIcon name="calendar" className="text-muted-foreground" />
        <span className={`min-w-0 flex-1 truncate text-sm font-semibold leading-none ${value ? "text-foreground" : "text-muted-foreground"}`}>
          {selectedLabel}
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={`Calendario de ${label.toLowerCase()}`}
          className="absolute left-0 z-50 mt-1 w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <button
              type="button"
              aria-label="Mes anterior"
              disabled={!canGoPrevious}
              onClick={() => setVisibleMonth(previousMonth)}
              className="fd-control inline-flex h-8 w-8 items-center justify-center"
            >
              <AppIcon name="chevronLeft" />
            </button>
            <div className="min-w-0 flex-1 text-center text-sm font-bold capitalize">
              {formatMonthLabel(visibleMonth)}
            </div>
            <button
              type="button"
              aria-label="Mes siguiente"
              disabled={!canGoNext}
              onClick={() => setVisibleMonth(nextMonth)}
              className="fd-control inline-flex h-8 w-8 items-center justify-center"
            >
              <AppIcon name="chevronRight" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1 text-center">
            {WEEKDAY_LABELS.map((day, index) => (
              <div key={`${day}-${index}`} className="fd-label flex h-7 items-center justify-center">
                {day}
              </div>
            ))}
            {days.map((day) => {
              const disabled = day.iso < minDate || Boolean(maxDate && day.iso > maxDate)
              const selected = day.iso === value

              return (
                <button
                  key={day.iso}
                  type="button"
                  disabled={disabled}
                  aria-pressed={selected}
                  aria-label={formatDateLabel(day.iso)}
                  onClick={() => {
                    onChange(day.iso)
                    setOpen(false)
                  }}
                  className={`inline-flex h-9 items-center justify-center rounded-lg text-sm font-semibold transition-[background-color,border-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    selected
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : day.inMonth
                        ? "text-foreground hover:bg-accent hover:text-accent-foreground"
                        : "text-muted-foreground/55 hover:bg-accent hover:text-accent-foreground"
                  } disabled:pointer-events-none disabled:text-muted-foreground/35 disabled:line-through`}
                >
                  {day.dayOfMonth}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function FlexibleOptionsBar({
  expandWindow,
  onExpandWindowChange,
  stayNights,
  onStayNightsChange,
  showStayNights,
}: {
  expandWindow: boolean
  onExpandWindowChange: (value: boolean) => void
  stayNights: number
  onStayNightsChange: (value: number) => void
  showStayNights: boolean
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 px-1">
      <button
        type="button"
        aria-pressed={expandWindow}
        onClick={() => onExpandWindowChange(!expandWindow)}
        className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition-[background-color,border-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          expandWindow
            ? "border-primary/45 bg-primary/10 text-primary"
            : "border-input bg-secondary text-muted-foreground hover:text-foreground"
        }`}
      >
        <AppIcon name="calendar" />
        ±4 días
      </button>

      {showStayNights && (
        <div
          role="group"
          aria-labelledby="flexible-stay-nights-label"
          className="inline-flex h-8 items-center rounded-lg border border-input bg-secondary p-0.5"
        >
          <span id="flexible-stay-nights-label" className="px-2 text-xs font-semibold text-muted-foreground">
            Estadía
          </span>
          <button
            type="button"
            aria-label="Quitar noche"
            onClick={() => onStayNightsChange(Math.max(1, stayNights - 1))}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <AppIcon name="minus" />
          </button>
          <span className="min-w-14 px-1 text-center text-xs font-semibold text-foreground">
            {stayNights} noche{stayNights === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            aria-label="Agregar noche"
            onClick={() => onStayNightsChange(Math.min(45, stayNights + 1))}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <AppIcon name="plus" />
          </button>
        </div>
      )}
    </div>
  )
}

function SegmentedControl({ children }: { children: ReactNode }) {
  return (
    <div className="inline-flex min-h-8 items-center rounded-lg border border-input bg-secondary p-0.5">
      {children}
    </div>
  )
}

function SegmentButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      disabled={disabled}
      className={`inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-semibold transition-[background-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground"
      }`}
    >
      {children}
    </button>
  )
}

function PaxRow({
  label,
  detail,
  value,
  onInc,
  onDec,
}: {
  label: string
  detail: string
  value: number
  onInc: () => void
  onDec: () => void
}) {
  return (
    <div className="flex items-center justify-between rounded-lg px-2 py-2 transition-colors duration-150 hover:bg-muted">
      <div>
        <div className="text-sm font-semibold">{label}</div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onDec} aria-label={`Quitar ${label.toLowerCase()}`} className="fd-control inline-flex h-8 w-8 items-center justify-center">
          <AppIcon name="minus" />
        </button>
        <span className="w-6 text-center font-mono text-sm font-bold">{value}</span>
        <button type="button" onClick={onInc} aria-label={`Agregar ${label.toLowerCase()}`} className="fd-control inline-flex h-8 w-8 items-center justify-center">
          <AppIcon name="plus" />
        </button>
      </div>
    </div>
  )
}

interface RuntimeSearchDatePolicy {
  minSearchDate: string
  maxSearchDate?: string
  maxFutureDays?: number
}

declare global {
  interface Window {
    __FLYDESK_RUNTIME__?: {
      searchDatePolicy?: RuntimeSearchDatePolicy
    }
  }
}

function getRuntimeSearchDatePolicy(): RuntimeSearchDatePolicy {
  const configured = window.__FLYDESK_RUNTIME__?.searchDatePolicy
  const minSearchDate = isIsoDate(configured?.minSearchDate) ? configured.minSearchDate : todayIso()
  const maxSearchDate = isIsoDate(configured?.maxSearchDate)
    ? configured.maxSearchDate
    : addDays(minSearchDate, configured?.maxFutureDays ?? 365)

  return { minSearchDate, maxSearchDate, maxFutureDays: configured?.maxFutureDays }
}

function todayIso() {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function maxIsoDate(left: string, right: string) {
  return left > right ? left : right
}

interface SearchValidationInput {
  originValue: string
  destinationValue: string
  departureDate: string
  returnDate: string
  trip: "round-trip" | "one-way"
  mode: SearchModeControl
  minDepartureDate: string
  minReturnDate: string
  maxDate?: string
}

interface SearchValidationState {
  origin?: string
  destination?: string
  departureDate?: string
  returnDate?: string
}

function buildSearchValidation(input: SearchValidationInput): SearchValidationState {
  const origin = normalizeLocationCandidate(input.originValue)
  const destination = normalizeLocationCandidate(input.destinationValue)
  const state: SearchValidationState = {}

  if (!isValidLocationCandidate(origin)) {
    state.origin = "Ingresa un origen válido."
  }

  if (!isValidLocationCandidate(destination)) {
    state.destination = "Ingresa un destino válido."
  } else if (isValidLocationCandidate(origin) && origin === destination) {
    state.destination = "El destino debe ser diferente al origen."
  }

  if (input.mode === "migration") {
    return state
  }

  if (!input.departureDate) {
    state.departureDate = input.mode === "flexible"
      ? "Selecciona el inicio del rango."
      : "Selecciona una fecha de salida."
  } else if (input.departureDate < input.minDepartureDate) {
    state.departureDate = `Debe ser igual o posterior a ${formatDateLabel(input.minDepartureDate)}.`
  } else if (input.maxDate && input.departureDate > input.maxDate) {
    state.departureDate = `Debe ser igual o anterior a ${formatDateLabel(input.maxDate)}.`
  }

  if (input.mode === "flexible") {
    if (!input.returnDate) {
      state.returnDate = "Selecciona el fin del rango."
    } else if (input.departureDate && input.returnDate < input.departureDate) {
      state.returnDate = "El fin debe ser igual o posterior al inicio."
    } else if (input.returnDate < input.minReturnDate) {
      state.returnDate = `Debe ser igual o posterior a ${formatDateLabel(input.minReturnDate)}.`
    } else if (input.maxDate && input.returnDate > input.maxDate) {
      state.returnDate = `Debe ser igual o anterior a ${formatDateLabel(input.maxDate)}.`
    }
  } else if (input.trip === "round-trip") {
    if (!input.returnDate) {
      state.returnDate = "Selecciona una fecha de regreso."
    } else if (input.returnDate < input.minReturnDate) {
      state.returnDate = `Debe ser igual o posterior a ${formatDateLabel(input.minReturnDate)}.`
    } else if (input.maxDate && input.returnDate > input.maxDate) {
      state.returnDate = `Debe ser igual o anterior a ${formatDateLabel(input.maxDate)}.`
    }
  }

  return state
}

function hasBlockingValidationError(state: SearchValidationState) {
  return Boolean(state.origin || state.destination || state.departureDate || state.returnDate)
}

function normalizeLocationCandidate(value: string) {
  return value.trim().toUpperCase()
}

function toDomId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

function isValidLocationCandidate(value: string) {
  return /^[A-Z]{3}/.test(value)
}

function clampIsoDate(value: string, minDate: string, maxDate?: string) {
  if (value < minDate) return minDate
  if (maxDate && value > maxDate) return maxDate
  return value
}

function formatDateLabel(value: string) {
  return DATE_LABEL_FORMATTER.format(new Date(`${value}T00:00:00Z`)).replace(".", "")
}

function formatMonthLabel(value: string) {
  return MONTH_LABEL_FORMATTER.format(new Date(`${value}-01T00:00:00Z`))
}

function normalizeMonth(value: string) {
  return isIsoDate(value) ? value.slice(0, 7) : todayIso().slice(0, 7)
}

function addMonths(monthValue: string, delta: number) {
  const [year, month] = monthValue.split("-").map(Number)
  const date = new Date(Date.UTC(year, month - 1 + delta, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`
}

function monthStartIso(monthValue: string) {
  return `${monthValue}-01`
}

function monthEndIso(monthValue: string) {
  const [year, month] = monthValue.split("-").map(Number)
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}

function getCalendarDays(monthValue: string) {
  const [year, month] = monthValue.split("-").map(Number)
  const firstDate = new Date(Date.UTC(year, month - 1, 1))
  const startOffset = (firstDate.getUTCDay() + 6) % 7
  const startDate = new Date(firstDate)
  startDate.setUTCDate(firstDate.getUTCDate() - startOffset)

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(startDate)
    date.setUTCDate(startDate.getUTCDate() + index)
    const iso = date.toISOString().slice(0, 10)

    return {
      iso,
      dayOfMonth: date.getUTCDate(),
      inMonth: date.getUTCMonth() === month - 1,
    }
  })
}
