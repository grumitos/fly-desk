export const state = {
  request: null,
  providerConfig: null,
  sortMode: "cheapest",
  searchResponse: null,
  searchJobId: null,
  searchPollHandle: null,
  matrixResponse: null,
  matrixJobId: null,
  matrixPollHandle: null,
  selectedOfferId: null,
  quotationText: "",
  selectedMatrixKey: null,
  airlineFilter: { hidden: new Set(), only: null },
  resultsPage: 1,
  resultsPageSize: 15,
  resultsColumnLayout: null,
  resultsLayoutLoaded: false,
  resultsLayoutSaving: false,
  resultsLayoutSavedAt: "",
  viewMode: "list",
  flexMode: false,
  detailPendingAction: null,
  matrixExpanded: false,
  matrixScroll: { top: 0, left: 0 },
  resultsScroll: { top: 0, left: 0 },
  resultsViewportSize: { width: 0, height: 0 },
  pollRenderHandle: null,
  pollRenderPending: false,
  pollInteractionAt: 0,
  pollPointerDown: false,
  migrationActive: false,
  migrationRunId: 0,
  migrationMonths: [],
  migrationPollHandles: new Set(),
};

export const autocompleteState = {
  origin: { items: [], activeIndex: -1, requestId: 0, abortController: null },
  destination: { items: [], activeIndex: -1, requestId: 0, abortController: null },
};

export const RESULTS_PAGE_SIZE = 15;
export const RESULTS_MAX_PAGES = 25;
export const SEARCH_DATE_DEFAULT_MAX_FUTURE_DAYS = 365;
export const runtimeSearchDatePolicy = window.__FLYDESK_RUNTIME__?.searchDatePolicy ?? null;
export const DEFAULT_CURRENCY_CODE = "USD";
export const SEARCH_CONFIG_CLIPBOARD_KEY = "flydesk.searchClipboard";
export const SEARCH_CONFIG_CLIPBOARD_TYPE = "fly-desk-search-config";
export const SEARCH_CONFIG_CLIPBOARD_VERSION = 1;
export const POLL_RENDER_IDLE_MS = 180;
export const THEME_STORAGE_KEY = "flydesk-theme";
export const LAYOVER_TIME_OPTIONS = [
  { value: "", label: "Cualquiera", compactLabel: "" },
  { value: "120", label: "Hasta 2h", compactLabel: "2h" },
  { value: "240", label: "Hasta 4h", compactLabel: "4h" },
  { value: "360", label: "Hasta 6h", compactLabel: "6h" },
  { value: "480", label: "Hasta 8h", compactLabel: "8h" },
];

export const $ = (id) => document.getElementById(id);

export const rootEl = document.documentElement;
export const searchForm = $("searchForm");
export const workspace = document.querySelector(".workspace");
export const searchMode = $("searchMode");
export const sortMode = $("sortMode");
export const tripType = $("tripType");
export const airlineBar = $("airlineBar");
export const detailPanel = $("detailPanel");
export const detailContent = $("detailContent");
export const resultsToolbar = $("resultsToolbar");
export const resultsPanelBody = $("resultsPanelBody");
export const resultsSidebar = $("resultsSidebar");
export const resultsContainer = $("resultsContainer");
export const emptyState = $("emptyState");
export const paxTrigger = $("paxTrigger");
export const paxPopover = $("paxPopover");
export const paxLabel = $("paxLabel");
export const paxAdultsDisplay = $("paxAdultsDisplay");
export const paxChildrenDisplay = $("paxChildrenDisplay");
export const paxInfantsDisplay = $("paxInfantsDisplay");
export const layoverFilter = $("layoverFilter");
export const layoverTrigger = $("layoverTrigger");
export const layoverTriggerValue = $("layoverTriggerValue");
export const layoverPopover = $("layoverPopover");
export const sortButtonsEl = $("sortButtons");
export const viewToggle = $("viewToggle");
export const matrixExpandBtn = $("matrixExpandBtn");
export const resultsPanelTitle = $("resultsPanelTitle");
export const resultsPanelMeta = $("resultsPanelMeta");
export const matrixFullscreen = $("matrixFullscreen");
export const matrixFullscreenBackdrop = $("matrixFullscreenBackdrop");
export const matrixFullscreenClose = $("matrixFullscreenClose");
export const matrixFullscreenBody = $("matrixFullscreenBody");
export const matrixFullscreenMeta = $("matrixFullscreenMeta");
export const dateTrigger = $("dateTrigger");
export const dateTriggerText = $("dateTriggerText");
export const calendarPopover = $("calendarPopover");
export const calendarClose = $("calendarClose");
export const calendarClear = $("calendarClear");
export const calendarDone = $("calendarDone");
export const calendarPrev = $("calendarPrev");
export const calendarNext = $("calendarNext");
export const calendarMonths = $("calendarMonths");
export const calendarTitle = $("calendarTitle");
export const calendarSelectionSummary = $("calendarSelectionSummary");
export const calendarFlexModeControl = $("calendarFlexModeControl");
export const calendarStayConfig = $("calendarStayConfig");
export const flexibleMode = $("flexibleMode");
export const stayNightsEl = $("stayNights");
export const runtimeBadge = $("runtimeBadge");
export const resultPill = $("resultPill");
export const submitButton = $("submitButton");
export const quotationButton = $("quotationButton");
export const resultsPagerEl = $("resultsPager");
export const validationBox = $("validationErrors");
export const toastContainer = $("toastContainer");
export const copySearchConfigBtn = $("copySearchConfigBtn");
export const pasteSearchConfigBtn = $("pasteSearchConfigBtn");
export const swapRouteBtn = $("swapRouteBtn");
export const migrationBtn = $("migrationBtn");
export const themeButtons = [...document.querySelectorAll("[data-theme-value]")];

export const calendarState = {
  selectionStage: "start",
  viewStartMonth: "",
};
