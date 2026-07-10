import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type MouseEvent, type RefObject } from "react"
import { createPortal } from "react-dom"
import { es } from "react-day-picker/locale"
import { Button } from "@/components/ui/button"
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group"
import { Calendar } from "@/components/ui/calendar"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SegmentButton, SegmentedControl } from "@/components/ui/segmented-control"
import { TOPBAR_SEARCH_CONTROLS_ID } from "@/components/TopBar"
import { AppIcon, type AppIconName } from "@/components/ui/app-icon"
import { useAutocomplete } from "@/hooks/useAutocomplete"
import { warmLocationSuggestionDetails } from "@/lib/api"
import {
  emptyLocationUsageSuggestions,
  getLocationUsageSuggestions,
  type LocationUsageSuggestions,
} from "@/lib/location-usage-suggestions"
import { cn } from "@/lib/utils"
import type { LocationSuggestion, SearchRequest, SortMode } from "@/types"

const DATE_LABEL_FORMATTER = new Intl.DateTimeFormat("es-PE", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
})
const MIGRATION_MONTH_LABEL_FORMATTER = new Intl.DateTimeFormat("es-PE", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
})
const MIGRATION_MONTH_NAME_FORMATTER = new Intl.DateTimeFormat("es-PE", {
  month: "long",
  timeZone: "UTC",
})
const LEGACY_DEFAULT_MIGRATION_MONTH_COUNT = 8
const SEARCH_FIELD_CONTROL_CLASS = "fd-control flex h-[52px] w-full items-center gap-2 px-3 pt-4"
const SEARCH_FIELD_VALUE_CLASS = "h-4 min-w-0 flex-1 truncate text-sm font-semibold leading-4"
const SEARCH_MAX_FUTURE_DAYS_FALLBACK = 365
const MAX_STAY_NIGHTS = 90
const MAX_PASSENGERS = 9
const MAX_CHILDREN = 8
const TOPBAR_CONTROLS_MEDIA_QUERY = "(min-width: 768px)"

type SearchModeControl = "exact" | "flexible" | "migration"
type SearchTouchedField = "origin" | "destination" | "departureDate" | "returnDate" | "passengers" | "migrationMonths"
type LocationUsageField = "origin" | "destination"
type SearchLocationMeta = Partial<Pick<LocationSuggestion, "label" | "countryCode">>
type MigrationMonthOption = {
  key: string
  label: string
  monthLabel: string
  shortLabel: string
  disabled: boolean
}

interface SearchShellProps {
  onSearch: (req: SearchRequest, sort?: SortMode) => void
  onCancelSearch?: () => void
  loading: boolean
  loadingLabel?: string
  controlsPlacement?: "inline" | "topbar"
  showLocationUsageSuggestions?: boolean
  syncedRequest?: SearchRequest | null
  resetToken?: number
  onSearchConfigDraftChange?: (request: SearchRequest | null) => void
}

export function SearchShell({
  onSearch,
  onCancelSearch,
  loading,
  loadingLabel = "Buscando",
  controlsPlacement = "inline",
  showLocationUsageSuggestions = false,
  syncedRequest = null,
  resetToken = 0,
  onSearchConfigDraftChange,
}: SearchShellProps) {
  const [mode, setMode] = useState<SearchModeControl>("exact")
  const [trip, setTrip] = useState<"round-trip" | "one-way">("round-trip")
  const [originCode, setOriginCode] = useState("")
  const [destCode, setDestCode] = useState("")
  const [originMeta, setOriginMeta] = useState<SearchLocationMeta>({})
  const [destinationMeta, setDestinationMeta] = useState<SearchLocationMeta>({})
  const [departureDate, setDepartureDate] = useState("")
  const [returnDate, setReturnDate] = useState("")
  const [stayNights, setStayNights] = useState(7)
  const [adults, setAdults] = useState(1)
  const [children, setChildren] = useState(0)
  const [infants, setInfants] = useState(0)
  const [paxOpen, setPaxOpen] = useState(false)
  const [usageSuggestions, setUsageSuggestions] = useState<LocationUsageSuggestions>(() => emptyLocationUsageSuggestions())
  const [hiddenUsageSuggestionFields, setHiddenUsageSuggestionFields] = useState<Record<LocationUsageField, boolean>>({
    origin: false,
    destination: false,
  })
  const [exitingUsageSuggestionFields, setExitingUsageSuggestionFields] = useState<Record<LocationUsageField, boolean>>({
    origin: false,
    destination: false,
  })
  const datePolicy = useMemo(() => getRuntimeSearchDatePolicy(), [])
  const migrationMonthOptions = useMemo(
    () => buildMigrationMonthOptions(datePolicy.minSearchDate),
    [datePolicy.minSearchDate],
  )
  const defaultMigrationMonths = useMemo(
    () => defaultMigrationMonthSelection(migrationMonthOptions),
    [migrationMonthOptions],
  )
  const [selectedMigrationMonths, setSelectedMigrationMonths] = useState<string[]>(() => defaultMigrationMonths)
  const migrationMonthRange = useMemo(
    () => resolveMigrationMonthRange(selectedMigrationMonths, migrationMonthOptions),
    [migrationMonthOptions, selectedMigrationMonths],
  )
  const lastResetTokenRef = useRef(resetToken)
  const [touched, setTouched] = useState<Record<SearchTouchedField, boolean>>({
    origin: false,
    destination: false,
    departureDate: false,
    returnDate: false,
    passengers: false,
    migrationMonths: false,
  })
  const validDepartureDate = isIsoDate(departureDate) ? departureDate : ""
  const returnMinDate = maxIsoDate(datePolicy.minSearchDate, validDepartureDate || datePolicy.minSearchDate)
  const endDateMaxDate = mode === "exact" && trip === "round-trip" && validDepartureDate
    ? minIsoDate(datePolicy.maxSearchDate, addDays(validDepartureDate, MAX_STAY_NIGHTS))
    : datePolicy.maxSearchDate
  const departureLabel = mode === "migration" ? "Mes desde" : mode === "flexible" ? "Salida desde" : "Salida"
  const endDateLabel = mode === "migration" ? "Mes hasta" : mode === "flexible" ? "Salida hasta" : "Regreso"
  const canUseTopbarControls = useCanUseTopbarControls()

  const origin = useAutocomplete((suggestion) => {
    setOriginCode(suggestion.code)
    setOriginMeta({ label: suggestion.label, countryCode: suggestion.countryCode })
  })
  const destination = useAutocomplete((suggestion) => {
    setDestCode(suggestion.code)
    setDestinationMeta({ label: suggestion.label, countryCode: suggestion.countryCode })
  })
  const setOriginQuery = origin.setQuery
  const setDestinationQuery = destination.setQuery
  const resolveOriginQuery = origin.resolveCurrentQuery
  const resolveDestinationQuery = destination.resolveCurrentQuery
  const usageSuggestionExitTimersRef = useRef<Partial<Record<LocationUsageField, number>>>({})
  const warmedUsageSuggestionCodesRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const timers = usageSuggestionExitTimersRef.current
    return () => {
      for (const timer of Object.values(timers)) {
        if (timer) window.clearTimeout(timer)
      }
    }
  }, [])

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
      setOriginMeta({ label: syncedRequest.originLabel, countryCode: syncedRequest.originCountryCode })
      setDestinationMeta({ label: syncedRequest.destinationLabel, countryCode: syncedRequest.destinationCountryCode })
      setOriginQuery(nextOrigin)
      setDestinationQuery(nextDestination)
      setDepartureDate(dateStartFromSearchRequest(syncedRequest))
      setReturnDate(dateEndFromSearchRequest(syncedRequest))
      setStayNights(clampStayNights(syncedRequest.stayNights ?? 7))
      setSelectedMigrationMonths(resolveMigrationMonthSelection(syncedRequest.migrationMonths, migrationMonthOptions))
      const nextAdults = clampInteger(syncedRequest.adults, 1, MAX_PASSENGERS, 1)
      const nextChildren = clampInteger(syncedRequest.children, 0, Math.max(0, MAX_PASSENGERS - nextAdults), 0)
      const nextInfants = clampInteger(
        syncedRequest.infants,
        0,
        Math.min(nextAdults, Math.max(0, MAX_PASSENGERS - nextAdults - nextChildren)),
        0,
      )
      setAdults(nextAdults)
      setChildren(nextChildren)
      setInfants(nextInfants)
      setTouched({
        origin: false,
        destination: false,
        departureDate: false,
        returnDate: false,
        passengers: false,
        migrationMonths: false,
      })
      void resolveOriginQuery()
      void resolveDestinationQuery()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [migrationMonthOptions, resolveDestinationQuery, resolveOriginQuery, setDestinationQuery, setOriginQuery, syncedRequest])

  useEffect(() => {
    if (!showLocationUsageSuggestions || loading) return

    const controller = new AbortController()
    void getLocationUsageSuggestions({ signal: controller.signal })
      .then((nextSuggestions) => {
        if (!controller.signal.aborted) {
          setUsageSuggestions(nextSuggestions)
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setUsageSuggestions(emptyLocationUsageSuggestions())
        }
      })

    return () => controller.abort()
  }, [loading, showLocationUsageSuggestions])

  useEffect(() => {
    if (!showLocationUsageSuggestions || loading) return

    const nextCodes = [...usageSuggestions.origin, ...usageSuggestions.destination]
      .map((code) => code.trim().toUpperCase())
      .filter((code) => /^[A-Z]{3}$/.test(code))
      .filter((code) => !warmedUsageSuggestionCodesRef.current.has(code))

    if (nextCodes.length === 0) return

    for (const code of nextCodes) {
      warmedUsageSuggestionCodesRef.current.add(code)
    }
    void warmLocationSuggestionDetails(nextCodes)
  }, [loading, showLocationUsageSuggestions, usageSuggestions])

  useEffect(() => {
    if (resetToken === lastResetTokenRef.current) return
    lastResetTokenRef.current = resetToken

    const frame = window.requestAnimationFrame(() => {
      setMode("exact")
      setTrip("round-trip")
      setOriginCode("")
      setDestCode("")
      setOriginMeta({})
      setDestinationMeta({})
      setOriginQuery("")
      setDestinationQuery("")
      setDepartureDate("")
      setReturnDate("")
      setStayNights(7)
      setSelectedMigrationMonths(defaultMigrationMonths)
      setAdults(1)
      setChildren(0)
      setInfants(0)
      setPaxOpen(false)
      setTouched({
        origin: false,
        destination: false,
        departureDate: false,
        returnDate: false,
        passengers: false,
        migrationMonths: false,
      })
      onSearchConfigDraftChange?.(null)
    })

    return () => window.cancelAnimationFrame(frame)
  }, [defaultMigrationMonths, onSearchConfigDraftChange, resetToken, setDestinationQuery, setOriginQuery])

  const updateAdults = (nextAdults: number) => {
    const clampedAdults = Math.max(1, Math.min(nextAdults, MAX_PASSENGERS))
    const clampedChildren = Math.min(children, Math.max(0, MAX_PASSENGERS - clampedAdults))
    const clampedInfants = Math.min(infants, clampedAdults, Math.max(0, MAX_PASSENGERS - clampedAdults - clampedChildren))
    setAdults(clampedAdults)
    setChildren(clampedChildren)
    setInfants(clampedInfants)
    setTouched((current) => ({ ...current, passengers: true }))
  }

  const updateChildren = (nextChildren: number) => {
    const clampedChildren = Math.max(0, Math.min(nextChildren, MAX_CHILDREN, MAX_PASSENGERS - adults))
    setChildren(clampedChildren)
    setInfants((current) => Math.min(current, adults, Math.max(0, MAX_PASSENGERS - adults - clampedChildren)))
    setTouched((current) => ({ ...current, passengers: true }))
  }

  const updateInfants = (nextInfants: number) => {
    setInfants(Math.max(0, Math.min(nextInfants, adults, MAX_PASSENGERS - adults - children)))
    setTouched((current) => ({ ...current, passengers: true }))
  }

  const handleDepartureDateChange = (nextDate: string) => {
    const clampedDate = clampIsoDate(nextDate, datePolicy.minSearchDate, datePolicy.maxSearchDate)
    const maxReturnDate = mode === "exact" && trip === "round-trip"
      ? minIsoDate(datePolicy.maxSearchDate, addDays(clampedDate, MAX_STAY_NIGHTS))
      : datePolicy.maxSearchDate
    setDepartureDate(clampedDate)
    setReturnDate((current) => {
      if (!current) return current
      if (current < clampedDate) return clampedDate
      if (current > maxReturnDate) return maxReturnDate
      return current
    })
  }

  const handleReturnDateChange = (nextDate: string) => {
    setReturnDate(clampIsoDate(nextDate, returnMinDate, endDateMaxDate))
  }

  const handleTripChange = (nextTrip: "round-trip" | "one-way") => {
    setTrip(nextTrip)
    if (nextTrip === "round-trip" && returnDate && returnDate < returnMinDate) {
      setReturnDate(returnMinDate)
    } else if (nextTrip === "round-trip" && returnDate && departureDate) {
      setReturnDate((current) => clampIsoDate(
        current,
        returnMinDate,
        minIsoDate(datePolicy.maxSearchDate, addDays(departureDate, MAX_STAY_NIGHTS)),
      ))
    }
  }

  const handleModeChange = (nextMode: SearchModeControl) => {
    setMode(nextMode)
    if (nextMode === "migration") {
      setSelectedMigrationMonths((current) => current.length ? current : defaultMigrationMonths)
    }
    setTouched((current) => ({
      ...current,
      departureDate: false,
      returnDate: false,
      migrationMonths: false,
    }))
  }

  const handleMigrationStartMonthChange = (key: string) => {
    setSelectedMigrationMonths((current) => {
      const range = resolveMigrationMonthRange(current, migrationMonthOptions)
      const end = range.end && key <= range.end ? range.end : key
      return buildMigrationMonthRangeSelection(key, end, migrationMonthOptions)
    })
    setTouched((current) => ({ ...current, migrationMonths: true }))
  }

  const handleMigrationEndMonthChange = (key: string) => {
    setSelectedMigrationMonths((current) => {
      const range = resolveMigrationMonthRange(current, migrationMonthOptions)
      const start = range.start && key >= range.start ? range.start : key
      return buildMigrationMonthRangeSelection(start, key, migrationMonthOptions)
    })
    setTouched((current) => ({ ...current, migrationMonths: true }))
  }

  const swapRoute = () => {
    setOriginCode(destCode)
    setDestCode(originCode)
    setOriginMeta(destinationMeta)
    setDestinationMeta(originMeta)
    origin.setQuery(destination.query)
    destination.setQuery(origin.query)
  }

  const clearUsageSuggestionExitTimer = (field: LocationUsageField) => {
    const timer = usageSuggestionExitTimersRef.current[field]
    if (timer) window.clearTimeout(timer)
    delete usageSuggestionExitTimersRef.current[field]
  }

  const resetUsageSuggestionVisibility = () => {
    clearUsageSuggestionExitTimer("origin")
    clearUsageSuggestionExitTimer("destination")
    setHiddenUsageSuggestionFields({ origin: false, destination: false })
    setExitingUsageSuggestionFields({ origin: false, destination: false })
  }

  const hideUsageSuggestionField = (field: LocationUsageField) => {
    clearUsageSuggestionExitTimer(field)
    setExitingUsageSuggestionFields((current) => ({ ...current, [field]: true }))
    usageSuggestionExitTimersRef.current[field] = window.setTimeout(() => {
      setHiddenUsageSuggestionFields((current) => ({ ...current, [field]: true }))
      setExitingUsageSuggestionFields((current) => ({ ...current, [field]: false }))
      delete usageSuggestionExitTimersRef.current[field]
    }, 150)
  }

  const applyOriginUsageSuggestion = async (code: string) => {
    hideUsageSuggestionField("origin")
    setOriginCode(code)
    origin.setQuery(code)
    setTouched((current) => ({ ...current, origin: true }))
    const resolved = await origin.resolveCurrentQuery()
    if (resolved) setOriginCode(resolved.code)
  }

  const applyDestinationUsageSuggestion = async (code: string) => {
    hideUsageSuggestionField("destination")
    setDestCode(code)
    destination.setQuery(code)
    setTouched((current) => ({ ...current, destination: true }))
    const resolved = await destination.resolveCurrentQuery()
    if (resolved) setDestCode(resolved.code)
  }

  const validation = buildSearchValidation({
    originValue: origin.query,
    destinationValue: destination.query,
    departureDate,
    returnDate,
    adults,
    children,
    infants,
    trip,
    mode,
    migrationMonths: selectedMigrationMonths,
    minDepartureDate: datePolicy.minSearchDate,
    maxDate: datePolicy.maxSearchDate,
    minReturnDate: returnMinDate,
    maxStayNights: MAX_STAY_NIGHTS,
  })

  const buildRequest = useCallback((origin: string, destination: string): SearchRequest => {
    const flexibleDepartureStart = mode === "migration"
      ? datePolicy.minSearchDate
      : mode === "flexible"
      ? clampIsoDate(departureDate, datePolicy.minSearchDate, datePolicy.maxSearchDate)
      : undefined
    const flexibleDepartureEnd = mode === "flexible"
      ? clampIsoDate(returnDate, datePolicy.minSearchDate, datePolicy.maxSearchDate)
      : undefined

    return {
      origin,
      destination,
      originLabel: originMeta.label,
      destinationLabel: destinationMeta.label,
      originCountryCode: originMeta.countryCode,
      destinationCountryCode: destinationMeta.countryCode,
      departureDate: mode === "exact" ? departureDate || undefined : undefined,
      departureStart: flexibleDepartureStart,
      departureEnd: flexibleDepartureEnd,
      returnDate: mode === "exact" && trip === "round-trip" ? returnDate || undefined : undefined,
      tripType: mode === "migration" ? "one-way" : trip,
      adults,
      children,
      infants,
      migrationMonths: mode === "migration" ? selectedMigrationMonths : undefined,
      searchMode: mode === "migration"
        ? "month-view"
        : mode === "flexible"
          ? trip === "round-trip" ? "roundtrip-grid" : "stay-range"
          : "exact",
      flexibleMode: mode === "flexible" && trip === "round-trip" ? "exact-stay" : undefined,
      stayNights: mode === "flexible" && trip === "round-trip" ? clampStayNights(stayNights) : undefined,
    }
  }, [
    adults,
    children,
    datePolicy.maxSearchDate,
    datePolicy.minSearchDate,
    departureDate,
    infants,
    mode,
    originMeta,
    returnDate,
    selectedMigrationMonths,
    stayNights,
    trip,
    destinationMeta,
  ])

  const hasValidationError = hasBlockingValidationError(validation)

  useEffect(() => {
    if (hasValidationError) {
      onSearchConfigDraftChange?.(null)
      return
    }

    const draftOrigin = normalizeLocationCandidate(originCode || origin.query)
    const draftDestination = normalizeLocationCandidate(destCode || destination.query)
    const draft = isValidLocationCandidate(draftOrigin) && isValidLocationCandidate(draftDestination)
      ? buildRequest(draftOrigin, draftDestination)
      : null

    onSearchConfigDraftChange?.(draft)
  }, [
    adults,
    children,
    datePolicy.maxSearchDate,
    datePolicy.minSearchDate,
    departureDate,
    destCode,
    destination.query,
    infants,
    hasValidationError,
    buildRequest,
    mode,
    onSearchConfigDraftChange,
    origin.query,
    originCode,
    returnDate,
    selectedMigrationMonths,
    stayNights,
    trip,
  ])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()

    if (loading) {
      onCancelSearch?.()
      return
    }

    setTouched({
      origin: true,
      destination: true,
      departureDate: mode !== "migration",
      returnDate: mode !== "migration" && (trip === "round-trip" || mode === "flexible"),
      passengers: true,
      migrationMonths: mode === "migration",
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
      adults,
      children,
      infants,
      trip,
      mode,
      migrationMonths: selectedMigrationMonths,
      minDepartureDate: datePolicy.minSearchDate,
      maxDate: datePolicy.maxSearchDate,
      minReturnDate: returnMinDate,
      maxStayNights: MAX_STAY_NIGHTS,
    })
    if (hasBlockingValidationError(resolvedValidation)) {
      return
    }

    const nextRequest = {
      ...buildRequest(resolvedRequest.origin, resolvedRequest.destination),
      originLabel: resolvedOrigin?.label ?? originMeta.label,
      destinationLabel: resolvedDestination?.label ?? destinationMeta.label,
      originCountryCode: resolvedOrigin?.countryCode ?? originMeta.countryCode,
      destinationCountryCode: resolvedDestination?.countryCode ?? destinationMeta.countryCode,
    }
    resetUsageSuggestionVisibility()
    onSearch(nextRequest)
  }

  const passengerTotal = adults + children + infants
  const passengerSlotsRemaining = Math.max(0, MAX_PASSENGERS - passengerTotal)
  const visibleOriginError = touched.origin ? validation.origin : undefined
  const visibleDestinationError = touched.destination ? validation.destination : undefined
  const visibleDepartureDateError = mode !== "migration" && (touched.departureDate || Boolean(departureDate && !isIsoDate(departureDate)))
    ? validation.departureDate
    : undefined
  const visibleReturnDateError = mode !== "migration" && (mode !== "exact" || trip !== "one-way") && (touched.returnDate || Boolean(returnDate && !isIsoDate(returnDate)))
    ? validation.returnDate
    : undefined
  const visiblePassengerError = touched.passengers ? validation.passengers : undefined
  const shouldShowUsageSuggestions = showLocationUsageSuggestions && !loading
  const reserveIdleHelperSpace = shouldShowUsageSuggestions
  const reserveOriginSuggestionSpace = shouldShowUsageSuggestions && usageSuggestions.origin.length > 0
  const reserveDestinationSuggestionSpace = shouldShowUsageSuggestions && usageSuggestions.destination.length > 0
  const searchGridClassName = cn(
    "fd-search-grid grid grid-cols-2 gap-1.5 transition-[grid-template-columns,max-width] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]",
    "lg:grid-cols-[minmax(150px,1.2fr)_34px_minmax(150px,1.2fr)_minmax(128px,.85fr)_minmax(128px,.85fr)_minmax(144px,.9fr)_124px]",
  )
  const visibleMigrationMonthsError = mode === "migration" && touched.migrationMonths
    ? validation.migrationMonths
    : undefined
  const tripTabs: { key: typeof trip; label: string; icon: AppIconName }[] = [
    { key: "round-trip", label: "Ida y vuelta", icon: "roundTrip" },
    { key: "one-way", label: "Solo ida", icon: "oneWay" },
  ]
  const topbarControlsTarget = controlsPlacement === "topbar" && canUseTopbarControls
    ? document.getElementById(TOPBAR_SEARCH_CONTROLS_ID)
    : null
  const shouldPortalControls = Boolean(topbarControlsTarget)
  const searchControls = (
    <SearchModeControls
      mode={mode}
      trip={trip}
      tripTabs={tripTabs}
      stayNights={stayNights}
      onModeChange={handleModeChange}
      onTripChange={handleTripChange}
      onStayNightsChange={setStayNights}
      topbar={shouldPortalControls}
    />
  )

  return (
    <>
      {topbarControlsTarget ? createPortal(searchControls, topbarControlsTarget) : null}
      <section className="overflow-visible" aria-busy={loading}>
        {!shouldPortalControls && (
          <div className="fd-search-controls-row mb-2 flex flex-wrap items-center justify-between gap-2">
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
                setOriginMeta({})
                setTouched((current) => ({ ...current, origin: true }))
              }}
              onSelect={(suggestion) => {
                origin.selectSuggestion(suggestion)
                setOriginCode(suggestion.code)
                setTouched((current) => ({ ...current, origin: true }))
              }}
              quickSuggestions={shouldShowUsageSuggestions && !origin.open && !hiddenUsageSuggestionFields.origin ? usageSuggestions.origin : []}
              quickSuggestionsExiting={exitingUsageSuggestionFields.origin}
              onQuickSuggestionSelect={applyOriginUsageSuggestion}
              reserveHelperSpace={reserveIdleHelperSpace}
              reserveSuggestionSpace={reserveOriginSuggestionSpace}
              invalid={Boolean(visibleOriginError)}
              helperText={visibleOriginError}
            />

          <div className="fd-route-swap-cell hidden justify-center lg:flex">
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
              setDestinationMeta({})
              setTouched((current) => ({ ...current, destination: true }))
            }}
            onSelect={(suggestion) => {
              destination.selectSuggestion(suggestion)
              setDestCode(suggestion.code)
              setTouched((current) => ({ ...current, destination: true }))
            }}
            quickSuggestions={shouldShowUsageSuggestions && !destination.open && !hiddenUsageSuggestionFields.destination ? usageSuggestions.destination : []}
            quickSuggestionsExiting={exitingUsageSuggestionFields.destination}
            onQuickSuggestionSelect={applyDestinationUsageSuggestion}
            reserveHelperSpace={reserveIdleHelperSpace}
            reserveSuggestionSpace={reserveDestinationSuggestionSpace}
            invalid={Boolean(visibleDestinationError)}
            helperText={visibleDestinationError}
          />

          {mode === "migration" ? (
            <>
              <MonthField
                label={departureLabel}
                value={migrationMonthRange.start}
                months={migrationMonthOptions}
                invalid={Boolean(visibleMigrationMonthsError)}
                helperText={visibleMigrationMonthsError}
                onChange={handleMigrationStartMonthChange}
                onTouch={() => setTouched((current) => ({ ...current, migrationMonths: true }))}
                reserveHelperSpace={reserveIdleHelperSpace}
              />
              <MonthField
                label={endDateLabel}
                value={migrationMonthRange.end}
                months={migrationMonthOptions}
                invalid={Boolean(visibleMigrationMonthsError)}
                onChange={handleMigrationEndMonthChange}
                onTouch={() => setTouched((current) => ({ ...current, migrationMonths: true }))}
                reserveHelperSpace={reserveIdleHelperSpace}
              />
            </>
          ) : (
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
                invalid={Boolean(visibleDepartureDateError)}
                helperText={visibleDepartureDateError}
                onTouch={() => setTouched((current) => ({ ...current, departureDate: true }))}
                reserveHelperSpace={reserveIdleHelperSpace}
              />
              <DateField
                label={endDateLabel}
                value={returnDate}
                minDate={returnMinDate}
                maxDate={endDateMaxDate}
                disabled={mode === "exact" && trip === "one-way"}
                disabledLabel="No aplica"
                onChange={(value) => {
                  handleReturnDateChange(value)
                  setTouched((current) => ({ ...current, returnDate: true }))
                }}
                invalid={Boolean(visibleReturnDateError)}
                helperText={visibleReturnDateError}
                onTouch={() => setTouched((current) => ({ ...current, returnDate: true }))}
                reserveHelperSpace={reserveIdleHelperSpace}
              />
            </>
          )}

          <Popover
            open={paxOpen}
            onOpenChange={(nextOpen) => {
              setPaxOpen(nextOpen)
              if (nextOpen) setTouched((current) => ({ ...current, passengers: true }))
            }}
          >
            <Field className={cn("relative", reserveIdleHelperSpace && "fd-search-field-shell")}>
              <FieldLabel className="pointer-events-none absolute left-3 top-2.5 z-10">Pasajeros</FieldLabel>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label="Seleccionar pasajeros"
                  aria-expanded={paxOpen}
                  aria-haspopup="dialog"
                  aria-invalid={Boolean(visiblePassengerError)}
                  aria-describedby={visiblePassengerError ? "passengers-helper" : undefined}
                  className={cn(
                    SEARCH_FIELD_CONTROL_CLASS,
                    "justify-start p-0 px-3 pt-4 text-left hover:bg-accent/60",
                    visiblePassengerError && "fd-control-invalid",
                  )}
                >
                  <AppIcon name="passengers" className="text-muted-foreground" />
                  <span className={SEARCH_FIELD_VALUE_CLASS}>
                    {passengerTotal} pasajero{passengerTotal > 1 ? "s" : ""}
                  </span>
                  <AppIcon name="chevronDown" className={`text-muted-foreground transition-transform ${paxOpen ? "rotate-180" : ""}`} />
                </Button>
              </PopoverTrigger>

              <PopoverContent align="end" className="w-72">
                <PaxRow label="Adultos" detail="12+ años" value={adults} onInc={() => updateAdults(adults + 1)} onDec={() => updateAdults(adults - 1)} decDisabled={adults <= 1} incDisabled={adults >= MAX_PASSENGERS || passengerSlotsRemaining <= 0} />
                <PaxRow label="Niños" detail="2-11 años" value={children} onInc={() => updateChildren(children + 1)} onDec={() => updateChildren(children - 1)} decDisabled={children <= 0} incDisabled={children >= MAX_CHILDREN || passengerSlotsRemaining <= 0} />
                <PaxRow label="Bebés" detail="Menos de 2 años" value={infants} onInc={() => updateInfants(infants + 1)} onDec={() => updateInfants(infants - 1)} decDisabled={infants <= 0} incDisabled={infants >= adults || passengerSlotsRemaining <= 0} />
                <p className="px-2 pt-1 text-xs font-medium text-muted-foreground">
                  Máximo {MAX_PASSENGERS} pasajeros por búsqueda.
                </p>
              </PopoverContent>
              <ControlHelper id="passengers-helper" text={visiblePassengerError} />
            </Field>
          </Popover>

          <Button
            type={loading ? "button" : "submit"}
            onClick={loading
              ? (event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  onCancelSearch?.()
                }
              : undefined}
            aria-label={loading ? "Detener búsqueda" : "Buscar"}
            title={loading ? "Detener búsqueda" : undefined}
            disabled={!loading && hasValidationError}
            className={cn(
              "h-[52px] rounded-lg text-sm",
              loading && "group border border-primary/40 hover:border-destructive hover:bg-destructive hover:text-destructive-foreground",
            )}
          >
            {loading ? (
              <>
                <span className="relative grid h-4 w-4 place-items-center">
                  <AppIcon name="loading" spin className="transition-opacity duration-150 group-hover:opacity-0" />
                  <AppIcon name="x" className="absolute opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
                </span>
                <span className="relative inline-grid min-w-16">
                  <span className="transition-opacity duration-150 group-hover:opacity-0">{loadingLabel}</span>
                  <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                    Detener
                  </span>
                </span>
              </>
            ) : (
              <>
                <AppIcon name="search" />
                Buscar
              </>
            )}
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
  stayNights,
  onModeChange,
  onTripChange,
  onStayNightsChange,
  topbar,
}: {
  mode: SearchModeControl
  trip: "round-trip" | "one-way"
  tripTabs: { key: "round-trip" | "one-way"; label: string; icon: AppIconName }[]
  stayNights: number
  onModeChange: (mode: SearchModeControl) => void
  onTripChange: (trip: "round-trip" | "one-way") => void
  onStayNightsChange: (value: number) => void
  topbar: boolean
}) {
  const flexibleControlsActive = mode === "flexible"
  const tripControlsDisabled = mode === "migration"
  const displayedTrip: "round-trip" | "one-way" = tripControlsDisabled ? "one-way" : trip

  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-2",
        topbar ? "max-w-[calc(100vw-11rem)] justify-center" : "w-full sm:w-auto",
      )}
    >
      <SegmentedControl
        value={mode}
        onValueChange={(value) => {
          if (value === "exact" || value === "flexible" || value === "migration") onModeChange(value)
        }}
        className={cn(!topbar && "flex min-w-0 flex-1 basis-full sm:inline-flex sm:flex-none sm:basis-auto")}
      >
        <SegmentButton
          value="exact"
          className={cn(!topbar && "flex-1 px-2 sm:flex-none sm:px-3")}
        >
          Exacto
        </SegmentButton>
        <SegmentButton
          value="flexible"
          className={cn(!topbar && "flex-1 px-2 sm:flex-none sm:px-3")}
        >
          Flexible
        </SegmentButton>
        <SegmentButton
          value="migration"
          className={cn(!topbar && "flex-1 px-2 sm:flex-none sm:px-3")}
        >
          Migratorio
        </SegmentButton>
      </SegmentedControl>

      <div
        aria-hidden={!flexibleControlsActive}
        className={cn(
          "fd-inline-reveal min-w-0",
          !topbar && "flex-[1_1_100%] sm:flex-none",
          flexibleControlsActive ? "fd-inline-reveal-open" : "fd-inline-reveal-closed",
        )}
      >
        <FlexibleOptionsBar
          stayNights={stayNights}
          onStayNightsChange={onStayNightsChange}
          disabled={!flexibleControlsActive}
          stayNightsDisabled={trip !== "round-trip"}
          stretch={!topbar}
        />
      </div>

      <SegmentedControl
        value={displayedTrip}
        onValueChange={(value) => {
          if (value === "round-trip" || value === "one-way") onTripChange(value)
        }}
        disabled={tripControlsDisabled}
        className={cn(!topbar && "flex min-w-0 flex-1 basis-full sm:inline-flex sm:flex-none sm:basis-auto")}
      >
        {tripTabs.map((item) => (
          <SegmentButton
            key={item.key}
            value={item.key}
            disabled={tripControlsDisabled}
            className={cn(!topbar && "flex-1 px-2 sm:flex-none sm:px-3")}
          >
            <AppIcon name={item.icon} />
            {item.label}
          </SegmentButton>
        ))}
      </SegmentedControl>
    </div>
  )
}

function useCanUseTopbarControls() {
  const [canUseTopbarControls, setCanUseTopbarControls] = useState(() => (
    typeof window === "undefined" ? false : window.matchMedia(TOPBAR_CONTROLS_MEDIA_QUERY).matches
  ))

  useEffect(() => {
    const query = window.matchMedia(TOPBAR_CONTROLS_MEDIA_QUERY)
    const update = () => setCanUseTopbarControls(query.matches)
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])

  return canUseTopbarControls
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
  quickSuggestions = [],
  quickSuggestionsExiting = false,
  onQuickSuggestionSelect,
  reserveHelperSpace = false,
  reserveSuggestionSpace = false,
  invalid = false,
  helperText,
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
  quickSuggestions?: string[]
  quickSuggestionsExiting?: boolean
  onQuickSuggestionSelect?: (code: string) => void | Promise<void>
  reserveHelperSpace?: boolean
  reserveSuggestionSpace?: boolean
  invalid?: boolean
  helperText?: string
}) {
  const fieldId = `location-${label.toLowerCase()}`
  const listboxId = `${fieldId}-suggestions`
  const activeOptionId = activeIndex >= 0 && suggestions[activeIndex]
    ? `${listboxId}-${activeIndex}`
    : undefined
  const fieldRef = useRef<HTMLDivElement | null>(null)
  const controlRef = useRef<HTMLDivElement | null>(null)
  const [listboxStyle, setListboxStyle] = useState<CSSProperties | null>(null)
  const shouldShowListbox = open && suggestions.length > 0
  const listboxTarget = typeof document === "undefined" ? null : document.body

  useLayoutEffect(() => {
    if (!shouldShowListbox) return

    const updateListboxStyle = () => {
      const rect = controlRef.current?.getBoundingClientRect() ?? fieldRef.current?.getBoundingClientRect()
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
    if (controlRef.current) {
      resizeObserver?.observe(controlRef.current)
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

  const focusInputFromControl = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === inputRef.current) {
      return
    }

    const alreadyFocused = document.activeElement === inputRef.current
    inputRef.current?.focus()
    if (alreadyFocused) {
      onFocus()
    }
  }

  return (
    <Field
      ref={fieldRef}
      className={cn(
        "relative",
        reserveHelperSpace && "fd-search-field-shell",
        reserveSuggestionSpace && "fd-location-field-shell-reserve-suggestions",
      )}
    >
      <FieldLabel htmlFor={fieldId} className="pointer-events-none absolute left-3 top-2.5 z-10">{label}</FieldLabel>
      <div
        ref={controlRef}
        onClick={focusInputFromControl}
        className={cn(
          SEARCH_FIELD_CONTROL_CLASS,
          "cursor-text",
          invalid && "fd-control-invalid",
          roundedClass,
        )}
      >
        {icon && (
          <AppIcon name={icon} className="pointer-events-none text-muted-foreground" />
        )}
        <Input
          id={fieldId}
          ref={inputRef}
          aria-label={label}
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-describedby={helperText ? `${fieldId}-helper` : undefined}
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
          className={`${SEARCH_FIELD_VALUE_CLASS} w-auto rounded-none border-0 bg-transparent p-0 text-foreground shadow-none outline-none placeholder:text-muted-foreground/60 focus-visible:border-0 focus-visible:ring-0`}
        />
      </div>
      <ControlHelper id={`${fieldId}-helper`} text={helperText} />
      <LocationUsageSuggestionRow
        fieldId={fieldId}
        label={label}
        suggestions={quickSuggestions}
        exiting={quickSuggestionsExiting}
        onSelect={onQuickSuggestionSelect}
      />
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
    </Field>
  )
}

function LocationUsageSuggestionRow({
  fieldId,
  label,
  suggestions,
  exiting,
  onSelect,
}: {
  fieldId: string
  label: string
  suggestions: string[]
  exiting: boolean
  onSelect?: (code: string) => void | Promise<void>
}) {
  if (suggestions.length === 0 || !onSelect) {
    return null
  }

  return (
    <div
      className={cn("fd-location-usage-suggestions", exiting && "fd-location-usage-suggestions-exit")}
      aria-label={`Sugerencias frecuentes de ${label.toLowerCase()}`}
    >
      {suggestions.map((code) => (
        <Button
          key={`${fieldId}-${code}`}
          type="button"
          variant="outline"
          className="fd-control fd-location-usage-card"
          aria-label={`Usar ${code} como ${label.toLowerCase()}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            void onSelect(code)
          }}
        >
          {code}
        </Button>
      ))}
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

function MonthField({
  label,
  value,
  months,
  onChange,
  invalid = false,
  helperText,
  onTouch,
  reserveHelperSpace = false,
}: {
  label: string
  value: string
  months: MigrationMonthOption[]
  onChange: (value: string) => void
  invalid?: boolean
  helperText?: string
  onTouch?: () => void
  reserveHelperSpace?: boolean
}) {
  const [open, setOpen] = useState(false)
  const fieldId = `month-${toDomId(label)}`
  const selectedMonth = months.find((month) => month.key === value && !month.disabled)
    ?? months.find((month) => !month.disabled)
  const selectedLabel = selectedMonth?.shortLabel ?? "Seleccionar"
  const years = Array.from(new Set(months.map((month) => month.key.slice(0, 4))))

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) onTouch?.()
        setOpen(nextOpen)
      }}
    >
      <Field className={cn("relative", reserveHelperSpace && "fd-search-field-shell")}>
        <FieldLabel id={`${fieldId}-label`} className="pointer-events-none absolute left-3 top-2.5 z-10">
          <AnimatedDateLabel label={label} />
        </FieldLabel>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            aria-labelledby={`${fieldId}-label`}
            aria-describedby={helperText ? `${fieldId}-helper` : undefined}
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-invalid={invalid}
            className={cn(
              SEARCH_FIELD_CONTROL_CLASS,
              "justify-start p-0 px-3 pt-4 text-left hover:bg-accent/60",
              invalid && "fd-control-invalid",
            )}
          >
            <AppIcon name="calendar" className="text-muted-foreground" />
            <span key={selectedLabel} className={`${SEARCH_FIELD_VALUE_CLASS} fd-field-value-swap ${selectedMonth ? "text-foreground" : "text-muted-foreground"}`}>
              {selectedLabel}
            </span>
            <AppIcon name="chevronDown" className={`text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
          </Button>
        </PopoverTrigger>
        <ControlHelper id={`${fieldId}-helper`} text={helperText} />

        <PopoverContent
          align="start"
          className="w-[min(20rem,calc(100vw-2rem))]"
          aria-label={`Calendario de ${label.toLowerCase()}`}
        >
          <div className="space-y-3 p-1">
            {years.map((year) => (
              <div key={year} className="space-y-2">
                <div className="flex h-8 items-center justify-center px-2">
                  <span className="text-sm font-bold">{year}</span>
                </div>
                <div className="grid grid-cols-3 gap-1.5" role="group" aria-label={`Meses de ${year}`}>
                  {months.filter((month) => month.key.startsWith(`${year}-`)).map((month) => {
                    const selected = month.key === selectedMonth?.key

                    return (
                      <Button
                        key={month.key}
                        type="button"
                        variant="ghost"
                        aria-label={`${month.label}${month.disabled ? " no disponible" : ""}`}
                        aria-pressed={selected}
                        disabled={month.disabled}
                        onClick={() => {
                          onChange(month.key)
                          setOpen(false)
                        }}
                        className={cn(
                          "h-10 w-full rounded-lg border border-transparent px-2 text-xs capitalize",
                          selected && "fd-selected-passive",
                          month.disabled && "text-muted-foreground/45 line-through hover:bg-transparent hover:text-muted-foreground/45",
                        )}
                      >
                        {month.monthLabel}
                      </Button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </PopoverContent>
      </Field>
    </Popover>
  )
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
  helperText,
  onTouch,
  reserveHelperSpace = false,
}: {
  label: string
  value: string
  minDate: string
  maxDate?: string
  disabled?: boolean
  disabledLabel?: string
  onChange: (value: string) => void
  invalid?: boolean
  helperText?: string
  onTouch?: () => void
  reserveHelperSpace?: boolean
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
      <Field className={cn(
        "relative transition-[opacity,filter,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]",
        reserveHelperSpace && "fd-search-field-shell",
        disabled && "fd-disabled-section",
      )}>
        <FieldLabel id={`${fieldId}-label`} className="pointer-events-none absolute left-3 top-2.5 z-10">
          <AnimatedDateLabel label={label} />
        </FieldLabel>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            aria-labelledby={`${fieldId}-label`}
            aria-describedby={helperText ? `${fieldId}-helper` : undefined}
            aria-expanded={disabled ? false : open}
            aria-invalid={invalid}
            disabled={disabled}
            className={cn(
              SEARCH_FIELD_CONTROL_CLASS,
              "justify-start p-0 px-3 pt-4 text-left hover:bg-accent/60",
              disabled && "fd-control-disabled-section hover:bg-secondary",
              invalid && "fd-control-invalid",
            )}
          >
            <AppIcon name="calendar" className="text-muted-foreground" />
            <span key={selectedLabel} className={`${SEARCH_FIELD_VALUE_CLASS} fd-field-value-swap ${!disabled && value ? "text-foreground" : "text-muted-foreground"}`}>
              {selectedLabel}
            </span>
          </Button>
        </PopoverTrigger>
        <ControlHelper id={`${fieldId}-helper`} text={helperText} />

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
      </Field>
    </Popover>
  )
}

function ControlHelper({ id, text }: { id: string; text?: string }) {
  if (!text) return null

  return <FieldError id={id}>{text}</FieldError>
}

function AnimatedDateLabel({ label }: { label: string }) {
  return (
    <span key={label} className="fd-label-word-swap whitespace-nowrap leading-none">
      {label}
    </span>
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
  stayNights,
  onStayNightsChange,
  disabled = false,
  stayNightsDisabled,
  stretch = false,
}: {
  stayNights: number
  onStayNightsChange: (value: number) => void
  disabled?: boolean
  stayNightsDisabled: boolean
  stretch?: boolean
}) {
  const stayControlsDisabled = disabled || stayNightsDisabled

  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-2", stretch && "w-full sm:w-auto")}>
      <ButtonGroup
        aria-disabled={stayControlsDisabled}
        aria-labelledby="flexible-stay-nights-label"
        className={cn(
          "inline-flex h-8 items-center overflow-hidden rounded-lg border border-input bg-secondary p-0.5 transition-[background-color,border-color,opacity,filter,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]",
          stretch && "w-full justify-between sm:w-auto sm:justify-start",
          stayControlsDisabled && "fd-control-disabled-section",
        )}
      >
        <ButtonGroupText id="flexible-stay-nights-label" className="px-2 text-xs font-semibold text-muted-foreground">
          Estadía
        </ButtonGroupText>
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
        <ButtonGroupText className={cn("min-w-14 px-1 text-center text-xs font-semibold transition-colors duration-150", stayControlsDisabled ? "text-muted-foreground" : "text-foreground")}>
          {stayNights} noche{stayNights === 1 ? "" : "s"}
        </ButtonGroupText>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Agregar noche"
          onClick={() => onStayNightsChange(clampStayNights(stayNights + 1))}
          disabled={stayControlsDisabled || stayNights >= MAX_STAY_NIGHTS}
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
        >
          <AppIcon name="plus" />
        </Button>
      </ButtonGroup>
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
      <ButtonGroup className="gap-2">
        <Button type="button" variant="outline" size="icon" onClick={onDec} disabled={decDisabled} aria-label={`Quitar ${label.toLowerCase()}`} className="fd-control h-8 w-8">
          <AppIcon name="minus" />
        </Button>
        <ButtonGroupText className="w-6 text-center font-mono text-sm font-bold">{value}</ButtonGroupText>
        <Button type="button" variant="outline" size="icon" onClick={onInc} disabled={incDisabled} aria-label={`Agregar ${label.toLowerCase()}`} className="fd-control h-8 w-8">
          <AppIcon name="plus" />
        </Button>
      </ButtonGroup>
    </div>
  )
}

interface RuntimeSearchDatePolicy {
  minSearchDate: string
  maxSearchDate: string
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
    : addDays(minSearchDate, configured?.maxFutureDays ?? SEARCH_MAX_FUTURE_DAYS_FALLBACK)

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

function minIsoDate(left: string, right: string) {
  return left < right ? left : right
}

function diffDays(fromIso: string, toIso: string) {
  const from = new Date(`${fromIso}T00:00:00Z`).getTime()
  const to = new Date(`${toIso}T00:00:00Z`).getTime()
  return Math.round((to - from) / 86400000)
}

function clampStayNights(value: number) {
  const numeric = Number.isFinite(value) ? Math.trunc(value) : 7
  return Math.max(1, Math.min(MAX_STAY_NIGHTS, numeric))
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.max(min, Math.min(max, numeric))
}

function buildMigrationMonthOptions(startIso: string): MigrationMonthOption[] {
  const start = isIsoDate(startIso) ? startIso : localDateToIso(new Date())
  const [year, startMonth] = start.split("-").map(Number)
  const lastMonthIndex = Math.max(11, startMonth + LEGACY_DEFAULT_MIGRATION_MONTH_COUNT - 2)

  return Array.from({ length: lastMonthIndex + 1 }, (_, index) => {
    const optionYear = year + Math.floor(index / 12)
    const month = index % 12 + 1
    const key = `${optionYear}-${String(month).padStart(2, "0")}`
    const label = formatMigrationMonthLabel(key)
    const monthLabel = formatMigrationMonthName(key)
    return {
      key,
      label,
      monthLabel,
      shortLabel: label.replace(/\s+de\s+/i, " "),
      disabled: key < start.slice(0, 7),
    }
  })
}

function defaultMigrationMonthSelection(options: MigrationMonthOption[]) {
  return options.filter((month) => !month.disabled).slice(0, LEGACY_DEFAULT_MIGRATION_MONTH_COUNT).map((month) => month.key)
}

function resolveMigrationMonthSelection(values: string[] | undefined, options: MigrationMonthOption[]) {
  const fallback = defaultMigrationMonthSelection(options)
  if (!values?.length) return fallback

  const allowed = new Set(options.filter((month) => !month.disabled).map((month) => month.key))
  const selected = orderMigrationMonths(uniqueMonthKeys(values.filter((month) => allowed.has(month))), options)
  return selected.length ? buildMigrationMonthRangeSelection(selected[0], selected[selected.length - 1], options) : fallback
}

function resolveMigrationMonthRange(values: string[], options: MigrationMonthOption[]) {
  const selected = resolveMigrationMonthSelection(values, options)
  const fallback = defaultMigrationMonthSelection(options)
  const normalized = selected.length ? selected : fallback
  const start = normalized[0] ?? ""

  return {
    start,
    end: normalized[normalized.length - 1] ?? start,
  }
}

function buildMigrationMonthRangeSelection(start: string, end: string, options: MigrationMonthOption[]) {
  const enabledKeys = options.filter((month) => !month.disabled).map((month) => month.key)
  if (enabledKeys.length === 0) return []

  const startIndex = enabledKeys.indexOf(start)
  const endIndex = enabledKeys.indexOf(end)
  const resolvedStartIndex = startIndex >= 0 ? startIndex : Math.max(0, endIndex)
  const resolvedEndIndex = endIndex >= 0 ? endIndex : resolvedStartIndex
  const from = Math.min(resolvedStartIndex, resolvedEndIndex)
  const to = Math.max(resolvedStartIndex, resolvedEndIndex)

  return enabledKeys.slice(from, to + 1)
}

function uniqueMonthKeys(values: string[]) {
  return Array.from(new Set(values.filter(isMigrationMonthKey)))
}

function orderMigrationMonths(values: string[], options: MigrationMonthOption[]) {
  const selected = new Set(values)
  return options.map((month) => month.key).filter((key) => selected.has(key))
}

function isMigrationMonthKey(value: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
}

function formatMigrationMonthLabel(monthValue: string) {
  const label = MIGRATION_MONTH_LABEL_FORMATTER.format(new Date(`${monthValue}-01T00:00:00Z`))
  return label.charAt(0).toUpperCase() + label.slice(1)
}

function formatMigrationMonthName(monthValue: string) {
  const label = MIGRATION_MONTH_NAME_FORMATTER.format(new Date(`${monthValue}-01T00:00:00Z`))
  return label.charAt(0).toUpperCase() + label.slice(1)
}

interface SearchValidationInput {
  originValue: string
  destinationValue: string
  departureDate: string
  returnDate: string
  adults: number
  children: number
  infants: number
  trip: "round-trip" | "one-way"
  mode: SearchModeControl
  migrationMonths: string[]
  minDepartureDate: string
  minReturnDate: string
  maxStayNights: number
  maxDate?: string
}

interface SearchValidationState {
  origin?: string
  destination?: string
  departureDate?: string
  returnDate?: string
  passengers?: string
  migrationMonths?: string
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

  const passengerTotal = input.adults + input.children + input.infants
  if (!Number.isInteger(input.adults) || input.adults < 1) {
    state.passengers = "Debe viajar al menos un adulto."
  } else if (!Number.isInteger(input.children) || input.children < 0 || input.children > MAX_CHILDREN) {
    state.passengers = `La cantidad de niños debe estar entre 0 y ${MAX_CHILDREN}.`
  } else if (!Number.isInteger(input.infants) || input.infants < 0) {
    state.passengers = "La cantidad de bebés debe ser válida."
  } else if (input.infants > input.adults) {
    state.passengers = "La cantidad de bebés no puede superar la de adultos."
  } else if (passengerTotal > MAX_PASSENGERS) {
    state.passengers = `La búsqueda admite hasta ${MAX_PASSENGERS} pasajeros.`
  }

  if (input.mode === "migration") {
    if (input.migrationMonths.length === 0) {
      state.migrationMonths = "Selecciona al menos un mes."
    }
    return state
  }

  if (!input.departureDate) {
    state.departureDate = input.mode === "flexible"
      ? "Selecciona el inicio del rango."
      : "Selecciona una fecha de salida."
  } else if (!isIsoDate(input.departureDate)) {
    state.departureDate = "Fecha inválida."
  } else if (input.departureDate < input.minDepartureDate) {
    state.departureDate = `Debe ser igual o posterior a ${formatDateLabel(input.minDepartureDate)}.`
  } else if (input.maxDate && input.departureDate > input.maxDate) {
    state.departureDate = `Debe ser igual o anterior a ${formatDateLabel(input.maxDate)}.`
  }

  if (input.mode === "flexible") {
    if (!input.returnDate) {
      state.returnDate = "Selecciona el fin del rango."
    } else if (!isIsoDate(input.returnDate)) {
      state.returnDate = "Fecha inválida."
    } else if (isIsoDate(input.departureDate) && input.returnDate < input.departureDate) {
      state.returnDate = "El fin debe ser igual o posterior al inicio."
    } else if (input.returnDate < input.minReturnDate) {
      state.returnDate = `Debe ser igual o posterior a ${formatDateLabel(input.minReturnDate)}.`
    } else if (input.maxDate && input.returnDate > input.maxDate) {
      state.returnDate = `Debe ser igual o anterior a ${formatDateLabel(input.maxDate)}.`
    }
  } else if (input.trip === "round-trip") {
    if (!input.returnDate) {
      state.returnDate = "Selecciona una fecha de regreso."
    } else if (!isIsoDate(input.returnDate)) {
      state.returnDate = "Fecha inválida."
    } else if (input.returnDate < input.minReturnDate) {
      state.returnDate = `Debe ser igual o posterior a ${formatDateLabel(input.minReturnDate)}.`
    } else if (isIsoDate(input.departureDate) && diffDays(input.departureDate, input.returnDate) > input.maxStayNights) {
      state.returnDate = `La estadía máxima es de ${input.maxStayNights} noches.`
    } else if (input.maxDate && input.returnDate > input.maxDate) {
      state.returnDate = `Debe ser igual o anterior a ${formatDateLabel(input.maxDate)}.`
    }
  }

  return state
}

function hasBlockingValidationError(state: SearchValidationState) {
  return Boolean(state.origin || state.destination || state.departureDate || state.returnDate || state.passengers || state.migrationMonths)
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
  if (!isIsoDate(value)) return "Fecha inválida"
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
