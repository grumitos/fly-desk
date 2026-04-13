import { createHash } from "node:crypto";
import {
  buildDerivedOneWayRequest,
  buildDerivedRequest,
  diffDays,
  enumerateRoundTripFlexibleAxes,
  enumerateRange,
  enumerateUsefulRoundTripPairs,
  enumerateUsefulFlexibleRequests,
  isUsefulRoundTripCombination,
} from "./core/flexible-search";
import {
  buildMatrixConfidenceSummary,
  mapConcurrent,
  prioritizeMatrixLoadingCells,
} from "./core/matrix";
import { buildOfferSignature } from "./core/offer-signature";
import { ProviderSearchResult } from "./core/provider";
import { maxStopsAcrossItineraries } from "./core/ranking";
import {
  BaggageSummary,
  CanonicalOffer,
  CostamarProviderContext,
  FareMeta,
  Itinerary,
  LocationSuggestion,
  MatrixCell,
  MatrixResponse,
  ProviderContext,
  ProviderMeta,
  SearchRequest,
  SearchResponse,
  Segment,
} from "./core/types";
import {
  getCostamarProviderContext,
  resolveLatestCostamarProviderContext,
  resolveUsableCostamarBrandedToken,
} from "./provider-context";
import { openUrlLocally } from "./local-browser";
import {
  resolveMatrixCellConcurrency,
  resolveProviderSubrequestConcurrency,
  resolveRangeSearchConcurrency,
  SHARED_SEARCH_CONCURRENCY,
} from "./search-concurrency";

interface CostamarEngineMetadata {
  code?: string;
  profile?: {
    id?: string;
    name?: string;
    countryCode?: string;
    currencyCode?: string;
    currency?: {
      code?: string;
      mask?: string;
    };
  };
}

interface CostamarAirport {
  code?: string;
  cityCode?: string;
  countryCode?: string;
  name?: string;
  cityName?: string;
}

interface CostamarAirline {
  code?: string;
  name?: string;
}

interface CostamarSegmentLike {
  id?: string;
  departureAirport?: CostamarAirport;
  arrivalAirport?: CostamarAirport;
  departureDateTime?: string;
  arrivalDateTime?: string;
  elapsedTime?: string | number;
  marketingAirline?: CostamarAirline;
  operatingAirline?: CostamarAirline;
  flightNumber?: string | number;
  bookingClass?: string | {
    code?: string;
  };
  fareBasisCode?: string;
  cabinType?: string;
  baggage?: unknown;
}

interface CostamarFlight extends CostamarSegmentLike {
  segments?: CostamarSegmentLike[];
  brandedFare?: {
    name?: string;
  };
}

interface CostamarJourney {
  flights?: CostamarFlight[];
}

interface CostamarPricing {
  base?: number;
  taxes?: number;
  total?: number;
  fees?: unknown;
  discounts?: unknown;
  passengers?: {
    adults?: {
      base?: number | string;
      total?: number | string;
      contextCode?: string;
    };
    children?: {
      base?: number | string;
      total?: number | string;
      contextCode?: string;
    };
    infants?: {
      base?: number | string;
      total?: number | string;
      contextCode?: string;
    };
  };
  source?: string;
  fareQualifier?: string;
  commission?: number;
  validatingAirline?: string;
  totalAmount?: number;
}

interface CostamarRecommendation {
  id?: string;
  itinerary?: CostamarJourney[];
  pricing?: CostamarPricing;
  pos?: {
    systemProviderCode?: string;
    codeContext?: string;
    officeId?: string;
  };
}

interface CostamarSearchResponse {
  status?: number;
  data?: CostamarRecommendation[];
  message?: string;
}

interface CostamarAutocompleteResponse {
  airports?: Array<{
    code?: string;
    countryCode?: string;
    cityCode?: string;
    cityName?: string;
    type?: string;
    name?: string;
  }>;
}

type CostamarAutocompleteAirport = NonNullable<CostamarAutocompleteResponse["airports"]>[number];

interface CostamarSearchOutcome {
  offers: CanonicalOffer[];
  warnings: string[];
}

interface CostamarMarkupApplied {
  amount?: {
    value?: number | string;
    percentage?: boolean;
    appliesToBase?: boolean;
    perPassenger?: boolean;
    perBooking?: boolean;
    passengersType?: string[];
  };
}

interface CostamarMarkupResponse {
  apply?: boolean;
  error?: {
    message?: string;
  } | string;
  markupsApplied?: CostamarMarkupApplied[];
  customMarkupApplied?: CostamarMarkupApplied[];
}

const COSTAMAR_HTTP_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.COSTAMAR_HTTP_TIMEOUT_MS ?? 20000),
);
const COSTAMAR_AIR_API_BASE_URL = process.env.COSTAMAR_AIR_API_BASE_URL?.trim()
  || "https://api-zneith.zdev.tech/api-air-0.1";
const COSTAMAR_REDIRECT_SESSION_WARNING =
  "Costamar redirect token is missing, expired, or incompatible with this terminal.";
const COSTAMAR_SESSION_WARMUP_POLL_MS = 500;

const pendingCostamarSessionWarmups = new Map<string, Promise<CostamarProviderContext>>();
const recentCostamarSessionWarmups = new Map<string, number>();
let costamarWarmupOpener: typeof openUrlLocally = openUrlLocally;

export const COSTAMAR_CONCURRENCY = Object.freeze({
  get matrixMinimum() {
    return SHARED_SEARCH_CONCURRENCY.matrixMinimum;
  },
  get rangeMinimum() {
    return SHARED_SEARCH_CONCURRENCY.rangeMinimum;
  },
  get matrixCell() {
    return resolveMatrixCellConcurrency("COSTAMAR_MATRIX_CELL_CONCURRENCY");
  },
  get rangeSearch() {
    return resolveRangeSearchConcurrency("COSTAMAR_RANGE_SEARCH_CONCURRENCY");
  },
  get markup() {
    return resolveProviderSubrequestConcurrency("COSTAMAR_MARKUP_CONCURRENCY", 4, 2);
  },
  httpTimeoutMs: COSTAMAR_HTTP_TIMEOUT_MS,
});

const engineCache = new Map<string, Promise<CostamarEngineMetadata>>();

function costamarSessionWarmupEnabled(): boolean {
  return String(process.env.COSTAMAR_SESSION_WARMUP_ENABLED ?? "1").trim() !== "0";
}

function costamarSessionWarmupTimeoutMs(): number {
  return Math.max(0, Number(process.env.COSTAMAR_SESSION_WARMUP_TIMEOUT_MS ?? 8000));
}

function costamarSessionWarmupCooldownMs(): number {
  return Math.max(
    costamarSessionWarmupTimeoutMs(),
    Number(process.env.COSTAMAR_SESSION_WARMUP_COOLDOWN_MS ?? 30000),
  );
}

function canWarmCostamarSession(request: SearchRequest): boolean {
  return request.redirectMode !== "none" && costamarSessionWarmupEnabled();
}

function resolveCostamarChromeLaunchOptions(): { userDataDir?: string; profileDirectory?: string } {
  const userDataDir = process.env.COSTAMAR_CHROME_USER_DATA_DIR?.trim()
    || process.env.COSTAMAR_AGENT_CHROME_USER_DATA_DIR?.trim()
    || undefined;
  const profileDirectory = process.env.COSTAMAR_CHROME_PROFILE?.trim()
    || process.env.AGIL_CHROME_PROFILE?.trim()
    || undefined;

  return {
    ...(userDataDir ? { userDataDir } : {}),
    ...(profileDirectory ? { profileDirectory } : {}),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function warmCostamarRedirectContext(
  request: SearchRequest,
  context: CostamarProviderContext,
): Promise<CostamarProviderContext> {
  if (!canWarmCostamarSession(request)) {
    return context;
  }

  if (resolveUsableCostamarBrandedToken(context.token, context.terminalId)) {
    return context;
  }

  const timeoutMs = costamarSessionWarmupTimeoutMs();
  if (timeoutMs <= 0) {
    return context;
  }

  const warmupKey = context.terminalId || "default";
  const pending = pendingCostamarSessionWarmups.get(warmupKey);
  if (pending) {
    return pending;
  }

  const nowMs = Date.now();
  const lastAttemptAt = recentCostamarSessionWarmups.get(warmupKey) ?? 0;
  if ((nowMs - lastAttemptAt) < costamarSessionWarmupCooldownMs()) {
    return resolveLatestCostamarProviderContext({
      ...context,
      token: "",
    });
  }

  const promise = (async () => {
    recentCostamarSessionWarmups.set(warmupKey, Date.now());
    const seedContext = {
      ...context,
      token: "",
    };

    try {
      await costamarWarmupOpener(
        buildCostamarBrandedSearchUrl(request, seedContext),
        "chrome",
        resolveCostamarChromeLaunchOptions(),
      );
    } catch {
      // Ignore launcher failures and still re-check any ambient session changes.
    }

    const deadline = Date.now() + timeoutMs;
    let latest = resolveLatestCostamarProviderContext(seedContext);
    while (Date.now() < deadline) {
      if (resolveUsableCostamarBrandedToken(latest.token, latest.terminalId)) {
        return latest;
      }

      await sleep(COSTAMAR_SESSION_WARMUP_POLL_MS);
      latest = resolveLatestCostamarProviderContext(seedContext);
    }

    return latest;
  })();

  pendingCostamarSessionWarmups.set(warmupKey, promise);
  try {
    return await promise;
  } finally {
    pendingCostamarSessionWarmups.delete(warmupKey);
  }
}

export function setCostamarWarmupOpenerForTests(
  opener?: typeof openUrlLocally,
): void {
  costamarWarmupOpener = opener ?? openUrlLocally;
}

export function resetCostamarWarmupStateForTests(): void {
  engineCache.clear();
  pendingCostamarSessionWarmups.clear();
  recentCostamarSessionWarmups.clear();
  costamarWarmupOpener = openUrlLocally;
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function toCostamarDayStart(dateIso?: string): string | undefined {
  if (!dateIso) {
    return undefined;
  }

  return new Date(`${dateIso}T00:00:00-05:00`).toISOString();
}

function toCostamarDayStartMs(dateIso?: string): number | undefined {
  const normalized = toCostamarDayStart(dateIso);
  if (!normalized) {
    return undefined;
  }

  const timestamp = new Date(normalized).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function toCompactDate(dateIso?: string): string | undefined {
  return dateIso ? dateIso.replaceAll("-", "") : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function parseDurationMinutes(value: unknown, departureAt?: string, arrivalAt?: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      return Math.max(0, Number(trimmed));
    }

    const hhmm = trimmed.match(/^(\d{1,2}):(\d{2})$/);
    if (hhmm) {
      return (Number(hhmm[1]) * 60) + Number(hhmm[2]);
    }

    const iso = trimmed.match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/i);
    if (iso) {
      return (Number(iso[1] ?? 0) * 60) + Number(iso[2] ?? 0);
    }
  }

  if (departureAt && arrivalAt) {
    const diff = new Date(arrivalAt).getTime() - new Date(departureAt).getTime();
    if (Number.isFinite(diff) && diff > 0) {
      return Math.round(diff / 60000);
    }
  }

  return 0;
}

function computeLayovers(segments: Segment[]): number[] {
  const layovers: number[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    const diff = Math.round(
      (new Date(current.departureAt).getTime() - new Date(previous.arrivalAt).getTime()) / 60000,
    );
    layovers.push(Math.max(0, diff));
  }
  return layovers;
}

function baggageEntryList(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (value && typeof value === "object") {
    return [value];
  }

  return [];
}

function buildBaggageSummaryFromSegments(segments: CostamarSegmentLike[]): BaggageSummary | undefined {
  let carryOnIncluded = false;
  let checkedIncluded = false;
  let checkedBags = 0;
  const descriptions: string[] = [];

  for (const segment of segments) {
    for (const entry of baggageEntryList(segment.baggage)) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const record = entry as Record<string, unknown>;
      const type = String(
        record.type
        ?? record.baggageType
        ?? record.code
        ?? record.category
        ?? "",
      ).toLowerCase();
      const description = String(record.description ?? record.name ?? "").trim();
      const quantity = numberValue(
        record.quantity
        ?? record.amount
        ?? record.pieces
        ?? record.qty,
      ) ?? 0;

      if (description) {
        descriptions.push(description);
      }

      if (type.includes("carry") || type.includes("hand") || type.includes("cab")) {
        carryOnIncluded = carryOnIncluded || quantity > 0 || Boolean(description);
      }

      if (type.includes("check") || type.includes("hold") || description.toLowerCase().includes("bodega")) {
        checkedIncluded = checkedIncluded || quantity > 0 || Boolean(description);
        checkedBags += quantity > 0 ? quantity : 0;
      }
    }
  }

  if (!carryOnIncluded && !checkedIncluded && checkedBags === 0 && descriptions.length === 0) {
    return undefined;
  }

  return {
    carryOnIncluded,
    checkedIncluded,
    checkedBags: checkedBags || undefined,
    description: uniqueStrings(descriptions).join(", ") || undefined,
  };
}

function buildCostamarOfferId(
  signature: string,
  totalAmount: number,
  currencyCode: string,
): string {
  const seed = `${signature}::${totalAmount.toFixed(2)}::${currencyCode}`;
  return `costamar-${createHash("sha1").update(seed).digest("hex").slice(0, 16)}`;
}

function dedupeCostamarOffers(offers: CanonicalOffer[]): CanonicalOffer[] {
  const deduped = new Map<string, CanonicalOffer>();

  for (const offer of offers) {
    const key = [
      offer.signature,
      offer.price.total.amount.toFixed(2),
      offer.price.total.currencyCode,
      String(offer.baggage?.checkedBags ?? ""),
      String(offer.baggage?.carryOnIncluded ?? ""),
    ].join("::");
    const existing = deduped.get(key);
    if (!existing || offer.valueScore < existing.valueScore) {
      deduped.set(key, offer);
    }
  }

  return [...deduped.values()];
}

function sumMoneyLike(value: unknown): number {
  if (value === undefined || value === null) {
    return 0;
  }

  const direct = numberValue(value);
  if (typeof direct === "number") {
    return direct;
  }

  if (Array.isArray(value)) {
    return value.reduce((sum, entry) => sum + sumMoneyLike(entry), 0);
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["amount", "value", "total", "price", "markup"]) {
      const numeric = numberValue(record[key]);
      if (typeof numeric === "number") {
        return numeric;
      }
    }

    for (const key of ["markups", "discounts", "items", "fees", "data"]) {
      if (record[key] !== undefined) {
        return sumMoneyLike(record[key]);
      }
    }
  }

  return 0;
}

function money(amount: number | undefined, currencyCode: string) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return undefined;
  }

  return {
    amount: Number(amount.toFixed(2)),
    currencyCode,
  };
}

function roundMoneyAmount(amount: number): number {
  return Number(amount.toFixed(2));
}

function resolveCostamarOfferCurrencyCode(
  request: SearchRequest,
  engine: CostamarEngineMetadata,
): string {
  const requestedCurrencyCode = String(request.currencyCode ?? "").trim().toUpperCase();
  if (requestedCurrencyCode) {
    return requestedCurrencyCode;
  }

  const engineCurrencyCode = String(
    engine.profile?.currencyCode
      ?? engine.profile?.currency?.code
      ?? "USD",
  ).trim().toUpperCase();

  return engineCurrencyCode || "USD";
}

function ensureCostamarCredentials(context: CostamarProviderContext): void {
  if (!context.terminalId) {
    throw new Error("Costamar terminalId is required.");
  }
}

async function fetchCostamar(
  context: CostamarProviderContext,
  path: string,
  init: RequestInit,
  action: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COSTAMAR_HTTP_TIMEOUT_MS);

  try {
    return await fetch(`${context.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json, text/plain, */*",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new Error(`${action} failed: ${detail}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCostamarJson<T>(
  context: CostamarProviderContext,
  path: string,
  init: RequestInit,
  action: string,
): Promise<T> {
  const response = await fetchCostamar(context, path, init, action);
  const bodyText = await response.text();
  let parsed: T | undefined;

  try {
    parsed = bodyText ? JSON.parse(bodyText) as T : undefined;
  } catch {
    parsed = undefined;
  }

  if (!response.ok) {
    throw new Error(
      bodyText
        ? `${action} failed with ${response.status} ${response.statusText}: ${bodyText}`
        : `${action} failed with ${response.status} ${response.statusText}`,
    );
  }

  return parsed as T;
}

async function getEngineMetadata(context: CostamarProviderContext): Promise<CostamarEngineMetadata> {
  const cacheKey = `${context.apiBaseUrl}::${context.terminalId}`;
  const cached = engineCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const request = fetchCostamarJson<CostamarEngineMetadata>(
    context,
    `/engines/${encodeURIComponent(context.terminalId)}`,
    { method: "GET" },
    "Costamar engine metadata",
  ).catch((error) => {
    engineCache.delete(cacheKey);
    throw error;
  });

  engineCache.set(cacheKey, request);
  return request;
}

export function buildCostamarSearchBody(
  request: SearchRequest,
  context: CostamarProviderContext,
  flexible = false,
): Record<string, unknown> {
  const leg = request.legs[0];
  const departureDate = toCompactDate(leg.departureDate);
  const returnDate = toCompactDate(leg.returnDate);
  if (!departureDate) {
    throw new Error("Costamar exact search requires departureDate.");
  }

  const itinerary = [
    {
      origin: leg.origin,
      destination: leg.destination,
      date: departureDate,
    },
  ];

  if (request.tripType === "round-trip") {
    if (!returnDate) {
      throw new Error("Costamar round-trip search requires returnDate.");
    }

    itinerary.push({
      origin: leg.destination,
      destination: leg.origin,
      date: returnDate,
    });
  }

  const validationToken = resolveUsableCostamarBrandedToken(context.token, context.terminalId);

  return {
    flightType: request.tripType === "one-way" ? "OW" : "RT",
    terminalId: context.terminalId,
    itinerary,
    passengers: {
      adults: request.passengers.adults,
      children: request.passengers.children,
      infants: request.passengers.infants,
    },
    startDate: toCostamarDayStart(leg.departureDate),
    endDate: toCostamarDayStart(request.tripType === "round-trip" ? leg.returnDate : leg.departureDate),
    ...(validationToken ? { token: validationToken } : {}),
    hasValidationToken: Boolean(validationToken),
    flexible,
  };
}

export function buildCostamarSearchWarning(payload: CostamarSearchResponse): string | undefined {
  const status = payload.status;
  if (typeof status !== "number" || status < 400) {
    return undefined;
  }

  const message = payload.message?.trim();
  if (message) {
    return `Costamar rejected this search (${status}): ${message}`;
  }

  if (status === 401) {
    return "Costamar rejected this search: the branded token is invalid, expired, or no longer belongs to this agency.";
  }

  if (status === 402) {
    return "Costamar rejected this search: the validation token is missing for this branded flow.";
  }

  return `Costamar rejected this search with status ${status}.`;
}

function normalizeSegment(
  value: CostamarSegmentLike,
  idSeed: string,
): Segment | undefined {
  const departureAt = value.departureDateTime;
  const arrivalAt = value.arrivalDateTime;
  const origin = value.departureAirport?.code?.trim().toUpperCase();
  const destination = value.arrivalAirport?.code?.trim().toUpperCase();

  if (!departureAt || !arrivalAt || !origin || !destination) {
    return undefined;
  }

  const marketingCarrier = value.marketingAirline?.code?.trim().toUpperCase() || "XX";
  const rawFlightNumber = String(value.flightNumber ?? "").trim();

  return {
    id: `${idSeed}-${origin}-${destination}-${rawFlightNumber || "0"}`,
    marketingCarrier,
    marketingCarrierName: value.marketingAirline?.name,
    operatingCarrier: value.operatingAirline?.code?.trim().toUpperCase(),
    operatingCarrierName: value.operatingAirline?.name,
    flightNumber: rawFlightNumber,
    origin,
    originName: value.departureAirport?.cityName ?? value.departureAirport?.name,
    destination,
    destinationName: value.arrivalAirport?.cityName ?? value.arrivalAirport?.name,
    departureAt,
    arrivalAt,
    durationMinutes: parseDurationMinutes(value.elapsedTime, departureAt, arrivalAt),
  };
}

function normalizeItinerary(
  recommendation: CostamarRecommendation,
  direction: "outbound" | "inbound",
  journey: CostamarJourney,
  index: number,
): { itinerary?: Itinerary; rawSegments: CostamarSegmentLike[] } {
  const selectedFlight = asArray(journey.flights)[0];
  if (!selectedFlight) {
    return { rawSegments: [] };
  }

  const rawSegments = asArray(selectedFlight.segments).length > 0
    ? asArray(selectedFlight.segments)
    : [selectedFlight];
  const segments = rawSegments
    .map((segment, segmentIndex) => normalizeSegment(
      segment,
      `${recommendation.id ?? "recommendation"}-${direction}-${index}-${segmentIndex}`,
    ))
    .filter((segment): segment is Segment => Boolean(segment));

  if (segments.length === 0) {
    return { rawSegments };
  }

  const layoverMinutes = computeLayovers(segments);
  const first = segments[0];
  const last = segments[segments.length - 1];

  return {
    rawSegments,
    itinerary: {
      id: `${recommendation.id ?? "recommendation"}-${direction}-${index}`,
      direction,
      durationMinutes: parseDurationMinutes(
        selectedFlight.elapsedTime,
        first.departureAt,
        last.arrivalAt,
      ),
      stops: Math.max(0, segments.length - 1),
      layoverMinutes,
      segments,
    },
  };
}

function buildPurchasePaths(
  request: SearchRequest,
  context: CostamarProviderContext,
): CanonicalOffer["purchasePaths"] {
  if (!resolveUsableCostamarBrandedToken(context.token, context.terminalId)) {
    return [];
  }

  return [
    {
      id: "costamar-search",
      type: "search-redirect",
      provider: "costamar",
      label: "Buscar en Costamar",
      url: buildCostamarBrandedSearchUrl(request, context),
      precision: "exact-search",
      score: 0.9,
      requiresNewTab: true,
      commercialMode: "provider",
      state: "search_redirect",
    },
  ];
}

export function buildCostamarBrandedSearchUrl(
  request: SearchRequest,
  context: CostamarProviderContext,
): string {
  const leg = request.legs[0];
  const base = new URL(`${context.brandBaseUrl.replace(/\/+$/, "")}/`);
  const pathParts = [
    "b",
    leg.origin,
    leg.destination,
    leg.departureDate ?? "",
  ];

  if (request.tripType === "round-trip") {
    pathParts.push(leg.returnDate ?? "");
  }

  pathParts.push(
    String(request.passengers.adults),
    String(request.passengers.children),
    String(request.passengers.infants),
  );

  base.pathname = `${base.pathname.replace(/\/+$/, "")}/${pathParts.join("/")}`;
  return applyCostamarContextToBrandedSearchUrl(base.toString(), context);
}

export function applyCostamarContextToBrandedSearchUrl(
  input: string,
  context: CostamarProviderContext,
): string {
  const branded = new URL(input);
  branded.searchParams.set("terminalId", context.terminalId);
  branded.searchParams.set("lang", context.lang);
  const redirectToken = resolveUsableCostamarBrandedToken(context.token, context.terminalId);
  if (redirectToken) {
    branded.searchParams.set("token", redirectToken);
  } else {
    branded.searchParams.delete("token");
  }

  return branded.toString();
}

function buildLocationsPayload(
  itineraries: Itinerary[],
): Array<{ cityCode?: string; countryCode?: string; date?: number }> {
  return itineraries.map((itinerary) => ({
    cityCode: itinerary.segments[0]?.origin ?? "",
    countryCode: "",
    date: toCostamarDayStartMs(itinerary.segments[0]?.departureAt?.slice(0, 10)),
  }));
}

function buildMarkupFlightsPayload(
  recommendation: CostamarRecommendation,
): Array<Record<string, unknown>> {
  return asArray(recommendation.itinerary).flatMap((journey, index) => {
    const selectedFlight = asArray(journey.flights)[0];
    if (!selectedFlight) {
      return [];
    }

    const segments: CostamarSegmentLike[] = asArray(selectedFlight.segments).length > 0
      ? asArray(selectedFlight.segments)
      : [selectedFlight];
    const normalizedSegments = segments.map((segment) => ({
      bookingClass: typeof segment.bookingClass === "string"
        ? segment.bookingClass
        : segment.bookingClass?.code,
      fareBasisCode: segment.fareBasisCode,
      marketingAirline: {
        code: segment.marketingAirline?.code,
      },
      operatingAirline: {
        code: segment.operatingAirline?.code ?? segment.marketingAirline?.code,
      },
      flightNumber: segment.flightNumber,
      cabinType: segment.cabinType,
    }));

    return [{
      segments: normalizedSegments,
      duration: parseDurationMinutes(selectedFlight.elapsedTime),
      refNumber: index,
    }];
  });
}

function shouldApplyCostamarBaggageMarkup(
  recommendation: CostamarRecommendation,
): boolean {
  const firstFlight = asArray(asArray(recommendation.itinerary)[0]?.flights)[0];
  if (!firstFlight || firstFlight.marketingAirline?.code === "VV") {
    return false;
  }

  const baggage = firstFlight.baggage as Record<string, unknown> | undefined;
  if (!baggage) {
    return false;
  }

  return String(baggage.pieces ?? "") !== "0";
}

function buildMarkupRequest(
  engine: CostamarEngineMetadata,
  request: SearchRequest,
  recommendation: CostamarRecommendation,
  itineraries: Itinerary[],
): Record<string, unknown> {
  const passengerTypes: string[] = ["ADT"];

  if (request.passengers.children > 0) {
    passengerTypes.push("CHD");
  }
  if (request.passengers.infants > 0) {
    passengerTypes.push("INF");
  }

  return {
    engineCode: engine.code ?? request.providerId ?? "costamar",
    profileId: engine.profile?.id,
    locations: buildLocationsPayload(itineraries),
    passengersQuantity: request.passengers.adults + request.passengers.children + request.passengers.infants,
    passengersType: passengerTypes,
    flights: buildMarkupFlightsPayload(recommendation),
    applyBaggage: shouldApplyCostamarBaggageMarkup(recommendation),
    tripType: request.tripType === "one-way" ? "OW" : "RT",
    routeType: recommendation.pricing?.fareQualifier,
    fareType: recommendation.pricing?.source === "PRIVATE"
      ? "PRIVATED"
      : recommendation.pricing?.source,
    validatingAirline: recommendation.pricing?.validatingAirline,
    validatingGds: recommendation.pos?.systemProviderCode,
  };
}

function buildCostamarPassengerFareBreakdowns(
  recommendation: CostamarRecommendation,
  request: SearchRequest,
): Array<{
  code: "ADT" | "CHD" | "INF";
  passengerFare: {
    base: number;
    total: number;
  };
  quantity: number;
}> {
  const passengers = recommendation.pricing?.passengers;
  return [
    {
      code: "ADT" as const,
      passengerFare: {
        base: numberValue(passengers?.adults?.base) ?? 0,
        total: numberValue(passengers?.adults?.total) ?? 0,
      },
      quantity: request.passengers.adults,
    },
    {
      code: "CHD" as const,
      passengerFare: {
        base: numberValue(passengers?.children?.base) ?? 0,
        total: numberValue(passengers?.children?.total) ?? 0,
      },
      quantity: request.passengers.children,
    },
    {
      code: "INF" as const,
      passengerFare: {
        base: numberValue(passengers?.infants?.base) ?? 0,
        total: numberValue(passengers?.infants?.total) ?? 0,
      },
      quantity: request.passengers.infants,
    },
  ].filter((entry) => entry.quantity > 0);
}

function computeCostamarMarkupValue(
  markup: CostamarMarkupApplied,
  recommendation: CostamarRecommendation,
  request: SearchRequest,
): number {
  const markupAmount = numberValue(markup.amount?.value);
  if (typeof markupAmount !== "number") {
    return 0;
  }

  const pricing = recommendation.pricing ?? {};
  const totalAmount = numberValue(pricing.total) ?? numberValue(pricing.totalAmount) ?? 0;
  if (markup.amount?.perBooking) {
    if (markup.amount?.percentage) {
      return roundMoneyAmount((roundMoneyAmount(totalAmount) * markupAmount) / 100);
    }

    return roundMoneyAmount(markupAmount);
  }

  const passengerTypes = asArray(markup.amount?.passengersType).map((value) => String(value));
  let computed = 0;

  buildCostamarPassengerFareBreakdowns(recommendation, request).forEach((breakdown) => {
    if (passengerTypes.length > 0 && !passengerTypes.includes(breakdown.code)) {
      return;
    }

    if (markup.amount?.percentage) {
      const baseValue = markup.amount?.appliesToBase
        ? breakdown.passengerFare.base
        : breakdown.passengerFare.total;
      computed += roundMoneyAmount((roundMoneyAmount(baseValue) * markupAmount) / 100) * breakdown.quantity;
      return;
    }

    computed += markupAmount * breakdown.quantity;
  });

  return roundMoneyAmount(computed);
}

function resolveCostamarMarkupError(markupResponse: CostamarMarkupResponse): string | undefined {
  if (typeof markupResponse.error === "string") {
    return markupResponse.error.trim() || undefined;
  }

  if (typeof markupResponse.error?.message === "string") {
    return markupResponse.error.message.trim() || undefined;
  }

  return undefined;
}

function sumCostamarMarkupTotals(
  markupResponse: CostamarMarkupResponse,
  recommendation: CostamarRecommendation,
  request: SearchRequest,
): number {
  return [
    ...asArray(markupResponse.markupsApplied),
    ...asArray(markupResponse.customMarkupApplied),
  ].reduce((sum, markup) => sum + computeCostamarMarkupValue(markup, recommendation, request), 0);
}

async function applyMarkupToOffer(
  context: CostamarProviderContext,
  engine: CostamarEngineMetadata,
  request: SearchRequest,
  recommendation: CostamarRecommendation,
  offer: CanonicalOffer,
  rawSegments: CostamarSegmentLike[],
): Promise<CanonicalOffer> {
  if (!engine.profile?.id || rawSegments.length === 0) {
    return offer;
  }

  try {
    const markupResponse = await fetchCostamarJson<CostamarMarkupResponse>(
      context,
      "/flights/markups/apply",
      {
        method: "POST",
        body: JSON.stringify(buildMarkupRequest(engine, request, recommendation, offer.itineraries)),
      },
      "Costamar markup apply",
    );

    const markups = sumCostamarMarkupTotals(markupResponse, recommendation, request);
    const discounts = sumMoneyLike(recommendation.pricing?.discounts);
    const markupError = resolveCostamarMarkupError(markupResponse);
    if (markups <= 0 && discounts <= 0) {
      return markupError
        ? {
            ...offer,
            warnings: [
              ...offer.warnings,
              `Costamar markup omitted: ${markupError}`,
            ],
          }
        : offer;
    }

    const total = roundMoneyAmount(offer.price.total.amount + markups - discounts);
    return {
      ...offer,
      id: buildCostamarOfferId(offer.signature, total, offer.price.total.currencyCode),
      price: {
        ...offer.price,
        total: {
          ...offer.price.total,
          amount: total,
        },
      },
    };
  } catch (error) {
    return {
      ...offer,
      warnings: [
        ...offer.warnings,
        error instanceof Error
          ? `Costamar markup omitted: ${error.message}`
          : "Costamar markup omitted.",
      ],
    };
  }
}

export function mapCostamarRecommendationToOffer(
  recommendation: CostamarRecommendation,
  request: SearchRequest,
  context: CostamarProviderContext,
  engine: CostamarEngineMetadata,
): { offer?: CanonicalOffer; rawSegments: CostamarSegmentLike[] } {
  const journeys = asArray(recommendation.itinerary);
  const outboundNormalized = normalizeItinerary(recommendation, "outbound", journeys[0] ?? {}, 0);
  if (!outboundNormalized.itinerary) {
    return { rawSegments: [] };
  }

  const inboundNormalized = request.tripType === "round-trip"
    ? normalizeItinerary(recommendation, "inbound", journeys[1] ?? {}, 1)
    : { rawSegments: [] as CostamarSegmentLike[] };
  if (request.tripType === "round-trip" && !inboundNormalized.itinerary) {
    return { rawSegments: [] };
  }

  const itineraries = request.tripType === "round-trip"
    ? [outboundNormalized.itinerary, inboundNormalized.itinerary].filter((entry): entry is Itinerary => Boolean(entry))
    : [outboundNormalized.itinerary];
  const maxStops = typeof request.filters.maxStops === "number"
    ? Math.max(0, request.filters.maxStops)
    : undefined;
  if (typeof maxStops === "number" && maxStopsAcrossItineraries(itineraries) > maxStops) {
    return { rawSegments: [] };
  }

  const pricing = recommendation.pricing ?? {};
  const currencyCode = resolveCostamarOfferCurrencyCode(request, engine);
  const totalAmount = numberValue(pricing.total) ?? numberValue(pricing.totalAmount);
  if (typeof totalAmount !== "number") {
    return { rawSegments: [] };
  }

  const baggage = buildBaggageSummaryFromSegments([
    ...outboundNormalized.rawSegments,
    ...inboundNormalized.rawSegments,
  ]);
  const firstSegment = outboundNormalized.itinerary.segments[0];
  const offer: CanonicalOffer = {
    id: "",
    signature: "",
    providerSource: "costamar",
    providerOfferRef: String(recommendation.id ?? createHash("sha1").update(JSON.stringify(recommendation)).digest("hex")),
    tripType: request.tripType,
    validatingCarrier: pricing.validatingAirline ?? firstSegment.marketingCarrier,
    mainCarrier: firstSegment.marketingCarrier,
    origin: firstSegment.origin,
    destination: outboundNormalized.itinerary.segments[outboundNormalized.itinerary.segments.length - 1]?.destination ?? request.legs[0].destination,
    itineraries,
    price: {
      total: {
        amount: Number(totalAmount.toFixed(2)),
        currencyCode,
      },
      base: money(numberValue(pricing.base), currencyCode),
      taxes: money(numberValue(pricing.taxes), currencyCode),
    },
    baggage,
    fareMeta: {
      seatsRemaining: undefined,
      lastTicketingDate: undefined,
      refundable: undefined,
      changeable: undefined,
    } satisfies FareMeta,
    priceConfidence: "live",
    priceStatus: "unverified",
    purchasePaths: buildPurchasePaths(request, context),
    comparisonMetrics: {
      totalDurationMinutes: 0,
      totalStops: 0,
      baggageScore: 0,
      purchasePathScore: 0,
    },
    tags: uniqueStrings([
      pricing.fareQualifier ? String(pricing.fareQualifier).toLowerCase() : "",
      pricing.source ? String(pricing.source).toLowerCase() : "",
    ]),
    warnings: [],
    rawRefs: {
      recommendationId: recommendation.id,
      pos: recommendation.pos,
    },
    valueScore: 0,
  };

  const signature = buildOfferSignature(offer);

  return {
    rawSegments: [...outboundNormalized.rawSegments, ...inboundNormalized.rawSegments],
    offer: {
      ...offer,
      signature,
      id: buildCostamarOfferId(signature, offer.price.total.amount, currencyCode),
    },
  };
}

async function searchRecommendations(
  request: SearchRequest,
  providerContext?: ProviderContext,
  flexible = false,
): Promise<CostamarSearchOutcome> {
  const baseContext = getCostamarProviderContext(providerContext);
  let redirectContext = resolveLatestCostamarProviderContext(baseContext);
  if (!resolveUsableCostamarBrandedToken(redirectContext.token, redirectContext.terminalId)) {
    redirectContext = await warmCostamarRedirectContext(request, redirectContext);
  }

  const context = resolveUsableCostamarBrandedToken(redirectContext.token, redirectContext.terminalId)
    ? {
        ...baseContext,
        terminalId: redirectContext.terminalId,
        token: redirectContext.token,
        lang: redirectContext.lang,
      }
    : baseContext;

  ensureCostamarCredentials(context);

  const engine = await getEngineMetadata(context);
  const search = (searchContext: CostamarProviderContext) => fetchCostamarJson<CostamarSearchResponse>(
    searchContext,
    "/flights/search",
    {
      method: "POST",
      body: JSON.stringify(buildCostamarSearchBody(request, searchContext, flexible)),
    },
    "Costamar flight search",
  );

  let payload = await search(context);
  if (
    context.token
    && (payload.status === 401 || payload.status === 402)
  ) {
    const fallbackPayload = await search({
      ...context,
      token: "",
    });
    if (typeof fallbackPayload.status !== "number" || fallbackPayload.status < 400) {
      payload = fallbackPayload;
    }
  }

  const responseWarning = buildCostamarSearchWarning(payload);
  const recommendations = responseWarning ? [] : asArray(payload.data);
  const mapped = await mapConcurrent(recommendations, COSTAMAR_CONCURRENCY.markup, async (recommendation) => {
    const normalized = mapCostamarRecommendationToOffer(recommendation, request, redirectContext, engine);
    if (!normalized.offer) {
      return undefined;
    }

    return applyMarkupToOffer(
      context,
      engine,
      request,
      recommendation,
      normalized.offer,
      normalized.rawSegments,
    );
  });

  const offers = dedupeCostamarOffers(mapped.filter((offer): offer is CanonicalOffer => Boolean(offer)));
  const hasUsableRedirectToken = Boolean(
    resolveUsableCostamarBrandedToken(redirectContext.token, redirectContext.terminalId),
  );
  const warnings = uniqueStrings([
    ...(responseWarning ? [responseWarning] : []),
    ...(offers.length > 0 && !hasUsableRedirectToken ? [COSTAMAR_REDIRECT_SESSION_WARNING] : []),
    ...offers.flatMap((offer) => offer.warnings),
  ]);

  if (offers.length === 0 && warnings.length === 0) {
    warnings.push("Costamar returned no offers for this search.");
  }

  return {
    offers,
    warnings,
  };
}

export async function searchLocalCostamarExact(
  request: SearchRequest,
  providerContext?: ProviderContext,
): Promise<ProviderSearchResult> {
  if (request.searchMode === "stay-range") {
    return searchLocalCostamarRange(request, providerContext);
  }

  const outcome = await searchRecommendations(request, providerContext, false);
  return {
    offers: outcome.offers,
    warnings: outcome.warnings,
    partial: false,
  };
}

export function createLocalCostamarSearchDraft(
  request: SearchRequest,
  providerMeta: ProviderMeta,
): SearchResponse {
  const requestedAt = new Date().toISOString();
  const warning = request.searchMode === "stay-range"
    ? "Consultando Costamar en paralelo. Los resultados se iran agregando."
    : "Consultando Costamar. Los resultados se iran agregando.";

  return {
    offers: [],
    allOffers: [],
    searchMeta: {
      requestedAt,
      completedAt: requestedAt,
      providersUsed: ["costamar"],
      warnings: [warning],
      partial: true,
      searchState: "search_partial",
    },
    providerMeta,
    warnings: [warning],
  };
}

export async function resolveLocalCostamarExactProgressive(
  request: SearchRequest,
  providerContext?: ProviderContext,
  onUpdate?: (result: ProviderSearchResult) => boolean | void,
): Promise<ProviderSearchResult> {
  const result = await searchLocalCostamarExact({
    ...request,
    searchMode: "exact",
  }, providerContext);
  onUpdate?.({
    ...result,
    partial: true,
  });
  return result;
}

function enumerateRangeRequests(request: SearchRequest): SearchRequest[] {
  return enumerateUsefulFlexibleRequests(request);
}

export async function searchLocalCostamarRange(
  request: SearchRequest,
  providerContext?: ProviderContext,
): Promise<ProviderSearchResult> {
  const candidates = enumerateRangeRequests(request);
  const outcomes = await mapConcurrent(candidates, COSTAMAR_CONCURRENCY.rangeSearch, async (derivedRequest) => {
    try {
      return {
        result: await searchLocalCostamarExact(derivedRequest, providerContext),
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Costamar range search failed.",
      };
    }
  });

  const warnings = uniqueStrings([
    ...outcomes.flatMap((outcome) => outcome.result?.warnings ?? []),
    ...outcomes.flatMap((outcome) => outcome.error ? [outcome.error] : []),
  ]);
  const offers = dedupeCostamarOffers(
    outcomes.flatMap((outcome) => outcome.result?.offers ?? []),
  );

  if (offers.length === 0 && warnings.length === 0) {
    warnings.push("Costamar returned no offers for this date range.");
  }

  return {
    offers,
    warnings,
    partial: outcomes.some((outcome) => Boolean(outcome.error)),
  };
}

export async function resolveLocalCostamarRangeProgressive(
  request: SearchRequest,
  providerContext?: ProviderContext,
  onUpdate?: (result: ProviderSearchResult) => boolean | void,
): Promise<ProviderSearchResult> {
  const candidates = enumerateRangeRequests(request);
  const aggregatedOffers: CanonicalOffer[] = [];
  const warnings: string[] = [];
  let partial = false;
  let stopRequested = false;

  await mapConcurrent(candidates, COSTAMAR_CONCURRENCY.rangeSearch, async (derivedRequest) => {
    try {
      const result = await searchLocalCostamarExact(derivedRequest, providerContext);
      aggregatedOffers.push(...result.offers);
      warnings.push(...result.warnings);
    } catch (error) {
      partial = true;
      warnings.push(error instanceof Error ? error.message : "Costamar range search failed.");
    }

    if (onUpdate?.({
      offers: dedupeCostamarOffers(aggregatedOffers),
      warnings: uniqueStrings(warnings),
      partial: true,
    }) === false) {
      stopRequested = true;
    }
  }, {
    canContinue: () => !stopRequested,
  });

  const offers = dedupeCostamarOffers(aggregatedOffers);
  const finalWarnings = uniqueStrings(warnings);
  if (offers.length === 0 && finalWarnings.length === 0) {
    finalWarnings.push("Costamar returned no offers for this date range.");
  }

  return {
    offers,
    warnings: finalWarnings,
    partial: partial || stopRequested,
  };
}

export function createLocalCostamarMatrixDraft(
  request: SearchRequest,
  providerMeta: ProviderMeta,
): MatrixResponse {
  const leg = request.legs[0];
  if (!leg.departureStart || !leg.departureEnd) {
    throw new Error("Costamar matrix requires departureStart and departureEnd.");
  }

  const departures = enumerateRange(leg.departureStart, leg.departureEnd);
  const requestedAt = new Date().toISOString();
  const pairs = request.tripType === "round-trip"
    ? enumerateUsefulRoundTripPairs(request)
    : [];
  const axes = request.tripType === "round-trip"
    ? enumerateRoundTripFlexibleAxes(request, pairs)
    : {
        departureDates: departures,
        returnDates: [] as string[],
      };
  const cells = request.tripType === "one-way"
    ? departures.map((departureDate) => ({
        key: departureDate,
        departureDate,
        confidence: "loading" as const,
        providerSource: "costamar" as const,
        selectable: false,
        requiresRequery: true,
        stateCode: "ind" as const,
        tooltip: "Consultando Costamar...",
        derivedRequest: buildDerivedOneWayRequest(request, departureDate),
      } satisfies MatrixCell))
    : pairs.map(({ departureDate, returnDate }) => ({
        key: `${departureDate}_${returnDate}`,
        departureDate,
        returnDate,
        stayNights: diffDays(departureDate, returnDate),
        confidence: "loading" as const,
        providerSource: "costamar" as const,
        selectable: false,
        requiresRequery: true,
        stateCode: "ind" as const,
        tooltip: "Consultando Costamar...",
        derivedRequest: buildDerivedRequest(request, departureDate, returnDate),
      } satisfies MatrixCell));

  return {
    cells,
    axes,
    confidenceSummary: buildMatrixConfidenceSummary(cells),
    recommendations: [
      "Matrix loading from Costamar with useful date combinations only.",
      "Only valid flexible combinations are materialized for Costamar.",
    ],
    searchMeta: {
      requestedAt,
      completedAt: requestedAt,
      providersUsed: ["costamar"],
      warnings: ["Matrix loading from Costamar with useful date combinations only."],
      partial: true,
      searchState: "search_partial",
    },
    providerMeta,
    warnings: ["Matrix loading from Costamar with useful date combinations only."],
  };
}

function spansExactFlexibleWindow(start?: string, end?: string): boolean {
  return Boolean(start && end && diffDays(start, end) === 6);
}

export function matchesCostamarNativeFlexibleWindow(request: SearchRequest): boolean {
  const leg = request.legs[0];
  if (request.tripType !== "round-trip") {
    return false;
  }

  return spansExactFlexibleWindow(leg.departureStart, leg.departureEnd)
    && spansExactFlexibleWindow(leg.returnStart, leg.returnEnd);
}

async function seedMatrixWithFlexibleSearch(
  request: SearchRequest,
  providerContext?: ProviderContext,
): Promise<Map<string, CanonicalOffer>> {
  if (!matchesCostamarNativeFlexibleWindow(request)) {
    return new Map();
  }

  const leg = request.legs[0];
  const seedRequest: SearchRequest = {
    ...request,
    searchMode: "exact",
    legs: [
      {
        ...leg,
        departureDate: leg.departureStart ? enumerateRange(leg.departureStart, leg.departureEnd ?? leg.departureStart)[3] : undefined,
        returnDate: leg.returnStart ? enumerateRange(leg.returnStart, leg.returnEnd ?? leg.returnStart)[3] : undefined,
      },
    ],
  };
  const search = await searchRecommendations(seedRequest, providerContext, true);
  const byKey = new Map<string, CanonicalOffer>();

  for (const offer of search.offers) {
    const outbound = offer.itineraries.find((itinerary) => itinerary.direction === "outbound") ?? offer.itineraries[0];
    const inbound = offer.itineraries.find((itinerary) => itinerary.direction === "inbound");
    const departureDate = outbound?.segments[0]?.departureAt?.slice(0, 10);
    const returnDate = inbound?.segments[0]?.departureAt?.slice(0, 10);

    if (!departureDate || !returnDate) {
      continue;
    }

    if (!isUsefulRoundTripCombination(request, departureDate, returnDate)) {
      continue;
    }

    const key = `${departureDate}_${returnDate}`;
    const existing = byKey.get(key);
    if (!existing || offer.price.total.amount < existing.price.total.amount) {
      byKey.set(key, offer);
    }
  }

  return byKey;
}

function buildMatrixCellFromOffer(
  cell: MatrixCell & { derivedRequest: SearchRequest; confidence: "loading" },
  offer: CanonicalOffer,
  providerContext?: ProviderContext,
): MatrixCell {
  return {
    ...cell,
    price: {
      amount: offer.price.total.amount,
      currencyCode: offer.price.total.currencyCode,
    },
    purchasePaths: offer.purchasePaths.length > 0
      ? offer.purchasePaths
      : providerContext?.costamar
        ? buildPurchasePaths(cell.derivedRequest, providerContext.costamar)
        : [],
    confidence: "live",
    selectable: true,
    stateCode: "live",
    tooltip: "Costamar live search.",
  };
}

async function resolveCellPrice(
  derivedRequest: SearchRequest,
  providerContext?: ProviderContext,
): Promise<CanonicalOffer | undefined> {
  const search = await searchLocalCostamarExact(derivedRequest, providerContext);
  return search.offers.reduce<CanonicalOffer | undefined>((best, current) => {
    if (!best || current.price.total.amount < best.price.total.amount) {
      return current;
    }

    return best;
  }, undefined);
}

export async function resolveLocalCostamarMatrixProgressive(
  request: SearchRequest,
  providerContext: ProviderContext | undefined,
  draft: MatrixResponse,
  onCellResolved?: (cell: MatrixCell) => void,
): Promise<MatrixResponse> {
  let partial = false;
  const seeded = await seedMatrixWithFlexibleSearch(request, providerContext).catch(() => new Map<string, CanonicalOffer>());
  const seededKeys = new Set<string>();
  const seededCells = draft.cells.map((cell) => {
    if (cell.confidence !== "loading" || !cell.derivedRequest) {
      return cell;
    }

    const seededOffer = seeded.get(cell.key);
    if (!seededOffer) {
      return cell;
    }

    seededKeys.add(cell.key);
    const nextCell = buildMatrixCellFromOffer(
      cell as MatrixCell & { derivedRequest: SearchRequest; confidence: "loading" },
      seededOffer,
      providerContext,
    );
    onCellResolved?.(nextCell);
    return nextCell;
  });

  const prioritizedCells = prioritizeMatrixLoadingCells(seededCells, draft.axes, request.tripType)
    .filter((cell) => !seededKeys.has(cell.key));
  const resolvedLoadingCells = await mapConcurrent(prioritizedCells, COSTAMAR_CONCURRENCY.matrixCell, async (cell) => {
    try {
      const offer = await resolveCellPrice(cell.derivedRequest, providerContext);
      const nextCell = offer
        ? buildMatrixCellFromOffer(cell, offer, providerContext)
        : {
            ...cell,
            confidence: "unavailable" as const,
            selectable: false,
            stateCode: "chg" as const,
            tooltip: "Costamar returned no live result for this combination.",
          } satisfies MatrixCell;
      onCellResolved?.(nextCell);
      return nextCell;
    } catch (error) {
      partial = true;
      const nextCell = {
        ...cell,
        confidence: "unavailable" as const,
        selectable: false,
        stateCode: "chg" as const,
        tooltip: error instanceof Error
          ? `Costamar error: ${error.message}`
          : "Costamar error while resolving this combination.",
      } satisfies MatrixCell;
      onCellResolved?.(nextCell);
      return nextCell;
    }
  });

  const resolvedByKey = new Map(resolvedLoadingCells.map((cell) => [cell.key, cell]));
  const resolvedCells = seededCells.map((cell) => resolvedByKey.get(cell.key) ?? cell);
  const warnings = partial
    ? ["Matrix finished with partial Costamar failures."]
    : [seeded.size > 0
        ? "Matrix seeded from Costamar native flexible search and completed with exact searches."
        : "Matrix built from Costamar exact searches over useful date combinations."];

  return {
    ...draft,
    cells: resolvedCells,
    confidenceSummary: buildMatrixConfidenceSummary(resolvedCells),
    recommendations: [
      "Matrix keeps only useful date combinations based on the requested stay window.",
      seeded.size > 0
        ? "Costamar native flexible search was used as a seed before exact lookups."
        : "Selecting a cell runs a full Costamar exact search for offers.",
    ],
    searchMeta: {
      requestedAt: draft.searchMeta.requestedAt,
      completedAt: new Date().toISOString(),
      providersUsed: ["costamar"],
      warnings,
      partial,
      searchState: partial ? "search_partial" : "search_live",
    },
    warnings,
  };
}

export async function buildLocalCostamarMatrix(
  request: SearchRequest,
  providerContext: ProviderContext | undefined,
  providerMeta: ProviderMeta,
): Promise<MatrixResponse> {
  const draft = createLocalCostamarMatrixDraft(request, providerMeta);
  return resolveLocalCostamarMatrixProgressive(request, providerContext, draft);
}

function mapLocationSuggestion(
  entry: CostamarAutocompleteAirport,
): LocationSuggestion | undefined {
  const code = entry.code?.trim().toUpperCase();
  const city = entry.cityName?.trim();
  const countryCode = entry.countryCode?.trim().toUpperCase();
  const label = entry.name?.trim();
  if (!code || !city || !countryCode || !label) {
    return undefined;
  }

  return {
    code,
    city,
    country: countryCode,
    countryCode,
    cityCode: entry.cityCode?.trim().toUpperCase(),
    searchType: entry.type?.trim(),
    label,
  };
}

export async function suggestLocalCostamarLocations(
  query: string,
  limit = 8,
): Promise<LocationSuggestion[]> {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length < 2) {
    return [];
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COSTAMAR_HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${COSTAMAR_AIR_API_BASE_URL}/autocomplete/airports/search?language=es&query=${encodeURIComponent(normalizedQuery)}`,
      {
        headers: {
          accept: "application/json, text/plain, */*",
        },
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      throw new Error(`Costamar location suggest failed: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json() as CostamarAutocompleteResponse;
    const suggestions = asArray(payload.airports)
      .map((entry) => mapLocationSuggestion(entry))
      .filter((entry): entry is LocationSuggestion => Boolean(entry));

    return suggestions.slice(0, Math.max(1, limit));
  } finally {
    clearTimeout(timeout);
  }
}
