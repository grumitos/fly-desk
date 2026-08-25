import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { DetailPanel } from "@/components/DetailPanel"
import { ProviderRail } from "@/components/ProviderRail"
import { QuotationPastePreview } from "@/components/QuotationPastePreview"
import { ResultsPanel, type ActiveFilterChip, type EmptyByFiltersCopy } from "@/components/ResultsPanel"
import { ActiveFilterChips } from "@/components/results/ActiveFilterChips"
import { SearchShell } from "@/components/SearchShell"
import { TopBar } from "@/components/TopBar"
import { AppIcon } from "@/components/ui/app-icon"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { SegmentedControl, SegmentedOption } from "@/components/ui/segmented-control"
import { Sheet } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { useSearch } from "@/hooks/useSearch"
import { useShellSize } from "@/hooks/useShellSize"
import { resolveAirlineDisplayName } from "@/lib/airline-names"
import { isIsoDate } from "@/lib/iso-date"
import { hasOpenOverlay } from "@/lib/overlay-stack"
import { motionToken } from "@/lib/reduced-motion"
import {
  ENTERING_WINDOW_MS,
  idleExitDuration,
  measureFlip,
  playFlip,
  useLeaveWindow,
  type FlipRect,
} from "@/lib/search-choreography"
import { migrationRequestForMonth } from "@/lib/api"
import { describeSearchOutcome } from "@/lib/search-outcome"
import { airlineLogoAssetPath } from "../../src/core/airline-assets"
import { parseCommercialQuotation, type CommercialQuotationParseResult } from "../../src/core/quotation-parser"
import {
  readSharedSearchFromText,
  readSharedSearchFromUrl,
  searchUrlWasWrittenHere,
  writeSharedSearchToClipboard,
  writeSharedSearchToUrl,
  type SharedSearchState,
} from "@/lib/search-share"
import type { CanonicalOffer, MigrationMonthSummary, SearchJobResponse, SearchRequest, Segment, SortMode } from "@/types"

/** The three shapes the search takes: 07 §1's two ends, plus 11 §2.4's return. */
type SearchPhase = "idle" | "editing" | "active"

type Filters = {
  nonStop?: boolean
  maxStopsFilter?: string
  maxLayoverMinutes?: string
  carryOnRequired?: boolean
  checkedBaggageRequired?: boolean
}

type AirlineFilterOption = {
  id: string
  label: string
  code: string
  logo: string
  codes: string[]
  count: number
}

type StopFilterValue = "any" | "direct" | "1" | "2+"
type LayoverFilterValue = "any" | "120" | "240" | "360"
type BaggageFilterValue = "any" | "carry" | "checked"

const DEFAULT_SORT_MODE: SortMode = "cheapest"
const WORKSPACE_PREFERENCES_KEY = "fly-desk:workspace-preferences:v1"

type WorkspacePreferences = {
  sortMode: SortMode
  filters: Filters
  selectedAirlines: string[]
}

/*
 * Plate 1b closes the filter panel: three of the four groups are the same
 * segmented control with no separator between them, and the separator appears
 * only before Aerolíneas because that is a different kind of filter — a list of
 * things you include, not a constraint you tighten.
 *
 * The sliders these replaced implied a continuum. "Directo · 1 · 2+" is not a
 * continuum; it is four choices, and a segmented control says so.
 */
/*
 * `relaxTo` is plate 2g's second exit, kept next to the option it loosens.
 *
 * The plate draws exactly one of these — «Permitir 1 escala» when Directo is
 * the filter to blame — and it is a step down the ladder, not a removal: the
 * caption is explicit that the two ways out are "quitar todo o **relajar** el
 * filtro culpable". An option with nothing below it has no `relaxTo`, and there
 * the only relaxation left is taking the filter off.
 */
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
const BAGGAGE_SEGMENTS: Array<{ value: BaggageFilterValue; label: string; icon?: "backpack" | "luggage"; chip?: string; relaxTo?: BaggageFilterValue; relaxLabel?: string }> = [
  { value: "any", label: "Todos" },
  { value: "carry", label: "Mano", icon: "backpack", chip: "Mano incluida" },
  { value: "checked", label: "Bodega", icon: "luggage", chip: "Bodega incluida", relaxTo: "carry", relaxLabel: "Permitir vuelos sin bodega" },
]

export default function App() {
  const { results, loading, error, statusMessage, diagnosticLog, runSearch, restoreJob, cancel } = useSearch()
  const [initialSharedSearch] = useState<SharedSearchState | null>(() => readInitialSharedSearch())
  /* Read before the first search of this tab overwrites the answer. */
  const [openedOwnSearchUrl] = useState(() => readSearchUrlWasWrittenHere())
  const [sessionPreferences] = useState<WorkspacePreferences>(() => readWorkspacePreferences())
  const initialSharedRequest = initialSharedSearch?.request ?? null
  const [sortMode, setSortMode] = useState<SortMode>(() => initialSharedSearch?.sortMode ?? sessionPreferences.sortMode)
  const [selectedOfferId, setSelectedOfferId] = useState<string | null>(null)
  const [lastRequest, setLastRequest] = useState<SearchRequest | null>(null)
  const [workspaceReady, setWorkspaceReady] = useState(false)
  /* Armed at the gesture, so the very first render that mounts the workspace
     already carries the cues of 07 §1; a search launched from an workspace that
     is already on screen does not arm it, because nothing is arriving. */
  const [workspaceEntering, setWorkspaceEntering] = useState(false)
  /* 11 §2.4: going back to edit. «Los resultados anteriores se quedan detrás,
     no se borran, hasta que se busca otra vez» — so this is not a way back to
     the idle screen; it is the form recovering its editing shape over results
     that stay put. It ends at the next search and nowhere else. */
  const [searchEditing, setSearchEditing] = useState(false)
  const [filters, setFilters] = useState<Filters>(() => (
    initialSharedSearch ? filtersFromRequest(initialSharedSearch.request) : sessionPreferences.filters
  ))
  const [selectedAirlines, setSelectedAirlines] = useState<string[]>(() => (
    initialSharedSearch
      ? initialSharedSearch.request.includedAirlineCodes ?? []
      : sessionPreferences.selectedAirlines
  ))
  const [workspaceOverlay, setWorkspaceOverlay] = useState<"filters" | "detail" | null>(null)
  const [mobileToolsCollapsed, setMobileToolsCollapsed] = useState(false)
  const [policyFootTarget, setPolicyFootTarget] = useState<HTMLDivElement | null>(null)
  /* Armazón B mounts the detail sheet over the results region, so the sheet
     needs the element to position against — a ref would not re-render it. */
  const [workspaceElement, setWorkspaceElement] = useState<HTMLDivElement | null>(null)
  const [pastedQuotation, setPastedQuotation] = useState<{
    text: string
    result: CommercialQuotationParseResult
  } | null>(null)
  const [plainLogView, setPlainLogView] = useState(false)
  const [clipboardError, setClipboardError] = useState<string | null>(null)
  /* The notice is dismissible and does not come back within the same search, so
     what we remember is the exact text that was dismissed. */
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null)
  const [searchDraft, setSearchDraft] = useState<SearchRequest | null>(initialSharedRequest)
  /* Offers the provider has confirmed since this search returned, by id. A new
     search empties it: a confirmation belongs to the search it was made in. */
  const [revalidatedOffers, setRevalidatedOffers] = useState<Map<string, CanonicalOffer>>(() => new Map())
  const filtersRef = useRef(filters)
  const selectedAirlinesRef = useRef(selectedAirlines)
  const sortModeRef = useRef(sortMode)
  const searchFrameRef = useRef<HTMLDivElement | null>(null)
  const searchControlsRef = useRef<HTMLDivElement | null>(null)
  const shellRef = useRef<HTMLDivElement | null>(null)
  const toolsBlockRef = useRef<HTMLDivElement | null>(null)
  const pendingChoreographyRef = useRef<
    { frame: FlipRect | null; controls: FlipRect | null; tools: FlipRect | null; phase: SearchPhase } | null
  >(null)
  const searchPhaseRef = useRef<SearchPhase>("idle")
  const toolsBlockAnimationRef = useRef<Animation | null>(null)
  const searchLayoutAnimationRef = useRef<Animation | null>(null)
  const searchControlsAnimationRef = useRef<Animation | null>(null)
  const { shellSize, detailPlacement } = useShellSize(shellRef)
  /* What the keyboard layer of 11 §7 reads. Refs rather than dependencies: the
     listener is bound once, and a shortcut that rebinds on every keystroke of a
     progressive search is a listener nobody can reason about. */
  const shouldShowWorkspaceRef = useRef(false)
  const filteredCandidateOffersRef = useRef<CanonicalOffer[]>([])
  const selectedOfferIdRef = useRef<string | undefined>(undefined)
  const openFiltersRef = useRef<(() => void) | null>(null)
  const selectOfferRef = useRef<((offer: CanonicalOffer) => void) | null>(null)
  /* `C` copies the quotation, which only the detail knows how to produce. It
     hands the shell the action itself when — and only when — the offer on
     screen can actually be quoted. */
  const quotationShortcutRef = useRef<(() => void) | null>(null)

  /*
   * `?job=` opens a search that already exists, which is how a month of a
   * migratory sweep reaches its own tab. It is deliberately not a shared-search
   * link: there is no request to re-run, only a job to read, so the list is on
   * screen in one round trip and keeps filling if the sweep had not finished.
   */
  useEffect(() => {
    const jobId = readRestorableJobIdFromUrl()
    if (!jobId) return
    void restoreJob(jobId)
  }, [restoreJob])

  useEffect(() => {
    filtersRef.current = filters
  }, [filters])

  useEffect(() => {
    selectedAirlinesRef.current = selectedAirlines
  }, [selectedAirlines])

  useEffect(() => {
    sortModeRef.current = sortMode
  }, [sortMode])

  useEffect(() => {
    writeWorkspacePreferences({ sortMode, filters, selectedAirlines })
  }, [filters, selectedAirlines, sortMode])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey || event.key.toLowerCase() !== "l") return
      event.preventDefault()
      setPlainLogView((active) => !active)
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [])

  /*
   * The keyboard contract of 11 §7, in the two contexts the shell owns: "the
   * searcher" and "the list". The third context — inside a popover or a sheet —
   * belongs to that surface, which traps focus and answers its own keys, so
   * this handler stands down whenever one is open.
   *
   * A bare letter is only a shortcut when nothing is being typed into. `/`, `C`
   * and `F` are characters an agent types all day inside a field; the guard on
   * editable targets is what keeps a shortcut from eating a keystroke.
   */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return

      const target = event.target
      const editing = target instanceof HTMLElement
        && (target.isContentEditable
          || target instanceof HTMLInputElement
          || target instanceof HTMLTextAreaElement
          || target instanceof HTMLSelectElement)

      // Whatever is being typed into owns every key, including `Esc` — the
      // field clears itself (11 §7), which is a decision only the field can
      // make because only it knows whether it holds text.
      if (editing) return

      // A sheet or popover on top answers for itself (focus trap, 02 §7).
      if (hasOpenOverlay()) return

      if (event.key === "/") {
        event.preventDefault()
        document.querySelector<HTMLInputElement>('[data-fd-location-field="origin"]')?.focus()
        return
      }

      if (!shouldShowWorkspaceRef.current) return

      const offers = filteredCandidateOffersRef.current
      const key = event.key.toLowerCase()

      if (key === "f") {
        const openFilters = openFiltersRef.current
        event.preventDefault()
        if (openFilters) {
          openFilters()
          return
        }
        // On a desk the filters are already on screen (02 §4), so "open" means
        // put the caret in them.
        document
          .querySelector<HTMLElement>(".fd-filter-column [role='radio'], .fd-filter-column button")
          ?.focus()
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
        if (!selectedOfferIdRef.current) return
        event.preventDefault()
        setSelectedOfferId(null)
        return
      }

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (offers.length === 0) return
        event.preventDefault()
        const current = offers.findIndex((offer) => offer.id === selectedOfferIdRef.current)
        const step = event.key === "ArrowDown" ? 1 : -1
        // From no selection, Down takes the first and Up takes the last.
        const next = current < 0
          ? (step === 1 ? 0 : offers.length - 1)
          : Math.min(offers.length - 1, Math.max(0, current + step))
        const offer = offers[next]
        if (offer) setSelectedOfferId(offer.id)
        return
      }

      if (event.key === "Enter") {
        const offer = offers.find((candidate) => candidate.id === selectedOfferIdRef.current)
        if (!offer) return
        event.preventDefault()
        selectOfferRef.current?.(offer)
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [])

  const candidateOffers = useMemo(() => {
    /*
     * The whole search, not the part that survived the request.
     *
     * The filters travel in the search payload and the server applies them, so
     * `results.offers` is already filtered — using it as the base made every
     * count on this screen compare the filtered list against itself. With
     * filters on (the normal case: they are sticky and they travel in the link)
     * the header said «386» flat instead of «386 de 1.240», the active chips sat
     * beside «0 vuelos ocultos», and 2g's empty panel claimed a total that was
     * not one and could never find the filter to blame, because the offers it
     * lifts the filters off had already been thrown away upstream.
     *
     * `allOffers` is the unfiltered set and the backend has always sent it.
     */
    const sourceOffers = results?.allOffers?.length ? results.allOffers : results?.offers ?? []
    /* An offer the provider has re-confirmed replaces the one the list is
       drawing. Revalidation may return a different fare — that is what it is
       for — and until this the card kept the old figure while the copied text
       carried the new one, with nothing on screen saying which was which. */
    const reconciled = revalidatedOffers.size === 0
      ? sourceOffers
      : sourceOffers.map((offer) => revalidatedOffers.get(offer.id) ?? offer)
    return sortOffersForDisplay(reconciled, sortMode)
  }, [results, revalidatedOffers, sortMode])
  /* What became of the providers. Until this existed the shell had no way to
     say that a search had failed: the backend's nominal warning died in the
     client and a search with both providers down was drawn as a route with no
     flights (04 §8, 08 §1, 11 §3). */
  const searchOutcome = useMemo(() => describeSearchOutcome(results), [results])
  const allAirlines = useMemo(() => {
    const options = new Map<string, AirlineFilterOption>()
    candidateOffers.forEach((offer) => {
      const label = airlineFilterLabel(offer)
      const codes = airlineFilterCodes(offer)
      const id = label.toLocaleUpperCase("es-PE")
      const code = airlineFilterCode(offer)
      const current = options.get(id) ?? { id, label, code, logo: "", codes: [], count: 0 }
      const mergedCodes = new Set([...current.codes, ...codes])
      const resolvedCode = current.code || code
      options.set(id, {
        ...current,
        code: resolvedCode,
        // The 18px logo in the row is the fastest way to find an airline in a
        // list of seven; the name is the confirmation, not the target.
        logo: resolvedCode ? airlineLogoAssetPath(resolvedCode) : "",
        codes: Array.from(mergedCodes),
        count: current.count + 1,
      })
    })
    return Array.from(options.values())
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  }, [candidateOffers])

  const filteredCandidateOffers = useMemo(
    () => applyClientFilters(candidateOffers, filters, selectedAirlines),
    [candidateOffers, filters, selectedAirlines],
  )

  const filteredResults = useMemo(() => {
    if (!results) return null
    if (isMigrationResults(results)) {
      return applyMigrationFilters(results, filteredCandidateOffers, sortMode)
    }

    return { ...results, offers: filteredCandidateOffers, sortMode }
  }, [results, filteredCandidateOffers, sortMode])

  const visibleSelectedOffer = useMemo(() => {
    if (!filteredResults) return null
    if (selectedOfferId) {
      const currentOffer = filteredResults.offers.find((offer) => offer.id === selectedOfferId)
      if (currentOffer) return currentOffer
    }

    return isMigrationResults(filteredResults) ? filteredResults.offers[0] ?? null : null
  }, [filteredResults, selectedOfferId])

  /* The "first" of both FLIPs of 07 §1, taken at the gesture rather than in a
     layout effect: this is the last instant the two elements are still where
     the plate says they start. The mode and trip segments in particular are
     about to change parent, so after the commit there is nothing left to
     measure. `wasIdle` travels with the rects because the measurement is only
     good for a crossing — a search fired from a workspace that is already on
     screen measures the same two boxes and moves neither. */
  const captureChoreographyRects = useCallback(() => {
    pendingChoreographyRef.current = {
      frame: measureFlip(searchFrameRef.current),
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

  /* 04 §8 gives every empty list a way out, and for «vacío por búsqueda» that
     way out is the form itself — the same gesture as 11 §2.4, reached from the
     column instead of from the summary. */
  const handleEditSearchFromEmptyList = useCallback(() => {
    handleSearchEditingChange(true)
  }, [handleSearchEditingChange])

  const handleOfferRevalidated = useCallback((offer: CanonicalOffer) => {
    setRevalidatedOffers((current) => {
      if (current.get(offer.id) === offer) return current
      const next = new Map(current)
      next.set(offer.id, offer)
      return next
    })
  }, [])

  const handleSearch = useCallback(
    (request: SearchRequest, sort?: SortMode) => {
      captureChoreographyRects()
      if (!shouldShowWorkspaceRef.current) setWorkspaceEntering(true)
      setSearchEditing(false)
      const merged = {
        ...request,
        ...filtersRef.current,
        baggageRequired: undefined,
        includedAirlineCodes: selectedAirlinesRef.current,
      }
      const nextSort = sort ?? defaultSortForRequest()
      setClipboardError(null)
      setSelectedOfferId(null)
      setRevalidatedOffers(new Map())
      setSortMode(nextSort)
      setWorkspaceReady(false)
      setSearchDraft(merged)
      setLastRequest(merged)
      writeSharedSearchToUrl(merged, nextSort)
      void runSearch(merged, nextSort).then((started) => {
        if (started) {
          setWorkspaceReady(true)
        }
      })
    },
    [captureChoreographyRects, runSearch]
  )

  /*
   * A shared link carries a whole request, but until now it only filled the
   * form. Whoever opened one saw a page that looked ready and did nothing,
   * which reads as "the link is broken" rather than "press Buscar" — the link
   * always implied the search, so it runs it, once.
   *
   * Only `exact` launches. The other three modes are sweeps that cost many
   * searches, and starting one from a pasted URL is a surprise nobody asked
   * for; those still arrive with the form filled and wait for the gesture.
   * `?job=` wins over both: it has results to read rather than a search to pay
   * for. And a reload is not a link — see `searchUrlWasWrittenHere`.
   */
  const sharedSearchLaunched = useRef(false)
  useEffect(() => {
    if (sharedSearchLaunched.current) return
    if (!initialSharedRequest || !isLaunchableSharedRequest(initialSharedRequest)) return
    if (readRestorableJobIdFromUrl()) return
    if (openedOwnSearchUrl) return
    /* Deferred a tick for the same reason `restoreJob` above gets away with it:
       the launch belongs after the paint that shows the filled form, not inside
       it. The guard is set in the callback, not here, so React's development
       double-invoke cancels the first timer and still leaves one that fires. */
    const timer = window.setTimeout(() => {
      sharedSearchLaunched.current = true
      handleSearch(initialSharedRequest, initialSharedSearch?.sortMode)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [handleSearch, initialSharedRequest, initialSharedSearch, openedOwnSearchUrl])

  /* 06 §1.3 and 11 §5: «al elegir un mes se entra en la lista normal de ese mes»
     — the same one-way range search the sweep ran for it, dates already in the
     form. The month's own request is rebuilt from the sweep's, so the list that
     opens is the month that was swept and not a near-miss of it. `handleSearch`
     puts the agent's current filters back on top. */
  const handleOpenMigrationMonth = useCallback((month: MigrationMonthSummary) => {
    /* The sweep already ran this month and the server still holds its job, so
       the new tab reads it rather than paying for it twice: the list is there
       on the first round trip and keeps filling if the month had not finished.
       A month whose job the server no longer has falls back to re-running it
       here, which is the old behaviour and still better than a dead click. */
    if (month.searchJobId) {
      const url = new URL(window.location.href)
      url.search = `?${RESTORE_JOB_QUERY_PARAM}=${encodeURIComponent(month.searchJobId)}`
      url.hash = ""
      window.open(url.toString(), "_blank", "noopener")
      return
    }

    const base = lastRequest ?? searchDraft ?? initialSharedRequest
    if (!base || !month.departureStart || !month.departureEnd) return
    handleSearch(migrationRequestForMonth(base, {
      departureStart: month.departureStart,
      departureEnd: month.departureEnd,
    }))
  }, [handleSearch, initialSharedRequest, lastRequest, searchDraft])

  const handlePasteSearchConfig = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      const sharedSearch = readSharedSearchFromText(text)
      if (!sharedSearch) {
        const parsedQuotation = parseCommercialQuotation(text)
        if (parsedQuotation.fields.format.state !== "parsed") {
          setClipboardError("No se encontró una configuración ni una cotización comercial válida en el portapapeles.")
          return
        }
        setClipboardError(null)
        setPastedQuotation({ text, result: parsedQuotation })
        return
      }

      setPastedQuotation(null)
      const nextFilters = filtersFromRequest(sharedSearch.request)
      filtersRef.current = nextFilters
      selectedAirlinesRef.current = sharedSearch.request.includedAirlineCodes ?? []
      sortModeRef.current = sharedSearch.sortMode
      setClipboardError(null)
      setSelectedOfferId(null)
      setWorkspaceReady(false)
      setSortMode(sharedSearch.sortMode)
      setFilters(nextFilters)
      setSelectedAirlines(sharedSearch.request.includedAirlineCodes ?? [])
      setLastRequest(sharedSearch.request)
      setSearchDraft(sharedSearch.request)
      writeSharedSearchToUrl(sharedSearch.request, sharedSearch.sortMode)
    } catch {
      setClipboardError("No se pudo leer el portapapeles. Revisa el permiso del navegador e intenta nuevamente.")
    }
  }, [])

  const handleQuotationDraft = useCallback((request: SearchRequest, execute: boolean) => {
    /* Loading a configuration without running it is the one way back to the
       idle screen, and 07 §1 gives the way back its own budget. */
    captureChoreographyRects()
    const nextFilters = filtersFromRequest(request)
    filtersRef.current = nextFilters
    selectedAirlinesRef.current = []
    sortModeRef.current = DEFAULT_SORT_MODE
    setPastedQuotation(null)
    setClipboardError(null)
    setSelectedOfferId(null)
    setWorkspaceReady(false)
    setFilters(nextFilters)
    setSelectedAirlines([])
    setSortMode(DEFAULT_SORT_MODE)

    if (execute) {
      handleSearch(request, DEFAULT_SORT_MODE)
      return
    }

    setLastRequest(request)
    setSearchDraft(request)
    writeSharedSearchToUrl(request, DEFAULT_SORT_MODE)
  }, [captureChoreographyRects, handleSearch])

  const handleSelectOffer = useCallback((offer: CanonicalOffer) => {
    setSelectedOfferId(offer.id)
    /* Keyed on where the detail is, not on which armazón the form is wearing:
       between 1100 and 1436 the shell is still A and the detail is a sheet. */
    if (detailPlacement !== "column") setWorkspaceOverlay("detail")
  }, [detailPlacement])

  useEffect(() => {
    selectOfferRef.current = handleSelectOffer
  }, [handleSelectOffer])

  const handleCopySearchConfig = useCallback(async () => {
    const draft = searchDraft ?? lastRequest ?? initialSharedRequest
    if (!draft) return

    const request = {
      ...draft,
      ...filtersRef.current,
      baggageRequired: undefined,
      includedAirlineCodes: selectedAirlinesRef.current.length ? selectedAirlinesRef.current : undefined,
    }

    try {
      await writeSharedSearchToClipboard(request, sortModeRef.current)
      setClipboardError(null)
    } catch {
      setClipboardError("No se pudo copiar la configuración. Revisa el permiso del navegador e intenta nuevamente.")
    }
  }, [initialSharedRequest, lastRequest, searchDraft])

  const handleSort = useCallback(
    (sort: SortMode) => {
      sortModeRef.current = sort
      setSortMode(sort)
      if (lastRequest) {
        const nextRequest = { ...lastRequest, sortMode: sort }
        setLastRequest(nextRequest)
        writeSharedSearchToUrl(nextRequest, sort)
      }
    },
    [lastRequest]
  )

  const handleFilterChange = useCallback(
    (next: Partial<Filters>) => {
      const merged = { ...filters, ...next }
      filtersRef.current = merged
      setFilters(merged)
      if (lastRequest) {
        const nextRequest = { ...lastRequest, ...merged, baggageRequired: undefined, includedAirlineCodes: selectedAirlines }
        setLastRequest(nextRequest)
        writeSharedSearchToUrl(nextRequest, sortMode)
      }
    },
    [filters, lastRequest, selectedAirlines, sortMode]
  )

  const handleClearFilters = useCallback(() => {
    filtersRef.current = {}
    selectedAirlinesRef.current = []
    setFilters({})
    setSelectedAirlines([])
    if (lastRequest) {
      const nextRequest = {
        ...lastRequest,
        nonStop: undefined,
        maxStopsFilter: undefined,
        maxLayoverMinutes: undefined,
        carryOnRequired: undefined,
        checkedBaggageRequired: undefined,
        baggageRequired: undefined,
        includedAirlineCodes: undefined,
      }
      setLastRequest(nextRequest)
      writeSharedSearchToUrl(nextRequest, sortMode)
    }
  }, [lastRequest, sortMode])

  const toggleAirline = useCallback((airline: AirlineFilterOption) => {
    const tokens = airline.codes.length > 0 ? airline.codes : [airline.label]
    const current = new Set(selectedAirlines)
    const selected = tokens.every((token) => current.has(token))
    tokens.forEach((token) => {
      if (selected) {
        current.delete(token)
      } else {
        current.add(token)
      }
    })
    const nextAirlines = Array.from(current)
    selectedAirlinesRef.current = nextAirlines
    setSelectedAirlines(nextAirlines)
    if (lastRequest) {
      const nextRequest = { ...lastRequest, ...filters, baggageRequired: undefined, includedAirlineCodes: nextAirlines }
      setLastRequest(nextRequest)
      writeSharedSearchToUrl(nextRequest, sortMode)
    }
  }, [filters, lastRequest, selectedAirlines, sortMode])

  const clearAirlineFilter = useCallback(() => {
    selectedAirlinesRef.current = []
    setSelectedAirlines([])
    if (lastRequest) {
      const nextRequest = { ...lastRequest, ...filters, baggageRequired: undefined, includedAirlineCodes: undefined }
      setLastRequest(nextRequest)
      writeSharedSearchToUrl(nextRequest, sortMode)
    }
  }, [filters, lastRequest, sortMode])

  const activeFilterChips = useMemo(
    () => buildActiveFilterChips(filters, selectedAirlines, allAirlines),
    [allAirlines, filters, selectedAirlines],
  )
  const hiddenByFiltersCount = Math.max(0, candidateOffers.length - filteredCandidateOffers.length)
  const shouldShowWorkspace = workspaceReady || Boolean(results) || loading
  const isSearchIdle = !shouldShowWorkspace
  const loadingLabel = "Buscando"
  /* The three shapes the search can take. `editing` is not a fourth screen: it
     is `active` with the form back in its resting anatomy (11 §2.4). */
  const searchPhase: SearchPhase = isSearchIdle ? "idle" : searchEditing ? "editing" : "active"

  useEffect(() => {
    shouldShowWorkspaceRef.current = shouldShowWorkspace
  }, [shouldShowWorkspace])

  useEffect(() => {
    searchPhaseRef.current = searchPhase
  }, [searchPhase])

  useEffect(() => {
    filteredCandidateOffersRef.current = filteredCandidateOffers
  }, [filteredCandidateOffers])

  useEffect(() => {
    selectedOfferIdRef.current = selectedOfferId ?? undefined
  }, [selectedOfferId])

  useEffect(() => {
    openFiltersRef.current = shellSize === "C"
      ? () => setWorkspaceOverlay("filters")
      : null
  }, [shellSize])

  const handleRemoveFilterChip = useCallback((id: string) => {
    if (id === "stops") {
      handleFilterChange({ nonStop: undefined, maxStopsFilter: undefined })
      return
    }
    if (id === "layover") {
      handleFilterChange({ maxLayoverMinutes: undefined })
      return
    }
    if (id === "baggage") {
      handleFilterChange({ carryOnRequired: undefined, checkedBaggageRequired: undefined })
      return
    }

    const airlineId = id.startsWith("airline:") ? id.slice("airline:".length) : null
    const airline = airlineId ? allAirlines.find((option) => option.id === airlineId) : undefined
    if (airline) toggleAirline(airline)
  }, [allAirlines, handleFilterChange, toggleAirline])

  /**
   * Plate 2g's second exit, which only this file can work out: with the list
   * empty, each active filter is lifted in turn and the offers that come back
   * are counted. The one that recovers most is the filter to blame.
   *
   * A tie, or nothing recovered, yields no copy at all. Naming the wrong filter
   * sends the agent to undo one that was not the problem, so the panel is
   * written to say the count and stop there.
   */
  const emptyByFilters = useMemo<EmptyByFiltersCopy | undefined>(() => {
    if (filteredCandidateOffers.length > 0 || candidateOffers.length === 0) return undefined

    const axes = activeFilterAxes(filters, selectedAirlines)
    let culprit: FilterAxis | undefined
    let best = 0
    let tied = false
    for (const axis of axes) {
      const recovered = applyClientFilters(
        candidateOffers,
        filtersWithoutAxis(filters, axis),
        axis === "airlines" ? [] : selectedAirlines,
      ).length
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
    const onlyAirline = culprit === "airlines" && selectedAirlines.length > 0
      ? allAirlines.filter((airline) => isAirlineFilterSelected(airline, selectedAirlines))
      : []

    return {
      /* "El que descarta más" is a comparison, so it needs something to compare
         against: with a single filter on there is no more and no less, and the
         panel's own title already names it. The way out still applies. */
      culpritSentence: name && axes.length > 1
        ? `El filtro de ${name.toLocaleLowerCase("es-PE")} es el que descarta más.`
        : undefined,
      relax: step
        ? { label: step.label, onClick: () => handleFilterChange(step.patch) }
        : culprit === "airlines"
          ? {
              label: onlyAirline.length === 1 && onlyAirline[0]
                ? removeFilterLabel(onlyAirline[0].label)
                : "Quitar el filtro de aerolíneas",
              onClick: clearAirlineFilter,
            }
          : undefined,
    }
  }, [
    allAirlines,
    candidateOffers,
    clearAirlineFilter,
    filteredCandidateOffers.length,
    filters,
    handleFilterChange,
    selectedAirlines,
  ])

  /*
   * The two rows of 07 §1 that CSS cannot reach, both at the 60ms cue:
   *
   *    bloque de campos      `translateY` al tope, `estructura`
   *    modo + tipo de viaje  FLIP del formulario a la barra de título
   *
   * Same cue, same token, one effect — they are one movement with two moving
   * parts, and splitting them would be two clocks for one gesture. The way back
   * («editar la búsqueda») is the same pair inverted inside the 180ms of
   * `--fd-dur-vuelta`, with no cue: a cue is what staggers an arrival.
   */
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
    /* Going back — to the idle screen or into editing — is «la misma secuencia
       invertida en 180 ms», one budget with no cue in front of it: a cue is
       what staggers an arrival, and nothing is arriving.
       Read off the frame, not off the root: the cue is 60ms on a desk and 0 on
       a phone, and which one applies is a container query on the stage the
       frame lives in. */
    const goingBack = searchPhase !== "active"
    const delay = goingBack ? 0 : motionToken("--fd-cue-campos", frame)
    const duration = goingBack
      ? motionToken("--fd-dur-vuelta", frame)
      : motionToken("--fd-dur-estructura", frame)

    if (frame && pending.frame) {
      searchLayoutAnimationRef.current = playFlip(frame, pending.frame, { delay, duration, matchWidth: true })
    }

    const controls = searchControlsRef.current
    if (controls && pending.controls) {
      searchControlsAnimationRef.current = playFlip(controls, pending.controls, { delay, duration })
    }

    /* «El bloque crece a su alto natural» (2h). On a phone the box does not
       travel on the way back — it stays under the title bar and only gets
       taller — so this is the only piece of the return that moves there. */
    const tools = toolsBlockRef.current
    if (goingBack && tools && pending.tools) {
      toolsBlockAnimationRef.current = playFlip(tools, pending.tools, { delay, duration, matchHeight: true })
    }
  }, [searchPhase])

  /* The cues come down once the table has run its 420ms, counted from the press
     as the table counts them. After that what happens is judged on its own: a
     detail panel picked later arrives with 05 §8's no-delay 8px, not with the
     140ms this one arrival needed. */
  useEffect(() => {
    if (!workspaceEntering) return
    const timer = window.setTimeout(() => setWorkspaceEntering(false), ENTERING_WINDOW_MS)
    return () => window.clearTimeout(timer)
  }, [workspaceEntering])

  /* 07 §1 at 60ms: the frequent chips and the provider rail belong to the idle
     screen and they *leave*, they do not blink out. React's answer to "not idle
     any more" is to unmount them, so the window holds them alive exactly as
     long as their row of the table lasts. */
  const idleChrome = useLeaveWindow(isSearchIdle, idleExitDuration)

  /* One fact — "does the desk know a search configuration?" — behind both
     capsule cells: Copy is disabled by it, Paste is only dimmed by it. */
  const hasSearchConfig = Boolean(searchDraft || lastRequest || initialSharedRequest)
  const visibleMobileToolsCollapsed = shellSize === "C" && mobileToolsCollapsed

  /* `dvh`, never `vh` (02 §10): Tailwind's `h-screen` is `100vh`, which on a
     phone measures the window without the virtual keyboard and cut the open
     sheet off at the bottom. */
  return (
    <div
      ref={shellRef}
      className="fd-shell flex h-[100dvh] flex-col overflow-hidden bg-background text-foreground"
      data-shell-size={shellSize}
      data-fd-sheet-root=""
    >
      <TopBar
        copySearchDisabled={!hasSearchConfig}
        pasteSearchDimmed={!hasSearchConfig}
        onCopySearchConfig={handleCopySearchConfig}
        onPasteSearchConfig={handlePasteSearchConfig}
        workspaceActive={shouldShowWorkspace}
      />

      {plainLogView ? (
        <PlainLogView lines={diagnosticLog} />
      ) : (
        <main
          className={`fd-search-stage ${
            isSearchIdle ? "fd-search-stage-idle" : "fd-search-stage-active"
          }`}
          data-tools-collapsed={visibleMobileToolsCollapsed}
          data-entering={workspaceEntering ? "" : undefined}
        >
          {/* Plate 1a spaces the idle screen with two unequal spacers — 1 above
              the form, 1.3 below — which is what leaves the form slightly above
              centre and the rail on the bottom edge. */}
          {isSearchIdle && <div className="fd-search-stage-spacer-top" aria-hidden="true" />}

          {/*
            Plate 1d draws the retractable block as ONE container: search
            summary, filter chips and notice inside a single `max-height`. They
            used to live in two subtrees with two collapse mechanisms, which is
            why the layout tore when the bar undocked. The status row and the
            list are its siblings and never retract (02 §9).
          */}
          <div
            ref={toolsBlockRef}
            className="fd-tools-block"
            data-collapsed={visibleMobileToolsCollapsed}
            data-active={shouldShowWorkspace}
            /* The 182px ceiling of 02 §9 measures the *summary* band. While the
               form is open for editing the block is the form, and «el bloque
               crece a su alto natural» (2h): left capped, the passenger field
               and the CTA sit 301px below the clip. */
            data-editing={searchEditing ? "" : undefined}
          >
          <div
            ref={searchFrameRef}
            data-testid="search-shell-frame"
            className="fd-search-frame"
          >
            <SearchShell
              onSearch={handleSearch}
              loading={loading}
              loadingLabel={loadingLabel}
              onCancelSearch={cancel}
              /* The segments have two homes and no third: above the form while
                 the screen is at rest, and centred in the title bar for as long
                 as a search exists. Editing used to hand them back down — the
                 inverse FLIP of 07 §1 — which meant every click on a field made
                 the pills jump out of the bar and back into the form. That is
                 not a state worth drawing: `editing` reopens the *fields*, and
                 the mode of the search is not one of them. */
              controlsPlacement={searchPhase !== "idle" && shellSize !== "C" ? "topbar" : "inline"}
              compactActive={shouldShowWorkspace && shellSize === "C"}
              mobilePresentation={shellSize === "C"}
              policyFootTarget={policyFootTarget}
              /* Idle only. Editing is the form at rest with results behind
                 it, but the shortcuts are furniture of the empty screen: once a
                 search exists they compete with the results for the same eye.
                 The provider rail already stays behind for the same reason
                 (03 §1). */
              showLocationUsageSuggestions={isSearchIdle}
              idle={isSearchIdle}
              usageSuggestionsLeaving={idleChrome.leaving}
              workspaceActive={shouldShowWorkspace}
              editing={searchEditing}
              onEditingChange={handleSearchEditingChange}
              controlsRef={searchControlsRef}
              syncedRequest={lastRequest ?? initialSharedRequest}
              onSearchConfigDraftChange={setSearchDraft}
            />

          </div>

            {/* Armazón C mounts the strip here, between the summary and the
                notice, so the three retract as one (02 §4). Elsewhere it is the
                list header's own row. */}
            {shouldShowWorkspace && shellSize === "C" && (
              <ActiveFilterChips
                chips={activeFilterChips}
                activeFilterCount={activeFilterChips.length}
                hiddenByFiltersCount={hiddenByFiltersCount}
                onOpenFilters={() => setWorkspaceOverlay("filters")}
                onRemoveFilter={handleRemoveFilterChip}
                /* The title bar is gone from this armazón once a search
                   exists, so its one surviving action lives here. */
                onCopySearchConfig={handleCopySearchConfig}
                copyDisabled={!hasSearchConfig}
              />
            )}

            {/* 11 §3 keeps one notice and one line. The provider outcome comes
                last because a request that never left, a cancellation and a
                clipboard failure are all about the gesture the agent just made;
                a provider falling over is about the search behind it. */}
            <SearchNotice
              message={clipboardError || error || statusMessage || searchOutcome.notice || ""}
              tone={clipboardError || error || searchOutcome.allFailed || searchOutcome.jobFailed
                ? "error"
                : "warning"}
              onDismiss={() => {
                setClipboardError(null)
                setDismissedNotice(clipboardError || error || statusMessage || searchOutcome.notice || "")
              }}
              dismissed={dismissedNotice}
            />
          </div>

          {isSearchIdle && <div className="fd-search-stage-spacer-bottom" aria-hidden="true" />}
          {/* 03 §8 puts the policy lines «al pie del reposo», next to the
              provider rail — not tucked under the fields, where they came
              between the form and its own errors. The slot is here on every
              armazón; only the wording narrows on a phone. */}
          {isSearchIdle && <div ref={setPolicyFootTarget} className="fd-policy-foot" />}
          {idleChrome.mounted && <ProviderRail leaving={idleChrome.leaving} />}

          {shouldShowWorkspace && (
            <div ref={setWorkspaceElement} className="fd-shell-workspace">
              <div className="fd-results">
                {/* Armazón A and B keep the 248px column; C turns it into a
                    partial sheet (02 §4). Like the detail below, the column is
                    not built rather than hidden: a second live `FiltersPanel`
                    behind `display:none` was two copies of the same state, and
                    02 §5 forbids the `display:none` besides. */}
                {shellSize !== "C" && (
                  <div className="fd-filter-column">
                    <FiltersPanel
                      activeFilterCount={activeFilterChips.length}
                      filters={filters}
                      allAirlines={allAirlines}
                      selectedAirlines={selectedAirlines}
                      onClear={handleClearFilters}
                      onFilterChange={handleFilterChange}
                      onToggleAirline={toggleAirline}
                    />
                  </div>
                )}

                <div className="fd-list">
                  <ResultsPanel
                    key={`${results?.searchJobId ?? "idle"}:${shellSize}`}
                    results={filteredResults}
                    unfilteredOfferCount={candidateOffers.length}
                    loading={loading}
                    sort={sortMode}
                    onSort={handleSort}
                    onSelectOffer={handleSelectOffer}
                    selectedOfferId={visibleSelectedOffer?.id}
                    activeFilterChips={activeFilterChips}
                    hiddenByFiltersCount={hiddenByFiltersCount}
                    onRemoveFilter={handleRemoveFilterChip}
                    onClearFilters={handleClearFilters}
                    emptyByFilters={emptyByFilters}
                    onEditSearch={handleEditSearchFromEmptyList}
                    onOpenMigrationMonth={handleOpenMigrationMonth}
                    onOpenFilters={shellSize === "C" ? () => setWorkspaceOverlay("filters") : undefined}
                    onMobileToolsCollapsedChange={setMobileToolsCollapsed}
                    mobileCollapseEnabled={shellSize === "C"}
                    chipsPlacement={shellSize === "C" ? "external" : "none"}
                  />
                </div>

                {/* Only while the list can still afford it. Below that the
                    detail leaves the grid entirely and overlays the results as
                    a side sheet (02 §1, plate 8a); on a phone it is a full
                    sheet. The column is not hidden with `display:none` — it is
                    not built. */}
                {detailPlacement === "column" && (
                  <div className="fd-detail-column">
                    <DetailPanel
                      offer={visibleSelectedOffer}
                      request={filteredResults?.request}
                      searchJobId={results?.searchJobId}
                      onOfferRevalidated={handleOfferRevalidated}
                      quotationShortcutRef={quotationShortcutRef}
                    />
                  </div>
                )}
              </div>
              <Sheet
                open={workspaceOverlay === "filters" && shellSize === "C"}
                onOpenChange={(open) => setWorkspaceOverlay(open ? "filters" : null)}
                title="Filtros"
                size="partial"
                className="fd-filter-sheet"
                meta={activeFilterChips.length > 0
                  ? <span className="fd-status-pill fd-status-pill-count">{activeFilterChips.length}</span>
                  : undefined}
                /* Plate 1e: the shared sheet-footer pattern — «Limpiar» at 44 and
                   content-sized, the primary at 52 taking the rest of the row and
                   saying how many flights survive the filters. */
                footer={(
                  <>
                    <button
                      type="button"
                      className="fd-sheet-action fd-sheet-action--secondary fd-focus-ring"
                      onClick={handleClearFilters}
                    >
                      Limpiar
                    </button>
                    <button
                      type="button"
                      className="fd-sheet-action fd-focus-ring"
                      onClick={() => setWorkspaceOverlay(null)}
                    >
                      <AppIcon name="check" size={16} />
                      {filteredCandidateOffers.length === 1
                        ? "Ver 1 vuelo"
                        : `Ver ${filteredCandidateOffers.length.toLocaleString("es-PE")} vuelos`}
                    </button>
                  </>
                )}
              >
                <FiltersPanel
                  activeFilterCount={activeFilterChips.length}
                  filters={filters}
                  allAirlines={allAirlines}
                  selectedAirlines={selectedAirlines}
                  onClear={handleClearFilters}
                  onFilterChange={handleFilterChange}
                  onToggleAirline={toggleAirline}
                  embedded
                />
              </Sheet>
              <Sheet
                open={workspaceOverlay === "detail" && detailPlacement !== "column"}
                onOpenChange={(open) => setWorkspaceOverlay(open ? "detail" : null)}
                title="Oferta"
                size="full"
                placement={detailPlacement === "side" ? "side" : "bottom"}
                container={detailPlacement === "side" ? workspaceElement : undefined}
                className="fd-detail-sheet"
                /* Neither sheet draws chrome of its own: 8a gives the side sheet
                   the detail's header with a 32px cross, and 1f gives the full
                   sheet the same header with a 44px back chevron — no grabber,
                   no second title bar saying less than the first. So the close
                   comes from the panel on both, and the dialog keeps its name. */
                chrome={false}
              >
                <DetailPanel
                  offer={visibleSelectedOffer}
                  request={filteredResults?.request}
                  searchJobId={results?.searchJobId}
                  onOfferRevalidated={handleOfferRevalidated}
                  embedded
                  mobileDirect={shellSize === "C"}
                  onClose={() => setWorkspaceOverlay(null)}
                  quotationShortcutRef={quotationShortcutRef}
                />
              </Sheet>
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
        placement={shellSize === "C" ? "bottom" : "modal"}
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

/**
 * Plate 1b — one notice, one line.
 *
 * This replaced a chain of technical warnings that stacked up and pushed the
 * results down. It appears only when the search actually failed, states the
 * reason, and can be dismissed; once dismissed it does not return within the
 * same search, because an agent who has read it does not need it again.
 */
function SearchNotice({
  message,
  tone,
  dismissed,
  onDismiss,
}: {
  message: string
  tone: "warning" | "error"
  dismissed: string | null
  onDismiss: () => void
}) {
  if (!message || message === dismissed) return null

  const [headline, ...rest] = formatAlertLines(message)
  const detail = rest.join(" · ")

  return (
    <div
      className={`fd-alert-line fd-motion-emergente mt-2 ${tone === "error" ? "fd-alert-line-error" : ""}`}
      role="status"
    >
      <AppIcon name="alert" />
      <span className="fd-alert-line-text" title={message}>
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
        className="fd-scrollbar h-full min-h-0 w-full resize-none rounded-none border-0 bg-background p-4 font-mono text-xs leading-5 text-foreground shadow-none outline-none focus-visible:ring-0"
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
    /* One component, two containers (rule of 02 §7), and the fork between them
       is one class shorter than it was. The desk column used to be a card and
       the sheet was not, so the panel carried `.fd-panel` in one branch and
       dropped it in the other; the column is now the same flat rail the sheet
       has always drawn — a filter panel is not an object, it is the control of
       the list beside it, and a box around it presents it as a thing apart from
       the results it governs. What is left in the branch is what the sheet
       genuinely does differently: it does not scroll itself and it has no
       header, because the sheet draws one. */
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
            className="shrink-0 !px-2 text-xs font-bold text-primary"
            aria-label="Limpiar filtros"
          >
            <AppIcon name="x" size={14} />
            Limpiar
          </Button>
        )}
      </header>}

      <div className="fd-filter-body fd-scrollbar-hidden">
        {/* Three constraints, one control, no separators between them. */}
        <FilterGroup label="Escalas" used={stopValue !== "any"}>
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

        <FilterGroup label="Escala máxima" used={layoverValue !== "any"}>
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

        <FilterGroup label="Equipaje incluido" used={baggageValue !== "any"}>
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

        {/* The separator goes here and nowhere else: this is a different kind of
            filter, and the rule is a cheaper signal than a heading change. */}
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
            {/* No scroller of its own: the panel body on a desk and the sheet
                body on a phone are the single scroll surface (02 §7). */}
            <div className="fd-airline-list">
              {allAirlines.map((airline) => (
                <label key={airline.id} className="fd-airline-row">
                  <Checkbox
                    checked={isAirlineFilterSelected(airline, selectedAirlines)}
                    onCheckedChange={() => onToggleAirline(airline)}
                    aria-label={airline.label}
                  />
                  {airline.logo && (
                    <img
                      src={airline.logo}
                      alt=""
                      className="fd-airline-row-logo"
                      decoding="async"
                      loading="lazy"
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

/**
 * A group nobody has touched sits at 72% opacity and says "sin usar". Greying it
 * out is what lets the agent see, without reading, which constraints are on —
 * and an untouched group at full contrast is indistinguishable from one set to
 * its widest value, which is the same picture with a different meaning.
 */
function FilterGroup({
  label,
  used,
  children,
}: {
  label: string
  used: boolean
  children: React.ReactNode
}) {
  return (
    <div className="fd-filter-group" data-used={used}>
      <div className="fd-filter-group-head">
        <span className="fd-type-micro">{label}</span>
        {!used && <span className="fd-filter-group-unused">sin usar</span>}
      </div>
      {children}
    </div>
  )
}

function countSelectedAirlines(allAirlines: AirlineFilterOption[], selectedAirlines: string[]): number {
  return allAirlines.filter((airline) => isAirlineFilterSelected(airline, selectedAirlines)).length
}

/**
 * The chips above the list, and the way back out of each one. Every active
 * constraint gets exactly one chip, so removing them one at a time is possible
 * without opening the panel.
 */
function buildActiveFilterChips(
  filters: Filters,
  selectedAirlines: string[],
  allAirlines: AirlineFilterOption[],
): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = []

  const stopValue = stopFilterValue(filters)
  const stopSegment = STOP_SEGMENTS.find((segment) => segment.value === stopValue)
  if (stopSegment?.chip) chips.push({ id: "stops", label: stopSegment.chip })

  const layoverValue = layoverFilterValue(filters)
  const layoverSegment = LAYOVER_SEGMENTS.find((segment) => segment.value === layoverValue)
  if (layoverSegment?.chip) chips.push({ id: "layover", label: layoverSegment.chip })

  const baggageValue = baggageFilterValue(filters)
  const baggageSegment = BAGGAGE_SEGMENTS.find((segment) => segment.value === baggageValue)
  if (baggageSegment?.chip) chips.push({ id: "baggage", label: baggageSegment.chip })

  allAirlines
    .filter((airline) => isAirlineFilterSelected(airline, selectedAirlines))
    .forEach((airline) => chips.push({ id: `airline:${airline.id}`, label: airline.label }))

  return chips
}

function stopFilterValue(filters: Filters): StopFilterValue {
  if (filters.nonStop) return "direct"
  if (filters.maxStopsFilter === "1" || filters.maxStopsFilter === "2+") return filters.maxStopsFilter
  return "any"
}

/* One place per group where a chosen segment becomes a patch, because the panel
   and plate 2g's relax button both have to produce the same one. */
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

/**
 * The four things a filter panel can constrain. Plate 2g asks which one is
 * throwing the most offers away, and that is a question about axes, not about
 * chips: three selected airlines are one filter with one way out, not three.
 */
type FilterAxis = "stops" | "layover" | "baggage" | "airlines"

function activeFilterAxes(filters: Filters, selectedAirlines: string[]): FilterAxis[] {
  const axes: FilterAxis[] = []
  if (stopFilterValue(filters) !== "any") axes.push("stops")
  if (layoverFilterValue(filters) !== "any") axes.push("layover")
  if (baggageFilterValue(filters) !== "any") axes.push("baggage")
  if (selectedAirlines.length > 0) axes.push("airlines")
  return axes
}

/** Lifting one axis is both how it is measured and how it is undone. */
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

/** How plate 2g names it: "El filtro de **directo** es el que descarta más." */
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

/**
 * The lesser way out: one step down the ladder where there is a step, and off
 * where there is not. Only the segmented groups have a ladder — a list of
 * airlines you include has no "one notch wider".
 */
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
  if (
    filters.maxLayoverMinutes === "120" ||
    filters.maxLayoverMinutes === "240" ||
    filters.maxLayoverMinutes === "360"
  ) {
    return filters.maxLayoverMinutes
  }

  return "any"
}

function baggageFilterValue(filters: Filters): BaggageFilterValue {
  if (filters.checkedBaggageRequired) return "checked"
  if (filters.carryOnRequired) return "carry"
  return "any"
}

function airlineToken(value: unknown): string {
  return String(value ?? "").trim().toUpperCase()
}

function airlineFilterCode(offer: CanonicalOffer): string {
  return String(offer.mainCarrier ?? offer.validatingCarrier ?? "").trim()
}

function airlineFilterLabel(offer: CanonicalOffer): string {
  const code = airlineFilterCode(offer)
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
    codes: [
      code,
      offer.validatingCarrier,
      segment?.marketingCarrier,
      segment?.operatingCarrier,
    ],
    fallback: "Aerolínea",
  })
}

function airlineNameSegmentForCode(segments: Segment[], codeToken: string): Segment | undefined {
  if (!codeToken) return undefined

  return segments.find((segment) => (
    (airlineToken(segment.marketingCarrier) === codeToken && Boolean(segment.marketingCarrierName?.trim())) ||
    (airlineToken(segment.operatingCarrier) === codeToken && Boolean(segment.operatingCarrierName?.trim()))
  ))
}

function airlineFilterCodes(offer: CanonicalOffer): string[] {
  return Array.from(new Set([
    airlineFilterCode(offer),
    String(offer.validatingCarrier ?? "").trim(),
    !airlineFilterCode(offer) ? String(offer.airline ?? "").trim() : "",
  ].filter(Boolean)))
}

function isAirlineFilterSelected(airline: AirlineFilterOption, selectedAirlines: string[]): boolean {
  const tokens = airline.codes.length > 0 ? airline.codes : [airline.label]
  return tokens.every((token) => selectedAirlines.includes(token))
}

function offerMatchesSelectedAirlines(offer: CanonicalOffer, selectedAirlines: string[]): boolean {
  if (selectedAirlines.length === 0) return true

  const tokens = new Set([
    ...airlineFilterCodes(offer),
    String(offer.airline ?? "").trim(),
  ].filter(Boolean))
  return selectedAirlines.some((airline) => tokens.has(airline))
}

function maxLayoverForOffer(offer: CanonicalOffer): number {
  return (offer.itineraries ?? [])
    .flatMap((itinerary) => itinerary.layoverMinutes ?? [])
    .reduce((max, minutes) => Math.max(max, minutes), 0)
}

function readWorkspacePreferences(): WorkspacePreferences {
  const fallback: WorkspacePreferences = {
    sortMode: DEFAULT_SORT_MODE,
    filters: {},
    selectedAirlines: [],
  }

  try {
    const parsed = JSON.parse(sessionStorage.getItem(WORKSPACE_PREFERENCES_KEY) ?? "null") as {
      sortMode?: unknown
      filters?: Record<string, unknown>
      selectedAirlines?: unknown
    } | null
    if (!parsed) return fallback

    const filters: Filters = {}
    if (typeof parsed.filters?.nonStop === "boolean") {
      filters.nonStop = parsed.filters.nonStop
    }
    if (parsed.filters?.maxStopsFilter === "1" || parsed.filters?.maxStopsFilter === "2+") {
      filters.maxStopsFilter = parsed.filters.maxStopsFilter
    }
    if (
      parsed.filters?.maxLayoverMinutes === "120"
      || parsed.filters?.maxLayoverMinutes === "240"
      || parsed.filters?.maxLayoverMinutes === "360"
    ) {
      filters.maxLayoverMinutes = parsed.filters.maxLayoverMinutes
    }
    if (typeof parsed.filters?.carryOnRequired === "boolean") {
      filters.carryOnRequired = parsed.filters.carryOnRequired
    }
    if (typeof parsed.filters?.checkedBaggageRequired === "boolean") {
      filters.checkedBaggageRequired = parsed.filters.checkedBaggageRequired
    }

    return {
      sortMode: parsed.sortMode === "fastest" ? "fastest" : DEFAULT_SORT_MODE,
      filters,
      selectedAirlines: Array.isArray(parsed.selectedAirlines)
        ? parsed.selectedAirlines
          .filter((value): value is string => typeof value === "string" && value.length <= 80)
          .slice(0, 32)
        : [],
    }
  } catch {
    return fallback
  }
}

function writeWorkspacePreferences(preferences: WorkspacePreferences) {
  try {
    sessionStorage.setItem(WORKSPACE_PREFERENCES_KEY, JSON.stringify(preferences))
  } catch {
    // Workspace memory is a convenience; private browsing must not block search.
  }
}

function applyClientFilters(offers: CanonicalOffer[], filters: Filters, selectedAirlines: string[]) {
  let list = offers
  if (filters.nonStop) list = list.filter((offer) => maxStopsForFilter(offer) === 0)
  if (filters.maxStopsFilter === "1") list = list.filter((offer) => maxStopsForFilter(offer) <= 1)
  if (filters.maxStopsFilter === "2+") list = list.filter((offer) => maxStopsForFilter(offer) >= 2)
  if (filters.maxLayoverMinutes) {
    const maxMinutes = Number(filters.maxLayoverMinutes)
    list = list.filter((offer) => maxLayoverForOffer(offer) <= maxMinutes)
  }
  if (filters.carryOnRequired) list = list.filter((offer) => offer.baggage?.carryOnIncluded === true)
  if (filters.checkedBaggageRequired) list = list.filter((offer) => offer.baggage?.checkedIncluded === true)
  if (selectedAirlines.length > 0) list = list.filter((offer) => offerMatchesSelectedAirlines(offer, selectedAirlines))
  return list
}

function isMigrationResults(results: { migrationMonths?: unknown[]; request: SearchRequest }) {
  return results.request.searchMode === "month-view" || Boolean(results.migrationMonths?.length)
}

// eslint-disable-next-line react-refresh/only-export-components -- Pure result transformer exercised directly in unit tests.
export function applyMigrationFilters(results: SearchJobResponse, filteredOffers: CanonicalOffer[], sortMode: SortMode) {
  const visibleOfferIds = new Set(filteredOffers.map((offer) => offer.id))
  const migrationMonths = (results.migrationMonths ?? []).map((month) => {
    const monthOffers = month.offers?.length
      ? month.offers
      : month.offer ? [month.offer] : []
    const visibleMonthOffers = monthOffers.filter((offer) => visibleOfferIds.has(offer.id))
    const selectedOffer = cheapestOfferForMonth(visibleMonthOffers)

    return {
      ...month,
      offer: selectedOffer,
      offers: visibleMonthOffers,
      filtered: !selectedOffer && monthOffers.length > 0 && month.status !== "loading",
    }
  })
  const offers = migrationMonths.flatMap((month) => month.offer ? [month.offer] : [])

  return {
    ...results,
    offers,
    migrationMonths,
    sortMode,
  }
}

function defaultSortForRequest(): SortMode {
  return DEFAULT_SORT_MODE
}

function cheapestOfferForMonth(offers: CanonicalOffer[]) {
  return offers.reduce<CanonicalOffer | undefined>((best, offer) => {
    if (!best) return offer
    const compared = compareNumber(priceAmount(offer), priceAmount(best))
      || compareNumber(totalDurationForDisplay(offer), totalDurationForDisplay(best))
    return compared < 0 ? offer : best
  }, undefined)
}

function sortOffersForDisplay(offers: CanonicalOffer[], sortMode: SortMode): CanonicalOffer[] {
  if (offers.length <= 1) return offers

  return offers
    .map((offer, index) => ({ offer, index }))
    .sort((left, right) => {
      const compared = compareOffersForDisplay(left.offer, right.offer, sortMode)
      return compared !== 0 ? compared : left.index - right.index
    })
    .map((item) => item.offer)
}

function compareOffersForDisplay(left: CanonicalOffer, right: CanonicalOffer, sortMode: SortMode): number {
  if (sortMode === "cheapest") {
    return compareNumber(priceAmount(left), priceAmount(right))
      || compareNumber(totalDurationForDisplay(left), totalDurationForDisplay(right))
  }

  if (sortMode === "fastest") {
    return compareNumber(totalDurationForDisplay(left), totalDurationForDisplay(right))
      || compareNumber(priceAmount(left), priceAmount(right))
  }

  return 0
}

function compareNumber(left: number, right: number): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function priceAmount(offer: CanonicalOffer): number {
  return normalizedNumber(offer.price?.total?.amount) ?? Number.POSITIVE_INFINITY
}

function totalDurationForDisplay(offer: CanonicalOffer): number {
  const metricDuration = normalizedNumber(offer.comparisonMetrics?.totalDurationMinutes)
  if (metricDuration !== null) return metricDuration

  const itineraryDuration = (offer.itineraries ?? [])
    .map((itinerary) => normalizedNumber(itinerary.durationMinutes) ?? 0)
    .reduce((sum, minutes) => sum + minutes, 0)

  return itineraryDuration > 0 ? itineraryDuration : Number.POSITIVE_INFINITY
}

function normalizedNumber(value: unknown): number | null {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}

function maxStopsForFilter(offer: CanonicalOffer): number {
  const itineraryStops = (offer.itineraries ?? [])
    .map((itinerary) => {
      if (typeof itinerary.stops === "number" && Number.isFinite(itinerary.stops)) {
        return itinerary.stops
      }

      return Math.max(0, (itinerary.segments?.length ?? 1) - 1)
    })
    .filter((stops) => Number.isFinite(stops))

  return itineraryStops.length > 0
    ? Math.max(...itineraryStops)
    : offer.stops
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

/** Whether this tab is looking at its own address bar rather than at a link. */
function readSearchUrlWasWrittenHere(): boolean {
  try {
    return searchUrlWasWrittenHere(new URL(window.location.href))
  } catch {
    return false
  }
}

/*
 * The readable share parameters only guarantee an origin and a destination, so
 * a link can arrive without the dates a search needs — or with dates the form
 * itself refuses, since `?departure=2026-06-31` reads as a date and is not one.
 * Those still fill the form; they just do not launch anything on their own, and
 * the form says why in the place it always says it.
 *
 * The runtime's floor is read from the same global `SearchShell` reads, so a
 * link shared last month prefills a route instead of paying for a search of a
 * day that has gone. Everything above that floor — the far end of the window,
 * the longest stay — stays the form's to judge: it has the whole ladder and the
 * words for each rung, and a link that trips one of those arrives filled with
 * the sentence that explains it.
 */
function isLaunchableSharedRequest(request: SearchRequest): boolean {
  if (request.searchMode !== "exact") return false
  if (!/^[A-Z]{3}$/.test(request.origin ?? "")) return false
  if (!/^[A-Z]{3}$/.test(request.destination ?? "")) return false
  if (request.origin === request.destination) return false
  if (!isIsoDate(request.departureDate)) return false
  if (request.tripType === "round-trip" && !isIsoDate(request.returnDate)) return false
  if (request.returnDate && request.returnDate < request.departureDate) return false

  const minSearchDate = window.__FLYDESK_RUNTIME__?.searchDatePolicy?.minSearchDate
  return !isIsoDate(minSearchDate) || request.departureDate >= minSearchDate
}

export const RESTORE_JOB_QUERY_PARAM = "job"

/** The id of a server-side job this tab should read instead of starting one. */
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
