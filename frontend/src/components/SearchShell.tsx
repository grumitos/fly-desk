import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type MouseEvent, type RefObject } from "react"
import { createPortal } from "react-dom"
import { Button } from "@/components/ui/button"
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group"
import { DateRangeField } from "@/components/ui/date-range-field"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Kbd, KbdHint } from "@/components/ui/kbd"
import { MonthRangeField } from "@/components/ui/month-range-field"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SegmentButton, SegmentedControl } from "@/components/ui/segmented-control"
import { TOPBAR_SEARCH_CONTROLS_ID } from "@/components/TopBar"
import { AppIcon, type AppIconName } from "@/components/ui/app-icon"
import { useAutocomplete } from "@/hooks/useAutocomplete"
import { clampIsoDate } from "@/lib/iso-date"
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
const DEFAULT_MIGRATION_MONTH_COUNT = 8
/* One 52px field (plate 1a) shared by Origen, Destino, Pasajeros and both halves
   of the merged date control, so the value baseline lands on the same y in all
   six. Geometry lives in `.fd-field-control` / `.fd-field-value`. */
const SEARCH_FIELD_CONTROL_CLASS = "fd-field-control w-full"
const SEARCH_FIELD_VALUE_CLASS = "fd-field-value"
const SEARCH_MAX_FUTURE_DAYS_FALLBACK = 365
/* Used only if the server did not inject the limits; they mirror the backend's
   own ceilings so the fallback advertises the truth rather than a guess. */
const MAX_STAY_NIGHTS_FALLBACK = 90
const MAX_PASSENGERS_FALLBACK = 9

/* Resolved once at module scope: the server writes `__FLYDESK_RUNTIME__` into
   `<head>` and this bundle is the last script in `<body>`, so the value is
   already there — and it cannot change during a session. */
const { maxStayNights: MAX_STAY_NIGHTS, maxPassengers: MAX_PASSENGERS } = getRuntimeSearchLimits()
const MAX_CHILDREN = 8
/* The Migratorio sweep is capped at twelve months, which is also the length of
   the search window, so the picker can never offer a range it cannot search. */
const MAX_MIGRATION_MONTHS = 12
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
  /* The pickable window, taken from the options the date policy produced rather
     than recomputed — one source for "how far ahead can this search reach". */
  const migrationMonthBounds = useMemo(() => {
    const selectable = migrationMonthOptions.filter((month) => !month.disabled)
    return {
      min: selectable[0]?.key ?? migrationMonthOptions[0]?.key ?? "",
      max: selectable[selectable.length - 1]?.key ?? migrationMonthOptions[migrationMonthOptions.length - 1]?.key ?? "",
    }
  }, [migrationMonthOptions])
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
  /* The merged control owns the stay ceiling now: it derives the return's upper
     bound from the departure the agent just picked, in one place. */
  const departureLabel = mode === "flexible" ? "Salida desde" : "Salida"
  const endDateLabel = mode === "flexible" ? "Salida hasta" : "Regreso"
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

  /* The month picker hands back a range; the request still travels as the list
     of months it covers, because that is what the backend fans out over. */
  const handleMigrationRangeChange = ({ startMonth, endMonth }: { startMonth: string; endMonth: string }) => {
    setSelectedMigrationMonths(buildMigrationMonthRangeSelection(startMonth, endMonth, migrationMonthOptions))
    setTouched((current) => ({ ...current, migrationMonths: true }))
  }

  /* Both halves of the merged control arrive together, so clamping the return
     against the new departure happens in one place instead of two. */
  const handleDateRangeChange = ({ startDate, endDate }: { startDate: string; endDate: string }) => {
    handleDepartureDateChange(startDate)
    setReturnDate(endDate ? clampIsoDate(endDate, datePolicy.minSearchDate, datePolicy.maxSearchDate) : "")
    setTouched((current) => ({ ...current, departureDate: true, returnDate: Boolean(endDate) || current.returnDate }))
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
    originValue: originCode || origin.query,
    destinationValue: destCode || destination.query,
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
  const reserveOriginSuggestionSpace = shouldShowUsageSuggestions
  const reserveDestinationSuggestionSpace = shouldShowUsageSuggestions
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
          <div className="fd-search-controls-row mb-2.5 flex flex-wrap items-center justify-between gap-2">
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

          {/* One control spanning the two date columns (plate 2e). In Migratorio
              the calendar of days gives up its place to the month picker (6c). */}
          <Field
            className={cn(
              "relative col-span-2 min-w-0",
              reserveIdleHelperSpace && "fd-search-field-shell",
            )}
          >
            {mode === "migration" ? (
              <MonthRangeField
                label="Meses"
                startMonth={migrationMonthRange.start}
                endMonth={migrationMonthRange.end}
                minMonth={migrationMonthBounds.min}
                maxMonth={migrationMonthBounds.max}
                maxSpan={MAX_MIGRATION_MONTHS}
                invalid={Boolean(visibleMigrationMonthsError)}
                onChange={handleMigrationRangeChange}
                onTouch={() => setTouched((current) => ({ ...current, migrationMonths: true }))}
              />
            ) : (
              <DateRangeField
                startLabel={departureLabel}
                endLabel={endDateLabel}
                startDate={departureDate}
                endDate={returnDate}
                minDate={datePolicy.minSearchDate}
                maxDate={datePolicy.maxSearchDate}
                maxStayNights={MAX_STAY_NIGHTS}
                endDisabled={mode === "exact" && trip === "one-way"}
                invalid={Boolean(visibleDepartureDateError || visibleReturnDateError)}
                onChange={handleDateRangeChange}
                onTouch={(half) => setTouched((current) => ({
                  ...current,
                  [half === "start" ? "departureDate" : "returnDate"]: true,
                }))}
              />
            )}
            <ControlHelper
              id="dates-helper"
              text={visibleMigrationMonthsError || visibleDepartureDateError || visibleReturnDateError}
            />
          </Field>

          <Popover
            open={paxOpen}
            onOpenChange={(nextOpen) => {
              setPaxOpen(nextOpen)
              if (nextOpen) setTouched((current) => ({ ...current, passengers: true }))
            }}
          >
            <Field className={cn("relative", reserveIdleHelperSpace && "fd-search-field-shell")}>
              <PopoverTrigger asChild>
                {/* A plain button, because the field *is* the control: the button
                    variants would layer a second height, radius, padding and
                    hover fill on top of the one `.fd-field-control` defines. */}
                <button
                  type="button"
                  aria-label="Seleccionar pasajeros"
                  aria-expanded={paxOpen}
                  aria-haspopup="dialog"
                  aria-invalid={Boolean(visiblePassengerError)}
                  aria-describedby={visiblePassengerError ? "passengers-helper" : undefined}
                  className={cn(
                    SEARCH_FIELD_CONTROL_CLASS,
                    "text-left",
                    visiblePassengerError && "fd-field-invalid",
                  )}
                >
                  <FieldLabel>Pasajeros</FieldLabel>
                  <AppIcon name="passengers" className="text-muted-foreground" />
                  <span className={SEARCH_FIELD_VALUE_CLASS}>
                    {passengerTotal} pasajero{passengerTotal > 1 ? "s" : ""}
                  </span>
                  <AppIcon name="chevronDown" className={`text-muted-foreground transition-transform ${paxOpen ? "rotate-180" : ""}`} />
                </button>
              </PopoverTrigger>

              <PopoverContent align="end" sideOffset={6} className="w-72 p-2.5">
                {/* The total against the ceiling, so the agent sees how much room
                    is left before a button goes dim rather than after. */}
                <div className="flex items-baseline justify-between gap-2 border-b border-border px-1 pb-2 pt-0.5">
                  <span className="fd-type-micro">Pasajeros</span>
                  <span className="fd-mono text-xs font-bold">{passengerTotal} de {MAX_PASSENGERS}</span>
                </div>
                <div className="grid gap-0.5 pt-1.5">
                  <PaxRow label="Adultos" detail="12+ años" value={adults} onInc={() => updateAdults(adults + 1)} onDec={() => updateAdults(adults - 1)} decDisabled={adults <= 1} incDisabled={adults >= MAX_PASSENGERS || passengerSlotsRemaining <= 0} />
                  <PaxRow label="Niños" detail="2-11 años" value={children} onInc={() => updateChildren(children + 1)} onDec={() => updateChildren(children - 1)} decDisabled={children <= 0} incDisabled={children >= MAX_CHILDREN || passengerSlotsRemaining <= 0} />
                  <PaxRow label="Bebés" detail="Menos de 2 años" value={infants} onInc={() => updateInfants(infants + 1)} onDec={() => updateInfants(infants - 1)} decDisabled={infants <= 0} incDisabled={infants >= adults || passengerSlotsRemaining <= 0} />
                </div>
                {/* Both rules in words. The one-infant-per-adult limit used to be
                    deducible only from a button that went dim. */}
                <p className="mx-1 mb-0.5 mt-2 border-t border-border pt-2 text-[11px] leading-[1.45] text-muted-foreground">
                  Máximo {MAX_PASSENGERS} por búsqueda · un bebé en falda por adulto
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
            size="xl"
            className={cn(
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

          {/* Plate 1a: the emptiness of the idle state is resolved with real
              material, not filler. The policy the agent needs *before* typing —
              the window, the stay ceiling, the passenger ceiling — instead of
              discovering each one by being rejected. */}
          {showLocationUsageSuggestions && (
            <div className="fd-policy-line">
              <p className="m-0">
                Ventana de búsqueda{" "}
                <b>{formatDateLabel(datePolicy.minSearchDate)} – {formatDateLabel(datePolicy.maxSearchDate)}</b>
                <span className="fd-policy-sep">·</span>
                hasta <b>{MAX_STAY_NIGHTS}</b> noches en ida y vuelta
                <span className="fd-policy-sep">·</span>
                hasta <b>{MAX_PASSENGERS}</b> pasajeros
              </p>
            </div>
          )}
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
          className={cn(!topbar && "flex-1 px-2 sm:flex-none sm:px-3.5")}
        >
          Exacto
        </SegmentButton>
        <SegmentButton
          value="flexible"
          className={cn(!topbar && "flex-1 px-2 sm:flex-none sm:px-3.5")}
        >
          Flexible
        </SegmentButton>
        <SegmentButton
          value="migration"
          className={cn(!topbar && "flex-1 px-2 sm:flex-none sm:px-3.5")}
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
            className={cn(!topbar && "flex-1 px-2 sm:flex-none sm:px-3.5")}
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
      <div
        ref={controlRef}
        onClick={focusInputFromControl}
        className={cn(
          SEARCH_FIELD_CONTROL_CLASS,
          "cursor-text",
          invalid && "fd-field-invalid",
        )}
      >
        <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>
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
          className={`${SEARCH_FIELD_VALUE_CLASS} w-auto rounded-none border-0 bg-transparent p-0 text-foreground shadow-none outline-none focus-visible:border-0 focus-visible:ring-0`}
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
        <div style={listboxStyle} className="fd-suggest-panel fd-motion-emergente">
          <div className="fd-suggest-head">
            <span className="fd-type-micro">Coincidencias</span>
            <span className="fd-mono text-xs font-semibold text-muted-foreground">{suggestions.length}</span>
          </div>

          {/* One row per result, with the IATA in a fixed column: it is what the
              agent reads first and what they type. */}
          <div id={listboxId} role="listbox" className="fd-scrollbar-hidden grid max-h-[288px] overflow-y-auto px-1.5 pb-1.5">
            {suggestions.map((suggestion, index) => (
              <button
                id={`${listboxId}-${index}`}
                key={`${suggestion.code}-${index}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className="fd-suggest-row"
                onMouseDown={(event) => {
                  event.preventDefault()
                  onSelect(suggestion)
                }}
              >
                {/* A city group gets a different glyph, because "all the airports
                    of this city" is a different kind of answer from one airport —
                    and a real quote almost always accepts any of the three. */}
                <span className="grid place-items-center text-muted-foreground">
                  <AppIcon name={isCityGroupSuggestion(suggestion) ? "cityGroup" : "airport"} size={14} />
                </span>
                <span className="fd-suggest-code">{suggestion.code}</span>
                <span className="grid min-w-0 gap-0.5">
                  <span className="fd-suggest-city">{suggestionCityLabel(suggestion)}</span>
                  <span className="fd-suggest-detail">{suggestionPlaceLabel(suggestion)}</span>
                </span>
              </button>
            ))}
          </div>

          {/* This search is used by typing, not by pointing, so the keys are on
              screen. They are icons from the same set, not mono glyphs. */}
          <div className="fd-suggest-foot">
            <KbdHint keys={<Kbd icon="enter" />} label="elegir" />
            <KbdHint
              keys={(
                <span className="inline-flex gap-1">
                  <Kbd icon="arrowUp" />
                  <Kbd icon="arrowDown" />
                </span>
              )}
              label="navegar"
            />
            <KbdHint keys={<Kbd>esc</Kbd>} label="cerrar" />
          </div>
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
      className={cn("fd-quick-chips", exiting && "fd-motion-exit")}
      aria-label={`Estaciones frecuentes de ${label.toLowerCase()}`}
    >
      {/* Real material in the space the old layout reserved and left blank: the
          stations this desk actually searches, already ranked by the backend. */}
      {suggestions.map((code) => (
        <button
          key={`${fieldId}-${code}`}
          type="button"
          className="fd-quick-chip fd-focus-ring"
          aria-label={`Usar ${code} como ${label.toLowerCase()}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            void onSelect(code)
          }}
        >
          {code}
        </button>
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

/** The city carries the title weight; the airport and country are the detail. */
function suggestionCityLabel(suggestion: LocationSuggestion): string {
  const city = suggestion.city?.trim()
  if (city) return city

  return suggestionPlaceLabel(suggestion).split(",")[0]?.trim() || suggestion.code
}

/**
 * Whether this row stands for a whole city rather than one airport. The backend
 * marks city entries with a `CITY` type on some providers and not on others, so
 * this also treats "todos los aeropuertos" phrasing as the same thing.
 */
function isCityGroupSuggestion(suggestion: LocationSuggestion): boolean {
  const type = String((suggestion as LocationSuggestion & { type?: string }).type ?? "").toUpperCase()
  if (type === "CITY") return true

  return /todos los aeropuertos/i.test(suggestion.label ?? "")
}

function ControlHelper({ id, text }: { id: string; text?: string }) {
  if (!text) return null

  return <p id={id} className="fd-control-helper">{text}</p>
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
    <div className="flex h-11 items-center gap-2.5 rounded-lg px-1 transition-colors duration-[90ms] hover:bg-muted">
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold leading-tight">{label}</span>
        <span className="block text-[11px] leading-tight text-muted-foreground">{detail}</span>
      </span>
      {/* 32px counters, not 20: a ± you have to aim at is a ± you mis-hit, and
          the pair must not move when one side reaches its limit — so a disabled
          button dims in place rather than disappearing. */}
      <span className="inline-flex items-center gap-0.5">
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={onDec}
          disabled={decDisabled}
          aria-label={`Quitar ${label.toLowerCase()}`}
        >
          <AppIcon name="minus" size={14} />
        </Button>
        <span className="grid min-w-[26px] place-items-center font-mono text-sm font-bold tabular-nums">{value}</span>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={onInc}
          disabled={incDisabled}
          aria-label={`Agregar ${label.toLowerCase()}`}
        >
          <AppIcon name="plus" size={14} />
        </Button>
      </span>
    </div>
  )
}

/*
 * The search policy the idle screen advertises (plate 1a) and the form enforces.
 *
 * The server injects `window.__FLYDESK_RUNTIME__` (see `src/server.ts`), so the
 * date window already comes from the backend and honours `SEARCH_MAX_FUTURE_DAYS`
 * / `SEARCH_TODAY_OVERRIDE`. The two ceilings did not: they were frontend
 * constants that happened to agree with the backend's own limits
 * (`MAX_FLEXIBLE_STAY_NIGHTS` in `src/core/flexible-search.ts`, and the
 * passenger check in `src/http-search-contract.ts`).
 *
 * That is the failure mode plate 1a exists to prevent: the line promises a
 * policy, so if the backend tightened its ceiling to 8 the screen would keep
 * advertising 9 and the agent would find out only after being rejected. They are
 * read from the runtime config now, with the current values as the fallback, so
 * adding the fields server-side is enough — no second change here.
 */
interface RuntimeSearchDatePolicy {
  minSearchDate: string
  maxSearchDate: string
  maxFutureDays?: number
}

interface RuntimeSearchLimits {
  maxStayNights: number
  maxPassengers: number
}

declare global {
  interface Window {
    __FLYDESK_RUNTIME__?: {
      searchDatePolicy?: RuntimeSearchDatePolicy
      maxStayNights?: number
      maxPassengers?: number
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

function getRuntimeSearchLimits(): RuntimeSearchLimits {
  const runtime = window.__FLYDESK_RUNTIME__

  return {
    maxStayNights: positiveInteger(runtime?.maxStayNights) ?? MAX_STAY_NIGHTS_FALLBACK,
    maxPassengers: positiveInteger(runtime?.maxPassengers) ?? MAX_PASSENGERS_FALLBACK,
  }
}

function positiveInteger(value: unknown): number | undefined {
  const numeric = Number(value)
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined
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
  const start = isIsoDate(startIso) ? startIso : todayIso()
  const [year, startMonth] = start.split("-").map(Number)
  const lastMonthIndex = startMonth + DEFAULT_MIGRATION_MONTH_COUNT - 2

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
  return options.filter((month) => !month.disabled).slice(0, DEFAULT_MIGRATION_MONTH_COUNT).map((month) => month.key)
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

  return enabledKeys.slice(from, to + 1).slice(0, DEFAULT_MIGRATION_MONTH_COUNT)
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
    } else if (input.migrationMonths.length > DEFAULT_MIGRATION_MONTH_COUNT) {
      state.migrationMonths = `Selecciona hasta ${DEFAULT_MIGRATION_MONTH_COUNT} meses.`
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

function isValidLocationCandidate(value: string) {
  return /^[A-Z]{3}$/.test(value)
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
