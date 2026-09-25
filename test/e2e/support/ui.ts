import type { Locator, Page } from "playwright";
import { spanishDayName, spanishMonthName } from "./scenario.ts";

/*
 * Every selector the end-to-end suite uses, and nothing else. Roles and
 * accessible names first; visible text where the product has no name for a
 * thing; a `data-testid` only where there is neither. No CSS classes and no
 * coordinates: when the frontend changes shape, this is the one file to adapt.
 */

type Root = Page | Locator;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ---- Shareable links (`frontend/src/lib/search-share.ts`) ---- */

export interface SearchLink {
  mode: "exact" | "flexible" | "migration";
  trip: "round-trip" | "one-way";
  origin: string;
  destination: string;
  departure?: string;
  return?: string;
  departureStart?: string;
  departureEnd?: string;
  stayNights?: number;
  flexible?: "exact-stay";
  months?: string[];
  adults?: number;
  children?: number;
  infants?: number;
  sort?: string;
}

/** The address a search writes onto the bar; opening an exact one runs it. */
export function searchLink(link: SearchLink): string {
  const params = new URLSearchParams();
  const set = (key: string, value: string | number | undefined) => {
    if (value !== undefined && value !== "") params.set(key, String(value));
  };
  set("mode", link.mode);
  set("trip", link.trip);
  set("origin", link.origin);
  set("destination", link.destination);
  set("departure", link.departure);
  set("return", link.return);
  set("departureStart", link.departureStart);
  set("departureEnd", link.departureEnd);
  set("stayNights", link.stayNights);
  set("flexible", link.flexible);
  set("adults", link.adults ?? 1);
  set("children", link.children);
  set("infants", link.infants);
  set("sort", link.sort);
  if (link.months?.length) set("months", link.months.join(","));
  return `/?${params.toString()}`;
}

/* ---- The sign-in gate (`renderLoginPage` in src/web-auth.ts) ---- */

export const login = {
  password: (page: Page) => page.getByLabel("Contraseña"),
  submit: (page: Page) => page.getByRole("button", { name: "Entrar" }),
  /** The announced error, whatever its words. */
  error: (page: Page) => page.getByRole("alert"),
  themeToggle: (page: Page) => page.getByRole("button", { name: "Cambiar tema" }),
};

export async function signInThroughGate(page: Page, password: string): Promise<void> {
  await login.password(page).fill(password);
  await login.submit(page).click();
}

/* ---- The title bar ---- */

export const topBar = {
  themeToggle: (page: Page) => page.getByRole("banner").getByRole("button", { name: "Cambiar tema" }),
  pasteConfig: (page: Page) => page.getByRole("button", { name: "Pegar configuración" }),
};

export async function isDarkTheme(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.classList.contains("dark"));
}

/* ---- The search form ---- */

export type ModeLabel = "Exacto" | "Flexible" | "Migratorio";
export type TripLabel = "Ida y vuelta" | "Solo ida";
export type LocationField = "Origen" | "Destino";

export const searchForm = {
  mode: (page: Page, mode: ModeLabel) =>
    page.getByRole("radiogroup", { name: "Modo de búsqueda" }).getByRole("radio", { name: mode, exact: true }),
  trip: (page: Page, trip: TripLabel) =>
    page.getByRole("radiogroup", { name: "Tipo de viaje" }).getByRole("radio", { name: trip, exact: true }),
  location: (page: Page, field: LocationField) => page.getByRole("combobox", { name: field, exact: true }),
  /** The phone's full-screen suggestions sheet and its own search box. */
  locationSheet: (page: Page, field: LocationField) => page.getByRole("dialog", { name: field, exact: true }),
  locationSheetInput: (page: Page, field: LocationField) =>
    page.getByRole("combobox", { name: `${field}: buscar ciudad o IATA` }),
  /** A match in the suggestions, named «LIM Lima Lima, Perú». */
  suggestion: (page: Page, code: string) => page.getByRole("option", { name: new RegExp(`^${escapeRegExp(code)}\\b`) }),
  suggestions: (page: Page) => page.getByRole("option"),
  /** The «Recientes» / «Frecuentes» sections of the usage panel. */
  usageSection: (page: Page, heading: "Recientes" | "Frecuentes") => page.getByRole("region", { name: heading, exact: true }),
  departureHalf: (page: Page) => page.getByRole("button", { name: /^Salida( desde)?:/ }),
  returnHalf: (page: Page) => page.getByRole("button", { name: /^(Regreso|Salida hasta):/ }),
  calendarDay: (root: Root, isoDate: string) =>
    root.getByRole("button", { name: new RegExp(`^${escapeRegExp(spanishDayName(isoDate))}(,|$)`) }),
  calendarSheet: (page: Page) => page.getByRole("dialog", { name: "Fechas", exact: true }),
  months: (page: Page) => page.getByRole("button", { name: /^Meses:/ }),
  /** The desk's month popover («Selector de meses»); the phone's is the sheet «Meses». */
  monthPicker: (page: Page) =>
    page.getByRole("dialog", { name: "Selector de meses", exact: true }).or(page.getByRole("dialog", { name: "Meses", exact: true })),
  /** A month of the picker, named «noviembre de 2026» plus its state. */
  monthCell: (root: Root, month: string) =>
    root.getByRole("button", { name: new RegExp(`^${escapeRegExp(spanishMonthName(month))}(,|$)`) }),
  passengers: (page: Page) => page.getByRole("button", { name: "Seleccionar pasajeros" }),
  passengerSheet: (page: Page) => page.getByRole("dialog", { name: "Pasajeros", exact: true }),
  addPassenger: (root: Root, kind: "adultos" | "niños" | "bebés") => root.getByRole("button", { name: `Agregar ${kind}` }),
  /** «Aplicar» at the foot of a phone sheet. */
  applySheet: (sheet: Locator) => sheet.getByRole("button", { name: "Aplicar" }),
  submit: (page: Page) => page.locator("form").getByRole("button", { name: "Buscar", exact: true }),
  stop: (page: Page) => page.getByRole("button", { name: "Detener búsqueda" }),
  /** The phone's one-line summary of a search, which reopens the form. */
  editSummary: (page: Page) => page.getByRole("button", { name: "Editar búsqueda" }),
};

/* ---- The notice line above the results ---- */

/* A warning is read out politely, from a `status` region; an error at once,
   from an `alert` one. */
function noticeIn(page: Page, region: Locator): Locator {
  return region.filter({ has: page.getByRole("button", { name: "Descartar el aviso", exact: true }) });
}

export const notice = {
  /** The line, whatever its tone. */
  line: (page: Page) => noticeIn(page, page.getByRole("status").or(page.getByRole("alert"))),
  /** The line when it is an error. */
  error: (page: Page) => noticeIn(page, page.getByRole("alert")),
};

/* ---- Results ---- */

export type SortCriterion = "precio" | "duración" | "hora de salida" | "número de escalas";

export const results = {
  heading: (page: Page) => page.getByRole("heading", { name: /^(Resultados|Vuelo migratorio)$/, level: 2 }),
  /**
   * The heading's line: title, count, «N ocultos por filtros», state pill. A
   * phone hides the title and keeps the rest, so the line is found through
   * the title even when it is not drawn.
   */
  headerLine: (page: Page) =>
    page.getByRole("heading", { name: /^(Resultados|Vuelo migratorio)$/, level: 2, includeHidden: true }).locator(".."),
  sort: (page: Page, criterion: SortCriterion) =>
    page.getByRole("radiogroup", { name: "Orden de resultados" }).getByRole("radio", { name: `Ordenar por ${criterion}` }),
  /** A result row is one button whose name reads the whole fare. */
  cards: (page: Page) => page.getByRole("button", { name: /^(Seleccionar oferta|Oferta seleccionada)\./ }),
  /** The row whose name also matches `pattern` (airline, times, price, provider…). */
  card: (page: Page, pattern: RegExp) =>
    page.getByRole("button", { name: new RegExp(`^(?:Seleccionar oferta|Oferta seleccionada)\\..*${pattern.source}`) }),
  partialPill: (page: Page) => results.headerLine(page).getByText("Parcial", { exact: true }),
  stoppedPill: (page: Page) => results.headerLine(page).getByText("Detenida", { exact: true }),
  emptyTitle: (page: Page, title: string) => page.getByRole("heading", { name: title, level: 3 }),
  /** The way out of an empty or failed list: back to the form. */
  editSearchFromEmpty: (page: Page) => page.getByRole("button", { name: "Volver a editar la búsqueda" }),
  /** The scroller the list grows inside. */
  viewport: (page: Page) => page.getByTestId("results-list-body"),
  openFilters: (page: Page) => page.getByRole("button", { name: "Abrir filtros" }).first(),
};

/* ---- Filters: the desk column, or the phone's «Filtros» sheet ---- */

export type StopsLabel = "Todos" | "Directo" | "1" | "2+";

export const filters = {
  sheet: (page: Page) => page.getByRole("dialog", { name: "Filtros", exact: true }),
  /** The phone's chip for an active filter, and its way out. */
  removeChip: (page: Page, label: string) => page.getByRole("button", { name: `Quitar filtro ${label}` }),
  stops: (root: Root, value: StopsLabel) =>
    root.getByRole("radiogroup", { name: "Escalas", exact: true }).getByRole("radio", { name: value, exact: true }),
  airline: (root: Root, name: string) => root.getByRole("checkbox", { name, exact: true }),
  clear: (root: Root) => root.getByRole("button", { name: "Limpiar filtros" }),
  /** The sheet's primary, «Ver N vuelos». */
  showFlights: (sheet: Locator) => sheet.getByRole("button", { name: /^Ver [\d.,]+ vuelos?$/ }),
};

/* ---- The offer: the desk's third column, or a sheet named «Oferta» ---- */

export const detail = {
  /* The sheet when there is one (it holds the same panel, hence `first`: an
     ancestor comes before what it contains), the desk's column otherwise. */
  surface: (page: Page) =>
    page.getByRole("dialog", { name: "Oferta", exact: true })
      .or(page.locator("section").filter({ has: page.getByRole("heading", { name: "Oferta", level: 2 }) }).filter({
        has: page.getByRole("button", { name: /^(Cotizar|Validando|Copiado)$/ }),
      }))
      .first(),
  quote: (root: Locator) => root.getByRole("button", { name: /^(Cotizar|Validando|Copiado)$/ }),
  /** The provider's own search, through `/r/<id>`. */
  purchase: (root: Locator) => root.getByRole("button", { name: /^(Buscar|Abrir)$/ }),
  close: (root: Locator) => root.getByRole("button", { name: "Cerrar oferta" }),
  /** The itinerary's leg eyebrow, «Ida» or «Vuelta». */
  legTitle: (root: Locator, leg: "Ida" | "Vuelta") => root.getByText(leg, { exact: true }),
  /** One flight of the itinerary rail, «3h 40m · LATAM 2400». */
  flightRow: (root: Locator, flight: string) => root.getByText(new RegExp(`· ${escapeRegExp(flight)}$`)),
  /** The phone's «Cotización copiada» line. */
  copied: (root: Locator) => root.getByRole("status").filter({ hasText: "Cotización copiada" }),
  quoteError: (root: Locator) => root.getByRole("alert"),
};

export const quotation = {
  dialog: (page: Page) => page.getByRole("dialog", { name: "Cotización lista para pegar" }),
  close: (page: Page) => page.getByRole("button", { name: "Cerrar la cotización" }),
};

/* ---- A pasted commercial quotation ---- */

export const pastedQuotation = {
  dialog: (page: Page) => page.getByRole("dialog", { name: "Cotización pegada" }),
  search: (page: Page) => page.getByRole("button", { name: "Buscar con estos datos" }),
};

/* ---- The migratory sweep ---- */

export const migration = {
  /** A month that came back with a fare: «Noviembre de 2026: USD 700.00 con LATAM». */
  pricedMonth: (page: Page, label: string) => page.getByRole("button", { name: new RegExp(`^${escapeRegExp(label)}: `) }),
  /** A month's card, fare or not. The grid gives cards no role, hence the test id. */
  monthCard: (page: Page, label: string) => page.getByTestId("migration-month-card").filter({ hasText: label }),
  monthCards: (page: Page) => page.getByTestId("migration-month-card"),
  openMonth: (page: Page, label: string) => page.getByTitle(`Abrir ${label} en una pestaña nueva`),
};

/* ---- Reading a result row ---- */

export interface CardLeg {
  direction: "Ida" | "Vuelta";
  departs: string;
  arrives: string;
  dayOffset: number;
  duration: string;
  stops: string;
}

export interface CardReading {
  label: string;
  airline: string;
  provider: string;
  currency: string;
  amount: number;
  legs: CardLeg[];
}

const LEG_PATTERN = /(Ida|Vuelta): (\d\d:\d\d) a (\d\d:\d\d)(?:, llega \+(\d+) día)?, ([^,]+), ([^.]+)\./g;

export function readCardLabel(label: string): CardReading {
  const airline = /^(?:Seleccionar oferta|Oferta seleccionada)\. ([^.]+)\./.exec(label)?.[1] ?? "";
  const price = /(USD|PEN|S\/) ([\d.,]+) total/.exec(label);
  const provider = label.slice(label.lastIndexOf(". ") + 2);
  const legs = [...label.matchAll(LEG_PATTERN)].map((match): CardLeg => ({
    direction: match[1] as CardLeg["direction"],
    departs: match[2]!,
    arrives: match[3]!,
    dayOffset: Number(match[4] ?? 0),
    duration: match[5]!,
    stops: match[6]!,
  }));
  return {
    label,
    airline,
    provider,
    currency: price?.[1] ?? "",
    amount: Number((price?.[2] ?? "NaN").replace(/,/g, "")),
    legs,
  };
}

/** The rows on screen, in order, read from their accessible names. */
export async function readCards(page: Page): Promise<CardReading[]> {
  const labels = await results.cards(page).evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label") ?? ""));
  return labels.map(readCardLabel);
}

/** «1h 25m» → 85. */
export function durationMinutes(value: string): number {
  const match = /^(?:(\d+)h)?\s*(?:(\d+)m)?$/.exec(value.trim());
  return match ? Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0) : Number.NaN;
}

/** The header's figure: «3» or «3 de 6». */
export async function readResultCount(page: Page): Promise<{ visible: number; total: number } | undefined> {
  const text = await results.headerLine(page).innerText();
  const match = /(\d[\d,.]*)(?: de (\d[\d,.]*))?/.exec(text.replace(/^(Resultados|Vuelo migratorio)\s*/, ""));
  if (!match) {
    return undefined;
  }
  const visible = Number(match[1]!.replace(/[,.]/g, ""));
  return { visible, total: match[2] ? Number(match[2].replace(/[,.]/g, "")) : visible };
}

/* ---- Geometry the product promises, measured without coordinates in the test ---- */

/** Page-level horizontal overflow: the document wider than its viewport. */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => Math.max(
    document.documentElement.scrollWidth,
    document.body.scrollWidth,
  ) - window.innerWidth);
}

/** Whether an element is on screen and not covered or clipped at its centre. */
export async function isOnScreen(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false;
    const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
    const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
    const hit = document.elementFromPoint(x, y);
    return Boolean(hit && (hit === element || element.contains(hit)));
  });
}

/** Whether all of an element's box is inside the viewport. */
export async function isFullyInViewport(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0
      && rect.top >= 0 && rect.left >= 0
      && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth;
  });
}

/** Whether a text element shows all of its text (no ellipsis, no clip). */
export async function showsWholeText(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
}

/**
 * Whether an element is drawn and nothing that clips it cuts it: every
 * ancestor that hides overflow holds its whole box, and that ancestor's own
 * content is not wider than it (an ellipsis). Inline labels have no width of
 * their own to compare, so the clipping ancestor is what is measured.
 */
export async function isUnclipped(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = window.getComputedStyle(ancestor);
      const frame = ancestor.getBoundingClientRect();
      if (style.overflowX !== "visible" && (box.left < frame.left - 0.5 || box.right > frame.right + 0.5)) return false;
      if (style.overflowY !== "visible" && (box.top < frame.top - 0.5 || box.bottom > frame.bottom + 0.5)) return false;
      if (style.textOverflow === "ellipsis" && ancestor.scrollWidth > ancestor.clientWidth + 1) return false;
    }
    return true;
  });
}

/** The visible stop labels of a row that stops once: «1 escala · BOG» on a desk, «1 esc · BOG» on a phone. */
export function oneStopLabels(root: Root): Locator {
  return root.getByText(/^1 esc(ala)? · [A-Z]{3}$/).filter({ visible: true });
}
