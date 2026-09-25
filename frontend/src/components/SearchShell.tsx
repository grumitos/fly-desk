import {
  memo,
  useCallback,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react"
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
import { MIGRATION_MONTH_LIMIT } from "@/lib/api"
import { formatDate, formatDateShortYear, monthName, plural } from "@/lib/format"
import { addDays, addMonths, clampIsoDate, diffDays, isIsoDate, isIsoMonth, maxIsoDate, minIsoDate } from "@/lib/iso-date"
import {
  emptyLocationUsageSuggestions,
  getLocationUsageSuggestions,
  type LocationUsageSuggestionGroups,
} from "@/lib/location-usage-suggestions"
import { SEARCH_DATE_POLICY, SEARCH_LIMITS } from "@/lib/runtime-config"
import { returnExitDuration, useLeaveWindow } from "@/lib/search-choreography"
import { cn } from "@/lib/utils"
import type { LocationSuggestion, SearchRequest } from "@/types"

/* One 52px field (plate 1a) shared by Origen, Destino, Pasajeros and both
   halves of the date control, so the value baseline lands on one y. */
const SEARCH_FIELD_CONTROL_CLASS = "fd-field-control w-full"
const SEARCH_FIELD_VALUE_CLASS = "fd-field-value"
const {
  maxStayNights: MAX_STAY_NIGHTS,
  maxPassengers: MAX_PASSENGERS,
  maxLapInfantsPerAdult: MAX_LAP_INFANTS_PER_ADULT,
} = SEARCH_LIMITS
const MAX_CHILDREN = 8
/* The twelve months a sweep can reach, from the month of the first search
   date: the picker never offers a range the search refuses. */
const MIGRATION_MONTHS = Array.from(
  { length: MIGRATION_MONTH_LIMIT },
  (_, index) => addMonths(SEARCH_DATE_POLICY.minSearchDate.slice(0, 7), index),
)
const UNTOUCHED: Record<SearchTouchedField, boolean> = {
  origin: false,
  destination: false,
  departureDate: false,
  returnDate: false,
  passengers: false,
  migrationMonths: false,
}

type SearchModeControl = "exact" | "flexible" | "migration"
type SearchTouchedField = "origin" | "destination" | "departureDate" | "returnDate" | "passengers" | "migrationMonths"
type SearchLocationMeta = Partial<Pick<LocationSuggestion, "label" | "countryCode">>

/** The form's request, or `null` while it could not be searched. */
export type SearchDraftHandle = { read: () => SearchRequest | null }

interface SearchShellProps {
  /** What the form starts from. Another request is loaded by remounting the shell. */
  seed: SearchRequest | null
  draftRef: RefObject<SearchDraftHandle | null>
  onDraftValidityChange: (valid: boolean) => void
  onSearch: (request: SearchRequest) => void
  onCancelSearch: () => void
  loading: boolean
  controlsPlacement: "inline" | "topbar"
  compactActive: boolean
  mobilePresentation: boolean
  /** The foot of the idle screen, where 03 §8 puts the policy lines. */
  policyFootTarget: HTMLElement | null
  /** The idle screen: the usage shortcuts and the policy lines belong to it alone. */
  idle: boolean
  /** The 120ms of 07 §1 during which the frequent chips are still on screen. */
  usageSuggestionsLeaving: boolean
  workspaceActive: boolean
  /** 11 §2.4 · the agent has gone back to edit, with the results behind. */
  editing: boolean
  onEditingChange: (editing: boolean) => void
  /** The stage FLIPs these into the title bar and measures them. */
  controlsRef: RefObject<HTMLDivElement | null>
}

export const SearchShell = memo(function SearchShell({
  seed,
  draftRef,
  onDraftValidityChange,
  onSearch,
  onCancelSearch,
  loading,
  controlsPlacement,
  compactActive,
  mobilePresentation,
  policyFootTarget,
  idle,
  usageSuggestionsLeaving,
  workspaceActive,
  editing,
  onEditingChange,
  controlsRef,
}: SearchShellProps) {
  const [mode, setMode] = useState<SearchModeControl>(() => (seed ? modeFromSearchRequest(seed) : "exact"))
  const [trip, setTrip] = useState<"round-trip" | "one-way">(() => (
    !seed ? "round-trip" : seed.searchMode === "month-view" ? "one-way" : seed.tripType
  ))
  const [originCode, setOriginCode] = useState(() => seedLocationCode(seed?.origin))
  const [destCode, setDestCode] = useState(() => seedLocationCode(seed?.destination))
  /** Bumped by `swapRoute`, so the two field values re-enter with movement 10. */
  const [swapToken, setSwapToken] = useState(0)
  const [originMeta, setOriginMeta] = useState<SearchLocationMeta>(() => ({
    label: seed?.originLabel,
    countryCode: seed?.originCountryCode,
  }))
  const [destinationMeta, setDestinationMeta] = useState<SearchLocationMeta>(() => ({
    label: seed?.destinationLabel,
    countryCode: seed?.destinationCountryCode,
  }))
  const [departureDate, setDepartureDate] = useState(() => (seed ? dateStartFromSearchRequest(seed) : ""))
  const [returnDate, setReturnDate] = useState(() => (seed ? dateEndFromSearchRequest(seed) : ""))
  const [stayNights, setStayNights] = useState(() => clampStayNights(seed?.stayNights ?? 7))
  const [seededPassengers] = useState(() => seedPassengers(seed))
  const [adults, setAdults] = useState(seededPassengers.adults)
  const [children, setChildren] = useState(seededPassengers.children)
  const [infants, setInfants] = useState(seededPassengers.infants)
  const [paxOpen, setPaxOpen] = useState(false)
  const [usageSuggestions, setUsageSuggestions] = useState<LocationUsageSuggestionGroups>(emptyLocationUsageSuggestions)
  const [selectedMigrationMonths, setSelectedMigrationMonths] = useState<string[]>(
    () => resolveMigrationMonthSelection(seed?.migrationMonths),
  )
  const migrationMonthRange = useMemo(
    () => resolveMigrationMonthRange(selectedMigrationMonths),
    [selectedMigrationMonths],
  )
  const [touched, setTouched] = useState<Record<SearchTouchedField, boolean>>(UNTOUCHED)
  const validDepartureDate = isIsoDate(departureDate) ? departureDate : ""
  const returnMinDate = maxIsoDate(SEARCH_DATE_POLICY.minSearchDate, validDepartureDate || SEARCH_DATE_POLICY.minSearchDate)
  const departureLabel = mode === "flexible" ? "Salida desde" : "Salida"
  const endDateLabel = mode === "flexible" ? "Salida hasta" : "Regreso"

  const origin = useAutocomplete((suggestion) => {
    setOriginCode(suggestion.code)
    setOriginMeta({ label: suggestion.label, countryCode: suggestion.countryCode })
  }, seedLocationCode(seed?.origin))
  const destination = useAutocomplete((suggestion) => {
    setDestCode(suggestion.code)
    setDestinationMeta({ label: suggestion.label, countryCode: suggestion.countryCode })
  }, seedLocationCode(seed?.destination))

  /* A seeded code becomes the station it names, once, when the form loads. */
  const resolveSeededLocations = useEffectEvent(() => {
    void origin.resolveCurrentQuery()
    void destination.resolveCurrentQuery()
  })
  useEffect(() => {
    if (seed) resolveSeededLocations()
  }, [seed])

  useEffect(() => {
    if (!idle || loading) return

    const controller = new AbortController()
    void getLocationUsageSuggestions({ signal: controller.signal }).then((nextSuggestions) => {
      if (!controller.signal.aborted) setUsageSuggestions(nextSuggestions)
    })
    return () => controller.abort()
  }, [idle, loading])

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
    const clampedDate = clampIsoDate(nextDate, SEARCH_DATE_POLICY.minSearchDate, SEARCH_DATE_POLICY.maxSearchDate)
    /* 11 §2.2: the cross empties both dates, and an empty departure has no stay ceiling. */
    const maxReturnDate = mode === "exact" && trip === "round-trip" && isIsoDate(clampedDate)
      ? minIsoDate(SEARCH_DATE_POLICY.maxSearchDate, addDays(clampedDate, MAX_STAY_NIGHTS))
      : SEARCH_DATE_POLICY.maxSearchDate
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
        minIsoDate(SEARCH_DATE_POLICY.maxSearchDate, addDays(departureDate, MAX_STAY_NIGHTS)),
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
    setSelectedMigrationMonths(buildMigrationMonthRangeSelection(startMonth, endMonth))
    setTouched((current) => ({ ...current, migrationMonths: true }))
  }

  /* Both halves arrive together, so the return is clamped against the new departure here. */
  const handleDateRangeChange = ({ startDate, endDate }: { startDate: string; endDate: string }) => {
    handleDepartureDateChange(startDate)
    setReturnDate(endDate ? clampIsoDate(endDate, SEARCH_DATE_POLICY.minSearchDate, SEARCH_DATE_POLICY.maxSearchDate) : "")
    setTouched((current) => ({ ...current, departureDate: true, returnDate: Boolean(endDate) || current.returnDate }))
  }

  /* Movement 10 (07 §4): the contents of the two fields cross in 140ms, and
     the token makes both values re-enter on every swap. */
  const swapRoute = () => {
    setOriginCode(destCode)
    setDestCode(originCode)
    setOriginMeta(destinationMeta)
    setDestinationMeta(originMeta)
    origin.setQuery(destination.query)
    destination.setQuery(origin.query)
    setSwapToken((current) => current + 1)
  }

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
    minDepartureDate: SEARCH_DATE_POLICY.minSearchDate,
    maxDate: SEARCH_DATE_POLICY.maxSearchDate,
    minReturnDate: returnMinDate,
    maxStayNights: MAX_STAY_NIGHTS,
  })

  const buildRequest = useCallback((origin: string, destination: string): SearchRequest => {
    const flexibleDepartureStart = mode === "migration"
      ? SEARCH_DATE_POLICY.minSearchDate
      : mode === "flexible"
      ? clampIsoDate(departureDate, SEARCH_DATE_POLICY.minSearchDate, SEARCH_DATE_POLICY.maxSearchDate)
      : undefined
    const flexibleDepartureEnd = mode === "flexible"
      ? clampIsoDate(returnDate, SEARCH_DATE_POLICY.minSearchDate, SEARCH_DATE_POLICY.maxSearchDate)
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
  const draftOrigin = normalizeLocationCandidate(originCode || origin.query)
  const draftDestination = normalizeLocationCandidate(destCode || destination.query)

  /* The shell reads the draft to copy it; only whether one exists is lifted,
     so typing never re-renders the workspace. */
  useImperativeHandle(draftRef, () => ({
    read: () => (hasValidationError ? null : buildRequest(draftOrigin, draftDestination)),
  }), [buildRequest, draftDestination, draftOrigin, hasValidationError])
  useEffect(() => {
    onDraftValidityChange(!hasValidationError)
  }, [hasValidationError, onDraftValidityChange])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()

    if (loading) {
      onCancelSearch()
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
      minDepartureDate: SEARCH_DATE_POLICY.minSearchDate,
      maxDate: SEARCH_DATE_POLICY.maxSearchDate,
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
  const shouldShowUsageSuggestions = idle && !loading
  const mobileSummaryExit = useLeaveWindow(compactActive && !editing, returnExitDuration)
  /* The chips outlive the idle screen by their 180ms row of 07 §1, while the
     space reserved for them is released at once so the fields can travel. They
     answer to the screen, not to a field's focus: an open panel covers them. */
  const shouldRenderQuickChips = shouldShowUsageSuggestions || usageSuggestionsLeaving
  const reserveIdleHelperSpace = shouldShowUsageSuggestions
  const mobileQuickSuggestions = Array.from(new Set([
    ...usageSuggestions.frequent.origin,
    ...usageSuggestions.frequent.destination,
  ])).slice(0, 5)
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
        migrationMonthRange.start ? monthName(migrationMonthRange.start) : "Meses",
        migrationMonthRange.end ? monthName(migrationMonthRange.end) : "seleccionar",
      ].join(" – ")
    : [departureDate, trip === "round-trip" ? returnDate : null]
        .filter((value): value is string => Boolean(value))
        .map(formatDateLabel)
        .join(" – ")
  const modeLabel = mode === "migration" ? "Migratorio" : mode === "flexible" ? "Flexible" : "Exacto"
  const mobileSummary = (
    /* Plate 1d: the search collapsed to a summary; the 44px pencil is the only
       way back to editing, the mode included (02 §4). */
    <button
      type="button"
      className="fd-mobile-search-summary fd-focus-ring"
      aria-label="Editar búsqueda"
      onClick={() => onEditingChange(true)}
    >
      {/* Two blocks: one line cannot hold route, dates, count and mode at 360px.
          Each mixed value stays on one JSX line, where the space survives. */}
      <span className="fd-mobile-search-lead">
        <span className="fd-mobile-search-block">
          <span className="fd-mobile-search-route">
            <span>{originCode || "Origen"}</span>
            <AppIcon name="swap" size={14} className="text-muted-foreground" />
            <span>{destCode || "Destino"}</span>
          </span>
          <span className="fd-mobile-search-meta">
            <span className="fd-mono">{dateSummary || "Fechas"}</span>
          </span>
        </span>
        <span className="fd-mobile-search-aside">
          <span className="fd-mobile-search-trip"><span className="fd-mono">{passengerTotal}</span> {plural(passengerTotal, "pasajero")}</span>
          <span className="fd-mobile-search-trip">{modeLabel}</span>
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

  /* «El resumen se funde» (2h): out of the flow, over the form that replaces it. */
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
      data-fd-search-menu=""
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
      {/* Figure in mono, noun in sans, on one JSX line so the space survives. */}
      <span className={SEARCH_FIELD_VALUE_CLASS}>
        <span className="fd-mono">{passengerTotal}</span> {plural(passengerTotal, "pasajero")}
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
        Máximo {MAX_PASSENGERS} por búsqueda
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
            className="fd-search-grid"
            /* 11 §2.4: focusing a field reopens the search for editing; the
               CTA is the opposite gesture. */
            onFocusCapture={(event) => {
              if (!workspaceActive || editing) return
              const target = event.target as HTMLElement
              if (target.closest("[data-fd-search-submit]")) return
              /* A menu is not an edit: the passenger popover leaves the
                 segments in the title bar. */
              if (target.closest("[data-fd-search-menu]")) return
              onEditingChange(true)
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
              quickSuggestions={!mobilePresentation && shouldRenderQuickChips ? usageSuggestions.frequent.origin : []}
              recentSuggestions={shouldShowUsageSuggestions ? usageSuggestions.recent.origin : []}
              frequentSuggestions={shouldShowUsageSuggestions ? usageSuggestions.frequent.origin : []}
              quickSuggestionsLeavingIdle={usageSuggestionsLeaving}
              onQuickSuggestionSelect={applyOriginUsageSuggestion}
              reserveHelperSpace={reserveIdleHelperSpace && !mobilePresentation}
              reserveSuggestionSpace={reserveIdleHelperSpace && !mobilePresentation}
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
              className="text-muted-foreground hover:text-foreground"
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
            quickSuggestions={!mobilePresentation && shouldRenderQuickChips ? usageSuggestions.frequent.destination : []}
            recentSuggestions={shouldShowUsageSuggestions ? usageSuggestions.recent.destination : []}
            frequentSuggestions={shouldShowUsageSuggestions ? usageSuggestions.frequent.destination : []}
            quickSuggestionsLeavingIdle={usageSuggestionsLeaving}
            onQuickSuggestionSelect={applyDestinationUsageSuggestion}
            reserveHelperSpace={reserveIdleHelperSpace && !mobilePresentation}
            reserveSuggestionSpace={reserveIdleHelperSpace && !mobilePresentation}
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
                minMonth={MIGRATION_MONTHS[0]!}
                maxMonth={MIGRATION_MONTHS[MIGRATION_MONTHS.length - 1]!}
                maxSpan={MIGRATION_MONTH_LIMIT}
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
                minDate={SEARCH_DATE_POLICY.minSearchDate}
                maxDate={SEARCH_DATE_POLICY.maxSearchDate}
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
                  /* Plate 2d: a primary that confirms nothing new, a thumb
                     target that is not the close. */
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
                {/* Radix focuses the content on open and the focus bubbles
                    to the grid: marked as a menu, it is not read as an edit. */}
                <PopoverContent data-fd-search-menu="" align="end" sideOffset={6} className="fd-pax-popover">
                  {/* The total against the ceiling, before a button dims. */}
                  <div className="fd-pax-popover-head">
                    <span className="fd-type-micro">Pasajeros</span>
                    <span className="fd-count">{passengerTotal} de {MAX_PASSENGERS}</span>
                  </div>
                  {passengerPickerBody}
                </PopoverContent>
                <ControlHelper id="passengers-helper" text={visiblePassengerError} />
              </Field>
            </Popover>
          )}

          {/* Busy, the button stops the search and says so on every input type;
              under a pointer the spinner turns into the cross. */}
          <ShortcutTooltip label={loading ? "Detener búsqueda" : "Buscar"} shortcut={<Kbd icon="enter" />}>
          <Button
            type={loading ? "button" : "submit"}
            onClick={loading
              ? (event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  onCancelSearch()
                }
              : undefined}
            aria-label={loading ? "Detener búsqueda" : "Buscar"}
            data-fd-search-submit=""
            disabled={!loading && hasValidationError}
            size="xl"
            className={cn(
              loading && "group hover:bg-destructive hover:text-destructive-foreground",
            )}
          >
            {loading ? (
              <>
                <span className="relative grid h-4 w-4 place-items-center">
                  <AppIcon name="loading" spin className="transition-opacity duration-[var(--fd-dur-tacto)] ease-[var(--fd-ease-tacto)] group-hover:opacity-0" />
                  <AppIcon name="x" className="absolute opacity-0 transition-opacity duration-[var(--fd-dur-tacto)] ease-[var(--fd-ease-tacto)] group-hover:opacity-100" />
                </span>
                <span className="inline-grid min-w-16 justify-items-center">Detener</span>
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

          {/* 03 §4: one row for both fields, pressed in order. */}
          {mobilePresentation && shouldShowUsageSuggestions && mobileQuickSuggestions.length > 0 && (
            <LocationUsageSuggestionRow
              fieldId="mobile-route"
              label="en la ruta"
              heading="Frecuentes"
              suggestions={mobileQuickSuggestions}
              onSelect={applyMobileUsageSuggestion}
            />
          )}

          {/* Plate 1a and 03 §8: the policy the agent needs before typing,
              in a slot at the foot of the idle screen, away from the
              errors the fields produce. */}
          {idle && policyFootTarget
            ? createPortal(
                mobilePresentation ? (
                  <div className="fd-policy-line fd-policy-line--mobile">
                    <p className="m-0">
                      Ventana{" "}
                      <b>{formatDateShortYear(SEARCH_DATE_POLICY.minSearchDate)} – {formatDateShortYear(SEARCH_DATE_POLICY.maxSearchDate)}</b>
                      <span className="fd-policy-sep">·</span>
                      hasta <b>{MAX_STAY_NIGHTS}</b> noches
                    </p>
                  </div>
                ) : (
                  <div className="fd-policy-line">
                    <p className="m-0">
                      Ventana de búsqueda{" "}
                      <b>{formatDateLabel(SEARCH_DATE_POLICY.minSearchDate)} – {formatDateLabel(SEARCH_DATE_POLICY.maxSearchDate)}</b>
                      <span className="fd-policy-sep">·</span>
                      hasta <b>{MAX_STAY_NIGHTS}</b> noches en ida y vuelta
                      <span className="fd-policy-sep">·</span>
                      hasta <b>{MAX_PASSENGERS}</b> pasajeros
                    </p>
                  </div>
                ),
                policyFootTarget,
              )
            : null}
        </form>
      </section>
    </>
  )
})

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

  /* Two mounting points (02 §4): the title bar while a search exists, the form
     at rest. The move is the FLIP of 07 §1, measured by the stage through the ref. */
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
  /* 11 §2.1: «Recientes» becomes «Coincidencias» at two letters. */
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
    /* 11 §7: `Esc` clears a field that holds text; on an empty one it belongs
       to whatever is open above. */
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
      })
    }

    updateListboxStyle()
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateListboxStyle)
    if (controlRef.current) {
      resizeObserver?.observe(controlRef.current)
    }
    window.addEventListener("resize", updateListboxStyle)
    window.addEventListener("scroll", updateListboxStyle, true)
    return () => {
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
        <div id={listboxId} role="listbox" className="fd-scrollbar-hidden fd-suggest-scroll grid max-h-[288px] overflow-y-auto pb-1.5">
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
            <span className="fd-count text-muted-foreground">{suggestions.length}</span>
          </div>
          <div id={listboxId} role="listbox" className="fd-scrollbar-hidden fd-suggest-scroll grid max-h-[288px] overflow-y-auto px-1.5 pb-1.5">
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
          aria-controls={shouldShowListbox ? listboxId : undefined}
          aria-describedby={helperText ? `${fieldId}-helper` : undefined}
          aria-expanded={mobilePresentation ? mobileSheetOpen : shouldShowListbox}
          aria-activedescendant={activeOptionId}
          aria-invalid={invalid}
          autoComplete="off"
          name={fieldId}
          role="combobox"
          /* The target of `/` (11 §7). */
          data-fd-location-field={label === "Origen" ? "origin" : "destination"}
          /* The parity replays the animation on every swap; absent until
             the first, so nothing fades in on load. */
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
            // The phone hands the focus to its sheet, which resolves on close.
            if (mobilePresentation) return
            void onBlur()
          }}
          onKeyDown={handleLocationKeyDown}
          placeholder={placeholder}
          className={`${SEARCH_FIELD_VALUE_CLASS} text-foreground`}
        />
        {/* 11 §2.1: clearing keeps the focus and reopens «Recientes»; the
            mousedown is swallowed so no blur resolves the erased query. */}
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
                aria-controls={shouldShowListbox ? listboxId : undefined}
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
                className="h-11 flex-1 text-base"
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
        <span className="fd-count text-muted-foreground">{suggestions.length}</span>
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
  leavingIdle = false,
  onSelect,
}: {
  fieldId: string
  /** How a chip is worded: «Usar LIM como origen», «Usar LIM en la ruta». */
  label: string
  /** Only the phone titles the strip: there it is one row for both fields. */
  heading?: string
  suggestions: string[]
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
      /* Leaving the idle screen is the 60ms cue and 120ms of 07 §1, and the row
         stops holding height: the field it hangs from is about to travel. */
      className={cn("fd-quick-chips", leavingIdle && "fd-motion-idle-exit")}
      data-leaving={leavingIdle ? "true" : undefined}
      aria-label={`Estaciones frecuentes ${label.toLowerCase()}`}
    >
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
        <ButtonGroupText id="flexible-stay-nights-label" className="fd-stay-label px-2 text-muted-foreground">
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
        <ButtonGroupText className={cn("fd-stay-value px-1 text-center transition-colors duration-[var(--fd-dur-tacto)] ease-[var(--fd-ease-tacto)]", stayControlsDisabled ? "text-muted-foreground" : "text-foreground")}>
          {/* One inline run: as two flex items the figure and noun lose their space. */}
          <span>
            <span className="fd-mono fd-stay-figure">{stayNights}</span> {plural(stayNights, "noche")}
          </span>
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

/* Plates 1g and 2d: one row, two surfaces; the sheet's larger row is CSS. */
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

function clampStayNights(value: number) {
  const numeric = Number.isFinite(value) ? Math.trunc(value) : 7
  return Math.max(1, Math.min(MAX_STAY_NIGHTS, numeric))
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.max(min, Math.min(max, numeric))
}

function seedLocationCode(value: string | undefined): string {
  return (value ?? "").toUpperCase().trim()
}

function seedPassengers(seed: SearchRequest | null) {
  const adults = clampInteger(seed?.adults, 1, MAX_PASSENGERS, 1)
  const children = clampInteger(seed?.children, 0, Math.max(0, MAX_PASSENGERS - adults), 0)
  const infants = clampInteger(
    seed?.infants,
    0,
    Math.min(adults * MAX_LAP_INFANTS_PER_ADULT, Math.max(0, MAX_PASSENGERS - adults - children)),
    0,
  )
  return { adults, children, infants }
}

/* Migratorio starts empty (11 §0.2): a sweep is the most expensive search the
   form can ask for, so the months are always an explicit choice. A selection is
   one contiguous run of the reachable months. */
function resolveMigrationMonthSelection(values: string[] | undefined): string[] {
  const chosen = new Set((values ?? []).filter(isIsoMonth))
  const selected = MIGRATION_MONTHS.filter((key) => chosen.has(key))
  return selected.length ? buildMigrationMonthRangeSelection(selected[0]!, selected[selected.length - 1]!) : []
}

function resolveMigrationMonthRange(values: string[]) {
  const selected = resolveMigrationMonthSelection(values)
  const start = selected[0] ?? ""
  return { start, end: selected[selected.length - 1] ?? start }
}

function buildMigrationMonthRangeSelection(start: string, end: string): string[] {
  const startIndex = MIGRATION_MONTHS.indexOf(start)
  const endIndex = MIGRATION_MONTHS.indexOf(end)
  const from = startIndex >= 0 ? startIndex : Math.max(0, endIndex)
  const to = endIndex >= 0 ? endIndex : from
  return MIGRATION_MONTHS.slice(Math.min(from, to), Math.max(from, to) + 1)
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
    } else if (input.migrationMonths.length > MIGRATION_MONTH_LIMIT) {
      state.migrationMonths = `Selecciona hasta ${MIGRATION_MONTH_LIMIT} meses.`
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
  return isIsoDate(value) ? formatDate(value) : "Fecha inválida"
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
