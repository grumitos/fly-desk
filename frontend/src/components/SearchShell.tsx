import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type MouseEvent, type RefObject } from "react"
import { createPortal } from "react-dom"
import { Button } from "@/components/ui/button"
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group"
import { DateRangeField } from "@/components/ui/date-range-field"
import { DisclosureIcon } from "@/components/ui/disclosure-icon"
import { SwapIcon } from "@/components/ui/swap-icon"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Kbd, KbdHint } from "@/components/ui/kbd"
import { ShortcutTooltip } from "@/components/ui/tooltip"
import { MonthRangeField } from "@/components/ui/month-range-field"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SegmentedControl, SegmentedOption } from "@/components/ui/segmented-control"
import { Sheet } from "@/components/ui/sheet"
import { TOPBAR_SEARCH_CONTROLS_ID } from "@/components/TopBar"
import { AppIcon, type AppIconName } from "@/components/ui/app-icon"
import { MIN_MATCH_QUERY, useAutocomplete } from "@/hooks/useAutocomplete"
import { clampIsoDate, isIsoDate } from "@/lib/iso-date"
import {
  emptyLocationUsageSuggestions,
  getLocationUsageSuggestions,
  type LocationUsageSuggestionGroups,
} from "@/lib/location-usage-suggestions"
import { returnExitDuration, useLeaveWindow } from "@/lib/search-choreography"
import { cn } from "@/lib/utils"
import type { LocationSuggestion, SearchRequest, SortMode } from "@/types"

const DATE_LABEL_FORMATTER = new Intl.DateTimeFormat("es-PE", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
})
const COMPACT_POLICY_DATE_FORMATTER = new Intl.DateTimeFormat("es-PE", {
  day: "2-digit",
  month: "short",
  year: "2-digit",
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
const MAX_LAP_INFANTS_PER_ADULT_FALLBACK = 1

/* Resolved once at module scope: the server writes `__FLYDESK_RUNTIME__` into
   `<head>` and this bundle is the last script in `<body>`, so the value is
   already there — and it cannot change during a session. */
const {
  maxStayNights: MAX_STAY_NIGHTS,
  maxPassengers: MAX_PASSENGERS,
  maxLapInfantsPerAdult: MAX_LAP_INFANTS_PER_ADULT,
} = getRuntimeSearchLimits()
const MAX_CHILDREN = 8
/* The Migratorio sweep is capped at twelve months, which is also the length of
   the search window, so the picker can never offer a range it cannot search. */
const MAX_MIGRATION_MONTHS = 12
type SearchModeControl = "exact" | "flexible" | "migration"
type SearchTouchedField = "origin" | "destination" | "departureDate" | "returnDate" | "passengers" | "migrationMonths"
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
  compactActive?: boolean
  mobilePresentation?: boolean
  mobilePolicyTarget?: HTMLElement | null
  showLocationUsageSuggestions?: boolean
  /** The idle screen itself, which is the only place the policy line belongs. */
  idle?: boolean
  /** The 120ms of 07 §1 during which the frequent chips are still on screen. */
  usageSuggestionsLeaving?: boolean
  /** True once the workspace is on screen, on any armazón. */
  workspaceActive?: boolean
  /** 11 §2.4 · the agent has gone back to edit, with the results behind. */
  editing?: boolean
  onEditingChange?: (editing: boolean) => void
  /** The stage FLIPs these into the title bar; it needs to be able to measure them. */
  controlsRef?: RefObject<HTMLDivElement | null>
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
  compactActive = false,
  mobilePresentation = false,
  mobilePolicyTarget = null,
  showLocationUsageSuggestions = false,
  idle = false,
  usageSuggestionsLeaving = false,
  workspaceActive = false,
  editing = false,
  onEditingChange,
  controlsRef,
  syncedRequest = null,
  resetToken = 0,
  onSearchConfigDraftChange,
}: SearchShellProps) {
  const [mode, setMode] = useState<SearchModeControl>("exact")
  const [trip, setTrip] = useState<"round-trip" | "one-way">("round-trip")
  const [originCode, setOriginCode] = useState("")
  const [destCode, setDestCode] = useState("")
  /** Bumped by `swapRoute`, so the two field values re-enter with movement 10. */
  const [swapToken, setSwapToken] = useState(0)
  const [originMeta, setOriginMeta] = useState<SearchLocationMeta>({})
  const [destinationMeta, setDestinationMeta] = useState<SearchLocationMeta>({})
  const [departureDate, setDepartureDate] = useState("")
  const [returnDate, setReturnDate] = useState("")
  const [stayNights, setStayNights] = useState(7)
  const [adults, setAdults] = useState(1)
  const [children, setChildren] = useState(0)
  const [infants, setInfants] = useState(0)
  const [paxOpen, setPaxOpen] = useState(false)
  const [usageSuggestions, setUsageSuggestions] = useState<LocationUsageSuggestionGroups>(() => emptyLocationUsageSuggestions())
  const datePolicy = useMemo(() => getRuntimeSearchDatePolicy(), [])
  const migrationMonthOptions = useMemo(
    () => buildMigrationMonthOptions(datePolicy.minSearchDate),
    [datePolicy.minSearchDate],
  )
  const [selectedMigrationMonths, setSelectedMigrationMonths] = useState<string[]>([])
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
  useEffect(() => {
    if (!syncedRequest) return

    const frame = window.requestAnimationFrame(() => {
      onEditingChange?.(false)
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
        Math.min(
          nextAdults * MAX_LAP_INFANTS_PER_ADULT,
          Math.max(0, MAX_PASSENGERS - nextAdults - nextChildren),
        ),
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
  }, [migrationMonthOptions, onEditingChange, resolveDestinationQuery, resolveOriginQuery, setDestinationQuery, setOriginQuery, syncedRequest])

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
      setSelectedMigrationMonths([])
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
  }, [onSearchConfigDraftChange, resetToken, setDestinationQuery, setOriginQuery])

  const updateAdults = (nextAdults: number) => {
    const clampedAdults = Math.max(1, Math.min(nextAdults, MAX_PASSENGERS))
    const clampedChildren = Math.min(children, Math.max(0, MAX_PASSENGERS - clampedAdults))
    const clampedInfants = Math.min(
      infants,
      clampedAdults * MAX_LAP_INFANTS_PER_ADULT,
      Math.max(0, MAX_PASSENGERS - clampedAdults - clampedChildren),
    )
    setAdults(clampedAdults)
    setChildren(clampedChildren)
    setInfants(clampedInfants)
    setTouched((current) => ({ ...current, passengers: true }))
  }

  const updateChildren = (nextChildren: number) => {
    const clampedChildren = Math.max(0, Math.min(nextChildren, MAX_CHILDREN, MAX_PASSENGERS - adults))
    setChildren(clampedChildren)
    setInfants((current) => Math.min(
      current,
      adults * MAX_LAP_INFANTS_PER_ADULT,
      Math.max(0, MAX_PASSENGERS - adults - clampedChildren),
    ))
    setTouched((current) => ({ ...current, passengers: true }))
  }

  const updateInfants = (nextInfants: number) => {
    setInfants(Math.max(0, Math.min(
      nextInfants,
      adults * MAX_LAP_INFANTS_PER_ADULT,
      MAX_PASSENGERS - adults - children,
    )))
    setTouched((current) => ({ ...current, passengers: true }))
  }

  const handleDepartureDateChange = (nextDate: string) => {
    const clampedDate = clampIsoDate(nextDate, datePolicy.minSearchDate, datePolicy.maxSearchDate)
    /* 11 §2.2 · «el aspa borra **las dos** fechas». Emptying the departure is a
       gesture of the ficha, not an edge case, and there is no ceiling to derive
       from a date that no longer exists: `addDays("")` builds an Invalid Date
       and `toISOString()` throws, which aborted the update and left the control
       showing the dates the agent had just asked to remove. */
    const maxReturnDate = mode === "exact" && trip === "round-trip" && isIsoDate(clampedDate)
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

  /*
   * Movement 10 (07 §4): what crosses is the *content* of the two fields, in
   * 140ms — the icon does not turn, and 07 §5 names it among the things that
   * never move. The token bumps on every swap so the two values re-enter with
   * the cross-fade instead of being replaced between two frames; without it the
   * only feedback for the gesture was that the words were suddenly elsewhere.
   */
  const swapRoute = () => {
    setOriginCode(destCode)
    setDestCode(originCode)
    setOriginMeta(destinationMeta)
    setDestinationMeta(originMeta)
    origin.setQuery(destination.query)
    destination.setQuery(origin.query)
    setSwapToken((current) => current + 1)
  }

  /*
   * The frequent-station chips are a standing shortcut, not a one-shot prompt.
   * Using one used to fade its whole row away, so the second field lost the
   * shortcut the moment the first was filled, and re-picking meant typing. They
   * stay put now; the idle screen is the only place they appear at all.
   */
  const applyOriginUsageSuggestion = async (code: string) => {
    setOriginCode(code)
    origin.setQuery(code)
    setTouched((current) => ({ ...current, origin: true }))
    const resolved = await origin.resolveCurrentQuery()
    if (resolved) setOriginCode(resolved.code)
  }

  const applyDestinationUsageSuggestion = async (code: string) => {
    setDestCode(code)
    destination.setQuery(code)
    setTouched((current) => ({ ...current, destination: true }))
    const resolved = await destination.resolveCurrentQuery()
    if (resolved) setDestCode(resolved.code)
  }

  const applyMobileUsageSuggestion = async (code: string) => {
    if (!isValidLocationCandidate(originCode)) {
      await applyOriginUsageSuggestion(code)
      return
    }

    await applyDestinationUsageSuggestion(code)
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
    onEditingChange?.(false)
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
  const mobileSummaryExit = useLeaveWindow(compactActive && !editing, returnExitDuration)
  /* The chips outlive the screen they belong to by the 180ms of their row in
     07 §1 — but only the chips. The space the fields reserve for them is
     released at once, because what the table has travelling upward is the block
     of fields, and it cannot travel while it is still holding their height. */
  const shouldRenderQuickChips = shouldShowUsageSuggestions || usageSuggestionsLeaving
  const reserveIdleHelperSpace = shouldShowUsageSuggestions
  const reserveOriginSuggestionSpace = shouldShowUsageSuggestions
  const reserveDestinationSuggestionSpace = shouldShowUsageSuggestions
  const mobileQuickSuggestions = Array.from(new Set([
    ...usageSuggestions.frequent.origin,
    ...usageSuggestions.frequent.destination,
  ])).slice(0, 5)
  /* No transition on the tracks: no plate animates a grid re-flowing. Plate 2h
     moves the block of fields with `translateY`, and the tracks simply arrive
     at their new widths. */
  const searchGridClassName = "fd-search-grid grid gap-1.5"
  const visibleMigrationMonthsError = mode === "migration" && touched.migrationMonths
    ? validation.migrationMonths
    : undefined
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
      ref={controlsRef}
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

  const dateSummary = mode === "migration"
    ? [
        migrationMonthRange.start ? formatMigrationMonthName(migrationMonthRange.start) : "Meses",
        migrationMonthRange.end ? formatMigrationMonthName(migrationMonthRange.end) : "seleccionar",
      ].join(" – ")
    : [departureDate, trip === "round-trip" ? returnDate : null]
        .filter((value): value is string => Boolean(value))
        .map(formatDateLabel)
        .join(" – ")
  const modeLabel = mode === "migration" ? "Migratorio" : mode === "flexible" ? "Flexible" : "Exacto"
  const mobileSummary = (
    /*
     * Plate 1d — the search collapsed to one line. The mode is no longer a
     * control here: it is read as the last word of the summary, and changing
     * it means going back in to edit (02 §4). The pencil is a 44px target
     * because it is the only way back out.
     */
    <button
      type="button"
      className="fd-mobile-search-summary fd-focus-ring"
      aria-label="Editar búsqueda"
      onClick={() => onEditingChange?.(true)}
    >
      <span className="fd-mobile-search-lead">
        <span className="fd-mobile-search-route">
          <span>{originCode || "Origen"}</span>
          <AppIcon name="swap" size={14} className="text-muted-foreground" />
          <span>{destCode || "Destino"}</span>
        </span>
        <span className="fd-mobile-search-meta">
          {dateSummary || "Fechas"} · {passengerTotal} pasajero{passengerTotal === 1 ? "" : "s"} · {modeLabel}
        </span>
      </span>
      <span className="fd-mobile-search-edit" aria-hidden="true">
        <AppIcon name="edit" size={18} />
      </span>
    </button>
  )

  if (compactActive && !editing) {
    return (
      <section className="fd-mobile-search-summary-shell" aria-busy={loading}>
        {mobileSummary}
      </section>
    )
  }

  /* «El resumen se funde» while the block grows underneath it (2h). It has to
     leave the flow to do that — two forms stacked would double the height the
     growth is animating towards — so it fades on top of the one replacing it. */
  const leavingSummary = mobileSummaryExit.leaving ? (
    <section
      className="fd-mobile-search-summary-shell fd-motion-exit"
      data-leaving="true"
      aria-hidden="true"
    >
      {mobileSummary}
    </section>
  ) : null

  const handlePaxOpenChange = (nextOpen: boolean) => {
    setPaxOpen(nextOpen)
    if (nextOpen) setTouched((current) => ({ ...current, passengers: true }))
  }
  const passengerButton = (
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
      onClick={mobilePresentation ? () => handlePaxOpenChange(true) : undefined}
    >
      <FieldLabel>Pasajeros</FieldLabel>
      <AppIcon name="passengers" className="text-muted-foreground" />
      <span className={SEARCH_FIELD_VALUE_CLASS}>
        {passengerTotal} pasajero{passengerTotal > 1 ? "s" : ""}
      </span>
      <DisclosureIcon open={paxOpen} className="text-muted-foreground" />
    </button>
  )
  const passengerPickerBody = (
    <>
      <div className="fd-pax-rows">
        <PaxRow label="Adultos" detail="12+ años" value={adults} onInc={() => updateAdults(adults + 1)} onDec={() => updateAdults(adults - 1)} decDisabled={adults <= 1} incDisabled={adults >= MAX_PASSENGERS || passengerSlotsRemaining <= 0} />
        <PaxRow label="Niños" detail="2-11 años" value={children} onInc={() => updateChildren(children + 1)} onDec={() => updateChildren(children - 1)} decDisabled={children <= 0} incDisabled={children >= MAX_CHILDREN || passengerSlotsRemaining <= 0} />
        <PaxRow label="Bebés" detail="Menos de 2 años" value={infants} onInc={() => updateInfants(infants + 1)} onDec={() => updateInfants(infants - 1)} decDisabled={infants <= 0} incDisabled={infants >= adults * MAX_LAP_INFANTS_PER_ADULT || passengerSlotsRemaining <= 0} />
      </div>
      <p className="fd-pax-note">
        Máximo {MAX_PASSENGERS} por búsqueda · {MAX_LAP_INFANTS_PER_ADULT === 1
          ? "un bebé en falda por adulto"
          : `hasta ${MAX_LAP_INFANTS_PER_ADULT} bebés en falda por adulto`}
      </p>
    </>
  )

  return (
    <>
      {topbarControlsTarget ? createPortal(searchControls, topbarControlsTarget) : null}
      {leavingSummary}
      <section className="overflow-visible" aria-busy={loading}>
        {!shouldPortalControls && (
          <div className="fd-search-controls-row mb-2.5 flex flex-wrap items-center justify-between gap-2">
            {searchControls}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div
            className={searchGridClassName}
            /* 11 §2.4 · «Editar la búsqueda (escritorio: clic en un campo)».
               Capture, because the focus lands on an input three components
               down and this only needs to know that it happened. The CTA is in
               the same grid and is not a field: pressing Buscar is the opposite
               gesture, and treating it as editing would undo the sequence it
               just started. */
            onFocusCapture={(event) => {
              if (!workspaceActive || editing) return
              if ((event.target as HTMLElement).closest("[data-fd-search-submit]")) return
              onEditingChange?.(true)
            }}
          >
            <div className="fd-route-fields">
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
              quickSuggestions={!mobilePresentation && shouldRenderQuickChips && !origin.open ? usageSuggestions.frequent.origin : []}
              recentSuggestions={shouldShowUsageSuggestions ? usageSuggestions.recent.origin : []}
              frequentSuggestions={shouldShowUsageSuggestions ? usageSuggestions.frequent.origin : []}
              quickSuggestionsLeavingIdle={usageSuggestionsLeaving}
              onQuickSuggestionSelect={applyOriginUsageSuggestion}
              reserveHelperSpace={reserveIdleHelperSpace && !mobilePresentation}
              reserveSuggestionSpace={reserveOriginSuggestionSpace && !mobilePresentation}
              invalid={Boolean(visibleOriginError)}
              helperText={visibleOriginError}
              mobilePresentation={mobilePresentation}
              swapToken={swapToken}
            />

          <div className="fd-route-swap-cell">
            <Button
              type="button"
              variant="secondary"
              size="icon"
              onClick={swapRoute}
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              aria-label="Intercambiar ruta"
            >
              <SwapIcon />
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
            quickSuggestions={!mobilePresentation && shouldRenderQuickChips && !destination.open ? usageSuggestions.frequent.destination : []}
            recentSuggestions={shouldShowUsageSuggestions ? usageSuggestions.recent.destination : []}
            frequentSuggestions={shouldShowUsageSuggestions ? usageSuggestions.frequent.destination : []}
            quickSuggestionsLeavingIdle={usageSuggestionsLeaving}
            onQuickSuggestionSelect={applyDestinationUsageSuggestion}
            reserveHelperSpace={reserveIdleHelperSpace && !mobilePresentation}
            reserveSuggestionSpace={reserveDestinationSuggestionSpace && !mobilePresentation}
            invalid={Boolean(visibleDestinationError)}
            helperText={visibleDestinationError}
            mobilePresentation={mobilePresentation}
            swapToken={swapToken}
          />
          </div>
          {/* One control spanning the two date columns (plate 2e). In Migratorio
              the calendar of days gives up its place to the month picker (6c). */}
          <Field
            className={cn(
              "relative min-w-0",
              reserveIdleHelperSpace && !mobilePresentation && "fd-search-field-shell",
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
                mobile={mobilePresentation}
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
                startInvalid={Boolean(visibleDepartureDateError)}
                endInvalid={Boolean(visibleReturnDateError)}
                errorId="dates-helper"
                onChange={handleDateRangeChange}
                onTouch={(half) => setTouched((current) => ({
                  ...current,
                  [half === "start" ? "departureDate" : "returnDate"]: true,
                }))}
                mobile={mobilePresentation}
              />
            )}
            <ControlHelper
              id="dates-helper"
              text={visibleMigrationMonthsError || visibleDepartureDateError || visibleReturnDateError}
            />
          </Field>

          {mobilePresentation ? (
            <Field className={cn("relative", reserveIdleHelperSpace && !mobilePresentation && "fd-search-field-shell")}>
              {passengerButton}
              <ControlHelper id="passengers-helper" text={visiblePassengerError} />
              <Sheet
                open={paxOpen}
                onOpenChange={handlePaxOpenChange}
                title="Pasajeros"
                meta={`${passengerTotal} de ${MAX_PASSENGERS}`}
                placement="bottom"
                size="partial"
                className="fd-passenger-sheet"
                footer={(
                  /* Plate 2d closes the sheet with one 52px primary. It confirms
                     nothing new — the counters already applied — it just gives
                     the thumb a target that is not the 44px close. */
                  <button
                    type="button"
                    className="fd-sheet-action fd-focus-ring"
                    onClick={() => handlePaxOpenChange(false)}
                  >
                    <AppIcon name="check" size={18} />
                    Aplicar
                  </button>
                )}
              >
                {passengerPickerBody}
              </Sheet>
            </Field>
          ) : (
            <Popover open={paxOpen} onOpenChange={handlePaxOpenChange}>
              <Field className={cn("relative", reserveIdleHelperSpace && "fd-search-field-shell")}>
                <PopoverTrigger asChild>{passengerButton}</PopoverTrigger>
                <PopoverContent align="end" sideOffset={6} className="fd-pax-popover">
                  {/* The total against the ceiling, so the agent sees how much room
                      is left before a button goes dim rather than after. */}
                  <div className="fd-pax-popover-head">
                    <span className="fd-type-micro">Pasajeros</span>
                    <span className="fd-mono text-xs font-bold">{passengerTotal} de {MAX_PASSENGERS}</span>
                  </div>
                  {passengerPickerBody}
                </PopoverContent>
                <ControlHelper id="passengers-helper" text={visiblePassengerError} />
              </Field>
            </Popover>
          )}

          <ShortcutTooltip label={loading ? "Detener búsqueda" : "Buscar"} shortcut={<Kbd icon="enter" />}>
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
            data-fd-search-submit=""
            disabled={!loading && hasValidationError}
            size="xl"
            className={cn(
              loading && "group border border-primary/40 hover:border-destructive hover:bg-destructive hover:text-destructive-foreground",
            )}
          >
            {loading ? (
              <>
                <span className="relative grid h-4 w-4 place-items-center">
                  <AppIcon name="loading" spin className="transition-opacity duration-[var(--fd-dur-tacto)] ease-[var(--fd-ease-tacto)] group-hover:opacity-0" />
                  <AppIcon name="x" className="absolute opacity-0 transition-opacity duration-[var(--fd-dur-tacto)] ease-[var(--fd-ease-tacto)] group-hover:opacity-100" />
                </span>
                <span className="relative inline-grid min-w-16">
                  <span className="transition-opacity duration-[var(--fd-dur-tacto)] ease-[var(--fd-ease-tacto)] group-hover:opacity-0">{loadingLabel}</span>
                  <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-[var(--fd-dur-tacto)] ease-[var(--fd-ease-tacto)] group-hover:opacity-100">
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
          </ShortcutTooltip>
          </div>

          {/* 03 §4 · one row for both fields, pressed in order. It is the same
              strip as the desk's — the phone only merges the two lists and puts
              a title on them; the geometry comes from the armazón. */}
          {mobilePresentation && shouldShowUsageSuggestions && mobileQuickSuggestions.length > 0 && (
            <LocationUsageSuggestionRow
              fieldId="mobile-route"
              label="en la ruta"
              heading="Frecuentes"
              suggestions={mobileQuickSuggestions}
              onSelect={applyMobileUsageSuggestion}
            />
          )}

          {/* Plate 1a: the emptiness of the idle state is resolved with real
              material, not filler. The policy the agent needs *before* typing —
              the window, the stay ceiling, the passenger ceiling — instead of
              discovering each one by being rejected.

              Keyed to the idle screen and not to the chips: 03 §8 puts these
              two lines «al pie del reposo», the same clause that keeps the
              provider rail there. Going back to edit (11 §2.4) brings the chips
              back because they are part of the form; it does not bring back the
              foot of a screen that is no longer on show. */}
          {idle && mobilePresentation && mobilePolicyTarget
            ? createPortal(
                <div className="fd-policy-line fd-policy-line--mobile">
                  <p className="m-0">
                    Ventana{" "}
                    <b>{formatCompactPolicyDateLabel(datePolicy.minSearchDate)} – {formatCompactPolicyDateLabel(datePolicy.maxSearchDate)}</b>
                    <span className="fd-policy-sep">·</span>
                    hasta <b>{MAX_STAY_NIGHTS}</b> noches
                  </p>
                </div>,
                mobilePolicyTarget,
              )
            : idle && !mobilePresentation && (
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
  ref,
  mode,
  trip,
  tripTabs,
  stayNights,
  onModeChange,
  onTripChange,
  onStayNightsChange,
  topbar,
}: {
  ref?: RefObject<HTMLDivElement | null>
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

  /*
   * One component, two mounting points (02 §4): the title bar once a search is
   * running, the form while it is at rest. In armazón C the title-bar slot is
   * empty and these live in the form, stacked full width at the touch minimum —
   * which is why the shape comes from a container query and not from a prop.
   *
   * Changing mounting point is exactly what makes 07 §1 call this a FLIP: the
   * element is rebuilt somewhere else, so the stage measures it here before the
   * move and plays the difference away. Hence the ref reaching in from `App`.
   */
  return (
    <div ref={ref} className="fd-trip-mode-controls" data-placement={topbar ? "topbar" : "form"}>
      <SegmentedControl
        aria-label="Modo de búsqueda"
        value={mode}
        onValueChange={(value) => {
          if (value === "exact" || value === "flexible" || value === "migration") onModeChange(value)
        }}
      >
        <SegmentedOption value="exact">Exacto</SegmentedOption>
        <SegmentedOption value="flexible">Flexible</SegmentedOption>
        <SegmentedOption value="migration">Migratorio</SegmentedOption>
      </SegmentedControl>

      <div
        aria-hidden={!flexibleControlsActive}
        className={cn(
          "fd-inline-reveal min-w-0",
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

      {/* Migratorio sweeps months, so there is no return leg to choose: the
          control goes to `opacity:.45` in place and keeps its value (11 §1). */}
      <SegmentedControl
        aria-label="Tipo de viaje"
        value={displayedTrip}
        onValueChange={(value) => {
          if (value === "round-trip" || value === "one-way") onTripChange(value)
        }}
        disabled={tripControlsDisabled}
      >
        {tripTabs.map((item) => (
          <SegmentedOption key={item.key} value={item.key} icon={item.icon}>
            {item.label}
          </SegmentedOption>
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
  onFocus,
  onBlur,
  onKeyDown,
  onChange,
  onSelect,
  quickSuggestions = [],
  recentSuggestions = [],
  frequentSuggestions = [],
  quickSuggestionsExiting = false,
  quickSuggestionsLeavingIdle = false,
  onQuickSuggestionSelect,
  reserveHelperSpace = false,
  reserveSuggestionSpace = false,
  invalid = false,
  helperText,
  mobilePresentation = false,
  swapToken = 0,
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
  recentSuggestions?: string[]
  frequentSuggestions?: string[]
  quickSuggestionsExiting?: boolean
  quickSuggestionsLeavingIdle?: boolean
  onQuickSuggestionSelect?: (code: string) => void | Promise<void>
  reserveHelperSpace?: boolean
  reserveSuggestionSpace?: boolean
  invalid?: boolean
  helperText?: string
  mobilePresentation?: boolean
  /** Movement 10: bumped on every route swap so the value re-enters. */
  swapToken?: number
}) {
  const fieldId = `location-${label.toLowerCase()}`
  const listboxId = `${fieldId}-suggestions`
  const fieldRef = useRef<HTMLDivElement | null>(null)
  const controlRef = useRef<HTMLDivElement | null>(null)
  const fieldInputRef = useRef<HTMLInputElement | null>(null)
  const [listboxStyle, setListboxStyle] = useState<CSSProperties | null>(null)
  const [usageActiveIndex, setUsageActiveIndex] = useState(-1)
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false)
  const usageOptions = useMemo(() => [
    ...recentSuggestions.map((code) => ({ code, heading: "Recientes" as const })),
    ...frequentSuggestions.map((code) => ({ code, heading: "Frecuentes" as const })),
  ], [frequentSuggestions, recentSuggestions])
  const presentationOpen = mobilePresentation ? mobileSheetOpen : open
  /* 11 §2.1 puts the changeover at two letters, not at one: with a single
     letter «nada cambia en la lista, se sigue viendo Recientes». Below the
     threshold the field has not narrowed anything down, and swapping the
     agent's own history for one stray match was the panel jumping under their
     hands on the first keystroke. */
  const shouldShowUsagePanel = presentationOpen
    && value.trim().length < MIN_MATCH_QUERY
    && Boolean(onQuickSuggestionSelect)
    && usageOptions.length > 0
  const shouldShowMatchesPanel = presentationOpen
    && suggestions.length > 0
    && value.trim().length >= MIN_MATCH_QUERY
  const shouldShowListbox = shouldShowUsagePanel || shouldShowMatchesPanel
  const activeOptionId = shouldShowUsagePanel
    && usageActiveIndex >= 0
    && usageOptions[usageActiveIndex]
    ? `${listboxId}-usage-${usageActiveIndex}`
    : activeIndex >= 0 && suggestions[activeIndex]
      ? `${listboxId}-${activeIndex}`
      : undefined
  const listboxTarget = typeof document === "undefined" ? null : document.body

  const handleLocationKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (mobilePresentation && event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      setMobileSheetOpen(false)
      void onBlur()
      return
    }
    /* 11 §7: in the searcher `Esc` clears the focused field when it holds text.
       Only then — on an empty field it belongs to whatever is open above, and
       swallowing it there would strand a popover the agent meant to close. */
    if (event.key === "Escape" && value.length > 0) {
      event.preventDefault()
      event.stopPropagation()
      onChange("")
      return
    }
    if (shouldShowUsagePanel && onQuickSuggestionSelect) {
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setUsageActiveIndex((current) => Math.min(current + 1, usageOptions.length - 1))
        return
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        setUsageActiveIndex((current) => current <= 0
          ? usageOptions.length - 1
          : Math.min(current - 1, usageOptions.length - 1))
        return
      }
      if (event.key === "Enter" && usageActiveIndex >= 0) {
        event.preventDefault()
        const selected = usageOptions[usageActiveIndex]
        if (selected) void onQuickSuggestionSelect(selected.code)
        return
      }
    }
    onKeyDown(event)
  }

  useLayoutEffect(() => {
    if (!shouldShowListbox || mobilePresentation) return

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
  }, [frequentSuggestions.length, mobilePresentation, recentSuggestions.length, shouldShowListbox, suggestions.length, value])

  const focusInputFromControl = (event: MouseEvent<HTMLDivElement>) => {
    const activeInputRef = mobilePresentation ? fieldInputRef : inputRef
    if (event.target === activeInputRef.current) {
      return
    }

    const alreadyFocused = document.activeElement === activeInputRef.current
    activeInputRef.current?.focus()
    if (alreadyFocused) {
      onFocus()
    }
  }

  const selectLocationSuggestion = (suggestion: LocationSuggestion) => {
    if (mobilePresentation) setMobileSheetOpen(false)
    onSelect(suggestion)
  }

  const selectUsageSuggestion = onQuickSuggestionSelect
    ? (code: string) => {
        if (mobilePresentation) setMobileSheetOpen(false)
        return onQuickSuggestionSelect(code)
      }
    : undefined

  const suggestionList = (
    <>
      {shouldShowUsagePanel ? (
        <div id={listboxId} role="listbox" className="fd-scrollbar-hidden grid max-h-[288px] overflow-y-auto pb-1.5">
          <LocationUsageSuggestionSection
            fieldId={fieldId}
            listboxId={listboxId}
            heading="Recientes"
            suggestions={recentSuggestions}
            activeIndex={usageActiveIndex}
            indexOffset={0}
            onSelect={selectUsageSuggestion}
          />
          <LocationUsageSuggestionSection
            fieldId={fieldId}
            listboxId={listboxId}
            heading="Frecuentes"
            suggestions={frequentSuggestions}
            activeIndex={usageActiveIndex}
            indexOffset={recentSuggestions.length}
            onSelect={selectUsageSuggestion}
          />
        </div>
      ) : shouldShowMatchesPanel ? (
        <>
          <div className="fd-suggest-head">
            <span className="fd-type-micro">Coincidencias</span>
            <span className="fd-mono text-xs font-semibold text-muted-foreground">{suggestions.length}</span>
          </div>
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
                }}
                onClick={() => selectLocationSuggestion(suggestion)}
              >
                <span className="grid place-items-center text-muted-foreground">
                  <AppIcon name={suggestionLocationIcon(suggestion)} size={14} />
                </span>
                <span className="fd-suggest-code">{suggestion.code}</span>
                <span className="grid min-w-0 gap-0.5">
                  <span className="fd-suggest-city">{suggestionCityLabel(suggestion)}</span>
                  <span className="fd-suggest-detail">{suggestionPlaceLabel(suggestion)}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="fd-suggest-empty">Escribe una ciudad o código IATA.</p>
      )}

      {!shouldShowUsagePanel && shouldShowMatchesPanel && (
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
      )}
    </>
  )

  return (
    <Field
      ref={fieldRef}
      className={cn(
        "fd-location-field relative",
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
          ref={mobilePresentation ? fieldInputRef : inputRef}
          aria-label={label}
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-describedby={helperText ? `${fieldId}-helper` : undefined}
          aria-expanded={mobilePresentation ? mobileSheetOpen : shouldShowListbox}
          aria-activedescendant={activeOptionId}
          aria-invalid={invalid}
          autoComplete="off"
          name={fieldId}
          role="combobox"
          /* The target of `/` (11 §7). An attribute rather than a ref chain:
             the field is three components deep and the shell only needs to
             find it, not to own it. */
          data-fd-location-field={label === "Origen" ? "origin" : "destination"}
          /* Alternating names because a CSS animation does not replay when only
             an attribute changes; the parity is what makes the swap visible
             every time rather than only the first. Absent until the agent has
             actually swapped, so the field does not fade in on page load. */
          data-swap-parity={swapToken > 0 ? swapToken % 2 : undefined}
          value={value}
          onChange={(event) => {
            setUsageActiveIndex(-1)
            onChange(event.target.value)
          }}
          onFocus={() => {
            setUsageActiveIndex(-1)
            if (mobilePresentation) setMobileSheetOpen(true)
            onFocus()
          }}
          onBlur={() => {
            // Mobile moves focus from this field into its full-screen sheet.
            // Resolve only when that sheet itself closes, not during the handoff.
            if (mobilePresentation) return
            void onBlur()
          }}
          onKeyDown={handleLocationKeyDown}
          placeholder={placeholder}
          className={`${SEARCH_FIELD_VALUE_CLASS} w-auto rounded-none border-0 bg-transparent p-0 text-foreground shadow-none outline-none focus-visible:border-0 focus-visible:ring-0`}
        />
        {/* 11 §2.1 gives it two rows: it «aparece» once the field holds a query,
            and pressing it «vacía el campo y **reabre** el panel con Recientes»
            with the focus still in the field. The reopening is not a second
            action — an empty field is what the usage panel shows on. The
            mousedown is swallowed so the blur never happens: losing focus here
            would resolve the query being erased. */}
        {value.length > 0 && (
          <button
            type="button"
            className="fd-field-clear fd-focus-ring"
            aria-label={`Limpiar ${label.toLowerCase()}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onChange("")
              inputRef.current?.focus()
            }}
          >
            <AppIcon name="x" size={14} />
          </button>
        )}
      </div>
      <ControlHelper id={`${fieldId}-helper`} text={helperText} />
      <LocationUsageSuggestionRow
        fieldId={fieldId}
        label={`como ${label}`}
        suggestions={quickSuggestions}
        exiting={quickSuggestionsExiting}
        leavingIdle={quickSuggestionsLeavingIdle}
        onSelect={onQuickSuggestionSelect}
      />
      {mobilePresentation && (
        <Sheet
          open={mobileSheetOpen}
          onOpenChange={(next) => {
            setMobileSheetOpen(next)
            if (!next) void onBlur()
          }}
          title={label}
          placement="bottom"
          size="full"
          className="fd-location-sheet"
        >
          <div className="fd-mobile-suggest-layout">
            <div className="fd-mobile-suggest-search">
              <AppIcon name={icon ?? "location"} size={18} className="text-muted-foreground" />
              <Input
                ref={inputRef}
                autoFocus
                data-sheet-autofocus
                aria-label={`${label}: buscar ciudad o IATA`}
                aria-autocomplete="list"
                aria-controls={listboxId}
                aria-expanded={shouldShowListbox}
                aria-activedescendant={activeOptionId}
                autoComplete="off"
                role="combobox"
                value={value}
                onChange={(event) => {
                  setUsageActiveIndex(-1)
                  onChange(event.target.value)
                }}
                onKeyDown={handleLocationKeyDown}
                placeholder={placeholder}
                className="h-11 flex-1 border-0 bg-transparent px-0 text-base shadow-none focus-visible:ring-0"
              />
            </div>
            <div className="fd-mobile-suggest-panel">
              {suggestionList}
            </div>
          </div>
        </Sheet>
      )}
      {!mobilePresentation && listboxTarget && shouldShowListbox && listboxStyle ? createPortal(
        <div style={listboxStyle} className="fd-suggest-panel fd-motion-emergente">
          {suggestionList}
        </div>,
        listboxTarget,
      ) : null}
    </Field>
  )
}

function LocationUsageSuggestionSection({
  fieldId,
  listboxId,
  heading,
  suggestions,
  activeIndex,
  indexOffset,
  onSelect,
}: {
  fieldId: string
  listboxId: string
  heading: "Recientes" | "Frecuentes"
  suggestions: string[]
  activeIndex: number
  indexOffset: number
  onSelect?: (code: string) => void | Promise<void>
}) {
  if (suggestions.length === 0 || !onSelect) {
    return null
  }

  return (
    <section aria-label={heading}>
      <div className="fd-suggest-head">
        <span className="fd-type-micro">{heading}</span>
        <span className="fd-mono text-xs font-semibold text-muted-foreground">{suggestions.length}</span>
      </div>
      <div className="grid px-1.5">
        {suggestions.map((code, index) => {
          const optionIndex = indexOffset + index
          return (
          <button
            id={`${listboxId}-usage-${optionIndex}`}
            key={`${fieldId}-${heading}-${code}`}
            type="button"
            role="option"
            aria-selected={optionIndex === activeIndex}
            className="fd-suggest-row"
            onMouseDown={(event) => {
              event.preventDefault()
            }}
            onClick={() => void onSelect(code)}
          >
            <span className="grid place-items-center text-muted-foreground">
              <AppIcon name="location" size={14} />
            </span>
            <span className="fd-suggest-code">{code}</span>
          </button>
          )
        })}
      </div>
    </section>
  )
}

function LocationUsageSuggestionRow({
  fieldId,
  label,
  heading,
  suggestions,
  exiting = false,
  leavingIdle = false,
  onSelect,
}: {
  fieldId: string
  /** How a chip is worded: «Usar LIM como origen», «Usar LIM en la ruta». */
  label: string
  /** Only the phone titles the strip: there it is one row for both fields. */
  heading?: string
  suggestions: string[]
  exiting?: boolean
  leavingIdle?: boolean
  onSelect?: (code: string) => void | Promise<void>
}) {
  if (suggestions.length === 0 || !onSelect) {
    return null
  }

  if (heading) {
    return (
      <div className="fd-mobile-quick-block">
        <span className="fd-type-micro">{heading}</span>
        <LocationUsageSuggestionRow
          fieldId={fieldId}
          label={label}
          suggestions={suggestions}
          onSelect={onSelect}
        />
      </div>
    )
  }

  return (
    <div
      /* Two different exits. `exiting` is the agent dismissing the row, which
         is rule 1's 70ms; `leavingIdle` is the search starting, which is the
         60ms cue and 120ms of 07 §1 — and that one also has to stop holding
         height, because the field it hangs from is about to travel. */
      className={cn("fd-quick-chips", exiting && "fd-motion-exit", leavingIdle && "fd-motion-idle-exit")}
      data-leaving={leavingIdle ? "true" : undefined}
      aria-label={`Estaciones frecuentes ${label.toLowerCase()}`}
    >
      {/* Real material in the space the old layout reserved and left blank: the
          stations this desk actually searches, already ranked by the backend. */}
      {suggestions.map((code) => (
        <button
          key={`${fieldId}-${code}`}
          type="button"
          className="fd-quick-chip fd-focus-ring"
          aria-label={`Usar ${code} ${label.toLowerCase()}`}
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

function suggestionLocationIcon(suggestion: LocationSuggestion): AppIconName {
  if (suggestion.type === "CITY") return "cityGroup"
  if (suggestion.type === "AIRPORT") return "airport"
  return "location"
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
    <div className={cn("flex min-w-0 flex-wrap items-center gap-2", stretch && "w-full")}>
      <ButtonGroup
        aria-disabled={stayControlsDisabled}
        aria-labelledby="flexible-stay-nights-label"
        className={cn(
          "fd-stay-counter",
          stretch && "fd-stay-counter--stretch",
          stayControlsDisabled && "fd-disabled",
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
          className="fd-stay-counter-step text-muted-foreground hover:text-foreground"
        >
          <AppIcon name="minus" />
        </Button>
        <ButtonGroupText className={cn("min-w-14 px-1 text-center text-xs font-semibold transition-colors duration-[var(--fd-dur-tacto)] ease-[var(--fd-ease-tacto)]", stayControlsDisabled ? "text-muted-foreground" : "text-foreground")}>
          {stayNights} noche{stayNights === 1 ? "" : "s"}
        </ButtonGroupText>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Agregar noche"
          onClick={() => onStayNightsChange(clampStayNights(stayNights + 1))}
          disabled={stayControlsDisabled || stayNights >= MAX_STAY_NIGHTS}
          className="fd-stay-counter-step text-muted-foreground hover:text-foreground"
        >
          <AppIcon name="plus" />
        </Button>
      </ButtonGroup>
    </div>
  )
}

/*
 * Plates 1g and 2d: one row, two surfaces. The popover gives it 44px with 32px
 * steppers and a mono 15 figure; inside the sheet the same row grows to 64 with
 * 44px steppers and a mono 17 figure. That growth is CSS on the surface, not a
 * prop — a row that reads the viewport to pick its own height is the platform
 * duplication rule 10 forbids.
 */
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
    <div className="fd-pax-row">
      <span className="fd-pax-row-copy">
        <span className="fd-pax-row-label">{label}</span>
        <span className="fd-pax-row-detail">{detail}</span>
      </span>
      {/* A stepper at its limit dims in place and never disappears: the pair
          must not move under the thumb that is still pressing it (03 §8). */}
      <span className="fd-pax-counter">
        <button
          type="button"
          className="fd-pax-step fd-focus-ring"
          onClick={onDec}
          disabled={decDisabled}
          aria-label={`Quitar ${label.toLowerCase()}`}
        >
          <AppIcon name="minus" />
        </button>
        <span className="fd-pax-figure">{value}</span>
        <button
          type="button"
          className="fd-pax-step fd-focus-ring"
          onClick={onInc}
          disabled={incDisabled}
          aria-label={`Agregar ${label.toLowerCase()}`}
        >
          <AppIcon name="plus" />
        </button>
      </span>
    </div>
  )
}

/*
 * The search policy the idle screen advertises (plate 1a) and the form enforces.
 *
 * The server injects `window.__FLYDESK_RUNTIME__` (see `src/server.ts`), so the
 * date window already comes from the backend and honours `SEARCH_MAX_FUTURE_DAYS`
 * / `SEARCH_TODAY_OVERRIDE`. The three ceilings did not: they were frontend
 * constants that happened to agree with the backend's own limits
 * (`MAX_FLEXIBLE_STAY_NIGHTS` in `src/core/flexible-search.ts`, and the
 * passenger and lap-infant checks in `src/http-search-contract.ts`).
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
  maxLapInfantsPerAdult: number
}

declare global {
  interface Window {
    __FLYDESK_RUNTIME__?: {
      searchDatePolicy?: RuntimeSearchDatePolicy
      maxStayNights?: number
      maxPassengers?: number
      maxLapInfantsPerAdult?: number
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
    maxLapInfantsPerAdult: positiveInteger(runtime?.maxLapInfantsPerAdult) ?? MAX_LAP_INFANTS_PER_ADULT_FALLBACK,
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
  const lastMonthIndex = startMonth + MAX_MIGRATION_MONTHS - 2

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

/*
 * Migratorio starts empty.
 *
 * 11 §0.2 — «nada se confirma sin un gesto explícito» — and a sweep is the most
 * expensive thing this form can ask for: every day of every selected month
 * against both providers. Arriving with eight months already chosen made one
 * click on Buscar launch a search the agent never picked. The field says
 * «Elegir» until they do, and `validateSearch` already refuses an empty
 * selection with «Selecciona al menos un mes».
 */
function resolveMigrationMonthSelection(values: string[] | undefined, options: MigrationMonthOption[]) {
  if (!values?.length) return []

  const allowed = new Set(options.filter((month) => !month.disabled).map((month) => month.key))
  const selected = orderMigrationMonths(uniqueMonthKeys(values.filter((month) => allowed.has(month))), options)
  return selected.length ? buildMigrationMonthRangeSelection(selected[0], selected[selected.length - 1], options) : []
}

function resolveMigrationMonthRange(values: string[], options: MigrationMonthOption[]) {
  const selected = resolveMigrationMonthSelection(values, options)
  const start = selected[0] ?? ""

  return {
    start,
    end: selected[selected.length - 1] ?? start,
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

  return enabledKeys.slice(from, to + 1).slice(0, MAX_MIGRATION_MONTHS)
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
  } else if (input.infants > input.adults * MAX_LAP_INFANTS_PER_ADULT) {
    state.passengers = MAX_LAP_INFANTS_PER_ADULT === 1
      ? "Se admite un bebé en falda por adulto."
      : `Se admiten hasta ${MAX_LAP_INFANTS_PER_ADULT} bebés en falda por adulto.`
  } else if (passengerTotal > MAX_PASSENGERS) {
    state.passengers = `La búsqueda admite hasta ${MAX_PASSENGERS} pasajeros.`
  }

  if (input.mode === "migration") {
    if (input.migrationMonths.length === 0) {
      state.migrationMonths = "Selecciona al menos un mes."
    } else if (input.migrationMonths.length > MAX_MIGRATION_MONTHS) {
      state.migrationMonths = `Selecciona hasta ${MAX_MIGRATION_MONTHS} meses.`
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

function formatCompactPolicyDateLabel(value: string) {
  if (!isIsoDate(value)) return "Fecha inválida"
  return COMPACT_POLICY_DATE_FORMATTER.format(new Date(`${value}T00:00:00Z`)).replace(".", "")
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
