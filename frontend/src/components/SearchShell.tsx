import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type RefObject } from "react"
import { createPortal } from "react-dom"
import { es } from "react-day-picker/locale"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SegmentButton, SegmentedControl } from "@/components/ui/segmented-control"
import { TOPBAR_SEARCH_CONTROLS_ID } from "@/components/TopBar"
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
const SEARCH_FIELD_CONTROL_CLASS = "fd-control flex h-[52px] w-full items-center gap-2 px-3 pt-4"
const SEARCH_FIELD_VALUE_CLASS = "min-w-0 flex-1 truncate text-sm font-semibold leading-none"

type SearchModeControl = "exact" | "flexible" | "migration"

interface SearchShellProps {
  onSearch: (req: SearchRequest, sort?: SortMode) => void
  loading: boolean
  controlsPlacement?: "inline" | "topbar"
  syncedRequest?: SearchRequest | null
}

export function SearchShell({ onSearch, loading, controlsPlacement = "inline", syncedRequest = null }: SearchShellProps) {
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
  const dateFieldsDisabled = mode === "migration"
  const searchGridClassName = cn(
    "grid grid-cols-1 gap-1.5 transition-[grid-template-columns] duration-200 ease-out",
    "lg:grid-cols-[minmax(150px,1.2fr)_34px_minmax(150px,1.2fr)_minmax(128px,.85fr)_minmax(128px,.85fr)_minmax(144px,.9fr)_124px]",
  )

  const origin = useAutocomplete("origin", (suggestion) => setOriginCode(suggestion.code))
  const destination = useAutocomplete("destination", (suggestion) => setDestCode(suggestion.code))
  const setOriginQuery = origin.setQuery
  const setDestinationQuery = destination.setQuery
  const resolveOriginQuery = origin.resolveCurrentQuery
  const resolveDestinationQuery = destination.resolveCurrentQuery

  useEffect(() => {
    if (!syncedRequest) return

    const frame = window.requestAnimationFrame(() => {
      const nextMode = modeFromSearchRequest(syncedRequest)
      const nextTrip = syncedRequest.searchMode === "month-view" ? "one-way" : syncedRequest.tripType
      const nextOrigin = syncedRequest.origin.toUpperCase().trim()
      const nextDestination = syncedRequest.destination.toUpperCase().trim()

      setMode(nextMode)
      setTrip(nextTrip)
      setOriginCode(nextOrigin)
      setDestCode(nextDestination)
      setOriginQuery(nextOrigin)
      setDestinationQuery(nextDestination)
      setDepartureDate(dateStartFromSearchRequest(syncedRequest))
      setReturnDate(dateEndFromSearchRequest(syncedRequest))
      setStayNights(syncedRequest.stayNights ?? 7)
      if (syncedRequest.searchMode !== "exact") {
        setExpandFlexibleWindow(false)
      }
      setTouched({
        origin: false,
        destination: false,
        departureDate: false,
        returnDate: false,
      })
      void resolveOriginQuery()
      void resolveDestinationQuery()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [resolveDestinationQuery, resolveOriginQuery, setDestinationQuery, setOriginQuery, syncedRequest])

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
  const topbarControlsTarget = controlsPlacement === "topbar"
    ? document.getElementById(TOPBAR_SEARCH_CONTROLS_ID)
    : null
  const shouldPortalControls = Boolean(topbarControlsTarget)
  const searchControls = (
    <SearchModeControls
      mode={mode}
      trip={trip}
      tripTabs={tripTabs}
      expandFlexibleWindow={expandFlexibleWindow}
      stayNights={stayNights}
      onModeChange={handleModeChange}
      onTripChange={handleTripChange}
      onExpandFlexibleWindowChange={setExpandFlexibleWindow}
      onStayNightsChange={setStayNights}
      topbar={shouldPortalControls}
    />
  )

  return (
    <>
      {topbarControlsTarget ? createPortal(searchControls, topbarControlsTarget) : null}
      <section className="overflow-visible" aria-busy={loading}>
        {!shouldPortalControls && (
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            {searchControls}
          </div>
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
              onFocus={origin.openSuggestions}
              onBlur={() => {
                setTouched((current) => ({ ...current, origin: true }))
                return origin.resolveCurrentQuery()
              }}
              onKeyDown={origin.onKeyDown}
              onChange={(value) => {
                origin.setQuery(value, { showSuggestions: true })
                setOriginCode(value)
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
            onFocus={destination.openSuggestions}
            onBlur={() => {
              setTouched((current) => ({ ...current, destination: true }))
              return destination.resolveCurrentQuery()
            }}
            onKeyDown={destination.onKeyDown}
            onChange={(value) => {
              destination.setQuery(value, { showSuggestions: true })
              setDestCode(value)
              setTouched((current) => ({ ...current, destination: true }))
            }}
            onSelect={(suggestion) => {
              destination.selectSuggestion(suggestion)
              setDestCode(suggestion.code)
              setTouched((current) => ({ ...current, destination: true }))
            }}
            invalid={touched.destination && Boolean(validation.destination)}
          />

          <DateField
            label={departureLabel}
            value={departureDate}
            minDate={datePolicy.minSearchDate}
            maxDate={datePolicy.maxSearchDate}
            disabled={dateFieldsDisabled}
            disabledLabel="No aplica"
            onChange={(value) => {
              handleDepartureDateChange(value)
              setTouched((current) => ({ ...current, departureDate: true }))
            }}
            invalid={!dateFieldsDisabled && touched.departureDate && Boolean(validation.departureDate)}
            onTouch={() => setTouched((current) => ({ ...current, departureDate: true }))}
          />
          <DateField
            label={endDateLabel}
            value={returnDate}
            minDate={returnMinDate}
            maxDate={datePolicy.maxSearchDate}
            disabled={dateFieldsDisabled || (mode === "exact" && trip === "one-way")}
            disabledLabel="No aplica"
            onChange={(value) => {
              handleReturnDateChange(value)
              setTouched((current) => ({ ...current, returnDate: true }))
            }}
            invalid={!dateFieldsDisabled && (mode !== "exact" || trip !== "one-way") ? touched.returnDate && Boolean(validation.returnDate) : false}
            onTouch={() => setTouched((current) => ({ ...current, returnDate: true }))}
          />

          <Popover open={paxOpen} onOpenChange={setPaxOpen}>
            <div className="relative">
              <label className="fd-label absolute left-3 top-2 z-10">Pasajeros</label>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="Seleccionar pasajeros"
                  aria-expanded={paxOpen}
                  aria-haspopup="dialog"
                  className={`${SEARCH_FIELD_CONTROL_CLASS} justify-start text-left hover:bg-accent/60`}
                >
                  <AppIcon name="passengers" className="text-muted-foreground" />
                  <span className={SEARCH_FIELD_VALUE_CLASS}>
                    {passengerTotal} pasajero{passengerTotal > 1 ? "s" : ""}
                  </span>
                  <AppIcon name="chevronDown" className={`text-muted-foreground transition-transform ${paxOpen ? "rotate-180" : ""}`} />
                </button>
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
    </>
  )
}

function SearchModeControls({
  mode,
  trip,
  tripTabs,
  expandFlexibleWindow,
  stayNights,
  onModeChange,
  onTripChange,
  onExpandFlexibleWindowChange,
  onStayNightsChange,
  topbar,
}: {
  mode: SearchModeControl
  trip: "round-trip" | "one-way"
  tripTabs: { key: "round-trip" | "one-way"; label: string; icon: AppIconName }[]
  expandFlexibleWindow: boolean
  stayNights: number
  onModeChange: (mode: SearchModeControl) => void
  onTripChange: (trip: "round-trip" | "one-way") => void
  onExpandFlexibleWindowChange: (value: boolean) => void
  onStayNightsChange: (value: number) => void
  topbar: boolean
}) {
  const flexibleControlsActive = mode === "flexible"
  const tripControlsDisabled = mode === "migration"
  const displayedTrip = tripControlsDisabled ? "one-way" : trip

  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-2",
        topbar && "max-w-[calc(100vw-11rem)] justify-center",
      )}
    >
      <SegmentedControl>
        <SegmentButton active={mode === "exact"} onClick={() => onModeChange("exact")}>
          Exacto
        </SegmentButton>
        <SegmentButton active={mode === "flexible"} onClick={() => onModeChange("flexible")}>
          Flexible
        </SegmentButton>
        <SegmentButton active={mode === "migration"} onClick={() => onModeChange("migration")}>
          Migratorio
        </SegmentButton>
      </SegmentedControl>

      <div
        aria-hidden={!flexibleControlsActive}
        className={cn(
          "fd-inline-reveal min-w-0",
          flexibleControlsActive ? "fd-inline-reveal-open" : "fd-inline-reveal-closed",
        )}
      >
        <FlexibleOptionsBar
          expandWindow={expandFlexibleWindow}
          onExpandWindowChange={onExpandFlexibleWindowChange}
          stayNights={stayNights}
          onStayNightsChange={onStayNightsChange}
          disabled={!flexibleControlsActive}
          stayNightsDisabled={trip !== "round-trip"}
        />
      </div>

      <SegmentedControl disabled={tripControlsDisabled}>
        {tripTabs.map((item) => (
          <SegmentButton
            key={item.key}
            active={displayedTrip === item.key}
            disabled={tripControlsDisabled}
            onClick={() => onTripChange(item.key)}
          >
            <AppIcon name={item.icon} />
            {item.label}
          </SegmentButton>
        ))}
      </SegmentedControl>
    </div>
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
  const fieldRef = useRef<HTMLDivElement | null>(null)
  const [listboxStyle, setListboxStyle] = useState<CSSProperties | null>(null)
  const shouldShowListbox = open && suggestions.length > 0
  const listboxTarget = typeof document === "undefined" ? null : document.body

  useLayoutEffect(() => {
    if (!shouldShowListbox) return

    const updateListboxStyle = () => {
      const rect = fieldRef.current?.getBoundingClientRect()
      if (!rect) return

      setListboxStyle({
        left: rect.left,
        maxHeight: Math.max(96, Math.min(288, window.innerHeight - rect.bottom - 12)),
        position: "fixed",
        top: rect.bottom + 4,
        width: rect.width,
        zIndex: 90,
      })
    }

    const frame = window.requestAnimationFrame(updateListboxStyle)
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateListboxStyle)
    if (fieldRef.current) {
      resizeObserver?.observe(fieldRef.current)
    }
    window.addEventListener("resize", updateListboxStyle)
    window.addEventListener("scroll", updateListboxStyle, true)
    return () => {
      window.cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
      window.removeEventListener("resize", updateListboxStyle)
      window.removeEventListener("scroll", updateListboxStyle, true)
    }
  }, [shouldShowListbox, suggestions.length, value])

  return (
    <div ref={fieldRef} className="relative">
      <label htmlFor={fieldId} className="fd-label absolute left-3 top-2 z-10">{label}</label>
      <div
        className={cn(
          SEARCH_FIELD_CONTROL_CLASS,
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
          className={`${SEARCH_FIELD_VALUE_CLASS} bg-transparent text-foreground outline-none placeholder:text-muted-foreground/60`}
        />
      </div>
      {listboxTarget && shouldShowListbox && listboxStyle ? createPortal(
        <div
          id={listboxId}
          role="listbox"
          style={listboxStyle}
          className="fd-popover-enter fd-scrollbar overflow-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {suggestions.map((suggestion, index) => (
            <Button
              id={`${listboxId}-${index}`}
              key={`${suggestion.code}-${index}`}
              type="button"
              variant="ghost"
              role="option"
              aria-selected={index === activeIndex}
              onMouseDown={(event) => {
                event.preventDefault()
                onSelect(suggestion)
              }}
              className={`h-auto w-full justify-start rounded-lg px-3 py-2 text-left text-sm font-normal ${
                index === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-muted"
              }`}
            >
              <div className="font-bold">{suggestion.code}</div>
              <div className="truncate text-xs text-muted-foreground">{suggestionPlaceLabel(suggestion)}</div>
            </Button>
          ))}
        </div>,
        listboxTarget,
      ) : null}
    </div>
  )
}

function suggestionPlaceLabel(suggestion: LocationSuggestion): string {
  const normalizedCode = suggestion.code.trim().toUpperCase()
  const label = suggestion.label.trim()
  const codePrefix = `${normalizedCode} - `

  if (normalizedCode && label.toUpperCase().startsWith(codePrefix)) {
    return label.slice(codePrefix.length).trim()
  }

  return label || [suggestion.city, suggestion.country].filter(Boolean).join(", ")
}

function DateField({
  label,
  value,
  minDate,
  maxDate,
  disabled = false,
  disabledLabel = "No aplica",
  onChange,
  invalid = false,
  onTouch,
}: {
  label: string
  value: string
  minDate: string
  maxDate?: string
  disabled?: boolean
  disabledLabel?: string
  onChange: (value: string) => void
  invalid?: boolean
  onTouch?: () => void
}) {
  const [open, setOpen] = useState(false)
  const fieldId = `date-${toDomId(label)}`
  const selectedLabel = disabled ? disabledLabel : value ? formatDateLabel(value) : "Seleccionar"
  const selectedDate = value ? isoToLocalDate(value) : undefined
  const minSelectableDate = isoToLocalDate(minDate)
  const maxSelectableDate = maxDate ? isoToLocalDate(maxDate) : undefined
  const disabledDays = maxSelectableDate
    ? [{ before: minSelectableDate }, { after: maxSelectableDate }]
    : [{ before: minSelectableDate }]

  useEffect(() => {
    if (!disabled) return
    const frame = window.requestAnimationFrame(() => setOpen(false))
    return () => window.cancelAnimationFrame(frame)
  }, [disabled])

  return (
    <Popover
      open={disabled ? false : open}
      onOpenChange={(nextOpen) => {
        if (disabled) return
        if (nextOpen) onTouch?.()
        setOpen(nextOpen)
      }}
    >
      <div className={cn("relative transition-[opacity,filter,transform] duration-200 ease-out", disabled && "fd-disabled-section")}>
        <label id={`${fieldId}-label`} className="fd-label absolute left-3 top-2 z-10">
          <AnimatedDateLabel label={label} />
        </label>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-labelledby={`${fieldId}-label`}
            aria-expanded={disabled ? false : open}
            aria-invalid={invalid}
            disabled={disabled}
            className={cn(
              SEARCH_FIELD_CONTROL_CLASS,
              "justify-start text-left hover:bg-accent/60",
              disabled && "fd-control-disabled-section hover:bg-secondary",
              invalid && "fd-control-invalid",
            )}
          >
            <AppIcon name="calendar" className="text-muted-foreground" />
            <span key={selectedLabel} className={`${SEARCH_FIELD_VALUE_CLASS} fd-field-value-swap ${!disabled && value ? "text-foreground" : "text-muted-foreground"}`}>
              {selectedLabel}
            </span>
          </button>
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
            labels={{
              labelDayButton: (date) => formatDateLabel(localDateToIso(date)),
            }}
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

function AnimatedDateLabel({ label }: { label: string }) {
  const [primary, ...rest] = label.split(" ")
  const qualifier = rest.join(" ")

  return (
    <>
      <span key={primary} className="fd-label-word-swap">{primary}</span>
      <AnimatedOptionalLabelWord word={qualifier} />
    </>
  )
}

function AnimatedOptionalLabelWord({ word }: { word: string }) {
  if (!word) {
    return null
  }

  return (
    <>
      {" "}
      <span
        key={word}
        className="fd-label-word-extra fd-label-word-extra-visible fd-label-word-swap"
      >
        {word}
      </span>
    </>
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
  disabled = false,
  stayNightsDisabled,
}: {
  expandWindow: boolean
  onExpandWindowChange: (value: boolean) => void
  stayNights: number
  onStayNightsChange: (value: number) => void
  disabled?: boolean
  stayNightsDisabled: boolean
}) {
  const stayControlsDisabled = disabled || stayNightsDisabled

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Button
        type="button"
        variant="outline"
        aria-pressed={expandWindow}
        disabled={disabled}
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

      <div
        role="group"
        aria-disabled={stayControlsDisabled}
        aria-labelledby="flexible-stay-nights-label"
        className={cn(
          "inline-flex h-8 items-center overflow-hidden rounded-lg border border-input bg-secondary p-0.5 transition-[background-color,border-color,opacity,filter,transform] duration-200 ease-out",
          stayControlsDisabled && "fd-control-disabled-section",
        )}
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
          disabled={stayControlsDisabled || stayNights <= 1}
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
        >
          <AppIcon name="minus" />
        </Button>
        <span className={cn("min-w-14 px-1 text-center text-xs font-semibold transition-colors duration-150", stayControlsDisabled ? "text-muted-foreground" : "text-foreground")}>
          {stayNights} noche{stayNights === 1 ? "" : "s"}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Agregar noche"
          onClick={() => onStayNightsChange(Math.min(45, stayNights + 1))}
          disabled={stayControlsDisabled || stayNights >= 45}
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
        >
          <AppIcon name="plus" />
        </Button>
      </div>
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

function modeFromSearchRequest(request: SearchRequest): SearchModeControl {
  if (request.searchMode === "month-view") return "migration"
  return request.searchMode === "exact" ? "exact" : "flexible"
}

function dateStartFromSearchRequest(request: SearchRequest) {
  return request.searchMode === "exact"
    ? request.departureDate ?? ""
    : request.departureStart ?? request.departureDate ?? ""
}

function dateEndFromSearchRequest(request: SearchRequest) {
  return request.searchMode === "exact"
    ? request.returnDate ?? ""
    : request.departureEnd ?? request.returnDate ?? ""
}
