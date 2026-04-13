import { bootstrapAppShell } from "./app/bootstrap.js";
import {
  addDaysIso,
  createSearchDateHelpers,
  diffDaysIso,
  enumerateRoundTripFlexibleAxes,
  enumerateIsoRange,
  enumerateUsefulRoundTripPairs,
  resolveExactStayNights,
  resolveRoundTripFlexibleMode,
} from "./app/date.js";
import { getJson, postJson, scheduleJsonPoll } from "./app/network.js";
import { renderAll as renderShell, syncWorkspaceViewportHeight as syncWorkspaceViewportHeightBase } from "./app/render.js";
import {
  $,
  airlineBar,
  autocompleteState,
  calendarClose,
  calendarClear,
  calendarDone,
  calendarFlexModeControl,
  calendarMonths,
  calendarNext,
  calendarPopover,
  calendarPrev,
  calendarSelectionSummary,
  calendarState,
  calendarStayConfig,
  calendarTitle,
  copySearchConfigBtn,
  dateTrigger,
  dateTriggerText,
  DEFAULT_CURRENCY_CODE,
  detailContent,
  detailPanel,
  emptyState,
  flexibleMode,
  LAYOVER_TIME_OPTIONS,
  layoverFilter,
  layoverPopover,
  layoverTrigger,
  layoverTriggerValue,
  matrixExpandBtn,
  matrixFullscreen,
  matrixFullscreenBackdrop,
  matrixFullscreenBody,
  matrixFullscreenClose,
  matrixFullscreenMeta,
  migrationBtn,
  pasteSearchConfigBtn,
  paxAdultsDisplay,
  paxChildrenDisplay,
  paxInfantsDisplay,
  paxLabel,
  paxPopover,
  paxTrigger,
  POLL_RENDER_IDLE_MS,
  quotationButton,
  resultPill,
  resultsContainer,
  resultsPanelMeta,
  resultsPanelTitle,
  resultsPagerEl,
  resultsToolbar,
  RESULTS_MAX_PAGES,
  RESULTS_PAGE_SIZE,
  rootEl,
  runtimeBadge,
  runtimeSearchDatePolicy,
  SEARCH_CONFIG_CLIPBOARD_KEY,
  SEARCH_CONFIG_CLIPBOARD_TYPE,
  SEARCH_CONFIG_CLIPBOARD_VERSION,
  SEARCH_DATE_DEFAULT_MAX_FUTURE_DAYS,
  searchForm,
  searchMode,
  sortButtonsEl,
  sortMode,
  state,
  stayNightsEl,
  submitButton,
  swapRouteBtn,
  themeButtons,
  THEME_STORAGE_KEY,
  toastContainer,
  tripType,
  validationBox,
  viewToggle,
  workspace,
} from "./app/runtime.js";

/* ================================================================
   Flight Desk — front-end
   ================================================================ */

const numFmt = new Intl.NumberFormat("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const {
  todayISO,
  minDateISO,
  maxDateISO,
  isValidIsoDate,
  allowedDateWindowText,
} = createSearchDateHelpers({
  runtimeSearchDatePolicy,
  maxFutureDaysDefault: SEARCH_DATE_DEFAULT_MAX_FUTURE_DAYS,
  formatDateCompact,
});

function providerIdFromRequest(request) {
  return request?.providerId === "costamar" ? "costamar" : "agil-local";
}

function providerLabel(providerId) {
  return providerId === "costamar" ? "Costamar" : "Agil";
}

function defaultProviderIds(request) {
  return request?.providerId ? [providerIdFromRequest(request)] : ["agil-local", "costamar"];
}

function matrixDerivedSearchRequest(request) {
  if (!request) {
    return request;
  }

  const providerIds = state.matrixResponse?.searchMeta?.providersUsed;
  if (Array.isArray(providerIds) && providerIds.length > 1 && request?.providerId) {
    return {
      ...request,
      providerId: undefined,
    };
  }

  return request;
}

function providerLabelList(providerIds) {
  return (providerIds || []).map(providerLabel).join(" + ");
}

function providerLoadingCopy(providerIds) {
  return `Consultando ${providerLabelList(providerIds)}...`;
}

function providerSearchWarnings(response) {
  return [
    ...(response?.warnings ?? []),
    ...(response?.searchMeta?.warnings ?? []),
  ];
}

function normalizedWarningMessage(warning) {
  return String(warning || "").trim().toLowerCase();
}

function classifyProviderWarning(providerId, warning) {
  const normalized = normalizedWarningMessage(warning);
  if (!normalized) return null;

  if (providerId === "costamar") {
    if (normalized.includes("costamar terminalid is required")) {
      return {
        shortLabel: "Falta terminal",
        detail: "Costamar no tiene un terminal activo o recuperable para esta búsqueda.",
      };
    }

    if (normalized.includes("costamar rejected this search")) {
      return {
        shortLabel: "Falta sesión",
        detail: "Costamar rechazó la búsqueda con la sesión actual.",
      };
    }

    if (normalized.includes("costamar") && (
      normalized.includes("token")
      || normalized.includes("session")
      || normalized.includes("sesion")
    )) {
      return {
        shortLabel: "Falta sesión",
        detail: normalized.includes("redirect token")
          ? "Costamar no tiene un token branded válido para abrir esta búsqueda en su web."
          : "Costamar no tiene un token o sesión válida para consultar.",
      };
    }

    return null;
  }

  if (normalized.includes("agil_apim_subscription_key")) {
    return {
      shortLabel: "Falta key",
      detail: "Agil no tiene AGIL_APIM_SUBSCRIPTION_KEY cargada en este runtime.",
    };
  }

  if (
    normalized.includes("unable to extract agil session")
    || normalized.includes("agil_token_expired")
    || (normalized.includes("agil") && (
      normalized.includes("token")
      || normalized.includes("session")
      || normalized.includes("sesion")
      || normalized.includes("localstorage")
      || normalized.includes("chrome")
    ))
  ) {
    return {
      shortLabel: "Falta sesión",
      detail: "Agil no tiene una sesión local utilizable para consultar.",
    };
  }

  return null;
}

function providerWarningDetails(response, providerId) {
  const details = [];
  const seen = new Set();

  providerSearchWarnings(response).forEach((warning) => {
    const issue = classifyProviderWarning(providerId, warning);
    if (!issue) return;

    const key = `${issue.shortLabel}::${issue.detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    details.push(issue);
  });

  return details;
}

function isProviderSessionWarning(providerId, warning) {
  const normalized = String(warning || "").trim().toLowerCase();
  if (!normalized) return false;

  if (providerId === "costamar") {
    return normalized.includes("costamar rejected this search")
      || (normalized.includes("costamar") && (
        normalized.includes("token")
        || normalized.includes("session")
        || normalized.includes("sesion")
      ));
  }

  return normalized.includes("unable to extract agil session")
    || normalized.includes("agil_token_expired")
    || (normalized.includes("agil") && (
      normalized.includes("token")
      || normalized.includes("session")
      || normalized.includes("sesion")
      || normalized.includes("localstorage")
      || normalized.includes("chrome")
    ));
}

function providerLinkFallbackLabel(response, providerId) {
  const issue = providerWarningDetails(response, providerId)[0];
  if (issue) {
    return {
      label: issue.shortLabel,
      title: issue.detail,
    };
  }

  return {
    label: "—",
  };
}

function providerSentence(providerIds) {
  const labels = (providerIds || []).map(providerLabel).filter(Boolean);
  if (labels.length === 0) return "los proveedores";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} y ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")} y ${labels[labels.length - 1]}`;
}

function emptySearchPanelModel(response) {
  const providerIds = Array.isArray(response?.searchMeta?.providersUsed) && response.searchMeta.providersUsed.length > 0
    ? response.searchMeta.providersUsed
    : defaultProviderIds(state.request);
  const providerIssues = providerIds.flatMap((providerId) => {
    const issue = providerWarningDetails(response, providerId)[0];
    return issue ? [{ providerId, issue }] : [];
  });
  const issueDetails = providerIssues.map(({ providerId, issue }) => `${providerLabel(providerId)}: ${issue.detail}`);

  if (providerIssues.length === providerIds.length && providerIssues.length > 0) {
    return {
      eyebrow: "Diagnóstico",
      title: `No se pudo consultar ${providerSentence(providerIds)}`,
      text: "La búsqueda terminó sin ofertas porque Fly Desk no logró entrar a los proveedores necesarios.",
      hint: issueDetails.join(" "),
      icon: "ico-route",
    };
  }

  const hintParts = [
    ...issueDetails,
    "Prueba quitando Directo, Equipaje o Escala para ampliar el rango.",
  ];

  return {
    title: "Sin resultados con estos filtros",
    text: "No aparecieron ofertas para la combinación actual.",
    hint: hintParts.join(" "),
    icon: "ico-route",
  };
}

function pathSupportsEquivalentSearch(path) {
  return Boolean(path?.url);
}

function providerIdsForLinkCell() {
  const providerIds = state.searchResponse?.searchMeta?.providersUsed;
  if (Array.isArray(providerIds) && providerIds.length > 0) {
    return providerIds;
  }

  return defaultProviderIds(state.request);
}

function renderProviderLinkItem(path, providerId) {
  if (pathSupportsEquivalentSearch(path)) {
    return `<a href="${path.url}" target="_blank" rel="noreferrer" class="row-link" data-stop-row="1">${providerLabel(providerId)}</a>`;
  }

  const fallback = providerLinkFallbackLabel(state.searchResponse, providerId);
  if (fallback.label === "—") {
    return "";
  }

  const titleAttr = fallback.title ? ` title="${escapeHtml(fallback.title)}"` : "";
  return `<span class="cell-sub cell-sub--warning"${titleAttr}>${providerLabel(providerId)}: ${fallback.label}</span>`;
}

function renderProviderLinksCell(offer, providerLinkIndex) {
  const items = providerIdsForLinkCell()
    .map((providerId) => renderProviderLinkItem(bestProviderPathForOffer(offer, providerId, providerLinkIndex), providerId))
    .filter(Boolean);

  if (items.length === 0) {
    return '<span class="cell-sub">—</span>';
  }

  return `<div class="provider-links-cell">${items.join("")}</div>`;
}

function runtimeBadgeCopy(active) {
  const providerIds = active?.searchMeta?.providersUsed?.length
    ? active.searchMeta.providersUsed
    : [active?.providerMeta?.exactProvider].filter(Boolean);
  const providerName = providerLabelList(providerIds);
  const status = active?.matrixStatus ?? active?.searchStatus ?? active?.searchMeta?.searchState;

  if (status === "running" || status === "search_partial") {
    return `${providerName} cargando`;
  }

  if (status === "search_failed" || status === "failed") {
    return `${providerName} error`;
  }

  if (active?.matrixResponse || active?.cells) {
    return `${providerName} flexible`;
  }

  return `${providerName} listo`;
}

function activeFlexibleRoundTripMode() {
  return flexibleMode?.value === "fixed-ranges"
    ? "fixed-ranges"
    : "exact-stay";
}

function isFlexibleRoundTripMode() {
  return state.flexMode && tripType.value === "round-trip";
}

function isExactStayFlexibleMode() {
  return isFlexibleRoundTripMode() && activeFlexibleRoundTripMode() === "exact-stay";
}

function isFixedRangesFlexibleMode() {
  return isFlexibleRoundTripMode() && activeFlexibleRoundTripMode() === "fixed-ranges";
}

function currentStayNights() {
  return Math.max(1, parseInt(stayNightsEl?.value, 10) || 1);
}

function activeMatrixFlexibleMode(request = state.matrixResponse?.request ?? state.request) {
  return resolveRoundTripFlexibleMode(request) === "fixed-ranges"
    ? "fixed-ranges"
    : "exact-stay";
}

function canRenderMatrixCalendar(request = state.matrixResponse?.request ?? state.request) {
  return resolveRoundTripFlexibleMode(request) === "fixed-ranges";
}

function flexibleCombinationLabel(count) {
  return `${count} combinación${count === 1 ? "" : "es"}`;
}

function buildResultsTableHeaderHtml() {
  return `
    <colgroup>
      <col style="width:15%">
      <col style="width:19%">
      <col style="width:11%">
      <col style="width:10%">
      <col style="width:11%">
      <col style="width:14%">
      <col style="width:10%">
    </colgroup>
    <thead><tr>
      <th>Aerolínea</th>
      <th>Fechas</th>
      <th>Duración</th>
      <th>Escalas</th>
      <th>Equipaje</th>
      <th>Precio</th>
      <th>Enlace</th>
    </tr></thead>
  `;
}

const RESULTS_SKELETON_ROW_COUNT = 6;

function buildResultsPlaceholderRows(count = RESULTS_SKELETON_ROW_COUNT) {
  return Array.from({ length: count }, () => `
    <tr class="results-row--placeholder" aria-hidden="true">
      <td><span class="skeleton-line skeleton-line--md"></span></td>
      <td>
        <div class="results-date-stack">
          <span class="skeleton-line skeleton-line--lg"></span>
          <span class="skeleton-line skeleton-line--sm"></span>
        </div>
      </td>
      <td><span class="skeleton-line skeleton-line--sm"></span></td>
      <td><span class="skeleton-line skeleton-line--sm"></span></td>
      <td><span class="skeleton-line skeleton-line--sm"></span></td>
      <td class="results-price"><span class="skeleton-line skeleton-line--price"></span></td>
      <td><span class="skeleton-line skeleton-line--link"></span></td>
    </tr>
  `).join("");
}

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

function normalizePlainTextLineEndings(text) {
  return typeof text === "string" ? text.replace(/\r\n/g, "\n") : "";
}

function resolveQuotationPayload(data) {
  return typeof data?.commercialText === "string"
    ? normalizePlainTextLineEndings(data.commercialText).trim()
    : normalizePlainTextLineEndings(data?.plainText).trim();
}

function renderResultsSkeleton({
  busy = true,
  rowCount = RESULTS_SKELETON_ROW_COUNT,
} = {}) {
  if (!resultsContainer) return;
  const rows = buildResultsPlaceholderRows(rowCount);

  resultsContainer.innerHTML = `
    <div class="results-skeleton" aria-live="polite" aria-busy="${busy ? "true" : "false"}">
      <div class="table-wrap">
        <table class="results-table results-table--pending">
          ${buildResultsTableHeaderHtml()}
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;

  const resultsWrap = resultsContainer.querySelector(".table-wrap");
  syncResultsPageSize();
  syncResultsScroll(resultsWrap);
  requestAnimationFrame(() => syncResultsScroll(resultsWrap));
  resultsWrap?.addEventListener("scroll", handleResultsScroll, { passive: true });
  resultsWrap?.addEventListener("wheel", markPollingUiInteraction, { passive: true });
  resultsWrap?.addEventListener("pointerdown", () => {
    state.pollPointerDown = true;
    markPollingUiInteraction();
  });
}

function detailActionCopy() {
  return {
    eyebrow: "Generando cotización",
    text: "Preparando el texto con la oferta seleccionada.",
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

function cancelPendingPollRender() {
  if (state.pollRenderHandle) {
    clearTimeout(state.pollRenderHandle);
    state.pollRenderHandle = null;
  }
  state.pollRenderPending = false;
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
    matrixFullscreenMeta.textContent = flexibleCombinationLabel(state.matrixResponse?.cells?.length ?? 0);
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

function normalizeMaxStopsValue(value) {
  const parsed = Number.isFinite(Number(value)) ? Number.parseInt(String(value), 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? String(parsed) : "";
}

function parseOptionalInteger(value) {
  const parsed = Number.isFinite(Number(value)) ? Number.parseInt(String(value), 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sortModeLabel(value) {
  if (value === "fastest") return "Más rápido";
  if (value === "best-value") return "Mejor valor";
  return "Más barato";
}

function compactStopsLabel(value) {
  if (String(value) === "1") return "1 esc.";
  if (String(value) === "2") return "2 esc.";
  return "";
}

function formatDateCompact(iso) {
  if (!iso) return "—";
  // "2026-04-15" → "15/04"
  const parts = iso.slice(0, 10).split("-");
  return `${parts[2]}/${parts[1]}`;
}

function activeResultsRequest() {
  return state.request ?? state.searchResponse?.request ?? state.matrixResponse?.request ?? null;
}

function toolbarRouteSummary(request = activeResultsRequest()) {
  const leg = request?.legs?.[0];
  if (!leg?.origin || !leg?.destination) {
    return "";
  }

  return `${leg.origin} → ${leg.destination}`;
}

function toolbarDateSummary(request = activeResultsRequest()) {
  const leg = request?.legs?.[0];
  if (!leg) {
    return "";
  }

  const flexibleRoundTripMode = resolveRoundTripFlexibleMode(request);
  if (request?.tripType === "round-trip" && request?.searchMode === "roundtrip-grid") {
    if (flexibleRoundTripMode === "exact-stay") {
      const stayNights = leg.stayNights ?? resolveExactStayNights(leg);
      if (leg.departureStart && leg.departureEnd && typeof stayNights === "number") {
        return `${formatDateCompact(leg.departureStart)} → ${formatDateCompact(leg.departureEnd)} · ${stayNights} noches`;
      }
    }

    if (flexibleRoundTripMode === "fixed-ranges") {
      if (leg.departureStart && leg.departureEnd && leg.returnStart && leg.returnEnd) {
        return `I ${formatDateCompact(leg.departureStart)} → ${formatDateCompact(leg.departureEnd)} · V ${formatDateCompact(leg.returnStart)} → ${formatDateCompact(leg.returnEnd)}`;
      }
    }
  }

  const departureStart = leg.departureDate ?? leg.departureStart ?? "";
  const departureEnd = leg.departureEnd ?? departureStart;
  const returnStart = leg.returnDate ?? leg.returnStart ?? "";
  const returnEnd = leg.returnEnd ?? returnStart;

  if (request?.tripType === "one-way") {
    if (departureStart && departureEnd && departureStart !== departureEnd) {
      return `${formatDateCompact(departureStart)} → ${formatDateCompact(departureEnd)}`;
    }

    return departureStart ? formatDateCompact(departureStart) : "";
  }

  if (departureStart && returnStart) {
    return `${formatDateCompact(departureStart)} → ${formatDateCompact(returnStart)}`;
  }

  if (departureStart && departureEnd && departureStart !== departureEnd) {
    return `${formatDateCompact(departureStart)} → ${formatDateCompact(departureEnd)}`;
  }

  if (returnStart && returnEnd && returnStart !== returnEnd) {
    return `${formatDateCompact(returnStart)} → ${formatDateCompact(returnEnd)}`;
  }

  return departureStart ? formatDateCompact(departureStart) : "";
}

function clipboardModeLabel(request) {
  if (request?.searchMode === "roundtrip-grid") {
    return resolveRoundTripFlexibleMode(request) === "fixed-ranges"
      ? "Flexible ida y vuelta · rangos fijos"
      : "Flexible ida y vuelta · estadía exacta";
  }

  if (request?.searchMode === "stay-range") {
    return "Flexible";
  }

  return "Exacta";
}

function buildResultsPanelMeta({ hasMatrix, matrixCellCount }) {
  const active = state.searchResponse ?? state.matrixResponse;
  if (!active) {
    return "";
  }

  const request = active.request ?? activeResultsRequest();
  const parts = [
    toolbarRouteSummary(request),
    toolbarDateSummary(request),
  ].filter(Boolean);

  if (hasMatrix && matrixCellCount > 0) {
    parts.push(flexibleCombinationLabel(matrixCellCount));
  }

  return parts.join(" · ");
}

function buildResultsPagerHtml(currentPage, totalPages, { placeholder = false } = {}) {
  const label = placeholder ? "— / —" : `${currentPage} / ${totalPages}`;
  const prevDisabled = placeholder || currentPage <= 1;
  const nextDisabled = placeholder || currentPage >= totalPages;
  const labelClass = placeholder ? "pager-label pager-label--placeholder" : "pager-label";

  return `
    <button type="button" class="pager-arrow" data-results-page="prev" ${prevDisabled ? "disabled" : ""} aria-label="Página anterior">
      <svg viewBox="0 0 10 14" width="10" height="14" aria-hidden="true"><polygon points="10,0 0,7 10,14" fill="currentColor"/></svg>
    </button>
    <span class="${labelClass}">${label}</span>
    <button type="button" class="pager-arrow" data-results-page="next" ${nextDisabled ? "disabled" : ""} aria-label="Página siguiente">
      <svg viewBox="0 0 10 14" width="10" height="14" aria-hidden="true"><polygon points="0,0 10,7 0,14" fill="currentColor"/></svg>
    </button>
  `;
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

function normalizePassengerCounts(passengers = {}) {
  const adults = Number.parseInt(String(passengers.adults ?? 1), 10) || 1;
  const children = Number.parseInt(String(passengers.children ?? 0), 10) || 0;
  const infants = Number.parseInt(String(passengers.infants ?? 0), 10) || 0;
  return {
    adults,
    children,
    infants,
    total: Math.max(1, adults + children + infants),
  };
}

function passengerCountForRequest(request) {
  return normalizePassengerCounts(request?.passengers ?? {}).total;
}

function moneyPerPassenger(m, passengerCount) {
  if (!m || typeof m.amount !== "number" || !m.currencyCode || !Number.isFinite(passengerCount) || passengerCount <= 0) {
    return null;
  }

  return {
    amount: Number((m.amount / passengerCount).toFixed(2)),
    currencyCode: m.currencyCode,
  };
}

function priceLabels(m, passengerCount) {
  if (!m) {
    return {
      totalLabel: "—",
      perPersonLabel: "",
      combinedLabel: "—",
    };
  }

  const totalLabel = formatMoney(m);
  const perPerson = moneyPerPassenger(m, passengerCount);
  const perPersonLabel = perPerson ? `${formatMoney(perPerson)} por persona` : "";
  return {
    totalLabel,
    perPersonLabel,
    combinedLabel: perPersonLabel ? `${totalLabel} total · ${perPersonLabel}` : totalLabel,
  };
}

function renderPriceBreakdownHtml(
  m,
  passengerCount,
  {
    emptyLabel = "—",
    totalSuffix = "",
    perPersonSuffix = " por persona",
    className = "price-stack",
    totalClassName = "price-stack__total",
    metaClassName = "price-stack__meta",
  } = {},
) {
  if (!m) {
    return escapeHtml(emptyLabel);
  }

  const totalLabel = formatMoney(m);
  const perPerson = moneyPerPassenger(m, passengerCount);
  const totalText = `${totalLabel}${totalSuffix}`;
  const perPersonText = perPerson ? `${formatMoney(perPerson)}${perPersonSuffix}` : "";

  return `
    <span class="${escapeHtml(className)}">
      <span class="${escapeHtml(totalClassName)}">${escapeHtml(totalText)}</span>
      ${perPersonText ? `<span class="${escapeHtml(metaClassName)}">${escapeHtml(perPersonText)}</span>` : ""}
    </span>
  `.trim();
}

function renderDetailHeroPriceHtml(m, passengerCount) {
  const labels = priceLabels(m, passengerCount);
  return `
    <div class="detail-hero">
      <span class="detail-hero__total">${escapeHtml(labels.totalLabel)}</span>
      ${labels.perPersonLabel ? `<span class="detail-hero__meta">${escapeHtml(labels.perPersonLabel)}</span>` : ""}
    </div>
  `.trim();
}

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

function isIsoDatePathSegment(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

function normalizeClipboardProviderConfig(rawProviderConfig) {
  const costamar = rawProviderConfig?.costamar;
  if (!costamar || typeof costamar !== "object") {
    return null;
  }

  const terminalId = String(costamar.terminalId || "").trim();
  const token = String(costamar.token || "").trim();
  const lang = String(costamar.lang || "").trim();
  if (!terminalId && !token && !lang) {
    return null;
  }

  return {
    costamar: {
      ...(terminalId ? { terminalId } : {}),
      ...(token ? { token } : {}),
      ...(lang ? { lang } : {}),
    },
  };
}

function buildClipboardRequestFromPayload(payload) {
  const baseRequest = payload?.request ?? {};
  const baseLeg = baseRequest?.legs?.[0] ?? {};
  const inferredTripType = baseRequest?.tripType === "one-way" || payload?.tripType === "one-way"
    ? "one-way"
    : "round-trip";
  const inferredFlexibleMode = baseRequest?.flexibleMode === "fixed-ranges"
    || payload?.flexibleMode === "fixed-ranges"
    || (payload?.mode === "flexible" && payload?.dates?.returnStart && payload?.dates?.returnEnd)
    ? "fixed-ranges"
    : "exact-stay";
  const inferredSearchMode = baseRequest?.searchMode
    || (payload?.mode === "flexible"
      ? inferredTripType === "round-trip" ? "roundtrip-grid" : "stay-range"
      : "exact");
  const passengers = {
    ...baseRequest?.passengers,
    adults: parseOptionalInteger(payload?.passengers?.adults ?? baseRequest?.passengers?.adults) ?? 1,
    children: parseOptionalInteger(payload?.passengers?.children ?? baseRequest?.passengers?.children) ?? 0,
    infants: parseOptionalInteger(payload?.passengers?.infants ?? baseRequest?.passengers?.infants) ?? 0,
  };
  const maxStops = parseOptionalInteger(payload?.filters?.maxStops ?? baseRequest?.filters?.maxStops);
  const maxLayoverMinutes = parseOptionalInteger(
    payload?.filters?.maxLayoverMinutes ?? baseRequest?.filters?.maxLayoverMinutes,
  );
  const filters = {
    ...(baseRequest?.filters ?? {}),
    nonStop: payload?.filters?.nonStop ?? baseRequest?.filters?.nonStop === true,
    baggageRequired: payload?.filters?.baggageRequired ?? baseRequest?.filters?.baggageRequired === true,
    ...(typeof maxStops === "number" ? { maxStops } : {}),
    ...(typeof maxLayoverMinutes === "number" ? { maxLayoverMinutes } : {}),
  };
  const stayNights = parseOptionalInteger(
    payload?.stay?.nights
    ?? payload?.stay?.min
    ?? payload?.stay?.max
    ?? baseLeg?.stayNights,
  );

  return {
    ...baseRequest,
    tripType: inferredTripType,
    searchMode: inferredSearchMode,
    flexibleMode: inferredSearchMode === "roundtrip-grid" ? inferredFlexibleMode : undefined,
    cabin: baseRequest?.cabin ?? "ECONOMY",
    coverageMode: baseRequest?.coverageMode ?? "core",
    redirectMode: baseRequest?.redirectMode ?? "best-effort",
    currencyCode: baseRequest?.currencyCode ?? DEFAULT_CURRENCY_CODE,
    locale: baseRequest?.locale ?? state.request?.locale ?? "es-PE",
    market: baseRequest?.market ?? state.request?.market ?? "PE",
    passengers,
    filters,
    legs: [
      {
        ...baseLeg,
        origin: baseLeg?.origin || payload?.origin?.code || payload?.origin?.value || "",
        destination: baseLeg?.destination || payload?.destination?.code || payload?.destination?.value || "",
        originLabel: baseLeg?.originLabel || payload?.origin?.label || payload?.origin?.value || "",
        destinationLabel: baseLeg?.destinationLabel || payload?.destination?.label || payload?.destination?.value || "",
        departureDate: inferredSearchMode === "exact" ? String(payload?.dates?.departureDate || baseLeg?.departureDate || "") : undefined,
        returnDate: inferredSearchMode === "exact" && inferredTripType === "round-trip"
          ? String(payload?.dates?.returnDate || baseLeg?.returnDate || "")
          : undefined,
        departureStart: inferredSearchMode !== "exact"
          ? String(payload?.dates?.departureStart || baseLeg?.departureStart || "")
          : undefined,
        departureEnd: inferredSearchMode !== "exact"
          ? String(payload?.dates?.departureEnd || baseLeg?.departureEnd || "")
          : undefined,
        returnStart: inferredSearchMode === "roundtrip-grid" && inferredFlexibleMode === "fixed-ranges"
          ? String(payload?.dates?.returnStart || baseLeg?.returnStart || "")
          : undefined,
        returnEnd: inferredSearchMode === "roundtrip-grid" && inferredFlexibleMode === "fixed-ranges"
          ? String(payload?.dates?.returnEnd || baseLeg?.returnEnd || "")
          : undefined,
        stayNights: inferredSearchMode === "roundtrip-grid" && inferredFlexibleMode === "exact-stay"
          ? stayNights
          : undefined,
      },
    ],
  };
}

function buildClipboardSummary(request, sortModeValue) {
  const passengers = request?.passengers ?? {};
  const leg = request?.legs?.[0] ?? {};
  const stayNights = leg?.stayNights ?? resolveExactStayNights(leg);

  return {
    route: toolbarRouteSummary(request),
    dates: toolbarDateSummary(request),
    tripType: request?.tripType === "one-way" ? "Solo ida" : "Ida y vuelta",
    mode: clipboardModeLabel(request),
    stay: typeof stayNights === "number" ? `${stayNights} noches` : "",
    passengers: formatPassengerSummary(
      Number.parseInt(String(passengers.adults ?? 1), 10) || 1,
      Number.parseInt(String(passengers.children ?? 0), 10) || 0,
      Number.parseInt(String(passengers.infants ?? 0), 10) || 0,
    ),
    filters: flexibleCellFilterSummary(request?.filters ?? {}),
    cabin: request?.cabin ?? "ECONOMY",
    sort: sortModeLabel(sortModeValue),
  };
}

function withClipboardMetadata(payload) {
  const request = buildClipboardRequestFromPayload(payload);
  return {
    ...payload,
    request,
    summary: buildClipboardSummary(request, payload?.sortMode || "cheapest"),
  };
}

function buildCostamarClipboardPayloadFromUrl(raw) {
  const source = String(raw || "").trim();
  if (!source) return null;

  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "booking.clickandbook.com") {
    return null;
  }

  const path = parsed.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (path.length < 7 || path[0] !== "vuelos" || path[1] !== "b") {
    return null;
  }

  const origin = String(path[2] || "").trim().toUpperCase();
  const destination = String(path[3] || "").trim().toUpperCase();
  const departureDate = String(path[4] || "").trim();
  if (!origin || !destination || !isIsoDatePathSegment(departureDate)) {
    return null;
  }

  let returnDate = "";
  let passengerOffset = 5;
  if (isIsoDatePathSegment(path[5])) {
    returnDate = String(path[5] || "").trim();
    passengerOffset = 6;
  }

  const adults = String(path[passengerOffset] || "").trim();
  const children = String(path[passengerOffset + 1] || "").trim();
  const infants = String(path[passengerOffset + 2] || "").trim();
  if (!/^\d+$/.test(adults) || !/^\d+$/.test(children) || !/^\d+$/.test(infants)) {
    return null;
  }

  const terminalId = String(parsed.searchParams.get("terminalId") || "").trim();
  const token = String(parsed.searchParams.get("token") || "").trim();
  const lang = String(parsed.searchParams.get("lang") || "es").trim() || "es";
  const stayNights = returnDate ? Math.max(0, diffDaysIso(departureDate, returnDate)) : undefined;

  return withClipboardMetadata({
    type: SEARCH_CONFIG_CLIPBOARD_TYPE,
    version: SEARCH_CONFIG_CLIPBOARD_VERSION,
    copiedAt: new Date().toISOString(),
    mode: "exact",
    tripType: returnDate ? "round-trip" : "one-way",
    origin: {
      value: origin,
      code: origin,
      label: origin,
    },
    destination: {
      value: destination,
      code: destination,
      label: destination,
    },
    dates: {
      departureDate,
      returnDate,
      departureStart: "",
      departureEnd: "",
      returnStart: "",
      returnEnd: "",
    },
    stay: {
      nights: typeof stayNights === "number" ? String(stayNights) : "",
      min: typeof stayNights === "number" ? String(stayNights) : "",
      max: typeof stayNights === "number" ? String(stayNights) : "",
    },
    passengers: {
      adults,
      children,
      infants,
    },
    filters: {
      nonStop: false,
      baggageRequired: false,
      maxStops: "",
      maxLayoverMinutes: "",
    },
    sortMode: state.sortMode || "cheapest",
    providerConfig: normalizeClipboardProviderConfig({
      costamar: {
        terminalId,
        token,
        lang,
      },
    }),
  });
}

function parseSearchClipboardPayload(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.type !== SEARCH_CONFIG_CLIPBOARD_TYPE || parsed.version !== SEARCH_CONFIG_CLIPBOARD_VERSION) {
      return null;
    }
    return {
      ...parsed,
      providerConfig: normalizeClipboardProviderConfig(parsed.providerConfig),
    };
  } catch {
    return buildCostamarClipboardPayloadFromUrl(raw);
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

  const formPayload = getFormPayload();
  const payload = {
    type: SEARCH_CONFIG_CLIPBOARD_TYPE,
    version: SEARCH_CONFIG_CLIPBOARD_VERSION,
    copiedAt: new Date().toISOString(),
    mode: state.flexMode ? "flexible" : "exact",
    flexibleMode: isFlexibleRoundTripMode() ? activeFlexibleRoundTripMode() : undefined,
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
      nights: controlValue("stayNights"),
      min: controlValue("stayNights"),
      max: controlValue("stayNights"),
    },
    passengers: {
      adults: controlValue("adults"),
      children: controlValue("children"),
      infants: controlValue("infants"),
    },
    filters: {
      nonStop: controlChecked("nonStop"),
      baggageRequired: controlChecked("baggageRequired"),
      maxStops: controlValue("maxStopsFilter"),
      maxLayoverMinutes: controlValue("maxLayoverMinutes"),
    },
    sortMode: controlValue("sortMode") || state.sortMode || "cheapest",
    providerConfig: normalizeClipboardProviderConfig(state.providerConfig),
    request: {
      ...formPayload.request,
      locale: formPayload.request.locale ?? state.request?.locale ?? "es-PE",
      market: formPayload.request.market ?? state.request?.market ?? "PE",
    },
  };

  return withClipboardMetadata(payload);
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

function syncSearchFormWithRequest(request) {
  if (!request) return;

  const leg = request.legs?.[0] ?? {};
  const isFlexible = request.searchMode && request.searchMode !== "exact";
  const roundTripFlexibleMode = resolveRoundTripFlexibleMode(request);
  const departureAnchor = String(leg.departureDate || leg.departureStart || "").trim();

  state.flexMode = Boolean(isFlexible);
  tripType.value = request.tripType === "one-way" ? "one-way" : "round-trip";
  if (flexibleMode) {
    flexibleMode.value = roundTripFlexibleMode === "fixed-ranges" ? "fixed-ranges" : "exact-stay";
  }

  applyResolvedLocation("origin", {
    value: leg.originLabel || leg.origin || "",
    code: leg.origin || "",
    label: leg.originLabel || leg.origin || "",
  });
  applyResolvedLocation("destination", {
    value: leg.destinationLabel || leg.destination || "",
    code: leg.destination || "",
    label: leg.destinationLabel || leg.destination || "",
  });
  hideLocationMenu("origin");
  hideLocationMenu("destination");

  $("adults").value = String(request.passengers?.adults ?? 1);
  $("children").value = String(request.passengers?.children ?? 0);
  $("infants").value = String(request.passengers?.infants ?? 0);
  $("nonStop").checked = request.filters?.nonStop === true;
  $("baggageRequired").checked = request.filters?.baggageRequired === true;
  $("maxStopsFilter").value = normalizeMaxStopsValue(request.filters?.maxStops);
  $("maxLayoverMinutes").value = String(request.filters?.maxLayoverMinutes || "");
  syncLayoverFilterUi();

  const stayNights = leg.stayNights ?? resolveExactStayNights(leg);
  if (typeof stayNights === "number" && stayNightsEl) {
    stayNightsEl.value = String(stayNights);
  }

  if (state.flexMode) {
    $("departureDate").value = "";
    $("returnDate").value = "";
    $("departureStart").value = String(leg.departureStart || "");
    $("departureEnd").value = String(leg.departureEnd || "");
    $("returnStart").value = roundTripFlexibleMode === "fixed-ranges"
      ? String(leg.returnStart || "")
      : "";
    $("returnEnd").value = roundTripFlexibleMode === "fixed-ranges"
      ? String(leg.returnEnd || "")
      : "";
  } else {
    $("departureDate").value = String(leg.departureDate || "");
    $("returnDate").value = tripType.value === "round-trip" ? String(leg.returnDate || "") : "";
    $("departureStart").value = "";
    $("departureEnd").value = "";
    $("returnStart").value = "";
    $("returnEnd").value = "";
  }

  calendarState.selectionStage = "start";
  if (departureAnchor) {
    calendarState.viewStartMonth = firstDayOfMonth(departureAnchor);
  }

  paxPopover?.classList.add("hidden");
  closeLayoverPopover();
  closeCalendarPopover();
  searchForm.querySelectorAll(".is-invalid").forEach((el) => el.classList.remove("is-invalid"));
  showErrors([]);
  updatePaxLabel();
  updateModeFields();
}

function applySearchClipboardPayload(payload) {
  if (!payload) return false;

  const request = buildClipboardRequestFromPayload(payload);
  state.providerConfig = normalizeClipboardProviderConfig(payload.providerConfig);
  state.sortMode = String(payload.sortMode || "cheapest");
  sortMode.value = state.sortMode;
  syncSearchFormWithRequest(request);

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
    const data = await getJson(`/api/locations?q=${encodeURIComponent(query.trim())}&limit=8`);
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

function normalizeProviderMatchTime(iso) {
  if (typeof iso !== "string") return "";
  return iso
    .replace(/\.\d+(?=(?:[+-]\d{2}:?\d{2}|Z)$)/i, "")
    .replace(/(?:[+-]\d{2}:?\d{2}|Z)$/i, "")
    .slice(0, 19);
}

function normalizeProviderMatchFlightNumber(segment) {
  const rawFlightNumber = typeof segment?.flightNumber === "string"
    ? segment.flightNumber.toUpperCase().replace(/\s+/g, "")
    : "";
  const marketingCarrier = typeof segment?.marketingCarrier === "string"
    ? segment.marketingCarrier.toUpperCase().trim()
    : "";

  if (!rawFlightNumber) return "";
  if (marketingCarrier && rawFlightNumber.startsWith(marketingCarrier)) {
    return rawFlightNumber.slice(marketingCarrier.length) || rawFlightNumber;
  }

  return rawFlightNumber;
}

function providerLinkSegmentKey(segment) {
  return [
    segment?.marketingCarrier ?? "",
    normalizeProviderMatchFlightNumber(segment),
    segment?.origin ?? "",
    segment?.destination ?? "",
    normalizeProviderMatchTime(segment?.departureAt),
    normalizeProviderMatchTime(segment?.arrivalAt),
  ].join("|");
}

function providerLinkMatchKey(offer) {
  const itineraries = (offer?.itineraries ?? []).map((itinerary) => [
    itinerary?.direction ?? "",
    (itinerary?.segments ?? []).map((segment) => providerLinkSegmentKey(segment)).join("~"),
  ].join("::")).join("||");

  return [
    offer?.tripType ?? state.request?.tripType ?? "",
    offer?.origin ?? "",
    offer?.destination ?? "",
    itineraries,
  ].join("##");
}

function buildProviderLinkIndex(offers) {
  const index = new Map();

  (offers ?? []).forEach((offer) => {
    const key = providerLinkMatchKey(offer);
    if (!key) return;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(offer);
  });

  return index;
}

function providerPathPrecisionRank(path) {
  switch (path?.precision) {
    case "exact-offer":
      return 0;
    case "exact-search":
      return 1;
    case "broad-search":
      return 2;
    case "manual":
      return 3;
    default:
      return 4;
  }
}

function compareProviderPathCandidates(left, right) {
  const precisionDiff = providerPathPrecisionRank(left?.path) - providerPathPrecisionRank(right?.path);
  if (precisionDiff !== 0) return precisionDiff;

  const leftScore = Number(left?.path?.score ?? 0);
  const rightScore = Number(right?.path?.score ?? 0);
  if (rightScore !== leftScore) return rightScore - leftScore;

  const leftAmount = Number(left?.offer?.price?.total?.amount ?? Number.POSITIVE_INFINITY);
  const rightAmount = Number(right?.offer?.price?.total?.amount ?? Number.POSITIVE_INFINITY);
  if (leftAmount !== rightAmount) return leftAmount - rightAmount;

  return String(left?.offer?.id ?? "").localeCompare(String(right?.offer?.id ?? ""));
}

function matchedOffersForProviderLink(offer, providerLinkIndex) {
  const key = providerLinkMatchKey(offer);
  return providerLinkIndex?.get(key) ?? [offer];
}

function bestProviderPathForOffer(offer, providerId, providerLinkIndex) {
  const candidates = matchedOffersForProviderLink(offer, providerLinkIndex)
    .flatMap((candidateOffer) =>
      (candidateOffer?.purchasePaths ?? [])
        .filter((path) => path?.provider === providerId && pathSupportsEquivalentSearch(path))
        .map((path) => ({ offer: candidateOffer, path })),
    )
    .sort(compareProviderPathCandidates);

  return candidates[0]?.path;
}

function resolvedOfferPurchasePaths(offer, providerLinkIndex) {
  const primaryPaths = [];
  const agilPath = bestProviderPathForOffer(offer, "agil-local", providerLinkIndex);
  const costamarPath = bestProviderPathForOffer(offer, "costamar", providerLinkIndex);

  if (agilPath?.url) primaryPaths.push(agilPath);
  if (costamarPath?.url) primaryPaths.push(costamarPath);

  const seen = new Set(primaryPaths.map((path) => `${path.provider}|${path.url}`));
  const extraPaths = (offer?.purchasePaths ?? []).filter((path) => {
    if (!pathSupportsEquivalentSearch(path)) return false;
    const key = `${path.provider}|${path.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return [...primaryPaths, ...extraPaths];
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

function stopsCountLabel(stops) {
  const total = Number.isFinite(Number(stops)) ? Number(stops) : 0;
  if (total <= 0) {
    return "Directo";
  }

  return total === 1 ? "1 escala" : `${total} escalas`;
}

function itineraryDirectionLabel(direction, index = 0) {
  if (direction === "outbound") {
    return "Ida";
  }

  if (direction === "inbound") {
    return "Vuelta";
  }

  return index > 0 ? `Tramo ${index + 1}` : "Tramo";
}

function itineraryHeadingHtml(itinerary, index = 0) {
  const title = itineraryDirectionLabel(itinerary?.direction, index);
  const meta = `${formatDuration(itinerary?.durationMinutes)} · ${stopsCountLabel(itinerary?.stops)}`;
  return `
    <div class="detail-segment__dir">
      <span class="detail-segment__title">${escapeHtml(title)}</span>
      <span class="detail-segment__meta">${escapeHtml(meta)}</span>
    </div>
  `;
}

function segmentRouteLabel(segment) {
  const originCode = String(segment?.origin ?? "").trim();
  const destinationCode = String(segment?.destination ?? "").trim();
  const originName = typeof segment?.originName === "string" ? segment.originName.trim() : "";
  const destinationName = typeof segment?.destinationName === "string" ? segment.destinationName.trim() : "";
  const showOriginName = originName && originName.toUpperCase() !== originCode.toUpperCase();
  const showDestinationName = destinationName && destinationName.toUpperCase() !== destinationCode.toUpperCase();

  if (!showOriginName && !showDestinationName) {
    return "";
  }

  return `${showOriginName ? originName : originCode} → ${showDestinationName ? destinationName : destinationCode}`;
}

function countWindowCombinations() {
  const ds = $("departureStart")?.value;
  const de = $("departureEnd")?.value;
  if (!ds || !de) return 0;
  const departures = enumerateIsoRange(ds, de);
  if (tripType.value === "one-way") return departures.length;

  try {
    return enumerateUsefulRoundTripPairs({
      tripType: "round-trip",
      searchMode: "roundtrip-grid",
      flexibleMode: activeFlexibleRoundTripMode(),
      legs: [
        {
          departureStart: ds,
          departureEnd: de,
          returnStart: isFixedRangesFlexibleMode() ? $("returnStart")?.value ?? "" : "",
          returnEnd: isFixedRangesFlexibleMode() ? $("returnEnd")?.value ?? "" : "",
          stayNights: isExactStayFlexibleMode() ? currentStayNights() : undefined,
        },
      ],
    }).length;
  } catch {
    return 0;
  }
}

function resultsPageCount(total) {
  const pageSize = Math.max(1, Math.trunc(state.resultsPageSize) || RESULTS_PAGE_SIZE);
  return Math.max(1, Math.ceil(total / pageSize));
}

function resolveVisibleResultsPageSize(viewport = resultsContainer?.querySelector(".table-wrap") ?? resultsContainer) {
  if (!(viewport instanceof HTMLElement)) {
    return Math.max(1, Math.trunc(state.resultsPageSize) || RESULTS_PAGE_SIZE);
  }

  const tableHeader = viewport.querySelector("thead");
  const sampleRows = [...viewport.querySelectorAll("tbody tr[data-oid], tbody tr.results-row--placeholder")]
    .slice(0, 6)
    .filter((row) => row instanceof HTMLElement);
  const viewportHeight = viewport.clientHeight;
  const headerHeight = tableHeader instanceof HTMLElement ? tableHeader.getBoundingClientRect().height : 0;
  const rowHeight = sampleRows.length > 0
    ? sampleRows.reduce((total, row) => total + row.getBoundingClientRect().height, 0) / sampleRows.length
    : 0;

  if (viewportHeight <= 0 || rowHeight <= 0) {
    return Math.max(1, Math.trunc(state.resultsPageSize) || RESULTS_PAGE_SIZE);
  }

  const availableHeight = Math.max(rowHeight, viewportHeight - headerHeight);
  return Math.max(1, Math.floor((availableHeight + 1) / rowHeight));
}

function syncResultsPageSize() {
  const viewport = resultsContainer?.querySelector(".table-wrap") ?? resultsContainer;
  if (!(viewport instanceof HTMLElement)) {
    return false;
  }

  const viewportBounds = viewport.getBoundingClientRect();
  const nextViewportSize = {
    width: Math.round(viewportBounds.width),
    height: Math.round(viewportBounds.height),
  };
  const previousViewportSize = state.resultsViewportSize ?? { width: 0, height: 0 };
  if (
    nextViewportSize.width > 0
    && nextViewportSize.height > 0
    && nextViewportSize.width === previousViewportSize.width
    && nextViewportSize.height === previousViewportSize.height
  ) {
    return false;
  }

  const nextPageSize = resolveVisibleResultsPageSize(viewport);
  state.resultsViewportSize = nextViewportSize;
  if (nextPageSize === state.resultsPageSize) {
    return false;
  }

  state.resultsPageSize = nextPageSize;
  return true;
}

function isLocal() {
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1";
}

function calendarSelectionValues() {
  if (isFixedRangesFlexibleMode()) {
    return {
      departureStart: controlValue("departureStart"),
      departureEnd: controlValue("departureEnd"),
      returnStart: controlValue("returnStart"),
      returnEnd: controlValue("returnEnd"),
    };
  }

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

function resetCalendarSelectionStage() {
  if (isFixedRangesFlexibleMode()) {
    const departureStart = controlValue("departureStart");
    const departureEnd = controlValue("departureEnd");
    const returnStart = controlValue("returnStart");
    const returnEnd = controlValue("returnEnd");

    if (!departureStart || (departureStart && departureEnd && returnStart && returnEnd)) {
      calendarState.selectionStage = "departure-start";
      return;
    }

    if (!departureEnd) {
      calendarState.selectionStage = "departure-end";
      return;
    }

    if (!returnStart) {
      calendarState.selectionStage = "return-start";
      return;
    }

    calendarState.selectionStage = "return-end";
    return;
  }

  calendarState.selectionStage = "start";
}

function syncDateTriggerText() {
  if (!dateTriggerText) return;

  if (state.flexMode) {
    if (isFixedRangesFlexibleMode()) {
      const departureStart = controlValue("departureStart");
      const departureEnd = controlValue("departureEnd");
      const returnStart = controlValue("returnStart");
      const returnEnd = controlValue("returnEnd");

      if (departureStart && departureEnd && returnStart && returnEnd) {
        dateTriggerText.textContent = `Ida ${formatDateCompact(departureStart)} → ${formatDateCompact(departureEnd)} · Vuelta ${formatDateCompact(returnStart)} → ${formatDateCompact(returnEnd)}`;
        return;
      }

      if (departureStart && departureEnd) {
        dateTriggerText.textContent = `Ida ${formatDateCompact(departureStart)} → ${formatDateCompact(departureEnd)} · define vuelta`;
        return;
      }

      if (departureStart) {
        dateTriggerText.textContent = `Ida desde ${formatDateCompact(departureStart)}`;
        return;
      }

      dateTriggerText.textContent = "Ventanas de ida y vuelta";
      return;
    }

    const start = controlValue("departureStart");
    const end = controlValue("departureEnd");
    const stayText = `${currentStayNights()} noches`;

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
  return firstDayOfMonth(maxDateISO());
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
  const preferred = selection.start
    || selection.departureStart
    || selection.returnStart
    || selection.end
    || selection.departureEnd
    || selection.returnEnd
    || minDateISO();
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

  if (isFixedRangesFlexibleMode()) {
    calendarTitle.textContent = "Ventanas de ida y vuelta";
    if (selection.departureStart && selection.departureEnd && selection.returnStart && selection.returnEnd) {
      calendarSelectionSummary.textContent = `Ida del ${formatDateCompact(selection.departureStart)} al ${formatDateCompact(selection.departureEnd)} y vuelta del ${formatDateCompact(selection.returnStart)} al ${formatDateCompact(selection.returnEnd)}.`;
    } else if (selection.departureStart && selection.departureEnd && selection.returnStart) {
      calendarSelectionSummary.textContent = `Ida del ${formatDateCompact(selection.departureStart)} al ${formatDateCompact(selection.departureEnd)}. Cierra la ventana de vuelta.`;
    } else if (selection.departureStart && selection.departureEnd) {
      calendarSelectionSummary.textContent = `Ida del ${formatDateCompact(selection.departureStart)} al ${formatDateCompact(selection.departureEnd)}. Selecciona la ventana de vuelta.`;
    } else if (selection.departureStart) {
      calendarSelectionSummary.textContent = `Ventana de ida iniciada en ${formatDateCompact(selection.departureStart)}. Selecciona la fecha final.`;
    } else {
      calendarSelectionSummary.textContent = "Selecciona primero la ventana de ida y luego la de vuelta.";
    }
    return;
  }

  if (state.flexMode) {
    calendarTitle.textContent = "Ventana de salida";
    if (selection.start && selection.end) {
      calendarSelectionSummary.textContent = `Salida flexible del ${formatDateCompact(selection.start)} al ${formatDateCompact(selection.end)} con ${currentStayNights()} noches de estadía.`;
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
  calendarFlexModeControl?.classList.toggle("hidden", !isFlexibleRoundTripMode());
  calendarStayConfig?.classList.toggle("hidden", !isExactStayFlexibleMode());

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
      const disabledByBounds = day.iso < today || day.iso > maxDateISO();
      const disabledByFlow = !state.flexMode
        && tripType.value === "round-trip"
        && calendarState.selectionStage === "end"
        && Boolean(selection.start)
        && !selection.end
        && day.iso <= selection.start;
      const disabled = disabledByBounds || disabledByFlow;
      const isStart = day.iso === selection.start
        || day.iso === selection.departureStart
        || day.iso === selection.returnStart;
      const isEnd = (
        (day.iso === selection.end && selection.end !== selection.start)
        || (day.iso === selection.departureEnd && selection.departureEnd !== selection.departureStart)
        || (day.iso === selection.returnEnd && selection.returnEnd !== selection.returnStart)
      );
      const isBetween = (
        selection.start
        && selection.end
        && day.iso > selection.start
        && day.iso < selection.end
      ) || (
        selection.departureStart
        && selection.departureEnd
        && day.iso > selection.departureStart
        && day.iso < selection.departureEnd
      ) || (
        selection.returnStart
        && selection.returnEnd
        && day.iso > selection.returnStart
        && day.iso < selection.returnEnd
      );
      const classes = [
        "calendar-day",
        day.inMonth ? "" : "calendar-day--outside",
        day.iso === today ? "calendar-day--today" : "",
        isStart ? "is-start" : "",
        isEnd ? "is-end" : "",
        isBetween ? "is-between" : "",
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
  resetCalendarSelectionStage();
  resetCalendarViewMonth();
  calendarPopover.classList.remove("hidden");
  renderCalendarPopover();
}

function closeCalendarPopover() {
  calendarPopover?.classList.add("hidden");
}

function clearCalendarSelection() {
  dateTrigger?.classList.remove("is-invalid");
  if (isFixedRangesFlexibleMode()) {
    $("departureStart").value = "";
    $("departureEnd").value = "";
    $("returnStart").value = "";
    $("returnEnd").value = "";
  } else if (state.flexMode) {
    $("departureStart").value = "";
    $("departureEnd").value = "";
    $("returnStart").value = "";
    $("returnEnd").value = "";
  } else {
    $("departureDate").value = "";
    $("returnDate").value = "";
  }
  resetCalendarSelectionStage();
  syncDateTriggerText();
  renderCalendarPopover();
}

function applyCalendarSelection(iso) {
  if (!iso) return;

  if (isFixedRangesFlexibleMode()) {
    const departureStart = controlValue("departureStart");
    const departureEnd = controlValue("departureEnd");
    const returnStart = controlValue("returnStart");
    const stage = calendarState.selectionStage;

    if (stage === "departure-start" || !departureStart || (departureStart && departureEnd && returnStart && controlValue("returnEnd"))) {
      $("departureStart").value = iso;
      $("departureEnd").value = "";
      $("returnStart").value = "";
      $("returnEnd").value = "";
      calendarState.selectionStage = "departure-end";
    } else if (stage === "departure-end") {
      const nextStart = iso < departureStart ? iso : departureStart;
      const nextEnd = iso < departureStart ? departureStart : iso;
      $("departureStart").value = nextStart;
      $("departureEnd").value = nextEnd;
      $("returnStart").value = "";
      $("returnEnd").value = "";
      calendarState.selectionStage = "return-start";
    } else if (stage === "return-start" || !returnStart) {
      $("returnStart").value = iso;
      $("returnEnd").value = "";
      calendarState.selectionStage = "return-end";
    } else {
      const nextStart = iso < returnStart ? iso : returnStart;
      const nextEnd = iso < returnStart ? returnStart : iso;
      $("returnStart").value = nextStart;
      $("returnEnd").value = nextEnd;
      calendarState.selectionStage = "departure-start";
      closeCalendarPopover();
    }

    syncDateTriggerText();
    renderCalendarPopover();
    return;
  }

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
  const providerIds = defaultProviderIds(request);
  const providerId = providerIds[0];
  const providerName = providerLabelList(providerIds);
  const leg = request.legs?.[0];
  const departures = enumerateIsoRange(leg.departureStart, leg.departureEnd);
  const requestedAt = new Date().toISOString();
  const pairs = request.tripType === "round-trip"
    ? enumerateUsefulRoundTripPairs(request)
    : [];
  const axes = request.tripType === "round-trip"
    ? enumerateRoundTripFlexibleAxes(request, pairs)
    : {
        departureDates: departures,
        returnDates: [],
      };
  const cells = request.tripType === "one-way"
    ? departures.map((departureDate) => ({
        key: departureDate,
        departureDate,
        confidence: "loading",
        providerSource: providerId,
        selectable: false,
        requiresRequery: true,
        stateCode: "ind",
        tooltip: providerLoadingCopy(providerIds),
        derivedRequest: {
          ...request,
          tripType: "one-way",
          searchMode: "exact",
          flexibleMode: undefined,
          legs: [{ origin: leg.origin, destination: leg.destination, departureDate }],
        },
      }))
    : pairs.map(({ departureDate, returnDate, stayNights }) => ({
        key: `${departureDate}_${returnDate}`,
        departureDate,
        returnDate,
        stayNights,
        confidence: "loading",
        providerSource: providerId,
        selectable: false,
        requiresRequery: true,
        stateCode: "ind",
        tooltip: providerLoadingCopy(providerIds),
        derivedRequest: {
          ...request,
          tripType: "round-trip",
          searchMode: "exact",
          flexibleMode: undefined,
          legs: [{ origin: leg.origin, destination: leg.destination, departureDate, returnDate }],
        },
      }));

  return {
    matrixJobId: null,
    matrixComplete: false,
    matrixStatus: "running",
    request,
    cells,
    axes,
    confidenceSummary: summarizeMatrixConfidence(cells),
    recommendations: [
      `Matrix loading from ${providerName} with useful date combinations only.`,
      "Prices appear as each useful date combination resolves.",
    ],
    searchMeta: {
      requestedAt,
      completedAt: requestedAt,
      providersUsed: providerIds,
      warnings: [`Matrix loading from ${providerName} with useful date combinations only.`],
      partial: true,
      searchState: "search_partial",
    },
    providerMeta: {
      exactProvider: providerId,
      coverageMode: request.coverageMode,
    },
    warnings: [`Matrix loading from ${providerName} with useful date combinations only.`],
  };
}

function buildPendingSearchResponse(request, sortMode) {
  const providerIds = defaultProviderIds(request);
  const providerId = providerIds[0];
  const providerName = providerLabelList(providerIds);
  const requestedAt = new Date().toISOString();
  return {
    searchJobId: null,
    searchComplete: false,
    searchStatus: "running",
    request,
    sortMode,
    serverOffers: [],
    offers: [],
    allOffers: [],
    filteredOffers: [],
    searchMeta: {
      requestedAt,
      completedAt: requestedAt,
      providersUsed: providerIds,
      warnings: [`Consultando ${providerName}. Los resultados se iran agregando.`],
      partial: true,
      searchState: "search_partial",
    },
    providerMeta: {
      exactProvider: providerId,
      coverageMode: request.coverageMode,
    },
    warnings: [`Consultando ${providerName}. Los resultados se iran agregando.`],
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

function selMatrixCell() {
  if (!state.selectedMatrixKey) return null;
  return state.matrixResponse?.cells?.find((cell) => cell.key === state.selectedMatrixKey) ?? null;
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

  if (item.id === "layoverFilter" && trigger instanceof HTMLElement && text instanceof HTMLElement) {
    const emptyLabel = text.dataset.emptyLabel?.trim() || text.textContent?.trim() || "";
    const stopsSelect = $("maxStopsFilter");
    const layoverSelect = $("maxLayoverMinutes");
    if (stopsSelect instanceof HTMLSelectElement && layoverSelect instanceof HTMLSelectElement) {
      const stopLabels = [...stopsSelect.options]
        .map((option) => compactStopsLabel(option.value))
        .filter(Boolean);
      const timeLabels = [...layoverSelect.options]
        .map((option) => {
          const configured = LAYOVER_TIME_OPTIONS.find((entry) => entry.value === option.value);
          return configured?.compactLabel ?? option.textContent?.trim() ?? "";
        })
        .filter(Boolean);
      const comboLabels = stopLabels.flatMap((stopLabel) => timeLabels.map((timeLabel) => `${stopLabel}/${timeLabel}`));
      const candidateLabels = [emptyLabel, ...stopLabels, ...timeLabels, ...comboLabels];
      return Math.max(
        intrinsicWidth,
        measureTriggerWidthForLabels(trigger, ".refinement__text", [...new Set(candidateLabels)]),
      );
    }
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
  const stopsSelect = $("maxStopsFilter");
  const layoverSelect = $("maxLayoverMinutes");
  if (!(stopsSelect instanceof HTMLSelectElement) || !(layoverSelect instanceof HTMLSelectElement)) return;

  const selectedStops = [...stopsSelect.options].find((option) => option.value === stopsSelect.value) ?? stopsSelect.options[0];
  const selectedLayover = [...layoverSelect.options].find((option) => option.value === layoverSelect.value) ?? layoverSelect.options[0];
  const layoverOption = LAYOVER_TIME_OPTIONS.find((option) => option.value === layoverSelect.value);
  const layoverCompactLabel = layoverOption?.compactLabel ?? selectedLayover?.textContent?.trim().replace("Hasta ", "") ?? "";
  const stopSummary = compactStopsLabel(stopsSelect.value);
  const layoverSummary = layoverSelect.value === "" ? "" : layoverCompactLabel;

  const activeStopFilter = stopsSelect.value !== "";
  const activeLayoverFilter = layoverSelect.value !== "";
  let activeSummary = "";
  if (activeStopFilter && activeLayoverFilter) {
    activeSummary = `${stopSummary}/${layoverSummary}`;
  } else if (activeStopFilter) {
    activeSummary = stopSummary;
  } else if (activeLayoverFilter) {
    activeSummary = layoverSummary;
  }

  if (layoverTriggerValue) {
    const emptyLabel = layoverTriggerValue.dataset.emptyLabel?.trim() || "Escala";
    layoverTriggerValue.textContent = emptyLabel;
  }

  const fullStopSummary = stopsSelect.value === "" ? "" : selectedStops?.textContent?.trim() ?? "";
  const fullLayoverSummary = layoverSelect.value === "" ? "" : layoverCompactLabel;
  const fullSummary = fullStopSummary && fullLayoverSummary
    ? `${fullStopSummary} / ${fullLayoverSummary}`
    : fullStopSummary || fullLayoverSummary;

  if (layoverFilter) {
    layoverFilter.classList.toggle("is-active", Boolean(activeSummary));
  }
  if (layoverTrigger) {
    layoverTrigger.title = fullSummary || "Escala";
    layoverTrigger.setAttribute(
      "aria-label",
      fullSummary ? `Configurar filtro de escala (${fullSummary})` : "Configurar filtro de escala",
    );
  }

  layoverPopover?.querySelectorAll("[data-max-stops-value]").forEach((option) => {
    const isSelected = option instanceof HTMLElement && option.dataset.maxStopsValue === stopsSelect.value;
    option.classList.toggle("is-selected", isSelected);
    option.setAttribute("aria-pressed", String(isSelected));
  });
  layoverPopover?.querySelectorAll("[data-layover-value]").forEach((option) => {
    const isSelected = option instanceof HTMLElement && option.dataset.layoverValue === layoverSelect.value;
    option.classList.toggle("is-selected", isSelected);
    option.setAttribute("aria-pressed", String(isSelected));
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

function setLayoverFilterValue({ maxStops = "", maxLayoverMinutes = "" } = {}) {
  const stopsSelect = $("maxStopsFilter");
  const layoverSelect = $("maxLayoverMinutes");
  if (!(stopsSelect instanceof HTMLSelectElement) || !(layoverSelect instanceof HTMLSelectElement)) return;

  if (stopsSelect.value !== maxStops) {
    stopsSelect.value = maxStops;
    stopsSelect.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (layoverSelect.value !== maxLayoverMinutes) {
    layoverSelect.value = maxLayoverMinutes;
    layoverSelect.dispatchEvent(new Event("change", { bubbles: true }));
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
  const stopsSelect = $("maxStopsFilter");
  const layoverSelect = $("maxLayoverMinutes");
  if (
    !layoverFilter ||
    !layoverTrigger ||
    !layoverPopover ||
    !(stopsSelect instanceof HTMLSelectElement) ||
    !(layoverSelect instanceof HTMLSelectElement)
  ) return;

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
    const option = event.target.closest("[data-layover-value], [data-max-stops-value]");
    if (!option) return;
    event.preventDefault();
    if (!(option instanceof HTMLElement)) return;
    setLayoverFilterValue({
      maxStops: option.dataset.maxStopsValue ?? stopsSelect.value,
      maxLayoverMinutes: option.dataset.layoverValue ?? layoverSelect.value,
    });
  });

  document.addEventListener("click", (event) => {
    if (!layoverPopover.contains(event.target) && event.target !== layoverTrigger && !layoverTrigger.contains(event.target)) {
      closeLayoverPopover();
    }
  });

  stopsSelect.addEventListener("change", syncLayoverFilterUi);
  layoverSelect.addEventListener("change", syncLayoverFilterUi);
}

function readMaxStopsFilter() {
  const raw = controlValue("maxStopsFilter");
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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
        if (tripType.value === "round-trip") {
          if (isFixedRangesFlexibleMode()) {
            $("returnDate").value = $("returnStart").value || $("returnEnd").value || "";
          } else if ($("departureStart").value) {
            $("returnDate").value = addDaysIso($("departureStart").value, currentStayNights());
          }
        }
      }

      resetCalendarSelectionStage();
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
      resetCalendarSelectionStage();
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

  stayNightsEl?.addEventListener("change", () => {
    syncDateTriggerText();
    if (!calendarPopover.classList.contains("hidden")) renderCalendarPopover();
  });

  document.querySelectorAll("[data-flex-submode]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!flexibleMode) return;
      flexibleMode.value = button.dataset.flexSubmode === "fixed-ranges"
        ? "fixed-ranges"
        : "exact-stay";
      resetCalendarSelectionStage();
      updateModeFields();
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
  const depStart = $("departureStart")?.value;
  const depEnd = $("departureEnd")?.value;
  if (!depStart || !depEnd) return payload;
  const leg = payload.request.legs[0];
  leg.departureStart = depStart;
  leg.departureEnd = depEnd;
  if (payload.request.tripType === "round-trip") {
    payload.request.searchMode = "roundtrip-grid";
    payload.request.flexibleMode = activeFlexibleRoundTripMode();
    leg.stayNights = isExactStayFlexibleMode() ? currentStayNights() : undefined;
    leg.minNights = undefined;
    leg.maxNights = undefined;
    if (isFixedRangesFlexibleMode()) {
      leg.returnStart = $("returnStart")?.value ?? "";
      leg.returnEnd = $("returnEnd")?.value ?? "";
    } else {
      leg.returnStart = "";
      leg.returnEnd = "";
    }
  } else {
    payload.request.searchMode = "stay-range";
    payload.request.flexibleMode = undefined;
    leg.stayNights = undefined;
    leg.minNights = undefined;
    leg.maxNights = undefined;
  }
  return payload;
}

/* ================================================================
   INPUT ENFORCEMENT — real-time, preventive
   ================================================================ */

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

  if (stayNightsEl) enforceIntRange(stayNightsEl, 1, 90);

  const dateIds = ["departureDate", "returnDate", "departureStart", "departureEnd", "returnStart", "returnEnd"];
  dateIds.forEach((id) => {
    const input = $(id);
    enforceDateNotPast(input);
    input?.addEventListener("change", () => {
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
  const max = maxDateISO();

  searchForm.querySelectorAll(".is-invalid").forEach((el) => el.classList.remove("is-invalid"));

  const origin = $("origin").value;
  const dest = $("destination").value;
  const originCode = resolvedLocationCode("origin");
  const destinationCode = resolvedLocationCode("destination");

  if (!originCode) { errs.push("Origen: selecciona una sugerencia válida o escribe un IATA valido."); $("origin").classList.add("is-invalid"); }
  if (!destinationCode) { errs.push("Destino: selecciona una sugerencia válida o escribe un IATA valido."); $("destination").classList.add("is-invalid"); }
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
    if (!isValidIsoDate(v)) {
      errs.push(`${label} debe usar una fecha valida en formato AAAA-MM-DD.`);
      el.classList.add("is-invalid");
      return false;
    }
    if (v < today) { errs.push(`${label} no puede ser pasada.`); el.classList.add("is-invalid"); return false; }
    if (v > max) {
      errs.push(`${label} debe estar entre ${allowedDateWindowText()}.`);
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
    checkDate("departureStart", "Ventana inicio");
    checkDate("departureEnd", "Ventana fin");
    const ds = $("departureStart")?.value;
    const de = $("departureEnd")?.value;
    if (ds && de && de < ds) errs.push("Ventana fin debe ser >= ventana inicio.");

    if (trip === "round-trip") {
      if (isExactStayFlexibleMode()) {
        const stayNights = parseInt(stayNightsEl?.value, 10);
        if (isNaN(stayNights) || stayNights < 1) {
          errs.push("Estadía requerida.");
        }
      } else {
        checkDate("returnStart", "Vuelta inicio");
        checkDate("returnEnd", "Vuelta fin");
        const rs = $("returnStart")?.value;
        const re = $("returnEnd")?.value;
        if (rs && re && re < rs) errs.push("Vuelta fin debe ser >= vuelta inicio.");
      }
    }
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
  const showFlexibleSubmode = isFlexible && tripType.value === "round-trip";
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === (isFlexible ? "flexible" : "exact"));
  });
  document.querySelectorAll("[data-trip]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.trip === tripType.value);
  });
  document.querySelectorAll("[data-flex-submode]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.flexSubmode === activeFlexibleRoundTripMode());
  });

  searchMode.value = isFlexible
    ? tripType.value === "round-trip" ? "roundtrip-grid" : "stay-range"
    : "exact";

  if (!showFlexibleSubmode && flexibleMode) {
    flexibleMode.value = "exact-stay";
  }

  calendarFlexModeControl?.classList.toggle("hidden", !showFlexibleSubmode);
  calendarStayConfig?.classList.toggle("hidden", !isExactStayFlexibleMode());

  if (!isFlexible || tripType.value === "one-way" || isExactStayFlexibleMode()) {
    $("returnStart").value = "";
    $("returnEnd").value = "";
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
  const roundTripFlexibleMode = isFlexibleRoundTripMode() ? activeFlexibleRoundTripMode() : undefined;
  syncResultsPageSize();
  const shouldCapVisiblePages = m !== "roundtrip-grid";
  const maxResults = shouldCapVisiblePages
    ? Math.max(1, state.resultsPageSize || RESULTS_PAGE_SIZE) * RESULTS_MAX_PAGES
    : undefined;
  return {
    sortMode: String(fd.get("sortMode") || "cheapest"),
    providerConfig: normalizeClipboardProviderConfig(state.providerConfig) || undefined,
    request: {
      tripType: t,
      searchMode: m,
      flexibleMode: roundTripFlexibleMode,
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
        maxStops: readMaxStopsFilter(),
        maxLayoverMinutes: readMaxLayoverFilter(),
        maxResults,
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
        stayNights: roundTripFlexibleMode === "exact-stay" ? currentStayNights() : undefined,
      }],
    },
  };
}

/* ================================================================
   API
   ================================================================ */

function totalDurationMinutes(offer) {
  return (offer.itineraries || []).reduce((sum, itinerary) => sum + (itinerary.durationMinutes || 0), 0);
}

function totalStopsCount(offer) {
  return (offer.itineraries || []).reduce((sum, itinerary) => sum + (itinerary.stops || 0), 0);
}

function maxStopsAcrossItineraries(offer) {
  return (offer?.itineraries || []).reduce((max, itinerary) => Math.max(max, itinerary?.stops || 0), 0);
}

function compareOffersForScaleFilters(left, right, filters = {}) {
  const hasStopsPriority = typeof filters.maxStops === "number" || typeof filters.maxLayoverMinutes === "number";
  const hasLayoverPriority = typeof filters.maxLayoverMinutes === "number";

  if (hasStopsPriority) {
    const maxStopsDiff = maxStopsAcrossItineraries(left) - maxStopsAcrossItineraries(right);
    if (maxStopsDiff !== 0) return maxStopsDiff;

    const totalStopsDiff = totalStopsCount(left) - totalStopsCount(right);
    if (totalStopsDiff !== 0) return totalStopsDiff;
  }

  if (hasLayoverPriority) {
    const layoverDiff = maxLayoverMinutesForOffer(left) - maxLayoverMinutesForOffer(right);
    if (layoverDiff !== 0) return layoverDiff;
  }

  return 0;
}

function compareOffersForSortMode(left, right, mode, filters = {}) {
  const scaleDiff = compareOffersForScaleFilters(left, right, filters);
  if (scaleDiff !== 0) return scaleDiff;

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
    maxStops: readMaxStopsFilter(),
    maxLayoverMinutes: readMaxLayoverFilter(),
  };
}

function comparableClientFilters(filters = {}) {
  return {
    nonStop: filters?.nonStop === true,
    baggageRequired: filters?.baggageRequired === true,
    maxStops: typeof filters?.maxStops === "number" ? Math.max(0, filters.maxStops) : null,
    maxLayoverMinutes: typeof filters?.maxLayoverMinutes === "number" ? filters.maxLayoverMinutes : null,
  };
}

function activeClientFiltersMatchRequestFilters(
  filters = getActiveClientFilters(),
  requestFilters = state.searchResponse?.request?.filters ?? state.request?.filters ?? {},
) {
  const left = comparableClientFilters(filters);
  const right = comparableClientFilters(requestFilters);
  return left.nonStop === right.nonStop
    && left.baggageRequired === right.baggageRequired
    && left.maxStops === right.maxStops
    && left.maxLayoverMinutes === right.maxLayoverMinutes;
}

function offersForClientControls(filters = getActiveClientFilters()) {
  if (!state.searchResponse) {
    return [];
  }

  if (activeClientFiltersMatchRequestFilters(filters, state.searchResponse.request?.filters)) {
    return state.searchResponse.serverOffers ?? state.searchResponse.offers ?? [];
  }

  return state.searchResponse.allOffers ?? state.searchResponse.offers ?? [];
}

function applyClientOfferControls() {
  if (!state.searchResponse) return;
  const sortMode = controlValue("sortMode") || state.sortMode || "cheapest";
  const filters = getActiveClientFilters();
  let offers = getOffersForVisibleFacets(offersForClientControls(filters), filters);

  const { hidden, only } = state.airlineFilter;
  offers = offers.filter((offer) => {
    const mainCarrier = offer.mainCarrier || offer.validatingCarrier || "";
    if (only !== null && mainCarrier !== only) return false;
    if (only === null && hidden.size > 0 && hidden.has(mainCarrier)) return false;
    return true;
  });

  offers.sort((left, right) => compareOffersForSortMode(left, right, sortMode, filters));

  state.searchResponse.filteredOffers = offers;
  const groupedOffers = buildOfferGroups(offers);
  state.searchResponse.filteredOfferGroups = groupedOffers;
  const totalPages = resultsPageCount(groupedOffers.length);
  state.resultsPage = Math.min(Math.max(1, state.resultsPage), totalPages);
  const pageSize = Math.max(1, Math.trunc(state.resultsPageSize) || RESULTS_PAGE_SIZE);
  const start = (state.resultsPage - 1) * pageSize;
  const visibleOfferGroups = groupedOffers.slice(start, start + pageSize);
  state.searchResponse.visibleOfferGroups = visibleOfferGroups;
  state.searchResponse.offers = visibleOfferGroups.flat();

  const previousSelectedOfferId = state.selectedOfferId;
  if (!state.searchResponse.offers.some((offer) => offer.id === state.selectedOfferId)) {
    state.selectedOfferId = state.searchResponse.offers[0]?.id ?? offers[0]?.id ?? null;
  }
  if (previousSelectedOfferId !== state.selectedOfferId) {
    clearQuotationState();
  }

}

function getOffersForVisibleFacets(allOffers, filters = getActiveClientFilters()) {
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
    serverOffers: data.offers ?? [],
    allOffers: data.allOffers ?? data.offers ?? [],
    offers: data.offers ?? [],
    filteredOffers: data.allOffers ?? data.offers ?? [],
    visibleOfferGroups: data.visibleOfferGroups ?? [],
  };
  applyClientOfferControls();
}

function clearQuotationState() {
  state.quotationText = "";
  if (state.detailPendingAction === "quotation") {
    state.detailPendingAction = null;
  }
}

function selectOffer(offerId) {
  const nextOfferId = offerId ?? null;
  if (state.selectedOfferId !== nextOfferId) {
    clearQuotationState();
  }
  state.selectedMatrixKey = null;
  state.selectedOfferId = nextOfferId;
  renderResultsArea();
  renderDetailPanel();
}

function queueSearchPoll(jobId) {
  if (!jobId) return;
  state.searchJobId = jobId;
  if (state.searchPollHandle) clearTimeout(state.searchPollHandle);
  state.searchPollHandle = scheduleJsonPoll({
    delayMs: 700,
    run: async () => {
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
    },
  });
}

function queueMatrixPoll(jobId) {
  if (!jobId) return;
  state.matrixJobId = jobId;
  if (state.matrixPollHandle) clearTimeout(state.matrixPollHandle);
  state.matrixPollHandle = scheduleJsonPoll({
    delayMs: 700,
    run: async () => {
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
    },
  });
}

/* ================================================================
   RENDER
   ================================================================ */

function renderToolbar() {
  const active = state.searchResponse ?? state.matrixResponse;
  if (!active) {
    if (runtimeBadge) { runtimeBadge.textContent = "Listo"; runtimeBadge.className = "badge"; }
    if (resultPill) { resultPill.textContent = "0"; resultPill.className = "badge badge--accent"; }
    return;
  }
  const runtimeCopy = runtimeBadgeCopy(active);
  const status = active.matrixStatus ?? active.searchStatus ?? active.searchMeta?.searchState ?? "";
  if (runtimeBadge) {
    runtimeBadge.textContent = runtimeCopy;
    runtimeBadge.className = status === "running" || status === "search_partial"
      ? "badge badge--accent"
      : status === "search_failed" || status === "failed"
        ? "badge badge--danger"
        : "badge badge--success";
  }
  if (resultPill) {
    resultPill.textContent = state.searchResponse
      ? `${state.searchResponse.filteredOfferGroups?.length ?? 0} ofertas`
      : flexibleCombinationLabel(state.matrixResponse?.cells?.length ?? 0);
    resultPill.className = "badge badge--accent";
  }
}

function updateResultsToolbar() {
  const total = state.searchResponse?.filteredOfferGroups?.length ?? 0;
  const hasListResults = (state.searchResponse?.allOffers?.length ?? 0) > 0;
  const hasMatrix = (state.matrixResponse?.cells?.length ?? 0) > 0;
  const hasMatrixCalendar = hasMatrix && canRenderMatrixCalendar();
  const matrixCellCount = state.matrixResponse?.cells?.length ?? 0;
  const isSearchRunning = state.searchResponse?.searchStatus === "running";
  const panelMeta = buildResultsPanelMeta({
    hasMatrix,
    matrixCellCount,
  });

  if (resultsPanelTitle && resultsPanelMeta) {
    if (hasMatrix) {
      resultsPanelTitle.textContent = "Flexible";
    } else if (state.searchResponse) {
      if (isSearchRunning) {
        resultsPanelTitle.textContent = "Buscando";
      } else if (total > 0) {
        resultsPanelTitle.textContent = "Resultados";
      } else {
        resultsPanelTitle.textContent = "Sin resultados";
      }
    } else {
      resultsPanelTitle.textContent = "Consulta";
    }

    resultsPanelMeta.textContent = panelMeta;
    resultsPanelMeta.classList.toggle("hidden", !panelMeta);
  }

  if (sortButtonsEl) {
    sortButtonsEl.querySelectorAll("[data-sort]").forEach(btn => {
      btn.classList.toggle("is-active", btn.dataset.sort === (state.sortMode || "cheapest"));
      btn.disabled = !hasListResults;
    });
    sortButtonsEl.classList.toggle("is-disabled", !hasListResults);
  }

  if (viewToggle) {
    if (!hasMatrixCalendar && state.viewMode === "calendar") {
      state.viewMode = "list";
    }
    viewToggle.classList.toggle("hidden", !hasMatrixCalendar);
    viewToggle.querySelectorAll("[data-view]").forEach(btn => {
      btn.classList.toggle("is-active", btn.dataset.view === state.viewMode);
    });
  }

  if (resultsPagerEl) {
    const totalPages = resultsPageCount(total);
    const showPager = hasListResults && totalPages > 1;
    const showPagerPlaceholder = Boolean(state.searchResponse) && isSearchRunning && !showPager;
    resultsPagerEl.classList.toggle("hidden", !showPager && !showPagerPlaceholder);
    resultsPagerEl.innerHTML = showPager
      ? buildResultsPagerHtml(state.resultsPage, totalPages)
      : showPagerPlaceholder
        ? buildResultsPagerHtml(1, 1, { placeholder: true })
        : "";
  }

  syncMatrixExpandedUI();
}

function renderResults() {
  if (!resultsContainer) return;
  captureResultsScroll(resultsContainer);
  if (!state.searchResponse) {
    renderResultsSkeleton({ busy: false });
    return;
  }

  const offers = state.searchResponse?.offers ?? [];
  const visibleOfferGroups = state.searchResponse?.visibleOfferGroups ?? buildOfferGroups(offers);
  const total = state.searchResponse?.filteredOfferGroups?.length
    ?? buildOfferGroups(state.searchResponse?.filteredOffers ?? state.searchResponse?.allOffers ?? offers).length;
  const isRunning = state.searchResponse?.searchStatus === "running";

  if (offers.length === 0 && !isRunning) {
    resultsContainer.innerHTML = renderEmptyPanel(emptySearchPanelModel(state.searchResponse));
    return;
  }

  if (offers.length === 0 && isRunning) {
    renderResultsSkeleton({ busy: true });
    return;
  }

  let html = "";

  html += `<div class="table-wrap" aria-live="polite" aria-busy="${isRunning ? "true" : "false"}"><table class="results-table">${buildResultsTableHeaderHtml()}<tbody>`;
  const providerLinkIndex = buildProviderLinkIndex(state.searchResponse?.allOffers ?? offers);
  const passengerCount = passengerCountForRequest(state.searchResponse?.request ?? state.request);

  visibleOfferGroups.forEach((group) => {
    const o = group.find(g => g.id === state.selectedOfferId) ?? group[0];
    const dateSummary = buildGroupDateSummary(group, state.selectedOfferId);
    const isActive = group.some(g => g.id === state.selectedOfferId);
    const badge = group.length > 1
      ? ` <span class="badge badge--accent badge--group-count" title="${group.length} fechas equivalentes">${group.length}</span>`
      : "";
    const bagCarry = `<svg class="ico ico--xs ${o.baggage?.carryOnIncluded ? "ico--bag-yes" : "ico--bag-no"}"><use href="#ico-carry-on"/></svg>`;
    const bagCheck = `<svg class="ico ico--xs ${o.baggage?.checkedIncluded ? "ico--bag-yes" : "ico--bag-no"}"><use href="#ico-luggage"/></svg>`;
    const carrier = carrierDisplayParts(o);
    const rowLabel = [
      isActive ? "Oferta seleccionada" : "Seleccionar oferta",
      carrier.display,
      dateSummary.primary,
      formatDuration(o.comparisonMetrics?.totalDurationMinutes),
      priceLabels(o.price?.total, passengerCount).combinedLabel,
    ].filter(Boolean).join(" · ");

    html += `<tr data-oid="${o.id}" class="${isActive ? "is-active" : ""}" tabindex="0" role="button" aria-label="${escapeHtml(rowLabel)}">`;
    html += `<td><span class="cell-main carrier-label" title="${escapeHtml(carrier.display)}">${escapeHtml(carrier.display)}</span></td>`;
    html += `<td title="${escapeHtml(dateSummary.title)}"><div class="results-date-stack"><span class="cell-main">${escapeHtml(dateSummary.primary)}${badge}</span>${dateSummary.secondary ? `<span class="cell-sub">${escapeHtml(dateSummary.secondary)}</span>` : '<span class="cell-sub cell-sub--ghost" aria-hidden="true">&nbsp;</span>'}</div></td>`;
    html += `<td>${formatDuration(o.comparisonMetrics?.totalDurationMinutes)}</td>`;
    html += `<td>${renderStopsSummary(o)}</td>`;
    html += `<td><span class="baggage-icons">${bagCarry}${bagCheck}</span></td>`;
    html += `<td class="results-price">${renderPriceBreakdownHtml(o.price?.total, passengerCount, { totalSuffix: " total" })}</td>`;
    html += `<td>${renderProviderLinksCell(o, providerLinkIndex)}</td>`;
    html += `</tr>`;
  });

  html += '</tbody></table></div>';

  resultsContainer.innerHTML = html;
  const resultsWrap = resultsContainer.querySelector(".table-wrap");
  const pageSizeChanged = syncResultsPageSize();
  if (pageSizeChanged && state.searchResponse?.allOffers?.length) {
    applyClientOfferControls();
    renderResultsArea();
    renderDetailPanel();
    updateResultsToolbar();
    return;
  }
  syncResultsScroll(resultsWrap);
  requestAnimationFrame(() => syncResultsScroll(resultsWrap));
  resultsWrap?.addEventListener("scroll", handleResultsScroll, { passive: true });
  resultsWrap?.addEventListener("wheel", markPollingUiInteraction, { passive: true });
  resultsWrap?.addEventListener("pointerdown", () => {
    state.pollPointerDown = true;
    markPollingUiInteraction();
  });
}

function renderSearchResultsViewport({ includeAirlineBar = false } = {}) {
  cancelPendingPollRender();
  renderToolbar();
  if (includeAirlineBar) {
    renderAirlineBar();
  }
  renderResultsArea();
  renderDetailPanel();
  updateResultsToolbar();
  syncWorkspaceViewportHeight();
}

function handleResultsClick(e) {
  const pager = e.target.closest("[data-results-page]");
  if (pager) {
    const total = state.searchResponse?.filteredOfferGroups?.length ?? 0;
    const totalPages = resultsPageCount(total);
    markPollingUiInteraction();
    state.resultsScroll = { top: 0, left: 0 };
    if (pager.dataset.resultsPage === "prev") {
      state.resultsPage = Math.max(1, state.resultsPage - 1);
    } else if (pager.dataset.resultsPage === "next") {
      state.resultsPage = Math.min(totalPages, state.resultsPage + 1);
    }
    applyClientOfferControls();
    renderSearchResultsViewport();
    return;
  }

  const flexibleRow = e.target.closest("tr[data-flex-cell-key]");
  if (flexibleRow) {
    selectMatrixCell(flexibleRow.dataset.flexCellKey);
    return;
  }

  const matrixRow = e.target.closest("[data-mk]");
  if (matrixRow) {
    void handleMatrixClick({ target: matrixRow });
    return;
  }

  if (e.target.closest("[data-stop-row]")) return;
  const row = e.target.closest("tr[data-oid]");
  if (!row) return;
  selectOffer(row.dataset.oid);
}

function focusAdjacentResultsRow(currentRow, step, selector = "tr[data-oid]") {
  const rows = [...resultsContainer?.querySelectorAll(selector) ?? []];
  const currentIndex = rows.indexOf(currentRow);
  if (currentIndex < 0) {
    return;
  }

  rows[currentIndex + step]?.focus();
}

function handleResultsKeydown(e) {
  const flexibleRow = e.target.closest("tr[data-flex-cell-key]");
  if (flexibleRow) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectMatrixCell(flexibleRow.dataset.flexCellKey);
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusAdjacentResultsRow(flexibleRow, 1, "tr[data-flex-cell-key]");
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      focusAdjacentResultsRow(flexibleRow, -1, "tr[data-flex-cell-key]");
    }
    return;
  }

  const matrixRow = e.target.closest("tr[data-mk]");
  if (matrixRow) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void handleMatrixClick({ target: matrixRow });
    }
    return;
  }

  if (e.target.closest("[data-stop-row]")) return;
  const row = e.target.closest("tr[data-oid]");
  if (!row) return;

  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    selectOffer(row.dataset.oid);
    return;
  }

  if (e.key === "ArrowDown") {
    e.preventDefault();
    focusAdjacentResultsRow(row, 1);
    return;
  }

  if (e.key === "ArrowUp") {
    e.preventDefault();
    focusAdjacentResultsRow(row, -1);
  }
}

function selectMatrixCell(cellKey) {
  if (!cellKey) return;
  state.selectedOfferId = null;
  state.selectedMatrixKey = cellKey;
  renderResultsArea();
  renderDetailPanel();
}

function flexibleCellStateLabel(cell) {
  switch (cell?.confidence) {
    case "validated":
      return "Confirmado";
    case "live":
      return "Disponible";
    case "indicative":
      return "Indicativo";
    case "loading":
      return "Cargando";
    case "unavailable":
      return "Sin resultado";
    case "empty":
      return "No consultable";
    default:
      return "Pendiente";
  }
}

function flexibleCellHeroLabel(cell) {
  if (cell?.price) {
    return formatMoney(cell.price);
  }

  return flexibleCellStateLabel(cell);
}

function flexibleCellRequest(cell) {
  return matrixDerivedSearchRequest(cell?.derivedRequest) ?? state.matrixResponse?.request ?? null;
}

function matrixCellPurchasePaths(cell) {
  return (cell?.purchasePaths ?? []).filter((path) => pathSupportsEquivalentSearch(path));
}

function matrixCellExternalActionLabel(path) {
  return path?.provider === "costamar" ? "Abrir en Costamar" : "Abrir en Agil";
}

function matrixCellExactRouteSummary(cell) {
  return toolbarRouteSummary(flexibleCellRequest(cell)) || [cell?.departureDate, cell?.returnDate].filter(Boolean).join(" · ");
}

function matrixCellExactDateSummary(cell) {
  const request = flexibleCellRequest(cell);
  const summary = toolbarDateSummary(request);
  if (summary) {
    return summary;
  }

  if (cell?.departureDate && cell?.returnDate) {
    return `${formatDateCompact(cell.departureDate)} → ${formatDateCompact(cell.returnDate)}`;
  }

  return cell?.departureDate ? formatDateCompact(cell.departureDate) : "—";
}

function flexibleCellFilterSummary(filters = {}) {
  const items = [];
  if (filters.nonStop) items.push("Directo");
  if (filters.baggageRequired) items.push("Con equipaje");
  if (typeof filters.maxStops === "number") {
    items.push(`Max. ${filters.maxStops} escala${filters.maxStops === 1 ? "" : "s"}`);
  }
  if (typeof filters.maxLayoverMinutes === "number" && filters.maxLayoverMinutes > 0) {
    items.push(`Escala max. ${formatDuration(filters.maxLayoverMinutes)}`);
  }
  return items.join(" · ") || "Sin filtros adicionales";
}

function flexibleCellSelectionCopy(cell) {
  if (cell?.selectable && cell?.derivedRequest) {
    return matrixCellPurchasePaths(cell).length > 0
      ? "Abrir exacta carga el detalle interno. El enlace externo abre la búsqueda equivalente en el proveedor."
      : "Esta combinación ya tiene consulta exacta interna, pero no hay un enlace externo utilizable para este proveedor.";
  }

  return cell?.tooltip || "Esta combinacion todavia no tiene una oferta exacta consultable.";
}

function flexibleCellSortRank(cell) {
  if (typeof cell?.price?.amount === "number") return 0;
  if (cell?.confidence === "loading") return 1;
  if (cell?.confidence === "unavailable") return 2;
  return 3;
}

function compareFlexibleListCells(left, right) {
  const leftHasPrice = typeof left?.price?.amount === "number";
  const rightHasPrice = typeof right?.price?.amount === "number";

  if (leftHasPrice && rightHasPrice) {
    const priceDiff = left.price.amount - right.price.amount;
    if (priceDiff !== 0) return priceDiff;
  } else if (leftHasPrice !== rightHasPrice) {
    return leftHasPrice ? -1 : 1;
  }

  const rankDiff = flexibleCellSortRank(left) - flexibleCellSortRank(right);
  if (rankDiff !== 0) return rankDiff;

  const departureDiff = String(left?.departureDate || "").localeCompare(String(right?.departureDate || ""));
  if (departureDiff !== 0) return departureDiff;

  return String(left?.returnDate || "").localeCompare(String(right?.returnDate || ""));
}

function renderFlexibleList(container = resultsContainer) {
  if (!container) return;
  captureResultsScroll(container);
  const cells = state.matrixResponse?.cells ?? [];
  if (cells.length === 0) {
    container.innerHTML = renderEmptyPanel({
      eyebrow: "Flexible",
      title: "Sin combinaciones válidas",
      text: "La búsqueda flexible todavía no generó combinaciones consultables.",
      hint: "Ajusta la ventana, la estadía o la vuelta para abrir más opciones.",
      icon: "ico-calendar",
    });
    return;
  }

  const orderedCells = [...cells].sort(compareFlexibleListCells);
  const isRunning = state.matrixResponse?.matrixStatus === "running";
  let html = "";

  if (isRunning) {
    html += '<div class="results-loading"><span>Cargando combinaciones flexibles...</span></div>';
  }

  html += `
    <div class="table-wrap" aria-live="polite" aria-busy="${isRunning ? "true" : "false"}">
      <table class="results-table results-table--flexible">
        <thead>
          <tr>
            <th>Ida</th>
            <th>Vuelta</th>
            <th>Estadía</th>
            <th>Precio</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
  `;

  orderedCells.forEach((cell) => {
    const isActive = cell.key === state.selectedMatrixKey;
    const stayLabel = cell.stayNights != null ? `${cell.stayNights} noches` : "—";
    const passengerCount = passengerCountForRequest(flexibleCellRequest(cell) ?? state.matrixResponse?.request ?? state.request);
    const priceLabel = cell.confidence === "loading"
      ? "..."
      : priceLabels(cell.price, passengerCount).combinedLabel;
    const priceHtml = cell.confidence === "loading"
      ? "..."
      : cell.price
        ? renderPriceBreakdownHtml(cell.price, passengerCount, { totalSuffix: " total" })
        : "—";
    const stateLabel = flexibleCellStateLabel(cell);
    const rowLabel = [
      isActive ? "Combinacion seleccionada" : "Ver combinacion flexible",
      formatDateCompact(cell.departureDate),
      cell.returnDate ? formatDateCompact(cell.returnDate) : "",
      stayLabel,
      priceLabel,
      stateLabel,
    ].filter(Boolean).join(" · ");

    html += `
      <tr
        data-flex-cell-key="${cell.key}"
        data-mk="${cell.key}"
        class="${isActive ? "is-active" : ""} ${!cell.selectable ? "results-row--disabled" : ""}"
        tabindex="0"
        role="button"
        aria-label="${escapeHtml(rowLabel)}"
        aria-pressed="${isActive ? "true" : "false"}"
        title="${escapeHtml(cell.tooltip ?? "")}"
      >
        <td><span class="cell-main">${escapeHtml(formatDateCompact(cell.departureDate))}</span></td>
        <td><span class="cell-main">${escapeHtml(cell.returnDate ? formatDateCompact(cell.returnDate) : "—")}</span></td>
        <td><span class="cell-sub">${escapeHtml(stayLabel)}</span></td>
        <td class="results-price">${priceHtml}</td>
        <td><span class="cell-sub">${escapeHtml(stateLabel)}</span></td>
      </tr>
    `;
  });

  html += `
        </tbody>
      </table>
    </div>
  `;

  container.innerHTML = html;
  const resultsWrap = container.querySelector(".table-wrap");
  syncResultsScroll(resultsWrap);
  requestAnimationFrame(() => syncResultsScroll(resultsWrap));
  resultsWrap?.addEventListener("scroll", handleResultsScroll, { passive: true });
  resultsWrap?.addEventListener("wheel", markPollingUiInteraction, { passive: true });
  resultsWrap?.addEventListener("pointerdown", () => {
    state.pollPointerDown = true;
    markPollingUiInteraction();
  });
}

async function launchMatrixCellSearch(cellKey) {
  const cells = state.matrixResponse?.cells ?? [];
  const cell = cells.find((entry) => entry.key === cellKey);
  if (!cell?.selectable || !cell.derivedRequest) return;
  const derivedRequest = matrixDerivedSearchRequest(cell.derivedRequest);
  submitButton.disabled = true;
  state.selectedMatrixKey = cellKey;
  state.matrixExpanded = false;
  try {
    stopMatrixPolling();
    stopSearchPolling();
    state.request = derivedRequest;
    syncSearchFormWithRequest(derivedRequest);
    state.matrixResponse = null;
    state.viewMode = "list";
    state.quotationText = "";
    state.airlineFilter.hidden.clear();
    state.airlineFilter.only = null;
    state.detailPendingAction = null;
    state.resultsScroll = { top: 0, left: 0 };
    setSearchResponse(buildPendingSearchResponse(derivedRequest, state.sortMode));
    renderAll();

    const data = await postJson("/api/search", { request: derivedRequest, sortMode: state.sortMode });
    state.request = data.request;
    syncSearchFormWithRequest(data.request);
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

async function handleMatrixClick(e) {
  const btn = e.target.closest("[data-mk]");
  if (!btn) {
    return;
  }

  await launchMatrixCellSearch(btn.dataset.mk);
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
  const baseOffers = offersForClientControls();
  const offersForFacets = baseOffers.length ? getOffersForVisibleFacets(baseOffers) : [];

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
      const passengerCount = passengerCountForRequest(flexibleCellRequest(cell) ?? state.matrixResponse?.request ?? state.request);
      const toneClass = matrixToneClass(cell, priceStats);
      const calTone = toneClass.replace("matrix-cell--", "cal-cell--");
      html += `<button class="matrix-cell cal-cell ${cell.key === state.selectedMatrixKey ? "is-active" : ""} ${isLoading ? "is-loading" : ""} ${toneClass} ${calTone}" type="button" ${!cell.selectable ? "disabled" : ""} data-mk="${cell.key}" title="${escapeHtml(cell.tooltip ?? "")}">`;
      html += `<div class="matrix-price cal-price ${isLoading ? "matrix-price--loading" : ""}">${isLoading ? "..." : cell.price ? renderPriceBreakdownHtml(cell.price, passengerCount, { className: "price-stack price-stack--matrix", perPersonSuffix: " p/p" }) : "—"}</div>`;
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
        const passengerCount = passengerCountForRequest(flexibleCellRequest(cell) ?? state.matrixResponse?.request ?? state.request);
        const toneClass = matrixToneClass(cell, priceStats);
        const calTone = toneClass.replace("matrix-cell--", "cal-cell--");
        html += `<button class="matrix-cell cal-cell ${cell.key === state.selectedMatrixKey ? "is-active" : ""} ${isLoading ? "is-loading" : ""} ${toneClass} ${calTone}" type="button" ${!cell.selectable ? "disabled" : ""} data-mk="${cell.key}" title="${escapeHtml(cell.tooltip ?? "")}">`;
        html += `<div class="matrix-price cal-price ${isLoading ? "matrix-price--loading" : ""}">${isLoading ? "..." : cell.price ? renderPriceBreakdownHtml(cell.price, passengerCount, { className: "price-stack price-stack--matrix", perPersonSuffix: " p/p" }) : "—"}</div>`;
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
  if (container !== resultsContainer) {
    container.querySelectorAll("[data-mk]").forEach(btn => {
      btn.addEventListener("click", handleMatrixClick);
    });
  }
}

/* ================================================================
   RESULTS AREA DISPATCHER
   ================================================================ */

function renderResultsArea() {
  if (state.migrationActive) {
    renderMigrationResults();
    return;
  }
  const hasMatrix = (state.matrixResponse?.cells?.length ?? 0) > 0;
  const showCalendar = hasMatrix && state.viewMode === "calendar" && canRenderMatrixCalendar();
  if (!showCalendar && state.matrixExpanded) {
    closeMatrixExpanded({ rerender: false });
  }

  if (showCalendar) {
    renderCalendarView(state.matrixExpanded ? matrixFullscreenBody : resultsContainer);
  } else if (hasMatrix) {
    renderFlexibleList();
  } else {
    renderResults();
  }
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

function detailPairHtml(label, value, options = {}) {
  if (value == null || value === "") return "";
  const valueClass = options.strong ? "detail-pair detail-pair--strong" : "detail-pair";
  return `<div class="${valueClass}"><span class="detail-pair__key">${escapeHtml(label)}</span><span class="detail-pair__val">${escapeHtml(String(value))}</span></div>`;
}

function renderMatrixCellDetail(cell) {
  const request = flexibleCellRequest(cell);
  const fallbackRequest = state.matrixResponse?.request ?? request ?? {};
  const leg = request?.legs?.[0] ?? fallbackRequest?.legs?.[0] ?? {};
  const passengers = normalizePassengerCounts(request?.passengers ?? fallbackRequest?.passengers ?? {});
  const passengerCount = passengers.total;
  const routeSummary = [leg.origin, leg.destination].filter(Boolean).join(" → ") || toolbarRouteSummary(fallbackRequest);
  const passengerSummary = formatPassengerSummary(passengers.adults, passengers.children, passengers.infants);
  const exactProviderLabel = request?.providerId
    ? providerLabel(request.providerId)
    : providerLabel(cell.providerSource);
  const externalPaths = matrixCellPurchasePaths(cell);
  const stayLabel = cell.stayNights != null ? `${cell.stayNights} noches` : "—";
  const summaryParts = [routeSummary, providerLabel(cell.providerSource), passengerSummary].filter(Boolean);
  let h = "";

  h += cell?.price
    ? renderDetailHeroPriceHtml(cell.price, passengerCount)
    : `<div class="detail-hero"><span class="detail-hero__total">${escapeHtml(flexibleCellHeroLabel(cell))}</span></div>`;
  h += `<div class="detail-summary">${escapeHtml(summaryParts.join(" · "))}</div>`;

  h += '<div class="detail-section"><div class="detail-section__title">Combinacion flexible</div>';
  h += detailPairHtml("Salida", formatDateCompact(cell.departureDate));
  h += detailPairHtml("Vuelta", cell.returnDate ? formatDateCompact(cell.returnDate) : "—");
  h += detailPairHtml("Estadia", stayLabel);
  h += detailPairHtml("Estado", flexibleCellStateLabel(cell));
  h += detailPairHtml("Proveedor", providerLabel(cell.providerSource));
  if (cell.tooltip) {
    h += detailPairHtml("Detalle", cell.tooltip);
  }
  h += '</div>';

  h += '<div class="detail-section"><div class="detail-section__title">Contexto de busqueda</div>';
  h += detailPairHtml("Pasajeros", passengerSummary);
  if (cell.price) {
    h += detailPairHtml("Total", priceLabels(cell.price, passengerCount).totalLabel, { strong: true });
    h += detailPairHtml("Por persona", priceLabels(cell.price, passengerCount).perPersonLabel.replace(/ por persona$/, ""));
  }
  h += detailPairHtml("Filtros", flexibleCellFilterSummary(request?.filters ?? fallbackRequest?.filters));
  h += detailPairHtml("Cabina", request?.cabin ?? fallbackRequest?.cabin ?? "ECONOMY");
  h += '</div>';

  h += '<div class="detail-section">';
  h += '<div class="detail-section__header">';
  h += '<div class="detail-section__title">Oferta</div>';
  if (cell.selectable && cell.derivedRequest) {
    h += `<button type="button" class="btn btn--primary btn--sm" data-matrix-detail-search="${escapeHtml(cell.key)}">Abrir exacta</button>`;
  }
  externalPaths.forEach((path) => {
    h += `<a href="${escapeHtml(path.url)}" target="_blank" rel="noreferrer" class="btn btn--ghost btn--sm">${escapeHtml(matrixCellExternalActionLabel(path))}</a>`;
  });
  h += '</div>';
  h += detailPairHtml("Ruta exacta", matrixCellExactRouteSummary(cell));
  h += detailPairHtml("Fechas", matrixCellExactDateSummary(cell));
  h += detailPairHtml("Proveedor", exactProviderLabel);
  h += `<p class="detail-busy__text">${escapeHtml(flexibleCellSelectionCopy(cell))}</p>`;
  h += '</div>';

  if (detailContent) detailContent.innerHTML = h;
  detailContent?.querySelector("[data-matrix-detail-search]")?.addEventListener("click", () => {
    void launchMatrixCellSearch(cell.key);
  });
}

function renderDetailPanel() {
  const offer = selOffer();
  const matrixCell = offer ? null : selMatrixCell();
  if (quotationButton) quotationButton.disabled = !offer;

  if (!offer && !matrixCell) {
    closeDetailPanel();
    if (detailContent) {
      detailContent.innerHTML = renderEmptyPanel({
        wrapperClass: "detail-empty",
        title: "Sin oferta seleccionada",
        text: "Selecciona una opción para ver el detalle.",
        icon: "ico-clipboard",
      });
    }
    return;
  }

  if (!offer && matrixCell) {
    openDetailPanel();
    renderMatrixCellDetail(matrixCell);
    return;
  }

  openDetailPanel();

  if (state.detailPendingAction) {
    const copy = detailActionCopy();
    const passengerCount = passengerCountForRequest(state.searchResponse?.request ?? state.request);
    const carrier = carrierDisplayParts(offer);
    const summary = `${escapeHtml(offer.origin)} → ${escapeHtml(offer.destination)} · ${escapeHtml(carrier.display)}`;
    if (detailContent) {
      detailContent.innerHTML = `
        <div class="detail-busy" aria-live="polite" aria-busy="true">
          ${renderDetailHeroPriceHtml(offer.price?.total, passengerCount)}
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

  const group = getGroupForOffer(offer.id) ?? [offer];
  const carrier = carrierDisplayParts(offer);
  const providerLinkIndex = buildProviderLinkIndex(state.searchResponse?.allOffers ?? []);
  const passengerCount = passengerCountForRequest(state.searchResponse?.request ?? state.request);
  const offerPriceLabels = priceLabels(offer.price?.total, passengerCount);

  let h = "";

  // Hero price
  const totalStops = offer.comparisonMetrics?.totalStops ?? 0;
  const stopsLabel = stopsCountLabel(totalStops);
  h += renderDetailHeroPriceHtml(offer.price?.total, passengerCount);
  h += `<div class="detail-summary">${escapeHtml(offer.origin)} → ${escapeHtml(offer.destination)} · ${escapeHtml(carrier.display)} · ${formatDuration(offer.comparisonMetrics?.totalDurationMinutes)} · ${stopsLabel}</div>`;

  // Segments
  h += '<div class="detail-section"><div class="detail-section__title">Segmentos</div>';

  (offer.itineraries ?? []).forEach((itinerary, index) => {
    h += `<div class="detail-segment">${itineraryHeadingHtml(itinerary, index)}`;
    itinerary.segments?.forEach((segment, segmentIndex) => {
      const routeLabel = segmentRouteLabel(segment);
      h += '<div class="detail-segment__leg">';
      h += `<div class="detail-segment__flight">${escapeHtml(segment.flightNumber)}</div>`;
      h += `<div class="detail-segment__times">${escapeHtml(segment.origin)} ${formatDT(segment.departureAt)} → ${escapeHtml(segment.destination)} ${formatDT(segment.arrivalAt)}</div>`;
      if (routeLabel) {
        h += `<div class="detail-segment__route">${escapeHtml(routeLabel)}</div>`;
      }
      h += "</div>";
      if (itinerary.segments?.[segmentIndex + 1]) {
        const layoverMin = computeLayoverMinutes(itinerary, segmentIndex);
        if (layoverMin > 0) {
          h += `<div class="detail-layover"><span class="detail-layover__line"></span><span class="detail-layover__label">Escala en ${escapeHtml(segment.destinationName || segment.destination)} · ${formatDuration(layoverMin)}</span><span class="detail-layover__line"></span></div>`;
        }
      }
    });
    h += "</div>";
  });

  if (group.length > 1) {
    h += `
      <div class="detail-segment">
        <div class="detail-segment__dir">
          <span class="detail-segment__title">Fechas equivalentes</span>
          <span class="detail-segment__meta">${group.length} variantes</span>
        </div>
    `;
    group.forEach((member) => {
      const isSelected = member.id === state.selectedOfferId;
      const label = buildOfferVariantSummary(member);
      h += `<button type="button" class="detail-segment__leg detail-segment__leg--choice ${isSelected ? "is-selected" : ""}" data-inbound-id="${member.id}" aria-pressed="${isSelected ? "true" : "false"}" title="${escapeHtml(label)}">${escapeHtml(label)}</button>`;
    });
    h += '</div>';
  }
  h += '</div>';

  // Baggage
  h += '<div class="detail-section"><div class="detail-section__title">Equipaje</div>';
  const carryIcon = `<svg class="ico ico--xs ${offer.baggage?.carryOnIncluded ? "ico--bag-yes" : "ico--bag-no"}"><use href="#ico-carry-on"/></svg>`;
  const checkIcon = `<svg class="ico ico--xs ${offer.baggage?.checkedIncluded ? "ico--bag-yes" : "ico--bag-no"}"><use href="#ico-luggage"/></svg>`;
  h += `<div class="detail-pair"><span class="detail-pair__key">${carryIcon} Cabina</span><span class="detail-pair__val">${offer.baggage?.carryOnIncluded ? "Incluido" : "No incluido"}</span></div>`;
  h += `<div class="detail-pair"><span class="detail-pair__key">${checkIcon} Bodega</span><span class="detail-pair__val">${offer.baggage?.checkedIncluded ? `${offer.baggage.checkedBags ?? 1}x ${offer.baggage.description ?? ""}`.trim() : "No incluido"}</span></div>`;
  h += '</div>';

  // Fare
  h += '<div class="detail-section"><div class="detail-section__title">Tarifa</div>';
  h += `<div class="detail-pair detail-pair--strong"><span class="detail-pair__key">Total</span><span class="detail-pair__val">${offerPriceLabels.totalLabel}</span></div>`;
  h += `<div class="detail-pair"><span class="detail-pair__key">Por persona</span><span class="detail-pair__val">${offerPriceLabels.perPersonLabel.replace(/ por persona$/, "")}</span></div>`;
  if (offer.price?.base) h += `<div class="detail-pair"><span class="detail-pair__key">Base</span><span class="detail-pair__val">${formatMoney(offer.price.base)}</span></div>`;
  if (offer.price?.taxes) h += `<div class="detail-pair"><span class="detail-pair__key">Tasas</span><span class="detail-pair__val">${formatMoney(offer.price.taxes)}</span></div>`;
  if (offer.fareMeta?.lastTicketingDate) h += `<div class="detail-pair"><span class="detail-pair__key">Emisión límite</span><span class="detail-pair__val">${offer.fareMeta.lastTicketingDate}</span></div>`;
  h += '</div>';

  // Purchase paths
  const paths = resolvedOfferPurchasePaths(offer, providerLinkIndex);
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
    h += '<div class="detail-section">';
    h += '<div class="detail-section__title">Cotización comercial</div>';
    h += `<textarea class="quote-textarea" readonly>${escapeHtml(state.quotationText)}</textarea>`;
    h += '</div>';
  }

  if (detailContent) detailContent.innerHTML = h;

  // Inbound option click
  detailContent?.querySelectorAll("[data-inbound-id]").forEach(el => {
    el.addEventListener("click", () => {
      selectOffer(el.dataset.inboundId);
    });
  });
}

/* ================================================================
   RENDER ALL
   ================================================================ */

function renderAll() {
  renderShell({
    state,
    renderToolbar,
    renderAirlineBar,
    renderResultsArea,
    renderDetailPanel,
    updateResultsToolbar,
    workspace,
  });
}

function syncWorkspaceViewportHeight() {
  syncWorkspaceViewportHeightBase(workspace);
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
  markPollingUiInteraction();
  state.sortMode = btn.dataset.sort;
  sortMode.value = btn.dataset.sort; // sync hidden select
  state.resultsPage = 1;
  state.resultsScroll = { top: 0, left: 0 };
  applyClientOfferControls();
  renderSearchResultsViewport();
});

// View toggle
viewToggle?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-view]");
  if (!btn) return;
  if (btn.dataset.view === "calendar" && !canRenderMatrixCalendar()) return;
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
  if (e.key === "Escape" && state.selectedOfferId) {
    selectOffer(null);
  }
});

// Toolbar pager click delegation (set up once)
resultsToolbar?.addEventListener("click", handleResultsClick);

// Results container click delegation (set up once)
resultsContainer?.addEventListener("click", handleResultsClick);
resultsContainer?.addEventListener("keydown", handleResultsKeydown);
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

window.addEventListener("resize", debounce(() => {
  const pageSizeChanged = syncResultsPageSize();
  if (!pageSizeChanged || !state.searchResponse?.allOffers?.length) {
    return;
  }

  applyClientOfferControls();
  renderAll();
}, 120));

["sortMode", "nonStop", "baggageRequired", "maxLayoverMinutes", "maxStopsFilter"].forEach((id) => {
  control(id)?.addEventListener("change", async () => {
    if (!state.searchResponse?.allOffers) return;
    markPollingUiInteraction();
    state.sortMode = controlValue("sortMode") || state.sortMode;
    state.resultsPage = 1;
    state.resultsScroll = { top: 0, left: 0 };
    applyClientOfferControls();
    renderSearchResultsViewport({ includeAirlineBar: true });
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
    exitMigrationMode();
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
      state.viewMode = "list";
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

quotationButton.addEventListener("click", async () => {
  const offer = selOffer();
  const sid = sessionId();
  if (!offer || !sid) return;
  const requestedOfferId = offer.id;
  const requestedSessionId = sid;
  quotationButton.disabled = true;
  state.detailPendingAction = "quotation";
  renderDetailPanel();
  try {
    const data = await postJson("/api/quotation", { searchSessionId: requestedSessionId, offerId: requestedOfferId });
    if (sessionId() !== requestedSessionId || state.selectedOfferId !== requestedOfferId || !state.searchResponse) {
      return;
    }
    const quotation = resolveQuotationPayload(data);
    state.searchResponse.serverOffers = state.searchResponse.serverOffers.map((o) => o.id === data.offer.id ? data.offer : o);
    state.searchResponse.allOffers = state.searchResponse.allOffers.map((o) => o.id === data.offer.id ? data.offer : o);
    applyClientOfferControls();
    state.quotationText = quotation;
    renderAll();
    const copied = await writeClipboardText(quotation);
    showToast(
      copied
        ? "Cotización comercial copiada al portapapeles."
        : "Cotización lista. No pude copiar la versión comercial al portapapeles.",
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
   MIGRATION MODE
   ================================================================ */

const MIGRATION_MONTH_COUNT = 8;
const MIGRATION_MONTH_NAMES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

function migrationMonthRanges(startISO, count) {
  const months = [];
  const start = new Date(startISO + "T00:00:00");
  let year = start.getFullYear();
  let month = start.getMonth();
  for (let i = 0; i < count; i++) {
    const first = new Date(year, month, 1);
    const last = new Date(year, month + 1, 0);
    const departureStart = first.toISOString().slice(0, 10);
    const departureEnd = last.toISOString().slice(0, 10);
    const clampedStart = departureStart < startISO ? startISO : departureStart;
    months.push({
      key: `${year}-${String(month + 1).padStart(2, "0")}`,
      label: `${MIGRATION_MONTH_NAMES[month]} ${year}`,
      departureStart: clampedStart,
      departureEnd,
    });
    month++;
    if (month > 11) { month = 0; year++; }
  }
  return months;
}

function stopMigrationPolling() {
  for (const handle of state.migrationPollHandles) {
    clearTimeout(handle);
  }
  state.migrationPollHandles = [];
}

function exitMigrationMode() {
  stopMigrationPolling();
  state.migrationActive = false;
  state.migrationMonths = [];
}

function renderMigrationResults() {
  if (!resultsContainer) return;
  const months = state.migrationMonths;
  if (!months || months.length === 0) {
    resultsContainer.innerHTML = "";
    return;
  }

  const origin = months[0]?.origin ?? "";
  const destination = months[0]?.destination ?? "";
  const route = [origin, destination].filter(Boolean).join(" → ");
  const passengerCount = normalizePassengerCounts({
    adults: $("adults")?.value ?? 1,
    children: $("children")?.value ?? 0,
    infants: $("infants")?.value ?? 0,
  }).total;

  let h = `<div class="migration-panel">`;
  h += `<div class="migration-panel__header">`;
  h += `<h2 class="migration-panel__title">Vuelo migratorio &mdash; ${escapeHtml(route)}</h2>`;
  h += `<p class="migration-panel__subtitle">Solo ida &middot; Precio más bajo por mes</p>`;
  h += `</div>`;
  h += `<div class="migration-grid">`;

  for (const m of months) {
    const statusClass = m.complete
      ? (m.cheapest ? "migration-card--ok" : "migration-card--empty")
      : "migration-card--loading";
    h += `<div class="migration-card ${statusClass}">`;
    h += `<div class="migration-card__month">${escapeHtml(m.label)}</div>`;
    if (!m.complete) {
      h += `<div class="migration-card__price migration-card__price--loading">Buscando&hellip;</div>`;
    } else if (m.cheapest) {
      const offer = m.cheapest;
      const totalMoney = offer.price?.total
        ? offer.price.total
        : {
            amount: offer.totalPrice ?? 0,
            currencyCode: offer.currencyCode || "USD",
          };
      const airline = offer.itineraries?.[0]?.segments?.[0]?.airlineName
        || offer.itineraries?.[0]?.segments?.[0]?.airlineCode
        || "";
      const date = offer.itineraries?.[0]?.segments?.[0]?.departureDate
        || offer.departureDate || "";
      h += `<div class="migration-card__price">${renderPriceBreakdownHtml(totalMoney, passengerCount, { totalSuffix: " total" })}</div>`;
      h += `<div class="migration-card__detail">${escapeHtml(formatDateCompact(date))}</div>`;
      if (airline) {
        h += `<div class="migration-card__detail">${escapeHtml(airline)}</div>`;
      }
      if (offer.itineraries?.[0]?.stops != null) {
        const stops = offer.itineraries[0].stops;
        h += `<div class="migration-card__detail">${stops === 0 ? "Directo" : stops + " escala" + (stops > 1 ? "s" : "")}</div>`;
      }
    } else {
      h += `<div class="migration-card__price migration-card__price--empty">Sin resultados</div>`;
      if (m.error) {
        h += `<div class="migration-card__detail migration-card__detail--error">${escapeHtml(m.error)}</div>`;
      }
    }
    h += `</div>`;
  }

  h += `</div></div>`;
  resultsContainer.innerHTML = h;
}

async function startMigrationSearch() {
  const origin = resolvedLocationCode("origin");
  const destination = resolvedLocationCode("destination");
  if (!origin || !destination) {
    showToast("Completa origen y destino antes de buscar vuelo migratorio.");
    return;
  }

  stopSearchPolling();
  stopMatrixPolling();
  exitMigrationMode();

  state.migrationActive = true;
  state.searchResponse = null;
  state.matrixResponse = null;
  state.selectedOfferId = null;

  const monthRanges = migrationMonthRanges(todayISO, MIGRATION_MONTH_COUNT);
  const adults = parseInt($("adults")?.value, 10) || 1;
  const children = parseInt($("children")?.value, 10) || 0;
  const infants = parseInt($("infants")?.value, 10) || 0;
  const originLabel = $("origin")?.dataset.label ?? $("origin")?.value ?? "";
  const destinationLabel = $("destination")?.dataset.label ?? $("destination")?.value ?? "";

  state.migrationMonths = monthRanges.map((m) => ({
    ...m,
    origin,
    destination,
    jobId: null,
    offers: [],
    cheapest: null,
    complete: false,
    error: null,
  }));

  if (resultsToolbar) resultsToolbar.classList.add("hidden");
  if (emptyState) emptyState.classList.add("hidden");
  renderMigrationResults();

  for (let i = 0; i < state.migrationMonths.length; i++) {
    const m = state.migrationMonths[i];
    const payload = {
      sortMode: "cheapest",
      request: {
        tripType: "one-way",
        searchMode: "stay-range",
        cabin: "ECONOMY",
        currencyCode: DEFAULT_CURRENCY_CODE,
        coverageMode: "core",
        redirectMode: "best-effort",
        passengers: { adults, children, infants },
        filters: { nonStop: false, maxResults: 300 },
        legs: [{
          origin,
          destination,
          originLabel,
          destinationLabel,
          departureDate: "",
          returnDate: "",
          departureStart: m.departureStart,
          departureEnd: m.departureEnd,
          returnStart: "",
          returnEnd: "",
        }],
      },
    };

    try {
      const data = await postJson("/api/search", payload);
      m.jobId = data.searchJobId ?? null;
      updateMigrationMonth(i, data);
      if (!data.searchComplete && m.jobId) {
        queueMigrationPoll(i, m.jobId);
      }
    } catch (err) {
      m.complete = true;
      m.error = err.message;
    }
    renderMigrationResults();
  }
}

function updateMigrationMonth(index, data) {
  const m = state.migrationMonths[index];
  if (!m) return;
  const offers = data.allOffers ?? data.offers ?? [];
  m.offers = offers;
  m.complete = Boolean(data.searchComplete);
  if (offers.length > 0) {
    m.cheapest = offers.reduce((best, o) =>
      ((o.price?.total?.amount ?? o.totalPrice ?? Infinity) < (best.price?.total?.amount ?? best.totalPrice ?? Infinity) ? o : best), offers[0]);
  }
}

function queueMigrationPoll(index, jobId) {
  const handle = scheduleJsonPoll({
    delayMs: 900,
    run: async () => {
      try {
        const data = await getJson(`/api/search/${jobId}`);
        const m = state.migrationMonths[index];
        if (!m || m.jobId !== jobId) return;
        updateMigrationMonth(index, data);
        renderMigrationResults();
        if (!data.searchComplete) {
          queueMigrationPoll(index, jobId);
        }
      } catch {
        const m = state.migrationMonths[index];
        if (m) { m.complete = true; m.error = "Error de conexión"; }
        renderMigrationResults();
      }
    },
  });
  state.migrationPollHandles.push(handle);
}

migrationBtn?.addEventListener("click", () => {
  startMigrationSearch();
});

/* ================================================================
   INIT
   ================================================================ */

bootstrapAppShell({
  SEARCH_CONFIG_CLIPBOARD_KEY,
  swapRouteBtn,
  $,
  hideLocationMenu,
  setupInputEnforcement,
  setupLocationAutocomplete,
  setupPaxPopover,
  setupLayoverPopover,
  setupThemeToggle,
  setupTripTypeToggle,
  setupModeToggle,
  setupCalendarPopover,
  updatePaxLabel,
  updateModeFields,
  syncVisibleLocationMenus,
  syncPaxPopoverPosition,
  syncLayoverPopoverPosition,
  syncCalendarPopoverPosition,
  syncWorkspaceViewportHeight,
  syncSearchShellLayoutMetrics,
  syncSearchClipboardUI,
  renderAll,
  settleInitialShellLayout,
  releaseInitialUiBootState,
});
