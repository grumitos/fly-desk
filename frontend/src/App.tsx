import { memo, useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { DetailPanel } from "@/components/DetailPanel"
import { ProviderRail } from "@/components/ProviderRail"
import { QuotationPastePreview } from "@/components/QuotationPastePreview"
import {
  ResultsPanel,
  type ActiveFilterChip,
  type EmptyByFiltersCopy,
  type ResultsNavigation,
} from "@/components/ResultsPanel"
import { ActiveFilterChips } from "@/components/results/ActiveFilterChips"
import type { DisplayMonth } from "@/components/results/migration-month-model"
import { SearchShell, type SearchDraftHandle } from "@/components/SearchShell"
import { TopBar } from "@/components/TopBar"
import { AppIcon, type AppIconName } from "@/components/ui/app-icon"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { SegmentedControl, SegmentedOption } from "@/components/ui/segmented-control"
import { Sheet } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { useSearch } from "@/hooks/useSearch"
import { useShellSize } from "@/hooks/useShellSize"
import { resolveAirlineDisplayName } from "@/lib/airline-names"
import { cheapestOffer, migrationRequestForMonth } from "@/lib/api"
import { formatCount, plural } from "@/lib/format"
import { isIsoDate } from "@/lib/iso-date"
import { openInNewTab } from "@/lib/new-tab"
import { hasOpenOverlay } from "@/lib/overlay-stack"
import { motionToken } from "@/lib/reduced-motion"
import { SEARCH_DATE_POLICY } from "@/lib/runtime-config"
import {
  enteringWindow,
  idleExitDuration,
  measureFlip,
  playFlip,
  useLeaveWindow,
  type FlipRect,
} from "@/lib/search-choreography"
import { describeSearchOutcome } from "@/lib/search-outcome"
import {
  readSharedSearchFromText,
  readSharedSearchFromUrl,
  searchUrlWasWrittenHere,
  writeSharedSearchToClipboard,
  writeSharedSearchToUrl,
  type SharedSearchState,
} from "@/lib/search-share"
import { isSortMode, type CanonicalOffer, type SearchJobResponse, type SearchRequest, type Segment, type SortMode } from "@/types"
import { airlineLogoAssetPath } from "../../src/core/airline-assets"
import { offerAirlineCode, offerMatchesFilters, type OfferFilters } from "../../src/core/filtering"
import { parseCommercialQuotation, type CommercialQuotationParseResult } from "../../src/core/quotation-parser"
import { compareOffers } from "../../src/core/ranking"

/** The three shapes the search takes: 07 §1's two ends, plus 11 §2.4's return. */
type SearchPhase = "idle" | "editing" | "active"

type Filters = {
  nonStop?: boolean
  maxStopsFilter?: string
  maxLayoverMinutes?: string
  carryOnRequired?: boolean
  checkedBaggageRequired?: boolean
}

/* How the list is read. It outlives a search: it rides the link and the
   session's preferences, and price is the order only until one is chosen. */
type ListView = { sort: SortMode; filters: Filters; airlines: string[] }

type AirlineFilterOption = {
  id: string
  label: string
  logo: string
  /** Every selling code drawn under this name: LATAM sells as LA, LP, XL… */
  codes: string[]
  count: number
}

type Notice = { message: string; tone: "warning" | "error"; icon?: AppIconName }

/* A search the runner holds until there is room for it: never refused, and
   said once, while it waits (REDESIGN_CONTRACT, «Una búsqueda en espera»). */
const QUEUED_SEARCH_NOTICE = "En espera\nTu búsqueda empezará en cuanto haya un cupo libre"

type FormSeed = { id: number; request: SearchRequest }

type StopFilterValue = "any" | "direct" | "1" | "2+"
type LayoverFilterValue = "any" | "120" | "240" | "360"
type BaggageFilterValue = "any" | "carry" | "checked"

const DEFAULT_SORT_MODE: SortMode = "cheapest"
const WORKSPACE_PREFERENCES_KEY = "fly-desk:workspace-preferences:v1"
const RESTORE_JOB_QUERY_PARAM = "job"
/* Surfaces that answer their own keys whether or not they sit in the overlay stack. */
const SELF_KEYED_SURFACES = "[role='dialog'], [role='menu'], [role='listbox'], [role='grid']"
const INTERACTIVE_TARGETS = "button, a[href], summary, [role='button'], [role='radio'], [role='checkbox'], [role='switch'], [role='option']"

/* Plate 1b: three segmented groups and, past a rule, the airlines — a list you
   include from rather than a constraint you tighten. `relaxTo` is plate 2g's
   second exit, one step down the ladder; an option with no step below is
   relaxed by removing it. */
const STOP_SEGMENTS: Array<{ value: StopFilterValue; label: string; chip?: string; relaxTo?: StopFilterValue; relaxLabel?: string }> = [
  { value: "any", label: "Todos" },
  { value: "direct", label: "Directo", chip: "Directo", relaxTo: "1", relaxLabel: "Permitir 1 escala" },
  { value: "1", label: "1", chip: "Hasta 1 escala" },
  { value: "2+", label: "2+", chip: "2+ escalas" },
]
const LAYOVER_SEGMENTS: Array<{ value: LayoverFilterValue; label: string; chip?: string; relaxTo?: LayoverFilterValue; relaxLabel?: string }> = [
  { value: "any", label: "Todos" },
  { value: "120", label: "≤2h", chip: "Escala ≤ 2 h", relaxTo: "240", relaxLabel: "Permitir escalas de hasta 4 h" },
  { value: "240", label: "≤4h", chip: "Escala ≤ 4 h", relaxTo: "360", relaxLabel: "Permitir escalas de hasta 6 h" },
  { value: "360", label: "≤6h", chip: "Escala ≤ 6 h" },
]
const BAGGAGE_SEGMENTS: Array<{ value: BaggageFilterValue; label: string; icon?: "cabinBag" | "holdBag"; chip?: string; relaxTo?: BaggageFilterValue; relaxLabel?: string }> = [
  { value: "any", label: "Todos" },
  { value: "carry", label: "Mano", icon: "cabinBag", chip: "Mano incluida" },
  { value: "checked", label: "Bodega", icon: "holdBag", chip: "Bodega incluida", relaxTo: "carry", relaxLabel: "Permitir vuelos sin bodega" },
]

export default function App() {
  const { results, loading, error, statusMessage, diagnosticLog, runSearch, restoreJob, cancel } = useSearch()
  const [initialSharedSearch] = useState<SharedSearchState | null>(() => readInitialSharedSearch())
  /* Read before the first search of this tab overwrites the answer. */
  const [openedOwnSearchUrl] = useState(() => readSearchUrlWasWrittenHere())
  const [initialView] = useState<ListView>(() => (
    initialSharedSearch
      ? viewFromRequest(initialSharedSearch.request, initialSharedSearch.sortMode)
      : readWorkspacePreferences()
  ))
  const [sortMode, setSortMode] = useState<SortMode>(initialView.sort)
  const [filters, setFilters] = useState<Filters>(initialView.filters)
  const [selectedAirlines, setSelectedAirlines] = useState<string[]>(initialView.airlines)
  const [selectedOfferId, setSelectedOfferId] = useState<string | null>(null)
  /* The request of the search on screen, or of the configuration last loaded;
     the list view is laid over it for the link. */
  const [lastRequest, setLastRequest] = useState<SearchRequest | null>(null)
  /* The form is rebuilt from this and nothing else, so a filter or an order
     never discards a half-typed edit. */
  const [formSeed, setFormSeed] = useState<FormSeed | null>(() => (
    initialSharedSearch ? { id: 1, request: initialSharedSearch.request } : null
  ))
  const searchDraftRef = useRef<SearchDraftHandle | null>(null)
  const [formHasDraft, setFormHasDraft] = useState(false)
  /* Armed at the gesture, so the first render of the workspace already carries
     the cues of 07 §1; a search from a workspace already on screen arrives nowhere. */
  const [workspaceEntering, setWorkspaceEntering] = useState(false)
  /* 11 §2.4: the form back in its editing shape over results that stay put. It
     ends at the next search. */
  const [searchEditing, setSearchEditing] = useState(false)
  const [workspaceOverlay, setWorkspaceOverlay] = useState<"filters" | "detail" | null>(null)
  const [mobileToolsCollapsed, setMobileToolsCollapsed] = useState(false)
  const [policyFootTarget, setPolicyFootTarget] = useState<HTMLDivElement | null>(null)
  /* Armazón B positions the detail sheet over the results region. */
  const [workspaceElement, setWorkspaceElement] = useState<HTMLDivElement | null>(null)
  const [pastedQuotation, setPastedQuotation] = useState<{
    text: string
    result: CommercialQuotationParseResult
  } | null>(null)
  const [plainLogView, setPlainLogView] = useState(false)
  /* A failure of the agent's own gesture: the clipboard, a blocked tab. */
  const [gestureError, setGestureError] = useState<string | null>(null)
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null)
  const [configCopiedAt, setConfigCopiedAt] = useState<number | null>(null)
  /* Offers the provider confirmed since this search returned; a new search
     empties it. */
  const [revalidatedOffers, setRevalidatedOffers] = useState<Map<string, CanonicalOffer>>(() => new Map())
  const searchFrameRef = useRef<HTMLDivElement | null>(null)
  const searchControlsRef = useRef<HTMLDivElement | null>(null)
  const shellRef = useRef<HTMLDivElement | null>(null)
  const toolsBlockRef = useRef<HTMLDivElement | null>(null)
  const pendingChoreographyRef = useRef<{
    frame: FlipRect | null
    fields: FlipRect | null
    controls: FlipRect | null
    tools: FlipRect | null
    phase: SearchPhase
  } | null>(null)
  const searchPhaseRef = useRef<SearchPhase>("idle")
  const toolsBlockAnimationRef = useRef<Animation | null>(null)
  const searchLayoutAnimationRef = useRef<Animation | null>(null)
  const searchControlsAnimationRef = useRef<Animation | null>(null)
  const { shellSize, detailPlacement } = useShellSize(shellRef)

  const resultsNavigationRef = useRef<ResultsNavigation | null>(null)
  /* `C` quotes through the detail, which fills this only while its offer can
     be quoted. */
  const quotationShortcutRef = useRef<(() => void) | null>(null)
  const shouldShowWorkspace = Boolean(results) || loading
  const isSearchIdle = !shouldShowWorkspace
  /* `editing` is not a fourth screen: it is `active` with the form at rest. */
  const searchPhase: SearchPhase = isSearchIdle ? "idle" : searchEditing ? "editing" : "active"

  useEffect(() => {
    searchPhaseRef.current = searchPhase
  }, [searchPhase])

  /* `?job=` reads a job that exists — a month of a sweep in its own tab — rather
     than paying for its search again. */
  useEffect(() => {
    const jobId = readRestorableJobIdFromUrl()
    if (jobId) void restoreJob(jobId)
  }, [restoreJob])

  useEffect(() => {
    writeWorkspacePreferences({ sort: sortMode, filters, airlines: selectedAirlines })
  }, [filters, selectedAirlines, sortMode])

  /* The address bar always states the list on screen, so it is the link to share. */
  const sharedRequest = useMemo(
    () => (lastRequest ? withListView(lastRequest, filters, selectedAirlines) : null),
    [filters, lastRequest, selectedAirlines],
  )
  useEffect(() => {
    if (sharedRequest) writeSharedSearchToUrl(sharedRequest, sortMode)
  }, [sharedRequest, sortMode])
  /* Closing a sheet goes back over its own history entry, onto one written
     before a filter changed inside the sheet; the URL is restated there. */
  const restateSharedUrl = useEffectEvent(() => {
    if (sharedRequest) writeSharedSearchToUrl(sharedRequest, sortMode)
  })
  useEffect(() => {
    const listener = () => restateSharedUrl()
    window.addEventListener("popstate", listener)
    return () => window.removeEventListener("popstate", listener)
  }, [])

  useEffect(() => {
    if (configCopiedAt === null) return
    const timer = window.setTimeout(() => setConfigCopiedAt(null), motionToken("--fd-hold-confirmacion"))
    return () => window.clearTimeout(timer)
  }, [configCopiedAt])

  /* The "first" of the FLIPs, taken at the gesture: after the commit the
     segments have changed parent and there is nothing left to measure. The
     fields are measured on their own because the frame above them loses the
     segments' row, so aligning frame tops would slide the fields under it. */
  const captureChoreographyRects = useCallback(() => {
    const frame = searchFrameRef.current
    pendingChoreographyRef.current = {
      frame: measureFlip(frame),
      fields: measureFlip(frame?.querySelector(".fd-search-grid")),
      controls: measureFlip(searchControlsRef.current),
      tools: measureFlip(toolsBlockRef.current),
      phase: searchPhaseRef.current,
    }
  }, [])

  /* Both ends of 11 §2.4's «editar la búsqueda»: the gesture that opens it, and
     the search that is the only thing that closes it. The measurement is taken
     here because the handler still runs before React commits, which is the last
     moment the segments are where the plate says they start. */
  const handleSearchEditingChange = useCallback((editing: boolean) => {
    captureChoreographyRects()
    setSearchEditing(editing)
  }, [captureChoreographyRects])

  /* 04 §8: the exit of «vacío por búsqueda» is the form itself. */
  const handleEditSearchFromEmptyList = useCallback(() => {
    handleSearchEditingChange(true)
  }, [handleSearchEditingChange])

  const applyListView = useCallback((view: ListView) => {
    setSortMode(view.sort)
    setFilters(view.filters)
    setSelectedAirlines(view.airlines)
  }, [])

  const seedForm = useCallback((request: SearchRequest) => {
    setFormSeed((current) => ({ id: (current?.id ?? 0) + 1, request }))
  }, [])

  const reportGestureError = useCallback((message: string) => {
    setGestureError(message)
    setDismissedNotice(null)
  }, [])

  const launchSearch = useCallback(
    (request: SearchRequest, view: ListView, { seed = false }: { seed?: boolean } = {}) => {
      captureChoreographyRects()
      if (!shouldShowWorkspace) setWorkspaceEntering(true)
      setSearchEditing(false)
      setGestureError(null)
      setDismissedNotice(null)
      setSelectedOfferId(null)
      setRevalidatedOffers(new Map())
      applyListView(view)
      setLastRequest(request)
      if (seed) seedForm(request)
      void runSearch(withListView(request, view.filters, view.airlines), view.sort)
    },
    [applyListView, captureChoreographyRects, runSearch, seedForm, shouldShowWorkspace],
  )

  const handleSearch = useCallback((request: SearchRequest) => {
    launchSearch(request, { sort: sortMode, filters, airlines: selectedAirlines })
  }, [filters, launchSearch, selectedAirlines, sortMode])

  /* A shared link runs its search once, after the paint of the filled form,
     and only an `exact` one: sweeps wait for «Buscar», `?job=` reads a job,
     and reloading this tab's own address bar is not a link. */
  const launchSharedLink = useEffectEvent(() => {
    const shared = initialSharedSearch
    if (!shared || !isLaunchableSharedRequest(shared.request)) return
    if (readRestorableJobIdFromUrl() || openedOwnSearchUrl) return
    launchSearch(shared.request, viewFromRequest(shared.request, shared.sortMode))
  })
  useEffect(() => {
    const timer = window.setTimeout(() => launchSharedLink(), 0)
    return () => window.clearTimeout(timer)
  }, [])

  /* Loaded into the form and the list view without searching. */
  const loadConfiguration = useCallback((request: SearchRequest, view: ListView) => {
    setGestureError(null)
    setSelectedOfferId(null)
    applyListView(view)
    setLastRequest(request)
    seedForm(request)
  }, [applyListView, seedForm])

  const handlePasteSearchConfig = useCallback(async () => {
    let text: string
    try {
      text = await navigator.clipboard.readText()
    } catch {
      reportGestureError("No se pudo leer el portapapeles. Revisa el permiso del navegador e intenta nuevamente.")
      return
    }

    const shared = readSharedSearchFromText(text)
    if (shared) {
      setPastedQuotation(null)
      loadConfiguration(shared.request, viewFromRequest(shared.request, shared.sortMode))
      return
    }

    const parsedQuotation = parseCommercialQuotation(text)
    if (parsedQuotation.fields.format.state !== "parsed") {
      reportGestureError("No se encontró una configuración ni una cotización comercial válida en el portapapeles.")
      return
    }
    setGestureError(null)
    setPastedQuotation({ text, result: parsedQuotation })
  }, [loadConfiguration, reportGestureError])

  /* A pasted quotation starts from a clean view: its own filters, price order. */
  const handleQuotationDraft = useCallback((request: SearchRequest, execute: boolean) => {
    captureChoreographyRects()
    setPastedQuotation(null)
    const view: ListView = { sort: DEFAULT_SORT_MODE, filters: filtersFromRequest(request), airlines: [] }
    if (execute) {
      launchSearch(request, view, { seed: true })
    } else {
      loadConfiguration(request, view)
    }
  }, [captureChoreographyRects, launchSearch, loadConfiguration])

  const handleCopySearchConfig = useCallback(async () => {
    const base = searchDraftRef.current?.read() ?? lastRequest ?? formSeed?.request
    if (!base) return

    if (await writeSharedSearchToClipboard(withListView(base, filters, selectedAirlines), sortMode)) {
      setGestureError(null)
      setConfigCopiedAt(Date.now())
    } else {
      reportGestureError("No se pudo copiar la configuración. Revisa el permiso del navegador e intenta nuevamente.")
    }
  }, [filters, formSeed, lastRequest, reportGestureError, selectedAirlines, sortMode])

  /* 06 §1.3 and 11 §5: a month opens as its own list. The sweep's job is read
     in a new tab when the server still holds it; otherwise the month's search
     runs here, rebuilt from the sweep's request under the current view. */
  const handleOpenMigrationMonth = useCallback((month: DisplayMonth) => {
    if (month.searchJobId) {
      const url = new URL(window.location.href)
      url.search = `?${RESTORE_JOB_QUERY_PARAM}=${encodeURIComponent(month.searchJobId)}`
      url.hash = ""
      if (!openInNewTab(url.toString())) {
        reportGestureError("El navegador bloqueó la pestaña nueva. Permite las ventanas emergentes de Fly Desk e intenta nuevamente.")
      }
      return
    }

    const base = lastRequest ?? searchDraftRef.current?.read()
    if (!base || !month.departureStart || !month.departureEnd) return
    launchSearch(
      migrationRequestForMonth(base, month),
      { sort: sortMode, filters, airlines: selectedAirlines },
      { seed: true },
    )
  }, [filters, lastRequest, launchSearch, reportGestureError, selectedAirlines, sortMode])

  const handleOfferRevalidated = useCallback((offer: CanonicalOffer) => {
    setRevalidatedOffers((current) => {
      if (current.get(offer.id) === offer) return current
      const next = new Map(current)
      next.set(offer.id, offer)
      return next
    })
  }, [])

  const handleSelectOffer = useCallback((offerId: string) => {
    setSelectedOfferId(offerId)
    /* Keyed on where the detail is, not on the armazón: between 1100 and 1436
       the shell is A and the detail a sheet. */
    if (detailPlacement !== "column") setWorkspaceOverlay("detail")
  }, [detailPlacement])

  const handleFilterChange = useCallback((patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }))
  }, [])

  const handleClearFilters = useCallback(() => {
    setFilters({})
    setSelectedAirlines([])
  }, [])

  const toggleAirline = useCallback((airline: AirlineFilterOption) => {
    setSelectedAirlines((current) => {
      if (isAirlineFilterSelected(airline, current)) {
        return current.filter((code) => !airline.codes.includes(code))
      }
      return Array.from(new Set([...current, ...airline.codes]))
    })
  }, [])

  const clearAirlineFilter = useCallback(() => setSelectedAirlines([]), [])
  const openFiltersSheet = useCallback(() => setWorkspaceOverlay("filters"), [])
  const closeWorkspaceOverlay = useCallback(() => setWorkspaceOverlay(null), [])

  /* The whole search in the chosen order, confirmed fares swapped in. The order
     is the backend's comparator, so the list reads as the server serves it. */
  const candidateOffers = useMemo(() => {
    const source = results?.allOffers ?? []
    const reconciled = revalidatedOffers.size === 0
      ? source
      : source.map((offer) => revalidatedOffers.get(offer.id) ?? offer)
    return [...reconciled].sort(compareOffers(sortMode))
  }, [results, revalidatedOffers, sortMode])
  const railFilters = useMemo(() => railOfferFilters(filters, selectedAirlines), [filters, selectedAirlines])
  const filteredOffers = useMemo(
    () => candidateOffers.filter((offer) => offerMatchesFilters(offer, railFilters)),
    [candidateOffers, railFilters],
  )
  const months = useMemo(() => migrationMonthsForDisplay(results, filteredOffers), [filteredOffers, results])
  const displayOffers = useMemo(
    () => (months ? months.flatMap((month) => (month.offer ? [month.offer] : [])) : filteredOffers),
    [filteredOffers, months],
  )
  const visibleSelectedOffer = useMemo(() => {
    const selected = selectedOfferId ? displayOffers.find((offer) => offer.id === selectedOfferId) : undefined
    if (selected) return selected
    /* A sweep always has a month in the detail. */
    return months ? displayOffers[0] ?? null : null
  }, [displayOffers, months, selectedOfferId])
  const outcome = useMemo(() => describeSearchOutcome(results), [results])
  /* From the offers, not the ordered list: an order changes nothing here. */
  const airlineOptions = useMemo(() => buildAirlineOptions(results?.allOffers ?? []), [results])
  const activeFilterChips = useMemo(
    () => buildActiveFilterChips(filters, selectedAirlines, airlineOptions),
    [airlineOptions, filters, selectedAirlines],
  )
  const hiddenByFiltersCount = Math.max(0, candidateOffers.length - filteredOffers.length)

  const handleRemoveFilterChip = useCallback((id: string) => {
    if (id === "stops") {
      handleFilterChange(stopFilterPatch("any"))
    } else if (id === "layover") {
      handleFilterChange(layoverFilterPatch("any"))
    } else if (id === "baggage") {
      handleFilterChange(baggageFilterPatch("any"))
    } else {
      const airline = airlineOptions.find((option) => airlineChipId(option) === id)
      if (airline) toggleAirline(airline)
    }
  }, [airlineOptions, handleFilterChange, toggleAirline])

  /* Plate 2g: with the list empty, the filter whose removal recovers most
     offers is named; a tie or no recovery names none rather than guess. */
  const emptyByFilters = useMemo<EmptyByFiltersCopy | undefined>(() => {
    if (filteredOffers.length > 0 || candidateOffers.length === 0) return undefined

    const axes = activeFilterAxes(filters, selectedAirlines)
    let culprit: FilterAxis | undefined
    let best = 0
    let tied = false
    for (const axis of axes) {
      const lifted = railOfferFilters(
        filtersWithoutAxis(filters, axis),
        axis === "airlines" ? [] : selectedAirlines,
      )
      const recovered = candidateOffers.filter((offer) => offerMatchesFilters(offer, lifted)).length
      if (recovered > best) {
        best = recovered
        culprit = axis
        tied = false
      } else if (recovered === best) {
        tied = true
      }
    }
    if (!culprit || best === 0 || tied) return undefined

    const name = culpritFilterName(culprit, filters)
    const step = relaxFilterStep(culprit, filters)
    const selectedOptions = culprit === "airlines"
      ? airlineOptions.filter((airline) => isAirlineFilterSelected(airline, selectedAirlines))
      : []

    return {
      /* «El que descarta más» needs something to compare against. */
      culpritSentence: name && axes.length > 1
        ? `El filtro de ${name.toLocaleLowerCase("es-PE")} es el que descarta más.`
        : undefined,
      relax: step
        ? { label: step.label, onClick: () => handleFilterChange(step.patch) }
        : culprit === "airlines"
          ? {
              label: selectedOptions.length === 1 && selectedOptions[0]
                ? removeFilterLabel(selectedOptions[0].label)
                : "Quitar el filtro de aerolíneas",
              onClick: clearAirlineFilter,
            }
          : undefined,
    }
  }, [
    airlineOptions,
    candidateOffers,
    clearAirlineFilter,
    filteredOffers.length,
    filters,
    handleFilterChange,
    selectedAirlines,
  ])

  /* 11 §3: one notice and one line. The agent's own gesture speaks before the
     search behind it. */
  const notice = useMemo<Notice | null>(() => {
    if (gestureError) return { message: gestureError, tone: "error" }
    if (error) return { message: error, tone: "error" }
    if (statusMessage) return { message: statusMessage, tone: "warning" }
    if (loading && results?.queued) return { message: QUEUED_SEARCH_NOTICE, tone: "warning", icon: "clock" }
    if (outcome.notice) {
      return { message: outcome.notice, tone: outcome.allFailed || outcome.jobFailed ? "error" : "warning" }
    }
    return null
  }, [error, gestureError, loading, outcome, results?.queued, statusMessage])
  const visibleNotice = notice && notice.message !== dismissedNotice ? notice : null

  const dismissNotice = useCallback(() => {
    setGestureError(null)
    setDismissedNotice(notice?.message ?? null)
  }, [notice])

  const listAnnouncement = describeListForScreenReaders({
    loading,
    hasResults: Boolean(results),
    searchFailed: outcome.allFailed || outcome.jobFailed,
    months,
    visibleCount: displayOffers.length,
    totalCount: candidateOffers.length,
  })

  /*
   * The keyboard layer of 11 §7, for «the searcher» and «the list». Whatever is
   * typed into owns every key, `Esc` included; a sheet, popover or menu answers
   * its own; a key a control already handled is not handled twice.
   */
  const handleWindowKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "l") {
      event.preventDefault()
      setPlainLogView((active) => !active)
      return
    }
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return

    const target = event.target instanceof Element ? event.target : null
    if (target && isEditableTarget(target)) return
    if (hasOpenOverlay() || target?.closest(SELF_KEYED_SURFACES)) return
    if (target?.getAttribute("aria-expanded") === "true") return

    if (event.key === "/") {
      event.preventDefault()
      document.querySelector<HTMLInputElement>('[data-fd-location-field="origin"]')?.focus()
      return
    }

    if (!shouldShowWorkspace) return
    const key = event.key.toLowerCase()

    if (key === "f") {
      event.preventDefault()
      if (shellSize === "C") {
        openFiltersSheet()
      } else {
        /* On a desk the filters are on screen already (02 §4): put the caret in them. */
        document.querySelector<HTMLElement>(".fd-filter-column [role='radio'][aria-checked='true']")?.focus()
      }
      return
    }

    if (key === "c") {
      const quote = quotationShortcutRef.current
      if (!quote) return
      event.preventDefault()
      quote()
      return
    }

    if (event.key === "Escape") {
      if (!selectedOfferId) return
      event.preventDefault()
      setSelectedOfferId(null)
      return
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const next = resultsNavigationRef.current?.step(event.key === "ArrowDown" ? 1 : -1)
      if (!next) return
      event.preventDefault()
      setSelectedOfferId(next)
      return
    }

    if (event.key === "Enter" && !target?.closest(INTERACTIVE_TARGETS) && visibleSelectedOffer) {
      event.preventDefault()
      handleSelectOffer(visibleSelectedOffer.id)
    }
  })

  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleWindowKeyDown(event)
    window.addEventListener("keydown", listener)
    return () => window.removeEventListener("keydown", listener)
  }, [])

  /* The fields rise and the segments move into the title bar, one movement on
     one cue. The way back (editing) is the same pair reversed, without the cue:
     a cue staggers an arrival. */
  useLayoutEffect(() => {
    const pending = pendingChoreographyRef.current
    pendingChoreographyRef.current = null

    searchLayoutAnimationRef.current?.cancel()
    searchControlsAnimationRef.current?.cancel()
    toolsBlockAnimationRef.current?.cancel()
    searchLayoutAnimationRef.current = null
    searchControlsAnimationRef.current = null
    toolsBlockAnimationRef.current = null

    if (!pending || pending.phase === searchPhase) return

    const frame = searchFrameRef.current
    /* Read off the frame: the cue is 0 on a phone, by the phone's rules. */
    const goingBack = searchPhase !== "active"
    const delay = goingBack ? 0 : motionToken("--fd-cue-campos", frame)
    const duration = goingBack
      ? motionToken("--fd-dur-vuelta", frame)
      : motionToken("--fd-dur-estructura", frame)

    const fields = frame?.querySelector(".fd-search-grid")
    if (frame && fields && pending.fields) {
      searchLayoutAnimationRef.current = playFlip(frame, pending.fields, { delay, duration, anchor: fields, centered: true })
    } else if (frame && pending.frame) {
      searchLayoutAnimationRef.current = playFlip(frame, pending.frame, { delay, duration, centered: true })
    }

    const controls = searchControlsRef.current
    if (controls && pending.controls) {
      searchControlsAnimationRef.current = playFlip(controls, pending.controls, { delay, duration })
    }

    /* On a phone the block does not travel on the way back: it stays under the
       title bar and grows to its natural height. */
    const tools = toolsBlockRef.current
    if (goingBack && tools && pending.tools) {
      toolsBlockAnimationRef.current = playFlip(tools, pending.tools, { delay, duration, reveal: true })
    }
  }, [searchPhase])

  /* The arrival cues come down once they have played, so a detail picked later
     arrives on its own, without the arrival's delay. */
  useEffect(() => {
    if (!workspaceEntering) return
    const timer = window.setTimeout(() => setWorkspaceEntering(false), enteringWindow())
    return () => window.clearTimeout(timer)
  }, [workspaceEntering])

  /* 07 §1 at 60ms: the frequent chips and the provider rail belong to the idle
     screen and they *leave*, they do not blink out. React's answer to "not idle
     any more" is to unmount them, so the window holds them alive exactly as
     long as their row of the table lasts. */
  const idleChrome = useLeaveWindow(isSearchIdle, idleExitDuration)

  /* Copy is disabled and paste dimmed while the desk knows no configuration. */
  const hasSearchConfig = formHasDraft || lastRequest !== null || formSeed !== null
  const phone = shellSize === "C"
  const visibleMobileToolsCollapsed = phone && mobileToolsCollapsed
  const configCopied = configCopiedAt !== null

  return (
    <div
      ref={shellRef}
      className="fd-shell"
      data-shell-size={shellSize}
      data-fd-sheet-root=""
    >
      <TopBar
        copySearchDisabled={!hasSearchConfig}
        copyConfirmed={configCopied}
        pasteSearchDimmed={!hasSearchConfig}
        onCopySearchConfig={handleCopySearchConfig}
        onPasteSearchConfig={handlePasteSearchConfig}
        workspaceActive={shouldShowWorkspace}
      />

      <p className="sr-only" role="status">{listAnnouncement}</p>
      <p className="sr-only" role="status">{configCopied ? "Configuración copiada" : ""}</p>

      {plainLogView ? (
        <PlainLogView lines={diagnosticLog} />
      ) : (
        <main
          className={`fd-search-stage ${
            isSearchIdle ? "fd-search-stage-idle" : "fd-search-stage-active"
          }`}
          data-entering={workspaceEntering ? "" : undefined}
        >
          {/* Plate 1a: two unequal spacers leave the form slightly above centre
              and the rail on the bottom edge. */}
          {isSearchIdle && <div className="fd-search-stage-spacer-top" aria-hidden="true" />}

          {/* Plate 1d: summary, filter chips and notice retract as one block
              (02 §9); the status row and the list are its siblings. */}
          <div
            ref={toolsBlockRef}
            className="fd-tools-block"
            data-collapsed={visibleMobileToolsCollapsed}
            data-active={shouldShowWorkspace}
            /* While the form is open for editing the block grows to its natural
               height (2h) instead of the summary band's 182px. */
            data-editing={searchEditing ? "" : undefined}
          >
          <div
            ref={searchFrameRef}
            data-testid="search-shell-frame"
            className="fd-search-frame"
          >
            <SearchShell
              key={formSeed?.id ?? 0}
              seed={formSeed?.request ?? null}
              draftRef={searchDraftRef}
              onDraftValidityChange={setFormHasDraft}
              onSearch={handleSearch}
              loading={loading}
              onCancelSearch={cancel}
              /* Above the form at rest, in the title bar while a search exists. */
              controlsPlacement={searchPhase !== "idle" && !phone ? "topbar" : "inline"}
              compactActive={shouldShowWorkspace && phone}
              mobilePresentation={phone}
              policyFootTarget={policyFootTarget}
              idle={isSearchIdle}
              usageSuggestionsLeaving={idleChrome.leaving}
              workspaceActive={shouldShowWorkspace}
              editing={searchEditing}
              onEditingChange={handleSearchEditingChange}
              controlsRef={searchControlsRef}
            />

          </div>

            {/* Armazón C: the strip sits between the summary and the notice so
                the three retract as one (02 §4). */}
            {shouldShowWorkspace && phone && (
              <ActiveFilterChips
                chips={activeFilterChips}
                hiddenByFiltersCount={hiddenByFiltersCount}
                onOpenFilters={openFiltersSheet}
                onRemoveFilter={handleRemoveFilterChip}
                /* On a phone the title bar hides once a search exists. */
                onCopySearchConfig={handleCopySearchConfig}
                copyDisabled={!hasSearchConfig}
                copyConfirmed={configCopied}
              />
            )}

            <SearchNotice notice={visibleNotice} onDismiss={dismissNotice} />
          </div>

          {isSearchIdle && <div className="fd-search-stage-spacer-bottom" aria-hidden="true" />}
          {/* 03 §8: the policy lines at the foot of the idle screen, next to the rail. */}
          {isSearchIdle && <div ref={setPolicyFootTarget} className="fd-policy-foot" />}
          {idleChrome.mounted && <ProviderRail leaving={idleChrome.leaving} />}

          {shouldShowWorkspace && (
            <div ref={setWorkspaceElement} className="fd-shell-workspace">
              <div className="fd-results">
                {/* A and B keep the 248px column; C turns it into a sheet (02 §4). */}
                {!phone && (
                  <div className="fd-filter-column">
                    <FiltersPanel
                      activeFilterCount={activeFilterChips.length}
                      filters={filters}
                      allAirlines={airlineOptions}
                      selectedAirlines={selectedAirlines}
                      onClear={handleClearFilters}
                      onFilterChange={handleFilterChange}
                      onToggleAirline={toggleAirline}
                    />
                  </div>
                )}

                <div className="fd-list">
                  <ResultsPanel
                    key={results?.searchJobId ?? "idle"}
                    results={results}
                    offers={displayOffers}
                    months={months}
                    outcome={outcome}
                    unfilteredOfferCount={candidateOffers.length}
                    loading={loading}
                    sort={sortMode}
                    onSort={setSortMode}
                    onSelectOffer={handleSelectOffer}
                    selectedOfferId={visibleSelectedOffer?.id}
                    activeFilterChips={activeFilterChips}
                    hiddenByFiltersCount={hiddenByFiltersCount}
                    onClearFilters={handleClearFilters}
                    emptyByFilters={emptyByFilters}
                    onEditSearch={handleEditSearchFromEmptyList}
                    onOpenMigrationMonth={handleOpenMigrationMonth}
                    phone={phone}
                    onOpenFilters={openFiltersSheet}
                    mobileToolsCollapsed={visibleMobileToolsCollapsed}
                    onMobileToolsCollapsedChange={setMobileToolsCollapsed}
                    navigationRef={resultsNavigationRef}
                  />
                </div>

                {/* Only while the list can afford it; below that the detail is a
                    side sheet (8a) or a full sheet, never a hidden column. */}
                {detailPlacement === "column" && (
                  <div className="fd-detail-column">
                    <DetailPanel
                      offer={visibleSelectedOffer}
                      request={results?.request}
                      searchJobId={results?.searchJobId}
                      onOfferRevalidated={handleOfferRevalidated}
                      quotationShortcutRef={quotationShortcutRef}
                    />
                  </div>
                )}
              </div>
              <Sheet
                open={workspaceOverlay === "filters" && phone}
                onOpenChange={(open) => setWorkspaceOverlay(open ? "filters" : null)}
                title="Filtros"
                size="partial"
                className="fd-filter-sheet"
                meta={activeFilterChips.length > 0
                  ? <span className="fd-status-pill fd-status-pill-count">{activeFilterChips.length}</span>
                  : undefined}
                /* Plate 1e: «Limpiar» content-sized, the primary taking the
                   rest of the row with the count that survives the filters. */
                footer={(
                  <>
                    <button
                      type="button"
                      className="fd-sheet-action fd-sheet-action--secondary fd-focus-ring"
                      onClick={handleClearFilters}
                    >
                      <AppIcon name="x" size={18} />
                      Limpiar
                    </button>
                    <button
                      type="button"
                      className="fd-sheet-action fd-focus-ring"
                      onClick={closeWorkspaceOverlay}
                    >
                      <AppIcon name="check" size={16} />
                      Ver {formatCount(filteredOffers.length)} {plural(filteredOffers.length, "vuelo")}
                    </button>
                  </>
                )}
              >
                <FiltersPanel
                  activeFilterCount={activeFilterChips.length}
                  filters={filters}
                  allAirlines={airlineOptions}
                  selectedAirlines={selectedAirlines}
                  onClear={handleClearFilters}
                  onFilterChange={handleFilterChange}
                  onToggleAirline={toggleAirline}
                  embedded
                />
              </Sheet>
              {/* Not built while the detail is a column, so one detail exists at a time. */}
              {detailPlacement !== "column" && (
                <Sheet
                  open={workspaceOverlay === "detail"}
                  onOpenChange={(open) => setWorkspaceOverlay(open ? "detail" : null)}
                  title="Oferta"
                  size="full"
                  placement={detailPlacement === "side" ? "side" : "bottom"}
                  container={detailPlacement === "side" ? workspaceElement : undefined}
                  className="fd-detail-sheet"
                  /* 8a and 1f give the sheet the detail's own header, so the close
                     comes from the panel; the grabber and the back swipe stay. */
                  chrome={false}
                  backSwipe
                >
                  <DetailPanel
                    offer={visibleSelectedOffer}
                    request={results?.request}
                    searchJobId={results?.searchJobId}
                    onOfferRevalidated={handleOfferRevalidated}
                    embedded
                    mobileDirect={phone}
                    onClose={closeWorkspaceOverlay}
                    quotationShortcutRef={quotationShortcutRef}
                  />
                </Sheet>
              )}
            </div>
          )}
        </main>
      )}

      <Sheet
        open={Boolean(pastedQuotation)}
        onOpenChange={(open) => {
          if (!open) setPastedQuotation(null)
        }}
        title="Cotización pegada"
        placement={phone ? "bottom" : "modal"}
        size="full"
        className="fd-quotation-paste-sheet"
      >
        {pastedQuotation && (
          <QuotationPastePreview
            text={pastedQuotation.text}
            result={pastedQuotation.result}
            onReview={(request) => handleQuotationDraft(request, false)}
            onSearch={(request) => handleQuotationDraft(request, true)}
          />
        )}
      </Sheet>
    </div>
  )
}

/*
 * Plate 1b — one notice, one line, dismissible. Both live regions stay
 * mounted so the line is announced when it appears: politely for a warning,
 * at once for an error.
 */
function SearchNotice({ notice, onDismiss }: { notice: Notice | null; onDismiss: () => void }) {
  const line = notice ? <NoticeLine notice={notice} onDismiss={onDismiss} /> : null

  return (
    <>
      <div role="status">{notice?.tone === "warning" ? line : null}</div>
      <div role="alert">{notice?.tone === "error" ? line : null}</div>
    </>
  )
}

function NoticeLine({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  const [headline, ...rest] = formatAlertLines(notice.message)
  const detail = rest.join(" · ")

  return (
    <div className={`fd-alert-line fd-motion-emergente mt-2 ${notice.tone === "error" ? "fd-alert-line-error" : ""}`}>
      <AppIcon name={notice.icon ?? "alert"} />
      <span className="fd-alert-line-text" title={notice.message}>
        <span className="font-bold">{headline}</span>
        {detail && (
          <>
            <span className="mx-[7px] opacity-50">·</span>
            <span>{detail}</span>
          </>
        )}
      </span>
      <button
        type="button"
        className="fd-alert-line-dismiss fd-focus-ring"
        aria-label="Descartar el aviso"
        onClick={onDismiss}
      >
        <AppIcon name="x" size={14} />
      </button>
    </div>
  )
}

function PlainLogView({ lines }: { lines: string[] }) {
  const text = lines.length > 0
    ? lines.join("\n")
    : "Sin logs para copiar. Ejecuta una búsqueda y vuelve a esta vista."

  return (
    <main className="min-h-0 flex-1 bg-background">
      <Textarea
        aria-label="Registro de búsqueda"
        readOnly
        spellCheck={false}
        value={text}
        className="fd-scrollbar h-full min-h-0 resize-none bg-background p-4 font-mono text-xs leading-5 text-foreground"
      />
    </main>
  )
}

const FiltersPanel = memo(function FiltersPanel({
  activeFilterCount,
  filters,
  allAirlines,
  selectedAirlines,
  onClear,
  onFilterChange,
  onToggleAirline,
  embedded = false,
}: {
  activeFilterCount: number
  filters: Filters
  allAirlines: AirlineFilterOption[]
  selectedAirlines: string[]
  onClear: () => void
  onFilterChange: (next: Partial<Filters>) => void
  onToggleAirline: (airline: AirlineFilterOption) => void
  embedded?: boolean
}) {
  const stopValue = stopFilterValue(filters)
  const layoverValue = layoverFilterValue(filters)
  const baggageValue = baggageFilterValue(filters)

  return (
    /* One panel in two containers (02 §7): the sheet draws its own header and
       scrolls it, the desk column does neither. */
    <aside className={embedded ? "fd-filter-panel fd-filter-panel--sheet" : "fd-filter-panel"}>
      {!embedded && <header className="fd-filter-panel-header">
        <div className="fd-filter-panel-heading">
          <h2 className="fd-filter-panel-title">Filtros</h2>
          {activeFilterCount > 0 && (
            <span className="fd-status-pill fd-status-pill-count">{activeFilterCount}</span>
          )}
        </div>
        {activeFilterCount > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="chip"
            onClick={onClear}
            className="shrink-0 px-2 font-bold text-primary"
            aria-label="Limpiar filtros"
          >
            <AppIcon name="x" size={14} />
            Limpiar
          </Button>
        )}
      </header>}

      <div className="fd-filter-body fd-scrollbar-hidden">
        <FilterGroup label="Escalas">
          <SegmentedControl
            aria-label="Escalas"
            value={stopValue}
            onValueChange={(value) => onFilterChange(stopFilterPatch(value as StopFilterValue))}
          >
            {STOP_SEGMENTS.map((segment) => (
              <SegmentedOption key={segment.value} value={segment.value}>
                {segment.label}
              </SegmentedOption>
            ))}
          </SegmentedControl>
        </FilterGroup>

        <FilterGroup label="Escala máxima">
          <SegmentedControl
            aria-label="Escala máxima"
            value={layoverValue}
            onValueChange={(value) => onFilterChange(layoverFilterPatch(value as LayoverFilterValue))}
          >
            {LAYOVER_SEGMENTS.map((segment) => (
              <SegmentedOption key={segment.value} value={segment.value}>
                {segment.label}
              </SegmentedOption>
            ))}
          </SegmentedControl>
        </FilterGroup>

        <FilterGroup label="Equipaje incluido">
          <SegmentedControl
            aria-label="Equipaje incluido"
            value={baggageValue}
            onValueChange={(value) => onFilterChange(baggageFilterPatch(value as BaggageFilterValue))}
          >
            {BAGGAGE_SEGMENTS.map((segment) => (
              <SegmentedOption key={segment.value} value={segment.value} icon={segment.icon}>
                {segment.label}
              </SegmentedOption>
            ))}
          </SegmentedControl>
        </FilterGroup>

        {allAirlines.length > 0 && (
          <div className="fd-filter-group fd-filter-group--airlines">
            <div className="fd-filter-group-head">
              <span className="fd-type-micro">Aerolíneas</span>
              <span className="fd-airline-total">
                {selectedAirlines.length > 0
                  ? `${countSelectedAirlines(allAirlines, selectedAirlines)} / ${allAirlines.length}`
                  : allAirlines.length}
              </span>
            </div>
            {/* No scroller of its own: the panel or the sheet body is the one scroll surface (02 §7). */}
            <div className="fd-airline-list">
              {allAirlines.map((airline) => (
                <label key={airline.id} className="fd-airline-row">
                  <Checkbox
                    checked={isAirlineFilterSelected(airline, selectedAirlines)}
                    onCheckedChange={() => onToggleAirline(airline)}
                    aria-label={airline.label}
                  />
                  {/* A carrier with no artwork answers 404: the broken glyph
                      goes, and its box stays so every name starts in line. */}
                  {airline.logo && (
                    <img
                      src={airline.logo}
                      alt=""
                      className="fd-airline-row-logo"
                      decoding="async"
                      loading="lazy"
                      onError={(event) => { event.currentTarget.style.visibility = "hidden" }}
                    />
                  )}
                  <span className="fd-airline-row-name" title={airline.label}>{airline.label}</span>
                  <span className="fd-airline-row-count">{airline.count}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  )
})

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fd-filter-group">
      <div className="fd-filter-group-head">
        <span className="fd-type-micro">{label}</span>
      </div>
      {children}
    </div>
  )
}

function countSelectedAirlines(allAirlines: AirlineFilterOption[], selectedAirlines: string[]): number {
  return allAirlines.filter((airline) => isAirlineFilterSelected(airline, selectedAirlines)).length
}

function airlineChipId(airline: AirlineFilterOption): string {
  return `airline:${airline.id}`
}

/* One chip per active constraint, so each can be removed without the panel. */
function buildActiveFilterChips(
  filters: Filters,
  selectedAirlines: string[],
  allAirlines: AirlineFilterOption[],
): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = []

  const stopSegment = STOP_SEGMENTS.find((segment) => segment.value === stopFilterValue(filters))
  if (stopSegment?.chip) chips.push({ id: "stops", label: stopSegment.chip })

  const layoverSegment = LAYOVER_SEGMENTS.find((segment) => segment.value === layoverFilterValue(filters))
  if (layoverSegment?.chip) chips.push({ id: "layover", label: layoverSegment.chip })

  const baggageSegment = BAGGAGE_SEGMENTS.find((segment) => segment.value === baggageFilterValue(filters))
  if (baggageSegment?.chip) chips.push({ id: "baggage", label: baggageSegment.chip })

  allAirlines
    .filter((airline) => isAirlineFilterSelected(airline, selectedAirlines))
    .forEach((airline) => chips.push({ id: airlineChipId(airline), label: airline.label }))

  return chips
}

function stopFilterValue(filters: Filters): StopFilterValue {
  if (filters.nonStop) return "direct"
  if (filters.maxStopsFilter === "1" || filters.maxStopsFilter === "2+") return filters.maxStopsFilter
  return "any"
}

/* The panel and plate 2g's relax button produce the same patch from here. */
function stopFilterPatch(value: StopFilterValue): Partial<Filters> {
  return {
    nonStop: value === "direct" ? true : undefined,
    maxStopsFilter: value === "1" || value === "2+" ? value : undefined,
  }
}

function layoverFilterPatch(value: LayoverFilterValue): Partial<Filters> {
  return { maxLayoverMinutes: value === "any" ? undefined : value }
}

function baggageFilterPatch(value: BaggageFilterValue): Partial<Filters> {
  return {
    carryOnRequired: value === "carry" || value === "checked" ? true : undefined,
    checkedBaggageRequired: value === "checked" ? true : undefined,
  }
}

/* Plate 2g asks about axes, not chips: three airlines are one filter with one way out. */
type FilterAxis = "stops" | "layover" | "baggage" | "airlines"

function activeFilterAxes(filters: Filters, selectedAirlines: string[]): FilterAxis[] {
  const axes: FilterAxis[] = []
  if (stopFilterValue(filters) !== "any") axes.push("stops")
  if (layoverFilterValue(filters) !== "any") axes.push("layover")
  if (baggageFilterValue(filters) !== "any") axes.push("baggage")
  if (selectedAirlines.length > 0) axes.push("airlines")
  return axes
}

function filtersWithoutAxis(filters: Filters, axis: FilterAxis): Filters {
  switch (axis) {
    case "stops":
      return { ...filters, ...stopFilterPatch("any") }
    case "layover":
      return { ...filters, ...layoverFilterPatch("any") }
    case "baggage":
      return { ...filters, ...baggageFilterPatch("any") }
    case "airlines":
      return filters
  }
}

/** «El filtro de **directo** es el que descarta más.» */
function culpritFilterName(axis: FilterAxis, filters: Filters): string {
  switch (axis) {
    case "stops":
      return STOP_SEGMENTS.find((segment) => segment.value === stopFilterValue(filters))?.chip ?? ""
    case "layover":
      return LAYOVER_SEGMENTS.find((segment) => segment.value === layoverFilterValue(filters))?.chip ?? ""
    case "baggage":
      return BAGGAGE_SEGMENTS.find((segment) => segment.value === baggageFilterValue(filters))?.chip ?? ""
    case "airlines":
      return "aerolíneas"
  }
}

/* One step down the ladder where there is one, off where there is not. */
function relaxFilterStep(axis: FilterAxis, filters: Filters): { label: string; patch: Partial<Filters> } | undefined {
  switch (axis) {
    case "stops": {
      const segment = STOP_SEGMENTS.find((option) => option.value === stopFilterValue(filters))
      if (!segment?.chip) return undefined
      return segment.relaxTo && segment.relaxLabel
        ? { label: segment.relaxLabel, patch: stopFilterPatch(segment.relaxTo) }
        : { label: removeFilterLabel(segment.chip), patch: stopFilterPatch("any") }
    }
    case "layover": {
      const segment = LAYOVER_SEGMENTS.find((option) => option.value === layoverFilterValue(filters))
      if (!segment?.chip) return undefined
      return segment.relaxTo && segment.relaxLabel
        ? { label: segment.relaxLabel, patch: layoverFilterPatch(segment.relaxTo) }
        : { label: removeFilterLabel(segment.chip), patch: layoverFilterPatch("any") }
    }
    case "baggage": {
      const segment = BAGGAGE_SEGMENTS.find((option) => option.value === baggageFilterValue(filters))
      if (!segment?.chip) return undefined
      return segment.relaxTo && segment.relaxLabel
        ? { label: segment.relaxLabel, patch: baggageFilterPatch(segment.relaxTo) }
        : { label: removeFilterLabel(segment.chip), patch: baggageFilterPatch("any") }
    }
    case "airlines":
      return undefined
  }
}

function removeFilterLabel(chip: string): string {
  return `Quitar «${chip}»`
}

function layoverFilterValue(filters: Filters): LayoverFilterValue {
  const value = filters.maxLayoverMinutes
  return value === "120" || value === "240" || value === "360" ? value : "any"
}

function baggageFilterValue(filters: Filters): BaggageFilterValue {
  if (filters.checkedBaggageRequired) return "checked"
  if (filters.carryOnRequired) return "carry"
  return "any"
}

/* The rail as the shared filter reads it, so the list keeps what the backend would. */
function railOfferFilters(filters: Filters, selectedAirlines: string[]): OfferFilters {
  const maxLayover = Number(filters.maxLayoverMinutes)
  return {
    nonStop: filters.nonStop,
    maxStops: filters.maxStopsFilter === "1" ? 1 : undefined,
    minStops: filters.maxStopsFilter === "2+" ? 2 : undefined,
    maxLayoverMinutes: filters.maxLayoverMinutes && Number.isFinite(maxLayover) ? maxLayover : undefined,
    carryOnRequired: filters.carryOnRequired,
    checkedBaggageRequired: filters.checkedBaggageRequired,
    includedAirlineCodes: selectedAirlines.length > 0 ? selectedAirlines : undefined,
  }
}

/* The request the list stands for: the search with the rail laid over it. */
function withListView(request: SearchRequest, filters: Filters, airlines: string[]): SearchRequest {
  return {
    ...request,
    nonStop: filters.nonStop,
    maxStopsFilter: filters.maxStopsFilter,
    maxLayoverMinutes: filters.maxLayoverMinutes,
    carryOnRequired: filters.carryOnRequired,
    checkedBaggageRequired: filters.checkedBaggageRequired,
    baggageRequired: undefined,
    includedAirlineCodes: airlines.length > 0 ? airlines : undefined,
  }
}

function viewFromRequest(request: SearchRequest, sort: SortMode): ListView {
  return { sort, filters: filtersFromRequest(request), airlines: request.includedAirlineCodes ?? [] }
}

/* An airline is the one that sells the offer (`offerAirlineCode`); codes that
   share a name are one option. */
function buildAirlineOptions(offers: CanonicalOffer[]): AirlineFilterOption[] {
  const options = new Map<string, AirlineFilterOption>()
  for (const offer of offers) {
    const code = offerAirlineCode(offer)
    if (!code) continue
    const label = airlineFilterLabel(offer, code)
    const id = label.toLocaleUpperCase("es-PE")
    const option = options.get(id)
    if (option) {
      option.count += 1
      if (!option.codes.includes(code)) option.codes.push(code)
    } else {
      options.set(id, { id, label, logo: airlineLogoAssetPath(code), codes: [code], count: 1 })
    }
  }
  return Array.from(options.values())
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

function airlineFilterLabel(offer: CanonicalOffer, code: string): string {
  const codeToken = airlineToken(code)
  const segments = (offer.itineraries ?? []).flatMap((itinerary) => itinerary.segments ?? [])
  const segment = airlineNameSegmentForCode(segments, codeToken)
    ?? segments.find((candidate) => candidate.marketingCarrierName || candidate.operatingCarrierName)
  return resolveAirlineDisplayName({
    names: [
      segment?.marketingCarrier && airlineToken(segment.marketingCarrier) === codeToken
        ? segment.marketingCarrierName
        : undefined,
      segment?.operatingCarrier && airlineToken(segment.operatingCarrier) === codeToken
        ? segment.operatingCarrierName
        : undefined,
      segment?.marketingCarrierName,
      offer.airline,
      segment?.operatingCarrierName,
    ],
    codes: [code, offer.validatingCarrier, segment?.marketingCarrier, segment?.operatingCarrier],
    fallback: "Aerolínea",
  })
}

function airlineToken(value: unknown): string {
  return String(value ?? "").trim().toUpperCase()
}

function airlineNameSegmentForCode(segments: Segment[], codeToken: string): Segment | undefined {
  if (!codeToken) return undefined

  return segments.find((segment) => (
    (airlineToken(segment.marketingCarrier) === codeToken && Boolean(segment.marketingCarrierName?.trim())) ||
    (airlineToken(segment.operatingCarrier) === codeToken && Boolean(segment.operatingCarrierName?.trim()))
  ))
}

function isAirlineFilterSelected(airline: AirlineFilterOption, selectedAirlines: string[]): boolean {
  return airline.codes.every((code) => selectedAirlines.includes(code))
}

function isMigrationResults(results: SearchJobResponse): boolean {
  return results.request.searchMode === "month-view" || Boolean(results.migrationMonths?.length)
}

/* A month of a sweep shows the cheapest of its offers the rail keeps; the
   offers are the list's own objects, so a confirmed fare shows there too. */
function migrationMonthsForDisplay(
  results: SearchJobResponse | null,
  visibleOffers: CanonicalOffer[],
): DisplayMonth[] | null {
  if (!results || !isMigrationResults(results)) return null

  const visibleById = new Map(visibleOffers.map((offer) => [offer.id, offer]))
  return (results.migrationMonths ?? []).map((month) => {
    const monthOffers = month.offers?.length ? month.offers : month.offer ? [month.offer] : []
    const kept = monthOffers.flatMap((offer) => visibleById.get(offer.id) ?? [])
    const offer = cheapestOffer(kept)
    return {
      ...month,
      offer,
      offers: kept,
      filtered: !offer && monthOffers.length > 0 && month.status !== "loading",
    }
  })
}

/* What the polite region says about the list; a failed search is the alert's to say. */
function describeListForScreenReaders({
  loading,
  hasResults,
  searchFailed,
  months,
  visibleCount,
  totalCount,
}: {
  loading: boolean
  hasResults: boolean
  searchFailed: boolean
  months: DisplayMonth[] | null
  visibleCount: number
  totalCount: number
}): string {
  if (loading) return "Buscando vuelos"
  if (!hasResults || searchFailed) return ""
  if (months) {
    const priced = months.filter((month) => month.offer).length
    return `${priced} de ${months.length} ${months.length === 1 ? "mes" : "meses"} con tarifa`
  }
  if (visibleCount === 0) return totalCount > 0 ? "Ningún vuelo cumple los filtros" : "Sin vuelos para esta búsqueda"
  const flights = `${formatCount(visibleCount)} ${plural(visibleCount, "vuelo")}`
  return visibleCount < totalCount ? `${flights} de ${formatCount(totalCount)}` : flights
}

function isEditableTarget(target: Element): boolean {
  return target instanceof HTMLElement && (
    target.isContentEditable
    || target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
  )
}

function readWorkspacePreferences(): ListView {
  const fallback: ListView = { sort: DEFAULT_SORT_MODE, filters: {}, airlines: [] }

  try {
    const parsed = JSON.parse(sessionStorage.getItem(WORKSPACE_PREFERENCES_KEY) ?? "null") as {
      sortMode?: unknown
      filters?: Record<string, unknown>
      selectedAirlines?: unknown
    } | null
    if (!parsed) return fallback

    const stored = parsed.filters ?? {}
    const filters: Filters = {}
    if (typeof stored.nonStop === "boolean") filters.nonStop = stored.nonStop
    if (stored.maxStopsFilter === "1" || stored.maxStopsFilter === "2+") filters.maxStopsFilter = stored.maxStopsFilter
    if (stored.maxLayoverMinutes === "120" || stored.maxLayoverMinutes === "240" || stored.maxLayoverMinutes === "360") {
      filters.maxLayoverMinutes = stored.maxLayoverMinutes
    }
    if (typeof stored.carryOnRequired === "boolean") filters.carryOnRequired = stored.carryOnRequired
    if (typeof stored.checkedBaggageRequired === "boolean") filters.checkedBaggageRequired = stored.checkedBaggageRequired

    return {
      sort: isSortMode(parsed.sortMode) ? parsed.sortMode : DEFAULT_SORT_MODE,
      filters,
      airlines: Array.isArray(parsed.selectedAirlines)
        ? parsed.selectedAirlines
          .filter((value): value is string => typeof value === "string" && value.length <= 80)
          .slice(0, 32)
        : [],
    }
  } catch {
    return fallback
  }
}

function writeWorkspacePreferences(view: ListView) {
  try {
    sessionStorage.setItem(WORKSPACE_PREFERENCES_KEY, JSON.stringify({
      sortMode: view.sort,
      filters: view.filters,
      selectedAirlines: view.airlines,
    }))
  } catch {
    // A convenience: private browsing must not block the search.
  }
}

function formatAlertLines(message: string) {
  return message
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function readInitialSharedSearch(): SharedSearchState | null {
  try {
    return readSharedSearchFromUrl(new URL(window.location.href))
  } catch {
    return null
  }
}

function readSearchUrlWasWrittenHere(): boolean {
  try {
    return searchUrlWasWrittenHere(new URL(window.location.href))
  } catch {
    return false
  }
}

/* A link that lacks dates, or carries dates before the window, fills the
   form and waits; the form judges and explains everything else. */
function isLaunchableSharedRequest(request: SearchRequest): boolean {
  if (request.searchMode !== "exact") return false
  if (!/^[A-Z]{3}$/.test(request.origin ?? "")) return false
  if (!/^[A-Z]{3}$/.test(request.destination ?? "")) return false
  if (request.origin === request.destination) return false
  if (!isIsoDate(request.departureDate)) return false
  if (request.tripType === "round-trip" && !isIsoDate(request.returnDate)) return false
  if (request.returnDate && request.returnDate < request.departureDate) return false
  return request.departureDate >= SEARCH_DATE_POLICY.minSearchDate
}

function readRestorableJobIdFromUrl(): string | null {
  try {
    const value = new URL(window.location.href).searchParams.get(RESTORE_JOB_QUERY_PARAM)?.trim()
    return value ? value : null
  } catch {
    return null
  }
}

function filtersFromRequest(request: SearchRequest | null | undefined): Filters {
  if (!request) return {}

  return {
    nonStop: request.nonStop,
    maxStopsFilter: request.maxStopsFilter,
    maxLayoverMinutes: request.maxLayoverMinutes,
    carryOnRequired: request.carryOnRequired,
    checkedBaggageRequired: request.checkedBaggageRequired ?? request.baggageRequired,
  }
}
