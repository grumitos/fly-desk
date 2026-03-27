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
  selectedMatrixKey: null,
  airlineFilter: { hidden: new Set(), only: null },
  resultsPage: 1,
  viewMode: "list",
  flexMode: false,
  detailPendingAction: null,
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

const $ = (id) => document.getElementById(id);

const rootEl = document.documentElement;
const searchForm = $("searchForm");
const workspace = document.querySelector(".workspace");
const searchMode = $("searchMode");
const tripType = $("tripType");
const detailPanel = $("detailPanel");
const detailClose = $("detailClose");
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
const sortButtonsEl = $("sortButtons");
const compareBtnEl = $("compareBtn");
const compareBtnCount = $("compareBtnCount");
const compareClearBtn = $("compareClear");
const viewToggle = $("viewToggle");
const resultsCountLabel = $("resultsCountLabel");
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

function renderResultsSkeleton(kind = "search") {
  if (!resultsContainer) return;
  const copy = kind === "matrix-selection"
    ? {
        eyebrow: "Cargando lista exacta",
        text: "Resolviendo la combinación elegida para traer las ofertas.",
      }
    : {
        eyebrow: "Consultando vuelos",
        text: "Las ofertas aparecerán aquí a medida que Agil vaya respondiendo.",
      };
  const rows = Array.from({ length: 6 }, (_, index) => `
    <div class="results-skeleton__row" aria-hidden="true">
      <span class="skeleton-block skeleton-block--check"></span>
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
      <div class="results-skeleton__header">
        <p class="results-skeleton__eyebrow">${copy.eyebrow}</p>
        <p class="results-skeleton__text">${copy.text}</p>
      </div>
      <div class="results-skeleton__table">
        <div class="results-skeleton__head" aria-hidden="true">
          <span>Sel</span>
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
  });
}

function setTheme(theme) {
  const nextTheme = theme === "dark" ? "dark" : "light";
  rootEl.dataset.theme = nextTheme;
  syncThemeButtons(nextTheme);
  try {
    window.localStorage.setItem("flydesk-theme", nextTheme);
  } catch {
    // Ignore private mode/localStorage restrictions.
  }
}

function initialTheme() {
  try {
    const saved = window.localStorage.getItem("flydesk-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // Ignore localStorage access issues.
  }
  return "light";
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

function syncLocationMenuPosition(id) {
  const input = $(id);
  const menu = locationMenu(id);
  if (!input || !menu || menu.classList.contains("hidden")) return;

  const segment = input.closest(".rail-segment");
  const width = segment?.getBoundingClientRect().width ?? input.getBoundingClientRect().width;
  menu.style.top = "";
  menu.style.left = "";
  menu.style.width = `${Math.max(width, 320)}px`;
}

function syncVisibleLocationMenus() {
  syncLocationMenuPosition("origin");
  syncLocationMenuPosition("destination");
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

  const viewportPadding = 16;
  const triggerRect = dateTrigger.getBoundingClientRect();
  const width = Math.min(960, window.innerWidth - viewportPadding * 2);

  calendarPopover.style.width = `${width}px`;
  calendarPopover.style.maxHeight = `${Math.min(window.innerHeight - viewportPadding * 2, 672)}px`;

  const popoverRect = calendarPopover.getBoundingClientRect();
  let left = triggerRect.left + (triggerRect.width / 2) - (width / 2);
  left = Math.max(viewportPadding, Math.min(left, window.innerWidth - width - viewportPadding));

  let top = triggerRect.bottom + 10;
  if (top + popoverRect.height > window.innerHeight - viewportPadding) {
    top = Math.max(viewportPadding, window.innerHeight - popoverRect.height - viewportPadding);
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
    paxPopover.classList.toggle("hidden");
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
  });
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
  setTheme(initialTheme());
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
  if (errors.length === 0) { validationBox.classList.add("hidden"); validationBox.innerHTML = ""; return; }
  validationBox.classList.remove("hidden");
  if (errors.some((error) => /fecha|ventana|salida|regreso|matriz|rango/i.test(error))) {
    dateTrigger?.classList.add("is-invalid");
  }
  validationBox.innerHTML = `<ul>${errors.map((e) => `<li>${e}</li>`).join("")}</ul>`;
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

function getActiveClientFilters() {
  return {
    nonStop: controlChecked("nonStop"),
    baggageRequired: controlChecked("baggageRequired"),
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
  const hasResults = (state.searchResponse?.allOffers?.length > 0) || (state.matrixResponse?.cells?.length > 0);
  if (resultsToolbar) resultsToolbar.classList.toggle("hidden", !hasResults);
  if (emptyState) emptyState.classList.toggle("hidden", hasResults);

  // Update count
  const total = state.searchResponse?.filteredOfferGroups?.length ?? 0;
  const page = buildOfferGroups(state.searchResponse?.offers ?? []).length;
  if (resultsCountLabel) {
    resultsCountLabel.innerHTML = total > 0 ? `<strong>${page}</strong> visibles de ${total}` : "";
  }

  // Update sort active state
  if (sortButtonsEl) {
    sortButtonsEl.querySelectorAll("[data-sort]").forEach(btn => {
      btn.classList.toggle("is-active", btn.dataset.sort === (state.sortMode || "cheapest"));
    });
  }

  // Show view toggle only when matrix data exists (flexible mode results)
  if (viewToggle) {
    viewToggle.style.display = state.matrixResponse?.cells?.length > 0 ? "" : "none";
    viewToggle.querySelectorAll("[data-view]").forEach(btn => {
      btn.classList.toggle("is-active", btn.dataset.view === state.viewMode);
    });
  }

  // Compare button
  if (compareBtnEl) {
    compareBtnEl.classList.toggle("hidden", state.compareIds.size === 0);
    if (compareBtnCount) compareBtnCount.textContent = state.compareIds.size;
  }
}

function renderResults() {
  if (!resultsContainer) return;
  const offers = state.searchResponse?.offers ?? [];
  const total = state.searchResponse?.filteredOfferGroups?.length
    ?? buildOfferGroups(state.searchResponse?.filteredOffers ?? state.searchResponse?.allOffers ?? offers).length;
  const totalPages = resultsPageCount(total);
  const isRunning = state.searchResponse?.searchStatus === "running";

  if (offers.length === 0 && !isRunning) {
    resultsContainer.innerHTML = '<div class="empty-state"><div class="empty-state__icon"><svg class="ico" style="width:40px;height:40px;opacity:0.3"><use href="#ico-plane"/></svg></div><p class="empty-state__eyebrow">Sin resultados</p><p class="empty-state__text">No aparecieron ofertas con los filtros actuales.</p></div>';
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
  html += '<th class="col-check">Sel</th>';
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
    const outbound = o.itineraries?.find((it) => it.direction === "outbound") ?? o.itineraries?.[0];
    const inbound = o.itineraries?.find((it) => it.direction === "inbound");
    const dep = formatDateCompact(outbound?.segments?.[0]?.departureAt?.slice(0, 10));
    const ret = inbound ? formatDateCompact(inbound.segments?.[0]?.departureAt?.slice(0, 10)) : null;
    const datesText = ret ? `${dep} → ${ret}` : dep;
    const isActive = group.some(g => g.id === state.selectedOfferId);
    const badge = group.length > 1 ? ` <span class="badge badge--accent" style="font-size:10px;height:18px;padding:0 5px" title="${group.length} opciones de regreso">${group.length}</span>` : "";
    const stops = o.comparisonMetrics?.totalStops ?? 0;
    const stopsClass = stops === 0 ? "badge--success" : stops === 1 ? "badge--warning" : "badge--danger";
    const stopsLabel = stops === 0 ? "Directo" : `${stops} esc`;
    const bagCarry = o.baggage?.carryOnIncluded ? "✓" : "—";
    const bagCheck = o.baggage?.checkedIncluded ? "✓" : "—";

    html += `<tr data-oid="${o.id}" class="${isActive ? "is-active" : ""}">`;
    html += `<td class="col-check"><input type="checkbox" data-cid="${o.id}" ${state.compareIds.has(o.id) ? "checked" : ""} /></td>`;
    html += `<td><span class="cell-main">${escapeHtml(o.mainCarrier ?? o.validatingCarrier ?? "—")}</span></td>`;
    html += `<td><span class="cell-sub">${datesText}${badge}</span></td>`;
    html += `<td>${formatDuration(o.comparisonMetrics?.totalDurationMinutes)}</td>`;
    html += `<td><span class="badge ${stopsClass}">${stopsLabel}</span></td>`;
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
}

function handleResultsClick(e) {
  const pager = e.target.closest("[data-results-page]");
  if (pager) {
    const total = state.searchResponse?.filteredOfferGroups?.length ?? 0;
    const totalPages = resultsPageCount(total);
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

  if (e.target instanceof HTMLInputElement) {
    // Checkbox change — handled via change delegation below
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
  try {
    stopMatrixPolling();
    stopSearchPolling();
    state.request = cell.derivedRequest;
    state.matrixResponse = null;
    state.viewMode = "list";
    state.compareIds.clear();
    state.compareResponse = null;
    state.quotationText = "";
    state.airlineFilter.hidden.clear();
    state.airlineFilter.only = null;
    state.detailPendingAction = null;
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
  const compSection = $("compareSection");
  if (!state.compareResponse) {
    if (compSection) compSection.classList.add("hidden");
    return;
  }
  if (compSection) compSection.classList.remove("hidden");
  const compareContentEl = $("compareContent");
  if (!compareContentEl) return;
  const hdr = state.compareResponse.offers.map(o => `<th>${escapeHtml(o.mainCarrier ?? "—")}</th>`).join("");
  const rows = state.compareResponse.rows.map(r => `<tr><th>${escapeHtml(r.label)}</th>${r.values.map(v => `<td>${escapeHtml(String(v))}</td>`).join("")}</tr>`).join("");
  compareContentEl.innerHTML = `<div class="table-wrap"><table class="results-table"><thead><tr><th>Campo</th>${hdr}</tr></thead><tbody>${rows}</tbody></table></div>`;
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
  const sidebarEl = $("sidebar");
  if (!sidebarEl) return;
  const allOffers = state.searchResponse?.allOffers;
  if (!allOffers?.length) {
    sidebarEl.classList.remove("is-visible");
    workspace?.classList.remove("workspace--with-sidebar");
    return;
  }
  const airlines = buildAirlineList(allOffers);
  if (airlines.length <= 1) {
    sidebarEl.classList.remove("is-visible");
    workspace?.classList.remove("workspace--with-sidebar");
    return;
  }
  sidebarEl.classList.add("is-visible");
  workspace?.classList.add("workspace--with-sidebar");
  const { hidden, only } = state.airlineFilter;
  const hasFilters = hidden.size > 0 || only !== null;

  sidebarEl.innerHTML = `
    <div class="sidebar__section">
      <div class="sidebar__title">
        <span>Aerolíneas</span>
        ${hasFilters ? '<button class="sidebar__reset" id="slReset">Todas</button>' : ""}
      </div>
      ${airlines.map(a => {
        const isOnly = only === a.code;
        const isHidden = !isOnly && (only !== null || hidden.has(a.code));
        const rowClass = isOnly ? "is-solo" : isHidden ? "is-hidden" : "";
        const priceStr = a.minPrice < Infinity ? `${a.currency} ${numFmt.format(a.minPrice)}` : "";
        return `
          <div class="sidebar__airline ${rowClass}" data-sl-toggle="${a.code}">
            <span class="sidebar__dot"></span>
            <div style="flex:1;min-width:0">
              <div class="sidebar__code">${escapeHtml(a.code)}</div>
              <div class="sidebar__meta">×${a.count}${priceStr ? ` · ${priceStr}` : ""}</div>
            </div>
            <button class="sidebar__solo-btn" data-sl-solo="${a.code}" type="button">Solo</button>
          </div>`;
      }).join("")}
    </div>`;

  // Event handlers (same logic as before)
  sidebarEl.querySelector("#slReset")?.addEventListener("click", () => {
    state.airlineFilter.hidden.clear();
    state.airlineFilter.only = null;
    applyClientOfferControls();
    renderAll();
  });
  sidebarEl.querySelectorAll("[data-sl-toggle]").forEach(row => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("[data-sl-solo]")) return;
      const code = row.dataset.slToggle;
      if (state.airlineFilter.only === code) {
        state.airlineFilter.only = null;
      } else if (state.airlineFilter.only !== null) {
        state.airlineFilter.only = null;
        state.airlineFilter.hidden.add(code);
      } else {
        if (state.airlineFilter.hidden.has(code)) state.airlineFilter.hidden.delete(code);
        else state.airlineFilter.hidden.add(code);
      }
      applyClientOfferControls();
      renderAll();
    });
  });
  sidebarEl.querySelectorAll("[data-sl-solo]").forEach(btn => {
    btn.addEventListener("click", () => {
      const code = btn.dataset.slSolo;
      if (state.airlineFilter.only === code) state.airlineFilter.only = null;
      else { state.airlineFilter.only = code; state.airlineFilter.hidden.clear(); }
      applyClientOfferControls();
      renderAll();
    });
  });
}

/* ================================================================
   CALENDAR VIEW (was renderMatrix)
   ================================================================ */

function renderCalendarView() {
  if (!resultsContainer) return;
  const cells = state.matrixResponse?.cells;
  if (!cells || cells.length === 0) {
    resultsContainer.innerHTML = '<div class="empty-state"><p class="empty-state__text">Sin datos de calendario.</p></div>';
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
  resultsContainer.innerHTML = html;

  // Re-attach matrix click handler on the container
  resultsContainer.querySelectorAll("[data-mk]").forEach(btn => {
    btn.addEventListener("click", handleMatrixClick);
  });
}

/* ================================================================
   RESULTS AREA DISPATCHER
   ================================================================ */

function renderResultsArea() {
  if (state.viewMode === "calendar" && state.matrixResponse?.cells?.length > 0) {
    renderCalendarView();
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
      detailContent.innerHTML = `
        <div class="detail-empty">
          <p class="detail-empty__eyebrow">Sin selección</p>
          <p class="detail-empty__text">El detalle aparecerá aquí al elegir una oferta o una celda del calendario.</p>
        </div>
      `;
    }
    return;
  }
  openDetailPanel();

  if (state.detailPendingAction) {
    const copy = detailActionCopy(state.detailPendingAction);
    const amount = formatMoney(offer.price?.total);
    const summary = `${escapeHtml(offer.origin)} → ${escapeHtml(offer.destination)} · ${escapeHtml(offer.mainCarrier ?? offer.validatingCarrier ?? "—")}`;
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

  let h = "";

  // Hero price
  h += `<div class="detail-hero">${formatMoney(offer.price?.total)}</div>`;
  h += `<div class="detail-summary">${escapeHtml(offer.origin)} → ${escapeHtml(offer.destination)} · ${escapeHtml(offer.mainCarrier ?? offer.validatingCarrier ?? "—")} · ${formatDuration(offer.comparisonMetrics?.totalDurationMinutes)} · ${offer.comparisonMetrics?.totalStops ?? 0} esc</div>`;

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
    h += `<div class="detail-segment"><div class="detail-segment__dir">Vuelta — ${group.length} opciones</div>`;
    group.forEach(member => {
      const ib = member.itineraries?.find(it => it.direction === "inbound");
      if (!ib) return;
      const isSelected = member.id === state.selectedOfferId;
      const label = ib.segments?.map(s => `${s.flightNumber} ${s.origin} ${formatDT(s.departureAt)} → ${s.destination} ${formatDT(s.arrivalAt)}`).join(" / ") || "—";
      h += `<div class="detail-segment__leg detail-segment__leg--choice ${isSelected ? "is-selected" : ""}" data-inbound-id="${member.id}">${label}</div>`;
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
  renderToolbar();
  renderSidebar();
  renderResultsArea();
  renderCompare();
  renderDetailPanel();
  updateResultsToolbar();
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

// Detail close
detailClose?.addEventListener("click", () => {
  state.selectedOfferId = null;
  closeDetailPanel();
  renderResultsArea();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !calendarPopover?.classList.contains("hidden")) {
    closeCalendarPopover();
    return;
  }
  if (e.key === "Escape" && detailPanel?.classList.contains("is-open")) {
    state.selectedOfferId = null;
    closeDetailPanel();
    renderResultsArea();
  }
});

// Compare clear
compareClearBtn?.addEventListener("click", () => {
  state.compareIds.clear();
  state.compareResponse = null;
  renderAll();
});

// Results container click delegation (set up once)
resultsContainer?.addEventListener("click", handleResultsClick);

// Results container change delegation for checkboxes (set up once)
resultsContainer?.addEventListener("change", async (e) => {
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

["sortMode", "nonStop", "baggageRequired"].forEach((id) => {
  control(id)?.addEventListener("change", async () => {
    if (!state.searchResponse?.allOffers) return;
    state.sortMode = controlValue("sortMode") || state.sortMode;
    state.resultsPage = 1;
    applyClientOfferControls();
    renderAll();
    if (state.compareIds.size > 0) await refreshCompare();
  });
});

searchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideLocationMenu("origin");
  hideLocationMenu("destination");
  paxPopover?.classList.add("hidden");
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
    state.compareIds.clear();
    state.compareResponse = null;
    state.quotationText = "";
    state.selectedMatrixKey = null;
    state.detailPendingAction = null;
    state.airlineFilter.hidden.clear();
    state.airlineFilter.only = null;

    if (translatedPayload.request.searchMode === "roundtrip-grid") {
      stopSearchPolling();
      state.searchResponse = null;
      state.selectedOfferId = null;
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
    if (state.compareIds.size > 0) await refreshCompare();
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
    if (state.compareIds.size > 0) await refreshCompare();
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
setupThemeToggle();
setupTripTypeToggle();
setupModeToggle();
setupCalendarPopover();
updatePaxLabel();
updateModeFields();
window.addEventListener("resize", syncVisibleLocationMenus);
window.addEventListener("scroll", syncVisibleLocationMenus, true);
renderAll();
