import { materializeSearchResponse } from "./core/orchestrator";
import { buildQuotationText } from "./core/quotation";
import {
  Cabin,
  CanonicalOffer,
  LocationSuggestion,
  MatrixCell,
  MatrixResponse,
  ProviderConfigInput,
  ProviderContext,
  ProviderId,
  SearchMode,
  SearchRequest,
  SearchResponse,
  TripType,
} from "./core/types";
import {
  createLocalAgilSearchDraft,
  resolveLocalAgilExactProgressive,
  createLocalAgilMatrixDraft,
  resolveLocalAgilMatrixProgressive,
  resolveLocalAgilRangeProgressive,
  suggestLocalAgilLocations,
} from "./local-agil";
import {
  createLocalCostamarMatrixDraft,
  createLocalCostamarSearchDraft,
  resolveLocalCostamarExactProgressive,
  resolveLocalCostamarMatrixProgressive,
  resolveLocalCostamarRangeProgressive,
  suggestLocalCostamarLocations,
} from "./local-costamar";
import { openUrlLocally } from "./local-browser";
import { buildProviderContext, resolveProviderId } from "./provider-context";
import { getRuntime } from "./runtime";

type SortMode = "cheapest" | "fastest" | "best-value";

interface SearchPayload {
  providerId?: ProviderId;
  providerConfig?: ProviderConfigInput;
  request?: Partial<SearchRequest> & {
    legs?: Array<Record<string, unknown>>;
    passengers?: Record<string, unknown>;
    filters?: Record<string, unknown>;
  };
  sortMode?: SortMode;
}

interface SessionPayload {
  searchSessionId?: string;
}

interface RepricePayload extends SessionPayload {
  offerId?: string;
}

interface QuotationPayload extends SessionPayload {
  offerId?: string;
}

interface LocalOpenPayload {
  url?: string;
  preferredBrowser?: "chrome" | "default";
}

interface ProgressiveSearchAdapter {
  createSearchDraft(request: SearchRequest, providerMeta: { exactProvider: ProviderId; coverageMode: SearchRequest["coverageMode"] }): SearchResponse;
  resolveExactProgressive(
    request: SearchRequest,
    providerContext: ProviderContext | undefined,
    onUpdate?: (result: { offers: CanonicalOffer[]; warnings: string[]; partial: boolean }) => void,
  ): Promise<{ offers: CanonicalOffer[]; warnings: string[]; partial: boolean }>;
  resolveRangeProgressive(
    request: SearchRequest,
    providerContext: ProviderContext | undefined,
    onUpdate?: (result: { offers: CanonicalOffer[]; warnings: string[]; partial: boolean }) => void,
  ): Promise<{ offers: CanonicalOffer[]; warnings: string[]; partial: boolean }>;
  createMatrixDraft(
    request: SearchRequest,
    providerMeta: { exactProvider: ProviderId; coverageMode: SearchRequest["coverageMode"] },
  ): MatrixResponse;
  resolveMatrixProgressive(
    request: SearchRequest,
    providerContext: ProviderContext | undefined,
    draft: MatrixResponse,
    onCellResolved?: (cell: MatrixResponse["cells"][number]) => void,
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

function parseExplicitProviderId(value: unknown): ProviderId | undefined {
  return value === "costamar" || value === "agil-local"
    ? value
    : undefined;
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

function stringValue(input: unknown, fallback = ""): string {
  return typeof input === "string" ? input.trim() : fallback;
}

function numberValue(input: unknown, fallback?: number): number | undefined {
  if (input === undefined || input === null || input === "") {
    return fallback;
  }

  const value = typeof input === "number" ? input : Number(input);
  return Number.isFinite(value) ? value : fallback;
}

function integerParam(input: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function booleanValue(input: unknown, fallback = false): boolean {
  return typeof input === "boolean" ? input : fallback;
}

function stringList(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }

  const values = input
    .map((entry) => typeof entry === "string" ? entry.trim().toUpperCase() : "")
    .filter(Boolean);

  return values.length > 0 ? values : undefined;
}

function normalizeTripType(input: unknown): TripType {
  if (input === "one-way" || input === "multi-city") {
    return input;
  }
  return "round-trip";
}

function normalizeSearchMode(input: unknown): SearchMode {
  if (input === "stay-range" || input === "roundtrip-grid" || input === "month-view") {
    return input;
  }
  return "exact";
}

function normalizeCabin(input: unknown): Cabin {
  return input === "PREMIUM_ECONOMY" || input === "BUSINESS" || input === "FIRST"
    ? input
    : "ECONOMY";
}

function normalizeRequest(
  input: SearchPayload["request"] | undefined,
  providerId?: ProviderId,
): SearchRequest {
  const leg: Record<string, unknown> = input?.legs?.[0] ?? {};
  const filters = input?.filters ?? {};

  return {
    providerId,
    tripType: normalizeTripType(input?.tripType),
    searchMode: normalizeSearchMode(input?.searchMode),
    legs: [
      {
        origin: stringValue(leg.origin).toUpperCase(),
        destination: stringValue(leg.destination).toUpperCase(),
        originLabel: stringValue(leg.originLabel),
        destinationLabel: stringValue(leg.destinationLabel),
        departureDate: stringValue(leg.departureDate),
        departureStart: stringValue(leg.departureStart),
        departureEnd: stringValue(leg.departureEnd),
        returnDate: stringValue(leg.returnDate),
        returnStart: stringValue(leg.returnStart),
        returnEnd: stringValue(leg.returnEnd),
        minNights: numberValue(leg.minNights, 3),
        maxNights: numberValue(leg.maxNights, 7),
      },
    ],
    passengers: {
      adults: numberValue(input?.passengers?.adults, 1) ?? 1,
      children: numberValue(input?.passengers?.children, 0) ?? 0,
      infants: numberValue(input?.passengers?.infants, 0) ?? 0,
    },
    cabin: normalizeCabin(input?.cabin),
    filters: {
      nonStop: booleanValue(filters.nonStop, false),
      includedAirlineCodes: stringList(filters.includedAirlineCodes),
      excludedAirlineCodes: stringList(filters.excludedAirlineCodes),
      maxPrice: numberValue(filters.maxPrice),
      maxResults: numberValue(filters.maxResults, 25),
      maxTotalDurationMinutes: numberValue(filters.maxTotalDurationMinutes),
      maxLayoverMinutes: numberValue(filters.maxLayoverMinutes),
      maxStops: numberValue(filters.maxStops),
      minDepartureMinutes: numberValue(filters.minDepartureMinutes),
      maxDepartureMinutes: numberValue(filters.maxDepartureMinutes),
      minArrivalMinutes: numberValue(filters.minArrivalMinutes),
      maxArrivalMinutes: numberValue(filters.maxArrivalMinutes),
      baggageRequired: booleanValue(filters.baggageRequired, false),
      verifiedOnly: booleanValue(filters.verifiedOnly, false),
      exactPurchasePathOnly: booleanValue(filters.exactPurchasePathOnly, false),
    },
    coverageMode: input?.coverageMode === "extended" ? "extended" : "core",
    redirectMode: input?.redirectMode === "none" || input?.redirectMode === "strict"
      ? input.redirectMode
      : "best-effort",
    currencyCode: stringValue(input?.currencyCode, "USD").toUpperCase(),
    locale: stringValue(input?.locale, "es-PE"),
    market: stringValue(input?.market, "PE"),
  };
}

function validateRequest(request: SearchRequest): string[] {
  const leg = request.legs[0];
  const errors: string[] = [];
  const dateFields = [
    ["Departure date", leg.departureDate],
    ["Return date", leg.returnDate],
    ["Departure start", leg.departureStart],
    ["Departure end", leg.departureEnd],
    ["Return start", leg.returnStart],
    ["Return end", leg.returnEnd],
  ];

  if (!leg.origin || leg.origin.length < 3) {
    errors.push("Origin is required and must be an IATA-like code.");
  }

  if (!leg.destination || leg.destination.length < 3) {
    errors.push("Destination is required and must be an IATA-like code.");
  }

  if (leg.origin && leg.destination && leg.origin === leg.destination) {
    errors.push("Origin and destination must be different.");
  }

  if (request.passengers.adults < 1) {
    errors.push("At least one adult is required.");
  }

  if (request.passengers.infants > request.passengers.adults) {
    errors.push("Infants cannot exceed adults.");
  }

  if (
    request.passengers.adults + request.passengers.children + request.passengers.infants > 9
  ) {
    errors.push("Passenger count cannot exceed 9.");
  }

  if (request.searchMode === "exact") {
    if (!leg.departureDate) {
      errors.push("Departure date is required for exact search.");
    }

    if (request.tripType === "round-trip" && !leg.returnDate) {
      errors.push("Return date is required for round-trip exact search.");
    }

    if (
      request.tripType === "round-trip" &&
      leg.departureDate &&
      leg.returnDate &&
      leg.returnDate <= leg.departureDate
    ) {
      errors.push("Return date must be after departure date.");
    }
  }

  if (request.searchMode === "roundtrip-grid") {
    if (!leg.departureStart || !leg.departureEnd) {
      errors.push("Departure range is required for matrix search.");
    }

    if (
      request.tripType === "round-trip" &&
      (!leg.returnStart || !leg.returnEnd)
    ) {
      errors.push("Return range is required for round-trip matrix search.");
    }
  }

  if (request.searchMode === "stay-range") {
    if (!leg.departureStart || !leg.departureEnd) {
      errors.push("Departure range is required for range search.");
    }

    if (
      request.tripType === "round-trip" &&
      (!leg.returnStart || !leg.returnEnd)
    ) {
      errors.push("Return range is required for round-trip range search.");
    }
  }

  if (leg.departureStart && leg.departureEnd && leg.departureEnd < leg.departureStart) {
    errors.push("Departure range end must be on or after departure range start.");
  }

  if (leg.returnStart && leg.returnEnd && leg.returnEnd < leg.returnStart) {
    errors.push("Return range end must be on or after return range start.");
  }

  if (
    request.tripType === "round-trip" &&
    leg.departureStart &&
    leg.returnStart &&
    leg.returnStart < leg.departureStart
  ) {
    errors.push("Return range must start after the departure range.");
  }

  dateFields.forEach(([label, value]) => {
    if (value && !value.startsWith("2026-")) {
      errors.push(`${label} must be within 2026.`);
    }
  });

  return errors;
}

function validateProviderContext(
  providerId: ProviderId,
  providerContext: ProviderContext | undefined,
): string[] {
  if (providerId !== "costamar") {
    return [];
  }

  const errors: string[] = [];
  const context = providerContext?.costamar;
  if (!context?.terminalId) {
    errors.push("Costamar terminalId is required.");
  }

  return errors;
}

function resolveSearchProviderIds(
  explicitProviderId: ProviderId | undefined,
): ProviderId[] {
  if (explicitProviderId) {
    return [explicitProviderId];
  }

  return ["agil-local", "costamar"];
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

function buildMatrixConfidenceSummary(cells: MatrixCell[]): Record<string, number> {
  return cells.reduce<Record<string, number>>((acc, cell) => {
    acc[cell.confidence] = (acc[cell.confidence] ?? 0) + 1;
    return acc;
  }, {});
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

function scopedProviderRequest(
  request: SearchRequest,
  providerId: ProviderId,
): SearchRequest {
  return {
    ...request,
    providerId,
  };
}

function getProgressiveAdapter(providerId: ProviderId): ProgressiveSearchAdapter {
  return PROGRESSIVE_ADAPTERS[providerId];
}

async function suggestLocationsForProvider(
  runtime: ReturnType<typeof getRuntime>,
  providerId: ProviderId,
  query: string,
  limit: number,
): Promise<Awaited<ReturnType<typeof suggestLocalAgilLocations>>> {
  const provider = runtime.orchestrator.getProvider(providerId);
  if (provider?.suggestLocations) {
    return provider.suggestLocations(query, limit);
  }

  return providerId === "costamar"
    ? suggestLocalCostamarLocations(query, limit)
    : suggestLocalAgilLocations(query, limit);
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

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "[::1]";
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

function matrixJobResponse(job: ReturnType<typeof getRuntime>["sessions"] extends { getMatrixJob(jobId: string): infer T } ? NonNullable<T> : never) {
  return {
    matrixJobId: job.id,
    matrixComplete: job.status === "completed" || job.status === "failed",
    matrixStatus: job.status,
    request: job.request,
    cells: job.cells,
    axes: job.axes,
    confidenceSummary: job.confidenceSummary,
    recommendations: job.recommendations,
    searchMeta: job.searchMeta,
    providerMeta: job.providerMeta,
    warnings: job.warnings,
    error: job.error,
  };
}

function searchJobResponse(job: ReturnType<typeof getRuntime>["sessions"] extends { getSearchJob(jobId: string): infer T } ? NonNullable<T> : never) {
  return {
    searchJobId: job.id,
    searchComplete: job.status === "completed" || job.status === "failed",
    searchStatus: job.status,
    sortMode: job.sortMode,
    request: job.request,
    offers: job.offers,
    allOffers: job.allOffers,
    searchMeta: job.searchMeta,
    providerMeta: job.providerMeta,
    warnings: job.warnings,
    error: job.error,
  };
}

export async function routeRequest(request: Request): Promise<Response> {
  const runtime = getRuntime();
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/health") {
    return json({ ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/agil/locations") {
    const query = stringValue(url.searchParams.get("q"));
    if (query.length < 2) {
      return json({ query, suggestions: [] });
    }

    const limit = integerParam(url.searchParams.get("limit"), 8, 1, 20);
    const suggestions = await suggestLocationsForProvider(runtime, "agil-local", query, limit);
    return json({ query, providerId: "agil-local", suggestions });
  }

  if (request.method === "GET" && url.pathname === "/api/costamar/locations") {
    const query = stringValue(url.searchParams.get("q"));
    if (query.length < 2) {
      return json({ query, suggestions: [] });
    }

    const limit = integerParam(url.searchParams.get("limit"), 8, 1, 20);
    const suggestions = await suggestLocationsForProvider(runtime, "costamar", query, limit);
    return json({ query, providerId: "costamar", suggestions });
  }

  if (request.method === "GET" && url.pathname === "/api/locations") {
    const query = stringValue(url.searchParams.get("q"));
    if (query.length < 2) {
      return json({ query, suggestions: [] });
    }

    const limit = integerParam(url.searchParams.get("limit"), 8, 1, 20);
    const rawProviderId = stringValue(url.searchParams.get("providerId"));
    const providerIds = rawProviderId
      ? [resolveProviderId(rawProviderId as ProviderId | undefined)]
      : resolveSearchProviderIds(undefined);

    if (providerIds.length === 1) {
      const providerId = providerIds[0];
      const suggestions = await suggestLocationsForProvider(runtime, providerId, query, limit);
      return json({ query, providerId, suggestions });
    }

    const settled = await Promise.allSettled(
      providerIds.map(async (providerId) => ({
        providerId,
        suggestions: await suggestLocationsForProvider(runtime, providerId, query, limit) as LocationSuggestion[],
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
    if (!isLoopbackHost(url.hostname)) {
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
    const payload = await readPayload<SearchPayload>(request);
    const explicitProviderId = parseExplicitProviderId(payload.providerId ?? payload.request?.providerId);
    const providerContext = buildProviderContext("costamar", payload.providerConfig);
    const providerIds = resolveSearchProviderIds(explicitProviderId);
    const normalizedRequest = normalizeRequest(payload.request, explicitProviderId);
    const errors = [
      ...validateRequest(normalizedRequest),
      ...(explicitProviderId === "costamar" ? validateProviderContext("costamar", providerContext) : []),
    ];

    if (errors.length > 0) {
      return json({ errors }, { status: 400 });
    }

    const sortMode: SortMode = payload.sortMode === "cheapest" || payload.sortMode === "fastest"
      ? payload.sortMode
      : "cheapest";
    const draft = createSearchDraftResponse(normalizedRequest, providerIds);
    const job = runtime.sessions.createSearchJob({
      request: normalizedRequest,
      providerContext,
      offers: draft.offers,
      allOffers: draft.allOffers ?? draft.offers,
      searchMeta: draft.searchMeta,
      providerMeta: draft.providerMeta,
      warnings: draft.warnings,
      sortMode,
      status: "running",
    });
    const providerStates = new Map<ProviderId, ProviderSearchState>(
      providerIds.map((providerId) => [providerId, {
        offers: [],
        warnings: [],
        partial: true,
        completed: false,
      }]),
    );

    const syncSearchJob = (status: "running" | "completed") => {
      const materialized = materializeAggregatedSearchResponse(
        normalizedRequest,
        sortMode,
        providerIds,
        providerStates,
      );

      runtime.sessions.updateSearchJob(job.id, (current) => ({
        ...current,
        offers: materialized.offers,
        allOffers: materialized.allOffers ?? materialized.offers,
        searchMeta: {
          ...materialized.searchMeta,
          requestedAt: current.searchMeta.requestedAt,
        },
        providerMeta: materialized.providerMeta,
        warnings: materialized.warnings,
        status,
        error: undefined,
      }));
    };

    const resolvers = providerIds.map(async (providerId) => {
      const adapter = getProgressiveAdapter(providerId);
      const onProgress = (partialResult: { offers: CanonicalOffer[]; warnings: string[]; partial: boolean }) => {
        providerStates.set(providerId, {
          offers: partialResult.offers,
          warnings: partialResult.warnings,
          partial: true,
          completed: false,
        });
        syncSearchJob("running");
      };

      try {
        const result = normalizedRequest.searchMode === "stay-range"
          ? await adapter.resolveRangeProgressive(normalizedRequest, providerContext, onProgress)
          : await adapter.resolveExactProgressive(normalizedRequest, providerContext, onProgress);
        providerStates.set(providerId, {
          offers: result.offers,
          warnings: result.warnings,
          partial: result.partial,
          completed: true,
        });
      } catch (error) {
        providerStates.set(providerId, {
          offers: [],
          warnings: [
            error instanceof Error ? error.message : "Search job failed.",
          ],
          partial: true,
          completed: true,
        });
      }
    });

    void Promise.allSettled(resolvers).then(() => {
      syncSearchJob("completed");
    });

    return json(searchJobResponse(job));
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/search/")) {
    const jobId = url.pathname.slice("/api/search/".length);
    const job = runtime.sessions.getSearchJob(jobId);

    if (!job) {
      return json({ error: "Search job not found." }, { status: 404 });
    }

    return json(searchJobResponse(job));
  }

  if (request.method === "POST" && url.pathname === "/api/matrix") {
    const payload = await readPayload<SearchPayload>(request);
    const explicitProviderId = parseExplicitProviderId(payload.providerId ?? payload.request?.providerId);
    const providerIds = resolveSearchProviderIds(explicitProviderId);
    const normalizedRequest = normalizeRequest(payload.request, explicitProviderId);
    normalizedRequest.searchMode = "roundtrip-grid";
    const providerContext = buildProviderContext("costamar", payload.providerConfig);

    const errors = [
      ...validateRequest(normalizedRequest),
      ...(explicitProviderId === "costamar" ? validateProviderContext("costamar", providerContext) : []),
    ];
    if (errors.length > 0) {
      return json({ errors }, { status: 400 });
    }

    const providerStates = new Map<ProviderId, ProviderMatrixState>(
      providerIds.map((providerId) => {
        const providerRequest = scopedProviderRequest(normalizedRequest, providerId);
        const adapter = getProgressiveAdapter(providerId);
        const response = adapter.createMatrixDraft(providerRequest, {
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
      status: "running",
    });

    const syncMatrixJob = (status: "running" | "completed") => {
      const materialized = materializeAggregatedMatrixResponse(
        normalizedRequest,
        providerIds,
        providerStates,
      );

      runtime.sessions.updateMatrixJob(job.id, (current) => ({
        ...current,
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
      }));
    };

    const resolvers = providerIds.map(async (providerId) => {
      const providerRequest = scopedProviderRequest(normalizedRequest, providerId);
      const adapter = getProgressiveAdapter(providerId);
      const currentState = providerStates.get(providerId);
      const draftResponse = currentState?.response ?? adapter.createMatrixDraft(providerRequest, {
        exactProvider: providerId,
        coverageMode: normalizedRequest.coverageMode,
      });

      try {
        const result = await adapter.resolveMatrixProgressive(
          providerRequest,
          providerContext,
          draftResponse,
          (cell) => {
            const providerState = providerStates.get(providerId);
            if (!providerState) {
              return;
            }

            providerStates.set(providerId, {
              response: updateMatrixDraftCell(providerState.response, cell),
              completed: false,
            });
            syncMatrixJob("running");
          },
        );

        providerStates.set(providerId, {
          response: result,
          completed: true,
        });
      } catch (error) {
        providerStates.set(providerId, {
          response: materializeFailedMatrixResponse(
            draftResponse,
            error instanceof Error ? error.message : "Matrix job failed.",
          ),
          completed: true,
        });
      }

      syncMatrixJob("running");
    });

    void Promise.allSettled(resolvers).then(() => {
      syncMatrixJob("completed");
    });

    return json(matrixJobResponse(job));
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/matrix/")) {
    const jobId = url.pathname.slice("/api/matrix/".length);
    const job = runtime.sessions.getMatrixJob(jobId);

    if (!job) {
      return json({ error: "Matrix job not found." }, { status: 404 });
    }

    return json(matrixJobResponse(job));
  }

  if (request.method === "GET" && url.pathname.startsWith("/r/")) {
    const purchasePathId = url.pathname.slice(3);
    const resolved = runtime.sessions.resolvePurchasePath(purchasePathId);

    if (!resolved) {
      return json({ error: "Purchase path not found." }, { status: 404 });
    }

    if (resolved.path.url) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: resolved.path.url,
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

  if (request.method === "POST" && url.pathname === "/api/reprice") {
    const payload = await readPayload<RepricePayload>(request);

    if (!payload.searchSessionId || !payload.offerId) {
      return json({ errors: ["searchSessionId and offerId are required."] }, { status: 400 });
    }

    const session = runtime.sessions.getSession(payload.searchSessionId);
    const offer = session ? runtime.sessions.getOffer(payload.searchSessionId, payload.offerId) : undefined;

    if (!session || !offer) {
      return json({ errors: ["Session or offer not found."] }, { status: 404 });
    }

    const result = await runtime.orchestrator.reprice(
      session.request,
      payload.offerId,
      offer,
      {
        providerId: offer.providerSource,
        providerContext: session.providerContext,
      },
    );
    const repriced = result.offers[0];

    if (!repriced) {
      return json({ errors: ["Offer not found after repricing."] }, { status: 404 });
    }

    const updated = runtime.sessions.updateOffer(payload.searchSessionId, repriced);

    return json({
      searchSessionId: payload.searchSessionId,
      offer: updated,
      searchMeta: result.searchMeta,
      providerMeta: result.providerMeta,
      warnings: result.warnings,
    });
  }

  if (request.method === "POST" && url.pathname === "/api/quotation") {
    const payload = await readPayload<QuotationPayload>(request);

    if (!payload.searchSessionId || !payload.offerId) {
      return json({ errors: ["searchSessionId and offerId are required."] }, { status: 400 });
    }

    const session = runtime.sessions.getSession(payload.searchSessionId);
    const offer = session ? runtime.sessions.getOffer(payload.searchSessionId, payload.offerId) : undefined;

    if (!session || !offer) {
      return json({ errors: ["Session or offer not found."] }, { status: 404 });
    }

    const quotationOffer = offer.priceConfidence === "validated"
      ? offer
      : runtime.sessions.updateOffer(
          payload.searchSessionId,
          (await runtime.orchestrator.reprice(
            session.request,
            payload.offerId,
            offer,
            {
              providerId: offer.providerSource,
              providerContext: session.providerContext,
            },
          )).offers[0] ?? offer,
        ) ?? offer;

    return json({
      searchSessionId: payload.searchSessionId,
      offer: quotationOffer,
      plainText: buildQuotationText(quotationOffer, session.request),
    });
  }

  return json({ error: "Not found" }, { status: 404 });
}
