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
  compareResponse: null,
  selectedOfferId: null,
  compareIds: new Set(),
  quotationText: "",
  showAgilEmbed: false,
  agilLaunchStatus: "",
  selectedMatrixKey: null,
  airlineFilter: { hidden: new Set(), only: null },
  resultsPage: 1,
};

const autocompleteState = {
  origin: { items: [], activeIndex: -1, requestId: 0 },
  destination: { items: [], activeIndex: -1, requestId: 0 },
};

const RESULTS_PAGE_SIZE = 10;
const ALLOWED_DATE_YEAR = "2026";
const ALLOWED_DATE_MIN = `${ALLOWED_DATE_YEAR}-01-01`;
const ALLOWED_DATE_MAX = `${ALLOWED_DATE_YEAR}-12-31`;

const $ = (id) => document.getElementById(id);

const searchForm = $("searchForm");
const searchMode = $("searchMode");
const tripType = $("tripType");
const summaryContent = $("summaryContent");
const matrixSection = $("matrixSection");
const matrixInfo = $("matrixInfo");
const matrixContent = $("matrixContent");
const resultsSection = $("resultsSection");
const resultsContent = $("resultsContent");
const detailSection = $("detailSection");
const detailContent = $("detailContent");
const compareSection = $("compareSection");
const compareContent = $("compareContent");
const runtimeBadge = $("runtimeBadge");
const resultPill = $("resultPill");
const submitButton = $("submitButton");
const repriceButton = $("repriceButton");
const quotationButton = $("quotationButton");
const validationBox = $("validationErrors");
const loadingOverlay = $("loadingOverlay");
const toastContainer = $("toastContainer");
const resultsCountBadge = $("resultsCount");
const matrixCountBadge = $("matrixCount");

const numFmt = new Intl.NumberFormat("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ================================================================
   UI FEEDBACK — loading, toast, debounce
   ================================================================ */

function showLoading() { loadingOverlay?.classList.remove("hidden"); }
function hideLoading() { loadingOverlay?.classList.add("hidden"); }

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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function formatAgilDate(v) {
  if (!v) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { const [y, m, d] = v.split("-"); return `${d}/${m}/${y}`; }
  return v;
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
  autocompleteState[id].items = [];
  autocompleteState[id].activeIndex = -1;
}

function selectLocationSuggestion(id, suggestion) {
  const input = $(id);
  if (!input) return;
  input.value = suggestion.label;
  input.dataset.code = suggestion.code;
  input.dataset.label = suggestion.label;
  hideLocationMenu(id);
}

function renderLocationMenu(id) {
  const menu = locationMenu(id);
  const auto = autocompleteState[id];
  if (!menu) return;
  if (!auto.items.length) {
    hideLocationMenu(id);
    return;
  }

  menu.innerHTML = auto.items.map((item, index) => `
    <button type="button" class="location-item ${index === auto.activeIndex ? "is-active" : ""}" data-location-id="${id}" data-index="${index}">
      <span class="location-item-code">${escapeHtml(item.code)} · ${escapeHtml(item.city)}</span>
      <span class="location-item-meta">${escapeHtml(item.country)}</span>
    </button>
  `).join("");
  menu.classList.remove("hidden");

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

function toAgilClass(cabin) {
  const c = String(cabin || "").toUpperCase();
  if (c === "BUSINESS") return "1";
  if (c === "FIRST") return "2";
  return "0";
}

function buildAgilSmartUrlFromRequest(request, offer) {
  if (!request) return null;
  const leg = request.legs?.[0];
  if (!leg) return null;
  const tripType = offer?.tripType || request.tripType;
  const ow = tripType === "one-way";
  const outbound = offer?.itineraries?.find((it) => it.direction === "outbound") ?? offer?.itineraries?.[0];
  const inbound = offer?.itineraries?.find((it) => it.direction === "inbound");
  const dep = outbound?.segments?.[0]?.departureAt?.slice(0, 10) || leg.departureDate || leg.departureStart;
  const ret = inbound?.segments?.[0]?.departureAt?.slice(0, 10) || leg.returnDate || leg.returnStart;
  const url = new URL("https://www.agilsmart.com/home-user/flight-result");
  url.searchParams.set("flightType", ow ? "1" : "0");
  url.searchParams.set("departureLocation", offer?.origin || leg.origin || "");
  url.searchParams.set("arrivalLocation", offer?.destination || leg.destination || "");
  if (dep) url.searchParams.set("departureDate", formatAgilDate(dep));
  if (!ow && ret) url.searchParams.set("arrivalDate", formatAgilDate(ret));
  url.searchParams.set("adults", String(request.passengers?.adults ?? 1));
  url.searchParams.set("children", String(request.passengers?.children ?? 0));
  url.searchParams.set("infants", String(request.passengers?.infants ?? 0));
  url.searchParams.set("flightClass", toAgilClass(offer?.cabin ?? request.cabin));
  return url.toString();
}

function buildAgilSmartUrl(offer) {
  if (!offer || !state.request) return null;
  return buildAgilSmartUrlFromRequest(state.request, offer);
}

function buildMatrixCellAgilUrl(cell) {
  if (!cell?.derivedRequest) return null;
  return buildAgilSmartUrlFromRequest(cell.derivedRequest);
}

function offerDateRangeText(offer) {
  if (!offer?.itineraries?.length) return "—";
  const outbound = offer.itineraries.find((it) => it.direction === "outbound") ?? offer.itineraries[0];
  const inbound = offer.itineraries.find((it) => it.direction === "inbound");
  const departure = outbound?.segments?.[0]?.departureAt?.slice(0, 10);
  const ret = inbound?.segments?.[0]?.departureAt?.slice(0, 10);
  return ret ? `${departure} → ${ret}` : `${departure}`;
}

function outboundGroupKey(offer) {
  const out = offer.itineraries?.find(it => it.direction === "outbound") ?? offer.itineraries?.[0];
  const segments = (out?.segments ?? []).map(s => `${s.flightNumber}|${s.departureAt}`).join("~");
  return `${segments}::${offer.price?.total?.amount?.toFixed(2) ?? "0"}::${offer.price?.total?.currencyCode ?? ""}`;
}

function buildOfferGroups(offers) {
  const groups = new Map();
  for (const offer of offers) {
    const key = outboundGroupKey(offer);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(offer);
  }
  return [...groups.values()];
}

function getGroupForOffer(offerId) {
  const all = state.searchResponse?.filteredOffers ?? state.searchResponse?.allOffers ?? [];
  const target = all.find(o => o.id === offerId);
  if (!target) return null;
  const key = outboundGroupKey(target);
  return all.filter(o => outboundGroupKey(o) === key);
}

function countWindowCombinations() {
  const ds = $("departureStart").value;
  const de = $("departureEnd").value;
  if (!ds || !de) return 0;
  const departures = enumerateIsoRange(ds, de);
  if (tripType.value === "one-way") return departures.length;
  const rs = $("returnStart").value;
  const re = $("returnEnd").value;
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

function selMatrixCell() {
  if (!state.matrixResponse?.cells?.length || !state.selectedMatrixKey) return null;
  return state.matrixResponse.cells.find((c) => c.key === state.selectedMatrixKey) ?? null;
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

function enforceAlphaUpper(input, maxLen) {
  input.addEventListener("input", () => {
    input.value = input.value.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, maxLen);
  });
  input.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text");
    input.value = text.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, maxLen);
  });
}

function enforceIntRange(input, min, max) {
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

function enforceCarrierCodes(input) {
  input.addEventListener("input", () => {
    input.value = input.value.replace(/[^A-Za-z,]/g, "").toUpperCase();
  });
}

function setupInputEnforcement() {
  enforceAlphaUpper($("currencyCode"), 3);

  enforceIntRange($("adults"), 1, 9);
  enforceIntRange($("children"), 0, 8);
  enforceIntRange($("infants"), 0, 4);

  const dateIds = ["departureDate", "returnDate", "departureStart", "departureEnd", "returnStart", "returnEnd"];
  dateIds.forEach((id) => {
    const input = $(id);
    enforceDateYear(input);
    enforceDateNotPast(input);
  });

  $("maxPrice")?.addEventListener("blur", () => {
    const el = $("maxPrice");
    if (el.value === "") return;
    let v = parseInt(el.value, 10);
    if (isNaN(v) || v < 0) { el.value = ""; return; }
    if (v > 999999) v = 999999;
    el.value = String(v);
  });

  $("maxStops")?.addEventListener("blur", () => {
    const el = $("maxStops");
    if (el.value === "") return;
    let v = parseInt(el.value, 10);
    if (isNaN(v) || v < 0) { el.value = ""; return; }
    if (v > 3) v = 3;
    el.value = String(v);
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

  const curr = $("currencyCode").value;
  if (curr.length !== 3) { errs.push("Moneda: código de 3 letras."); $("currencyCode").classList.add("is-invalid"); }

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
    const v = $(id).value;
    if (!v) { errs.push(`${label} es obligatorio.`); $(id).classList.add("is-invalid"); return false; }
    if (!v.startsWith(`${ALLOWED_DATE_YEAR}-`)) {
      errs.push(`${label} debe estar dentro del año ${ALLOWED_DATE_YEAR}.`);
      $(id).classList.add("is-invalid");
      return false;
    }
    if (v < today) { errs.push(`${label} no puede ser pasada.`); $(id).classList.add("is-invalid"); return false; }
    if (v > ALLOWED_DATE_MAX) {
      errs.push(`${label} debe estar dentro del año ${ALLOWED_DATE_YEAR}.`);
      $(id).classList.add("is-invalid");
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

  if (mode === "roundtrip-grid" || mode === "stay-range") {
    checkDate("departureStart", "Salida inicio");
    checkDate("departureEnd", "Salida fin");
    if (trip === "round-trip") {
      checkDate("returnStart", "Regreso inicio");
      checkDate("returnEnd", "Regreso fin");
    }

    const ds = $("departureStart").value;
    const de = $("departureEnd").value;
    const rs = $("returnStart").value;
    const re = $("returnEnd").value;

    if (ds && de && de < ds) errs.push("Salida fin debe ser >= salida inicio.");
    if (trip === "round-trip") {
      if (rs && re && re < rs) errs.push("Regreso fin debe ser >= regreso inicio.");
      if (ds && rs && rs < ds) errs.push("Regreso debe empezar despues de la salida.");
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
  if (errors.length === 0) { validationBox.classList.add("hidden"); validationBox.innerHTML = ""; return; }
  validationBox.classList.remove("hidden");
  validationBox.innerHTML = `<ul>${errors.map((e) => `<li>${e}</li>`).join("")}</ul>`;
}

/* ================================================================
   FORM HELPERS
   ================================================================ */

function updateModeFields() {
  const usesRangeFields = searchMode.value === "roundtrip-grid" || searchMode.value === "stay-range";
  document.querySelectorAll(".grid-field").forEach((el) => el.classList.toggle("hidden", !usesRangeFields));
  document.querySelectorAll(".exact-field").forEach((el) => el.classList.toggle("hidden", usesRangeFields));
  document.querySelectorAll(".return-range-field").forEach((el) => {
    el.classList.toggle("hidden", !usesRangeFields || tripType.value !== "round-trip");
  });
  document.querySelectorAll(".roundtrip-only").forEach((el) => {
    el.classList.toggle("hidden", usesRangeFields || tripType.value !== "round-trip");
  });
  tripType.disabled = false;
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
      cabin: String(fd.get("cabin") || "ECONOMY"),
      currencyCode: $("currencyCode").value,
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
        maxResults: disableMaxResults ? undefined : 25,
        maxPrice: $("maxPrice").value ? Number($("maxPrice").value) : undefined,
        includedAirlineCodes: [],
        maxStops: $("maxStops").value ? Number($("maxStops").value) : undefined,
      },
      legs: [{
        origin: resolvedLocationCode("origin"),
        destination: resolvedLocationCode("destination"),
        departureDate: $("departureDate").value,
        returnDate: $("returnDate").value,
        departureStart: $("departureStart").value,
        departureEnd: $("departureEnd").value,
        returnStart: $("returnStart").value,
        returnEnd: $("returnEnd").value,
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

function getActiveClientFilters() {
  return {
    nonStop: controlChecked("nonStop"),
    baggageRequired: controlChecked("baggageRequired"),
    maxPrice: controlValue("maxPrice") ? Number(controlValue("maxPrice")) : undefined,
    maxStops: controlValue("maxStops") ? Number(controlValue("maxStops")) : undefined,
  };
}

function applyClientOfferControls() {
  if (!state.searchResponse?.allOffers) return;
  const filters = getActiveClientFilters();
  const sortMode = controlValue("sortMode") || state.sortMode || "cheapest";
  let offers = [...state.searchResponse.allOffers];

  const { hidden, only } = state.airlineFilter;
  offers = offers.filter((offer) => {
    const mainCarrier = offer.mainCarrier || offer.validatingCarrier || "";
    if (filters.nonStop && totalStopsCount(offer) > 0) return false;
    if (filters.baggageRequired && !offer.baggage?.checkedIncluded) return false;
    if (typeof filters.maxPrice === "number" && offer.price.total.amount > filters.maxPrice) return false;
    if (typeof filters.maxStops === "number" && totalStopsCount(offer) > filters.maxStops) return false;
    // Sidebar airline filter
    if (only !== null && mainCarrier !== only) return false;
    if (only === null && hidden.size > 0 && hidden.has(mainCarrier)) return false;
    return true;
  });

  if (sortMode === "fastest") {
    offers.sort((a, b) => totalDurationMinutes(a) - totalDurationMinutes(b));
  } else if (sortMode === "best-value") {
    offers.sort((a, b) => a.valueScore - b.valueScore);
  } else {
    offers.sort((a, b) => a.price.total.amount - b.price.total.amount);
  }

  state.searchResponse.filteredOffers = offers;
  const totalPages = resultsPageCount(offers.length);
  state.resultsPage = Math.min(Math.max(1, state.resultsPage), totalPages);
  const start = (state.resultsPage - 1) * RESULTS_PAGE_SIZE;
  state.searchResponse.offers = offers.slice(start, start + RESULTS_PAGE_SIZE);

  if (!state.searchResponse.offers.some((offer) => offer.id === state.selectedOfferId)) {
    state.selectedOfferId = state.searchResponse.offers[0]?.id ?? offers[0]?.id ?? null;
  }
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
      renderAll();
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
      renderAll();
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
  if (!active) { runtimeBadge.textContent = "IDLE"; resultPill.textContent = "0"; return; }
  const prov = active.providerMeta?.exactProvider ?? "—";
  const st = active.matrixStatus ?? active.searchMeta?.searchState ?? "—";
  runtimeBadge.textContent = `${prov} | ${st}`;
  runtimeBadge.className = "tag tag--green";
  resultPill.textContent = state.searchResponse
    ? `${state.searchResponse.offers.length}/${state.searchResponse.allOffers?.length ?? state.searchResponse.offers.length} ofertas`
    : `${state.matrixResponse?.cells?.length ?? 0} celdas`;
  resultPill.className = "tag tag--accent";
}

function renderSummary() {
  const active = state.searchResponse ?? state.matrixResponse;
  if (!active || !state.request) { summaryContent.innerHTML = ""; return; }
  const leg = state.request.legs[0];
  const prov = active.providerMeta ?? {};
  const warnings = active.warnings ?? [];
  const sc = selMatrixCell();

  let h = `
    <span class="tag tag--accent">${leg.origin} → ${leg.destination}</span>
    <span class="tag">${state.request.searchMode}</span>
    <span class="tag">${prov.exactProvider ?? "—"}</span>
    <span class="tag">${state.request.currencyCode}</span>
  `;
  if (sc) h += `<span class="tag tag--accent">${sc.returnDate ? `${sc.departureDate} → ${sc.returnDate}` : sc.departureDate}</span>`;
  warnings.forEach((w) => { h += `<span class="tag tag--amber">${w}</span>`; });
  summaryContent.innerHTML = h;
}

function renderResults() {
  const offers = state.searchResponse?.offers ?? [];
  const total = state.searchResponse?.filteredOffers?.length ?? state.searchResponse?.allOffers?.length ?? offers.length;
  const totalPages = resultsPageCount(total);
  const isRunning = state.searchResponse?.searchStatus === "running";

  // Update count badge
  if (resultsCountBadge) {
    resultsCountBadge.textContent = `${offers.length}/${total}`;
    resultsCountBadge.classList.toggle("hidden", offers.length === 0);
  }

  if (offers.length === 0) {
    resultsContent.innerHTML = isRunning
      ? '<div class="empty-msg">Consultando Agil. Los resultados se iran agregando a medida que lleguen.</div>'
      : '<div class="empty-msg">Sin ofertas.</div>';
    return;
  }

  resultsContent.innerHTML = `
    ${isRunning ? '<div class="results-loading">Consultando Agil. El listado sigue cargando y puede crecer.</div>' : ""}
    <div class="table-wrap"><table>
      <thead><tr>
        <th class="col-check">C</th>
        <th>Carrier</th>
        <th>Fechas</th>
        <th>Precio</th>
        <th>Fuente</th>
        <th>Duración</th>
        <th>Esc</th>
        <th>Equipaje</th>
        <th>Agil</th>
      </tr></thead>
      <tbody>
        ${buildOfferGroups(offers).map((group) => {
          const o = group.find(g => g.id === state.selectedOfferId) ?? group[0];
          const agilPath = o.purchasePaths.find((p) => p.provider === "agil-local" && p.url);
          const outbound = o.itineraries?.find((it) => it.direction === "outbound") ?? o.itineraries?.[0];
          const inbound = o.itineraries?.find((it) => it.direction === "inbound");
          const dep = formatDateCompact(outbound?.segments?.[0]?.departureAt?.slice(0, 10));
          const ret = inbound ? formatDateCompact(inbound.segments?.[0]?.departureAt?.slice(0, 10)) : null;
          const datesText = ret ? `${dep} → ${ret}` : dep;
          const isActive = group.some(g => g.id === state.selectedOfferId);
          const badge = group.length > 1 ? ` <span class="group-badge" title="${group.length} opciones de regreso">${group.length}</span>` : "";
          return `
            <tr data-oid="${o.id}" class="${isActive ? "is-active" : ""}">
              <td class="col-check"><input type="checkbox" data-cid="${o.id}" ${state.compareIds.has(o.id) ? "checked" : ""} /></td>
              <td><div class="cell-stack"><span class="cell-main">${o.mainCarrier ?? o.validatingCarrier ?? "—"}</span><span class="cell-sub">${o.origin}→${o.destination}</span></div></td>
              <td><span class="cell-sub">${datesText}${badge}</span></td>
              <td><div class="cell-stack"><span class="cell-main">${formatMoney(o.price.total)}</span><span class="cell-sub">score ${o.valueScore}</span></div></td>
              <td><span class="tag tag--${confidenceColor(o.priceConfidence)}">${o.priceConfidence === "validated" ? "Reprice" : "Live"}</span></td>
              <td>${formatDuration(o.comparisonMetrics.totalDurationMinutes)}</td>
              <td>${o.comparisonMetrics.totalStops}</td>
              <td class="cell-sub">${o.baggage?.description ?? "—"}</td>
              <td>${agilPath ? `<a href="${agilPath.url}" target="_blank" rel="noreferrer" class="row-link" data-stop-row="1" title="Abre la busqueda equivalente en Agil, no una tarifa exacta bloqueada">Buscar</a>` : '<span class="cell-sub">—</span>'}</td>
            </tr>`;
        }).join("")}
      </tbody>
    </table></div>
    <div class="results-pager">
      <button type="button" class="btn btn--sm" data-results-page="prev" ${state.resultsPage <= 1 ? "disabled" : ""}>Anterior</button>
      <span class="results-pager-label">Pagina ${state.resultsPage} de ${totalPages}</span>
      <button type="button" class="btn btn--sm" data-results-page="next" ${state.resultsPage >= totalPages ? "disabled" : ""}>Siguiente</button>
    </div>
  `;

  // Event delegation — single listener per container
  resultsContent.addEventListener("click", handleResultsClick);
}

function handleResultsClick(e) {
  const pager = e.target.closest("[data-results-page]");
  if (pager) {
    const total = state.searchResponse?.filteredOffers?.length ?? 0;
    const totalPages = resultsPageCount(total);
    if (pager.dataset.resultsPage === "prev") {
      state.resultsPage = Math.max(1, state.resultsPage - 1);
    } else if (pager.dataset.resultsPage === "next") {
      state.resultsPage = Math.min(totalPages, state.resultsPage + 1);
    }
    applyClientOfferControls();
    renderResults();
    renderDetail();
    return;
  }

  if (e.target instanceof HTMLInputElement) {
    // Checkbox change — handled via change delegation below
    return;
  }
  if (e.target.closest("[data-stop-row]")) return;
  const row = e.target.closest("tr[data-oid]");
  if (!row) return;
  state.selectedOfferId = row.dataset.oid;
  state.showAgilEmbed = false;
  state.agilLaunchStatus = "";
  renderResults();
  renderDetail();
}

resultsContent.addEventListener("change", async (e) => {
  const inp = e.target.closest("[data-cid]");
  if (!inp) return;
  const id = inp.dataset.cid;
  if (inp.checked) {
    if (state.compareIds.size >= 2) { inp.checked = false; return; }
    state.compareIds.add(id);
  } else {
    state.compareIds.delete(id);
  }
  await refreshCompare();
});

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

async function refreshCompare() {
  const sid = sessionId();
  if (!sid || state.compareIds.size === 0) {
    state.compareResponse = null;
    renderCompare();
    return;
  }
  try {
    state.compareResponse = await postJson("/api/compare", { searchSessionId: sid, offerIds: [...state.compareIds] });
  } catch (err) { showToast(err.message); state.compareResponse = null; }
  renderCompare();
}

function renderCompare() {
  if (!state.compareResponse) {
    compareSection.classList.add("hidden");
    return;
  }
  compareSection.classList.remove("hidden");
  const hdr = state.compareResponse.offers.map((o) => `<th>${o.mainCarrier ?? "—"}</th>`).join("");
  const rows = state.compareResponse.rows.map((r) => `<tr><th>${r.label}</th>${r.values.map((v) => `<td>${v}</td>`).join("")}</tr>`).join("");
  compareContent.innerHTML = `<div class="compare-wrap"><div class="table-wrap"><table><thead><tr><th>Campo</th>${hdr}</tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

/* ================================================================
   SIDEBAR — airline filter
   ================================================================ */

function buildAirlineList(allOffers) {
  const map = new Map();
  for (const offer of allOffers) {
    const code = offer.mainCarrier ?? offer.validatingCarrier ?? "?";
    if (!map.has(code)) map.set(code, { code, count: 0, minPrice: Infinity, currency: "" });
    const entry = map.get(code);
    entry.count++;
    const amt = offer.price?.total?.amount;
    if (typeof amt === "number" && amt < entry.minPrice) {
      entry.minPrice = amt;
      entry.currency = offer.price?.total?.currencyCode ?? "";
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function renderSidebar() {
  const sidebar = $("sidebar");
  if (!sidebar) return;

  const allOffers = state.searchResponse?.allOffers;
  if (!allOffers?.length) { sidebar.classList.add("hidden"); return; }

  const airlines = buildAirlineList(allOffers);
  if (airlines.length <= 1) { sidebar.classList.add("hidden"); return; }

  sidebar.classList.remove("hidden");

  const { hidden, only } = state.airlineFilter;
  const hasFilters = hidden.size > 0 || only !== null;

  sidebar.innerHTML = `
    <div class="sl-head">
      <span class="sl-title">Aerolíneas</span>
      ${hasFilters ? '<button class="sl-reset" id="slReset">Todas</button>' : ""}
    </div>
    <div class="sl-list">
      ${airlines.map((a) => {
        const isOnly = only === a.code;
        const isHidden = !isOnly && (only !== null || hidden.has(a.code));
        const rowClass = isOnly ? "sl-row--only" : isHidden ? "sl-row--hidden" : "";
        const priceStr = a.minPrice < Infinity
          ? `${a.currency} ${numFmt.format(a.minPrice)}`
          : "";
        return `
          <div class="sl-row ${rowClass}" data-sl-toggle="${a.code}">
            <span class="sl-dot"></span>
            <div class="sl-info">
              <span class="sl-code">${a.code}</span>
              <span class="sl-meta">×${a.count}${priceStr ? ` · ${priceStr}` : ""}</span>
            </div>
            <button class="sl-solo ${isOnly ? "sl-solo--active" : ""}" data-sl-solo="${a.code}" type="button">Solo</button>
          </div>`;
      }).join("")}
    </div>
  `;

  sidebar.querySelector("#slReset")?.addEventListener("click", () => {
    state.airlineFilter.hidden.clear();
    state.airlineFilter.only = null;
    applyClientOfferControls();
    renderAll();
  });

  sidebar.querySelectorAll("[data-sl-toggle]").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("[data-sl-solo]")) return;
      const code = row.dataset.slToggle;
      if (state.airlineFilter.only === code) {
        state.airlineFilter.only = null;
      } else if (state.airlineFilter.only !== null) {
        // Exit solo mode and hide this one instead
        state.airlineFilter.only = null;
        state.airlineFilter.hidden.add(code);
      } else {
        if (state.airlineFilter.hidden.has(code)) {
          state.airlineFilter.hidden.delete(code);
        } else {
          state.airlineFilter.hidden.add(code);
        }
      }
      applyClientOfferControls();
      renderAll();
    });
  });

  sidebar.querySelectorAll("[data-sl-solo]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const code = btn.dataset.slSolo;
      if (state.airlineFilter.only === code) {
        state.airlineFilter.only = null;
      } else {
        state.airlineFilter.only = code;
        state.airlineFilter.hidden.clear();
      }
      applyClientOfferControls();
      renderAll();
    });
  });
}

function renderMatrix() {
  const cells = state.matrixResponse?.cells;
  if (!cells || cells.length === 0) {
    matrixSection.classList.add("hidden");
    if (matrixCountBadge) matrixCountBadge.classList.add("hidden");
    return;
  }
  matrixSection.classList.remove("hidden");
  if (matrixCountBadge) {
    matrixCountBadge.textContent = cells.length;
    matrixCountBadge.classList.remove("hidden");
  }

  const returns = state.matrixResponse.axes.returnDates;
  const departures = state.matrixResponse.axes.departureDates;
  const sc = selMatrixCell();
  const isOneWay = state.request?.tripType === "one-way";
  const priceStats = getMatrixPriceStats(cells);
  const selectedCellAgilUrl = buildMatrixCellAgilUrl(sc);

  let info = `<span class="tag tag--accent">${isOneWay ? "Solo ida" : "Filas=ida Cols=vuelta"}</span>`;
  if (sc) info += `<span class="tag tag--accent">${sc.returnDate ? `${sc.departureDate} → ${sc.returnDate}` : sc.departureDate}</span>`;
  else info += `<span class="tag">Elige celda para búsqueda exacta</span>`;
  if (priceStats) {
    info += '<span class="tag">Rojo = caro</span><span class="tag">Verde = mejor tramo</span><span class="tag tag--accent">Celeste = mejor precio</span>';
  }
  if (selectedCellAgilUrl) {
    info += `<a href="${selectedCellAgilUrl}" target="_blank" rel="noreferrer" class="btn btn--go btn--sm">Abrir Agil</a>`;
    if (isLocal()) {
      info += '<button id="matrixAgilLocalOpen" class="btn btn--sm" type="button">Chrome local</button>';
    }
  }
  Object.entries(state.matrixResponse.confidenceSummary).forEach(([k, v]) => { info += `<span class="tag">${k}: ${v}</span>`; });
  matrixInfo.innerHTML = info;

  const rows = [];
  if (isOneWay) {
    rows.push(`<div class="matrix-row" style="--cols:${departures.length}"><div class="matrix-corner">IDA</div>${departures.map((d) => `<div class="matrix-header">${d.slice(5)}</div>`).join("")}</div>`);
    rows.push(`<div class="matrix-row" style="--cols:${departures.length}"><div class="matrix-label">Precio</div>${departures.map((dep) => {
      const cell = cells.find((c) => c.departureDate === dep);
      if (!cell) return '<button class="matrix-cell" disabled type="button">—</button>';
      const isLoading = cell.confidence === "loading";
      const toneClass = matrixToneClass(cell, priceStats);
      return `<button class="matrix-cell ${cell.key === state.selectedMatrixKey ? "is-active" : ""} ${isLoading ? "is-loading" : ""} ${toneClass}" type="button" ${!cell.selectable && !isLoading ? "disabled" : ""} data-mk="${cell.key}" title="${cell.tooltip ?? ""}">`
        + `<div class="matrix-price ${isLoading ? "matrix-price--loading" : ""}">${isLoading ? "..." : cell.price ? formatMoney(cell.price) : "—"}</div>`
        + `<div class="matrix-meta">${isLoading ? "cargando" : cell.stateCode}</div></button>`;
    }).join("")}</div>`);
  } else {
    rows.push(`<div class="matrix-row" style="--cols:${returns.length}"><div class="matrix-corner">S\\R</div>${returns.map((d) => `<div class="matrix-header">${d.slice(5)}</div>`).join("")}</div>`);

    for (const dep of departures) {
      rows.push(`<div class="matrix-row" style="--cols:${returns.length}"><div class="matrix-label">${dep.slice(5)}</div>${returns.map((ret) => {
        const cell = cells.find((c) => c.departureDate === dep && c.returnDate === ret);
        if (!cell) return '<button class="matrix-cell" disabled type="button">—</button>';
        const isLoading = cell.confidence === "loading";
        const toneClass = matrixToneClass(cell, priceStats);
        return `<button class="matrix-cell ${cell.key === state.selectedMatrixKey ? "is-active" : ""} ${isLoading ? "is-loading" : ""} ${toneClass}" type="button" ${!cell.selectable && !isLoading ? "disabled" : ""} data-mk="${cell.key}" title="${cell.tooltip ?? ""}">`
          + `<div class="matrix-price ${isLoading ? "matrix-price--loading" : ""}">${isLoading ? "..." : cell.price ? formatMoney(cell.price) : "—"}</div>`
          + `<div class="matrix-meta">${isLoading ? "cargando" : cell.stateCode} ${cell.stayNights ?? ""}n</div></button>`;
      }).join("")}</div>`);
    }
  }

  matrixContent.innerHTML = `<div class="matrix-wrap"><div class="matrix-grid">${rows.join("")}</div></div>`;

  // Single delegated listener (re-assigned on each render — old one is discarded with innerHTML)
  matrixContent.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-mk]");
    if (!btn) {
      // Handle matrixAgilLocalOpen
      if (e.target.id === "matrixAgilLocalOpen" && selectedCellAgilUrl) {
        try {
          await postJson("/api/local/open-url", { url: selectedCellAgilUrl, preferredBrowser: "chrome" });
        } catch (err) { showToast(err.message); }
      }
      return;
    }
    const cell = cells.find((c) => c.key === btn.dataset.mk);
    if (!cell?.selectable || !cell.derivedRequest) return;
    submitButton.disabled = true;
    showLoading();
    state.selectedMatrixKey = btn.dataset.mk;
    try {
      const data = await postJson("/api/search", { request: cell.derivedRequest, sortMode: state.sortMode });
      state.request = data.request;
      setSearchResponse(data);
      state.compareIds.clear();
      state.compareResponse = null;
      state.quotationText = "";
      renderAll();
    } catch (err) { showToast(err.message); }
    finally { submitButton.disabled = false; hideLoading(); }
  });
}

function renderDetail() {
  const offer = selOffer();
  repriceButton.disabled = !offer;
  quotationButton.disabled = !offer;

  if (!offer) { detailSection.classList.add("hidden"); return; }
  detailSection.classList.remove("hidden");

  const flights = offer.itineraries.flatMap((it) => it.segments.map((s) => s.flightNumber)).join(", ");

  let h = "";

  // Detail grid
  h += `<div class="detail-grid">
    <div class="detail-pair"><span class="detail-key">Ruta</span><span class="detail-val">${offer.origin} → ${offer.destination}</span></div>
    <div class="detail-pair"><span class="detail-key">Carrier</span><span class="detail-val">${offer.mainCarrier ?? offer.validatingCarrier ?? "—"}</span></div>
    <div class="detail-pair"><span class="detail-key">Vuelos</span><span class="detail-val">${flights || "—"}</span></div>
    <div class="detail-pair"><span class="detail-key">Fuente</span><span class="tag tag--${confidenceColor(offer.priceConfidence)}">${offer.priceConfidence === "validated" ? "Reprice Agil" : "Agil live"}</span></div>
    <div class="detail-pair detail-pair--full"><span class="detail-key">Precio</span><span class="detail-val detail-val--hero">${formatMoney(offer.price.total)}</span></div>
    <div class="detail-pair"><span class="detail-key">Actualizado</span><span class="detail-val">${offer.priceVerifiedAt ? formatDT(offer.priceVerifiedAt) : "Live"}</span></div>
    <div class="detail-pair"><span class="detail-key">Duración</span><span class="detail-val">${formatDuration(offer.comparisonMetrics.totalDurationMinutes)} · ${offer.comparisonMetrics.totalStops} esc</span></div>
  </div>`;

  // Segments
  const group = getGroupForOffer(offer.id) ?? [offer];
  const outboundItinerary = offer.itineraries.find(it => it.direction === "outbound") ?? offer.itineraries[0];
  h += `<div class="segments-grid">`;
  h += `<div class="segment-block"><div class="segment-dir">outbound — ${formatDuration(outboundItinerary.durationMinutes)}, ${outboundItinerary.stops} esc</div>`;
  outboundItinerary.segments.forEach((s) => {
    h += `<div class="segment-leg"><div class="segment-flight">${s.flightNumber}</div><div class="segment-times">${s.origin} ${formatDT(s.departureAt)} → ${s.destination} ${formatDT(s.arrivalAt)}</div></div>`;
  });
  h += `</div>`;

  if (group.length > 1) {
    // Show inbound options as selectable cards
    h += `<div class="segment-block inbound-options"><div class="segment-dir">inbound — ${group.length} opciones</div>`;
    group.forEach((member) => {
      const ib = member.itineraries.find(it => it.direction === "inbound");
      if (!ib) return;
      const isSelected = member.id === state.selectedOfferId;
      const label = ib.segments.map(s => `${s.flightNumber} ${s.origin} ${formatDT(s.departureAt)} → ${s.destination} ${formatDT(s.arrivalAt)}`).join(" / ");
      h += `<div class="segment-leg inbound-option ${isSelected ? "inbound-option--active" : ""}" data-inbound-id="${member.id}" style="cursor:pointer">${label}</div>`;
    });
    h += `</div>`;
  } else {
    offer.itineraries.filter(it => it !== outboundItinerary).forEach((it) => {
      h += `<div class="segment-block"><div class="segment-dir">${it.direction} — ${formatDuration(it.durationMinutes)}, ${it.stops} esc</div>`;
      it.segments.forEach((s) => {
        h += `<div class="segment-leg"><div class="segment-flight">${s.flightNumber}</div><div class="segment-times">${s.origin} ${formatDT(s.departureAt)} → ${s.destination} ${formatDT(s.arrivalAt)}</div></div>`;
      });
      h += `</div>`;
    });
  }
  h += `</div>`;

  // Paths
  const paths = offer.purchasePaths.filter((p) => p.provider !== "agil-local" && p.provider !== "manual-link");
  if (paths.length > 0) {
    h += `<div class="paths-list">`;
    paths.forEach((p) => {
      h += `<div class="path-row"><div><span class="path-label">${p.label}</span> <span class="path-sub">${p.type} · ${p.precision}</span></div>`;
      if (p.url) h += `<a href="${p.url}" target="${p.requiresNewTab ? "_blank" : "_self"}" rel="noreferrer">Abrir</a>`;
      h += `</div>`;
    });
    h += `</div>`;
  }

  // Manual ref
  const manual = offer.purchasePaths.find((p) => p.type === "manual-reference");
  if (manual?.referenceText) {
    h += `<div class="quote-area"><textarea readonly>${manual.referenceText}</textarea></div>`;
  }

  // Quotation
  if (state.quotationText) {
    h += `<div class="quote-area"><textarea readonly>${state.quotationText}</textarea></div>`;
  }

  detailContent.innerHTML = h;

  // Inbound option selection
  detailContent.querySelectorAll("[data-inbound-id]").forEach((el) => {
    el.addEventListener("click", () => {
      state.selectedOfferId = el.dataset.inboundId;
      renderResults();
      renderDetail();
    });
  });
}

function renderAll() {
  renderToolbar();
  renderSummary();
  renderSidebar();
  renderResults();
  renderCompare();
  renderMatrix();
  renderDetail();
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

// Collapsible sections
document.querySelectorAll(".section-head[data-target]").forEach((head) => {
  head.addEventListener("click", (e) => {
    if (e.target.closest(".section-actions")) return;
    const section = document.getElementById(head.dataset.target);
    if (section) section.classList.toggle("section--collapsed");
  });
});

searchMode.addEventListener("change", updateModeFields);
tripType.addEventListener("change", updateModeFields);

const debouncedFilterRefresh = debounce(async () => {
  if (!state.searchResponse?.allOffers) return;
  state.sortMode = controlValue("sortMode") || state.sortMode;
  state.resultsPage = 1;
  applyClientOfferControls();
  renderAll();
  if (state.compareIds.size > 0) await refreshCompare();
}, 300);

["sortMode", "nonStop", "baggageRequired", "maxPrice", "maxStops"].forEach((id) => {
  control(id)?.addEventListener("change", async () => {
    if (!state.searchResponse?.allOffers) return;
    state.sortMode = controlValue("sortMode") || state.sortMode;
    state.resultsPage = 1;
    applyClientOfferControls();
    renderAll();
    if (state.compareIds.size > 0) await refreshCompare();
  });
  // Debounce number inputs to avoid re-rendering on every keystroke
  if (["maxPrice", "maxStops"].includes(id)) {
    control(id)?.addEventListener("input", debouncedFilterRefresh);
  }
});

searchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const errs = validateForm();
  showErrors(errs);
  if (errs.length > 0) return;

  submitButton.disabled = true;
  showLoading();
  try {
    const payload = getFormPayload();
    stopMatrixPolling();
    stopSearchPolling();
    state.sortMode = payload.sortMode;
    state.resultsPage = 1;
    state.compareIds.clear();
    state.compareResponse = null;
    state.quotationText = "";
    state.showAgilEmbed = false;
    state.agilLaunchStatus = "";
    state.selectedMatrixKey = null;
    state.airlineFilter.hidden.clear();
    state.airlineFilter.only = null;

    if (payload.request.searchMode === "roundtrip-grid") {
      stopSearchPolling();
      state.searchResponse = null;
      state.selectedOfferId = null;
      state.request = payload.request;
      state.matrixResponse = buildPendingMatrixResponse(payload.request);
      renderAll();

      const matrixJob = await postJson("/api/matrix", payload);
      state.matrixResponse = matrixJob;
      state.request = matrixJob.request;
      state.searchResponse = null;
      state.matrixJobId = matrixJob.matrixJobId ?? null;
      if (!matrixJob.matrixComplete && state.matrixJobId) {
        queueMatrixPoll(state.matrixJobId);
      }
    } else {
      state.matrixResponse = null;
      state.request = payload.request;
      setSearchResponse(buildPendingSearchResponse(payload.request, payload.sortMode));
      renderAll();

      const data = await postJson("/api/search", payload);
      state.request = data.request;
      setSearchResponse(data);
      state.searchJobId = data.searchJobId ?? null;
      if (!data.searchComplete && state.searchJobId) {
        queueSearchPoll(state.searchJobId);
      }
    }
    renderAll();
  } catch (err) { showToast(err.message); }
  finally { submitButton.disabled = false; hideLoading(); }
});

repriceButton.addEventListener("click", async () => {
  const offer = selOffer();
  const sid = sessionId();
  if (!offer || !sid) return;
  repriceButton.disabled = true;
  showLoading();
  try {
    const data = await postJson("/api/reprice", { searchSessionId: sid, offerId: offer.id });
    state.searchResponse.allOffers = state.searchResponse.allOffers.map((o) => o.id === data.offer.id ? data.offer : o);
    applyClientOfferControls();
    state.quotationText = "";
    renderAll();
    if (state.compareIds.size > 0) await refreshCompare();
  } catch (err) { showToast(err.message); }
  finally { repriceButton.disabled = false; hideLoading(); }
});

quotationButton.addEventListener("click", async () => {
  const offer = selOffer();
  const sid = sessionId();
  if (!offer || !sid) return;
  quotationButton.disabled = true;
  showLoading();
  try {
    const data = await postJson("/api/quotation", { searchSessionId: sid, offerId: offer.id });
    state.searchResponse.allOffers = state.searchResponse.allOffers.map((o) => o.id === data.offer.id ? data.offer : o);
    applyClientOfferControls();
    state.quotationText = data.plainText;
    renderAll();
    if (state.compareIds.size > 0) await refreshCompare();
  } catch (err) { showToast(err.message); }
  finally { quotationButton.disabled = false; hideLoading(); }
});

/* ================================================================
   INIT
   ================================================================ */

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
resetSearchFormDefaults();
updateModeFields();
renderAll();
