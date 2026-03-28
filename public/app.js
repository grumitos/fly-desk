/* ================================================================
   Flight Desk — front-end
   ================================================================ */

const state = {
  request: null,
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
  viewMode: "list",
  flexMode: false,
  detailPendingAction: null,
  matrixExpanded: false,
  matrixScroll: { top: 0, left: 0 },
  resultsScroll: { top: 0, left: 0 },
  pollRenderHandle: null,
  pollRenderPending: false,
  pollInteractionAt: 0,
  pollPointerDown: false,
};

const autocompleteState = {
  origin: { items: [], activeIndex: -1, requestId: 0 },
  destination: { items: [], activeIndex: -1, requestId: 0 },
};

const RESULTS_PAGE_SIZE = 15;
const ALLOWED_DATE_YEAR = "2026";
const ALLOWED_DATE_MIN = `${ALLOWED_DATE_YEAR}-01-01`;
const ALLOWED_DATE_MAX = `${ALLOWED_DATE_YEAR}-12-31`;
const DEFAULT_CURRENCY_CODE = "USD";
const SEARCH_CONFIG_CLIPBOARD_KEY = "flydesk.searchClipboard";
const SEARCH_CONFIG_CLIPBOARD_TYPE = "fly-desk-search-config";
const SEARCH_CONFIG_CLIPBOARD_VERSION = 1;
const POLL_RENDER_IDLE_MS = 180;
const THEME_STORAGE_KEY = "flydesk-theme";

const $ = (id) => document.getElementById(id);

const rootEl = document.documentElement;
const searchForm = $("searchForm");
const workspace = document.querySelector(".workspace");
const searchMode = $("searchMode");
const sortMode = $("sortMode");
const tripType = $("tripType");
const airlineBar = $("airlineBar");
const detailPanel = $("detailPanel");
const detailContent = $("detailContent");
const resultsToolbar = $("resultsToolbar");
const resultsContainer = $("resultsContainer");
const emptyState = $("emptyState");
const paxTrigger = $("paxTrigger");
const paxPopover = $("paxPopover");
const paxLabel = $("paxLabel");
const paxAdultsDisplay = $("paxAdultsDisplay");
const paxChildrenDisplay = $("paxChildrenDisplay");
const paxInfantsDisplay = $("paxInfantsDisplay");
const layoverFilter = $("layoverFilter");
const layoverTrigger = $("layoverTrigger");
const layoverTriggerValue = $("layoverTriggerValue");
const layoverPopover = $("layoverPopover");
const sortButtonsEl = $("sortButtons");
const viewToggle = $("viewToggle");
const matrixExpandBtn = $("matrixExpandBtn");
const resultsCountLabel = $("resultsCountLabel");
const resultsPanelTitle = $("resultsPanelTitle");
const resultsPanelMeta = $("resultsPanelMeta");
const matrixFullscreen = $("matrixFullscreen");
const matrixFullscreenBackdrop = $("matrixFullscreenBackdrop");
const matrixFullscreenClose = $("matrixFullscreenClose");
const matrixFullscreenBody = $("matrixFullscreenBody");
const matrixFullscreenMeta = $("matrixFullscreenMeta");
const dateTrigger = $("dateTrigger");
const dateTriggerText = $("dateTriggerText");
const calendarPopover = $("calendarPopover");
const calendarClose = $("calendarClose");
const calendarClear = $("calendarClear");
const calendarDone = $("calendarDone");
const calendarPrev = $("calendarPrev");
const calendarNext = $("calendarNext");
const calendarMonths = $("calendarMonths");
const calendarTitle = $("calendarTitle");
const calendarSelectionSummary = $("calendarSelectionSummary");
const calendarStayConfig = $("calendarStayConfig");
const stayDaysMinEl = $("stayDaysMin");
const stayDaysMaxEl = $("stayDaysMax");
const runtimeBadge = $("runtimeBadge");
const resultPill = $("resultPill");
const submitButton = $("submitButton");
const repriceButton = $("repriceButton");
const quotationButton = $("quotationButton");
const validationBox = $("validationErrors");
const toastContainer = $("toastContainer");
const copySearchConfigBtn = $("copySearchConfigBtn");
const pasteSearchConfigBtn = $("pasteSearchConfigBtn");
const themeButtons = [...document.querySelectorAll("[data-theme-value]")];

const calendarState = {
  selectionStage: "start",
  viewStartMonth: "",
};

const numFmt = new Intl.NumberFormat("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ================================================================
   UI FEEDBACK — loading, toast, debounce
   ================================================================ */

function showToast(message, type = "error") {
  if (!toastContainer) return;
  const el = document.createElement("div");
  el.className = `toast toast--${type}`;
  el.textContent = message;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), type === "error" ? 5000 : 3000);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function writeClipboardText(text) {
  if (!navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    } finally {
      textarea.remove();
    }
    return copied;
  }
}

function renderResultsSkeleton(kind = "search") {
  if (!resultsContainer) return;
  const rows = Array.from({ length: 6 }, (_, index) => `
    <div class="results-skeleton__row" aria-hidden="true">
      <span class="skeleton-line skeleton-line--md"></span>
      <span class="skeleton-line skeleton-line--lg"></span>
      <span class="skeleton-line skeleton-line--sm"></span>
      <span class="skeleton-line skeleton-line--sm"></span>
      <span class="skeleton-line skeleton-line--sm"></span>
      <span class="skeleton-line skeleton-line--price"></span>
      <span class="skeleton-line skeleton-line--link"></span>
    </div>
  `).join("");

  resultsContainer.innerHTML = `
    <div class="results-skeleton" aria-live="polite" aria-busy="true">
      <div class="results-skeleton__table">
        <div class="results-skeleton__head" aria-hidden="true">
          <span>Aerolínea</span>
          <span>Fechas</span>
          <span>Duración</span>
          <span>Escalas</span>
          <span>Equipaje</span>
          <span>Precio</span>
          <span>Agil</span>
        </div>
        ${rows}
      </div>
    </div>
  `;
}

function detailActionCopy(action) {
  if (action === "quotation") {
    return {
      eyebrow: "Generando cotización",
      text: "Preparando el texto con la oferta seleccionada.",
    };
  }
  return {
    eyebrow: "Actualizando tarifa",
    text: "Revalidando precio y disponibilidad sobre esta oferta.",
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderEmptyPanel({
  wrapperClass = "empty-state",
  panelClass = "",
  icon = "ico-search",
  eyebrow = "",
  title,
  text,
  hint = "",
}) {
  const classes = [wrapperClass, panelClass].filter(Boolean).join(" ");
  const eyebrowMarkup = eyebrow ? `<p class="empty-panel__eyebrow">${escapeHtml(eyebrow)}</p>` : "";
  const hintMarkup = hint ? `<p class="empty-panel__hint">${escapeHtml(hint)}</p>` : "";
  return `
    <div class="${classes}">
      <div class="empty-panel">
        <div class="empty-panel__media" aria-hidden="true">
          <svg class="empty-panel__icon"><use href="#${escapeHtml(icon)}"/></svg>
        </div>
        ${eyebrowMarkup}
        <h2 class="empty-panel__title">${escapeHtml(title)}</h2>
        <p class="empty-panel__text">${escapeHtml(text)}</p>
        ${hintMarkup}
      </div>
    </div>
  `;
}

function captureMatrixScroll(container = resultsContainer) {
  const wrap = container?.querySelector(".matrix-wrap");
  if (!wrap) return;
  state.matrixScroll = {
    top: wrap.scrollTop,
    left: wrap.scrollLeft,
  };
}

function syncMatrixScroll(wrap) {
  if (!wrap) return;
  wrap.scrollTop = state.matrixScroll.top;
  wrap.scrollLeft = state.matrixScroll.left;
}

function handleMatrixScroll(event) {
  const wrap = event.currentTarget;
  if (!(wrap instanceof HTMLElement)) return;
  markPollingUiInteraction();
  state.matrixScroll = {
    top: wrap.scrollTop,
    left: wrap.scrollLeft,
  };
}

function captureResultsScroll(container = resultsContainer) {
  const wrap = container?.querySelector(".table-wrap");
  if (!wrap) return;
  state.resultsScroll = {
    top: wrap.scrollTop,
    left: wrap.scrollLeft,
  };
}

function syncResultsScroll(wrap) {
  if (!wrap) return;
  wrap.scrollTop = state.resultsScroll.top;
  wrap.scrollLeft = state.resultsScroll.left;
}

function handleResultsScroll(event) {
  const wrap = event.currentTarget;
  if (!(wrap instanceof HTMLElement)) return;
  markPollingUiInteraction();
  state.resultsScroll = {
    top: wrap.scrollTop,
    left: wrap.scrollLeft,
  };
}

function markPollingUiInteraction() {
  state.pollInteractionAt = Date.now();
}

function scheduleDeferredPollRender() {
  if (state.pollRenderHandle) clearTimeout(state.pollRenderHandle);
  state.pollRenderHandle = setTimeout(() => {
    if (!state.pollRenderPending) {
      state.pollRenderHandle = null;
      return;
    }
    if (state.pollPointerDown || (Date.now() - state.pollInteractionAt) < POLL_RENDER_IDLE_MS) {
      scheduleDeferredPollRender();
      return;
    }
    state.pollRenderHandle = null;
    renderAll();
  }, POLL_RENDER_IDLE_MS);
}

function requestPolledRender() {
  if (state.pollPointerDown || (Date.now() - state.pollInteractionAt) < POLL_RENDER_IDLE_MS) {
    state.pollRenderPending = true;
    scheduleDeferredPollRender();
    return;
  }
  renderAll();
}

function syncMatrixExpandedUI() {
  const canExpand = state.viewMode === "calendar" && state.matrixResponse?.cells?.length > 0;
  const isExpanded = canExpand && state.matrixExpanded;
  matrixExpandBtn?.classList.toggle("hidden", !canExpand);
  matrixExpandBtn?.classList.toggle("is-active", isExpanded);
  matrixFullscreen?.classList.toggle("hidden", !isExpanded);
  matrixFullscreen?.setAttribute("aria-hidden", String(!isExpanded));
  document.body.classList.toggle("matrix-expanded-open", isExpanded);
  if (matrixFullscreenMeta) {
    matrixFullscreenMeta.textContent = `${state.matrixResponse?.cells?.length ?? 0} celdas`;
  }
  if (!isExpanded && matrixFullscreenBody) {
    matrixFullscreenBody.innerHTML = "";
  }
}

function openMatrixExpanded() {
  if (state.viewMode !== "calendar" || !state.matrixResponse?.cells?.length) return;
  captureMatrixScroll(resultsContainer);
  state.matrixExpanded = true;
  renderAll();
}

function closeMatrixExpanded({ rerender = true } = {}) {
  if (!state.matrixExpanded) return;
  captureMatrixScroll(matrixFullscreenBody);
  state.matrixExpanded = false;
  syncMatrixExpandedUI();
  if (rerender) renderAll();
}

function formatDuration(minutes) {
  if (!minutes) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatDateCompact(iso) {
  if (!iso) return "—";
  // "2026-04-15" → "15/04"
  const parts = iso.slice(0, 10).split("-");
  return `${parts[2]}/${parts[1]}`;
}

function formatMonthTitle(isoMonth) {
  const value = new Date(`${isoMonth}T00:00:00Z`);
  return value.toLocaleDateString("es-PE", { month: "long", year: "numeric", timeZone: "UTC" });
}

function formatPassengerSummary(adults, children, infants) {
  const chunks = [`${adults} adulto${adults === 1 ? "" : "s"}`];
  if (children > 0) chunks.push(`${children} niño${children === 1 ? "" : "s"}`);
  if (infants > 0) chunks.push(`${infants} bebé${infants === 1 ? "" : "s"}`);
  return chunks.join(", ");
}

function primarySegmentForOffer(offer) {
  const outbound = offer?.itineraries?.find((it) => it.direction === "outbound") ?? offer?.itineraries?.[0];
  return outbound?.segments?.[0] ?? null;
}

function carrierDisplayParts(offer) {
  const primarySegment = primarySegmentForOffer(offer);
  const code = offer?.mainCarrier ?? offer?.validatingCarrier ?? primarySegment?.marketingCarrier ?? "—";
  const rawName = [
    primarySegment?.marketingCarrierName,
    primarySegment?.operatingCarrierName,
  ].find((value) => typeof value === "string" && value.trim());
  const name = rawName && rawName.trim().toUpperCase() !== String(code).trim().toUpperCase()
    ? rawName.trim()
    : "";

  return {
    code,
    name,
    display: name || code,
  };
}

function firstDayOfMonth(iso) {
  return `${iso.slice(0, 7)}-01`;
}

function addMonthsIso(isoMonth, delta) {
  const base = new Date(`${isoMonth}T00:00:00Z`);
  base.setUTCMonth(base.getUTCMonth() + delta);
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function syncThemeButtons(theme) {
  themeButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.themeValue === theme);
    button.setAttribute("aria-pressed", String(button.dataset.themeValue === theme));
  });
}

function setTheme(theme, { persist = true } = {}) {
  const nextTheme = theme === "dark" ? "dark" : "light";
  rootEl.dataset.theme = nextTheme;
  syncThemeButtons(nextTheme);
  if (persist) {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // Ignore private mode/localStorage restrictions.
    }
  }
}

function initialTheme() {
  const datasetTheme = rootEl.dataset.theme;
  if (datasetTheme === "light" || datasetTheme === "dark") return datasetTheme;
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // Ignore localStorage access issues.
  }
  return "light";
}

function releaseThemeBootingState() {
  if (!rootEl.hasAttribute("data-theme-booting")) return;
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      rootEl.removeAttribute("data-theme-booting");
    });
  });
}

function settleInitialShellLayout() {
  syncSearchShellLayoutMetrics();
  syncWorkspaceViewportHeight();
  syncVisibleLocationMenus();
  syncPaxPopoverPosition();
  syncLayoverPopoverPosition();
  syncCalendarPopoverPosition();
}

function releaseInitialUiBootState() {
  const fontReady = document.fonts?.ready
    ? document.fonts.ready.catch(() => undefined)
    : Promise.resolve();

  fontReady.finally(() => {
    settleInitialShellLayout();
    releaseThemeBootingState();
  });
}

function field(name) { return searchForm.querySelector(`[name="${name}"]`); }
function control(name) { return $(name) ?? field(name); }
function controlValue(name) {
  const el = control(name);
  return el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement
    ? el.value
    : "";
}
function controlChecked(name) {
  const el = control(name);
  return el instanceof HTMLInputElement ? el.checked : false;
}

function formatMoney(m) { return m ? `${m.currencyCode} ${numFmt.format(m.amount)}` : "—"; }

function formatDT(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("es-PE", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

function locationMenu(id) {
  return $(`${id}Suggestions`);
}

function clearResolvedLocation(id, keepValue = true) {
  const input = $(id);
  if (!input) return;
  if (!keepValue) input.value = "";
  delete input.dataset.code;
  delete input.dataset.label;
}

function applyResolvedLocation(id, location = {}) {
  const input = $(id);
  if (!input) return;
  const value = String(location.value || location.label || location.code || "").trim();
  const code = String(location.code || "").trim().toUpperCase();
  const label = String(location.label || value).trim();
  input.value = value;
  if (code) input.dataset.code = code;
  else delete input.dataset.code;
  if (label) input.dataset.label = label;
  else delete input.dataset.label;
}

function resolvedLocationCode(id) {
  const input = $(id);
  if (!input) return "";
  const selectedCode = String(input.dataset.code || "").trim().toUpperCase();
  if (selectedCode) return selectedCode;
  const raw = input.value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(raw) ? raw : "";
}

function hideLocationMenu(id) {
  const menu = locationMenu(id);
  if (!menu) return;
  menu.classList.add("hidden");
  menu.innerHTML = "";
  menu.style.top = "";
  menu.style.left = "";
  menu.style.width = "";
  autocompleteState[id].items = [];
  autocompleteState[id].activeIndex = -1;
}

function floatingViewportPadding() {
  const shellMargin = searchForm ? getComputedStyle(searchForm).marginLeft : "";
  return Math.max(12, Math.round(resolveCssLength(shellMargin || getComputedStyle(rootEl).getPropertyValue("--layout-gutter"))));
}

function floatingPanelOffset() {
  return Math.max(8, Math.round(resolveCssLength(getComputedStyle(rootEl).getPropertyValue("--floating-panel-offset"))));
}

function syncAnchoredPopoverPosition(trigger, popover, {
  width,
  minWidth = 0,
  maxWidth = Number.POSITIVE_INFINITY,
  matchTriggerWidth = false,
  offset = floatingPanelOffset(),
} = {}) {
  if (!(trigger instanceof Element) || !(popover instanceof HTMLElement) || popover.classList.contains("hidden")) return;

  const viewportPadding = floatingViewportPadding();
  const triggerRect = trigger.getBoundingClientRect();
  const maxAllowedWidth = Math.max(minWidth, Math.min(maxWidth, window.innerWidth - (viewportPadding * 2)));
  let targetWidth = typeof width === "number" ? width : popover.getBoundingClientRect().width;

  if (matchTriggerWidth) {
    targetWidth = Math.max(targetWidth, triggerRect.width);
  }

  targetWidth = Math.min(Math.max(targetWidth, minWidth), maxAllowedWidth);

  if (Number.isFinite(targetWidth) && targetWidth > 0) {
    popover.style.width = `${Math.round(targetWidth)}px`;
    popover.style.maxWidth = `${Math.round(maxAllowedWidth)}px`;
  }

  const popoverRect = popover.getBoundingClientRect();
  let left = triggerRect.left + (triggerRect.width / 2) - (popoverRect.width / 2);
  left = Math.max(viewportPadding, Math.min(left, window.innerWidth - popoverRect.width - viewportPadding));

  let top = triggerRect.bottom + offset;
  if (top + popoverRect.height > window.innerHeight - viewportPadding) {
    const aboveTop = triggerRect.top - popoverRect.height - offset;
    if (aboveTop >= viewportPadding) top = aboveTop;
    else top = Math.max(viewportPadding, window.innerHeight - popoverRect.height - viewportPadding);
  }

  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
}

function syncLocationMenuPosition(id) {
  const input = $(id);
  const menu = locationMenu(id);
  if (!input || !menu || menu.classList.contains("hidden")) return;

  const anchor = input.closest(".field-shell") ?? input.closest(".rail-segment") ?? input;
  const width = anchor.getBoundingClientRect().width;
  syncAnchoredPopoverPosition(anchor, menu, {
    width: Math.max(width, 320),
    minWidth: Math.max(width, 320),
    maxWidth: 420,
  });
}

function syncVisibleLocationMenus() {
  syncLocationMenuPosition("origin");
  syncLocationMenuPosition("destination");
}

function syncPaxPopoverPosition() {
  if (!paxTrigger || !paxPopover) return;
  syncAnchoredPopoverPosition(paxTrigger, paxPopover, {
    width: Math.max(paxTrigger.getBoundingClientRect().width, 320),
    minWidth: 288,
    maxWidth: 360,
  });
}

function selectLocationSuggestion(id, suggestion) {
  const input = $(id);
  if (!input) return;
  input.value = suggestion.label;
  input.dataset.code = suggestion.code;
  input.dataset.label = suggestion.label;
  hideLocationMenu(id);
}

function parseSearchClipboardPayload(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.type !== SEARCH_CONFIG_CLIPBOARD_TYPE || parsed.version !== SEARCH_CONFIG_CLIPBOARD_VERSION) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function readStoredSearchClipboard() {
  try {
    const stored = window.localStorage.getItem(SEARCH_CONFIG_CLIPBOARD_KEY);
    const payload = parseSearchClipboardPayload(stored);
    if (!payload && stored) window.localStorage.removeItem(SEARCH_CONFIG_CLIPBOARD_KEY);
    return payload;
  } catch {
    return null;
  }
}

function canReadSystemSearchClipboard() {
  return typeof navigator.clipboard?.readText === "function";
}

function syncSearchClipboardUI() {
  if (!pasteSearchConfigBtn) return;
  pasteSearchConfigBtn.disabled = !Boolean(readStoredSearchClipboard() || canReadSystemSearchClipboard());
}

function buildSearchClipboardPayload() {
  const readLocation = (id) => {
    const input = $(id);
    return {
      value: String(input?.value || "").trim(),
      code: String(input?.dataset.code || "").trim().toUpperCase(),
      label: String(input?.dataset.label || input?.value || "").trim(),
    };
  };

  return {
    type: SEARCH_CONFIG_CLIPBOARD_TYPE,
    version: SEARCH_CONFIG_CLIPBOARD_VERSION,
    copiedAt: new Date().toISOString(),
    mode: state.flexMode ? "flexible" : "exact",
    tripType: tripType.value === "one-way" ? "one-way" : "round-trip",
    origin: readLocation("origin"),
    destination: readLocation("destination"),
    dates: {
      departureDate: controlValue("departureDate"),
      returnDate: controlValue("returnDate"),
      departureStart: controlValue("departureStart"),
      departureEnd: controlValue("departureEnd"),
      returnStart: controlValue("returnStart"),
      returnEnd: controlValue("returnEnd"),
    },
    stay: {
      min: controlValue("stayDaysMin"),
      max: controlValue("stayDaysMax"),
    },
    passengers: {
      adults: controlValue("adults"),
      children: controlValue("children"),
      infants: controlValue("infants"),
    },
    filters: {
      nonStop: controlChecked("nonStop"),
      baggageRequired: controlChecked("baggageRequired"),
      maxLayoverMinutes: controlValue("maxLayoverMinutes"),
    },
    sortMode: controlValue("sortMode") || state.sortMode || "cheapest",
  };
}

function persistSearchClipboardPayload(payload) {
  const serialized = JSON.stringify(payload);
  try {
    window.localStorage.setItem(SEARCH_CONFIG_CLIPBOARD_KEY, serialized);
  } catch {
    // Ignore storage failures; clipboard write still provides a usable path.
  }
  return serialized;
}

async function readSystemSearchClipboard() {
  if (!canReadSystemSearchClipboard()) {
    return { payload: null, reason: "unsupported" };
  }
  try {
    const payload = parseSearchClipboardPayload(await navigator.clipboard.readText());
    return {
      payload,
      reason: payload ? "ok" : "invalid",
    };
  } catch (error) {
    const reason = error instanceof DOMException && error.name === "NotAllowedError"
      ? "permission"
      : "unavailable";
    return { payload: null, reason };
  }
}

function clearRenderedSearchState() {
  if (state.matrixExpanded) closeMatrixExpanded({ rerender: false });
  stopMatrixPolling();
  stopSearchPolling();
  state.request = null;
  state.searchResponse = null;
  state.matrixResponse = null;
  state.selectedOfferId = null;
  state.selectedMatrixKey = null;
  state.quotationText = "";
  state.detailPendingAction = null;
  state.airlineFilter.hidden.clear();
  state.airlineFilter.only = null;
  state.resultsPage = 1;
  state.viewMode = "list";
  state.matrixScroll = { top: 0, left: 0 };
  state.resultsScroll = { top: 0, left: 0 };
  closeDetailPanel();
}

function applySearchClipboardPayload(payload) {
  if (!payload) return false;

  state.flexMode = payload.mode === "flexible";
  tripType.value = payload.tripType === "one-way" ? "one-way" : "round-trip";
  state.sortMode = String(payload.sortMode || "cheapest");
  sortMode.value = state.sortMode;

  applyResolvedLocation("origin", payload.origin);
  applyResolvedLocation("destination", payload.destination);
  hideLocationMenu("origin");
  hideLocationMenu("destination");

  $("departureDate").value = String(payload.dates?.departureDate || "");
  $("returnDate").value = String(payload.dates?.returnDate || "");
  $("departureStart").value = String(payload.dates?.departureStart || "");
  $("departureEnd").value = String(payload.dates?.departureEnd || "");
  $("returnStart").value = String(payload.dates?.returnStart || "");
  $("returnEnd").value = String(payload.dates?.returnEnd || "");

  stayDaysMinEl.value = String(payload.stay?.min || stayDaysMinEl.value || "7");
  stayDaysMaxEl.value = String(payload.stay?.max || stayDaysMaxEl.value || stayDaysMinEl.value || "14");

  $("adults").value = String(payload.passengers?.adults || "1");
  $("children").value = String(payload.passengers?.children || "0");
  $("infants").value = String(payload.passengers?.infants || "0");
  $("nonStop").checked = payload.filters?.nonStop === true;
  $("baggageRequired").checked = payload.filters?.baggageRequired === true;
  $("maxLayoverMinutes").value = String(payload.filters?.maxLayoverMinutes || "");
  syncLayoverFilterUi();

  calendarState.selectionStage = "start";
  closeCalendarPopover();
  showErrors([]);
  updatePaxLabel();
  updateModeFields();
  clearRenderedSearchState();
  renderAll();
  return true;
}

async function copySearchConfiguration() {
  const payload = buildSearchClipboardPayload();
  const serialized = persistSearchClipboardPayload(payload);
  const clipboardSynced = await writeClipboardText(serialized);

  syncSearchClipboardUI();
  showToast(
    clipboardSynced
      ? "Configuracion copiada. Ya puedes pegarla en otra pestana."
      : "Configuracion guardada para pegarla en otra pestana.",
    "success",
  );
}

async function pasteSearchConfiguration() {
  let payload = readStoredSearchClipboard();

  if (!payload) {
    const clipboardResult = await readSystemSearchClipboard();
    payload = clipboardResult.payload;
    if (payload) persistSearchClipboardPayload(payload);
    else if (clipboardResult.reason === "permission") {
      syncSearchClipboardUI();
      showToast("Permite acceso al portapapeles para pegar la configuracion.", "error");
      return;
    }
  }

  if (!payload) {
    syncSearchClipboardUI();
    showToast("No hay una configuracion copiada todavia.");
    return;
  }

  applySearchClipboardPayload(payload);
  syncSearchClipboardUI();
  showToast("Configuracion pegada. Pulsa Buscar para ejecutarla.", "success");
}

function renderLocationMenu(id) {
  const input = $(id);
  const menu = locationMenu(id);
  const auto = autocompleteState[id];
  if (!menu) return;
  if (!input || document.activeElement !== input) {
    hideLocationMenu(id);
    return;
  }
  if (!auto.items.length) {
    hideLocationMenu(id);
    return;
  }

  menu.innerHTML = auto.items.map((item, index) => `
    <button type="button" class="autocomplete-item location-item ${index === auto.activeIndex ? "is-active" : ""}" data-location-id="${id}" data-index="${index}">
      <span class="location-item-code">${escapeHtml(item.code)} · ${escapeHtml(item.city)}</span>
      <span class="location-item-meta">${escapeHtml(item.country)}</span>
    </button>
  `).join("");
  menu.classList.remove("hidden");
  requestAnimationFrame(() => syncLocationMenuPosition(id));

  menu.querySelectorAll(".location-item").forEach((button) => {
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const index = Number(button.dataset.index);
      const item = autocompleteState[id].items[index];
      if (item) selectLocationSuggestion(id, item);
    });
  });
}

async function fetchLocationSuggestions(id, query) {
  const input = $(id);
  const auto = autocompleteState[id];
  const requestId = auto.requestId + 1;
  auto.requestId = requestId;

  if (query.trim().length < 2) {
    hideLocationMenu(id);
    return;
  }

  try {
    const data = await getJson(`/api/agil/locations?q=${encodeURIComponent(query.trim())}&limit=8`);
    if (autocompleteState[id].requestId !== requestId) return;
    if (!input || document.activeElement !== input) {
      hideLocationMenu(id);
      return;
    }
    auto.items = data.suggestions ?? [];
    auto.activeIndex = auto.items.length > 0 ? 0 : -1;
    renderLocationMenu(id);
  } catch (err) {
    hideLocationMenu(id);
    showToast(err.message);
  }
}

function setupLocationAutocomplete(id) {
  const input = $(id);
  const debouncedFetch = debounce((query) => fetchLocationSuggestions(id, query), 180);
  if (!input) return;

  input.addEventListener("input", () => {
    const currentLabel = String(input.dataset.label || "");
    if (input.value !== currentLabel) {
      clearResolvedLocation(id, true);
    }
    debouncedFetch(input.value);
  });

  input.addEventListener("focus", () => {
    if (input.value.trim().length >= 2) {
      debouncedFetch(input.value);
    }
  });

  input.addEventListener("blur", () => {
    setTimeout(() => hideLocationMenu(id), 120);
  });

  input.addEventListener("keydown", (event) => {
    const auto = autocompleteState[id];
    if (!auto.items.length) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      auto.activeIndex = Math.min(auto.items.length - 1, auto.activeIndex + 1);
      renderLocationMenu(id);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      auto.activeIndex = Math.max(0, auto.activeIndex - 1);
      renderLocationMenu(id);
      return;
    }

    if (event.key === "Enter") {
      const active = auto.items[auto.activeIndex];
      if (active) {
        event.preventDefault();
        selectLocationSuggestion(id, active);
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      hideLocationMenu(id);
    }
  });
}

function offerPrimaryDates(offer) {
  const outbound = offer.itineraries?.find((it) => it.direction === "outbound") ?? offer.itineraries?.[0];
  const inbound = offer.itineraries?.find((it) => it.direction === "inbound");
  return {
    departureDate: outbound?.segments?.[0]?.departureAt?.slice(0, 10) ?? "",
    returnDate: inbound?.segments?.[0]?.departureAt?.slice(0, 10) ?? "",
  };
}

function compareOfferTravelDates(left, right) {
  const leftDates = offerPrimaryDates(left);
  const rightDates = offerPrimaryDates(right);

  if (leftDates.departureDate !== rightDates.departureDate) {
    return leftDates.departureDate.localeCompare(rightDates.departureDate);
  }

  if (leftDates.returnDate !== rightDates.returnDate) {
    return leftDates.returnDate.localeCompare(rightDates.returnDate);
  }

  return String(left.id ?? "").localeCompare(String(right.id ?? ""));
}

function timeOfIso(iso) {
  return typeof iso === "string" ? iso.slice(11, 16) : "";
}

function segmentPatternKey(segment) {
  return [
    segment.marketingCarrier ?? "",
    segment.flightNumber ?? "",
    segment.origin ?? "",
    segment.destination ?? "",
    timeOfIso(segment.departureAt),
    timeOfIso(segment.arrivalAt),
    String(segment.durationMinutes ?? ""),
  ].join("|");
}

function itineraryPatternKey(itinerary) {
  const segments = (itinerary?.segments ?? []).map((segment) => segmentPatternKey(segment)).join("~");
  return [
    itinerary?.direction ?? "",
    String(itinerary?.durationMinutes ?? ""),
    String(itinerary?.stops ?? ""),
    segments,
  ].join("::");
}

function offerVariantGroupKey(offer) {
  const itineraries = (offer.itineraries ?? []).map((itinerary) => itineraryPatternKey(itinerary)).join("||");
  return [
    offer.mainCarrier ?? offer.validatingCarrier ?? "",
    offer.price?.total?.amount?.toFixed(2) ?? "0",
    offer.price?.total?.currencyCode ?? "",
    String(offer.comparisonMetrics?.totalDurationMinutes ?? totalDurationMinutes(offer)),
    String(offer.comparisonMetrics?.totalStops ?? totalStopsCount(offer)),
    offer.baggage?.carryOnIncluded ? "1" : "0",
    offer.baggage?.checkedIncluded ? "1" : "0",
    itineraries,
  ].join("##");
}

function buildOfferGroups(offers) {
  const groups = new Map();
  for (const offer of offers) {
    const key = offerVariantGroupKey(offer);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(offer);
  }
  return [...groups.values()].map((group) => [...group].sort(compareOfferTravelDates));
}

function getGroupForOffer(offerId) {
  const all = state.searchResponse?.filteredOffers ?? state.searchResponse?.allOffers ?? [];
  const target = all.find((offer) => offer.id === offerId);
  if (!target) return null;
  const key = offerVariantGroupKey(target);
  return all
    .filter((offer) => offerVariantGroupKey(offer) === key)
    .sort(compareOfferTravelDates);
}

function formatOfferDateLabel(offer) {
  const { departureDate, returnDate } = offerPrimaryDates(offer);
  const departureText = formatDateCompact(departureDate);
  if (!returnDate) {
    return departureText;
  }
  return `${departureText} → ${formatDateCompact(returnDate)}`;
}

function buildGroupDateSummary(group, selectedOfferId) {
  const orderedGroup = [...group].sort(compareOfferTravelDates);
  const current = orderedGroup.find((offer) => offer.id === selectedOfferId) ?? orderedGroup[0];
  const labels = [...new Set(orderedGroup.map((offer) => formatOfferDateLabel(offer)))];
  const primary = current ? formatOfferDateLabel(current) : "—";
  const alternatives = labels.filter((label) => label !== primary);
  let secondary = "";

  if (alternatives.length === 1) {
    secondary = `También ${alternatives[0]}`;
  } else if (alternatives.length > 1) {
    secondary = `También ${alternatives[0]} y ${alternatives.length - 1} fecha${alternatives.length - 1 === 1 ? "" : "s"} más`;
  }

  return {
    primary,
    secondary,
    title: labels.join(" | "),
  };
}

function itineraryTimeWindow(itinerary) {
  const segments = itinerary?.segments ?? [];
  if (segments.length === 0) return "Horario por confirmar";
  const first = segments[0];
  const last = segments[segments.length - 1];
  return `${first.origin} ${timeOfIso(first.departureAt)} → ${last.destination} ${timeOfIso(last.arrivalAt)}`;
}

function buildOfferVariantSummary(offer) {
  const outbound = offer.itineraries?.find((it) => it.direction === "outbound") ?? offer.itineraries?.[0];
  const inbound = offer.itineraries?.find((it) => it.direction === "inbound");
  const pieces = [formatOfferDateLabel(offer)];
  if (outbound) {
    pieces.push(`Ida ${itineraryTimeWindow(outbound)}`);
  }
  if (inbound) {
    pieces.push(`Vuelta ${itineraryTimeWindow(inbound)}`);
  }
  return pieces.join(" · ");
}

function countWindowCombinations() {
  const ds = $("departureStart")?.value;
  const de = $("departureEnd")?.value;
  if (!ds || !de) return 0;
  const departures = enumerateIsoRange(ds, de);
  if (tripType.value === "one-way") return departures.length;
  const minDays = parseInt(stayDaysMinEl?.value, 10) || 7;
  const maxDays = parseInt(stayDaysMaxEl?.value, 10) || minDays;
  // In flexible mode, returns are derived from departures + stay days
  if (state.flexMode) {
    return departures.reduce((sum, dep) => {
      let count = 0;
      for (let d = minDays; d <= maxDays; d++) {
        const ret = addDaysIso(dep, d);
        if (ret > dep) count++;
      }
      return sum + count;
    }, 0);
  }
  const rs = $("returnStart")?.value;
  const re = $("returnEnd")?.value;
  if (!rs || !re) return 0;
  const returns = enumerateIsoRange(rs, re);
  return departures.reduce((sum, departureDate) => (
    sum + returns.filter((returnDate) => returnDate > departureDate).length
  ), 0);
}

function resultsPageCount(total) {
  return Math.max(1, Math.ceil(total / RESULTS_PAGE_SIZE));
}

function isLocal() {
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1";
}

function addDaysIso(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function enumerateIsoRange(start, end) {
  const values = [];
  let current = start;
  while (current <= end) {
    values.push(current);
    current = addDaysIso(current, 1);
  }
  return values;
}

function diffDaysIso(from, to) {
  return Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);
}

function calendarSelectionValues() {
  if (state.flexMode) {
    return {
      start: controlValue("departureStart"),
      end: controlValue("departureEnd"),
    };
  }

  return {
    start: controlValue("departureDate"),
    end: tripType.value === "round-trip" ? controlValue("returnDate") : "",
  };
}

function syncFlexibleDerivedDates() {
  if (!state.flexMode) return;
  const start = controlValue("departureStart");
  const end = controlValue("departureEnd");
  const minDays = parseInt(stayDaysMinEl?.value, 10) || 7;
  const maxDays = parseInt(stayDaysMaxEl?.value, 10) || minDays;

  if (!start || !end || tripType.value !== "round-trip") {
    if ($("returnStart")) $("returnStart").value = "";
    if ($("returnEnd")) $("returnEnd").value = "";
    return;
  }

  $("returnStart").value = addDaysIso(start, minDays);
  $("returnEnd").value = addDaysIso(end, maxDays);
}

function syncDateTriggerText() {
  if (!dateTriggerText) return;

  if (state.flexMode) {
    const start = controlValue("departureStart");
    const end = controlValue("departureEnd");
    const minDays = parseInt(stayDaysMinEl?.value, 10) || 7;
    const maxDays = parseInt(stayDaysMaxEl?.value, 10) || minDays;
    const stayText = minDays === maxDays ? `${minDays} noches` : `${minDays}-${maxDays} noches`;

    if (start && end) {
      dateTriggerText.textContent = `${formatDateCompact(start)} → ${formatDateCompact(end)} · ${stayText}`;
      return;
    }
    if (start) {
      dateTriggerText.textContent = `Desde ${formatDateCompact(start)} · ${stayText}`;
      return;
    }
    dateTriggerText.textContent = "Ventana de salida";
    return;
  }

  const departure = controlValue("departureDate");
  const ret = controlValue("returnDate");
  if (tripType.value === "one-way") {
    dateTriggerText.textContent = departure ? `${formatDateCompact(departure)} · solo ida` : "Fecha de salida";
    return;
  }

  if (departure && ret) {
    dateTriggerText.textContent = `${formatDateCompact(departure)} → ${formatDateCompact(ret)}`;
    return;
  }
  if (departure) {
    dateTriggerText.textContent = `Salida ${formatDateCompact(departure)}`;
    return;
  }

  dateTriggerText.textContent = "Salida y regreso";
}

function monthGridFor(isoMonth) {
  const monthStart = new Date(`${isoMonth}T00:00:00Z`);
  const monthIndex = monthStart.getUTCMonth();
  const gridStart = new Date(monthStart);
  const weekday = (monthStart.getUTCDay() + 6) % 7;
  gridStart.setUTCDate(gridStart.getUTCDate() - weekday);
  const days = [];

  for (let offset = 0; offset < 42; offset += 1) {
    const cellDate = new Date(gridStart);
    cellDate.setUTCDate(gridStart.getUTCDate() + offset);
    const iso = cellDate.toISOString().slice(0, 10);
    days.push({
      iso,
      day: String(cellDate.getUTCDate()),
      inMonth: cellDate.getUTCMonth() === monthIndex,
    });
  }

  return days;
}

function calendarMinMonth() {
  return firstDayOfMonth(minDateISO());
}

function calendarMaxMonth() {
  return firstDayOfMonth(ALLOWED_DATE_MAX);
}

function calendarMaxStartMonth() {
  const minMonth = calendarMinMonth();
  const maxMonth = calendarMaxMonth();
  const previousMonth = addMonthsIso(maxMonth, -1);
  return previousMonth < minMonth ? minMonth : previousMonth;
}

function clampCalendarViewMonth(month) {
  if (!month) return calendarMinMonth();
  const minMonth = calendarMinMonth();
  const maxStart = calendarMaxStartMonth();
  if (month < minMonth) return minMonth;
  if (month > maxStart) return maxStart;
  return month;
}

function resetCalendarViewMonth() {
  const selection = calendarSelectionValues();
  const preferred = selection.start || selection.end || minDateISO();
  calendarState.viewStartMonth = clampCalendarViewMonth(firstDayOfMonth(preferred));
}

function syncCalendarPopoverPosition() {
  if (!calendarPopover || !dateTrigger || calendarPopover.classList.contains("hidden")) return;

  const viewportPadding = floatingViewportPadding();
  const triggerRect = dateTrigger.getBoundingClientRect();
  const width = Math.min(960, window.innerWidth - viewportPadding * 2);

  calendarPopover.style.width = `${width}px`;
  calendarPopover.style.maxHeight = `${Math.min(window.innerHeight - viewportPadding * 2, 672)}px`;

  const popoverRect = calendarPopover.getBoundingClientRect();
  let left = triggerRect.left + (triggerRect.width / 2) - (width / 2);
  left = Math.max(viewportPadding, Math.min(left, window.innerWidth - width - viewportPadding));

  let top = triggerRect.bottom + floatingPanelOffset();
  if (top + popoverRect.height > window.innerHeight - viewportPadding) {
    const aboveTop = triggerRect.top - popoverRect.height - floatingPanelOffset();
    if (aboveTop >= viewportPadding) top = aboveTop;
    else top = Math.max(viewportPadding, window.innerHeight - popoverRect.height - viewportPadding);
  }

  calendarPopover.style.left = `${left}px`;
  calendarPopover.style.top = `${top}px`;
}

function syncCalendarSummary(selection) {
  if (!calendarSelectionSummary || !calendarTitle) return;

  if (state.flexMode) {
    calendarTitle.textContent = "Ventana de salida";
    if (selection.start && selection.end) {
      calendarSelectionSummary.textContent = `Salida flexible del ${formatDateCompact(selection.start)} al ${formatDateCompact(selection.end)}.`;
    } else if (selection.start) {
      calendarSelectionSummary.textContent = `Ventana iniciada en ${formatDateCompact(selection.start)}. Selecciona la fecha final.`;
    } else {
      calendarSelectionSummary.textContent = "Selecciona la primera fecha de la ventana de salida.";
    }
    return;
  }

  if (tripType.value === "one-way") {
    calendarTitle.textContent = "Fecha de salida";
    calendarSelectionSummary.textContent = selection.start
      ? `Salida elegida para el ${formatDateCompact(selection.start)}.`
      : "Selecciona la fecha de salida.";
    return;
  }

  calendarTitle.textContent = "Salida y regreso";
  if (selection.start && selection.end) {
    calendarSelectionSummary.textContent = `Ruta cerrada del ${formatDateCompact(selection.start)} al ${formatDateCompact(selection.end)}.`;
  } else if (selection.start) {
    calendarSelectionSummary.textContent = `Salida fijada para el ${formatDateCompact(selection.start)}. Selecciona el regreso.`;
  } else {
    calendarSelectionSummary.textContent = "Selecciona la salida y luego el regreso.";
  }
}

function renderCalendarPopover() {
  if (!calendarPopover || !calendarMonths) return;

  const selection = calendarSelectionValues();
  syncCalendarSummary(selection);
  calendarStayConfig?.classList.toggle("hidden", !state.flexMode);

  const firstMonth = clampCalendarViewMonth(calendarState.viewStartMonth || calendarMinMonth());
  const secondMonth = addMonthsIso(firstMonth, 1);
  const today = minDateISO();
  const canGoPrev = firstMonth > calendarMinMonth();
  const canGoNext = firstMonth < calendarMaxStartMonth();

  calendarPrev?.toggleAttribute("disabled", !canGoPrev);
  calendarNext?.toggleAttribute("disabled", !canGoNext);

  const months = [firstMonth, secondMonth].map((month) => {
    const days = monthGridFor(month);
    const dayButtons = days.map((day) => {
      const disabledByBounds = day.iso < today || day.iso > ALLOWED_DATE_MAX;
      const disabledByFlow = !state.flexMode
        && tripType.value === "round-trip"
        && calendarState.selectionStage === "end"
        && Boolean(selection.start)
        && !selection.end
        && day.iso <= selection.start;
      const disabled = disabledByBounds || disabledByFlow;
      const classes = [
        "calendar-day",
        day.inMonth ? "" : "calendar-day--outside",
        day.iso === today ? "calendar-day--today" : "",
        day.iso === selection.start ? "is-start" : "",
        day.iso === selection.end && selection.end !== selection.start ? "is-end" : "",
        selection.start && selection.end && day.iso > selection.start && day.iso < selection.end ? "is-between" : "",
      ].filter(Boolean).join(" ");

      return `
        <button
          type="button"
          class="${classes}"
          data-date-value="${day.iso}"
          ${disabled ? "disabled" : ""}
        >
          <span>${day.day}</span>
        </button>
      `;
    }).join("");

    return `
      <section class="calendar-month">
        <header class="calendar-month__header">
          <h3>${escapeHtml(formatMonthTitle(month))}</h3>
        </header>
        <div class="calendar-weekdays">
          <span>Lun</span><span>Mar</span><span>Mié</span><span>Jue</span><span>Vie</span><span>Sáb</span><span>Dom</span>
        </div>
        <div class="calendar-grid">
          ${dayButtons}
        </div>
      </section>
    `;
  }).join("");

  calendarMonths.innerHTML = months;
  calendarMonths.querySelectorAll("[data-date-value]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      applyCalendarSelection(button.dataset.dateValue);
    });
  });
  syncCalendarPopoverPosition();
  requestAnimationFrame(syncCalendarPopoverPosition);
}

function openCalendarPopover() {
  if (!calendarPopover) return;
  resetCalendarViewMonth();
  calendarPopover.classList.remove("hidden");
  renderCalendarPopover();
}

function closeCalendarPopover() {
  calendarPopover?.classList.add("hidden");
}

function clearCalendarSelection() {
  dateTrigger?.classList.remove("is-invalid");
  if (state.flexMode) {
    $("departureStart").value = "";
    $("departureEnd").value = "";
    $("returnStart").value = "";
    $("returnEnd").value = "";
  } else {
    $("departureDate").value = "";
    $("returnDate").value = "";
  }
  calendarState.selectionStage = "start";
  syncDateTriggerText();
  renderCalendarPopover();
}

function applyCalendarSelection(iso) {
  if (!iso) return;

  if (state.flexMode) {
    const start = controlValue("departureStart");
    const end = controlValue("departureEnd");

    if (calendarState.selectionStage === "start" || !start || (start && end)) {
      $("departureStart").value = iso;
      $("departureEnd").value = "";
      calendarState.selectionStage = "end";
    } else {
      const nextStart = iso < start ? iso : start;
      const nextEnd = iso < start ? start : iso;
      $("departureStart").value = nextStart;
      $("departureEnd").value = nextEnd;
      calendarState.selectionStage = "start";
    }
    syncFlexibleDerivedDates();
    syncDateTriggerText();
    renderCalendarPopover();
    return;
  }

  if (tripType.value === "one-way") {
    $("departureDate").value = iso;
    $("returnDate").value = "";
    calendarState.selectionStage = "start";
    syncDateTriggerText();
    closeCalendarPopover();
    return;
  }

  const departure = controlValue("departureDate");
  const ret = controlValue("returnDate");

  if (calendarState.selectionStage === "start" || !departure || (departure && ret)) {
    $("departureDate").value = iso;
    $("returnDate").value = "";
    calendarState.selectionStage = "end";
  } else if (iso <= departure) {
    $("departureDate").value = iso;
    $("returnDate").value = "";
    calendarState.selectionStage = "end";
  } else {
    $("returnDate").value = iso;
    calendarState.selectionStage = "start";
    closeCalendarPopover();
  }

  syncDateTriggerText();
  renderCalendarPopover();
}

function summarizeMatrixConfidence(cells) {
  return cells.reduce((acc, cell) => {
    acc[cell.confidence] = (acc[cell.confidence] || 0) + 1;
    return acc;
  }, {});
}

function buildPendingMatrixResponse(request) {
  const leg = request.legs?.[0];
  const departures = enumerateIsoRange(leg.departureStart, leg.departureEnd);
  const returns = request.tripType === "round-trip"
    ? enumerateIsoRange(leg.returnStart, leg.returnEnd)
    : [];
  const requestedAt = new Date().toISOString();
  const cells = request.tripType === "one-way"
    ? departures.map((departureDate) => ({
        key: departureDate,
        departureDate,
        confidence: "loading",
        providerSource: "agil-local",
        selectable: false,
        requiresRequery: true,
        stateCode: "ind",
        tooltip: "Consultando Agil...",
        derivedRequest: {
          ...request,
          tripType: "one-way",
          searchMode: "exact",
          legs: [{ origin: leg.origin, destination: leg.destination, departureDate }],
        },
      }))
    : departures.flatMap((departureDate) => returns.map((returnDate) => {
        if (returnDate <= departureDate) {
          return {
            key: `${departureDate}_${returnDate}`,
            departureDate,
            returnDate,
            confidence: "empty",
            providerSource: "agil-local",
            selectable: false,
            requiresRequery: true,
            stateCode: "emp",
            tooltip: "Return date must be after departure date.",
          };
        }

        return {
          key: `${departureDate}_${returnDate}`,
          departureDate,
          returnDate,
          stayNights: diffDaysIso(departureDate, returnDate),
          confidence: "loading",
          providerSource: "agil-local",
          selectable: false,
          requiresRequery: true,
          stateCode: "ind",
          tooltip: "Consultando Agil...",
          derivedRequest: {
            ...request,
            tripType: "round-trip",
            searchMode: "exact",
            legs: [{ origin: leg.origin, destination: leg.destination, departureDate, returnDate }],
          },
        };
      }));

  return {
    matrixJobId: null,
    matrixComplete: false,
    matrixStatus: "running",
    request,
    cells,
    axes: {
      departureDates: departures,
      returnDates: returns,
    },
    confidenceSummary: summarizeMatrixConfidence(cells),
    recommendations: [
      "Matrix loading from Agil in parallel.",
      "Prices appear as each date combination resolves.",
    ],
    searchMeta: {
      requestedAt,
      completedAt: requestedAt,
      providersUsed: ["agil-local"],
      warnings: ["Matrix loading from Agil in parallel."],
      partial: true,
      searchState: "search_partial",
    },
    providerMeta: {
      exactProvider: "agil-local",
      coverageMode: request.coverageMode,
    },
    warnings: ["Matrix loading from Agil in parallel."],
  };
}

function buildPendingSearchResponse(request, sortMode) {
  const requestedAt = new Date().toISOString();
  return {
    searchJobId: null,
    searchComplete: false,
    searchStatus: "running",
    request,
    sortMode,
    offers: [],
    allOffers: [],
    filteredOffers: [],
    searchMeta: {
      requestedAt,
      completedAt: requestedAt,
      providersUsed: ["agil-local"],
      warnings: ["Consultando Agil. Los resultados se iran agregando."],
      partial: true,
      searchState: "search_partial",
    },
    providerMeta: {
      exactProvider: "agil-local",
      coverageMode: request.coverageMode,
    },
    warnings: ["Consultando Agil. Los resultados se iran agregando."],
  };
}

function stopMatrixPolling() {
  if (state.matrixPollHandle) {
    clearTimeout(state.matrixPollHandle);
    state.matrixPollHandle = null;
  }
  state.matrixJobId = null;
}

function stopSearchPolling() {
  if (state.searchPollHandle) {
    clearTimeout(state.searchPollHandle);
    state.searchPollHandle = null;
  }
  state.searchJobId = null;
}

function selOffer() {
  if (!state.selectedOfferId) return null;
  return state.searchResponse?.offers?.find(o => o.id === state.selectedOfferId)
    ?? state.searchResponse?.filteredOffers?.find(o => o.id === state.selectedOfferId)
    ?? state.searchResponse?.allOffers?.find(o => o.id === state.selectedOfferId)
    ?? null;
}

function sessionId() {
  return state.searchResponse?.searchMeta?.searchSessionId ?? null;
}

/* ================================================================
   PAX POPOVER
   ================================================================ */

function updatePaxLabel() {
  const a = parseInt($("adults").value, 10) || 1;
  const c = parseInt($("children").value, 10) || 0;
  const i = parseInt($("infants").value, 10) || 0;
  if (paxLabel) paxLabel.textContent = formatPassengerSummary(a, c, i);
  if (paxAdultsDisplay) paxAdultsDisplay.textContent = a;
  if (paxChildrenDisplay) paxChildrenDisplay.textContent = c;
  if (paxInfantsDisplay) paxInfantsDisplay.textContent = i;
}

function setupPaxPopover() {
  if (!paxTrigger || !paxPopover) return;
  paxTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    closeCalendarPopover();
    closeLayoverPopover();
    paxPopover.classList.toggle("hidden");
    if (!paxPopover.classList.contains("hidden")) {
      syncPaxPopoverPosition();
    }
  });
  document.addEventListener("click", (e) => {
    if (!paxPopover.contains(e.target) && e.target !== paxTrigger && !paxTrigger.contains(e.target)) {
      paxPopover.classList.add("hidden");
    }
  });
  paxPopover.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-pax-action]");
    if (!btn) return;
    e.preventDefault();
    const action = btn.dataset.paxAction;
    let a = parseInt($("adults").value, 10) || 1;
    let c = parseInt($("children").value, 10) || 0;
    let i = parseInt($("infants").value, 10) || 0;
    if (action === "adults-inc" && a + c + i < 9) a++;
    if (action === "adults-dec" && a > 1) { a--; if (i > a) i = a; }
    if (action === "children-inc" && a + c + i < 9) c++;
    if (action === "children-dec" && c > 0) c--;
    if (action === "infants-inc" && i < a && a + c + i < 9) i++;
    if (action === "infants-dec" && i > 0) i--;
    $("adults").value = a;
    $("children").value = c;
    $("infants").value = i;
    updatePaxLabel();
    syncPaxPopoverPosition();
  });
}

function readCssPixels(value) {
  return Number.parseFloat(value || "0") || 0;
}

function resolveCssLength(value) {
  const source = String(value || "").trim();
  if (!source) return 0;
  if (/^-?\d+(\.\d+)?px$/i.test(source)) return Number.parseFloat(source) || 0;

  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.width = source;
  document.body.appendChild(probe);
  const resolved = probe.getBoundingClientRect().width;
  probe.remove();
  return resolved;
}

function resolveRootCssLength(variableName, fallback = 0) {
  const rootStyles = getComputedStyle(document.documentElement);
  const value = resolveCssLength(rootStyles.getPropertyValue(variableName));
  return value > 0 ? value : fallback;
}

function measureIntrinsicWidth(element) {
  if (!(element instanceof HTMLElement)) return 0;

  const clone = element.cloneNode(true);
  clone.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
  clone.querySelectorAll(".autocomplete-menu, .pax-popover, .refinement-popover, .calendar-popover").forEach((node) => {
    node.classList.add("hidden");
  });

  clone.style.position = "absolute";
  clone.style.left = "-99999px";
  clone.style.top = "0";
  clone.style.width = "max-content";
  clone.style.minWidth = "0";
  clone.style.maxWidth = "none";
  clone.style.visibility = "hidden";
  clone.style.pointerEvents = "none";
  clone.style.contain = "layout style";
  clone.style.zIndex = "-1";

  document.body.appendChild(clone);
  const width = Math.ceil(clone.getBoundingClientRect().width);
  clone.remove();
  return width;
}

function measureTriggerWidthForLabels(trigger, selector, labels) {
  if (!(trigger instanceof HTMLElement) || !Array.isArray(labels) || labels.length === 0) return 0;

  const clone = trigger.cloneNode(true);
  clone.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
  const cloneText = clone.querySelector(selector);
  if (!(cloneText instanceof HTMLElement)) {
    return measureIntrinsicWidth(trigger);
  }

  clone.style.position = "absolute";
  clone.style.left = "-99999px";
  clone.style.top = "0";
  clone.style.width = "max-content";
  clone.style.minWidth = "0";
  clone.style.maxWidth = "none";
  clone.style.visibility = "hidden";
  clone.style.pointerEvents = "none";
  clone.style.contain = "layout style";
  clone.style.zIndex = "-1";

  document.body.appendChild(clone);
  let maxWidth = 0;
  labels.forEach((label) => {
    cloneText.textContent = label;
    maxWidth = Math.max(maxWidth, Math.ceil(clone.getBoundingClientRect().width));
  });
  clone.remove();
  return maxWidth;
}

function measureTrackWidth(segment) {
  if (!(segment instanceof HTMLElement)) return 0;
  const label = segment.querySelector(".field-label");
  const control = segment.querySelector(".segmented-control, .field-shell, .field-button, .btn");
  return Math.max(
    measureIntrinsicWidth(label),
    measureIntrinsicWidth(control),
    measureIntrinsicWidth(segment),
  );
}

function measureRefinementMinWidth(item) {
  if (!(item instanceof HTMLElement)) return 0;
  const text = item.querySelector(".refinement__text");
  const trigger = item.querySelector(".refinement__trigger");
  const basis = trigger instanceof HTMLElement ? trigger : item;
  const style = getComputedStyle(basis);
  const icon = item.querySelector(".refinement__icon");
  const textWidth = text instanceof HTMLElement ? Math.ceil(text.scrollWidth) : measureIntrinsicWidth(basis);
  const paddingWidth = readCssPixels(style.paddingLeft) + readCssPixels(style.paddingRight);
  const iconWidth = icon && "getBoundingClientRect" in icon ? Math.ceil(icon.getBoundingClientRect().width) : 0;
  const symmetricReserve = iconWidth > 0 ? iconWidth * 2 : 0;
  const select = item.querySelector(".refinement__native-select");
  const intrinsicWidth = Math.ceil(textWidth + paddingWidth + symmetricReserve + 4);

  if (trigger instanceof HTMLElement && text instanceof HTMLElement && select instanceof HTMLSelectElement) {
    const emptyLabel = text.dataset.emptyLabel?.trim() || text.textContent?.trim() || "";
    const valuePrefix = text.dataset.valuePrefix ?? `${emptyLabel}: `;
    const candidateLabels = [
      emptyLabel,
      ...[...select.options]
        .filter((option) => option.value !== "")
        .map((option) => `${valuePrefix}${option.textContent?.trim() || ""}`),
    ].filter(Boolean);
    return Math.max(
      intrinsicWidth,
      measureTriggerWidthForLabels(trigger, ".refinement__text", [...new Set(candidateLabels)]),
    );
  }

  return intrinsicWidth;
}

function syncSearchShellLayoutMetrics() {
  if (!searchForm) return;

  const shellGap = readCssPixels(getComputedStyle(searchForm.querySelector(".search-rail") || searchForm).columnGap);
  const modeSegment = searchForm.querySelector('[data-search-order="mode"]');
  const tripSegment = searchForm.querySelector('[data-search-order="trip"]');
  const refinementItems = [...searchForm.querySelectorAll(".search-refinements > .refinement")];
  const actionButtons = [...searchForm.querySelectorAll(".search-shell__action")];

  const modeWidth = measureTrackWidth(modeSegment);
  const tripWidth = measureTrackWidth(tripSegment);
  const pairBaseWidth = modeWidth + tripWidth + shellGap;
  const largestRefinement = refinementItems.reduce((maxWidth, item) => {
    return Math.max(maxWidth, measureRefinementMinWidth(item));
  }, 0);
  const refinementGroupWidth = refinementItems.length
    ? (largestRefinement * refinementItems.length) + (shellGap * Math.max(refinementItems.length - 1, 0))
    : 0;
  const pairTargetWidth = Math.max(pairBaseWidth, refinementGroupWidth);
  const pairContentWidth = modeWidth + tripWidth;
  const pairExtraWidth = Math.max(0, pairTargetWidth - pairBaseWidth);
  const modeWeight = pairContentWidth > 0 ? modeWidth / pairContentWidth : 0.5;
  const modeTrack = Math.ceil(modeWidth + (pairExtraWidth * modeWeight));
  const tripTrack = Math.ceil(tripWidth + (pairExtraWidth * (1 - modeWeight)));

  if (modeTrack > 0) {
    searchForm.style.setProperty("--shell-mode-track", `${modeTrack}px`);
  }
  if (tripTrack > 0) {
    searchForm.style.setProperty("--shell-trip-track", `${tripTrack}px`);
  }

  const submitWidth = measureIntrinsicWidth(submitButton);
  const actionRailWidth = actionButtons.reduce((totalWidth, button, index) => {
    return totalWidth + measureIntrinsicWidth(button) + (index > 0 ? shellGap : 0);
  }, 0);
  const nextActionWidth = Math.max(submitWidth, actionRailWidth);
  if (nextActionWidth > 0) {
    searchForm.style.setProperty("--shell-actions-width", `${Math.ceil(nextActionWidth)}px`);
  }
}

function syncLayoverFilterUi() {
  const select = $("maxLayoverMinutes");
  if (!(select instanceof HTMLSelectElement)) return;

  const selected = [...select.options].find((option) => option.value === select.value) ?? select.options[0];
  if (layoverTriggerValue) {
    const emptyLabel = layoverTriggerValue.dataset.emptyLabel?.trim() || "Escala";
    const valuePrefix = layoverTriggerValue.dataset.valuePrefix ?? `${emptyLabel}: `;
    layoverTriggerValue.textContent = select.value === ""
      ? emptyLabel
      : `${valuePrefix}${selected?.textContent || emptyLabel}`;
  }

  layoverPopover?.querySelectorAll("[data-layover-value]").forEach((option) => {
    const isSelected = option.dataset.layoverValue === select.value;
    option.classList.toggle("is-selected", isSelected);
    option.setAttribute("aria-selected", String(isSelected));
  });

  syncLayoverPopoverPosition();
}

function openLayoverPopover() {
  if (!layoverFilter || !layoverTrigger || !layoverPopover) return;
  syncLayoverFilterUi();
  layoverFilter.classList.add("is-open");
  layoverTrigger.setAttribute("aria-expanded", "true");
  layoverPopover.classList.remove("hidden");
  syncLayoverPopoverPosition();
}

function closeLayoverPopover() {
  if (!layoverFilter || !layoverTrigger || !layoverPopover) return;
  layoverFilter.classList.remove("is-open");
  layoverTrigger.setAttribute("aria-expanded", "false");
  layoverPopover.classList.add("hidden");
}

function setLayoverFilterValue(value) {
  const select = $("maxLayoverMinutes");
  if (!(select instanceof HTMLSelectElement)) return;

  if (select.value !== value) {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  syncLayoverFilterUi();
  closeLayoverPopover();
}

function syncLayoverPopoverPosition() {
  if (!layoverTrigger || !layoverPopover) return;
  const minWidth = resolveRootCssLength("--layover-popover-min-width", 144);
  const maxWidth = resolveRootCssLength("--layover-popover-max-width", 220);
  syncAnchoredPopoverPosition(layoverTrigger, layoverPopover, {
    width: Math.max(layoverTrigger.getBoundingClientRect().width, minWidth),
    minWidth,
    maxWidth,
  });
}

function setupLayoverPopover() {
  const select = $("maxLayoverMinutes");
  if (!layoverFilter || !layoverTrigger || !layoverPopover || !(select instanceof HTMLSelectElement)) return;

  syncLayoverFilterUi();

  layoverTrigger.addEventListener("click", (event) => {
    event.stopPropagation();
    paxPopover?.classList.add("hidden");
    closeCalendarPopover();
    if (layoverPopover.classList.contains("hidden")) openLayoverPopover();
    else closeLayoverPopover();
  });

  layoverTrigger.addEventListener("keydown", (event) => {
    if (!["Enter", " ", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    openLayoverPopover();
  });

  layoverPopover.addEventListener("click", (event) => {
    const option = event.target.closest("[data-layover-value]");
    if (!option) return;
    event.preventDefault();
    setLayoverFilterValue(option.dataset.layoverValue || "");
  });

  document.addEventListener("click", (event) => {
    if (!layoverPopover.contains(event.target) && event.target !== layoverTrigger && !layoverTrigger.contains(event.target)) {
      closeLayoverPopover();
    }
  });

  select.addEventListener("change", syncLayoverFilterUi);
}

/* ================================================================
   MODE TOGGLE & FLEXIBLE DATES
   ================================================================ */

function setupModeToggle() {
  document.querySelectorAll("[data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.flexMode = btn.dataset.mode === "flexible";

      if (state.flexMode && !$("departureStart").value && $("departureDate").value) {
        $("departureStart").value = $("departureDate").value;
        $("departureEnd").value = $("returnDate").value || $("departureDate").value;
      }

      if (!state.flexMode && !$("departureDate").value && $("departureStart").value) {
        $("departureDate").value = $("departureStart").value;
        if (tripType.value === "round-trip" && $("departureEnd").value) {
          $("returnDate").value = $("departureEnd").value;
        }
      }

      calendarState.selectionStage = "start";
      updateModeFields();
    });
  });
}

function setupTripTypeToggle() {
  document.querySelectorAll("[data-trip]").forEach((btn) => {
    btn.addEventListener("click", () => {
      tripType.value = btn.dataset.trip || "round-trip";
      if (tripType.value === "one-way") {
        $("returnDate").value = "";
        $("returnStart").value = "";
        $("returnEnd").value = "";
      }
      calendarState.selectionStage = "start";
      updateModeFields();
    });
  });
}

function setupThemeToggle() {
  setTheme(initialTheme(), { persist: false });
  themeButtons.forEach((button) => {
    button.addEventListener("click", () => setTheme(button.dataset.themeValue));
  });
}

function setupCalendarPopover() {
  if (!dateTrigger || !calendarPopover) return;

  if (calendarPopover.parentElement !== document.body) {
    document.body.appendChild(calendarPopover);
  }

  dateTrigger.addEventListener("click", (event) => {
    event.stopPropagation();
    paxPopover?.classList.add("hidden");
    closeLayoverPopover();
    if (calendarPopover.classList.contains("hidden")) openCalendarPopover();
    else closeCalendarPopover();
  });

  calendarClose?.addEventListener("click", closeCalendarPopover);
  calendarDone?.addEventListener("click", closeCalendarPopover);
  calendarClear?.addEventListener("click", clearCalendarSelection);
  calendarPrev?.addEventListener("click", (event) => {
    event.stopPropagation();
    calendarState.viewStartMonth = clampCalendarViewMonth(addMonthsIso(calendarState.viewStartMonth || calendarMinMonth(), -1));
    renderCalendarPopover();
  });
  calendarNext?.addEventListener("click", (event) => {
    event.stopPropagation();
    calendarState.viewStartMonth = clampCalendarViewMonth(addMonthsIso(calendarState.viewStartMonth || calendarMinMonth(), 1));
    renderCalendarPopover();
  });

  [stayDaysMinEl, stayDaysMaxEl].forEach((input) => {
    input?.addEventListener("change", () => {
      syncFlexibleDerivedDates();
      syncDateTriggerText();
      if (!calendarPopover.classList.contains("hidden")) renderCalendarPopover();
    });
  });

  document.addEventListener("click", (event) => {
    if (!calendarPopover.contains(event.target) && event.target !== dateTrigger && !dateTrigger.contains(event.target)) {
      closeCalendarPopover();
    }
  });
}

function translateFlexibleDates(payload) {
  if (!state.flexMode) return payload;
  const minDays = parseInt(stayDaysMinEl?.value, 10) || 7;
  const maxDays = parseInt(stayDaysMaxEl?.value, 10) || minDays;
  const depStart = $("departureStart")?.value;
  const depEnd = $("departureEnd")?.value;
  if (!depStart || !depEnd) return payload;
  const leg = payload.request.legs[0];
  leg.departureStart = depStart;
  leg.departureEnd = depEnd;
  if (payload.request.tripType === "round-trip") {
    leg.returnStart = addDaysIso(depStart, minDays);
    leg.returnEnd = addDaysIso(depEnd, maxDays);
    payload.request.searchMode = "roundtrip-grid";
  } else {
    payload.request.searchMode = "stay-range";
  }
  return payload;
}

/* ================================================================
   INPUT ENFORCEMENT — real-time, preventive
   ================================================================ */

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function minDateISO() {
  const today = todayISO();
  if (today < ALLOWED_DATE_MIN) return ALLOWED_DATE_MIN;
  if (today > ALLOWED_DATE_MAX) return ALLOWED_DATE_MAX;
  return today;
}

function maxDateISO() {
  return ALLOWED_DATE_MAX;
}

function clampDayToMonth(year, month, day) {
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Math.min(day, maxDay);
}

function normalizeToAllowedYear(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const normalizedDay = clampDayToMonth(Number(ALLOWED_DATE_YEAR), month, day);
  return `${ALLOWED_DATE_YEAR}-${String(month).padStart(2, "0")}-${String(normalizedDay).padStart(2, "0")}`;
}

function enforceDateBounds() {
  const today = minDateISO();
  const max = maxDateISO();
  const ids = ["departureDate", "returnDate", "departureStart", "departureEnd", "returnStart", "returnEnd"];
  ids.forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.min = today;
    el.max = max;
  });
}

function enforceDateYear(input) {
  if (!input) return;
  const normalize = () => {
    if (!input.value) return;
    const normalized = normalizeToAllowedYear(input.value);
    if (normalized !== input.value) {
      input.value = normalized;
      input.classList.add("is-invalid");
      setTimeout(() => input.classList.remove("is-invalid"), 800);
    }
  };

  input.addEventListener("change", normalize);
  input.addEventListener("blur", normalize);
}

function enforceIntRange(input, min, max) {
  if (!input) return;
  input.addEventListener("input", () => {
    let raw = input.value.replace(/[^0-9]/g, "");
    if (raw.length > String(max).length) raw = raw.slice(0, String(max).length);
    input.value = raw;
  });
  input.addEventListener("blur", () => {
    let v = parseInt(input.value, 10);
    if (isNaN(v)) { input.value = String(min); return; }
    if (v < min) v = min;
    if (v > max) v = max;
    input.value = String(v);
  });
}

function enforceDateNotPast(input) {
  if (!input) return;
  // Only enforce on blur — firing on change is too aggressive while the
  // user is still typing the year digit by digit.
  input.addEventListener("blur", () => {
    if (!input.value) return;
    // Ignore partial/incomplete dates (browser may report them as empty anyway)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.value)) return;
    const today = minDateISO();
    const max = maxDateISO();
    if (input.value < today) {
      input.value = today;
      input.classList.add("is-invalid");
      setTimeout(() => input.classList.remove("is-invalid"), 1500);
    } else if (input.value > max) {
      input.value = max;
      input.classList.add("is-invalid");
      setTimeout(() => input.classList.remove("is-invalid"), 1500);
    }
  });
}

function setupInputEnforcement() {
  enforceIntRange($("adults"), 1, 9);
  enforceIntRange($("children"), 0, 8);
  enforceIntRange($("infants"), 0, 4);

  if (stayDaysMinEl) enforceIntRange(stayDaysMinEl, 1, 90);
  if (stayDaysMaxEl) enforceIntRange(stayDaysMaxEl, 1, 90);

  const dateIds = ["departureDate", "returnDate", "departureStart", "departureEnd", "returnStart", "returnEnd"];
  dateIds.forEach((id) => {
    const input = $(id);
    enforceDateYear(input);
    enforceDateNotPast(input);
    input?.addEventListener("change", () => {
      syncFlexibleDerivedDates();
      syncDateTriggerText();
      if (!calendarPopover?.classList.contains("hidden")) renderCalendarPopover();
    });
  });

  enforceDateBounds();
}

/* ================================================================
   VALIDATION — on submit, catches anything enforcement missed
   ================================================================ */

function validateForm() {
  const errs = [];
  const mode = searchMode.value;
  const trip = tripType.value;
  const today = minDateISO();

  searchForm.querySelectorAll(".is-invalid").forEach((el) => el.classList.remove("is-invalid"));

  const origin = $("origin").value;
  const dest = $("destination").value;
  const originCode = resolvedLocationCode("origin");
  const destinationCode = resolvedLocationCode("destination");

  if (!originCode) { errs.push("Origen: selecciona una sugerencia de Agil o escribe un IATA valido."); $("origin").classList.add("is-invalid"); }
  if (!destinationCode) { errs.push("Destino: selecciona una sugerencia de Agil o escribe un IATA valido."); $("destination").classList.add("is-invalid"); }
  if (originCode && destinationCode && originCode === destinationCode) {
    errs.push("Origen y destino no pueden ser iguales.");
    $("origin").classList.add("is-invalid");
    $("destination").classList.add("is-invalid");
  }

  const adults = parseInt($("adults").value, 10);
  const children = parseInt($("children").value, 10);
  const infants = parseInt($("infants").value, 10);

  if (isNaN(adults) || adults < 1) { errs.push("Al menos 1 adulto."); $("adults").classList.add("is-invalid"); }
  if (!isNaN(infants) && !isNaN(adults) && infants > adults) {
    errs.push("Infantes no puede superar adultos.");
    $("infants").classList.add("is-invalid");
  }
  if ((adults || 0) + (children || 0) + (infants || 0) > 9) {
    errs.push("Maximo 9 pasajeros en total.");
  }

  function checkDate(id, label) {
    const el = $(id);
    if (!el) return false;
    const v = el.value;
    if (!v) { errs.push(`${label} es obligatorio.`); el.classList.add("is-invalid"); return false; }
    if (!v.startsWith(`${ALLOWED_DATE_YEAR}-`)) {
      errs.push(`${label} debe estar dentro del anio ${ALLOWED_DATE_YEAR}.`);
      el.classList.add("is-invalid");
      return false;
    }
    if (v < today) { errs.push(`${label} no puede ser pasada.`); el.classList.add("is-invalid"); return false; }
    if (v > ALLOWED_DATE_MAX) {
      errs.push(`${label} debe estar dentro del anio ${ALLOWED_DATE_YEAR}.`);
      el.classList.add("is-invalid");
      return false;
    }
    return true;
  }

  if (mode === "exact") {
    const depOk = checkDate("departureDate", "Fecha salida");
    if (trip === "round-trip") {
      const retOk = checkDate("returnDate", "Fecha regreso");
      if (depOk && retOk && $("returnDate").value <= $("departureDate").value) {
        errs.push("Regreso debe ser posterior a salida.");
        $("returnDate").classList.add("is-invalid");
      }
    }
  }

  // Flexible mode validation
  if (state.flexMode) {
    const minDays = parseInt(stayDaysMinEl?.value, 10);
    const maxDays = parseInt(stayDaysMaxEl?.value, 10);
    if (isNaN(minDays) || minDays < 1) { errs.push("Duracion minima requerida."); }
    if (!isNaN(minDays) && !isNaN(maxDays) && maxDays < minDays) { errs.push("Duracion maxima debe ser >= minima."); }
    checkDate("departureStart", "Ventana inicio");
    checkDate("departureEnd", "Ventana fin");
    const ds = $("departureStart")?.value;
    const de = $("departureEnd")?.value;
    if (ds && de && de < ds) errs.push("Ventana fin debe ser >= ventana inicio.");
  }

  if (mode === "roundtrip-grid" || mode === "stay-range") {
    if (!state.flexMode) {
      checkDate("departureStart", "Salida inicio");
      checkDate("departureEnd", "Salida fin");
      if (trip === "round-trip") {
        checkDate("returnStart", "Regreso inicio");
        checkDate("returnEnd", "Regreso fin");
      }

      const ds = $("departureStart")?.value;
      const de = $("departureEnd")?.value;
      const rs = $("returnStart")?.value;
      const re = $("returnEnd")?.value;

      if (ds && de && de < ds) errs.push("Salida fin debe ser >= salida inicio.");
      if (trip === "round-trip") {
        if (rs && re && re < rs) errs.push("Regreso fin debe ser >= regreso inicio.");
        if (ds && rs && rs < ds) errs.push("Regreso debe empezar despues de la salida.");
      }
    }
  }

  if (mode === "stay-range") {
    const combinations = countWindowCombinations();
    if (combinations === 0) {
      errs.push("El rango no genera combinaciones validas.");
    }
  }

  if (mode === "roundtrip-grid") {
    const combinations = countWindowCombinations();
    if (combinations === 0) {
      errs.push("La matriz no genera combinaciones validas.");
    }
  }

  return errs;
}

function showErrors(errors) {
  dateTrigger?.classList.remove("is-invalid");
  if (errors.length === 0) {
    validationBox.classList.add("hidden");
    validationBox.innerHTML = "";
    syncWorkspaceViewportHeight();
    return;
  }
  validationBox.classList.remove("hidden");
  if (errors.some((error) => /fecha|ventana|salida|regreso|matriz|rango/i.test(error))) {
    dateTrigger?.classList.add("is-invalid");
  }
  validationBox.innerHTML = `<ul>${errors.map((e) => `<li>${e}</li>`).join("")}</ul>`;
  syncWorkspaceViewportHeight();
}

/* ================================================================
   FORM HELPERS
   ================================================================ */

function updateModeFields() {
  const isFlexible = state.flexMode;
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === (isFlexible ? "flexible" : "exact"));
  });
  document.querySelectorAll("[data-trip]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.trip === tripType.value);
  });

  searchMode.value = isFlexible
    ? tripType.value === "round-trip" ? "roundtrip-grid" : "stay-range"
    : "exact";

  calendarStayConfig?.classList.toggle("hidden", !isFlexible);
  if (!isFlexible) {
    $("returnStart").value = "";
    $("returnEnd").value = "";
  } else {
    syncFlexibleDerivedDates();
  }

  syncDateTriggerText();
  if (!calendarPopover?.classList.contains("hidden")) renderCalendarPopover();
}

function toCarrierList(raw) {
  return raw.split(",").map((v) => v.trim().toUpperCase()).filter(Boolean);
}

function getFormPayload() {
  const fd = new FormData(searchForm);
  const m = String(fd.get("searchMode") || "exact");
  const t = String(fd.get("tripType") || "round-trip");
  const disableMaxResults = m === "stay-range" && t === "one-way";
  return {
    sortMode: String(fd.get("sortMode") || "cheapest"),
    request: {
      tripType: t,
      searchMode: m,
      cabin: "ECONOMY",
      currencyCode: DEFAULT_CURRENCY_CODE,
      coverageMode: "core",
      redirectMode: "best-effort",
      passengers: {
        adults: parseInt($("adults").value, 10) || 1,
        children: parseInt($("children").value, 10) || 0,
        infants: parseInt($("infants").value, 10) || 0,
      },
      filters: {
        nonStop: fd.get("nonStop") === "on",
        baggageRequired: fd.get("baggageRequired") === "on",
        maxLayoverMinutes: readMaxLayoverFilter(),
        maxResults: disableMaxResults ? undefined : 25,
        includedAirlineCodes: [],
      },
      legs: [{
        origin: resolvedLocationCode("origin"),
        destination: resolvedLocationCode("destination"),
        originLabel: $("origin")?.dataset.label ?? $("origin")?.value ?? "",
        destinationLabel: $("destination")?.dataset.label ?? $("destination")?.value ?? "",
        departureDate: $("departureDate").value,
        returnDate: $("returnDate")?.value ?? "",
        departureStart: $("departureStart")?.value ?? "",
        departureEnd: $("departureEnd")?.value ?? "",
        returnStart: $("returnStart")?.value ?? "",
        returnEnd: $("returnEnd")?.value ?? "",
      }],
    },
  };
}

/* ================================================================
   API
   ================================================================ */

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.errors && data.errors.join(" ")) || data.error || "Error inesperado");
  return data;
}

async function getJson(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error((data.errors && data.errors.join(" ")) || data.error || "Error inesperado");
  return data;
}

function totalDurationMinutes(offer) {
  return (offer.itineraries || []).reduce((sum, itinerary) => sum + (itinerary.durationMinutes || 0), 0);
}

function totalStopsCount(offer) {
  return (offer.itineraries || []).reduce((sum, itinerary) => sum + (itinerary.stops || 0), 0);
}

function maxStopsAcrossItineraries(offer) {
  return (offer?.itineraries || []).reduce((max, itinerary) => Math.max(max, itinerary?.stops || 0), 0);
}

function compareOffersForSortMode(left, right, mode) {
  if (mode === "fastest") {
    const durationDiff = totalDurationMinutes(left) - totalDurationMinutes(right);
    if (durationDiff !== 0) return durationDiff;
  } else if (mode === "best-value") {
    const valueDiff = (left.valueScore ?? Number.MAX_SAFE_INTEGER) - (right.valueScore ?? Number.MAX_SAFE_INTEGER);
    if (valueDiff !== 0) return valueDiff;
  } else {
    const priceDiff = (left.price?.total?.amount ?? Number.MAX_SAFE_INTEGER) - (right.price?.total?.amount ?? Number.MAX_SAFE_INTEGER);
    if (priceDiff !== 0) return priceDiff;
  }

  return compareOfferTravelDates(left, right);
}

function computeLayoverMinutes(itinerary, index) {
  const layoverMinutes = itinerary?.layoverMinutes?.[index];
  if (typeof layoverMinutes === "number" && layoverMinutes > 0) {
    return layoverMinutes;
  }

  const current = itinerary?.segments?.[index];
  const next = itinerary?.segments?.[index + 1];
  if (!current?.arrivalAt || !next?.departureAt) {
    return null;
  }

  const currentMs = new Date(current.arrivalAt).getTime();
  const nextMs = new Date(next.departureAt).getTime();
  if (!Number.isFinite(currentMs) || !Number.isFinite(nextMs) || nextMs <= currentMs) {
    return null;
  }

  return Math.round((nextMs - currentMs) / 60000);
}

function cityLabel(value = "") {
  const normalized = String(value).trim();
  if (!normalized) return "";
  return normalized
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function layoverItemsForItinerary(itinerary) {
  const segments = itinerary?.segments ?? [];
  if (segments.length < 2) return [];

  return segments.slice(0, -1).map((segment, index) => {
    const minutes = computeLayoverMinutes(itinerary, index);
    if (typeof minutes !== "number" || minutes <= 0) {
      return null;
    }

    return {
      city: cityLabel(segment.destinationName || segment.destination || "Escala"),
      minutes,
    };
  }).filter(Boolean);
}

function layoverItemsForOffer(offer) {
  return (offer?.itineraries ?? []).flatMap((itinerary) => layoverItemsForItinerary(itinerary));
}

function maxLayoverMinutesForOffer(offer) {
  return layoverItemsForOffer(offer).reduce((max, item) => Math.max(max, item.minutes), 0);
}

function readMaxLayoverFilter() {
  const raw = controlValue("maxLayoverMinutes");
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function renderStopsSummary(offer) {
  const stops = offer?.comparisonMetrics?.totalStops ?? totalStopsCount(offer);
  if (stops === 0) {
    return '<span class="badge badge--success">Directo</span>';
  }

  const items = layoverItemsForOffer(offer);
  const toneClass = stops === 1 ? "stops-stack--warning" : "stops-stack--danger";
  const maxLayoverMinutes = items.reduce((max, item) => Math.max(max, item.minutes), 0);
  const timeText = maxLayoverMinutes > 0
    ? formatDuration(maxLayoverMinutes)
    : items.length
      ? formatDuration(items[0].minutes)
      : "Escala";
  const label = stops === 1 ? "1 escala" : `${stops} escalas`;
  const primaryCity = items[0]?.city || "Ciudad por confirmar";
  const citySummary = items.length > 1 ? `${primaryCity} +${items.length - 1}` : primaryCity;
  const metaText = `${citySummary} · ${label}`;
  const detailTitle = items.length
    ? `Escala máx.: ${timeText} | ${items.map((item) => `${item.city}: ${formatDuration(item.minutes)}`).join(" | ")}`
    : metaText;

  return `
    <div class="stops-stack ${toneClass}" title="${escapeHtml(detailTitle)}">
      <span class="stops-stack__time">${escapeHtml(timeText)}</span>
      <span class="stops-stack__meta">${escapeHtml(metaText)}</span>
    </div>
  `;
}

function getActiveClientFilters() {
  return {
    nonStop: controlChecked("nonStop"),
    baggageRequired: controlChecked("baggageRequired"),
    maxLayoverMinutes: readMaxLayoverFilter(),
  };
}

function applyClientOfferControls() {
  if (!state.searchResponse?.allOffers) return;
  const sortMode = controlValue("sortMode") || state.sortMode || "cheapest";
  let offers = getOffersForVisibleFacets(state.searchResponse.allOffers);

  const { hidden, only } = state.airlineFilter;
  offers = offers.filter((offer) => {
    const mainCarrier = offer.mainCarrier || offer.validatingCarrier || "";
    if (only !== null && mainCarrier !== only) return false;
    if (only === null && hidden.size > 0 && hidden.has(mainCarrier)) return false;
    return true;
  });

  offers.sort((left, right) => compareOffersForSortMode(left, right, sortMode));

  state.searchResponse.filteredOffers = offers;
  const groupedOffers = buildOfferGroups(offers);
  state.searchResponse.filteredOfferGroups = groupedOffers;
  const totalPages = resultsPageCount(groupedOffers.length);
  state.resultsPage = Math.min(Math.max(1, state.resultsPage), totalPages);
  const start = (state.resultsPage - 1) * RESULTS_PAGE_SIZE;
  state.searchResponse.offers = groupedOffers
    .slice(start, start + RESULTS_PAGE_SIZE)
    .flat();

  if (!state.searchResponse.offers.some((offer) => offer.id === state.selectedOfferId)) {
    state.selectedOfferId = state.searchResponse.offers[0]?.id ?? offers[0]?.id ?? null;
  }
}

function getOffersForVisibleFacets(allOffers) {
  const filters = getActiveClientFilters();
  return [...allOffers].filter((offer) => {
    const maxOfferStops = maxStopsAcrossItineraries(offer);
    if (typeof filters.maxStops === "number" && maxOfferStops > Math.max(0, filters.maxStops)) return false;
    if (filters.nonStop && maxOfferStops > 0) return false;
    if (filters.baggageRequired && !offer.baggage?.checkedIncluded) return false;
    if (typeof filters.maxLayoverMinutes === "number" && maxLayoverMinutesForOffer(offer) > filters.maxLayoverMinutes) return false;
    return true;
  });
}

function setSearchResponse(data) {
  state.searchResponse = {
    ...data,
    allOffers: data.allOffers ?? data.offers ?? [],
    offers: data.offers ?? [],
    filteredOffers: data.allOffers ?? data.offers ?? [],
  };
  applyClientOfferControls();
}

function queueSearchPoll(jobId) {
  if (!jobId) return;
  state.searchJobId = jobId;
  if (state.searchPollHandle) clearTimeout(state.searchPollHandle);
  state.searchPollHandle = setTimeout(async () => {
    try {
      const data = await getJson(`/api/search/${jobId}`);
      if (state.searchJobId !== jobId) return;
      state.request = data.request;
      setSearchResponse(data);
      requestPolledRender();
      if (!data.searchComplete) {
        queueSearchPoll(jobId);
      } else {
        stopSearchPolling();
      }
    } catch (err) {
      stopSearchPolling();
      showToast(err.message);
    }
  }, 700);
}

function queueMatrixPoll(jobId) {
  if (!jobId) return;
  state.matrixJobId = jobId;
  if (state.matrixPollHandle) clearTimeout(state.matrixPollHandle);
  state.matrixPollHandle = setTimeout(async () => {
    try {
      const data = await getJson(`/api/matrix/${jobId}`);
      if (state.matrixJobId !== jobId) return;
      state.matrixResponse = data;
      state.request = data.request;
      requestPolledRender();
      if (!data.matrixComplete) {
        queueMatrixPoll(jobId);
      } else {
        stopMatrixPolling();
      }
    } catch (err) {
      stopMatrixPolling();
      showToast(err.message);
    }
  }, 700);
}

/* ================================================================
   RENDER
   ================================================================ */

function renderToolbar() {
  const active = state.searchResponse ?? state.matrixResponse;
  if (!active) {
    if (runtimeBadge) { runtimeBadge.textContent = "IDLE"; runtimeBadge.className = "badge"; }
    if (resultPill) { resultPill.textContent = "0"; resultPill.className = "badge badge--accent"; }
    return;
  }
  const prov = active.providerMeta?.exactProvider ?? "—";
  const st = active.matrixStatus ?? active.searchMeta?.searchState ?? "—";
  if (runtimeBadge) {
    runtimeBadge.textContent = `${prov} · ${st}`;
    runtimeBadge.className = "badge badge--success";
  }
  if (resultPill) {
    resultPill.textContent = state.searchResponse
      ? `${state.searchResponse.filteredOfferGroups?.length ?? 0} ofertas`
      : `${state.matrixResponse?.cells?.length ?? 0} celdas`;
    resultPill.className = "badge badge--accent";
  }
}

function updateResultsToolbar() {
  const total = state.searchResponse?.filteredOfferGroups?.length ?? 0;
  const hasListResults = (state.searchResponse?.allOffers?.length ?? 0) > 0;
  const hasMatrix = (state.matrixResponse?.cells?.length ?? 0) > 0;
  const matrixCellCount = state.matrixResponse?.cells?.length ?? 0;
  const isSearchRunning = state.searchResponse?.searchStatus === "running";

  if (resultsPanelTitle && resultsPanelMeta) {
    if (hasMatrix) {
      resultsPanelTitle.textContent = "Calendario flexible";
      resultsPanelMeta.textContent = "Compara fechas y abre una celda para convertirla en consulta exacta.";
    } else if (state.searchResponse) {
      if (isSearchRunning) {
        resultsPanelTitle.textContent = "Cargando resultados";
        resultsPanelMeta.textContent = "Consultando Agil. La lista se irá completando mientras llegan ofertas.";
      } else if (total > 0) {
        resultsPanelTitle.textContent = "Resultados disponibles";
        resultsPanelMeta.textContent = total === 1
          ? "1 grupo listo para revisar."
          : `${total} grupos listos para revisar.`;
      } else {
        resultsPanelTitle.textContent = "Sin resultados";
        resultsPanelMeta.textContent = "No aparecieron ofertas con la combinación y filtros actuales.";
      }
    } else {
      resultsPanelTitle.textContent = "Esperando una búsqueda";
      resultsPanelMeta.textContent = "Completa origen, destino y fechas para empezar.";
    }
  }

  if (resultsCountLabel) {
    let nextCount = "";
    if (hasMatrix) {
      nextCount = `${matrixCellCount} celdas`;
    } else if (isSearchRunning) {
      nextCount = "Cargando";
    } else if (total > 0) {
      nextCount = `${total} grupos`;
    }
    resultsCountLabel.textContent = nextCount;
    resultsCountLabel.classList.toggle("hidden", !nextCount);
  }

  if (sortButtonsEl) {
    sortButtonsEl.querySelectorAll("[data-sort]").forEach(btn => {
      btn.classList.toggle("is-active", btn.dataset.sort === (state.sortMode || "cheapest"));
      btn.disabled = !hasListResults;
    });
    sortButtonsEl.classList.toggle("is-disabled", !hasListResults);
  }

  if (viewToggle) {
    viewToggle.classList.toggle("hidden", !hasMatrix);
    viewToggle.querySelectorAll("[data-view]").forEach(btn => {
      btn.classList.toggle("is-active", btn.dataset.view === state.viewMode);
    });
  }

  syncMatrixExpandedUI();
}

function renderResults() {
  if (!resultsContainer) return;
  captureResultsScroll(resultsContainer);
  const offers = state.searchResponse?.offers ?? [];
  const total = state.searchResponse?.filteredOfferGroups?.length
    ?? buildOfferGroups(state.searchResponse?.filteredOffers ?? state.searchResponse?.allOffers ?? offers).length;
  const totalPages = resultsPageCount(total);
  const isRunning = state.searchResponse?.searchStatus === "running";

  if (offers.length === 0 && !isRunning) {
    resultsContainer.innerHTML = renderEmptyPanel({
      title: "Sin resultados con estos filtros",
      text: "No aparecieron ofertas para la combinación actual.",
      hint: "Prueba quitando Directo, Equipaje o Escala para ampliar el rango.",
      icon: "ico-route",
    });
    return;
  }

  if (offers.length === 0 && isRunning) {
    renderResultsSkeleton();
    return;
  }

  let html = "";
  if (isRunning) {
    html += '<div class="results-loading"><span>Consultando Agil. El listado sigue cargando.</span></div>';
  }

  html += '<div class="table-wrap"><table class="results-table"><thead><tr>';
  html += '<th>Aerolínea</th>';
  html += '<th>Fechas</th>';
  html += '<th>Duración</th>';
  html += '<th>Escalas</th>';
  html += '<th>Equipaje</th>';
  html += '<th class="results-price">Precio</th>';
  html += '<th>Agil</th>';
  html += '</tr></thead><tbody>';

  buildOfferGroups(offers).forEach((group) => {
    const o = group.find(g => g.id === state.selectedOfferId) ?? group[0];
    const agilPath = o.purchasePaths?.find((p) => p.provider === "agil-local" && p.url);
    const dateSummary = buildGroupDateSummary(group, state.selectedOfferId);
    const isActive = group.some(g => g.id === state.selectedOfferId);
    const badge = group.length > 1
      ? ` <span class="badge badge--accent badge--group-count" title="${group.length} fechas equivalentes">${group.length}</span>`
      : "";
    const bagCarry = o.baggage?.carryOnIncluded ? "✓" : "—";
    const bagCheck = o.baggage?.checkedIncluded ? "✓" : "—";
    const carrier = carrierDisplayParts(o);

    html += `<tr data-oid="${o.id}" class="${isActive ? "is-active" : ""}">`;
    html += `<td><span class="cell-main carrier-label" title="${escapeHtml(carrier.display)}">${escapeHtml(carrier.display)}</span></td>`;
    html += `<td title="${escapeHtml(dateSummary.title)}"><div class="results-date-stack"><span class="cell-main">${escapeHtml(dateSummary.primary)}${badge}</span>${dateSummary.secondary ? `<span class="cell-sub">${escapeHtml(dateSummary.secondary)}</span>` : ""}</div></td>`;
    html += `<td>${formatDuration(o.comparisonMetrics?.totalDurationMinutes)}</td>`;
    html += `<td>${renderStopsSummary(o)}</td>`;
    html += `<td class="cell-sub">${bagCarry} / ${bagCheck}</td>`;
    html += `<td class="results-price">${formatMoney(o.price?.total)}</td>`;
    html += `<td>${agilPath ? `<a href="${agilPath.url}" target="_blank" rel="noreferrer" class="row-link" data-stop-row="1">Agil</a>` : '<span class="cell-sub">—</span>'}</td>`;
    html += `</tr>`;
  });

  html += '</tbody></table></div>';

  // Pagination
  html += `<div class="results-pager">`;
  html += `<button type="button" class="btn btn--secondary btn--sm" data-results-page="prev" ${state.resultsPage <= 1 ? "disabled" : ""}>← Anterior</button>`;
  html += `<span class="results-pager__label">Página ${state.resultsPage} de ${totalPages}</span>`;
  html += `<button type="button" class="btn btn--secondary btn--sm" data-results-page="next" ${state.resultsPage >= totalPages ? "disabled" : ""}>Siguiente →</button>`;
  html += `</div>`;

  resultsContainer.innerHTML = html;
  const resultsWrap = resultsContainer.querySelector(".table-wrap");
  syncResultsScroll(resultsWrap);
  requestAnimationFrame(() => syncResultsScroll(resultsWrap));
  resultsWrap?.addEventListener("scroll", handleResultsScroll, { passive: true });
  resultsWrap?.addEventListener("wheel", markPollingUiInteraction, { passive: true });
  resultsWrap?.addEventListener("pointerdown", () => {
    state.pollPointerDown = true;
    markPollingUiInteraction();
  });
}

function handleResultsClick(e) {
  const pager = e.target.closest("[data-results-page]");
  if (pager) {
    const total = state.searchResponse?.filteredOfferGroups?.length ?? 0;
    const totalPages = resultsPageCount(total);
    state.resultsScroll = { top: 0, left: 0 };
    if (pager.dataset.resultsPage === "prev") {
      state.resultsPage = Math.max(1, state.resultsPage - 1);
    } else if (pager.dataset.resultsPage === "next") {
      state.resultsPage = Math.min(totalPages, state.resultsPage + 1);
    }
    applyClientOfferControls();
    renderResultsArea();
    renderDetailPanel();
    return;
  }

  if (e.target.closest("[data-stop-row]")) return;
  const row = e.target.closest("tr[data-oid]");
  if (!row) return;
  state.selectedOfferId = row.dataset.oid;
  renderResultsArea();
  renderDetailPanel();
}

async function handleMatrixClick(e) {
  const cells = state.matrixResponse?.cells ?? [];
  const btn = e.target.closest("[data-mk]");
  if (!btn) {
    return;
  }

  const cell = cells.find((entry) => entry.key === btn.dataset.mk);
  if (!cell?.selectable || !cell.derivedRequest) return;
  submitButton.disabled = true;
  state.selectedMatrixKey = btn.dataset.mk;
  state.matrixExpanded = false;
  try {
    stopMatrixPolling();
    stopSearchPolling();
    state.request = cell.derivedRequest;
    state.matrixResponse = null;
    state.viewMode = "list";
    state.quotationText = "";
    state.airlineFilter.hidden.clear();
    state.airlineFilter.only = null;
    state.detailPendingAction = null;
    state.resultsScroll = { top: 0, left: 0 };
    setSearchResponse(buildPendingSearchResponse(cell.derivedRequest, state.sortMode));
    renderAll();

    const data = await postJson("/api/search", { request: cell.derivedRequest, sortMode: state.sortMode });
    state.request = data.request;
    state.selectedMatrixKey = null;
    setSearchResponse(data);
    state.searchJobId = data.searchJobId ?? null;
    if (!data.searchComplete && state.searchJobId) {
      queueSearchPoll(state.searchJobId);
    }
    renderAll();
  } catch (err) { showToast(err.message); }
  finally { submitButton.disabled = false; }
}

function confidenceColor(c) {
  if (c === "validated") return "green";
  if (c === "live" || c === "indicative") return "amber";
  return "red";
}

function getMatrixPriceStats(cells) {
  const amounts = (cells || [])
    .map((cell) => cell.price?.amount)
    .filter((amount) => typeof amount === "number");

  if (amounts.length === 0) {
    return null;
  }

  return {
    min: Math.min(...amounts),
    max: Math.max(...amounts),
  };
}

function matrixToneClass(cell, stats) {
  if (!cell?.price || !stats) return "";
  if (cell.price.amount === stats.min) return "matrix-cell--best";
  if (stats.max === stats.min) return "matrix-cell--good";

  const ratio = (cell.price.amount - stats.min) / (stats.max - stats.min);
  if (ratio <= 0.2) return "matrix-cell--good";
  if (ratio <= 0.45) return "matrix-cell--ok";
  if (ratio <= 0.7) return "matrix-cell--warm";
  return "matrix-cell--bad";
}

/* ================================================================
   AIRLINES BAR
   ================================================================ */

function buildAirlineList(allOffers) {
  const map = new Map();
  for (const offer of allOffers) {
    const carrier = carrierDisplayParts(offer);
    const code = carrier.code || "?";
    if (!map.has(code)) map.set(code, { code, display: carrier.display, count: 0, minPrice: Infinity, currency: "" });
    const entry = map.get(code);
    entry.count++;
    if (!entry.display && carrier.display) entry.display = carrier.display;
    const amt = offer.price?.total?.amount;
    if (typeof amt === "number" && amt < entry.minPrice) {
      entry.minPrice = amt;
      entry.currency = offer.price?.total?.currencyCode ?? "";
    }
  }
  return [...map.values()].sort((a, b) => {
    const leftPrice = Number.isFinite(a.minPrice) ? a.minPrice : Number.MAX_SAFE_INTEGER;
    const rightPrice = Number.isFinite(b.minPrice) ? b.minPrice : Number.MAX_SAFE_INTEGER;
    if (leftPrice !== rightPrice) return leftPrice - rightPrice;
    if (b.count !== a.count) return b.count - a.count;
    return String(a.display || a.code).localeCompare(String(b.display || b.code), "es");
  });
}

function renderAirlineBar() {
  if (!airlineBar) return;
  const allOffers = state.searchResponse?.allOffers;
  const offersForFacets = allOffers?.length ? getOffersForVisibleFacets(allOffers) : [];

  if (!offersForFacets.length) {
    airlineBar.classList.add("hidden");
    airlineBar.innerHTML = "";
    return;
  }

  const airlines = buildAirlineList(offersForFacets);
  if (airlines.length <= 1) {
    airlineBar.classList.add("hidden");
    airlineBar.innerHTML = "";
    return;
  }

  const activeCode = state.airlineFilter.only;
  airlineBar.classList.remove("hidden");
  airlineBar.innerHTML = `
    <div class="airline-bar__header">
      <span class="airline-bar__label">Aerolíneas</span>
      <span class="airline-bar__hint">Ordenadas por mejor tarifa</span>
    </div>
    <div class="airline-bar__scroller" role="group" aria-label="Filtrar por aerolínea">
      <button type="button" class="airline-chip ${activeCode === null ? "is-active" : ""}" data-airline-all="1">
        <span class="airline-chip__name">Todas</span>
        <span class="airline-chip__meta">${offersForFacets.length} opciones</span>
      </button>
      ${airlines.map((airline) => {
        const priceStr = airline.minPrice < Infinity ? `${airline.currency} ${numFmt.format(airline.minPrice)}` : "Precio pendiente";
        return `
          <button
            type="button"
            class="airline-chip ${activeCode === airline.code ? "is-active" : ""}"
            data-airline-code="${airline.code}"
            title="${escapeHtml(airline.display)}"
          >
            <span class="airline-chip__name">${escapeHtml(airline.display)}</span>
            <span class="airline-chip__meta">${priceStr} · ${airline.count}</span>
          </button>
        `;
      }).join("")}
    </div>
  `;

  airlineBar.querySelector("[data-airline-all]")?.addEventListener("click", () => {
    state.airlineFilter.hidden.clear();
    state.airlineFilter.only = null;
    state.resultsPage = 1;
    state.resultsScroll = { top: 0, left: 0 };
    applyClientOfferControls();
    renderAll();
  });

  airlineBar.querySelectorAll("[data-airline-code]").forEach((button) => {
    button.addEventListener("click", () => {
      const code = button.dataset.airlineCode;
      state.airlineFilter.hidden.clear();
      state.airlineFilter.only = state.airlineFilter.only === code ? null : code;
      state.resultsPage = 1;
      state.resultsScroll = { top: 0, left: 0 };
      applyClientOfferControls();
      renderAll();
    });
  });
}

/* ================================================================
   CALENDAR VIEW (was renderMatrix)
   ================================================================ */

function renderCalendarView(container = resultsContainer) {
  if (!container) return;
  captureMatrixScroll(container);
  const cells = state.matrixResponse?.cells;
  if (!cells || cells.length === 0) {
    container.innerHTML = renderEmptyPanel({
      eyebrow: "Calendario",
      title: "Sin datos disponibles",
      text: "Esta vista todavía no tiene celdas para mostrar.",
      hint: "Ajusta las fechas o lanza una búsqueda exacta para seguir.",
      icon: "ico-calendar",
    });
    return;
  }

  const returns = state.matrixResponse.axes.returnDates;
  const departures = state.matrixResponse.axes.departureDates;
  const isOneWay = state.request?.tripType === "one-way";
  const priceStats = getMatrixPriceStats(cells);
  const isRunning = state.matrixResponse?.matrixStatus === "running";

  let html = "";
  if (isRunning) {
    html += '<div class="results-loading"><span>Cargando precios del calendario...</span></div>';
  }

  html += '<div class="matrix-wrap"><div class="matrix-grid cal-grid">';

  if (isOneWay) {
    html += `<div class="matrix-row cal-row" style="--cols:${departures.length}"><div class="matrix-corner cal-corner">IDA</div>${departures.map(d => `<div class="matrix-header cal-header">${d.slice(5)}</div>`).join("")}</div>`;
    html += `<div class="matrix-row cal-row" style="--cols:${departures.length}"><div class="matrix-label cal-label">Precio</div>`;
    departures.forEach(dep => {
      const cell = cells.find(c => c.departureDate === dep);
      if (!cell) { html += '<button class="matrix-cell cal-cell" disabled type="button">—</button>'; return; }
      const isLoading = cell.confidence === "loading";
      const toneClass = matrixToneClass(cell, priceStats);
      const calTone = toneClass.replace("matrix-cell--", "cal-cell--");
      html += `<button class="matrix-cell cal-cell ${cell.key === state.selectedMatrixKey ? "is-active" : ""} ${isLoading ? "is-loading" : ""} ${toneClass} ${calTone}" type="button" ${!cell.selectable ? "disabled" : ""} data-mk="${cell.key}" title="${escapeHtml(cell.tooltip ?? "")}">`;
      html += `<div class="matrix-price cal-price ${isLoading ? "matrix-price--loading" : ""}">${isLoading ? "..." : cell.price ? formatMoney(cell.price) : "—"}</div>`;
      html += `<div class="matrix-meta cal-meta">${isLoading ? "cargando" : cell.stateCode ?? ""}</div></button>`;
    });
    html += '</div>';
  } else {
    html += `<div class="matrix-row cal-row" style="--cols:${returns.length}"><div class="matrix-corner cal-corner">S\\R</div>${returns.map(d => `<div class="matrix-header cal-header">${d.slice(5)}</div>`).join("")}</div>`;
    departures.forEach(dep => {
      html += `<div class="matrix-row cal-row" style="--cols:${returns.length}"><div class="matrix-label cal-label">${dep.slice(5)}</div>`;
      returns.forEach(ret => {
        const cell = cells.find(c => c.departureDate === dep && c.returnDate === ret);
        if (!cell) { html += '<button class="matrix-cell cal-cell" disabled type="button">—</button>'; return; }
        const isLoading = cell.confidence === "loading";
        const toneClass = matrixToneClass(cell, priceStats);
        const calTone = toneClass.replace("matrix-cell--", "cal-cell--");
        html += `<button class="matrix-cell cal-cell ${cell.key === state.selectedMatrixKey ? "is-active" : ""} ${isLoading ? "is-loading" : ""} ${toneClass} ${calTone}" type="button" ${!cell.selectable ? "disabled" : ""} data-mk="${cell.key}" title="${escapeHtml(cell.tooltip ?? "")}">`;
        html += `<div class="matrix-price cal-price ${isLoading ? "matrix-price--loading" : ""}">${isLoading ? "..." : cell.price ? formatMoney(cell.price) : "—"}</div>`;
        html += `<div class="matrix-meta cal-meta">${isLoading ? "cargando" : cell.stateCode ?? ""} ${cell.stayNights != null ? cell.stayNights + "n" : ""}</div></button>`;
      });
      html += '</div>';
    });
  }

  html += '</div></div>';
  container.innerHTML = html;
  const matrixWrap = container.querySelector(".matrix-wrap");
  syncMatrixScroll(matrixWrap);
  requestAnimationFrame(() => syncMatrixScroll(matrixWrap));
  matrixWrap?.addEventListener("scroll", handleMatrixScroll, { passive: true });

  // Re-attach matrix click handler on the container
  container.querySelectorAll("[data-mk]").forEach(btn => {
    btn.addEventListener("click", handleMatrixClick);
  });
}

/* ================================================================
   RESULTS AREA DISPATCHER
   ================================================================ */

function renderResultsArea() {
  const hasMatrix = state.viewMode === "calendar" && state.matrixResponse?.cells?.length > 0;
  if (!hasMatrix && state.matrixExpanded) {
    closeMatrixExpanded({ rerender: false });
  }

  if (hasMatrix) {
    renderCalendarView(state.matrixExpanded ? matrixFullscreenBody : resultsContainer);
  } else if (state.searchResponse?.offers) {
    renderResults();
  }
  // If neither, the empty state from HTML is already showing
}

/* ================================================================
   DETAIL PANEL
   ================================================================ */

function openDetailPanel() {
  if (detailPanel) detailPanel.classList.add("is-open");
}

function closeDetailPanel() {
  if (detailPanel) detailPanel.classList.remove("is-open");
}

function renderDetailPanel() {
  const offer = selOffer();
  if (repriceButton) repriceButton.disabled = !offer;
  if (quotationButton) quotationButton.disabled = !offer;

  if (!offer) {
    closeDetailPanel();
    if (detailContent) {
      detailContent.innerHTML = renderEmptyPanel({
        wrapperClass: "detail-empty",
        eyebrow: "Oferta",
        title: "Ninguna oferta seleccionada",
        text: "Aquí verás tarifa, tramos, equipaje y accesos de compra.",
        hint: "Selecciona una fila o una celda del calendario para poblar el panel.",
        icon: "ico-clipboard",
      });
    }
    return;
  }
  openDetailPanel();

  if (state.detailPendingAction) {
    const copy = detailActionCopy(state.detailPendingAction);
    const amount = formatMoney(offer.price?.total);
    const carrier = carrierDisplayParts(offer);
    const summary = `${escapeHtml(offer.origin)} → ${escapeHtml(offer.destination)} · ${escapeHtml(carrier.display)}`;
    if (detailContent) {
      detailContent.innerHTML = `
        <div class="detail-busy" aria-live="polite" aria-busy="true">
          <div class="detail-hero">${amount}</div>
          <div class="detail-summary">${summary}</div>
          <div class="detail-section">
            <div class="detail-section__title">${copy.eyebrow}</div>
            <p class="detail-busy__text">${copy.text}</p>
            <div class="detail-busy__stack" aria-hidden="true">
              <span class="skeleton-line skeleton-line--hero"></span>
              <span class="skeleton-line skeleton-line--lg"></span>
              <span class="skeleton-line skeleton-line--md"></span>
              <span class="skeleton-line skeleton-line--sm"></span>
            </div>
          </div>
        </div>
      `;
    }
    return;
  }

  const flights = offer.itineraries?.flatMap((it) => it.segments.map((s) => s.flightNumber)).join(", ") || "—";
  const group = getGroupForOffer(offer.id) ?? [offer];
  const outbound = offer.itineraries?.find(it => it.direction === "outbound") ?? offer.itineraries?.[0];
  const carrier = carrierDisplayParts(offer);

  let h = "";

  // Hero price
  h += `<div class="detail-hero">${formatMoney(offer.price?.total)}</div>`;
  h += `<div class="detail-summary">${escapeHtml(offer.origin)} → ${escapeHtml(offer.destination)} · ${escapeHtml(carrier.display)} · ${formatDuration(offer.comparisonMetrics?.totalDurationMinutes)} · ${offer.comparisonMetrics?.totalStops ?? 0} esc</div>`;

  // Confidence badge
  h += `<div><span class="badge badge--${confidenceColor(offer.priceConfidence)}">${offer.priceConfidence === "validated" ? "Precio validado" : "Precio live"}</span></div>`;

  // Segments
  h += '<div class="detail-section"><div class="detail-section__title">Segmentos</div>';

  if (outbound) {
    h += `<div class="detail-segment"><div class="detail-segment__dir">Ida — ${formatDuration(outbound.durationMinutes)}, ${outbound.stops} esc</div>`;
    outbound.segments?.forEach(s => {
      h += `<div class="detail-segment__leg"><div class="detail-segment__flight">${escapeHtml(s.flightNumber)}</div><div class="detail-segment__times">${escapeHtml(s.origin)} ${formatDT(s.departureAt)} → ${escapeHtml(s.destination)} ${formatDT(s.arrivalAt)}</div></div>`;
    });
    h += '</div>';
  }

  if (group.length > 1) {
    h += `<div class="detail-segment"><div class="detail-segment__dir">Fechas equivalentes — ${group.length} variantes</div>`;
    group.forEach((member) => {
      const isSelected = member.id === state.selectedOfferId;
      const label = buildOfferVariantSummary(member);
      h += `<div class="detail-segment__leg detail-segment__leg--choice ${isSelected ? "is-selected" : ""}" data-inbound-id="${member.id}" title="${escapeHtml(label)}">${escapeHtml(label)}</div>`;
    });
    h += '</div>';
  } else {
    offer.itineraries?.filter(it => it !== outbound).forEach(it => {
      h += `<div class="detail-segment"><div class="detail-segment__dir">${escapeHtml(it.direction)} — ${formatDuration(it.durationMinutes)}, ${it.stops} esc</div>`;
      it.segments?.forEach(s => {
        h += `<div class="detail-segment__leg"><div class="detail-segment__flight">${escapeHtml(s.flightNumber)}</div><div class="detail-segment__times">${escapeHtml(s.origin)} ${formatDT(s.departureAt)} → ${escapeHtml(s.destination)} ${formatDT(s.arrivalAt)}</div></div>`;
      });
      h += '</div>';
    });
  }
  h += '</div>';

  // Baggage
  h += '<div class="detail-section"><div class="detail-section__title">Equipaje</div>';
  h += `<div class="detail-pair"><span class="detail-pair__key">Carry-on</span><span class="detail-pair__val">${offer.baggage?.carryOnIncluded ? "✓ Incluido" : "— No incluido"}</span></div>`;
  h += `<div class="detail-pair"><span class="detail-pair__key">Bodega</span><span class="detail-pair__val">${offer.baggage?.checkedIncluded ? `✓ ${offer.baggage.checkedBags ?? 1}x${offer.baggage.description ?? ""}` : "— No incluido"}</span></div>`;
  h += '</div>';

  // Fare
  h += '<div class="detail-section"><div class="detail-section__title">Tarifa</div>';
  if (offer.price?.base) h += `<div class="detail-pair"><span class="detail-pair__key">Base</span><span class="detail-pair__val">${formatMoney(offer.price.base)}</span></div>`;
  if (offer.price?.taxes) h += `<div class="detail-pair"><span class="detail-pair__key">Tasas</span><span class="detail-pair__val">${formatMoney(offer.price.taxes)}</span></div>`;
  if (offer.fareMeta?.lastTicketingDate) h += `<div class="detail-pair"><span class="detail-pair__key">Emision limite</span><span class="detail-pair__val">${offer.fareMeta.lastTicketingDate}</span></div>`;
  h += '</div>';

  // Purchase paths
  const paths = offer.purchasePaths?.filter(p => p.url) ?? [];
  if (paths.length > 0) {
    h += '<div class="detail-section"><div class="detail-section__title">Compra</div>';
    paths.forEach(p => {
      h += `<div class="detail-pair"><span class="detail-pair__key">${escapeHtml(p.label)}</span>`;
      h += `<a href="${p.url}" target="_blank" rel="noreferrer" class="btn btn--ghost btn--sm">${escapeHtml(p.type === "manual-reference" ? "Ref" : "Abrir")}</a></div>`;
    });
    h += '</div>';
  }

  // Quotation
  if (state.quotationText) {
    h += '<div class="detail-section"><div class="detail-section__title">Cotizacion</div>';
    h += `<textarea class="quote-textarea" readonly>${escapeHtml(state.quotationText)}</textarea>`;
    h += '</div>';
  }

  if (detailContent) detailContent.innerHTML = h;

  // Inbound option click
  detailContent?.querySelectorAll("[data-inbound-id]").forEach(el => {
    el.addEventListener("click", () => {
      state.selectedOfferId = el.dataset.inboundId;
      renderResultsArea();
      renderDetailPanel();
    });
  });
}

/* ================================================================
   RENDER ALL
   ================================================================ */

function renderAll() {
  if (state.pollRenderHandle) {
    clearTimeout(state.pollRenderHandle);
    state.pollRenderHandle = null;
  }
  state.pollRenderPending = false;
  renderToolbar();
  renderAirlineBar();
  renderResultsArea();
  renderDetailPanel();
  updateResultsToolbar();
  syncWorkspaceViewportHeight();
}

function syncWorkspaceViewportHeight() {
  if (!workspace) return;
  const top = workspace.getBoundingClientRect().top;
  const available = Math.max(0, Math.floor(window.innerHeight - top));
  workspace.style.setProperty("--workspace-height", `${available}px`);
}

/* ================================================================
   EVENTS
   ================================================================ */

// Block Enter-to-submit from any field that is not the submit button itself
// Ctrl+Enter triggers search from any field
searchForm.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.ctrlKey) {
    e.preventDefault();
    searchForm.requestSubmit();
    return;
  }
  if (e.key === "Enter" && e.target !== submitButton) {
    e.preventDefault();
  }
});

searchMode.addEventListener("change", () => {
  state.flexMode = searchMode.value !== "exact";
  updateModeFields();
});
tripType.addEventListener("change", updateModeFields);

// Sort buttons in toolbar
sortButtonsEl?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-sort]");
  if (!btn) return;
  state.sortMode = btn.dataset.sort;
  sortMode.value = btn.dataset.sort; // sync hidden select
  state.resultsPage = 1;
  state.resultsScroll = { top: 0, left: 0 };
  applyClientOfferControls();
  renderAll();
});

// View toggle
viewToggle?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-view]");
  if (!btn) return;
  state.viewMode = btn.dataset.view;
  renderResultsArea();
  updateResultsToolbar();
});

matrixExpandBtn?.addEventListener("click", () => {
  if (state.matrixExpanded) closeMatrixExpanded();
  else openMatrixExpanded();
});

matrixFullscreenClose?.addEventListener("click", () => {
  closeMatrixExpanded();
});

matrixFullscreenBackdrop?.addEventListener("click", () => {
  closeMatrixExpanded();
});

copySearchConfigBtn?.addEventListener("click", async () => {
  await copySearchConfiguration();
});

pasteSearchConfigBtn?.addEventListener("click", async () => {
  await pasteSearchConfiguration();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !layoverPopover?.classList.contains("hidden")) {
    closeLayoverPopover();
    return;
  }
  if (e.key === "Escape" && !calendarPopover?.classList.contains("hidden")) {
    closeCalendarPopover();
    return;
  }
  if (e.key === "Escape" && state.matrixExpanded) {
    closeMatrixExpanded();
    return;
  }
  if (e.key === "Escape" && detailPanel?.classList.contains("is-open")) {
    state.selectedOfferId = null;
    closeDetailPanel();
    renderResultsArea();
  }
});

// Results container click delegation (set up once)
resultsContainer?.addEventListener("click", handleResultsClick);
resultsContainer?.addEventListener("pointerdown", () => {
  state.pollPointerDown = true;
  markPollingUiInteraction();
});
resultsContainer?.addEventListener("wheel", markPollingUiInteraction, { passive: true });
matrixFullscreenBody?.addEventListener("pointerdown", () => {
  state.pollPointerDown = true;
  markPollingUiInteraction();
});
matrixFullscreenBody?.addEventListener("wheel", markPollingUiInteraction, { passive: true });
document.addEventListener("pointerup", () => {
  if (!state.pollPointerDown) return;
  state.pollPointerDown = false;
  markPollingUiInteraction();
  if (state.pollRenderPending) scheduleDeferredPollRender();
});
document.addEventListener("pointercancel", () => {
  if (!state.pollPointerDown) return;
  state.pollPointerDown = false;
  markPollingUiInteraction();
  if (state.pollRenderPending) scheduleDeferredPollRender();
});

["sortMode", "nonStop", "baggageRequired", "maxLayoverMinutes"].forEach((id) => {
  control(id)?.addEventListener("change", async () => {
    if (!state.searchResponse?.allOffers) return;
    state.sortMode = controlValue("sortMode") || state.sortMode;
    state.resultsPage = 1;
    state.resultsScroll = { top: 0, left: 0 };
    applyClientOfferControls();
    renderAll();
  });
});

searchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideLocationMenu("origin");
  hideLocationMenu("destination");
  paxPopover?.classList.add("hidden");
  closeLayoverPopover();
  closeCalendarPopover();
  const errs = validateForm();
  showErrors(errs);
  if (errs.length > 0) return;

  submitButton.disabled = true;
  try {
    const payload = getFormPayload();
    const translatedPayload = translateFlexibleDates(payload);
    stopMatrixPolling();
    stopSearchPolling();
    state.sortMode = translatedPayload.sortMode;
    state.resultsPage = 1;
    state.quotationText = "";
    state.selectedMatrixKey = null;
    state.detailPendingAction = null;
    state.airlineFilter.hidden.clear();
    state.airlineFilter.only = null;
    state.resultsScroll = { top: 0, left: 0 };

    if (translatedPayload.request.searchMode === "roundtrip-grid") {
      stopSearchPolling();
      state.searchResponse = null;
      state.selectedOfferId = null;
      state.matrixExpanded = false;
      state.matrixScroll = { top: 0, left: 0 };
      state.request = translatedPayload.request;
      state.matrixResponse = buildPendingMatrixResponse(translatedPayload.request);
      state.viewMode = "calendar";
      renderAll();

      const matrixJob = await postJson("/api/matrix", translatedPayload);
      state.matrixResponse = matrixJob;
      state.request = matrixJob.request;
      state.searchResponse = null;
      state.matrixJobId = matrixJob.matrixJobId ?? null;
      if (!matrixJob.matrixComplete && state.matrixJobId) {
        queueMatrixPoll(state.matrixJobId);
      }
    } else {
      state.matrixExpanded = false;
      state.matrixResponse = null;
      state.request = translatedPayload.request;
      state.viewMode = "list";
      setSearchResponse(buildPendingSearchResponse(translatedPayload.request, translatedPayload.sortMode));
      renderAll();

      const data = await postJson("/api/search", translatedPayload);
      state.request = data.request;
      setSearchResponse(data);
      state.searchJobId = data.searchJobId ?? null;
      if (!data.searchComplete && state.searchJobId) {
        queueSearchPoll(state.searchJobId);
      }
    }
    renderAll();
  } catch (err) { showToast(err.message); }
  finally { submitButton.disabled = false; }
});

repriceButton.addEventListener("click", async () => {
  const offer = selOffer();
  const sid = sessionId();
  if (!offer || !sid) return;
  repriceButton.disabled = true;
  state.detailPendingAction = "reprice";
  renderDetailPanel();
  try {
    const data = await postJson("/api/reprice", { searchSessionId: sid, offerId: offer.id });
    state.searchResponse.allOffers = state.searchResponse.allOffers.map((o) => o.id === data.offer.id ? data.offer : o);
    applyClientOfferControls();
    state.quotationText = "";
    renderAll();
  } catch (err) { showToast(err.message); }
  finally {
    state.detailPendingAction = null;
    repriceButton.disabled = false;
    renderDetailPanel();
  }
});

quotationButton.addEventListener("click", async () => {
  const offer = selOffer();
  const sid = sessionId();
  if (!offer || !sid) return;
  quotationButton.disabled = true;
  state.detailPendingAction = "quotation";
  renderDetailPanel();
  try {
    const data = await postJson("/api/quotation", { searchSessionId: sid, offerId: offer.id });
    state.searchResponse.allOffers = state.searchResponse.allOffers.map((o) => o.id === data.offer.id ? data.offer : o);
    applyClientOfferControls();
    state.quotationText = data.plainText;
    renderAll();
    const copied = await writeClipboardText(data.plainText);
    showToast(
      copied
        ? "Cotizacion copiada al portapapeles."
        : "Cotizacion lista. No pude copiarla al portapapeles.",
      copied ? "success" : "error",
    );
  } catch (err) { showToast(err.message); }
  finally {
    state.detailPendingAction = null;
    quotationButton.disabled = false;
    renderDetailPanel();
  }
});

/* ================================================================
   INIT
   ================================================================ */

// Swap route button
const swapRouteBtn = $("swapRouteBtn");
if (swapRouteBtn) {
  swapRouteBtn.addEventListener("click", () => {
    const originInput = $("origin");
    const destInput = $("destination");
    if (!originInput || !destInput) return;

    const tmpVal = originInput.value;
    const tmpCode = originInput.dataset.code;
    const tmpLabel = originInput.dataset.label;

    originInput.value = destInput.value;
    originInput.dataset.code = destInput.dataset.code || "";
    originInput.dataset.label = destInput.dataset.label || "";

    destInput.value = tmpVal;
    destInput.dataset.code = tmpCode || "";
    destInput.dataset.label = tmpLabel || "";
  });
}

function resetSearchFormDefaults() {
  searchForm.reset();
  clearResolvedLocation("origin", false);
  clearResolvedLocation("destination", false);
  hideLocationMenu("origin");
  hideLocationMenu("destination");
  const ids = ["departureDate", "returnDate", "departureStart", "departureEnd", "returnStart", "returnEnd"];
  ids.forEach((id) => {
    const el = $(id);
    if (el) el.value = "";
  });
}

setupInputEnforcement();
setupLocationAutocomplete("origin");
setupLocationAutocomplete("destination");
setupPaxPopover();
setupLayoverPopover();
setupThemeToggle();
setupTripTypeToggle();
setupModeToggle();
setupCalendarPopover();
updatePaxLabel();
updateModeFields();
window.addEventListener("resize", () => {
  syncVisibleLocationMenus();
  syncPaxPopoverPosition();
  syncLayoverPopoverPosition();
  syncCalendarPopoverPosition();
  syncWorkspaceViewportHeight();
  syncSearchShellLayoutMetrics();
});
window.addEventListener("scroll", () => {
  syncVisibleLocationMenus();
  syncPaxPopoverPosition();
  syncLayoverPopoverPosition();
  syncCalendarPopoverPosition();
}, true);
window.addEventListener("storage", (event) => {
  if (event.key === SEARCH_CONFIG_CLIPBOARD_KEY) syncSearchClipboardUI();
});
syncSearchClipboardUI();
renderAll();
settleInitialShellLayout();
releaseInitialUiBootState();
