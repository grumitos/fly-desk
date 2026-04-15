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
  resultsPanelBody,
  resultsPanelMeta,
  resultsPanelTitle,
  resultsPagerEl,
  resultsSidebar,
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
const AUTOCOMPLETE_SESSION_STORAGE_KEY = "flydesk.autocompleteCache.v1";
const AUTOCOMPLETE_CLIENT_SESSION_STORAGE_KEY = "flydesk.clientSessionId";
const AUTOCOMPLETE_CACHE_TTL_MS = 8 * 60 * 60 * 1000;
const AUTOCOMPLETE_CACHE_MAX_ENTRIES = 80;
const SEARCH_RESULT_CACHE_STORAGE_KEY = "flydesk.searchResultCache.v1";
const SEARCH_RESULT_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const SEARCH_RESULT_CACHE_MAX_ENTRIES = 16;
const SEARCH_LAUNCH_STORAGE_KEY_PREFIX = "flydesk.searchLaunch.v1";
const SEARCH_LAUNCH_TTL_MS = 15 * 60 * 1000;
const SEARCH_LAUNCH_QUERY_PARAM = "launchSearch";
const SEARCH_LAUNCH_PAYLOAD_QUERY_PARAM = "launchPayload";
const RESULTS_REORDER_DURATION_MS = 170;
const RESULTS_REORDER_ENTRY_DURATION_MS = 130;
const RESULTS_REORDER_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const RESULTS_REORDER_MAX_ANIMATED_CARDS = 80;
const autocompleteSessionCache = loadAutocompleteSessionCache();
const searchResultCache = loadSearchResultCache();

function createClientSessionId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  return `flydesk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getClientSessionId() {
  try {
    const stored = window.sessionStorage.getItem(AUTOCOMPLETE_CLIENT_SESSION_STORAGE_KEY);
    if (stored) {
      return stored;
    }

    const created = createClientSessionId();
    window.sessionStorage.setItem(AUTOCOMPLETE_CLIENT_SESSION_STORAGE_KEY, created);
    return created;
  } catch {
    return "flydesk-anonymous";
  }
}

function loadAutocompleteSessionCache() {
  try {
    const raw = window.sessionStorage.getItem(AUTOCOMPLETE_SESSION_STORAGE_KEY);
    if (!raw) {
      return new Map();
    }

    const parsed = JSON.parse(raw);
    const nowMs = Date.now();
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    const cache = new Map();

    entries.forEach((entry) => {
      const key = typeof entry?.key === "string" ? entry.key : "";
      const touchedAtMs = Number(entry?.touchedAtMs);
      const suggestions = Array.isArray(entry?.suggestions) ? entry.suggestions : [];
      if (!key || !Number.isFinite(touchedAtMs) || nowMs - touchedAtMs > AUTOCOMPLETE_CACHE_TTL_MS) {
        return;
      }

      cache.set(key, {
        touchedAtMs,
        suggestions: suggestions.map((suggestion) => ({ ...suggestion })),
      });
    });

    return cache;
  } catch {
    return new Map();
  }
}

function persistAutocompleteSessionCache() {
  try {
    const entries = [...autocompleteSessionCache.entries()]
      .sort((left, right) => right[1].touchedAtMs - left[1].touchedAtMs)
      .slice(0, AUTOCOMPLETE_CACHE_MAX_ENTRIES)
      .map(([key, value]) => ({
        key,
        touchedAtMs: value.touchedAtMs,
        suggestions: value.suggestions.map((suggestion) => ({ ...suggestion })),
      }));
    window.sessionStorage.setItem(AUTOCOMPLETE_SESSION_STORAGE_KEY, JSON.stringify({ entries }));
  } catch {
    // sessionStorage can be unavailable in privacy-restricted contexts.
  }
}

function normalizeAutocompleteQuery(query) {
  return String(query || "").trim().toUpperCase();
}

function autocompleteCacheKey(query, limit) {
  return [
    "all",
    String(limit),
    normalizeAutocompleteQuery(query),
  ].join("::");
}

function readAutocompleteCache(query, limit) {
  const key = autocompleteCacheKey(query, limit);
  const entry = autocompleteSessionCache.get(key);
  if (!entry) {
    return [];
  }

  if (Date.now() - entry.touchedAtMs > AUTOCOMPLETE_CACHE_TTL_MS) {
    autocompleteSessionCache.delete(key);
    persistAutocompleteSessionCache();
    return [];
  }

  entry.touchedAtMs = Date.now();
  persistAutocompleteSessionCache();
  return entry.suggestions.map((suggestion) => ({ ...suggestion }));
}

function writeAutocompleteCache(query, limit, suggestions) {
  const key = autocompleteCacheKey(query, limit);
  autocompleteSessionCache.set(key, {
    touchedAtMs: Date.now(),
    suggestions: (suggestions ?? []).map((suggestion) => ({ ...suggestion })),
  });

  while (autocompleteSessionCache.size > AUTOCOMPLETE_CACHE_MAX_ENTRIES) {
    const oldest = [...autocompleteSessionCache.entries()]
      .sort((left, right) => left[1].touchedAtMs - right[1].touchedAtMs)[0];
    if (!oldest) {
      break;
    }
    autocompleteSessionCache.delete(oldest[0]);
  }

  persistAutocompleteSessionCache();
}

function cloneSerializable(value) {
  if (value == null) return value;
  try {
    if (typeof window.structuredClone === "function") {
      return window.structuredClone(value);
    }
  } catch {
    // Fallback to JSON clone for plain data payloads.
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function stableSerializeJson(value) {
  if (value == null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerializeJson(item == null ? null : item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, itemValue]) => itemValue !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
    return `{${entries.map(([key, itemValue]) => `${JSON.stringify(key)}:${stableSerializeJson(itemValue)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function searchResultCacheKey(request, sortModeValue) {
  return stableSerializeJson({
    request: request ?? null,
    sortMode: String(sortModeValue || "cheapest"),
  });
}

function loadSearchResultCache() {
  try {
    const raw = window.localStorage.getItem(SEARCH_RESULT_CACHE_STORAGE_KEY);
    if (!raw) {
      return new Map();
    }

    const parsed = JSON.parse(raw);
    const nowMs = Date.now();
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    const cache = new Map();

    entries.forEach((entry) => {
      const key = typeof entry?.key === "string" ? entry.key : "";
      const touchedAtMs = Number(entry?.touchedAtMs);
      const response = entry?.response;
      if (!key || !Number.isFinite(touchedAtMs) || nowMs - touchedAtMs > SEARCH_RESULT_CACHE_TTL_MS) {
        return;
      }
      if (!response || typeof response !== "object") {
        return;
      }
      cache.set(key, {
        touchedAtMs,
        response: cloneSerializable(response),
      });
    });

    return cache;
  } catch {
    return new Map();
  }
}

function persistSearchResultCache() {
  try {
    const entries = [...searchResultCache.entries()]
      .sort((left, right) => right[1].touchedAtMs - left[1].touchedAtMs)
      .slice(0, SEARCH_RESULT_CACHE_MAX_ENTRIES)
      .map(([key, value]) => ({
        key,
        touchedAtMs: value.touchedAtMs,
        response: cloneSerializable(value.response),
      }));
    window.localStorage.setItem(SEARCH_RESULT_CACHE_STORAGE_KEY, JSON.stringify({ entries }));
  } catch {
    // localStorage can be unavailable in privacy-restricted contexts.
  }
}

function readSearchResultCache(request, sortModeValue) {
  const key = searchResultCacheKey(request, sortModeValue);
  const entry = searchResultCache.get(key);
  if (!entry) {
    return null;
  }

  if (Date.now() - entry.touchedAtMs > SEARCH_RESULT_CACHE_TTL_MS) {
    searchResultCache.delete(key);
    persistSearchResultCache();
    return null;
  }

  entry.touchedAtMs = Date.now();
  persistSearchResultCache();
  return cloneSerializable(entry.response);
}

function writeSearchResultCache(request, sortModeValue, response) {
  if (!request || !response || typeof response !== "object") {
    return;
  }
  const key = searchResultCacheKey(request, sortModeValue);
  const responseCopy = cloneSerializable(response);
  if (!responseCopy || typeof responseCopy !== "object") {
    return;
  }
  searchResultCache.set(key, {
    touchedAtMs: Date.now(),
    response: responseCopy,
  });

  while (searchResultCache.size > SEARCH_RESULT_CACHE_MAX_ENTRIES) {
    const oldest = [...searchResultCache.entries()]
      .sort((left, right) => left[1].touchedAtMs - right[1].touchedAtMs)[0];
    if (!oldest) {
      break;
    }
    searchResultCache.delete(oldest[0]);
  }

  persistSearchResultCache();
}

function createSearchLaunchToken() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `launch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function searchLaunchStorageKey(token) {
  return `${SEARCH_LAUNCH_STORAGE_KEY_PREFIX}.${token}`;
}

function cleanupSearchLaunchStorage(nowMs = Date.now()) {
  try {
    const staleKeys = [];
    for (let index = 0; index < window.localStorage.length; index++) {
      const key = window.localStorage.key(index);
      if (!key || !key.startsWith(`${SEARCH_LAUNCH_STORAGE_KEY_PREFIX}.`)) {
        continue;
      }
      const raw = window.localStorage.getItem(key);
      if (!raw) {
        staleKeys.push(key);
        continue;
      }
      try {
        const parsed = JSON.parse(raw);
        const createdAtMs = Number(parsed?.createdAtMs);
        if (!Number.isFinite(createdAtMs) || nowMs - createdAtMs > SEARCH_LAUNCH_TTL_MS) {
          staleKeys.push(key);
        }
      } catch {
        staleKeys.push(key);
      }
    }

    staleKeys.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // localStorage can be unavailable in privacy-restricted contexts.
  }
}

function persistSearchLaunchPayload(payload) {
  if (!payload?.request) {
    return null;
  }
  try {
    cleanupSearchLaunchStorage();
    const token = createSearchLaunchToken();
    const key = searchLaunchStorageKey(token);
    window.localStorage.setItem(key, JSON.stringify({
      createdAtMs: Date.now(),
      payload: cloneSerializable(payload),
    }));
    return token;
  } catch {
    return null;
  }
}

function encodeSearchLaunchPayload(payload) {
  if (!payload?.request) {
    return "";
  }
  try {
    const json = JSON.stringify(cloneSerializable(payload));
    const utf8Bytes = new TextEncoder().encode(json);
    let binary = "";
    utf8Bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  } catch {
    return "";
  }
}

function decodeSearchLaunchPayload(encoded) {
  const source = String(encoded || "").trim();
  if (!source) {
    return null;
  }
  try {
    const base64 = source
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const paddingLength = (4 - (base64.length % 4)) % 4;
    const normalized = `${base64}${"=".repeat(paddingLength)}`;
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(json);
    return parsed?.request ? parsed : null;
  } catch {
    return null;
  }
}

function stripLaunchSearchParamFromUrl() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(SEARCH_LAUNCH_QUERY_PARAM) && !url.searchParams.has(SEARCH_LAUNCH_PAYLOAD_QUERY_PARAM)) {
      return;
    }
    url.searchParams.delete(SEARCH_LAUNCH_QUERY_PARAM);
    url.searchParams.delete(SEARCH_LAUNCH_PAYLOAD_QUERY_PARAM);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // Ignore URL parsing issues.
  }
}

function consumeSearchLaunchPayloadFromUrl() {
  let launchToken = "";
  let encodedPayload = "";
  try {
    const url = new URL(window.location.href);
    launchToken = String(url.searchParams.get(SEARCH_LAUNCH_QUERY_PARAM) || "").trim();
    encodedPayload = String(url.searchParams.get(SEARCH_LAUNCH_PAYLOAD_QUERY_PARAM) || "").trim();
    if (!launchToken && !encodedPayload) {
      return null;
    }
  } catch {
    return null;
  }

  let payload = null;
  try {
    if (launchToken) {
      const raw = window.localStorage.getItem(searchLaunchStorageKey(launchToken));
      if (raw) {
        const parsed = JSON.parse(raw);
        const createdAtMs = Number(parsed?.createdAtMs);
        if (Number.isFinite(createdAtMs) && Date.now() - createdAtMs <= SEARCH_LAUNCH_TTL_MS) {
          payload = cloneSerializable(parsed?.payload);
        }
      }
    }
    if (!payload && encodedPayload) {
      payload = decodeSearchLaunchPayload(encodedPayload);
    }
  } catch {
    payload = null;
  } finally {
    try {
      if (launchToken) {
        window.localStorage.removeItem(searchLaunchStorageKey(launchToken));
      }
    } catch {
      // Ignore localStorage issues.
    }
    cleanupSearchLaunchStorage();
    stripLaunchSearchParamFromUrl();
  }

  return payload?.request ? payload : null;
}

function openSearchPayloadInNewTab(payload) {
  const token = persistSearchLaunchPayload(payload);
  const encodedPayload = encodeSearchLaunchPayload(payload);
  if (!token && !encodedPayload) {
    showToast("No pude preparar la busqueda para otra pestana.");
    return false;
  }

  let openedTab = null;
  try {
    const url = new URL(window.location.href);
    if (token) {
      url.searchParams.set(SEARCH_LAUNCH_QUERY_PARAM, token);
    }
    if (encodedPayload) {
      url.searchParams.set(SEARCH_LAUNCH_PAYLOAD_QUERY_PARAM, encodedPayload);
    }
    openedTab = window.open(url.toString(), "_blank", "noopener");
  } catch {
    openedTab = null;
  }

  if (openedTab) {
    return true;
  }

  try {
    if (token) {
      window.localStorage.removeItem(searchLaunchStorageKey(token));
    }
  } catch {
    // Ignore localStorage issues.
  }
  showToast("No pude abrir otra pestana. Habilita pop-ups para Fly Desk.");
  return false;
}

const startupSearchLaunchPayload = consumeSearchLaunchPayloadFromUrl();

function providerIdFromRequest(request) {
  return request?.providerId === "costamar" ? "costamar" : "agil-local";
}

function providerLabel(providerId) {
  return providerId === "costamar" ? "Costamar" : "Agil";
}

function providerFaviconPath(providerId) {
  return providerId === "costamar"
    ? "/assets/provider-icons/costamar-128.png"
    : "/assets/provider-icons/agilsmart-128.png";
}

function renderProviderFaviconIcon(providerId) {
  return `
    <img
      src="${escapeHtml(providerFaviconPath(providerId))}"
      alt=""
      aria-hidden="true"
      width="40"
      height="40"
      class="provider-link-icon__img"
      decoding="async"
    />
  `.trim();
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
  if (!path?.url) {
    return false;
  }

  if (path?.precision === "broad-search" || path?.precision === "manual") {
    return false;
  }

  if (path?.commercialMode === "manual" || path?.state === "manual" || path?.type === "manual-reference") {
    return false;
  }

  return true;
}

function providerIdsForLinkCell() {
  const providerIds = state.searchResponse?.searchMeta?.providersUsed;
  if (Array.isArray(providerIds) && providerIds.length > 0) {
    return providerIds;
  }

  return defaultProviderIds(state.request);
}

function renderProviderLinkItem(path, providerId) {
  const label = providerLabel(providerId);
  const icon = renderProviderFaviconIcon(providerId);

  if (pathSupportsEquivalentSearch(path)) {
    return `
      <div class="provider-links-cell__item provider-links-cell__item--link">
        <a
          href="${path.url}"
          target="_blank"
          rel="noreferrer"
          class="row-link row-link--provider"
          data-stop-row="1"
          aria-label="${escapeHtml(label)}"
          title="${escapeHtml(label)}"
        >
          ${icon}
          <span class="sr-only">${escapeHtml(label)}</span>
        </a>
      </div>
    `.trim();
  }

  const fallback = providerLinkFallbackLabel(state.searchResponse, providerId);
  if (fallback.label === "—") {
    return "";
  }

  const warningTitle = fallback.title || `${label}: ${fallback.label}`;
  return `
    <div class="provider-links-cell__item provider-links-cell__item--warning">
      <span class="cell-sub cell-sub--warning provider-link-warning" title="${escapeHtml(warningTitle)}">
        ${icon}
        <span class="sr-only">${escapeHtml(label)}</span>
        <span class="provider-link-warning__text">${escapeHtml(fallback.label)}</span>
      </span>
    </div>
  `.trim();
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

const RESULTS_LAYOUT_ENDPOINT = "/api/results-layout";
const RESULTS_LAYOUT_FILE_HINT = "config/results-layout.json";
const RESULTS_LAYOUT_EDITOR_MODE = (() => {
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = String(
      params.get("layoutEditor")
      || params.get("layout")
      || "",
    ).trim().toLowerCase();
    return raw === "1" || raw === "true" || raw === "editor";
  } catch {
    return false;
  }
})();
const RESULTS_COLUMN_DEFINITIONS = [
  { key: "carrier", label: "Aerolínea", defaultWidth: 132, minWidth: 88, maxWidth: 320 },
  { key: "dates", label: "Fechas", defaultWidth: 154, minWidth: 96, maxWidth: 240 },
  { key: "duration", label: "Duración", defaultWidth: 126, minWidth: 92, maxWidth: 240 },
  { key: "stops", label: "Escalas", defaultWidth: 138, minWidth: 96, maxWidth: 300 },
  { key: "baggage", label: "Equipaje", defaultWidth: 96, minWidth: 64, maxWidth: 180 },
  { key: "price", label: "Precio", defaultWidth: 128, minWidth: 112, maxWidth: 360 },
  { key: "links", label: "Enlace", defaultWidth: 102, minWidth: 40, maxWidth: 240 },
];
const RESULTS_PROTOTYPE_ROWS = [
  {
    airline: "Delta Air Lines",
    departureDate: "20/05",
    returnDate: "27/05",
    routeLabel: "LIM → MXP",
    duration: "69h 35m",
    stopTone: "danger",
    stopTime: "10h 0m",
    stopMeta: "ATL +1 escala",
    carryOnIncluded: false,
    checkedIncluded: false,
    priceAmount: 1416.83,
    linkLabel: "Costamar",
  },
  {
    airline: "Delta Air Lines",
    departureDate: "20/05",
    returnDate: "27/05",
    routeLabel: "LIM → MXP",
    duration: "70h 35m",
    stopTone: "danger",
    stopTime: "10h 0m",
    stopMeta: "ATL +1 escala",
    carryOnIncluded: false,
    checkedIncluded: false,
    priceAmount: 1420.58,
    linkLabel: "Costamar",
  },
  {
    airline: "Air France",
    departureDate: "20/05",
    returnDate: "27/05",
    routeLabel: "LIM → MXP",
    duration: "62h 40m",
    stopTone: "warning",
    stopTime: "8h 5m",
    stopMeta: "CDG +1 escala",
    carryOnIncluded: false,
    checkedIncluded: false,
    priceAmount: 1459.84,
    linkLabel: "Costamar",
  },
  {
    airline: "Air France",
    departureDate: "20/05",
    returnDate: "28/05",
    routeLabel: "LIM → MXP",
    duration: "77h 0m",
    stopTone: "danger",
    stopTime: "10h 0m",
    stopMeta: "CDG +1 escala",
    carryOnIncluded: false,
    checkedIncluded: false,
    priceAmount: 1463.54,
    linkLabel: "Costamar",
  },
  {
    airline: "Air France",
    departureDate: "20/05",
    returnDate: "27/05",
    routeLabel: "LIM → MXP",
    duration: "63h 40m",
    stopTone: "warning",
    stopTime: "8h 5m",
    stopMeta: "CDG +1 escala",
    carryOnIncluded: false,
    checkedIncluded: false,
    priceAmount: 1463.64,
    linkLabel: "Costamar",
  },
];

function createDefaultResultsColumnLayout() {
  return Object.fromEntries(
    RESULTS_COLUMN_DEFINITIONS.map((column) => [column.key, column.defaultWidth]),
  );
}

function normalizedResultsColumnLayout(input) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const columns = {};
  let validCount = 0;

  RESULTS_COLUMN_DEFINITIONS.forEach((column) => {
    const numeric = Number(input?.[column.key]);
    if (!Number.isFinite(numeric)) {
      return;
    }

    columns[column.key] = Math.max(
      column.minWidth,
      Math.min(column.maxWidth, Math.round(numeric)),
    );
    validCount += 1;
  });

  return validCount === RESULTS_COLUMN_DEFINITIONS.length
    ? columns
    : null;
}

function currentResultsColumnLayout() {
  return normalizedResultsColumnLayout(state.resultsColumnLayout)
    ?? createDefaultResultsColumnLayout();
}

function resultsLayoutStatusText() {
  if (state.resultsLayoutSaving) {
    return "Guardando layout local...";
  }

  if (!state.resultsLayoutLoaded) {
    return "Cargando layout local...";
  }

  if (state.resultsLayoutSavedAt) {
    return `Guardado ${formatDT(state.resultsLayoutSavedAt)} en ${RESULTS_LAYOUT_FILE_HINT}`;
  }

  return `Aún no hay un layout guardado. Cuando lo guardes quedará en ${RESULTS_LAYOUT_FILE_HINT}`;
}

function buildResultsLayoutEditorHtml({
  eyebrow = "Edición temporal",
  title = "Ajusta columnas en esta misma vista",
  description = "Estás viendo la instancia normal con resultados reales. Ajusta anchos y guarda para reutilizar luego.",
} = {}) {
  const layout = currentResultsColumnLayout();
  const fields = RESULTS_COLUMN_DEFINITIONS.map((column) => `
    <label class="results-layout-field">
      <span class="results-layout-field__label">${escapeHtml(column.label)}</span>
      <div class="results-layout-field__control">
        <input
          type="number"
          min="${column.minWidth}"
          max="${column.maxWidth}"
          step="4"
          value="${layout[column.key]}"
          data-results-layout-input="${column.key}"
          aria-label="Ancho de ${escapeHtml(column.label)} en píxeles"
        />
        <span class="results-layout-field__unit">px</span>
      </div>
    </label>
  `).join("");

  return `
    <section class="results-layout-editor" aria-label="Editor de columnas">
      <div class="results-layout-editor__header">
        <div class="results-layout-editor__copy">
          <p class="results-layout-editor__eyebrow">${escapeHtml(eyebrow)}</p>
          <h2 class="results-layout-editor__title">${escapeHtml(title)}</h2>
          <p class="results-layout-editor__text">${escapeHtml(description)}</p>
        </div>
        <div class="results-layout-editor__actions">
          <button type="button" class="btn btn--secondary btn--sm" data-results-layout-action="reset">Restaurar</button>
          <button type="button" class="btn btn--primary btn--sm" data-results-layout-action="save" ${state.resultsLayoutSaving ? "disabled" : ""}>Guardar layout</button>
        </div>
      </div>
      <div class="results-layout-editor__grid">${fields}</div>
      <p class="results-layout-editor__status">${escapeHtml(resultsLayoutStatusText())}</p>
    </section>
  `;
}

function buildResultsTableHeaderHtml() {
  const layout = currentResultsColumnLayout();
  return `
    <colgroup>
      ${RESULTS_COLUMN_DEFINITIONS.map((column) => `
        <col data-results-col="${column.key}" style="width:${layout[column.key]}px">
      `).join("")}
    </colgroup>
    <thead><tr>${RESULTS_COLUMN_DEFINITIONS.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("")}</tr></thead>
  `;
}

function resultsLayoutEditorEnabled() {
  return RESULTS_LAYOUT_EDITOR_MODE;
}

function readResultsLayoutColumnDefinition(key) {
  return RESULTS_COLUMN_DEFINITIONS.find((column) => column.key === key) ?? null;
}

function clampResultsLayoutWidth(column, value) {
  const numeric = Number(value);
  if (!column || !Number.isFinite(numeric)) {
    return null;
  }

  return Math.max(
    column.minWidth,
    Math.min(column.maxWidth, Math.round(numeric)),
  );
}

function buildResultsLayoutStyleVars(layout = currentResultsColumnLayout()) {
  return RESULTS_COLUMN_DEFINITIONS
    .map((column) => `--results-col-${column.key}:${Math.round(layout[column.key])}px`)
    .join(";");
}

function resultsLayoutEditorMarkup() {
  if (!resultsLayoutEditorEnabled()) {
    return "";
  }

  return buildResultsLayoutEditorHtml();
}

function resultsLayoutInlineStyleAttr() {
  return ` style="${escapeHtml(buildResultsLayoutStyleVars())}"`;
}

function resultsListExactClassName() {
  return resultsLayoutEditorEnabled()
    ? "results-list results-list--exact results-list--layout-edit"
    : "results-list results-list--exact";
}

async function loadResultsLayout({ rerender = true, showErrorToast = true } = {}) {
  try {
    const data = await getJson(RESULTS_LAYOUT_ENDPOINT);
    const layout = normalizedResultsColumnLayout(data?.layout?.columns);
    state.resultsColumnLayout = layout ?? createDefaultResultsColumnLayout();
    state.resultsLayoutSavedAt = typeof data?.layout?.savedAt === "string"
      ? data.layout.savedAt
      : "";
  } catch (err) {
    state.resultsColumnLayout = createDefaultResultsColumnLayout();
    state.resultsLayoutSavedAt = "";
    if (showErrorToast) {
      showToast(`No pude cargar layout local (${err.message}).`);
    }
  } finally {
    state.resultsLayoutLoaded = true;
    if (rerender) {
      renderResultsArea();
      updateResultsToolbar();
    }
  }
}

function resetResultsLayoutDraft() {
  state.resultsColumnLayout = createDefaultResultsColumnLayout();
  state.resultsLayoutSavedAt = "";
  renderResultsArea();
}

function updateResultsLayoutDraftColumn(key, rawValue) {
  const column = readResultsLayoutColumnDefinition(key);
  if (!column) {
    return;
  }

  const clamped = clampResultsLayoutWidth(column, rawValue);
  if (clamped == null) {
    return;
  }

  state.resultsColumnLayout = {
    ...currentResultsColumnLayout(),
    [column.key]: clamped,
  };
  state.resultsLayoutSavedAt = "";
  renderResultsArea();
}

async function saveResultsLayoutDraft() {
  if (state.resultsLayoutSaving) {
    return;
  }

  state.resultsLayoutSaving = true;
  renderResultsArea();
  try {
    const payload = { columns: currentResultsColumnLayout() };
    const data = await postJson(RESULTS_LAYOUT_ENDPOINT, payload);
    const layout = normalizedResultsColumnLayout(data?.layout?.columns);
    state.resultsColumnLayout = layout ?? payload.columns;
    state.resultsLayoutSavedAt = typeof data?.layout?.savedAt === "string"
      ? data.layout.savedAt
      : new Date().toISOString();
    state.resultsLayoutLoaded = true;
    showToast(`Layout guardado en ${RESULTS_LAYOUT_FILE_HINT}`, "success");
  } catch (err) {
    showToast(`No pude guardar layout (${err.message}).`);
  } finally {
    state.resultsLayoutSaving = false;
    renderResultsArea();
    updateResultsToolbar();
  }
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
  const cards = Array.from({ length: rowCount }, () => `
    <article class="results-card results-card--placeholder" aria-hidden="true">
      <div class="results-card__airline">
        <span class="skeleton-line skeleton-line--md"></span>
        <span class="skeleton-line skeleton-line--sm"></span>
      </div>
      <div class="results-card__schedule">
        <span class="skeleton-line skeleton-line--hero"></span>
        <span class="skeleton-line skeleton-line--sm"></span>
      </div>
      <div class="results-card__route">
        <span class="skeleton-line skeleton-line--lg"></span>
        <span class="skeleton-line skeleton-line--sm"></span>
      </div>
      <div class="results-card__journey">
        <span class="skeleton-line skeleton-line--md"></span>
        <span class="skeleton-line skeleton-line--sm"></span>
      </div>
      <div class="results-card__baggage">
        <span class="skeleton-line skeleton-line--sm"></span>
      </div>
      <div class="results-card__price">
        <span class="skeleton-line skeleton-line--price"></span>
      </div>
      <div class="results-card__links">
        <span class="skeleton-line skeleton-line--link"></span>
      </div>
    </article>
  `).join("");

  resultsContainer.innerHTML = `
    <div class="results-skeleton" aria-live="polite" aria-busy="${busy ? "true" : "false"}">
      ${resultsLayoutEditorMarkup()}
      <div class="results-list-wrap" data-results-scroll="1">
        <div class="${resultsListExactClassName()}"${resultsLayoutInlineStyleAttr()}>${cards}</div>
      </div>
    </div>
  `;

  const resultsWrap = resultsScrollViewport(resultsContainer);
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

function resultsScrollViewport(container = resultsContainer) {
  return container?.querySelector("[data-results-scroll]")
    ?? container?.querySelector(".table-wrap")
    ?? null;
}

function prefersReducedMotion() {
  try {
    return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  } catch {
    return false;
  }
}

function resultsCardAnimationKey(card) {
  if (!(card instanceof HTMLElement)) {
    return "";
  }
  if (card.dataset.oid) {
    return `offer:${card.dataset.oid}`;
  }
  if (card.dataset.flexCellKey) {
    return `flex:${card.dataset.flexCellKey}`;
  }
  return "";
}

function captureResultsCardRects(container = resultsContainer) {
  const viewport = resultsScrollViewport(container) ?? container;
  if (!viewport) {
    return null;
  }

  const cards = [...viewport.querySelectorAll(".results-card[data-oid], .results-card[data-flex-cell-key]")];
  if (cards.length === 0) {
    return null;
  }

  const rects = new Map();
  cards.forEach((card) => {
    const key = resultsCardAnimationKey(card);
    if (!key) {
      return;
    }
    rects.set(key, card.getBoundingClientRect());
  });

  return rects.size > 0 ? rects : null;
}

function animateResultsCardReorder(container = resultsContainer, previousRects = null) {
  if (!container || !previousRects || previousRects.size === 0 || prefersReducedMotion()) {
    return;
  }

  const viewport = resultsScrollViewport(container) ?? container;
  if (!viewport) {
    return;
  }

  const cards = [...viewport.querySelectorAll(".results-card[data-oid], .results-card[data-flex-cell-key]")];
  if (cards.length === 0 || cards.length > RESULTS_REORDER_MAX_ANIMATED_CARDS) {
    return;
  }

  cards.forEach((card, index) => {
    const key = resultsCardAnimationKey(card);
    if (!key) {
      return;
    }

    const previous = previousRects.get(key);
    if (!previous) {
      card.animate(
        [
          { opacity: 0, transform: "translateY(5px)" },
          { opacity: 1, transform: "translateY(0)" },
        ],
        {
          duration: RESULTS_REORDER_ENTRY_DURATION_MS,
          delay: Math.min(index, 6) * 9,
          easing: RESULTS_REORDER_EASING,
          fill: "both",
        },
      );
      return;
    }

    const current = card.getBoundingClientRect();
    const deltaX = previous.left - current.left;
    const deltaY = previous.top - current.top;

    if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) {
      return;
    }

    card.animate(
      [
        { transform: `translate(${deltaX}px, ${deltaY}px)` },
        { transform: "translate(0, 0)" },
      ],
      {
        duration: RESULTS_REORDER_DURATION_MS,
        easing: RESULTS_REORDER_EASING,
        fill: "both",
      },
    );
  });
}

function captureResultsScroll(container = resultsContainer) {
  const wrap = resultsScrollViewport(container);
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
  const showPerPerson = Number.isFinite(passengerCount) && passengerCount > 1;
  const perPerson = showPerPerson ? moneyPerPassenger(m, passengerCount) : null;
  const perPersonLabel = perPerson ? formatMoney(perPerson) : "";
  return {
    totalLabel,
    perPersonLabel,
    combinedLabel: perPersonLabel ? `${totalLabel} · ${perPersonLabel}` : totalLabel,
  };
}

function renderPriceBreakdownHtml(
  m,
  passengerCount,
  {
    emptyLabel = "—",
    totalSuffix = "",
    perPersonSuffix = "",
    className = "price-stack",
    totalClassName = "price-stack__total",
    metaClassName = "price-stack__meta",
  } = {},
) {
  if (!m) {
    return escapeHtml(emptyLabel);
  }

  const totalLabel = formatMoney(m);
  const showPerPerson = Number.isFinite(passengerCount) && passengerCount > 1;
  const perPerson = showPerPerson ? moneyPerPassenger(m, passengerCount) : null;
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
  const normalizedQuery = query.trim();
  const limit = 8;

  if (auto.abortController) {
    auto.abortController.abort();
    auto.abortController = null;
  }

  if (normalizedQuery.length < 2) {
    hideLocationMenu(id);
    return;
  }

  const cachedSuggestions = readAutocompleteCache(normalizedQuery, limit);
  if (cachedSuggestions.length > 0) {
    if (!input || document.activeElement !== input) {
      hideLocationMenu(id);
      return;
    }

    auto.items = cachedSuggestions;
    auto.activeIndex = auto.items.length > 0 ? 0 : -1;
    renderLocationMenu(id);
    return;
  }

  const controller = new AbortController();
  auto.abortController = controller;

  try {
    const data = await getJson(
      `/api/locations?q=${encodeURIComponent(normalizedQuery)}&limit=${limit}&clientSessionId=${encodeURIComponent(getClientSessionId())}`,
      { signal: controller.signal },
    );
    if (autocompleteState[id].requestId !== requestId) return;
    if (auto.abortController === controller) {
      auto.abortController = null;
    }
    if (!input || document.activeElement !== input) {
      hideLocationMenu(id);
      return;
    }
    auto.items = data.suggestions ?? [];
    auto.activeIndex = auto.items.length > 0 ? 0 : -1;
    writeAutocompleteCache(normalizedQuery, limit, auto.items);
    renderLocationMenu(id);
  } catch (err) {
    if (autocompleteState[id].requestId !== requestId) return;
    if (auto.abortController === controller) {
      auto.abortController = null;
    }
    if (err?.name === "AbortError") {
      return;
    }
    if (!input || document.activeElement !== input) {
      return;
    }
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
    String(segment?.marketingCarrier ?? "").trim().toUpperCase(),
    normalizeProviderMatchFlightNumber(segment),
    String(segment?.origin ?? "").trim().toUpperCase(),
    String(segment?.destination ?? "").trim().toUpperCase(),
    normalizeProviderMatchTime(segment?.departureAt),
    normalizeProviderMatchTime(segment?.arrivalAt),
  ].join("|");
}

function providerLinkMatchKey(offer) {
  const itineraries = (offer?.itineraries ?? []).map((itinerary) => [
    String(itinerary?.direction ?? "").trim().toLowerCase(),
    (itinerary?.segments ?? []).map((segment) => providerLinkSegmentKey(segment)).join("~"),
  ].join("::")).join("||");

  return [
    String(offer?.tripType ?? state.request?.tripType ?? "").trim().toLowerCase(),
    String(offer?.origin ?? "").trim().toUpperCase(),
    String(offer?.destination ?? "").trim().toUpperCase(),
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

const PROVIDER_LINK_PRICE_TOLERANCE = 0.01;

function baggageMatchFlag(value) {
  if (value === true) return "included";
  if (value === false) return "excluded";
  return "unknown";
}

function providerLinkCandidateMatchesOffer(referenceOffer, candidateOffer) {
  if (!referenceOffer || !candidateOffer) {
    return false;
  }

  if (candidateOffer.id === referenceOffer.id) {
    return true;
  }

  const referenceTotal = referenceOffer.price?.total;
  const candidateTotal = candidateOffer.price?.total;
  const referenceCurrency = String(referenceTotal?.currencyCode ?? "").trim().toUpperCase();
  const candidateCurrency = String(candidateTotal?.currencyCode ?? "").trim().toUpperCase();
  const referenceAmount = Number(referenceTotal?.amount);
  const candidateAmount = Number(candidateTotal?.amount);

  if (!referenceCurrency || referenceCurrency !== candidateCurrency) {
    return false;
  }

  if (!Number.isFinite(referenceAmount) || !Number.isFinite(candidateAmount)) {
    return false;
  }

  if (Math.abs(referenceAmount - candidateAmount) > PROVIDER_LINK_PRICE_TOLERANCE) {
    return false;
  }

  return baggageMatchFlag(referenceOffer.baggage?.carryOnIncluded) === baggageMatchFlag(candidateOffer.baggage?.carryOnIncluded)
    && baggageMatchFlag(referenceOffer.baggage?.checkedIncluded) === baggageMatchFlag(candidateOffer.baggage?.checkedIncluded);
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
    .filter((candidateOffer) => providerLinkCandidateMatchesOffer(offer, candidateOffer))
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
  return [...groups.values()].map((group) => [...group]);
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

function itineraryWindowSummary(itinerary) {
  const segments = itinerary?.segments ?? [];
  if (segments.length === 0) {
    return {
      origin: "",
      destination: "",
      departureDate: "",
      arrivalDate: "",
      departureTime: "—",
      arrivalTime: "—",
      arrivalDayOffset: 0,
    };
  }

  const first = segments[0];
  const last = segments[segments.length - 1];
  const departureDate = typeof first?.departureAt === "string" ? first.departureAt.slice(0, 10) : "";
  const arrivalDate = typeof last?.arrivalAt === "string" ? last.arrivalAt.slice(0, 10) : "";
  let arrivalDayOffset = 0;

  try {
    arrivalDayOffset = departureDate && arrivalDate ? Math.max(0, diffDaysIso(departureDate, arrivalDate)) : 0;
  } catch {
    arrivalDayOffset = 0;
  }

  return {
    origin: String(first?.origin ?? "").trim().toUpperCase(),
    destination: String(last?.destination ?? "").trim().toUpperCase(),
    departureDate,
    arrivalDate,
    departureTime: timeOfIso(first?.departureAt) || "—",
    arrivalTime: timeOfIso(last?.arrivalAt) || "—",
    arrivalDayOffset,
  };
}

function primaryItineraryForOffer(offer) {
  return offer?.itineraries?.find((itinerary) => itinerary.direction === "outbound")
    ?? offer?.itineraries?.[0]
    ?? null;
}

function formatJourneyDurationLabel(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return "—";
  }

  const total = Math.round(minutes);
  const days = Math.floor(total / (24 * 60));
  const hours = Math.floor((total % (24 * 60)) / 60);
  const mins = total % 60;
  const parts = [];

  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);

  return parts.join(" ");
}

function flightCodeLabel(segment) {
  const marketingCarrier = String(segment?.marketingCarrier ?? "").trim().toUpperCase();
  const rawFlightNumber = typeof segment?.flightNumber === "string"
    ? segment.flightNumber.trim().toUpperCase().replace(/\s+/g, "")
    : "";

  if (!rawFlightNumber) {
    return "";
  }

  if (marketingCarrier && !rawFlightNumber.startsWith(marketingCarrier)) {
    return `${marketingCarrier}${rawFlightNumber}`;
  }

  return rawFlightNumber;
}

function offerFlightCodesLabel(offer) {
  const tokens = (offer?.itineraries ?? [])
    .flatMap((itinerary) => itinerary?.segments ?? [])
    .map((segment) => flightCodeLabel(segment))
    .filter(Boolean);

  return [...new Set(tokens)].join(" · ");
}

function offerOperatingCopy(offer) {
  const primaryCarrier = carrierDisplayParts(offer);
  const primaryTokens = new Set(
    [primaryCarrier.code, primaryCarrier.name, primaryCarrier.display]
      .map((value) => String(value ?? "").trim().toUpperCase())
      .filter(Boolean),
  );
  const operators = new Set();

  (offer?.itineraries ?? []).forEach((itinerary) => {
    (itinerary?.segments ?? []).forEach((segment) => {
      const marketingCarrier = String(segment?.marketingCarrier ?? "").trim().toUpperCase();
      const operatingCarrier = String(segment?.operatingCarrier ?? "").trim().toUpperCase();
      const operatingName = typeof segment?.operatingCarrierName === "string" ? segment.operatingCarrierName.trim() : "";
      const label = operatingName || operatingCarrier;
      const normalizedLabel = label.toUpperCase();

      if (!label) return;
      if (operatingCarrier && marketingCarrier && operatingCarrier === marketingCarrier) return;
      if (primaryTokens.has(normalizedLabel) || primaryTokens.has(operatingCarrier)) return;
      operators.add(label);
    });
  });

  if (operators.size === 0) {
    return "";
  }

  return `Opera con ${[...operators].join(" / ")}`;
}

function renderBaggageIconsHtml(offer) {
  const baggage = offer?.baggage ?? {};
  const items = [
    {
      icon: "ico-personal-item",
      label: "Artículo personal",
      included: baggage.carryOnIncluded === true,
    },
    {
      icon: "ico-carry-on",
      label: "Cabina",
      included: baggage.carryOnIncluded === true,
    },
    {
      icon: "ico-luggage",
      label: "Bodega",
      included: baggage.checkedIncluded === true,
    },
  ];

  return `
    <span class="baggage-icons" aria-label="Disponibilidad de equipaje">
      ${items.map((item) => `
        <span class="baggage-icons__item ${item.included ? "is-included" : "is-missing"}" title="${escapeHtml(item.label)}">
          <svg class="ico ico--sm ${item.included ? "ico--bag-yes" : "ico--bag-no"}" aria-hidden="true"><use href="#${item.icon}"/></svg>
        </span>
      `).join("")}
    </span>
  `;
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

function resolveVisibleResultsPageSize(viewport = resultsScrollViewport(resultsContainer) ?? resultsContainer) {
  if (!(viewport instanceof HTMLElement)) {
    return Math.max(1, Math.trunc(state.resultsPageSize) || RESULTS_PAGE_SIZE);
  }

  const tableHeader = viewport.querySelector("thead");
  const sampleRows = [
    ...viewport.querySelectorAll("[data-oid], .results-card--placeholder, [data-flex-cell-key]"),
  ]
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
  const viewport = resultsScrollViewport(resultsContainer) ?? resultsContainer;
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
    revision: 0,
    unchanged: false,
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

function resetExactSearchUiState(request, sortModeValue, { syncForm = false } = {}) {
  stopMatrixPolling();
  stopSearchPolling();
  exitMigrationMode();
  state.sortMode = sortModeValue || state.sortMode || "cheapest";
  state.resultsPage = 1;
  state.quotationText = "";
  state.selectedOfferId = null;
  state.selectedMatrixKey = null;
  state.detailPendingAction = null;
  state.airlineFilter.hidden.clear();
  state.airlineFilter.only = null;
  state.resultsScroll = { top: 0, left: 0 };
  state.matrixExpanded = false;
  state.matrixResponse = null;
  state.viewMode = "list";
  state.request = request;
  if (syncForm) {
    syncSearchFormWithRequest(request);
  }
}

function seedExactSearchResponse(request, sortModeValue) {
  const cached = readSearchResultCache(request, sortModeValue);
  state.searchJobId = null;
  if (cached) {
    setSearchResponse({
      ...cached,
      searchJobId: null,
    }, { cache: false });
    return true;
  }

  setSearchResponse(buildPendingSearchResponse(request, sortModeValue), { cache: false });
  return false;
}

async function fetchExactSearchData(request, sortModeValue, { syncForm = false } = {}) {
  const data = await postJson("/api/search", { request, sortMode: sortModeValue });
  state.request = data.request ?? request;
  if (syncForm) {
    syncSearchFormWithRequest(state.request);
  }
  setSearchResponse(data);
  state.searchJobId = data.searchJobId ?? null;
  if (!data.searchComplete && state.searchJobId) {
    queueSearchPoll(state.searchJobId);
  }
  return data;
}

async function launchExactSearchInCurrentTab(payload, { syncForm = false } = {}) {
  if (!payload?.request) {
    return false;
  }
  const sortModeValue = payload.sortMode || state.sortMode || "cheapest";
  resetExactSearchUiState(payload.request, sortModeValue, { syncForm });
  seedExactSearchResponse(payload.request, sortModeValue);
  renderAll();
  await fetchExactSearchData(payload.request, sortModeValue, { syncForm });
  renderAll();
  return true;
}

function applyStartupLaunchPayload(payload) {
  if (!payload?.request) {
    return false;
  }
  const sortModeValue = payload.sortMode || state.sortMode || "cheapest";
  resetExactSearchUiState(payload.request, sortModeValue, { syncForm: true });
  seedExactSearchResponse(payload.request, sortModeValue);
  return true;
}

async function refreshStartupLaunchPayload(payload) {
  if (!payload?.request) {
    return;
  }
  const sortModeValue = payload.sortMode || state.sortMode || "cheapest";
  try {
    await fetchExactSearchData(payload.request, sortModeValue, { syncForm: true });
    renderAll();
  } catch (err) {
    showToast(err.message);
  }
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
    return '<span class="results-card__stops-summary results-card__stops-summary--direct" title="Vuelo directo">Directo</span>';
  }

  const items = layoverItemsForOffer(offer);
  const toneClass = stops === 1
    ? "results-card__stops-summary--warning"
    : "results-card__stops-summary--danger";
  const label = stops === 1 ? "1 escala" : `${stops} escalas`;
  const primaryCity = items[0]?.city || "Ciudad por confirmar";
  const citySummary = items.length > 1 ? `${primaryCity} +${items.length - 1}` : primaryCity;
  const summaryText = `${label} · ${citySummary}`;
  const detailTitle = items.length
    ? `${label}: ${items.map((item) => item.city).join(" | ")}`
    : summaryText;

  return `
    <span class="results-card__stops-summary ${toneClass}" title="${escapeHtml(detailTitle)}">${escapeHtml(summaryText)}</span>
  `;
}

function buildResultCardLabel({ isActive, carrier, dateSummary, durationLabel, priceLabel }) {
  return [
    isActive ? "Oferta seleccionada" : "Seleccionar oferta",
    carrier,
    dateSummary,
    durationLabel,
    priceLabel,
  ].filter(Boolean).join(" · ");
}

function renderExactResultsCardHtml(group, selectedOfferId, providerLinkIndex, passengerCount) {
  const offer = group.find((entry) => entry.id === selectedOfferId) ?? group[0];
  const isActive = group.some((entry) => entry.id === selectedOfferId);
  const carrier = carrierDisplayParts(offer);
  const dateSummary = buildGroupDateSummary(group, selectedOfferId);
  const itinerary = primaryItineraryForOffer(offer);
  const windowSummary = itineraryWindowSummary(itinerary);
  const price = priceLabels(offer.price?.total, passengerCount);
  const durationLabel = formatJourneyDurationLabel(
    offer.comparisonMetrics?.totalDurationMinutes ?? totalDurationMinutes(offer),
  );
  const flightCodes = offerFlightCodesLabel(offer);
  const operatingCopy = offerOperatingCopy(offer);
  const badge = group.length > 1
    ? `<span class="badge badge--accent badge--group-count" title="${group.length} fechas equivalentes">${group.length}</span>`
    : "";
  const rowLabel = buildResultCardLabel({
    isActive,
    carrier: carrier.display,
    dateSummary: dateSummary.primary,
    durationLabel,
    priceLabel: price.combinedLabel,
  });
  const arrivalOffset = windowSummary.arrivalDayOffset > 0
    ? `<span class="results-card__schedule-offset">+${windowSummary.arrivalDayOffset}</span>`
    : "";
  const routeLabel = [windowSummary.origin, windowSummary.destination].filter(Boolean).join(" - ") || "Ruta por confirmar";
  const dateSecondary = dateSummary.secondary
    ? `<span class="cell-sub">${escapeHtml(dateSummary.secondary)}</span>`
    : '<span class="cell-sub cell-sub--ghost" aria-hidden="true">&nbsp;</span>';

  return `
    <article
      class="results-card ${isActive ? "is-active" : ""}"
      data-oid="${offer.id}"
      tabindex="0"
      role="button"
      aria-label="${escapeHtml(rowLabel)}"
      aria-pressed="${isActive ? "true" : "false"}"
    >
      <div class="results-card__airline">
        <span class="results-card__airline-name carrier-label" data-result-airline title="${escapeHtml(carrier.display)}">${escapeHtml(carrier.display)}</span>
        ${flightCodes ? `<span class="results-card__airline-meta" data-result-flight-numbers>${escapeHtml(flightCodes)}</span>` : ""}
        ${operatingCopy ? `<span class="results-card__airline-meta results-card__airline-meta--muted">${escapeHtml(operatingCopy)}</span>` : ""}
      </div>

      <div class="results-card__schedule">
        <div class="results-card__schedule-main" data-result-schedule>
          <span>${escapeHtml(windowSummary.departureTime)}</span>
          <span class="results-card__schedule-separator">-</span>
          <span>${escapeHtml(windowSummary.arrivalTime)}</span>
          ${arrivalOffset}
        </div>
        <span class="results-card__schedule-sub">${windowSummary.departureDate ? `Ida ${escapeHtml(formatDateCompact(windowSummary.departureDate))}` : "Horario por confirmar"}</span>
      </div>

      <div class="results-card__route">
        <span class="results-card__route-main" data-result-route>${escapeHtml(routeLabel)}</span>
        <div class="results-date-stack" data-result-dates title="${escapeHtml(dateSummary.title)}">
          <span class="cell-main">${escapeHtml(dateSummary.primary)}${badge}</span>
          ${dateSecondary}
        </div>
      </div>

      <div class="results-card__journey">
        <span class="results-card__journey-main" data-result-duration>${escapeHtml(durationLabel)}</span>
        <div class="results-card__journey-sub" data-result-stops>${renderStopsSummary(offer)}</div>
      </div>

      <div class="results-card__baggage" data-result-baggage>
        <span class="results-card__micro-label">Equipaje</span>
        ${renderBaggageIconsHtml(offer)}
      </div>

      <div class="results-card__price results-price" data-result-price>${renderPriceBreakdownHtml(offer.price?.total, passengerCount)}</div>
      <div class="results-card__links results-links-cell" data-result-links>${renderProviderLinksCell(offer, providerLinkIndex)}</div>
    </article>
  `;
}

function flexibleRouteSummary(cell) {
  const request = flexibleCellRequest(cell) ?? state.matrixResponse?.request ?? state.request ?? {};
  const leg = request?.legs?.[0] ?? {};
  return [leg.origin, leg.destination].filter(Boolean).join(" - ") || toolbarRouteSummary(request) || "Ruta por confirmar";
}

function renderFlexibleResultsCardHtml(cell) {
  const isActive = cell.key === state.selectedMatrixKey;
  const stayLabel = cell.stayNights != null ? `${cell.stayNights} noches` : "—";
  const passengerCount = passengerCountForRequest(flexibleCellRequest(cell) ?? state.matrixResponse?.request ?? state.request);
  const priceHtml = cell.confidence === "loading"
    ? '<span class="results-card__status">Cargando...</span>'
    : cell.price
      ? renderPriceBreakdownHtml(cell.price, passengerCount)
      : `<span class="results-card__status">${escapeHtml(flexibleCellStateLabel(cell))}</span>`;
  const rowLabel = [
    isActive ? "Combinación seleccionada" : "Ver combinación flexible",
    formatDateCompact(cell.departureDate),
    cell.returnDate ? formatDateCompact(cell.returnDate) : "",
    stayLabel,
    cell.price ? priceLabels(cell.price, passengerCount).combinedLabel : flexibleCellStateLabel(cell),
  ].filter(Boolean).join(" · ");

  return `
    <article
      class="results-card results-card--flexible ${isActive ? "is-active" : ""} ${!cell.selectable ? "results-card--disabled" : ""}"
      data-flex-cell-key="${cell.key}"
      data-mk="${cell.key}"
      tabindex="0"
      role="button"
      aria-label="${escapeHtml(rowLabel)}"
      aria-pressed="${isActive ? "true" : "false"}"
      title="${escapeHtml(cell.tooltip ?? "")}"
    >
      <div class="results-card__schedule">
        <div class="results-card__schedule-main">${escapeHtml(formatDateCompact(cell.departureDate))}</div>
        <span class="results-card__schedule-sub">${escapeHtml(cell.returnDate ? formatDateCompact(cell.returnDate) : "—")}</span>
      </div>

      <div class="results-card__route">
        <span class="results-card__route-main">${escapeHtml(flexibleRouteSummary(cell))}</span>
        <div class="results-date-stack">
          <span class="cell-main">${escapeHtml(stayLabel)}</span>
          <span class="cell-sub">${escapeHtml(providerLabel(cell.providerSource))}</span>
        </div>
      </div>

      <div class="results-card__journey results-card__journey--flex">
        <span class="results-card__journey-main">${escapeHtml(flexibleCellStateLabel(cell))}</span>
        <span class="cell-sub">${escapeHtml(cell.selectable ? "Consulta exacta disponible" : "Sin reconsulta disponible")}</span>
      </div>

      <div class="results-card__price results-price">${priceHtml}</div>
    </article>
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

function setSearchResponse(data, { cache = true } = {}) {
  state.searchResponse = {
    ...data,
    revision: Number.isFinite(data?.revision) ? data.revision : 0,
    unchanged: false,
    serverOffers: data.offers ?? [],
    allOffers: data.allOffers ?? data.offers ?? [],
    offers: data.offers ?? [],
    filteredOffers: data.allOffers ?? data.offers ?? [],
    visibleOfferGroups: data.visibleOfferGroups ?? [],
  };
  applyClientOfferControls();
  if (cache) {
    writeSearchResultCache(state.searchResponse.request, state.searchResponse.sortMode, state.searchResponse);
  }
}

function applySearchResponseMeta(data) {
  if (!state.searchResponse) return;
  state.searchResponse.searchJobId = data.searchJobId ?? state.searchResponse.searchJobId;
  state.searchResponse.searchComplete = Boolean(data.searchComplete);
  state.searchResponse.searchStatus = data.searchStatus ?? state.searchResponse.searchStatus;
  state.searchResponse.revision = Number.isFinite(data?.revision)
    ? data.revision
    : (state.searchResponse.revision ?? 0);
  state.searchResponse.request = data.request ?? state.searchResponse.request;
  state.searchResponse.sortMode = data.sortMode ?? state.searchResponse.sortMode;
  state.searchResponse.searchMeta = data.searchMeta ?? state.searchResponse.searchMeta;
  state.searchResponse.providerMeta = data.providerMeta ?? state.searchResponse.providerMeta;
  state.searchResponse.warnings = data.warnings ?? state.searchResponse.warnings;
  state.searchResponse.error = data.error ?? state.searchResponse.error;
  state.searchResponse.unchanged = Boolean(data.unchanged);
  writeSearchResultCache(state.searchResponse.request, state.searchResponse.sortMode, state.searchResponse);
}

function applyMatrixResponseMeta(data) {
  if (!state.matrixResponse) return;
  state.matrixResponse.matrixJobId = data.matrixJobId ?? state.matrixResponse.matrixJobId;
  state.matrixResponse.matrixComplete = Boolean(data.matrixComplete);
  state.matrixResponse.matrixStatus = data.matrixStatus ?? state.matrixResponse.matrixStatus;
  state.matrixResponse.revision = Number.isFinite(data?.revision)
    ? data.revision
    : (state.matrixResponse.revision ?? 0);
  state.matrixResponse.request = data.request ?? state.matrixResponse.request;
  state.matrixResponse.searchMeta = data.searchMeta ?? state.matrixResponse.searchMeta;
  state.matrixResponse.providerMeta = data.providerMeta ?? state.matrixResponse.providerMeta;
  state.matrixResponse.warnings = data.warnings ?? state.matrixResponse.warnings;
  state.matrixResponse.error = data.error ?? state.matrixResponse.error;
  state.matrixResponse.unchanged = Boolean(data.unchanged);
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
        const sinceRevision = Number.isFinite(state.searchResponse?.revision) ? state.searchResponse.revision : 0;
        const pollUrl = sinceRevision > 0
          ? `/api/search/${jobId}?sinceRevision=${encodeURIComponent(String(sinceRevision))}`
          : `/api/search/${jobId}`;
        const data = await getJson(pollUrl);
        if (state.searchJobId !== jobId) return;
        state.request = data.request ?? state.request;
        if (data.unchanged) {
          applySearchResponseMeta(data);
        } else {
          setSearchResponse(data);
        }
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
        const sinceRevision = Number.isFinite(state.matrixResponse?.revision) ? state.matrixResponse.revision : 0;
        const pollUrl = sinceRevision > 0
          ? `/api/matrix/${jobId}?sinceRevision=${encodeURIComponent(String(sinceRevision))}`
          : `/api/matrix/${jobId}`;
        const data = await getJson(pollUrl);
        if (state.matrixJobId !== jobId) return;
        if (data.unchanged) {
          applyMatrixResponseMeta(data);
        } else {
          state.matrixResponse = {
            ...data,
            revision: Number.isFinite(data?.revision) ? data.revision : 0,
            unchanged: false,
          };
        }
        state.request = data.request ?? state.request;
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
  const previousCardRects = captureResultsCardRects(resultsContainer);
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
    const emptyPanelHtml = renderEmptyPanel(emptySearchPanelModel(state.searchResponse));
    resultsContainer.innerHTML = resultsLayoutEditorEnabled()
      ? `${resultsLayoutEditorMarkup()}${emptyPanelHtml}`
      : emptyPanelHtml;
    return;
  }

  if (offers.length === 0 && isRunning) {
    renderResultsSkeleton({ busy: true });
    return;
  }

  const providerLinkIndex = buildProviderLinkIndex(state.searchResponse?.allOffers ?? offers);
  const passengerCount = passengerCountForRequest(state.searchResponse?.request ?? state.request);
  const cards = visibleOfferGroups
    .map((group) => renderExactResultsCardHtml(group, state.selectedOfferId, providerLinkIndex, passengerCount))
    .join("");
  const loadingHtml = isRunning
    ? '<div class="results-loading results-loading--inline"><span>Los resultados se seguirán agregando.</span></div>'
    : "";
  const html = `
    ${resultsLayoutEditorMarkup()}
    ${loadingHtml}
    <div class="results-list-wrap" data-results-scroll="1" aria-live="polite" aria-busy="${isRunning ? "true" : "false"}">
      <div class="${resultsListExactClassName()}"${resultsLayoutInlineStyleAttr()}>${cards}</div>
    </div>
  `;

  resultsContainer.innerHTML = html;
  const resultsWrap = resultsScrollViewport(resultsContainer);
  const pageSizeChanged = syncResultsPageSize();
  if (pageSizeChanged && state.searchResponse?.allOffers?.length) {
    applyClientOfferControls();
    renderResultsArea();
    renderDetailPanel();
    updateResultsToolbar();
    return;
  }
  syncResultsScroll(resultsWrap);
  requestAnimationFrame(() => {
    syncResultsScroll(resultsWrap);
    animateResultsCardReorder(resultsContainer, previousCardRects);
  });
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
  if (resultsLayoutEditorEnabled()) {
    const actionButton = e.target.closest("[data-results-layout-action]");
    if (actionButton) {
      if (actionButton.dataset.resultsLayoutAction === "save") {
        void saveResultsLayoutDraft();
      } else if (actionButton.dataset.resultsLayoutAction === "reset") {
        resetResultsLayoutDraft();
      }
      return;
    }
  }

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

  const flexibleRow = e.target.closest("[data-flex-cell-key]");
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
  const row = e.target.closest("[data-oid]");
  if (!row) return;
  selectOffer(row.dataset.oid);
}

function focusAdjacentResultsRow(currentRow, step, selector = "[data-oid]") {
  const rows = [...resultsContainer?.querySelectorAll(selector) ?? []];
  const currentIndex = rows.indexOf(currentRow);
  if (currentIndex < 0) {
    return;
  }

  rows[currentIndex + step]?.focus();
}

function handleResultsKeydown(e) {
  const flexibleRow = e.target.closest("[data-flex-cell-key]");
  if (flexibleRow) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectMatrixCell(flexibleRow.dataset.flexCellKey);
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusAdjacentResultsRow(flexibleRow, 1, "[data-flex-cell-key]");
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      focusAdjacentResultsRow(flexibleRow, -1, "[data-flex-cell-key]");
    }
    return;
  }

  const matrixRow = e.target.closest("[data-mk]");
  if (matrixRow) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void handleMatrixClick({ target: matrixRow });
    }
    return;
  }

  if (e.target.closest("[data-stop-row]")) return;
  const row = e.target.closest("[data-oid]");
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

function handleResultsInput(e) {
  if (!resultsLayoutEditorEnabled()) {
    return;
  }

  const input = e.target.closest("[data-results-layout-input]");
  if (!input) {
    return;
  }

  updateResultsLayoutDraftColumn(input.dataset.resultsLayoutInput, input.value);
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
      ? "Abrir busqueda carga el detalle interno. El enlace externo abre la búsqueda equivalente en el proveedor."
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
  const previousCardRects = captureResultsCardRects(container);
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
    <div class="results-list-wrap" data-results-scroll="1" aria-live="polite" aria-busy="${isRunning ? "true" : "false"}">
      <div class="results-list results-list--flexible">
  `;

  orderedCells.forEach((cell) => {
    html += renderFlexibleResultsCardHtml(cell);
  });

  html += `
      </div>
    </div>
  `;

  container.innerHTML = html;
  const resultsWrap = resultsScrollViewport(container);
  syncResultsScroll(resultsWrap);
  requestAnimationFrame(() => {
    syncResultsScroll(resultsWrap);
    animateResultsCardReorder(container, previousCardRects);
  });
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
  const payload = { request: derivedRequest, sortMode: state.sortMode };
  openSearchPayloadInNewTab(payload);
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
  const hideSidebar = () => {
    airlineBar.classList.add("hidden");
    airlineBar.innerHTML = "";
    resultsSidebar?.classList.add("hidden");
    resultsPanelBody?.classList.remove("has-sidebar");
  };

  if (!offersForFacets.length) {
    hideSidebar();
    return;
  }

  const airlines = buildAirlineList(offersForFacets);
  if (airlines.length <= 1) {
    hideSidebar();
    return;
  }

  const activeCode = state.airlineFilter.only;
  airlineBar.classList.remove("hidden");
  resultsSidebar?.classList.remove("hidden");
  resultsPanelBody?.classList.add("has-sidebar");
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
            <span class="airline-chip__meta">${priceStr}</span>
            <span class="airline-chip__meta">${airline.count} opción${airline.count === 1 ? "" : "es"}</span>
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
      html += `<div class="matrix-price cal-price ${isLoading ? "matrix-price--loading" : ""}">${isLoading ? "..." : cell.price ? renderPriceBreakdownHtml(cell.price, passengerCount, { className: "price-stack price-stack--matrix" }) : "—"}</div>`;
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
        html += `<div class="matrix-price cal-price ${isLoading ? "matrix-price--loading" : ""}">${isLoading ? "..." : cell.price ? renderPriceBreakdownHtml(cell.price, passengerCount, { className: "price-stack price-stack--matrix" }) : "—"}</div>`;
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
    h += detailPairHtml("Por pax", priceLabels(cell.price, passengerCount).perPersonLabel);
  }
  h += detailPairHtml("Filtros", flexibleCellFilterSummary(request?.filters ?? fallbackRequest?.filters));
  h += detailPairHtml("Cabina", request?.cabin ?? fallbackRequest?.cabin ?? "ECONOMY");
  h += '</div>';

  h += '<div class="detail-section">';
  h += '<div class="detail-section__header">';
  h += '<div class="detail-section__title">Oferta</div>';
  if (cell.selectable && cell.derivedRequest) {
    h += `<button type="button" class="btn btn--primary btn--sm" data-matrix-detail-search="${escapeHtml(cell.key)}">Abrir busqueda</button>`;
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
  h += `<div class="detail-pair"><span class="detail-pair__key">Por pax</span><span class="detail-pair__val">${offerPriceLabels.perPersonLabel}</span></div>`;
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
resultsContainer?.addEventListener("input", handleResultsInput);
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
    markPollingUiInteraction();
    state.sortMode = controlValue("sortMode") || state.sortMode;
    if (state.migrationActive) {
      applyMigrationClientOfferControls();
      renderMigrationResults();
      return;
    }
    if (!state.searchResponse?.allOffers) return;
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

    if (translatedPayload.request.searchMode === "roundtrip-grid") {
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
      await launchExactSearchInCurrentTab(translatedPayload, { syncForm: false });
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
const MIGRATION_CONCURRENT_REQUESTS = 2;
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
  state.migrationPollHandles.clear();
}

function isCurrentMigrationRun(runId) {
  return state.migrationActive && state.migrationRunId === runId;
}

function exitMigrationMode() {
  stopMigrationPolling();
  state.migrationRunId += 1;
  state.migrationActive = false;
  state.migrationMonths = [];
  resultsToolbar?.classList.remove("hidden");
}

function migrationMonthProviderIds(month) {
  const providerIds = month?.providerIds;
  if (Array.isArray(providerIds) && providerIds.length > 0) {
    return providerIds;
  }

  return defaultProviderIds(month?.request ?? state.request);
}

function migrationMonthOffers(month) {
  return Array.isArray(month?.offers) ? month.offers : [];
}

function migrationMonthSelection(month, filters = getActiveClientFilters()) {
  const allOffers = migrationMonthOffers(month);
  const offers = getOffersForVisibleFacets(allOffers, filters);
  if (offers.length === 0) {
    return { cheapest: null, providerPaths: {} };
  }

  const cheapest = offers.reduce((best, offer) =>
    ((offer.price?.total?.amount ?? offer.totalPrice ?? Infinity) < (best.price?.total?.amount ?? best.totalPrice ?? Infinity) ? offer : best), offers[0]);
  const providerLinkIndex = buildProviderLinkIndex(allOffers);
  const providerPaths = {};
  migrationMonthProviderIds(month).forEach((providerId) => {
    const path = bestProviderPathForOffer(cheapest, providerId, providerLinkIndex);
    if (path) {
      providerPaths[providerId] = path;
    }
  });
  return { cheapest, providerPaths };
}

function applyMigrationMonthSelection(month, filters = getActiveClientFilters()) {
  if (!month) return;
  const selection = migrationMonthSelection(month, filters);
  month.cheapest = selection.cheapest;
  month.providerPaths = selection.providerPaths;
}

function applyMigrationClientOfferControls(filters = getActiveClientFilters()) {
  if (!state.migrationActive) return;
  state.migrationMonths.forEach((month) => {
    applyMigrationMonthSelection(month, filters);
  });
}

function migrationOfferDepartureDate(offer) {
  const primaryDate = offerPrimaryDates(offer).departureDate;
  return primaryDate
    || offer?.itineraries?.[0]?.segments?.[0]?.departureDate
    || offer?.departureDate
    || "";
}

function renderMigrationProviderAction(path, providerId, responseMeta) {
  if (pathSupportsEquivalentSearch(path)) {
    return `<a href="${escapeHtml(path.url)}" target="_blank" rel="noreferrer" class="btn btn--ghost btn--sm migration-card__action">${escapeHtml(providerLabel(providerId))}</a>`;
  }

  const fallback = providerLinkFallbackLabel(responseMeta, providerId);
  if (fallback.label === "—") {
    return "";
  }

  const titleAttr = fallback.title ? ` title="${escapeHtml(fallback.title)}"` : "";
  return `<span class="migration-card__action migration-card__action--warning"${titleAttr}>${escapeHtml(providerLabel(providerId))}: ${escapeHtml(fallback.label)}</span>`;
}

function renderMigrationCardActions(month, index) {
  const offer = month?.cheapest;
  if (!offer) {
    return "";
  }

  const departureDate = migrationOfferDepartureDate(offer);
  const responseMeta = month?.responseMeta ?? null;
  const providerPaths = month?.providerPaths ?? {};
  const providerItems = migrationMonthProviderIds(month)
    .map((providerId) => renderMigrationProviderAction(providerPaths?.[providerId], providerId, responseMeta))
    .filter(Boolean);

  let html = `<div class="migration-card__actions">`;
  if (departureDate) {
    html += `<button type="button" class="btn btn--primary btn--sm migration-card__action" data-migration-exact-index="${index}">Abrir busqueda</button>`;
  }
  if (providerItems.length > 0) {
    html += `<div class="migration-card__links">${providerItems.join("")}</div>`;
  }
  html += `</div>`;
  return html;
}

function buildMigrationExactSearchPayload(month, offer) {
  const departureDate = migrationOfferDepartureDate(offer);
  if (!departureDate) {
    return null;
  }

  const basePayload = getFormPayload();
  const baseRequest = basePayload.request ?? {};
  const baseLeg = baseRequest.legs?.[0] ?? {};
  const originLabel = month?.originLabel ?? $("origin")?.dataset.label ?? $("origin")?.value ?? month?.origin ?? "";
  const destinationLabel = month?.destinationLabel ?? $("destination")?.dataset.label ?? $("destination")?.value ?? month?.destination ?? "";

  return {
    ...basePayload,
    request: {
      ...baseRequest,
      tripType: "one-way",
      searchMode: "exact",
      flexibleMode: undefined,
      legs: [{
        ...baseLeg,
        origin: month?.origin ?? baseLeg.origin ?? "",
        destination: month?.destination ?? baseLeg.destination ?? "",
        originLabel,
        destinationLabel,
        departureDate,
        returnDate: "",
        departureStart: "",
        departureEnd: "",
        returnStart: "",
        returnEnd: "",
        stayNights: undefined,
      }],
    },
  };
}

async function launchMigrationExactSearch(index) {
  const month = state.migrationMonths[index];
  if (!month) return;
  applyMigrationMonthSelection(month);
  const offer = month.cheapest;
  if (!offer) return;

  const payload = buildMigrationExactSearchPayload(month, offer);
  if (!payload) {
    showToast("No pude derivar una fecha exacta desde este resultado migratorio.");
    return;
  }
  openSearchPayloadInNewTab(payload);
}

function renderMigrationResults() {
  if (!resultsContainer) return;
  if (!state.migrationActive) return;
  const months = state.migrationMonths;
  if (!months || months.length === 0) {
    resultsContainer.innerHTML = "";
    return;
  }
  applyMigrationClientOfferControls();

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
  h += `<div class="migration-grid-wrap" role="region" aria-label="Resultados migratorios por mes" tabindex="0">`;
  h += `<div class="migration-grid">`;

  for (let index = 0; index < months.length; index++) {
    const m = months[index];
    const statusClass = m.complete
      ? (m.cheapest ? "migration-card--ok" : "migration-card--empty")
      : "migration-card--loading";
    h += `<div class="migration-card ${statusClass}">`;
    h += `<div class="migration-card__month">${escapeHtml(m.label)}</div>`;
    if (!m.complete && !m.cheapest) {
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
      const date = migrationOfferDepartureDate(offer);
      h += `<div class="migration-card__price">${renderPriceBreakdownHtml(totalMoney, passengerCount)}</div>`;
      if (date) {
        h += `<div class="migration-card__detail">Fecha exacta: ${escapeHtml(formatDateCompact(date))}</div>`;
      }
      if (airline) {
        h += `<div class="migration-card__detail">${escapeHtml(airline)}</div>`;
      }
      if (offer.itineraries?.[0]?.stops != null) {
        const stops = offer.itineraries[0].stops;
        h += `<div class="migration-card__detail">${stops === 0 ? "Directo" : stops + " escala" + (stops > 1 ? "s" : "")}</div>`;
      }
      if (!m.complete) {
        h += `<div class="migration-card__detail">Actualizando mejor tarifa&hellip;</div>`;
      }
      h += renderMigrationCardActions(m, index);
    } else {
      h += `<div class="migration-card__price migration-card__price--empty">Sin resultados</div>`;
      if (m.error) {
        h += `<div class="migration-card__detail migration-card__detail--error">${escapeHtml(m.error)}</div>`;
      }
    }
    h += `</div>`;
  }

  h += `</div></div></div>`;
  resultsContainer.innerHTML = h;
  resultsContainer.querySelectorAll("[data-migration-exact-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number.parseInt(button.dataset.migrationExactIndex ?? "", 10);
      if (Number.isFinite(index)) {
        void launchMigrationExactSearch(index);
      }
    });
  });
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

  const runId = state.migrationRunId;
  state.migrationActive = true;
  state.searchResponse = null;
  state.matrixResponse = null;
  state.selectedOfferId = null;

  const monthRanges = migrationMonthRanges(todayISO(), MIGRATION_MONTH_COUNT);
  const adults = parseInt($("adults")?.value, 10) || 1;
  const children = parseInt($("children")?.value, 10) || 0;
  const infants = parseInt($("infants")?.value, 10) || 0;
  const originLabel = $("origin")?.dataset.label ?? $("origin")?.value ?? "";
  const destinationLabel = $("destination")?.dataset.label ?? $("destination")?.value ?? "";

  state.migrationMonths = monthRanges.map((m) => ({
    ...m,
    origin,
    destination,
    originLabel,
    destinationLabel,
    jobId: null,
    offers: [],
    cheapest: null,
    providerPaths: {},
    complete: false,
    error: null,
    request: null,
    revision: 0,
    providerIds: defaultProviderIds(state.request),
    responseMeta: {
      warnings: [],
      searchMeta: {
        providersUsed: defaultProviderIds(state.request),
      },
    },
  }));

  if (resultsToolbar) resultsToolbar.classList.add("hidden");
  if (emptyState) emptyState.classList.add("hidden");
  renderMigrationResults();

  const launchMonthSearch = async (index) => {
    const month = state.migrationMonths[index];
    if (!month) return;

    const payload = {
      sortMode: "cheapest",
      providerConfig: normalizeClipboardProviderConfig(state.providerConfig) || undefined,
      request: {
        tripType: "one-way",
        searchMode: "stay-range",
        cabin: "ECONOMY",
        currencyCode: DEFAULT_CURRENCY_CODE,
        coverageMode: "core",
        redirectMode: "best-effort",
        passengers: { adults, children, infants },
        filters: { nonStop: false },
        legs: [{
          origin,
          destination,
          originLabel,
          destinationLabel,
          departureDate: "",
          returnDate: "",
          departureStart: month.departureStart,
          departureEnd: month.departureEnd,
          returnStart: "",
          returnEnd: "",
        }],
      },
    };

    try {
      const data = await postJson("/api/search", payload);
      if (!isCurrentMigrationRun(runId)) return;
      const currentMonth = state.migrationMonths[index];
      if (!currentMonth) return;
      currentMonth.jobId = data.searchJobId ?? null;
      updateMigrationMonth(index, data, runId);
      if (!data.searchComplete && currentMonth.jobId) {
        queueMigrationPoll(index, currentMonth.jobId, runId);
      }
    } catch (err) {
      if (!isCurrentMigrationRun(runId)) return;
      const currentMonth = state.migrationMonths[index];
      if (currentMonth) {
        currentMonth.complete = true;
        currentMonth.error = err.message;
      }
    }
    renderMigrationResults();
  };

  void (async () => {
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(MIGRATION_CONCURRENT_REQUESTS, state.migrationMonths.length) },
      () => (async () => {
        while (isCurrentMigrationRun(runId)) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= state.migrationMonths.length) {
            return;
          }
          await launchMonthSearch(index);
        }
      })(),
    );
    await Promise.allSettled(workers);
  })();
}

function updateMigrationMonth(index, data, runId = state.migrationRunId) {
  if (!isCurrentMigrationRun(runId)) return;
  const m = state.migrationMonths[index];
  if (!m) return;
  m.complete = Boolean(data.searchComplete);
  m.request = data.request ?? m.request;
  m.revision = Number.isFinite(data?.revision) ? data.revision : (m.revision ?? 0);
  m.providerIds = Array.isArray(data?.searchMeta?.providersUsed) && data.searchMeta.providersUsed.length > 0
    ? [...data.searchMeta.providersUsed]
    : m.providerIds;
  m.responseMeta = {
    warnings: [...(data?.warnings ?? [])],
    searchMeta: {
      ...(data?.searchMeta ?? {}),
      providersUsed: migrationMonthProviderIds(m),
    },
  };

  if (data.unchanged) {
    applyMigrationMonthSelection(m);
    return;
  }

  const offers = data.allOffers ?? data.offers ?? [];
  m.offers = offers;
  if (offers.length === 0) {
    m.cheapest = null;
    m.providerPaths = {};
    return;
  }

  applyMigrationMonthSelection(m);
}

function queueMigrationPoll(index, jobId, runId = state.migrationRunId) {
  let handle = null;
  handle = scheduleJsonPoll({
    delayMs: 900,
    run: async () => {
      if (handle) {
        state.migrationPollHandles.delete(handle);
      }
      try {
        const month = state.migrationMonths[index];
        const sinceRevision = Number.isFinite(month?.revision) ? month.revision : 0;
        const pollUrl = sinceRevision > 0
          ? `/api/search/${jobId}?sinceRevision=${encodeURIComponent(String(sinceRevision))}`
          : `/api/search/${jobId}`;
        const data = await getJson(pollUrl);
        if (!isCurrentMigrationRun(runId)) return;
        const m = state.migrationMonths[index];
        if (!m || m.jobId !== jobId) return;
        updateMigrationMonth(index, data, runId);
        renderMigrationResults();
        if (!data.searchComplete) {
          queueMigrationPoll(index, jobId, runId);
        }
      } catch {
        if (!isCurrentMigrationRun(runId)) return;
        const m = state.migrationMonths[index];
        if (m) { m.complete = true; m.error = "Error de conexión"; }
        renderMigrationResults();
      }
    },
  });
  state.migrationPollHandles.add(handle);
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
  beforeInitialRender: async () => {
    await loadResultsLayout({ rerender: false, showErrorToast: false });
    if (applyStartupLaunchPayload(startupSearchLaunchPayload)) {
      window.setTimeout(() => {
        void refreshStartupLaunchPayload(startupSearchLaunchPayload);
      }, 0);
    }
  },
  renderAll,
  settleInitialShellLayout,
  releaseInitialUiBootState,
});
