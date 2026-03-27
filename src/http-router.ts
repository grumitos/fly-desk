import { buildCompareResponse } from "./core/comparison";
import { materializeSearchResponse } from "./core/orchestrator";
import { buildQuotationText } from "./core/quotation";
import {
  Cabin,
  CanonicalOffer,
  SearchMode,
  SearchRequest,
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
import { openUrlLocally } from "./local-browser";
import { getRuntime } from "./runtime";

type SortMode = "cheapest" | "fastest" | "best-value";

interface SearchPayload {
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

interface ComparePayload extends SessionPayload {
  offerIds?: string[];
}

interface QuotationPayload extends SessionPayload {
  offerId?: string;
}

interface LocalOpenPayload {
  url?: string;
  preferredBrowser?: "chrome" | "default";
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

function normalizeRequest(input?: SearchPayload["request"]): SearchRequest {
  const leg: Record<string, unknown> = input?.legs?.[0] ?? {};
  const filters = input?.filters ?? {};

  return {
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
    const suggestions = await suggestLocalAgilLocations(query, limit);
    return json({ query, suggestions });
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
    const normalizedRequest = normalizeRequest(payload.request);
    const errors = validateRequest(normalizedRequest);

    if (errors.length > 0) {
      return json({ errors }, { status: 400 });
    }

    const sortMode: SortMode = payload.sortMode === "cheapest" || payload.sortMode === "fastest"
      ? payload.sortMode
      : "cheapest";

    const draft = createLocalAgilSearchDraft(normalizedRequest, {
      exactProvider: "agil-local",
      coverageMode: normalizedRequest.coverageMode,
    });
    const job = runtime.sessions.createSearchJob({
      request: normalizedRequest,
      offers: draft.offers,
      allOffers: draft.allOffers ?? draft.offers,
      searchMeta: draft.searchMeta,
      providerMeta: draft.providerMeta,
      warnings: draft.warnings,
      sortMode,
      status: "running",
    });

    const onProgress = (partialResult: { offers: CanonicalOffer[]; warnings: string[]; partial: boolean }) => {
      const materialized = materializeSearchResponse(
        normalizedRequest,
        sortMode,
        "agil-local",
        partialResult,
      );

      runtime.sessions.updateSearchJob(job.id, (current) => ({
        ...current,
        offers: materialized.offers,
        allOffers: materialized.allOffers ?? materialized.offers,
        searchMeta: {
          ...materialized.searchMeta,
          requestedAt: current.searchMeta.requestedAt,
          partial: true,
          searchState: "search_partial",
        },
        providerMeta: materialized.providerMeta,
        warnings: materialized.warnings,
        status: "running",
        error: undefined,
      }));
    };

    const resolver = normalizedRequest.searchMode === "stay-range"
      ? resolveLocalAgilRangeProgressive(normalizedRequest, onProgress)
      : resolveLocalAgilExactProgressive(normalizedRequest, onProgress);

    void resolver.then((result) => {
      const materialized = materializeSearchResponse(
        normalizedRequest,
        sortMode,
        "agil-local",
        result,
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
        status: "completed",
        error: undefined,
      }));
    }).catch((error) => {
      runtime.sessions.updateSearchJob(job.id, (current) => ({
        ...current,
        status: "failed",
        error: error instanceof Error ? error.message : "Search job failed.",
        warnings: [
          ...current.warnings,
          error instanceof Error ? error.message : "Search job failed.",
        ],
        searchMeta: {
          ...current.searchMeta,
          completedAt: new Date().toISOString(),
          partial: true,
          searchState: "search_failed",
          warnings: [
            ...current.searchMeta.warnings,
            error instanceof Error ? error.message : "Search job failed.",
          ],
        },
      }));
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
    const normalizedRequest = normalizeRequest(payload.request);
    normalizedRequest.searchMode = "roundtrip-grid";

    const errors = validateRequest(normalizedRequest);
    if (errors.length > 0) {
      return json({ errors }, { status: 400 });
    }

    const draft = createLocalAgilMatrixDraft(normalizedRequest, {
      exactProvider: "agil-local",
      coverageMode: normalizedRequest.coverageMode,
    });
    const job = runtime.sessions.createMatrixJob({
      request: normalizedRequest,
      cells: draft.cells,
      axes: draft.axes,
      confidenceSummary: draft.confidenceSummary,
      recommendations: draft.recommendations,
      searchMeta: draft.searchMeta,
      providerMeta: draft.providerMeta,
      warnings: draft.warnings,
      status: "running",
    });

    void resolveLocalAgilMatrixProgressive(normalizedRequest, {
      ...draft,
      searchMeta: {
        ...draft.searchMeta,
        searchSessionId: job.id,
      },
    }, (cell) => {
      runtime.sessions.updateMatrixJob(job.id, (current) => {
        const cells = current.cells.map((entry) => entry.key === cell.key ? cell : entry);
        const confidenceSummary = cells.reduce<Record<string, number>>((acc, entry) => {
          acc[entry.confidence] = (acc[entry.confidence] ?? 0) + 1;
          return acc;
        }, {});

        return {
          ...current,
          cells,
          confidenceSummary,
        };
      });
    }).then((result) => {
      runtime.sessions.updateMatrixJob(job.id, (current) => ({
        ...current,
        cells: result.cells,
        axes: result.axes,
        confidenceSummary: result.confidenceSummary,
        recommendations: result.recommendations,
        searchMeta: {
          ...result.searchMeta,
          searchSessionId: current.id,
        },
        providerMeta: result.providerMeta,
        warnings: result.warnings,
        status: "completed",
        error: undefined,
      }));
    }).catch((error) => {
      runtime.sessions.updateMatrixJob(job.id, (current) => ({
        ...current,
        status: "failed",
        error: error instanceof Error ? error.message : "Matrix job failed.",
        warnings: [
          ...current.warnings,
          error instanceof Error ? error.message : "Matrix job failed.",
        ],
        searchMeta: {
          ...current.searchMeta,
          completedAt: new Date().toISOString(),
          partial: true,
          searchState: "search_failed",
          warnings: [
            ...current.searchMeta.warnings,
            error instanceof Error ? error.message : "Matrix job failed.",
          ],
        },
      }));
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

    const result = await runtime.orchestrator.reprice(session.request, payload.offerId, offer);
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

  if (request.method === "POST" && url.pathname === "/api/compare") {
    const payload = await readPayload<ComparePayload>(request);

    if (!payload.searchSessionId || !payload.offerIds || payload.offerIds.length === 0) {
      return json({ errors: ["searchSessionId and offerIds are required."] }, { status: 400 });
    }

    const session = runtime.sessions.getSession(payload.searchSessionId);
    if (!session) {
      return json({ errors: ["Session not found."] }, { status: 404 });
    }

    const offers = payload.offerIds
      .map((offerId) => session.offers.find((offer) => offer.id === offerId))
      .filter((offer): offer is CanonicalOffer => Boolean(offer));

    if (offers.length === 0) {
      return json({ errors: ["Offers not found in session."] }, { status: 404 });
    }

    return json(buildCompareResponse(offers));
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
          (await runtime.orchestrator.reprice(session.request, payload.offerId, offer)).offers[0] ?? offer,
        ) ?? offer;

    return json({
      searchSessionId: payload.searchSessionId,
      offer: quotationOffer,
      plainText: buildQuotationText(quotationOffer, session.request),
    });
  }

  return json({ error: "Not found" }, { status: 404 });
}
