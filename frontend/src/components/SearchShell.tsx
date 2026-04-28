import { useMemo, useState, type FormEvent, type KeyboardEvent, type RefObject } from "react"
import { es } from "react-day-picker/locale"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
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

  const updateAdults = (nextAdults: number) => {
    const clampedAdults = Math.max(1, Math.min(nextAdults, 9))
    setAdults(clampedAdults)
    setInfants((current) => Math.min(current, clampedAdults))
  }

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

    if (loading) {
      return
    }

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
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ToggleGroup
            type="single"
            value={mode}
            onValueChange={(value) => {
              if (value) handleModeChange(value as SearchModeControl)
            }}
          >
            <ToggleGroupItem value="exact" aria-label="Modo exacto">
              Exacto
            </ToggleGroupItem>
            <ToggleGroupItem value="flexible" aria-label="Modo flexible">
              Flexible
            </ToggleGroupItem>
            <ToggleGroupItem value="migration" aria-label="Modo migratorio">
              <AppIcon name="migration" />
              Migratorio
            </ToggleGroupItem>
          </ToggleGroup>

          {mode === "flexible" && (
            <div className="fd-inline-enter min-w-0">
              <FlexibleOptionsBar
                expandWindow={expandFlexibleWindow}
                onExpandWindowChange={setExpandFlexibleWindow}
                stayNights={stayNights}
                onStayNightsChange={setStayNights}
                showStayNights={trip === "round-trip"}
              />
            </div>
          )}

          {mode !== "migration" && (
            <ToggleGroup
              type="single"
              value={trip}
              onValueChange={(value) => {
                if (value) handleTripChange(value as "round-trip" | "one-way")
              }}
            >
              {tripTabs.map((item) => (
                <ToggleGroupItem key={item.key} value={item.key} aria-label={item.label}>
                  <AppIcon name={item.icon} />
                  {item.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}
        </div>
      </div>

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
            <Button
              type="button"
              variant="secondary"
              size="icon"
              onClick={swapRoute}
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              aria-label="Intercambiar ruta"
            >
              <AppIcon name="swap" />
            </Button>
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

          <Popover open={paxOpen} onOpenChange={setPaxOpen}>
            <div className="relative">
              <label className="fd-label absolute left-3 top-2 z-10">Pasajeros</label>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  aria-label="Seleccionar pasajeros"
                  aria-expanded={paxOpen}
                  aria-haspopup="dialog"
                  className="fd-control flex h-[52px] w-full justify-start gap-2 px-3 pt-4 text-left hover:bg-accent/60"
                >
                  <AppIcon name="passengers" className="text-muted-foreground" />
                  <span className="min-w-0 flex-1 text-sm font-semibold leading-none">
                    {passengerTotal} pasajero{passengerTotal > 1 ? "s" : ""}
                  </span>
                  <AppIcon name="chevronDown" className={`text-muted-foreground transition-transform ${paxOpen ? "rotate-180" : ""}`} />
                </Button>
              </PopoverTrigger>

              <PopoverContent align="end" className="w-72">
                <PaxRow label="Adultos" detail="12+ años" value={adults} onInc={() => updateAdults(adults + 1)} onDec={() => updateAdults(adults - 1)} decDisabled={adults <= 1} incDisabled={adults >= 9} />
                <PaxRow label="Niños" detail="2-11 años" value={children} onInc={() => setChildren((v) => Math.min(v + 1, 8))} onDec={() => setChildren((v) => Math.max(v - 1, 0))} decDisabled={children <= 0} incDisabled={children >= 8} />
                <PaxRow label="Bebés" detail="Menos de 2 años" value={infants} onInc={() => setInfants((v) => Math.min(v + 1, adults))} onDec={() => setInfants((v) => Math.max(v - 1, 0))} decDisabled={infants <= 0} incDisabled={infants >= adults} />
              </PopoverContent>
            </div>
          </Popover>

          <Button
            type="submit"
            disabled={loading}
            className="h-[52px] rounded-lg text-sm"
          >
            {loading ? <AppIcon name="loading" spin /> : <AppIcon name="search" />}
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
      <div
        className={cn(
          "fd-control flex h-[52px] w-full items-center gap-2 px-3 pt-4",
          invalid && "fd-control-invalid",
          roundedClass,
        )}
      >
        {icon && (
          <AppIcon name={icon} className="pointer-events-none text-muted-foreground" />
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
          className="min-w-0 flex-1 bg-transparent text-sm font-semibold leading-none text-foreground outline-none placeholder:text-muted-foreground/60"
        />
      </div>
      {open && suggestions.length > 0 && (
        <div id={listboxId} role="listbox" className="fd-popover-enter fd-scrollbar absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg">
          {suggestions.map((suggestion, index) => (
            <Button
              id={`${listboxId}-${index}`}
              key={`${suggestion.code}-${index}`}
              type="button"
              variant="ghost"
              role="option"
              aria-selected={index === activeIndex}
              onMouseDown={() => onSelect(suggestion)}
              className={`h-auto w-full justify-start rounded-lg px-3 py-2 text-left text-sm font-normal ${
                index === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-muted"
              }`}
            >
              <div className="font-bold">{suggestion.code}</div>
              <div className="truncate text-xs text-muted-foreground">{suggestion.label}</div>
            </Button>
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
  const fieldId = `date-${toDomId(label)}`
  const selectedLabel = value ? formatDateLabel(value) : "Seleccionar"
  const selectedDate = value ? isoToLocalDate(value) : undefined
  const minSelectableDate = isoToLocalDate(minDate)
  const maxSelectableDate = maxDate ? isoToLocalDate(maxDate) : undefined
  const disabledDays = maxSelectableDate
    ? [{ before: minSelectableDate }, { after: maxSelectableDate }]
    : [{ before: minSelectableDate }]

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) onTouch?.()
        setOpen(nextOpen)
      }}
    >
      <div className="relative">
        <label id={`${fieldId}-label`} className="fd-label absolute left-3 top-2 z-10">{label}</label>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            aria-labelledby={`${fieldId}-label`}
            aria-expanded={open}
            aria-invalid={invalid}
            className={cn(
              "fd-control flex h-[52px] w-full justify-start gap-2 px-3 pt-4 text-left hover:bg-accent/60",
              invalid && "fd-control-invalid",
            )}
          >
            <AppIcon name="calendar" className="text-muted-foreground" />
            <span className={`min-w-0 flex-1 truncate text-sm font-semibold leading-none ${value ? "text-foreground" : "text-muted-foreground"}`}>
              {selectedLabel}
            </span>
          </Button>
        </PopoverTrigger>

        <PopoverContent
          align="start"
          className="w-[min(20rem,calc(100vw-2rem))]"
          aria-label={`Calendario de ${label.toLowerCase()}`}
        >
          <Calendar
            mode="single"
            locale={es}
            weekStartsOn={1}
            fixedWeeks
            selected={selectedDate}
            defaultMonth={selectedDate ?? minSelectableDate}
            startMonth={minSelectableDate}
            endMonth={maxSelectableDate}
            disabled={disabledDays}
            onSelect={(date) => {
              if (!date) return
              onChange(localDateToIso(date))
              setOpen(false)
            }}
          />
        </PopoverContent>
      </div>
    </Popover>
  )
}

function isoToLocalDate(value: string) {
  const [year, month, day] = value.split("-").map(Number)
  return new Date(year, month - 1, day)
}

function localDateToIso(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
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
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Button
        type="button"
        variant="outline"
        aria-pressed={expandWindow}
        onClick={() => onExpandWindowChange(!expandWindow)}
        className={`h-8 px-2.5 text-xs ${
          expandWindow
            ? "fd-selected-passive"
            : "border-input bg-secondary text-muted-foreground hover:text-foreground"
        }`}
      >
        <AppIcon name="calendar" />
        ±4 días
      </Button>

      {showStayNights && (
        <div
          role="group"
          aria-labelledby="flexible-stay-nights-label"
          className="inline-flex h-8 items-center rounded-lg border border-input bg-secondary p-0.5"
        >
          <span id="flexible-stay-nights-label" className="px-2 text-xs font-semibold text-muted-foreground">
            Estadía
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Quitar noche"
            onClick={() => onStayNightsChange(Math.max(1, stayNights - 1))}
            disabled={stayNights <= 1}
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
          >
            <AppIcon name="minus" />
          </Button>
          <span className="min-w-14 px-1 text-center text-xs font-semibold text-foreground">
            {stayNights} noche{stayNights === 1 ? "" : "s"}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Agregar noche"
            onClick={() => onStayNightsChange(Math.min(45, stayNights + 1))}
            disabled={stayNights >= 45}
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
          >
            <AppIcon name="plus" />
          </Button>
        </div>
      )}
    </div>
  )
}

function PaxRow({
  label,
  detail,
  value,
  onInc,
  onDec,
  incDisabled = false,
  decDisabled = false,
}: {
  label: string
  detail: string
  value: number
  onInc: () => void
  onDec: () => void
  incDisabled?: boolean
  decDisabled?: boolean
}) {
  return (
    <div className="flex items-center justify-between rounded-lg px-2 py-2 transition-colors duration-150 hover:bg-muted">
      <div>
        <div className="text-sm font-semibold">{label}</div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="icon" onClick={onDec} disabled={decDisabled} aria-label={`Quitar ${label.toLowerCase()}`} className="fd-control h-8 w-8">
          <AppIcon name="minus" />
        </Button>
        <span className="w-6 text-center font-mono text-sm font-bold">{value}</span>
        <Button type="button" variant="outline" size="icon" onClick={onInc} disabled={incDisabled} aria-label={`Agregar ${label.toLowerCase()}`} className="fd-control h-8 w-8">
          <AppIcon name="plus" />
        </Button>
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
