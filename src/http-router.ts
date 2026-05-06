import { materializeSearchResponse } from "./core/orchestrator";
import { buildMatrixConfidenceSummary } from "./core/matrix";
import { buildCommercialQuotation, shouldIncludePenQuotationPrice } from "./core/quotation";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import * as path from "node:path";
import {
  CanonicalOffer,
  Itinerary,
  LocationSuggestion,
  MatrixCell,
  MatrixResponse,
  ProviderDiagnosticEvent,
  ProviderDiagnosticKind,
  ProviderDiagnostics,
  ProviderContext,
  ProviderId,
  SearchRequest,
  SearchResponse,
  Segment,
} from "./core/types";
import {
  prepareSearchContract,
  resolveSearchProviderIds,
  resolveSortMode,
  SearchPayload,
  SortMode,
  validateSearchContract,
} from "./http-search-contract";
import {
  AGIL_CONCURRENCY,
  createLocalAgilSearchDraft,
  resolveLocalAgilExactProgressive,
  createLocalAgilMatrixDraft,
  resolveLocalAgilMatrixProgressive,
  resolveLocalAgilRangeProgressive,
  suggestLocalAgilLocations,
} from "./local-agil";
import {
  COSTAMAR_CONCURRENCY,
  applyCostamarContextToBrandedSearchUrl,
  buildCostamarPurchasePaths,
  createLocalCostamarMatrixDraft,
  createLocalCostamarSearchDraft,
  resolveLocalCostamarExactProgressive,
  resolveLocalCostamarMatrixProgressive,
  resolveLocalCostamarRangeProgressive,
  suggestLocalCostamarLocations,
} from "./local-costamar";
import { openUrlLocally } from "./local-browser";
import {
  getCostamarTokenStatus,
  normalizeCostamarProviderContext,
  resolveLatestCostamarProviderContext,
  resolveProviderId,
  resolveUsableCostamarBrandedToken,
  verifyCostamarTokenLive,
} from "./provider-context";
import { resolveQuotationUsdToPenRate, resolveStandaloneUsdToPenRate } from "./quotation-exchange-rate";
import { limitSearchResponseForPagination } from "./search-limits";
import { runProviderMatrixInWorker, runProviderSearchInWorker } from "./search-worker-client";
import { collectTempArtifactDiagnostics } from "./temp-artifacts";
import { getRuntime } from "./runtime";
import { logPerfSpan, startPerfTimer } from "./perf";
import { COMPLETED_SEARCH_SESSION_TTL_MS, type SearchJobRecord } from "./session-store";
import {
  appendProviderDiagnosticEvent,
  cloneProviderDiagnostics,
  createProviderDiagnostics,
  recordProviderDiagnosticEvent,
  setProviderDiagnosticStatus,
  withProviderDiagnostics,
} from "./provider-diagnostics";

interface SessionPayload {
  searchSessionId?: string;
}

interface QuotationPayload extends SessionPayload {
  offerId?: string;
  offer?: unknown;
  request?: unknown;
}

type ResultsLayoutColumnKey =
  | "carrier"
  | "dates"
  | "duration"
  | "stops"
  | "price"
  | "links";

interface LocalOpenPayload {
  url?: string;
  preferredBrowser?: "chrome" | "default";
}

interface ResultsLayoutPayload {
  columns?: Partial<Record<ResultsLayoutColumnKey, unknown>>;
}

interface ProgressiveSearchAdapter {
  createSearchDraft(request: SearchRequest, providerMeta: { exactProvider: ProviderId; coverageMode: SearchRequest["coverageMode"] }): SearchResponse;
  resolveExactProgressive(
    request: SearchRequest,
    providerContext: ProviderContext | undefined,
    onUpdate?: (result: { offers: CanonicalOffer[]; warnings: string[]; partial: boolean }) => boolean | void,
  ): Promise<{ offers: CanonicalOffer[]; warnings: string[]; partial: boolean }>;
  resolveRangeProgressive(
    request: SearchRequest,
    providerContext: ProviderContext | undefined,
    onUpdate?: (result: { offers: CanonicalOffer[]; warnings: string[]; partial: boolean }) => boolean | void,
  ): Promise<{ offers: CanonicalOffer[]; warnings: string[]; partial: boolean }>;
  createMatrixDraft(
    request: SearchRequest,
    providerMeta: { exactProvider: ProviderId; coverageMode: SearchRequest["coverageMode"] },
  ): MatrixResponse;
  resolveMatrixProgressive(
    request: SearchRequest,
    providerContext: ProviderContext | undefined,
    draft: MatrixResponse,
    onCellResolved?: (cell: MatrixResponse["cells"][number]) => boolean | void,
  ): Promise<MatrixResponse>;
}

interface ProviderSearchState {
  offers: CanonicalOffer[];
  warnings: string[];
  partial: boolean;
  completed: boolean;
}

interface ProviderMatrixState {
  response: MatrixResponse;
  completed: boolean;
}

const PROGRESSIVE_ADAPTERS: Record<ProviderId, ProgressiveSearchAdapter> = {
  "agil-local": {
    createSearchDraft: createLocalAgilSearchDraft,
    resolveExactProgressive: (request, _providerContext, onUpdate) =>
      resolveLocalAgilExactProgressive(request, onUpdate),
    resolveRangeProgressive: (request, _providerContext, onUpdate) =>
      resolveLocalAgilRangeProgressive(request, onUpdate),
    createMatrixDraft: createLocalAgilMatrixDraft,
    resolveMatrixProgressive: (request, _providerContext, draft, onCellResolved) =>
      resolveLocalAgilMatrixProgressive(request, draft, onCellResolved),
  },
  costamar: {
    createSearchDraft: createLocalCostamarSearchDraft,
    resolveExactProgressive: (request, providerContext, onUpdate) =>
      resolveLocalCostamarExactProgressive(request, providerContext, onUpdate),
    resolveRangeProgressive: (request, providerContext, onUpdate) =>
      resolveLocalCostamarRangeProgressive(request, providerContext, onUpdate),
    createMatrixDraft: createLocalCostamarMatrixDraft,
    resolveMatrixProgressive: (request, providerContext, draft, onCellResolved) =>
      resolveLocalCostamarMatrixProgressive(request, providerContext, draft, onCellResolved),
  },
};

const RESULTS_LAYOUT_COLUMNS = [
  "carrier",
  "dates",
  "duration",
  "stops",
  "price",
  "links",
] as const satisfies readonly ResultsLayoutColumnKey[];

const SEARCH_REVALIDATION_CACHE_DEFAULT_TTL_MS = COMPLETED_SEARCH_SESSION_TTL_MS;
const SEARCH_REVALIDATION_CACHE_TTL_MS = (() => {
  const raw = Number(process.env.SEARCH_REVALIDATION_CACHE_TTL_MS ?? SEARCH_REVALIDATION_CACHE_DEFAULT_TTL_MS);
  return Number.isFinite(raw) && raw >= 0
    ? raw
    : SEARCH_REVALIDATION_CACHE_DEFAULT_TTL_MS;
})();
const SEARCH_REVALIDATION_CACHE_WARNING = "Mostrando resultados cacheados mientras actualizamos en segundo plano.";
const SEARCH_CANCELLED_WARNING = "Search cancelled by user.";
const SEARCH_REFRESH_CANCELLED_WARNING = "Search stopped because the page was refreshed.";
function readNonNegativeEnvMs(name: string, fallbackMs: number): number {
  const raw = Number(process.env[name] ?? fallbackMs);
  return Number.isFinite(raw) && raw >= 0
    ? Math.trunc(raw)
    : fallbackMs;
}

function backgroundSearchStartDelayMs(): number {
  return readNonNegativeEnvMs("FLY_DESK_BACKGROUND_SEARCH_START_DELAY_MS", 0);
}

function cachedBackgroundSearchStartDelayMs(): number {
  return readNonNegativeEnvMs("FLY_DESK_CACHED_BACKGROUND_SEARCH_START_DELAY_MS", 250);
}

const RESULTS_LAYOUT_FILE = path.resolve(__dirname, "..", "config", "results-layout.json");
const RESULTS_LAYOUT_VERSION = 1;
const RESULTS_LAYOUT_COLUMN_LIMITS: Record<ResultsLayoutColumnKey, { min: number; max: number }> = {
  carrier: { min: 88, max: 320 },
  dates: { min: 112, max: 260 },
  duration: { min: 92, max: 240 },
  stops: { min: 96, max: 300 },
  price: { min: 112, max: 360 },
  links: { min: 40, max: 84 },
};

function shouldRunBackgroundSearchJobs(): boolean {
  return process.env.FLY_DESK_DISABLE_BACKGROUND_SEARCH_JOBS !== "1";
}

function scheduleBackgroundSearchJob(callback: () => void, delayMs: number): void {
  const timer = setTimeout(callback, delayMs);
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}

function providerDiagnosticKindForRequest(request: SearchRequest): ProviderDiagnosticKind {
  return request.searchMode === "stay-range" ? "range" : "exact";
}

function providerConcurrencyDetail(providerId: ProviderId, kind: ProviderDiagnosticKind): string {
  if (providerId === "agil-local") {
    if (kind === "matrix") {
      return `workerProcesses=${shouldUseSearchWorkerProcesses() ? 1 : 0} matrixCellConcurrency=${AGIL_CONCURRENCY.matrixCell}`;
    }

    if (kind === "range") {
      return `workerProcesses=${shouldUseSearchWorkerProcesses() ? 1 : 0} rangeConcurrency=${AGIL_CONCURRENCY.rangeSearch} gdsConcurrency=${AGIL_CONCURRENCY.gdsSearch}`;
    }

    return `workerProcesses=${shouldUseSearchWorkerProcesses() ? 1 : 0} gdsConcurrency=${AGIL_CONCURRENCY.gdsSearch}`;
  }

  if (kind === "matrix") {
    return `workerProcesses=${shouldUseSearchWorkerProcesses() ? 1 : 0} matrixCellConcurrency=${COSTAMAR_CONCURRENCY.matrixCell}`;
  }

  if (kind === "range") {
    return `workerProcesses=${shouldUseSearchWorkerProcesses() ? 1 : 0} rangeConcurrency=${COSTAMAR_CONCURRENCY.rangeSearch} markupConcurrency=${COSTAMAR_CONCURRENCY.markup}`;
  }

  return `workerProcesses=${shouldUseSearchWorkerProcesses() ? 1 : 0} markupConcurrency=${COSTAMAR_CONCURRENCY.markup}`;
}

function createProviderDiagnosticsForRun(
  providerIds: ProviderId[],
  kind: ProviderDiagnosticKind,
): ProviderDiagnostics[] {
  return providerIds.map((providerId) => createProviderDiagnostics(
    providerId,
    kind,
    providerConcurrencyDetail(providerId, kind),
  ));
}

function cloneProviderDiagnosticsList(entries: ProviderDiagnostics[] | undefined): ProviderDiagnostics[] {
  return (entries ?? []).map(cloneProviderDiagnostics);
}

function updateProviderDiagnosticsEntry(
  entries: ProviderDiagnostics[] | undefined,
  providerId: ProviderId,
  update: (entry: ProviderDiagnostics) => void,
): ProviderDiagnostics[] {
  return cloneProviderDiagnosticsList(entries).map((entry) => {
    if (entry.providerId !== providerId) {
      return entry;
    }

    update(entry);
    return entry;
  });
}

function applyProviderDiagnosticEvent(
  entries: ProviderDiagnostics[] | undefined,
  providerId: ProviderId,
  event: ProviderDiagnosticEvent | string,
  status: ProviderDiagnostics["status"] = "running",
): ProviderDiagnostics[] {
  return updateProviderDiagnosticsEntry(entries, providerId, (entry) => {
    const name = typeof event === "string" ? event : event.name;
    const detail = typeof event === "string" ? undefined : event.detail;
    appendProviderDiagnosticEvent(entry, name, detail);
    setProviderDiagnosticStatus(entry, status);
  });
}

function applyProviderDiagnosticSummary(
  entries: ProviderDiagnostics[] | undefined,
  providerId: ProviderId,
  status: ProviderDiagnostics["status"],
  summary: Pick<ProviderDiagnostics, "offers" | "warningCount" | "error">,
): ProviderDiagnostics[] {
  return updateProviderDiagnosticsEntry(entries, providerId, (entry) => {
    setProviderDiagnosticStatus(entry, status, summary);
  });
}

function quotationObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function quotationStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function quotationNumberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function quotationBoolValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function quotationStringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
}

function normalizeProviderSource(value: unknown): ProviderId {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized.includes("costamar") ? "costamar" : "agil-local";
}

function normalizeTripType(value: unknown): SearchRequest["tripType"] {
  return value === "one-way" || value === "multi-city" ? value : "round-trip";
}

function normalizeSearchMode(value: unknown): SearchRequest["searchMode"] {
  return value === "stay-range" || value === "roundtrip-grid" || value === "month-view"
    ? value
    : "exact";
}

function normalizeCabin(value: unknown): SearchRequest["cabin"] {
  return value === "PREMIUM_ECONOMY" || value === "BUSINESS" || value === "FIRST"
    ? value
    : "ECONOMY";
}

function normalizeQuotationRequestSnapshot(input: unknown, offerInput?: unknown): SearchRequest | undefined {
  const payload = quotationObjectRecord(input);
  const offer = quotationObjectRecord(offerInput);
  const rawLegs = Array.isArray(payload?.legs) ? payload.legs : [];
  const rawLeg = quotationObjectRecord(rawLegs[0]) ?? {};
  const origin = quotationStringValue(rawLeg.origin) ?? quotationStringValue(offer?.origin);
  const destination = quotationStringValue(rawLeg.destination) ?? quotationStringValue(offer?.destination);

  if (!origin || !destination) {
    return undefined;
  }

  const rawPassengers = quotationObjectRecord(payload?.passengers);
  const rawFilters = quotationObjectRecord(payload?.filters);
  const tripType = normalizeTripType(payload?.tripType);

  return {
    providerId: payload?.providerId ? normalizeProviderSource(payload.providerId) : undefined,
    tripType,
    searchMode: normalizeSearchMode(payload?.searchMode),
    flexibleMode: payload?.flexibleMode === "exact-stay" || payload?.flexibleMode === "fixed-ranges"
      ? payload.flexibleMode
      : undefined,
    legs: [
      {
        origin,
        destination,
        originLabel: quotationStringValue(rawLeg.originLabel),
        destinationLabel: quotationStringValue(rawLeg.destinationLabel),
        departureDate: quotationStringValue(rawLeg.departureDate) ?? quotationStringValue(offer?.departureDate)?.slice(0, 10),
        departureStart: quotationStringValue(rawLeg.departureStart),
        departureEnd: quotationStringValue(rawLeg.departureEnd),
        returnDate: tripType === "round-trip"
          ? quotationStringValue(rawLeg.returnDate) ?? quotationStringValue(offer?.returnDate)?.slice(0, 10)
          : undefined,
        returnStart: quotationStringValue(rawLeg.returnStart),
        returnEnd: quotationStringValue(rawLeg.returnEnd),
        stayNights: quotationNumberValue(rawLeg.stayNights),
        minNights: quotationNumberValue(rawLeg.minNights),
        maxNights: quotationNumberValue(rawLeg.maxNights),
      },
    ],
    passengers: {
      adults: Math.max(1, Math.round(quotationNumberValue(rawPassengers?.adults) ?? 1)),
      children: Math.max(0, Math.round(quotationNumberValue(rawPassengers?.children) ?? 0)),
      infants: Math.max(0, Math.round(quotationNumberValue(rawPassengers?.infants) ?? 0)),
    },
    cabin: normalizeCabin(payload?.cabin),
    filters: {
      nonStop: quotationBoolValue(rawFilters?.nonStop),
      maxStops: quotationNumberValue(rawFilters?.maxStops),
      includedAirlineCodes: quotationStringArrayValue(rawFilters?.includedAirlineCodes),
      excludedAirlineCodes: quotationStringArrayValue(rawFilters?.excludedAirlineCodes),
      maxPrice: quotationNumberValue(rawFilters?.maxPrice),
      currencyCode: quotationStringValue(rawFilters?.currencyCode),
      maxResults: quotationNumberValue(rawFilters?.maxResults),
      compactAllOffers: quotationBoolValue(rawFilters?.compactAllOffers),
      maxTotalDurationMinutes: quotationNumberValue(rawFilters?.maxTotalDurationMinutes),
      maxLayoverMinutes: quotationNumberValue(rawFilters?.maxLayoverMinutes),
      minDepartureMinutes: quotationNumberValue(rawFilters?.minDepartureMinutes),
      maxDepartureMinutes: quotationNumberValue(rawFilters?.maxDepartureMinutes),
      minArrivalMinutes: quotationNumberValue(rawFilters?.minArrivalMinutes),
      maxArrivalMinutes: quotationNumberValue(rawFilters?.maxArrivalMinutes),
      baggageRequired: quotationBoolValue(rawFilters?.baggageRequired),
      verifiedOnly: quotationBoolValue(rawFilters?.verifiedOnly),
      exactPurchasePathOnly: quotationBoolValue(rawFilters?.exactPurchasePathOnly),
    },
    coverageMode: payload?.coverageMode === "extended" ? "extended" : "core",
    redirectMode: payload?.redirectMode === "strict" || payload?.redirectMode === "best-effort"
      ? payload.redirectMode
      : "none",
    currencyCode: quotationStringValue(payload?.currencyCode) ?? "USD",
    locale: quotationStringValue(payload?.locale) ?? "es-PE",
    market: quotationStringValue(payload?.market) ?? "PE",
  };
}

function normalizeQuotationSegment(input: unknown, fallback: {
  direction: "outbound" | "inbound";
  origin: string;
  destination: string;
  departureAt?: string;
}): Segment {
  const raw = quotationObjectRecord(input) ?? {};
  const origin = quotationStringValue(raw.origin) ?? fallback.origin;
  const destination = quotationStringValue(raw.destination) ?? fallback.destination;
  const departureAt = quotationStringValue(raw.departureAt) ?? fallback.departureAt ?? "";
  const arrivalAt = quotationStringValue(raw.arrivalAt) ?? departureAt;

  return {
    id: quotationStringValue(raw.id) ?? `${fallback.direction}-segment`,
    marketingCarrier: quotationStringValue(raw.marketingCarrier) ?? "",
    marketingCarrierName: quotationStringValue(raw.marketingCarrierName),
    operatingCarrier: quotationStringValue(raw.operatingCarrier),
    operatingCarrierName: quotationStringValue(raw.operatingCarrierName),
    flightNumber: quotationStringValue(raw.flightNumber) ?? "",
    origin,
    originName: quotationStringValue(raw.originName),
    destination,
    destinationName: quotationStringValue(raw.destinationName),
    departureAt,
    arrivalAt,
    durationMinutes: Math.max(0, Math.round(quotationNumberValue(raw.durationMinutes) ?? 0)),
    originTerminal: quotationStringValue(raw.originTerminal),
    destinationTerminal: quotationStringValue(raw.destinationTerminal),
  };
}

function normalizeQuotationItineraries(input: unknown, request: SearchRequest, offer: Record<string, unknown>): Itinerary[] {
  const leg = request.legs[0];
  const rawItineraries = Array.isArray(input) ? input : [];
  const normalized = rawItineraries.flatMap((item, index): Itinerary[] => {
    const raw = quotationObjectRecord(item);
    if (!raw) {
      return [];
    }

    const direction = raw.direction === "inbound" || raw.direction === "multi" ? raw.direction : "outbound";
    const rawSegments = Array.isArray(raw.segments) ? raw.segments : [];
    const fallback = {
      direction: direction === "inbound" ? "inbound" as const : "outbound" as const,
      origin: direction === "inbound" ? leg.destination : leg.origin,
      destination: direction === "inbound" ? leg.origin : leg.destination,
      departureAt: direction === "inbound"
        ? quotationStringValue(offer.returnDate) ?? leg.returnDate
        : quotationStringValue(offer.departureDate) ?? leg.departureDate,
    };
    const segments = rawSegments.length > 0
      ? rawSegments.map((segment) => normalizeQuotationSegment(segment, fallback))
      : [normalizeQuotationSegment(undefined, fallback)];

    return [{
      id: quotationStringValue(raw.id) ?? `itinerary-${index}`,
      direction,
      durationMinutes: Math.max(0, Math.round(quotationNumberValue(raw.durationMinutes) ?? 0)),
      stops: Math.max(0, Math.round(quotationNumberValue(raw.stops) ?? Math.max(0, segments.length - 1))),
      layoverMinutes: Array.isArray(raw.layoverMinutes)
        ? raw.layoverMinutes.map((value) => Math.max(0, Math.round(quotationNumberValue(value) ?? 0)))
        : [],
      segments,
    }];
  });

  if (normalized.length > 0) {
    return normalized;
  }

  const outboundDeparture = quotationStringValue(offer.departureDate) ?? leg.departureDate ?? leg.departureStart ?? "";
  const outbound = normalizeQuotationSegment(undefined, {
    direction: "outbound",
    origin: leg.origin,
    destination: leg.destination,
    departureAt: outboundDeparture,
  });
  const itineraries: Itinerary[] = [{
    id: "outbound",
    direction: "outbound",
    durationMinutes: 0,
    stops: 0,
    layoverMinutes: [],
    segments: [outbound],
  }];

  const returnDeparture = quotationStringValue(offer.returnDate) ?? leg.returnDate ?? leg.returnStart;
  if (request.tripType === "round-trip" && returnDeparture) {
    const inbound = normalizeQuotationSegment(undefined, {
      direction: "inbound",
      origin: leg.destination,
      destination: leg.origin,
      departureAt: returnDeparture,
    });
    itineraries.push({
      id: "inbound",
      direction: "inbound",
      durationMinutes: 0,
      stops: 0,
      layoverMinutes: [],
      segments: [inbound],
    });
  }

  return itineraries;
}

function normalizeQuotationOfferSnapshot(input: unknown, request: SearchRequest): CanonicalOffer | undefined {
  const offer = quotationObjectRecord(input);
  if (!offer) {
    return undefined;
  }

  const rawPrice = quotationObjectRecord(offer.price);
  const rawTotal = quotationObjectRecord(rawPrice?.total) ?? rawPrice;
  const amount = quotationNumberValue(rawTotal?.amount);
  if (amount === undefined) {
    return undefined;
  }

  const providerSource = normalizeProviderSource(offer.providerSource);
  const mainCarrier = quotationStringValue(offer.mainCarrier)
    ?? quotationStringValue(offer.validatingCarrier)
    ?? quotationStringValue(offer.airline)
    ?? "";
  const itineraries = normalizeQuotationItineraries(offer.itineraries, request, offer);
  const rawBaggage = quotationObjectRecord(offer.baggage);
  const rawFareMeta = quotationObjectRecord(offer.fareMeta);
  const rawMetrics = quotationObjectRecord(offer.comparisonMetrics);
  const totalStops = quotationNumberValue(rawMetrics?.totalStops) ?? quotationNumberValue(offer.stops) ?? 0;

  return {
    id: quotationStringValue(offer.sourceOfferId) ?? quotationStringValue(offer.id) ?? "selected-offer",
    signature: quotationStringValue(offer.signature) ?? quotationStringValue(offer.id) ?? "selected-offer",
    providerSource,
    providerOfferRef: quotationStringValue(offer.providerOfferRef) ?? quotationStringValue(offer.id) ?? "selected-offer",
    tripType: request.tripType,
    validatingCarrier: quotationStringValue(offer.validatingCarrier) ?? mainCarrier,
    mainCarrier,
    origin: quotationStringValue(offer.origin) ?? request.legs[0].origin,
    destination: quotationStringValue(offer.destination) ?? request.legs[0].destination,
    itineraries,
    price: {
      total: {
        amount,
        currencyCode: quotationStringValue(rawTotal?.currencyCode) ?? request.currencyCode ?? "USD",
      },
      base: quotationObjectRecord(rawPrice?.base)
        ? {
            amount: quotationNumberValue(quotationObjectRecord(rawPrice?.base)?.amount) ?? amount,
            currencyCode: quotationStringValue(quotationObjectRecord(rawPrice?.base)?.currencyCode) ?? quotationStringValue(rawTotal?.currencyCode) ?? "USD",
          }
        : undefined,
      taxes: quotationObjectRecord(rawPrice?.taxes)
        ? {
            amount: quotationNumberValue(quotationObjectRecord(rawPrice?.taxes)?.amount) ?? 0,
            currencyCode: quotationStringValue(quotationObjectRecord(rawPrice?.taxes)?.currencyCode) ?? quotationStringValue(rawTotal?.currencyCode) ?? "USD",
          }
        : undefined,
    },
    usdToPenRate: quotationNumberValue(offer.usdToPenRate),
    baggage: rawBaggage
      ? {
          carryOnIncluded: quotationBoolValue(rawBaggage.carryOnIncluded),
          checkedIncluded: quotationBoolValue(rawBaggage.checkedIncluded),
          checkedBags: quotationNumberValue(rawBaggage.checkedBags),
          description: quotationStringValue(rawBaggage.description),
        }
      : undefined,
    fareMeta: rawFareMeta
      ? {
          lastTicketingDate: quotationStringValue(rawFareMeta.lastTicketingDate),
          seatsRemaining: quotationNumberValue(rawFareMeta.seatsRemaining),
          refundable: quotationBoolValue(rawFareMeta.refundable),
          changeable: quotationBoolValue(rawFareMeta.changeable),
          co2Kg: quotationNumberValue(rawFareMeta.co2Kg),
        }
      : undefined,
    priceConfidence: offer.priceConfidence === "indicative"
      || offer.priceConfidence === "validated"
      || offer.priceConfidence === "landing-page"
      || offer.priceConfidence === "stale"
      ? offer.priceConfidence
      : "live",
    priceStatus: offer.priceStatus === "verified" || offer.priceStatus === "stale" ? offer.priceStatus : "unverified",
    priceVerifiedAt: quotationStringValue(offer.priceVerifiedAt),
    purchasePaths: [],
    comparisonMetrics: {
      totalDurationMinutes: Math.max(0, Math.round(quotationNumberValue(rawMetrics?.totalDurationMinutes) ?? 0)),
      totalStops: Math.max(0, Math.round(totalStops)),
      baggageScore: Math.max(0, Math.round(quotationNumberValue(rawMetrics?.baggageScore) ?? 0)),
      purchasePathScore: Math.max(0, Math.round(quotationNumberValue(rawMetrics?.purchasePathScore) ?? 0)),
    },
    tags: quotationStringArrayValue(offer.tags),
    warnings: quotationStringArrayValue(offer.warnings),
    rawRefs: quotationObjectRecord(offer.rawRefs),
    valueScore: quotationNumberValue(offer.valueScore) ?? 0,
  };
}

function normalizeResultsLayoutColumns(
  input: Partial<Record<ResultsLayoutColumnKey, unknown>> | undefined,
): Record<ResultsLayoutColumnKey, number> | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const columns = {} as Record<ResultsLayoutColumnKey, number>;

  for (const key of RESULTS_LAYOUT_COLUMNS) {
    const raw = input[key];
    const numeric = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(numeric)) {
      continue;
    }
    const limits = RESULTS_LAYOUT_COLUMN_LIMITS[key];

    columns[key] = Math.max(
      limits.min,
      Math.min(limits.max, Math.round(numeric)),
    );
  }

  return Object.keys(columns).length === RESULTS_LAYOUT_COLUMNS.length
    ? columns
    : undefined;
}

async function readResultsLayoutFile(): Promise<{
  version: number;
  savedAt: string;
  columns: Record<ResultsLayoutColumnKey, number>;
} | null> {
  try {
    const raw = await readFile(RESULTS_LAYOUT_FILE, "utf8");
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      savedAt?: unknown;
      columns?: Partial<Record<ResultsLayoutColumnKey, unknown>>;
    };
    const columns = normalizeResultsLayoutColumns(parsed?.columns);
    if (!columns) {
      return null;
    }

    return {
      version: RESULTS_LAYOUT_VERSION,
      savedAt: typeof parsed?.savedAt === "string" ? parsed.savedAt : "",
      columns,
    };
  } catch {
    return null;
  }
}

async function writeResultsLayoutFile(
  columns: Record<ResultsLayoutColumnKey, number>,
): Promise<{
  version: number;
  savedAt: string;
  columns: Record<ResultsLayoutColumnKey, number>;
}> {
  const payload = {
    version: RESULTS_LAYOUT_VERSION,
    savedAt: new Date().toISOString(),
    columns,
  };

  await mkdir(path.dirname(RESULTS_LAYOUT_FILE), { recursive: true });
  await writeFile(RESULTS_LAYOUT_FILE, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

function html(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    status: init?.status ?? 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

function costamarRedirectBlockedResponse(): Response {
  return html(`<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Renueva la sesion de Costamar</title>
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        font-family: "Segoe UI", Arial, sans-serif;
        background: linear-gradient(160deg, #f8f0e2, #fffaf1);
        color: #2d2a26;
      }
      main {
        max-width: 560px;
        margin: 0 auto;
        min-height: 100vh;
        display: grid;
        align-content: center;
        gap: 16px;
        padding: 32px 20px;
      }
      section {
        background: rgba(255, 255, 255, 0.92);
        border: 1px solid rgba(112, 77, 31, 0.12);
        border-radius: 20px;
        padding: 24px;
        box-shadow: 0 20px 45px rgba(88, 59, 24, 0.08);
      }
      h1 {
        margin: 0 0 12px;
        font-size: 28px;
        line-height: 1.15;
      }
      p {
        margin: 0 0 12px;
        line-height: 1.55;
      }
      p:last-child {
        margin-bottom: 0;
      }
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>Renueva la sesion de Costamar</h1>
        <p>Fly Desk no encontro un token vigente para abrir esta busqueda en Costamar.</p>
        <p>Abre Costamar en Chrome, confirma que la sesion este activa y vuelve a intentar desde Fly Desk.</p>
      </section>
    </main>
  </body>
</html>`, {
    status: 409,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function stringValue(input: unknown, fallback = ""): string {
  return typeof input === "string" ? input.trim() : fallback;
}

function integerParam(input: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function createSearchDraftResponse(
  request: SearchRequest,
  providerIds: ProviderId[],
): SearchResponse {
  const requestedAt = new Date().toISOString();
  const warning = providerIds.length > 1
    ? "Consultando Agil y Costamar. Los resultados se iran agregando."
    : providerIds[0] === "costamar"
      ? "Consultando Costamar. Los resultados se iran agregando."
      : "Consultando Agil. Los resultados se iran agregando.";

  return {
    offers: [],
    allOffers: [],
    searchMeta: {
      requestedAt,
      completedAt: requestedAt,
      providersUsed: providerIds,
      warnings: [warning],
      partial: true,
      searchState: "search_partial",
    },
    providerMeta: {
      exactProvider: providerIds[0],
      coverageMode: request.coverageMode,
    },
    warnings: [warning],
  };
}

function aggregateProviderSearchStates(
  providerIds: ProviderId[],
  states: Map<ProviderId, ProviderSearchState>,
): { offers: CanonicalOffer[]; warnings: string[]; partial: boolean } {
  return {
    offers: providerIds.flatMap((providerId) => states.get(providerId)?.offers ?? []),
    warnings: [...new Set(providerIds.flatMap((providerId) => states.get(providerId)?.warnings ?? []))],
    partial: providerIds.some((providerId) => {
      const state = states.get(providerId);
      return !state?.completed || state.partial;
    }),
  };
}

function materializeAggregatedSearchResponse(
  request: SearchRequest,
  sortMode: SortMode,
  providerIds: ProviderId[],
  states: Map<ProviderId, ProviderSearchState>,
): SearchResponse {
  const aggregated = aggregateProviderSearchStates(providerIds, states);
  const materialized = materializeSearchResponse(
    request,
    sortMode,
    providerIds[0],
    aggregated,
  );

  materialized.searchMeta.providersUsed = providerIds;
  materialized.searchMeta.warnings = aggregated.warnings;
  materialized.searchMeta.partial = aggregated.partial;
  materialized.searchMeta.searchState = aggregated.partial ? "search_partial" : "search_live";
  materialized.providerMeta = {
    exactProvider: providerIds[0],
    coverageMode: request.coverageMode,
  };
  materialized.warnings = aggregated.warnings;

  return materialized;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function matrixCellStateRank(cell?: MatrixCell): number {
  switch (cell?.confidence) {
    case "validated":
      return 0;
    case "live":
      return 1;
    case "indicative":
      return 2;
    case "loading":
      return 3;
    case "unavailable":
      return 4;
    case "empty":
      return 5;
    default:
      return 6;
  }
}

function compareAggregatedMatrixCells(
  left: MatrixCell,
  right: MatrixCell,
  providerIds: ProviderId[],
): number {
  const leftHasPrice = typeof left.price?.amount === "number";
  const rightHasPrice = typeof right.price?.amount === "number";

  if (leftHasPrice && rightHasPrice) {
    const priceDiff = (left.price?.amount ?? Number.POSITIVE_INFINITY)
      - (right.price?.amount ?? Number.POSITIVE_INFINITY);
    if (priceDiff !== 0) {
      return priceDiff;
    }
  } else if (leftHasPrice !== rightHasPrice) {
    return leftHasPrice ? -1 : 1;
  }

  const stateDiff = matrixCellStateRank(left) - matrixCellStateRank(right);
  if (stateDiff !== 0) {
    return stateDiff;
  }

  return providerIds.indexOf(left.providerSource) - providerIds.indexOf(right.providerSource);
}

function pickAggregatedMatrixCell(
  cells: MatrixCell[],
  providerIds: ProviderId[],
): MatrixCell | undefined {
  if (cells.length === 0) {
    return undefined;
  }

  return [...cells].sort((left, right) => compareAggregatedMatrixCells(left, right, providerIds))[0];
}

function materializeAggregatedMatrixResponse(
  request: SearchRequest,
  providerIds: ProviderId[],
  states: Map<ProviderId, ProviderMatrixState>,
): MatrixResponse {
  const orderedKeys: string[] = [];
  const seenKeys = new Set<string>();

  providerIds.forEach((providerId) => {
    const response = states.get(providerId)?.response;
    response?.cells.forEach((cell) => {
      if (!seenKeys.has(cell.key)) {
        seenKeys.add(cell.key);
        orderedKeys.push(cell.key);
      }
    });
  });

  const cells = orderedKeys.flatMap((key) => {
    const candidates = providerIds
      .map((providerId) => states.get(providerId)?.response.cells.find((cell) => cell.key === key))
      .filter((cell): cell is MatrixCell => Boolean(cell));
    const selected = pickAggregatedMatrixCell(candidates, providerIds);
    return selected ? [selected] : [];
  });

  const departureDates: string[] = [];
  const seenDepartureDates = new Set<string>();
  const returnDates: string[] = [];
  const seenReturnDates = new Set<string>();

  providerIds.forEach((providerId) => {
    const response = states.get(providerId)?.response;
    response?.axes.departureDates.forEach((date) => {
      if (!seenDepartureDates.has(date)) {
        seenDepartureDates.add(date);
        departureDates.push(date);
      }
    });
    response?.axes.returnDates.forEach((date) => {
      if (!seenReturnDates.has(date)) {
        seenReturnDates.add(date);
        returnDates.push(date);
      }
    });
  });

  const warnings = uniqueStrings(providerIds.flatMap((providerId) => {
    const response = states.get(providerId)?.response;
    return [
      ...(response?.warnings ?? []),
      ...(response?.searchMeta.warnings ?? []),
    ];
  }));
  const recommendations = uniqueStrings(providerIds.flatMap((providerId) =>
    states.get(providerId)?.response.recommendations ?? [],
  ));
  const partial = providerIds.some((providerId) => {
    const state = states.get(providerId);
    return !state?.completed || state.response.searchMeta.partial;
  });

  return {
    cells,
    axes: {
      departureDates,
      returnDates,
    },
    confidenceSummary: buildMatrixConfidenceSummary(cells),
    recommendations,
    searchMeta: {
      requestedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      providersUsed: providerIds,
      warnings,
      partial,
      searchState: partial ? "search_partial" : "search_live",
    },
    providerMeta: {
      exactProvider: providerIds[0],
      coverageMode: request.coverageMode,
    },
    warnings,
  };
}

function updateMatrixDraftCell(response: MatrixResponse, cell: MatrixCell): MatrixResponse {
  const cells = response.cells.map((entry) => entry.key === cell.key ? cell : entry);
  return {
    ...response,
    cells,
    confidenceSummary: buildMatrixConfidenceSummary(cells),
  };
}

function materializeFailedMatrixResponse(
  response: MatrixResponse,
  message: string,
): MatrixResponse {
  const cells = response.cells.map((cell) => {
    if (cell.confidence !== "loading") {
      return cell;
    }

    return {
      ...cell,
      confidence: "unavailable" as const,
      selectable: false,
      stateCode: "chg" as const,
      tooltip: message,
    };
  });
  const warnings = uniqueStrings([
    ...response.warnings,
    message,
  ]);

  return {
    ...response,
    cells,
    confidenceSummary: buildMatrixConfidenceSummary(cells),
    searchMeta: {
      ...response.searchMeta,
      completedAt: new Date().toISOString(),
      warnings,
      partial: true,
      searchState: "search_partial",
    },
    warnings,
  };
}

function getProgressiveAdapter(providerId: ProviderId): ProgressiveSearchAdapter {
  return PROGRESSIVE_ADAPTERS[providerId];
}

function shouldUseSearchWorkerProcesses(): boolean {
  return process.env.FLY_DESK_SEARCH_WORKER_PROCESSES !== "0";
}

async function resolveProviderSearchProgressive(
  providerId: ProviderId,
  request: SearchRequest,
  providerContext: ProviderContext | undefined,
  onProgress: (result: { offers: CanonicalOffer[]; warnings: string[]; partial: boolean }) => boolean | void,
  diagnostics: ProviderDiagnostics | undefined,
  onProviderEvent: ((event: ProviderDiagnosticEvent) => void) | undefined,
): Promise<{ offers: CanonicalOffer[]; warnings: string[]; partial: boolean }> {
  const kind = request.searchMode === "stay-range" ? "range" : "exact";
  if (shouldUseSearchWorkerProcesses()) {
    return runProviderSearchInWorker({
      kind,
      providerId,
      request,
      providerContext,
      onProgress,
      onProviderEvent,
    });
  }

  const adapter = getProgressiveAdapter(providerId);
  const run = async () => {
    recordProviderDiagnosticEvent("provider_started");
    return kind === "range"
      ? adapter.resolveRangeProgressive(request, providerContext, onProgress)
      : adapter.resolveExactProgressive(request, providerContext, onProgress);
  };

  return diagnostics
    ? withProviderDiagnostics(diagnostics, onProviderEvent, run)
    : run();
}

async function resolveProviderMatrixProgressive(
  providerId: ProviderId,
  request: SearchRequest,
  providerContext: ProviderContext | undefined,
  draft: MatrixResponse,
  onCellResolved: (cell: MatrixResponse["cells"][number]) => boolean | void,
  diagnostics: ProviderDiagnostics | undefined,
  onProviderEvent: ((event: ProviderDiagnosticEvent) => void) | undefined,
): Promise<MatrixResponse> {
  if (shouldUseSearchWorkerProcesses()) {
    return runProviderMatrixInWorker({
      providerId,
      request,
      providerContext,
      draft,
      onCellResolved,
      onProviderEvent,
    });
  }

  const run = async () => {
    recordProviderDiagnosticEvent("provider_started");
    return getProgressiveAdapter(providerId).resolveMatrixProgressive(
      request,
      providerContext,
      draft,
      onCellResolved,
    );
  };

  return diagnostics
    ? withProviderDiagnostics(diagnostics, onProviderEvent, run)
    : run();
}

async function suggestLocationsForProvider(
  runtime: ReturnType<typeof getRuntime>,
  sessionId: string | undefined,
  providerId: ProviderId,
  query: string,
  limit: number,
): Promise<Awaited<ReturnType<typeof suggestLocalAgilLocations>>> {
  return runtime.locationSuggestions.getOrLoad(sessionId, providerId, query, limit, async () => {
    const provider = runtime.orchestrator.getProvider(providerId);
    if (provider?.suggestLocations) {
      return provider.suggestLocations(query, limit);
    }

    return providerId === "costamar"
      ? suggestLocalCostamarLocations(query, limit)
      : suggestLocalAgilLocations(query, limit);
  });
}

function mergeLocationSuggestions(
  groups: ReadonlyArray<ReadonlyArray<LocationSuggestion>>,
  limit: number,
): LocationSuggestion[] {
  const deduped = new Map<string, LocationSuggestion>();

  for (const group of groups) {
    for (const suggestion of group) {
      const key = String(suggestion.code || suggestion.label || "")
        .trim()
        .toUpperCase();
      if (!key || deduped.has(key)) {
        continue;
      }
      deduped.set(key, suggestion);
      if (deduped.size >= limit) {
        return [...deduped.values()];
      }
    }
  }

  return [...deduped.values()];
}

function isTrustedLocalRequest(request: Request): boolean {
  return request.headers.get("x-flydesk-client-loopback") === "1";
}

function resolveConfiguredApiAccessToken(): string | undefined {
  const configured = String(process.env.FLY_DESK_API_TOKEN ?? "").trim();
  return configured || undefined;
}

function resolveProvidedApiAccessToken(request: Request): string | undefined {
  const tokenHeader = String(request.headers.get("x-flydesk-api-token") ?? "").trim();
  if (tokenHeader) {
    return tokenHeader;
  }

  const authorizationHeader = String(request.headers.get("authorization") ?? "").trim();
  if (authorizationHeader.toLowerCase().startsWith("bearer ")) {
    const bearer = authorizationHeader.slice("bearer ".length).trim();
    return bearer || undefined;
  }

  return undefined;
}

function hasValidApiAccessToken(request: Request, expectedToken: string): boolean {
  const providedToken = resolveProvidedApiAccessToken(request);
  if (!providedToken) {
    return false;
  }

  const expected = Buffer.from(expectedToken, "utf8");
  const provided = Buffer.from(providedToken, "utf8");
  if (expected.length !== provided.length) {
    return false;
  }

  return timingSafeEqual(expected, provided);
}

function isTrustedApiRequest(request: Request): boolean {
  if (isTrustedLocalRequest(request)) {
    return true;
  }

  const token = resolveConfiguredApiAccessToken();
  return token ? hasValidApiAccessToken(request, token) : false;
}

function apiAuthRequiredResponse(): Response {
  return json(
    { error: "This endpoint requires localhost access or a valid API token." },
    { status: 403 },
  );
}

function validateLocalOpenUrl(input: string): URL | undefined {
  try {
    const candidate = new URL(input);
    const allowedHosts = new Set([
      "www.agilsmart.com",
      "agilsmart.com",
    ]);

    if (candidate.protocol !== "https:" || !allowedHosts.has(candidate.hostname.toLowerCase())) {
      return undefined;
    }

    return candidate;
  } catch {
    return undefined;
  }
}

async function readPayload<T>(request: Request): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return {} as T;
  }

  return request.json() as Promise<T>;
}

function parseSinceRevision(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function resolveLocationSuggestionSessionId(value: string | null): string | undefined {
  const normalized = stringValue(value).slice(0, 96);
  return normalized || undefined;
}

function matrixJobResponse(
  job: ReturnType<typeof getRuntime>["sessions"] extends { getMatrixJob(jobId: string): infer T } ? NonNullable<T> : never,
  sinceRevision?: number,
) {
  const unchanged = typeof sinceRevision === "number" && sinceRevision >= job.revision;
  const base = {
    matrixJobId: job.id,
    matrixComplete: job.status === "completed" || job.status === "failed" || job.status === "cancelled",
    matrixStatus: job.status,
    revision: job.revision,
    request: job.request,
    searchMeta: job.searchMeta,
    providerMeta: job.providerMeta,
    warnings: job.warnings,
    providerDiagnostics: job.providerDiagnostics,
    error: job.error,
    unchanged,
  };

  if (unchanged) {
    return base;
  }

  return {
    ...base,
    cells: job.cells,
    axes: job.axes,
    confidenceSummary: job.confidenceSummary,
    recommendations: job.recommendations,
  };
}

function createCachedSearchDraftResponse(
  request: SearchRequest,
  providerIds: ProviderId[],
  cachedJob: SearchJobRecord,
): SearchResponse {
  const now = new Date().toISOString();
  const warnings = uniqueStrings([
    ...cachedJob.searchMeta.warnings,
    ...cachedJob.warnings,
    SEARCH_REVALIDATION_CACHE_WARNING,
  ]);

  return {
    offers: cachedJob.offers,
    allOffers: cachedJob.allOffers,
    searchMeta: {
      requestedAt: now,
      completedAt: now,
      providersUsed: providerIds,
      warnings,
      partial: true,
      searchState: "search_cached",
    },
    providerMeta: {
      exactProvider: providerIds[0],
      coverageMode: request.coverageMode,
    },
    warnings,
  };
}

function recoverCachedCostamarPurchasePaths(
  cachedJob: SearchJobRecord | undefined,
  providerContext: ProviderContext | undefined,
): SearchJobRecord | undefined {
  const costamarContext = providerContext?.costamar ?? cachedJob?.providerContext?.costamar;
  if (!cachedJob || !costamarContext) {
    return cachedJob;
  }

  const repairOffer = (offer: CanonicalOffer): CanonicalOffer => {
    if (offer.providerSource !== "costamar") {
      return offer;
    }

    const existingPaths = offer.purchasePaths ?? [];
    if (existingPaths.some((path) => path.provider === "costamar" && typeof path.url === "string" && path.url.trim())) {
      return offer;
    }

    return {
      ...offer,
      purchasePaths: [
        ...existingPaths,
        ...buildCostamarPurchasePaths(
          buildCostamarOfferRedirectRequest(cachedJob.request, offer),
          costamarContext,
        ),
      ],
    };
  };
  const allOffers = cachedJob.allOffers.map(repairOffer);
  const offersById = new Map(allOffers.map((offer) => [offer.id, offer] as const));

  return {
    ...cachedJob,
    allOffers,
    offers: cachedJob.offers.map((offer) => offersById.get(offer.id) ?? repairOffer(offer)),
  };
}

function buildCostamarOfferRedirectRequest(
  request: SearchRequest,
  offer: CanonicalOffer,
): SearchRequest {
  const leg = request.legs[0];
  const outbound = offer.itineraries?.find((itinerary) => itinerary.direction === "outbound")
    ?? offer.itineraries?.[0];
  const inbound = offer.itineraries?.find((itinerary) => itinerary.direction === "inbound");
  const departureDate = isoDateFromValue(outbound?.segments[0]?.departureAt)
    ?? leg.departureDate
    ?? leg.departureStart
    ?? "";
  const returnDate = request.tripType === "round-trip"
    ? isoDateFromValue(inbound?.segments[0]?.departureAt)
      ?? leg.returnDate
      ?? leg.returnStart
      ?? ""
    : "";

  return {
    ...request,
    searchMode: "exact",
    flexibleMode: undefined,
    legs: [
      {
        ...leg,
        origin: leg.origin || offer.origin,
        destination: leg.destination || offer.destination,
        departureDate,
        departureStart: undefined,
        departureEnd: undefined,
        returnDate,
        returnStart: undefined,
        returnEnd: undefined,
        stayNights: undefined,
        minNights: undefined,
        maxNights: undefined,
      },
    ],
  };
}

function isoDateFromValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(normalized)) {
    return normalized.slice(0, 10);
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

function createProviderSearchStates(
  providerIds: ProviderId[],
  cachedJob?: SearchJobRecord,
): Map<ProviderId, ProviderSearchState> {
  const offersByProvider = new Map<ProviderId, CanonicalOffer[]>(
    providerIds.map((providerId) => [providerId, []]),
  );

  for (const offer of cachedJob?.allOffers ?? []) {
    const providerOffers = offersByProvider.get(offer.providerSource);
    if (!providerOffers) {
      continue;
    }
    providerOffers.push(offer);
  }

  return new Map<ProviderId, ProviderSearchState>(
    providerIds.map((providerId) => [providerId, {
      offers: offersByProvider.get(providerId) ?? [],
      warnings: [],
      partial: true,
      completed: false,
    }]),
  );
}

function searchJobResponse(
  job: ReturnType<typeof getRuntime>["sessions"] extends { getSearchJob(jobId: string): infer T } ? NonNullable<T> : never,
  sinceRevision?: number,
) {
  const unchanged = typeof sinceRevision === "number" && sinceRevision >= job.revision;
  const base = {
    searchJobId: job.id,
    searchComplete: job.status === "completed" || job.status === "failed" || job.status === "cancelled",
    searchStatus: job.status,
    revision: job.revision,
    sortMode: job.sortMode,
    request: job.request,
    searchMeta: job.searchMeta,
    providerMeta: job.providerMeta,
    warnings: job.warnings,
    providerDiagnostics: job.providerDiagnostics,
    error: job.error,
    unchanged,
  };

  if (unchanged) {
    return base;
  }

  return {
    ...base,
    offers: job.offers,
    allOffers: job.allOffers,
  };
}

function isSearchJobRunning(runtime: ReturnType<typeof getRuntime>, jobId: string): boolean {
  return runtime.sessions.getSearchJob(jobId)?.status === "running";
}

function isMatrixJobRunning(runtime: ReturnType<typeof getRuntime>, jobId: string): boolean {
  return runtime.sessions.getMatrixJob(jobId)?.status === "running";
}

function shouldCachePartialCancellation(url: URL): boolean {
  return url.searchParams.get("cachePartial") === "1";
}

function cancelSearchJobResponse(runtime: ReturnType<typeof getRuntime>, jobId: string, url: URL): Response {
  const cachePartial = shouldCachePartialCancellation(url);
  const job = runtime.sessions.cancelSearchJob(
    jobId,
    cachePartial ? SEARCH_REFRESH_CANCELLED_WARNING : SEARCH_CANCELLED_WARNING,
    { cachePartial },
  );
  if (!job) {
    return json({ error: "Search job not found." }, { status: 404 });
  }

  return json(searchJobResponse(job));
}

function cancelMatrixJobResponse(runtime: ReturnType<typeof getRuntime>, jobId: string, url: URL): Response {
  const cachePartial = shouldCachePartialCancellation(url);
  const job = runtime.sessions.cancelMatrixJob(
    jobId,
    cachePartial ? SEARCH_REFRESH_CANCELLED_WARNING : SEARCH_CANCELLED_WARNING,
    { cachePartial },
  );
  if (!job) {
    return json({ error: "Matrix job not found." }, { status: 404 });
  }

  return json(matrixJobResponse(job));
}

function shouldBuildCostamarProviderContext(providerIds: ProviderId[]): boolean {
  return providerIds.includes("costamar");
}

function buildInitialProviderContext(
  providerIds: ProviderId[],
  payload: SearchPayload | undefined,
): ProviderContext | undefined {
  if (!shouldBuildCostamarProviderContext(providerIds)) {
    return undefined;
  }

  return {
    costamar: normalizeCostamarProviderContext(payload?.providerConfig?.costamar),
  };
}

async function handleSearchRequest(
  runtime: ReturnType<typeof getRuntime>,
  request: Request,
): Promise<Response> {
  const requestStart = startPerfTimer();
  const payload = await readPayload<SearchPayload>(request);
  const contract = prepareSearchContract(payload);
  const requestErrors = validateSearchContract(contract, undefined, { skipProviderContext: true });
  if (requestErrors.length > 0) {
    return json({ errors: requestErrors }, { status: 400 });
  }

  const providerContext = buildInitialProviderContext(contract.providerIds, payload);
  const errors = validateSearchContract(contract, providerContext);
  if (errors.length > 0) {
    return json({ errors }, { status: 400 });
  }

  const sortMode = resolveSortMode(payload?.sortMode);
  const normalizedRequest = contract.request;
  const providerIds = contract.providerIds;
  const diagnosticKind = providerDiagnosticKindForRequest(normalizedRequest);
  const providerDiagnostics = createProviderDiagnosticsForRun(providerIds, diagnosticKind);
  const cachedJob = runtime.sessions.findRecentCompletedSearchJob({
    request: normalizedRequest,
    providerContext,
    providerIds,
    sortMode,
    maxAgeMs: SEARCH_REVALIDATION_CACHE_TTL_MS,
  });
  const cacheSeedJob = recoverCachedCostamarPurchasePaths(cachedJob, providerContext);
  const draft = cacheSeedJob
    ? createCachedSearchDraftResponse(normalizedRequest, providerIds, cacheSeedJob)
    : createSearchDraftResponse(normalizedRequest, providerIds);
  const providerStates = createProviderSearchStates(providerIds, cacheSeedJob);
  const job = runtime.sessions.createSearchJob({
    request: normalizedRequest,
    providerContext,
    offers: draft.offers,
    allOffers: draft.allOffers ?? draft.offers,
    searchMeta: draft.searchMeta,
    providerMeta: draft.providerMeta,
    warnings: draft.warnings,
    providerDiagnostics,
    sortMode,
    status: "running",
  });
  logPerfSpan("search.accepted", requestStart, {
    jobId: job.id,
    mode: normalizedRequest.searchMode,
    providers: providerIds.join(","),
    cached: Boolean(cacheSeedJob),
    offers: job.offers.length,
  });

  const syncSearchJob = (status: "running" | "completed") => {
    const materialized = materializeAggregatedSearchResponse(
      normalizedRequest,
      sortMode,
      providerIds,
      providerStates,
    );
    const limited = limitSearchResponseForPagination(normalizedRequest, materialized);

    runtime.sessions.updateSearchJob(job.id, (current) => ({
      ...current,
      ...(current.status === "cancelled"
        ? {}
        : {
            offers: limited.offers,
            allOffers: limited.allOffers ?? limited.offers,
            searchMeta: {
              ...limited.searchMeta,
              requestedAt: current.searchMeta.requestedAt,
              partial: limited.searchMeta.partial,
              searchState: limited.searchMeta.searchState,
            },
            providerMeta: limited.providerMeta,
            warnings: limited.warnings,
            status,
            error: undefined,
          }),
    }));
    return materialized;
  };

  if (shouldRunBackgroundSearchJobs()) {
    scheduleBackgroundSearchJob(() => {
      if (!isSearchJobRunning(runtime, job.id)) {
        return;
      }

      const failedProviderIds = new Set<ProviderId>();
      const resolvers = providerIds.map(async (providerId) => {
        const providerStart = startPerfTimer();
        const providerDiagnosticSeed = providerDiagnostics.find((entry) => entry.providerId === providerId);
        const recordProviderEvent = (
          event: ProviderDiagnosticEvent | string,
          status: ProviderDiagnostics["status"] = "running",
        ) => {
          runtime.sessions.updateSearchJob(job.id, (current) => ({
            ...current,
            providerDiagnostics: applyProviderDiagnosticEvent(
              current.providerDiagnostics,
              providerId,
              event,
              status,
            ),
          }));
        };
        const recordProviderSummary = (
          status: ProviderDiagnostics["status"],
          summary: Pick<ProviderDiagnostics, "offers" | "warningCount" | "error">,
        ) => {
          runtime.sessions.updateSearchJob(job.id, (current) => ({
            ...current,
            providerDiagnostics: applyProviderDiagnosticSummary(
              current.providerDiagnostics,
              providerId,
              status,
              summary,
            ),
          }));
        };
        let firstProgressReported = false;
        const onProgress = (partialResult: { offers: CanonicalOffer[]; warnings: string[]; partial: boolean }) => {
          if (!isSearchJobRunning(runtime, job.id)) {
            return false;
          }

          if (!firstProgressReported) {
            firstProgressReported = true;
            recordProviderEvent("first_progress");
          }

          providerStates.set(providerId, {
            offers: partialResult.offers,
            warnings: partialResult.warnings,
            partial: true,
            completed: false,
          });
          syncSearchJob("running");
          return isSearchJobRunning(runtime, job.id);
        };

        try {
          if (!isSearchJobRunning(runtime, job.id)) {
            return;
          }

          if (shouldUseSearchWorkerProcesses()) {
            recordProviderEvent("worker_spawned");
          }

          const result = await resolveProviderSearchProgressive(
            providerId,
            normalizedRequest,
            providerContext,
            onProgress,
            providerDiagnosticSeed ? cloneProviderDiagnostics(providerDiagnosticSeed) : undefined,
            (event) => recordProviderEvent(event),
          );
          if (!isSearchJobRunning(runtime, job.id)) {
            return;
          }

          providerStates.set(providerId, {
            offers: result.offers,
            warnings: result.warnings,
            partial: result.partial,
            completed: true,
          });
          logPerfSpan("search.provider", providerStart, {
            jobId: job.id,
            providerId,
            status: "completed",
            offers: result.offers.length,
            partial: result.partial,
          });
          recordProviderEvent("completed", "completed");
          recordProviderSummary("completed", {
            offers: result.offers.length,
            warningCount: result.warnings.length,
          });
          syncSearchJob("running");
        } catch (error) {
          if (!isSearchJobRunning(runtime, job.id)) {
            return;
          }

          providerStates.set(providerId, {
            offers: [],
            warnings: [
              error instanceof Error ? error.message : "Search job failed.",
            ],
            partial: true,
            completed: true,
          });
          failedProviderIds.add(providerId);
          recordProviderEvent("failed", "failed");
          recordProviderSummary("failed", {
            offers: 0,
            warningCount: 1,
            error: error instanceof Error ? error.message : "Search job failed.",
          });
          logPerfSpan("search.provider", providerStart, {
            jobId: job.id,
            providerId,
            status: "failed",
            error: error instanceof Error ? error.name : "Error",
          });
        }
      });

      void Promise.allSettled(resolvers).then((settled) => {
        if (!isSearchJobRunning(runtime, job.id)) {
          logPerfSpan("search.job", requestStart, {
            jobId: job.id,
            status: runtime.sessions.getSearchJob(job.id)?.status ?? "missing",
            providers: providerIds.join(","),
          });
          return;
        }

        const materialized = syncSearchJob("completed");
        logPerfSpan("search.job", requestStart, {
          jobId: job.id,
          status: "completed",
          providers: providerIds.join(","),
          failedProviders: failedProviderIds.size + settled.filter((result) => result.status === "rejected").length,
          offers: materialized.offers.length,
          partial: materialized.searchMeta.partial,
        });
      });
    }, cacheSeedJob ? cachedBackgroundSearchStartDelayMs() : backgroundSearchStartDelayMs());
  }

  return json(searchJobResponse(job));
}

async function handleMatrixRequest(
  runtime: ReturnType<typeof getRuntime>,
  request: Request,
): Promise<Response> {
  const requestStart = startPerfTimer();
  const payload = await readPayload<SearchPayload>(request);
  const contract = prepareSearchContract(payload, { forceRoundTripGrid: true });
  const requestErrors = validateSearchContract(contract, undefined, { skipProviderContext: true });
  if (requestErrors.length > 0) {
    return json({ errors: requestErrors }, { status: 400 });
  }

  const providerContext = buildInitialProviderContext(contract.providerIds, payload);
  const errors = validateSearchContract(contract, providerContext);
  if (errors.length > 0) {
    return json({ errors }, { status: 400 });
  }

  const normalizedRequest = contract.request;
  const providerIds = contract.providerIds;
  const providerDiagnostics = createProviderDiagnosticsForRun(providerIds, "matrix");
  const providerStates = new Map<ProviderId, ProviderMatrixState>(
    providerIds.map((providerId) => {
      const adapter = getProgressiveAdapter(providerId);
      const response = adapter.createMatrixDraft(normalizedRequest, {
        exactProvider: providerId,
        coverageMode: normalizedRequest.coverageMode,
      });
      return [providerId, {
        response,
        completed: false,
      }];
    }),
  );
  const draft = materializeAggregatedMatrixResponse(
    normalizedRequest,
    providerIds,
    providerStates,
  );
  const job = runtime.sessions.createMatrixJob({
    request: normalizedRequest,
    providerContext,
    cells: draft.cells,
    axes: draft.axes,
    confidenceSummary: draft.confidenceSummary,
    recommendations: draft.recommendations,
    searchMeta: draft.searchMeta,
    providerMeta: draft.providerMeta,
    warnings: draft.warnings,
    providerDiagnostics,
    status: "running",
  });
  logPerfSpan("matrix.accepted", requestStart, {
    jobId: job.id,
    mode: normalizedRequest.searchMode,
    providers: providerIds.join(","),
    cells: job.cells.length,
  });

  const syncMatrixJob = (status: "running" | "completed") => {
    const materialized = materializeAggregatedMatrixResponse(
      normalizedRequest,
      providerIds,
      providerStates,
    );

    runtime.sessions.updateMatrixJob(job.id, (current) => ({
      ...current,
      ...(current.status === "cancelled"
        ? {}
        : {
            cells: materialized.cells,
            axes: materialized.axes,
            confidenceSummary: materialized.confidenceSummary,
            recommendations: materialized.recommendations,
            searchMeta: {
              ...materialized.searchMeta,
              requestedAt: current.searchMeta.requestedAt,
              searchSessionId: current.id,
            },
            providerMeta: materialized.providerMeta,
            warnings: materialized.warnings,
            status,
            error: undefined,
          }),
    }));

    return materialized;
  };

  if (shouldRunBackgroundSearchJobs()) {
    scheduleBackgroundSearchJob(() => {
      if (!isMatrixJobRunning(runtime, job.id)) {
        return;
      }

      const failedProviderIds = new Set<ProviderId>();
      const resolvers = providerIds.map(async (providerId) => {
        const providerStart = startPerfTimer();
        const providerDiagnosticSeed = providerDiagnostics.find((entry) => entry.providerId === providerId);
        const recordProviderEvent = (
          event: ProviderDiagnosticEvent | string,
          status: ProviderDiagnostics["status"] = "running",
        ) => {
          runtime.sessions.updateMatrixJob(job.id, (current) => ({
            ...current,
            providerDiagnostics: applyProviderDiagnosticEvent(
              current.providerDiagnostics,
              providerId,
              event,
              status,
            ),
          }));
        };
        const recordProviderSummary = (
          status: ProviderDiagnostics["status"],
          summary: Pick<ProviderDiagnostics, "offers" | "warningCount" | "error">,
        ) => {
          runtime.sessions.updateMatrixJob(job.id, (current) => ({
            ...current,
            providerDiagnostics: applyProviderDiagnosticSummary(
              current.providerDiagnostics,
              providerId,
              status,
              summary,
            ),
          }));
        };
        let firstProgressReported = false;
        const adapter = getProgressiveAdapter(providerId);
        const currentState = providerStates.get(providerId);
        const draftResponse = currentState?.response ?? adapter.createMatrixDraft(normalizedRequest, {
          exactProvider: providerId,
          coverageMode: normalizedRequest.coverageMode,
        });

        try {
          if (!isMatrixJobRunning(runtime, job.id)) {
            return;
          }

          if (shouldUseSearchWorkerProcesses()) {
            recordProviderEvent("worker_spawned");
          }

          const result = await resolveProviderMatrixProgressive(
            providerId,
            normalizedRequest,
            providerContext,
            draftResponse,
            (cell) => {
              if (!isMatrixJobRunning(runtime, job.id)) {
                return false;
              }

              if (!firstProgressReported) {
                firstProgressReported = true;
                recordProviderEvent("first_progress");
              }

              const providerState = providerStates.get(providerId);
              if (!providerState) {
                return false;
              }

              providerStates.set(providerId, {
                response: updateMatrixDraftCell(providerState.response, cell),
                completed: false,
              });
              syncMatrixJob("running");
              return isMatrixJobRunning(runtime, job.id);
            },
            providerDiagnosticSeed ? cloneProviderDiagnostics(providerDiagnosticSeed) : undefined,
            (event) => recordProviderEvent(event),
          );
          if (!isMatrixJobRunning(runtime, job.id)) {
            return;
          }

          providerStates.set(providerId, {
            response: result,
            completed: true,
          });
          logPerfSpan("matrix.provider", providerStart, {
            jobId: job.id,
            providerId,
            status: "completed",
            cells: result.cells.length,
            partial: result.searchMeta.partial,
          });
          recordProviderEvent("completed", "completed");
          recordProviderSummary("completed", {
            offers: result.cells.filter((cell) => typeof cell.price?.amount === "number").length,
            warningCount: result.warnings.length,
          });
        } catch (error) {
          if (!isMatrixJobRunning(runtime, job.id)) {
            return;
          }

          providerStates.set(providerId, {
            response: materializeFailedMatrixResponse(
              draftResponse,
              error instanceof Error ? error.message : "Matrix job failed.",
            ),
            completed: true,
          });
          failedProviderIds.add(providerId);
          recordProviderEvent("failed", "failed");
          recordProviderSummary("failed", {
            offers: 0,
            warningCount: 1,
            error: error instanceof Error ? error.message : "Matrix job failed.",
          });
          logPerfSpan("matrix.provider", providerStart, {
            jobId: job.id,
            providerId,
            status: "failed",
            error: error instanceof Error ? error.name : "Error",
          });
        }

        if (isMatrixJobRunning(runtime, job.id)) {
          syncMatrixJob("running");
        }
      });

      void Promise.allSettled(resolvers).then((settled) => {
        if (!isMatrixJobRunning(runtime, job.id)) {
          logPerfSpan("matrix.job", requestStart, {
            jobId: job.id,
            status: runtime.sessions.getMatrixJob(job.id)?.status ?? "missing",
            providers: providerIds.join(","),
          });
          return;
        }

        const materialized = syncMatrixJob("completed");
        logPerfSpan("matrix.job", requestStart, {
          jobId: job.id,
          status: "completed",
          providers: providerIds.join(","),
          failedProviders: failedProviderIds.size + settled.filter((result) => result.status === "rejected").length,
          cells: materialized.cells.length,
          partial: materialized.searchMeta.partial,
        });
      });
    }, backgroundSearchStartDelayMs());
  }

  return json(matrixJobResponse(job));
}

export async function routeRequest(request: Request): Promise<Response> {
  const runtime = getRuntime();
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/health") {
    return json({ ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/diagnostics") {
    if (!isTrustedLocalRequest(request)) {
      return json({ error: "This diagnostic endpoint is only available on localhost." }, { status: 403 });
    }

    return json({
      ok: true,
      generatedAt: new Date().toISOString(),
      memoryUsage: process.memoryUsage(),
      locationSuggestions: runtime.locationSuggestions.getDiagnostics(),
      sessions: runtime.sessions.getDiagnostics(),
      tempArtifacts: collectTempArtifactDiagnostics(),
    });
  }

  if (request.method === "GET" && url.pathname === "/api/results-layout") {
    if (!isTrustedLocalRequest(request)) {
      return json({ error: "This layout endpoint is only available on localhost." }, { status: 403 });
    }

    const layout = await readResultsLayoutFile();
    return json({ layout });
  }

  if (request.method === "POST" && url.pathname === "/api/results-layout") {
    if (!isTrustedLocalRequest(request)) {
      return json({ error: "This layout endpoint is only available on localhost." }, { status: 403 });
    }

    const payload = await readPayload<ResultsLayoutPayload>(request);
    const columns = normalizeResultsLayoutColumns(payload?.columns);
    if (!columns) {
      return json({ errors: ["A full results column layout is required."] }, { status: 400 });
    }

    const layout = await writeResultsLayoutFile(columns);
    return json({ ok: true, layout });
  }

  if (request.method === "GET" && url.pathname === "/api/costamar/token-status") {
    if (!isTrustedLocalRequest(request)) {
      return json({ error: "This Costamar token endpoint is only available on localhost." }, { status: 403 });
    }

    const status = getCostamarTokenStatus();
    const verify = url.searchParams.get("verify") === "true";
    const verification = verify ? await verifyCostamarTokenLive() : undefined;
    return json({ ...status, verification });
  }

  if (request.method === "GET" && url.pathname === "/api/agil/locations") {
    if (!isTrustedApiRequest(request)) {
      return apiAuthRequiredResponse();
    }

    const query = stringValue(url.searchParams.get("q"));
    if (query.length < 1) {
      return json({ query, suggestions: [] });
    }

    const limit = integerParam(url.searchParams.get("limit"), 8, 1, 20);
    const clientSessionId = resolveLocationSuggestionSessionId(url.searchParams.get("clientSessionId"));
    const suggestions = await suggestLocationsForProvider(runtime, clientSessionId, "agil-local", query, limit);
    return json({ query, providerId: "agil-local", suggestions });
  }

  if (request.method === "GET" && url.pathname === "/api/costamar/locations") {
    if (!isTrustedApiRequest(request)) {
      return apiAuthRequiredResponse();
    }

    const query = stringValue(url.searchParams.get("q"));
    if (query.length < 1) {
      return json({ query, suggestions: [] });
    }

    const limit = integerParam(url.searchParams.get("limit"), 8, 1, 20);
    const clientSessionId = resolveLocationSuggestionSessionId(url.searchParams.get("clientSessionId"));
    const suggestions = await suggestLocationsForProvider(runtime, clientSessionId, "costamar", query, limit);
    return json({ query, providerId: "costamar", suggestions });
  }

  if (request.method === "GET" && url.pathname === "/api/locations") {
    if (!isTrustedApiRequest(request)) {
      return apiAuthRequiredResponse();
    }

    const query = stringValue(url.searchParams.get("q"));
    if (query.length < 1) {
      return json({ query, suggestions: [] });
    }

    const limit = integerParam(url.searchParams.get("limit"), 8, 1, 20);
    const clientSessionId = resolveLocationSuggestionSessionId(url.searchParams.get("clientSessionId"));
    const rawProviderId = stringValue(url.searchParams.get("providerId"));
    const providerIds = rawProviderId
      ? [resolveProviderId(rawProviderId as ProviderId | undefined)]
      : resolveSearchProviderIds(undefined);

    if (providerIds.length === 1) {
      const providerId = providerIds[0];
      const suggestions = await suggestLocationsForProvider(runtime, clientSessionId, providerId, query, limit);
      return json({ query, providerId, suggestions });
    }

    const settled = await Promise.allSettled(
      providerIds.map(async (providerId) => ({
        providerId,
        suggestions: await suggestLocationsForProvider(runtime, clientSessionId, providerId, query, limit) as LocationSuggestion[],
      })),
    );

    const fulfilled = settled
      .filter((result): result is PromiseFulfilledResult<{ providerId: ProviderId; suggestions: LocationSuggestion[] }> => result.status === "fulfilled")
      .map((result) => result.value.suggestions);

    if (fulfilled.length === 0) {
      const failure = settled.find((result) => result.status === "rejected");
      throw failure?.status === "rejected" && failure.reason instanceof Error
        ? failure.reason
        : new Error("Location suggest failed.");
    }

    const suggestions = mergeLocationSuggestions(fulfilled, limit);
    return json({ query, providerIds, suggestions });
  }

  if (request.method === "POST" && url.pathname === "/api/local/open-url") {
    if (!isTrustedLocalRequest(request)) {
      return json({ error: "This local browser action is only available on localhost." }, { status: 403 });
    }

    const payload = await readPayload<LocalOpenPayload>(request);
    const targetUrl = validateLocalOpenUrl(stringValue(payload.url));
    if (!targetUrl) {
      return json({ error: "Unsupported URL for local browser launch." }, { status: 400 });
    }

    const launcher = await openUrlLocally(
      targetUrl.toString(),
      payload.preferredBrowser === "default" ? "default" : "chrome",
    );

    return json({
      ok: true,
      localOnly: true,
      launcher: launcher.launcher,
      url: targetUrl.toString(),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/search") {
    if (!isTrustedApiRequest(request)) {
      return apiAuthRequiredResponse();
    }

    return handleSearchRequest(runtime, request);
  }

  if (request.method === "POST" && url.pathname.startsWith("/api/search/") && url.pathname.endsWith("/cancel")) {
    if (!isTrustedApiRequest(request)) {
      return apiAuthRequiredResponse();
    }

    const jobId = url.pathname.slice("/api/search/".length, -"/cancel".length);
    return cancelSearchJobResponse(runtime, jobId, url);
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/search/")) {
    if (!isTrustedApiRequest(request)) {
      return apiAuthRequiredResponse();
    }

    const jobId = url.pathname.slice("/api/search/".length);
    const job = runtime.sessions.getSearchJob(jobId);

    if (!job) {
      return json({ error: "Search job not found." }, { status: 404 });
    }

    return json(searchJobResponse(job, parseSinceRevision(url.searchParams.get("sinceRevision"))));
  }

  if (request.method === "POST" && url.pathname === "/api/matrix") {
    if (!isTrustedApiRequest(request)) {
      return apiAuthRequiredResponse();
    }

    return handleMatrixRequest(runtime, request);
  }

  if (request.method === "POST" && url.pathname.startsWith("/api/matrix/") && url.pathname.endsWith("/cancel")) {
    if (!isTrustedApiRequest(request)) {
      return apiAuthRequiredResponse();
    }

    const jobId = url.pathname.slice("/api/matrix/".length, -"/cancel".length);
    return cancelMatrixJobResponse(runtime, jobId, url);
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/matrix/")) {
    if (!isTrustedApiRequest(request)) {
      return apiAuthRequiredResponse();
    }

    const jobId = url.pathname.slice("/api/matrix/".length);
    const job = runtime.sessions.getMatrixJob(jobId);

    if (!job) {
      return json({ error: "Matrix job not found." }, { status: 404 });
    }

    return json(matrixJobResponse(job, parseSinceRevision(url.searchParams.get("sinceRevision"))));
  }

  if (request.method === "GET" && url.pathname.startsWith("/r/")) {
    if (!isTrustedApiRequest(request)) {
      return apiAuthRequiredResponse();
    }

    const purchasePathId = url.pathname.slice(3);
    const resolved = runtime.sessions.resolvePurchasePath(purchasePathId);

    if (!resolved) {
      return json({ error: "Purchase path not found." }, { status: 404 });
    }

    if (resolved.path.url) {
      let location = resolved.path.url;

      if (resolved.path.provider === "costamar" && resolved.path.type === "search-redirect") {
        const providerContext = runtime.sessions.getSession(resolved.sessionId)?.providerContext
          ?? runtime.sessions.getMatrixJob(resolved.sessionId)?.providerContext;
        let canRedirect = false;

        try {
          const parsed = new URL(location);
          const sessionContext = providerContext?.costamar;
          const parsedTerminalId = parsed.searchParams.get("terminalId")?.trim() || undefined;
          const parsedLang = parsed.searchParams.get("lang")?.trim() || undefined;
          const parsedToken = parsed.searchParams.get("token")?.trim() || undefined;
          const terminalId = parsedTerminalId || sessionContext?.terminalId;
          const lang = parsedLang || sessionContext?.lang;
          const parsedTokenIsUsable = Boolean(resolveUsableCostamarBrandedToken(parsedToken, terminalId));
          const fastContext = normalizeCostamarProviderContext({
            ...(sessionContext ?? {}),
            ...(terminalId ? { terminalId } : {}),
            ...(lang ? { lang } : {}),
            token: parsedTokenIsUsable ? parsedToken : sessionContext?.token,
          });

          if (resolveUsableCostamarBrandedToken(fastContext.token, fastContext.terminalId)) {
            location = applyCostamarContextToBrandedSearchUrl(location, fastContext);
            canRedirect = true;
          }

          const refreshContext = {
            ...(sessionContext ?? {}),
            ...(terminalId ? { terminalId } : {}),
            ...(lang ? { lang } : {}),
            ...(parsedToken || sessionContext?.token ? { token: parsedToken || sessionContext?.token } : {}),
          };
          if (!canRedirect) {
            const refreshedContext = resolveLatestCostamarProviderContext(refreshContext);
            if (resolveUsableCostamarBrandedToken(refreshedContext.token, refreshedContext.terminalId)) {
              location = applyCostamarContextToBrandedSearchUrl(location, refreshedContext);
              canRedirect = true;
            }
          }
        } catch {
          canRedirect = false;
        }

        if (!canRedirect) {
          return costamarRedirectBlockedResponse();
        }
      }

      return new Response(null, {
        status: 302,
        headers: {
          Location: location,
        },
      });
    }

    if (resolved.path.referenceText) {
      return new Response(resolved.path.referenceText, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }

    return json({ error: "Purchase path is unavailable." }, { status: 410 });
  }

  if (request.method === "POST" && url.pathname === "/api/quotation") {
    if (!isTrustedApiRequest(request)) {
      return apiAuthRequiredResponse();
    }

    const payload = await readPayload<QuotationPayload>(request);

    const session = payload.searchSessionId ? runtime.sessions.getSession(payload.searchSessionId) : undefined;
    const storedOffer = session && payload.offerId
      ? runtime.sessions.getOffer(payload.searchSessionId as string, payload.offerId)
      : undefined;
    const snapshotRequest = normalizeQuotationRequestSnapshot(payload.request, payload.offer);
    const requestSnapshot = session?.request ?? snapshotRequest;
    const offerSnapshot = !storedOffer && requestSnapshot
      ? normalizeQuotationOfferSnapshot(payload.offer, requestSnapshot)
      : undefined;
    const offer = storedOffer ?? offerSnapshot;

    if (!requestSnapshot || !offer) {
      return json({ errors: ["Session or offer not found."] }, { status: 404 });
    }

    const usdToPenRate = shouldIncludePenQuotationPrice(offer, requestSnapshot)
      ? session
        ? await resolveQuotationUsdToPenRate(session, offer)
        : await resolveStandaloneUsdToPenRate(offer)
      : undefined;

    return json({
      searchSessionId: payload.searchSessionId,
      offer,
      commercialText: buildCommercialQuotation(offer, requestSnapshot, { usdToPenRate }),
    });
  }

  return json({ error: "Not found" }, { status: 404 });
}
