import { materializeSearchResponse } from "./core/orchestrator";
import { buildMatrixConfidenceSummary } from "./core/matrix";
import { buildOfferScheduleGroups } from "./core/offer-schedule-groups";
import {
  buildCommercialQuotation,
  QUOTATION_FARE_FRESHNESS_MS,
  shouldIncludePenQuotationPrice,
} from "./core/quotation";
import { buildOfferSignature } from "./core/offer-signature";
import type { ProviderSearchResult } from "./core/provider";
import { timingSafeEqual } from "node:crypto";
import {
  CanonicalOffer,
  LocationSuggestion,
  MatrixCell,
  MatrixResponse,
  ProviderDiagnosticEvent,
  ProviderDiagnosticKind,
  ProviderDiagnostics,
  ProviderContext,
  ProviderId,
  QuotationUsdToPenRateInfo,
  SEARCH_CACHE_VERSION,
  SearchMeta,
  SearchRequest,
  SearchResponse,
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
  resolveAgilChromeLaunchOptions,
  suggestLocalAgilLocations,
} from "./local-agil";
import {
  COSTAMAR_CONCURRENCY,
  applyCostamarContextToBrandedSearchUrl,
  buildCostamarPurchasePaths,
  createLocalCostamarMatrixDraft,
  createLocalCostamarSearchDraft,
  getLastCostamarWarmupDiagnostics,
  isAllowedCostamarBrandedSearchLocation,
  resolveCostamarRedirectForRequest,
  safeCostamarRedirectFailureReason,
  resolveLocalCostamarExactProgressive,
  resolveLocalCostamarMatrixProgressive,
  resolveLocalCostamarRangeProgressive,
  suggestLocalCostamarLocations,
} from "./local-costamar";
import { openUrlLocally } from "./local-browser";
import {
  getCostamarTokenStatus,
  normalizeCostamarProviderContext,
  resolveProviderId,
  resolveUsableCostamarBrandedToken,
  verifyCostamarTokenLive,
} from "./provider-context";
import {
  resolveStandaloneUsdToPenRateInfo,
} from "./quotation-exchange-rate";
import { SearchAdmissionError, type SearchAdmissionKind } from "./search-admission";
import { resolveAcceptedApiAccessTokens } from "./service-auth";
import {
  isSearchServiceDelegationConfigured,
  isSearchServiceProxiedRequest,
  isSearchServiceRoute,
  maybeProxySearchServiceRequest,
} from "./search-service-client";
import { runProviderMatrixInWorker, runProviderSearchInWorker } from "./search-worker-client";
import { collectTempArtifactDiagnostics } from "./temp-artifacts";
import { getRuntime } from "./runtime";
import { normalizeLocationUsageSessionId } from "./location-usage-store";
import { LOCATION_SUGGESTION_CACHE_MAX_QUERY_CHARS } from "./location-suggestion-cache";
import { logPerfSpan, startPerfTimer } from "./perf";
import { DEFAULT_PROVIDER_STATUS_TTL_MS, providerPublicFailureMessage } from "./provider-status";
import {
  clearRedirectSessionCookie,
  clearWebSessionCookie,
  createRedirectSessionCookie,
  createRedirectSessionCookieForWebSession,
  createWebSessionCookie,
  getWebAuthConfigError,
  hasValidWebSession,
  isWebAuthEnabled,
  renderLoginPage,
  resolveWebTheme,
  shouldTrustReverseProxyLoopbackClient,
  shouldTrustLoopbackClient,
  verifyWebPassword,
} from "./web-auth";
import {
  checkWebLoginAdmission,
  recordFailedWebLogin,
  resetWebLoginAdmission,
} from "./login-admission";
import { type MatrixJobRecord, type SearchJobRecord } from "./session-store";
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
  migrationPlan?: boolean;
}

interface LocalOpenPayload {
  url?: string;
  preferredBrowser?: "chrome" | "default";
}

type LocalOpenUrlOpener = typeof openUrlLocally;
interface QuotationSource {
  sessionId: string;
  offerId: string;
  request: SearchRequest;
  providerContext?: ProviderContext;
  offer: CanonicalOffer;
  kind: "search" | "matrix";
  cellKey?: string;
}

type QuotationOfferValidator = (source: QuotationSource) => Promise<CanonicalOffer | undefined>;

let localOpenUrlOpener: LocalOpenUrlOpener = openUrlLocally;
let quotationOfferValidatorOverride: QuotationOfferValidator | undefined;

export function setQuotationOfferValidatorForTests(validator?: QuotationOfferValidator): void {
  quotationOfferValidatorOverride = validator;
}

interface ProgressiveSearchAdapter {
  createSearchDraft(request: SearchRequest, providerMeta: { exactProvider: ProviderId; coverageMode: SearchRequest["coverageMode"] }): SearchResponse;
  resolveExactProgressive(
    request: SearchRequest,
    providerContext: ProviderContext | undefined,
    onUpdate?: (result: ProviderSearchResult) => boolean | void,
  ): Promise<ProviderSearchResult>;
  resolveRangeProgressive(
    request: SearchRequest,
    providerContext: ProviderContext | undefined,
    onUpdate?: (result: ProviderSearchResult) => boolean | void,
  ): Promise<ProviderSearchResult>;
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
  fresh: boolean;
}

export function mergeProviderSearchProgress(
  current: ProviderSearchState | undefined,
  update: ProviderSearchResult,
): ProviderSearchState {
  if (update.incremental && current?.fresh) {
    current.offers.push(...update.offers);
    current.warnings.push(...update.warnings);
    current.partial = true;
    current.completed = false;
    return current;
  }

  return {
    offers: [...update.offers],
    warnings: [...update.warnings],
    partial: true,
    completed: false,
    fresh: true,
  };
}

export interface ProviderMatrixState {
  response: MatrixResponse;
  completed: boolean;
  cellIndex: Map<string, number>;
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

export const SEARCH_REVALIDATION_CACHE_DEFAULT_TTL_MS = 4 * 60 * 60 * 1000;
export const SEARCH_REVALIDATION_CACHE_TTL_MS = (() => {
  const raw = Number(process.env.SEARCH_REVALIDATION_CACHE_TTL_MS ?? SEARCH_REVALIDATION_CACHE_DEFAULT_TTL_MS);
  return Number.isFinite(raw) && raw >= 0
    ? raw
    : SEARCH_REVALIDATION_CACHE_DEFAULT_TTL_MS;
})();
const SEARCH_REVALIDATION_CACHE_WARNING = "Mostrando resultados cacheados mientras actualizamos en segundo plano.";
const SEARCH_PROGRESS_SYNC_INTERVAL_MS = 900;
const SEARCH_CANCELLED_WARNING = "Search cancelled by user.";
const SEARCH_REFRESH_CANCELLED_WARNING = "Search stopped because the page was refreshed.";
const DEFAULT_COSTAMAR_REDIRECT_TOTAL_TIMEOUT_MS = 55_000;
const MAX_COSTAMAR_REDIRECT_TOTAL_TIMEOUT_MS = 240_000;
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

function shouldRunBackgroundSearchJobs(): boolean {
  return process.env.FLY_DESK_DISABLE_BACKGROUND_SEARCH_JOBS !== "1";
}

function scheduleBackgroundSearchJob(callback: () => void, delayMs: number): void {
  const timer = setTimeout(callback, delayMs);
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}

interface ProgressSyncController {
  mark: () => void;
  flush: () => void;
  dispose: () => void;
}

const pendingProgressSyncs = new Map<string, ProgressSyncController>();

function progressSyncKey(kind: "search" | "matrix", jobId: string): string {
  return `${kind}:${jobId}`;
}

export function createTrailingProgressSync(
  searchMode: SearchRequest["searchMode"],
  sync: () => void,
  intervalMs = SEARCH_PROGRESS_SYNC_INTERVAL_MS,
): ProgressSyncController {
  let dirty = false;
  let lastSyncAt = Date.now();
  let progressCount = 0;
  let nextPublishCount = 1;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!dirty) {
      return;
    }

    dirty = false;
    lastSyncAt = Date.now();
    sync();
    nextPublishCount = Math.max(progressCount + 1, progressCount * 2);
  };

  const mark = () => {
    progressCount += 1;
    dirty = true;
    if (searchMode === "exact" || progressCount < nextPublishCount) {
      return;
    }

    const remainingMs = Math.max(0, intervalMs - (Date.now() - lastSyncAt));
    if (remainingMs === 0) {
      flush();
      return;
    }
    if (timer) {
      return;
    }

    timer = setTimeout(flush, remainingMs);
    if (typeof timer === "object" && timer && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
  };

  return {
    mark,
    flush,
    dispose: () => {
      dirty = false;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

function registerPendingProgressSync(
  kind: "search" | "matrix",
  jobId: string,
  controller: ProgressSyncController,
): void {
  pendingProgressSyncs.set(progressSyncKey(kind, jobId), controller);
}

function disposePendingProgressSync(kind: "search" | "matrix", jobId: string, flush = false): void {
  const key = progressSyncKey(kind, jobId);
  const controller = pendingProgressSyncs.get(key);
  if (!controller) {
    return;
  }

  if (flush) {
    controller.flush();
  }
  controller.dispose();
  pendingProgressSyncs.delete(key);
}

export function flushPendingProgressForShutdown(): void {
  for (const [key, controller] of pendingProgressSyncs) {
    controller.flush();
    controller.dispose();
    pendingProgressSyncs.delete(key);
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
    return `workerProcesses=${shouldUseSearchWorkerProcesses() ? 1 : 0} rangeConcurrency=${COSTAMAR_CONCURRENCY.rangeSearch}`;
  }

  return `workerProcesses=${shouldUseSearchWorkerProcesses() ? 1 : 0}`;
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function costamarRedirectBlockedResponse(reason?: string): Response {
  const reasonText = reason?.trim() ? escapeHtml(reason.trim()) : "No se pudo validar ni renovar el redirect de Click and Book Plus.";
  return html(`<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Renueva la autenticación de Click and Book Plus</title>
    <style>
      :root { color-scheme: light; }
      * {
        box-sizing: border-box;
      }
      html {
        min-height: 100%;
      }
      body {
        margin: 0;
        min-height: 100dvh;
        overflow: hidden;
        display: grid;
        place-items: center;
        padding: 20px;
        font-family: "Segoe UI", Arial, sans-serif;
        background: #f8f8f6;
        color: #2d2a26;
      }
      main {
        width: min(560px, 100%);
        max-width: 560px;
      }
      section {
        background: rgba(255, 255, 255, 0.92);
        border: 1px solid rgba(112, 77, 31, 0.12);
        border-radius: 12px;
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
      @media (max-width: 480px) {
        body {
          padding: 16px;
        }
        section {
          padding: 20px;
        }
        h1 {
          font-size: 24px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>Renueva la autenticación de Click and Book Plus</h1>
        <p>Fly Desk no encontro un redirect verificado para abrir esta busqueda en Click and Book Plus.</p>
        <p><strong>Motivo:</strong> ${reasonText}</p>
        <p>Abre Click and Book Plus B2B/Chrome, vuelve a autenticarte y reintenta desde Fly Desk.</p>
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

function costamarRedirectTotalTimeoutMs(): number {
  const configured = Number(
    process.env.CBPLUS_REDIRECT_TOTAL_TIMEOUT_MS?.trim()
      ?? process.env.COSTAMAR_REDIRECT_TOTAL_TIMEOUT_MS
      ?? DEFAULT_COSTAMAR_REDIRECT_TOTAL_TIMEOUT_MS,
  );
  if (!Number.isFinite(configured)) {
    return DEFAULT_COSTAMAR_REDIRECT_TOTAL_TIMEOUT_MS;
  }

  return Math.max(
    1_000,
    Math.min(MAX_COSTAMAR_REDIRECT_TOTAL_TIMEOUT_MS, Math.trunc(configured)),
  );
}

async function withCostamarRedirectTotalTimeout<T>(promise: Promise<T>): Promise<T> {
  const timeoutMs = costamarRedirectTotalTimeoutMs();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`La validacion del redirect de Click and Book Plus tardo mas de ${timeoutMs}ms.`));
        }, timeoutMs);
        if (typeof timeout === "object" && timeout && "unref" in timeout) {
          (timeout as { unref: () => void }).unref();
        }
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
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

function currentSearchMeta(searchMeta: SearchMeta): SearchMeta {
  return {
    ...searchMeta,
    cacheVersion: SEARCH_CACHE_VERSION,
  };
}

export function shouldPersistProgressSnapshot(lastPersistedCount: number, currentCount: number): boolean {
  return currentCount > 0
    && (lastPersistedCount <= 0 || currentCount >= lastPersistedCount * 2);
}

function createSearchDraftResponse(
  request: SearchRequest,
  providerIds: ProviderId[],
): SearchResponse {
  const requestedAt = new Date().toISOString();
  const warning = providerIds.length > 1
    ? "Consultando Agil y Click and Book Plus."
    : providerIds[0] === "costamar"
      ? "Consultando Click and Book Plus."
      : "Consultando Agil.";

  return {
    offers: [],
    allOffers: [],
    searchMeta: currentSearchMeta({
      requestedAt,
      completedAt: requestedAt,
      providersUsed: providerIds,
      warnings: [warning],
      partial: true,
      searchState: "search_partial",
    }),
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
  const freshOffers = providerIds.flatMap((providerId) => {
    const state = states.get(providerId);
    return state?.fresh ? state.offers : [];
  });
  const preparedFreshOffers = prepareOffersForQuotation(request, freshOffers);
  const preparedBySource = new Map(freshOffers.map((offer, index) => [offer, preparedFreshOffers[index]]));
  const materialized = materializeSearchResponse(
    request,
    sortMode,
    providerIds[0],
    {
      ...aggregated,
      offers: aggregated.offers.map((offer) => preparedBySource.get(offer) ?? stripQuotationPreparation(offer)),
    },
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
  providerRanks: ReadonlyMap<ProviderId, number>,
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

  return (providerRanks.get(left.providerSource) ?? Number.MAX_SAFE_INTEGER)
    - (providerRanks.get(right.providerSource) ?? Number.MAX_SAFE_INTEGER);
}

function pickAggregatedMatrixCell(
  cells: MatrixCell[],
  providerRanks: ReadonlyMap<ProviderId, number>,
): MatrixCell | undefined {
  let selected = cells[0];
  for (let index = 1; index < cells.length; index += 1) {
    if (compareAggregatedMatrixCells(cells[index]!, selected!, providerRanks) < 0) {
      selected = cells[index];
    }
  }
  return selected;
}

export function materializeAggregatedMatrixResponse(
  request: SearchRequest,
  providerIds: ProviderId[],
  states: Map<ProviderId, ProviderMatrixState>,
): MatrixResponse {
  const orderedKeys: string[] = [];
  const seenKeys = new Set<string>();
  const providerRanks = new Map(providerIds.map((providerId, index) => [providerId, index]));

  providerIds.forEach((providerId) => {
    const response = states.get(providerId)?.response;
    response?.cells.forEach((cell) => {
      if (!seenKeys.has(cell.key)) {
        seenKeys.add(cell.key);
        orderedKeys.push(cell.key);
      }
    });
  });

  const selectedCells = orderedKeys.flatMap((key) => {
    const candidates = providerIds
      .map((providerId) => {
        const state = states.get(providerId);
        if (!state) {
          return undefined;
        }
        const index = state.cellIndex.get(key);
        return index === undefined ? undefined : state.response.cells[index];
      })
      .filter((cell): cell is MatrixCell => Boolean(cell));
    const selected = pickAggregatedMatrixCell(candidates, providerRanks);
    return selected ? [selected] : [];
  });
  const matrixOffers = providerIds.flatMap((providerId) =>
    states.get(providerId)?.response.cells.flatMap((cell) => cell.offer ? [cell.offer] : []) ?? []
  );
  const preparedOffers = prepareOffersForQuotation(
    request,
    selectedCells.flatMap((cell) => cell.offer ? [cell.offer] : []),
    matrixOffers,
  );
  let preparedOfferIndex = 0;
  const cells = selectedCells.map((cell) => cell.offer
    ? { ...cell, offer: preparedOffers[preparedOfferIndex++] }
    : cell);

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
    searchMeta: currentSearchMeta({
      requestedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      providersUsed: providerIds,
      warnings,
      partial,
      searchState: partial ? "search_partial" : "search_live",
    }),
    providerMeta: {
      exactProvider: providerIds[0],
      coverageMode: request.coverageMode,
    },
    warnings,
  };
}

export function buildMatrixCellIndex(cells: readonly MatrixCell[]): Map<string, number> {
  const index = new Map<string, number>();
  cells.forEach((cell, position) => {
    if (!index.has(cell.key)) {
      index.set(cell.key, position);
    }
  });
  return index;
}

export function updateMatrixDraftCell(
  response: MatrixResponse,
  cell: MatrixCell,
  cellIndex: ReadonlyMap<string, number>,
): MatrixResponse {
  const position = cellIndex.get(cell.key);
  const previous = position === undefined ? undefined : response.cells[position];
  if (position === undefined || !previous) {
    return response;
  }

  response.cells[position] = cell;
  if (previous.confidence !== cell.confidence) {
    const previousCount = (response.confidenceSummary[previous.confidence] ?? 0) - 1;
    if (previousCount > 0) {
      response.confidenceSummary[previous.confidence] = previousCount;
    } else {
      delete response.confidenceSummary[previous.confidence];
    }
    response.confidenceSummary[cell.confidence] = (response.confidenceSummary[cell.confidence] ?? 0) + 1;
  }
  return response;
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
    searchMeta: currentSearchMeta({
      ...response.searchMeta,
      completedAt: new Date().toISOString(),
      warnings,
      partial: true,
      searchState: "search_partial",
    }),
    warnings,
  };
}

function getProgressiveAdapter(providerId: ProviderId): ProgressiveSearchAdapter {
  return PROGRESSIVE_ADAPTERS[providerId];
}

function shouldUseSearchWorkerProcesses(): boolean {
  return process.env.FLY_DESK_SEARCH_WORKER_PROCESSES !== "0";
}

function shouldContinueProviderWork(shouldContinue: (() => boolean) | undefined): boolean {
  try {
    return shouldContinue ? shouldContinue() : true;
  } catch {
    return false;
  }
}

function assertProviderWorkStillRunning(shouldContinue: (() => boolean) | undefined): void {
  if (!shouldContinueProviderWork(shouldContinue)) {
    throw new Error("Search worker cancelled.");
  }
}

async function resolveProviderSearchProgressive(
  providerId: ProviderId,
  request: SearchRequest,
  providerContext: ProviderContext | undefined,
  onProgress: (result: ProviderSearchResult) => boolean | void,
  diagnostics: ProviderDiagnostics | undefined,
  onProviderEvent: ((event: ProviderDiagnosticEvent) => void) | undefined,
  shouldContinue: (() => boolean) | undefined,
): Promise<ProviderSearchResult> {
  const kind = request.searchMode === "stay-range" ? "range" : "exact";
  if (shouldUseSearchWorkerProcesses()) {
    return runProviderSearchInWorker({
      kind,
      providerId,
      request,
      providerContext,
      onProgress,
      onProviderEvent,
      shouldContinue,
    });
  }

  const adapter = getProgressiveAdapter(providerId);
  const guardedOnProgress = (result: ProviderSearchResult) => {
    if (!shouldContinueProviderWork(shouldContinue)) {
      return false;
    }

    const keepGoing = onProgress(result);
    return keepGoing !== false && shouldContinueProviderWork(shouldContinue);
  };
  const run = async () => {
    assertProviderWorkStillRunning(shouldContinue);
    recordProviderDiagnosticEvent("provider_started");
    const result = await (kind === "range"
      ? adapter.resolveRangeProgressive(request, providerContext, guardedOnProgress)
      : adapter.resolveExactProgressive(request, providerContext, guardedOnProgress));
    assertProviderWorkStillRunning(shouldContinue);
    return result;
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
  shouldContinue: (() => boolean) | undefined,
): Promise<MatrixResponse> {
  if (shouldUseSearchWorkerProcesses()) {
    return runProviderMatrixInWorker({
      providerId,
      request,
      providerContext,
      draft,
      onCellResolved,
      onProviderEvent,
      shouldContinue,
    });
  }

  const run = async () => {
    assertProviderWorkStillRunning(shouldContinue);
    recordProviderDiagnosticEvent("provider_started");
    const result = await getProgressiveAdapter(providerId).resolveMatrixProgressive(
      request,
      providerContext,
      draft,
      (cell) => {
        if (!shouldContinueProviderWork(shouldContinue)) {
          return false;
        }

        const keepGoing = onCellResolved(cell);
        return keepGoing !== false && shouldContinueProviderWork(shouldContinue);
      },
    );
    assertProviderWorkStillRunning(shouldContinue);
    return result;
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
  if (!shouldTrustLoopbackClient() || request.headers.get("x-flydesk-client-loopback") !== "1") {
    return false;
  }

  if (hasForwardedClientMarker(request) && !shouldTrustReverseProxyLoopbackClient()) {
    return false;
  }

  return true;
}

function hasForwardedClientMarker(request: Request): boolean {
  return Boolean(
    request.headers.get("x-forwarded-for")?.trim()
      || request.headers.get("forwarded")?.trim()
      || request.headers.get("x-real-ip")?.trim(),
  );
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

function hasValidApiAccessToken(request: Request, expectedTokens: readonly string[]): boolean {
  const providedToken = resolveProvidedApiAccessToken(request);
  if (!providedToken) {
    return false;
  }

  const provided = Buffer.from(providedToken, "utf8");

  return expectedTokens.some((expectedToken) => {
    const expected = Buffer.from(expectedToken, "utf8");
    if (expected.length !== provided.length) {
      return false;
    }

    return timingSafeEqual(expected, provided);
  });
}

function isTrustedApiRequest(request: Request): boolean {
  if (isTrustedLocalRequest(request)) {
    return true;
  }

  if (hasValidWebSession(request)) {
    return true;
  }

  const tokens = resolveAcceptedApiAccessTokens();
  return tokens.length > 0 ? hasValidApiAccessToken(request, tokens) : false;
}

function isOfferValidatedForQuotation(offer: CanonicalOffer): boolean {
  if (offer.priceConfidence !== "validated" || offer.priceStatus !== "verified") {
    return false;
  }

  const verifiedAt = Date.parse(offer.priceVerifiedAt ?? "");
  const ageMs = Date.now() - verifiedAt;
  return Number.isFinite(verifiedAt) && ageMs >= 0 && ageMs <= QUOTATION_FARE_FRESHNESS_MS;
}

function stripQuotationPreparation(offer: CanonicalOffer): CanonicalOffer {
  if (!offer.quotationPreparedAt) {
    return offer;
  }

  const next: CanonicalOffer = { ...offer };
  delete next.quotationPreparedAt;
  return next;
}

type QuotationRateResolver = (
  offer: CanonicalOffer,
  options?: { final?: boolean },
) => Promise<QuotationUsdToPenRateInfo | undefined>;

function isUsableUsdToPenRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 2 && value <= 8;
}

function offerNeedsQuotationRate(offer: CanonicalOffer, request: SearchRequest): boolean {
  const currencyCode = String(offer.price.total.currencyCode ?? "").trim().toUpperCase();
  const domesticPeru = shouldIncludePenQuotationPrice(offer, request);
  return domesticPeru ? currencyCode === "USD" : currencyCode === "PEN";
}

export function prepareOffersForQuotation(
  request: SearchRequest,
  offers: CanonicalOffer[],
  rateCandidates: readonly CanonicalOffer[] = offers,
): CanonicalOffer[] {
  const sharedRate = rateCandidates.map((offer) => offer.usdToPenRate).find(isUsableUsdToPenRate);
  const quotationPreparedAt = new Date().toISOString();

  return offers.map((offer) => {
    const usdToPenRate = isUsableUsdToPenRate(offer.usdToPenRate) ? offer.usdToPenRate : sharedRate;
    const prepared = usdToPenRate === undefined ? { ...offer } : { ...offer, usdToPenRate };
    if (offerNeedsQuotationRate(prepared, request) && usdToPenRate === undefined) {
      delete prepared.quotationPreparedAt;
      return prepared;
    }
    return {
      ...prepared,
      quotationPreparedAt: offer.quotationPreparedAt ?? quotationPreparedAt,
    };
  });
}

export async function resolveQuotationReadyOffers(
  request: SearchRequest,
  offers: CanonicalOffer[],
  resolveRate: QuotationRateResolver = (offer) => resolveStandaloneUsdToPenRateInfo(offer),
): Promise<CanonicalOffer[]> {
  const prepared = prepareOffersForQuotation(request, offers);
  const unresolved = prepared.find((offer) => offerNeedsQuotationRate(offer, request) && !offer.quotationPreparedAt);
  if (!unresolved) {
    return prepared;
  }

  const rateInfo = await resolveRate(unresolved, { final: true }).catch(() => undefined);
  if (!isUsableUsdToPenRate(rateInfo?.rate)) {
    return prepared;
  }

  return prepareOffersForQuotation(request, offers.map((offer) => ({ ...offer, usdToPenRate: rateInfo.rate })));
}

export function createSharedQuotationRateResolver(
  lookup: (offer: CanonicalOffer) => Promise<QuotationUsdToPenRateInfo | undefined> = resolveStandaloneUsdToPenRateInfo,
): QuotationRateResolver {
  let pending: Promise<QuotationUsdToPenRateInfo | undefined> | undefined;
  let prefetched = false;
  let finalRetryUsed = false;
  const startLookup = (offer: CanonicalOffer) => lookup(offer).catch(() => undefined);

  return async (offer, options) => {
    if (!pending) {
      pending = startLookup(offer);
      prefetched = !options?.final;
    }

    const rateInfo = await pending;
    if (rateInfo || !options?.final || !prefetched || finalRetryUsed) {
      return rateInfo;
    }

    finalRetryUsed = true;
    pending = startLookup(offer);
    return pending;
  };
}

function startQuotationRateResolution(
  request: SearchRequest,
  offers: CanonicalOffer[],
  resolveRate: QuotationRateResolver,
): void {
  if (offers.some((offer) => isUsableUsdToPenRate(offer.usdToPenRate))) {
    return;
  }
  const unresolved = offers.find((offer) => offerNeedsQuotationRate(offer, request));
  if (unresolved) {
    void resolveRate(unresolved);
  }
}

function offerFirstSegment(offer: CanonicalOffer): CanonicalOffer["itineraries"][number]["segments"][number] | undefined {
  const outbound = offer.itineraries.find((itinerary) => itinerary.direction === "outbound") ?? offer.itineraries[0];
  return outbound?.segments[0];
}

function offerInboundFirstSegment(offer: CanonicalOffer): CanonicalOffer["itineraries"][number]["segments"][number] | undefined {
  return offer.itineraries.find((itinerary) => itinerary.direction === "inbound")?.segments[0];
}

function offerDepartureDay(offer: CanonicalOffer): string | undefined {
  return offerFirstSegment(offer)?.departureAt?.slice(0, 10);
}

function offerReturnDay(offer: CanonicalOffer): string | undefined {
  return offerInboundFirstSegment(offer)?.departureAt?.slice(0, 10);
}

function buildExactRequestFromOffer(baseRequest: SearchRequest, offer: CanonicalOffer): SearchRequest | undefined {
  const departureDate = offerDepartureDay(offer);
  const returnDate = offer.tripType === "round-trip" ? offerReturnDay(offer) : undefined;
  const baseLeg = baseRequest.legs[0];

  if (!departureDate || !baseLeg) {
    return undefined;
  }

  if (offer.tripType === "round-trip" && !returnDate) {
    return undefined;
  }

  return {
    ...baseRequest,
    providerId: offer.providerSource,
    tripType: offer.tripType,
    searchMode: "exact",
    legs: [
      {
        origin: baseLeg.origin ?? offer.origin,
        destination: baseLeg.destination ?? offer.destination,
        originLabel: baseLeg.originLabel,
        destinationLabel: baseLeg.destinationLabel,
        departureDate,
        returnDate: offer.tripType === "round-trip" ? returnDate : undefined,
      },
    ],
  };
}

function buildExactRequestFromMatrixCell(baseRequest: SearchRequest, cell: MatrixCell): SearchRequest | undefined {
  if (cell.derivedRequest) {
    return {
      ...cell.derivedRequest,
      providerId: cell.providerSource,
      searchMode: "exact",
    };
  }

  const baseLeg = baseRequest.legs[0];
  if (!baseLeg || !cell.departureDate) {
    return undefined;
  }

  if (baseRequest.tripType === "round-trip" && !cell.returnDate) {
    return undefined;
  }

  return {
    ...baseRequest,
    providerId: cell.providerSource,
    searchMode: "exact",
    legs: [
      {
        origin: baseLeg.origin,
        destination: baseLeg.destination,
        originLabel: baseLeg.originLabel,
        destinationLabel: baseLeg.destinationLabel,
        departureDate: cell.departureDate,
        returnDate: baseRequest.tripType === "round-trip" ? cell.returnDate : undefined,
      },
    ],
  };
}

function resolveSearchQuotationSource(
  runtime: ReturnType<typeof getRuntime>,
  sessionId: string,
  offerId: string,
): QuotationSource | undefined {
  const session = runtime.sessions.getSession(sessionId);
  const offer = session ? runtime.sessions.getOffer(sessionId, offerId) : undefined;

  if (!session || !offer) {
    return undefined;
  }

  return {
    sessionId,
    offerId,
    request: session.request,
    providerContext: session.providerContext,
    offer,
    kind: "search",
  };
}

function resolveMatrixQuotationSource(
  runtime: ReturnType<typeof getRuntime>,
  sessionId: string,
  offerId: string,
): QuotationSource | undefined {
  const job = runtime.sessions.getMatrixJob(sessionId);
  const cell = job?.cells.find((candidate) => candidate.key === offerId || candidate.offer?.id === offerId);
  if (!job || !cell) {
    return undefined;
  }

  const request = buildExactRequestFromMatrixCell(job.request, cell);
  const offer = cell.offer;
  if (!request || !offer) {
    return undefined;
  }

  return {
    sessionId,
    offerId,
    request,
    providerContext: job.providerContext,
    offer,
    kind: "matrix",
    cellKey: cell.key,
  };
}

function resolveQuotationSource(
  runtime: ReturnType<typeof getRuntime>,
  sessionId: string,
  offerId: string,
): QuotationSource | undefined {
  return resolveSearchQuotationSource(runtime, sessionId, offerId)
    ?? resolveMatrixQuotationSource(runtime, sessionId, offerId);
}

function quotationCandidateScore(candidate: CanonicalOffer, original: CanonicalOffer): number {
  let score = 0;
  if (candidate.id === original.id) score += 100;
  if (candidate.providerOfferRef && candidate.providerOfferRef === original.providerOfferRef) score += 80;
  if (candidate.signature && candidate.signature === original.signature) score += 60;
  if ((candidate.validatingCarrier ?? candidate.mainCarrier) === (original.validatingCarrier ?? original.mainCarrier)) score += 30;
  if (candidate.origin === original.origin && candidate.destination === original.destination) score += 20;
  if (offerDepartureDay(candidate) === offerDepartureDay(original)) score += 20;
  if (offerReturnDay(candidate) === offerReturnDay(original)) score += 10;
  return score;
}

function pickQuotationValidationOffer(
  offers: CanonicalOffer[],
  original: CanonicalOffer,
): CanonicalOffer | undefined {
  return offers
    .filter((candidate) => candidate.providerSource === original.providerSource)
    .filter((candidate) => buildOfferSignature(candidate) === buildOfferSignature(original))
    .filter((candidate) => candidate.origin === original.origin && candidate.destination === original.destination)
    .filter((candidate) => offerDepartureDay(candidate) === offerDepartureDay(original))
    .filter((candidate) => original.tripType !== "round-trip" || offerReturnDay(candidate) === offerReturnDay(original))
    .sort((left, right) => quotationCandidateScore(right, original) - quotationCandidateScore(left, original)
      || left.price.total.amount - right.price.total.amount)[0];
}

function markOfferValidatedForQuotation(offer: CanonicalOffer): CanonicalOffer {
  return {
    ...offer,
    priceConfidence: "validated",
    priceStatus: "verified",
    priceVerifiedAt: new Date().toISOString(),
  };
}

async function validateQuotationOfferAgainstProvider(source: QuotationSource): Promise<CanonicalOffer | undefined> {
  if (source.offer.providerSource === "costamar" && !source.providerContext?.costamar) {
    return undefined;
  }

  const validationRequest = buildExactRequestFromOffer(source.request, source.offer);
  if (!validationRequest) {
    return undefined;
  }

  const result = await resolveProviderSearchProgressive(
    source.offer.providerSource,
    validationRequest,
    source.providerContext,
    () => true,
    undefined,
    undefined,
    undefined,
  );
  const matched = pickQuotationValidationOffer(result.offers, source.offer);
  return matched ? markOfferValidatedForQuotation(matched) : undefined;
}

async function resolveValidatedQuotationOffer(source: QuotationSource): Promise<CanonicalOffer | undefined> {
  if (isOfferValidatedForQuotation(source.offer)) {
    return source.offer;
  }

  const validator = quotationOfferValidatorOverride ?? validateQuotationOfferAgainstProvider;
  const validated = await validator(source);
  if (!validated || buildOfferSignature(validated) !== buildOfferSignature(source.offer)) {
    return undefined;
  }

  return markOfferValidatedForQuotation({
    ...validated,
    // Provider normalizers include the current price in their generated ID.
    // Keep the session-facing ID stable so the refreshed exact flight replaces
    // the selected record instead of becoming an unreferenced response only.
    id: source.offer.id,
  });
}

function storeValidatedQuotationOffer(
  runtime: ReturnType<typeof getRuntime>,
  source: QuotationSource,
  validatedOffer: CanonicalOffer,
): CanonicalOffer {
  if (source.kind === "search") {
    return runtime.sessions.updateOffer(source.sessionId, validatedOffer) ?? validatedOffer;
  }

  if (!source.cellKey) {
    return validatedOffer;
  }

  const updated = runtime.sessions.updateMatrixJob(source.sessionId, (current: MatrixJobRecord) => ({
    ...current,
    cells: current.cells.map((cell) => cell.key === source.cellKey
      ? {
          ...cell,
          price: validatedOffer.price.total,
          confidence: "validated",
          selectable: true,
          requiresRequery: false,
          stateCode: "ok",
          providerSource: validatedOffer.providerSource,
          purchasePaths: validatedOffer.purchasePaths,
          offer: validatedOffer,
        }
      : cell),
  }));

  return updated?.cells.find((cell) => cell.key === source.cellKey)?.offer ?? validatedOffer;
}

function apiAuthRequiredResponse(): Response {
  if (isWebAuthEnabled()) {
    return json(
      { error: "Authentication required." },
      {
        status: 401,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }

  return json(
    { error: "This endpoint requires localhost access or a valid API token." },
    { status: 403 },
  );
}

async function readLoginPassword(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const payload = await request.json() as { password?: unknown };
    return typeof payload.password === "string" ? payload.password : "";
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(await request.text());
    return form.get("password") ?? "";
  }

  return "";
}

async function handleWebLogin(request: Request, options: { jsonResponse?: boolean } = {}): Promise<Response> {
  if (!isWebAuthEnabled()) {
    return json({ error: "Web authentication is disabled." }, { status: 404 });
  }

  const configError = getWebAuthConfigError();
  if (configError) {
    return json(
      { error: "Web authentication is not configured." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const password = await readLoginPassword(request);
  const loginClientKey = request.headers.get("x-flydesk-client-address")?.trim() || "unknown";
  const admission = checkWebLoginAdmission(loginClientKey);
  if (!admission.allowed) {
    const headers = {
      "Cache-Control": "no-store",
      "Retry-After": String(admission.retryAfterSeconds),
    };
    if (options.jsonResponse) {
      return json(
        { error: "Too many login attempts. Try again later." },
        { status: 429, headers },
      );
    }
    return new Response(
      renderLoginPage("Demasiados intentos. Intenta de nuevo mas tarde.", resolveWebTheme(request)),
      {
        status: 429,
        headers: {
          ...headers,
          "Content-Type": "text/html; charset=utf-8",
        },
      },
    );
  }

  const verification = verifyWebPassword(password);
  if (!verification.ok) {
    recordFailedWebLogin(loginClientKey);
    if (options.jsonResponse) {
      return json(
        { error: "Invalid password." },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }

    return new Response(null, {
      status: 303,
      headers: {
        Location: "/login?error=1",
        "Cache-Control": "no-store",
      },
    });
  }

  resetWebLoginAdmission(loginClientKey);
  const sessionCookie = createWebSessionCookie(request);
  const redirectSessionCookie = createRedirectSessionCookie(request);
  if (options.jsonResponse) {
    const response = json(
      { ok: true },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
    response.headers.append("Set-Cookie", sessionCookie);
    response.headers.append("Set-Cookie", redirectSessionCookie);
    return response;
  }

  const response = new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Cache-Control": "no-store",
    },
  });
  response.headers.append("Set-Cookie", sessionCookie);
  response.headers.append("Set-Cookie", redirectSessionCookie);
  return response;
}

function handleWebLogout(request: Request, options: { jsonResponse?: boolean } = {}): Response {
  const cookie = clearWebSessionCookie(request);
  const redirectCookie = clearRedirectSessionCookie(request);
  if (options.jsonResponse) {
    const response = json(
      { ok: true },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
    response.headers.append("Set-Cookie", cookie);
    response.headers.append("Set-Cookie", redirectCookie);
    return response;
  }

  const response = new Response(null, {
    status: 303,
    headers: {
      Location: "/login",
      "Cache-Control": "no-store",
    },
  });
  response.headers.append("Set-Cookie", cookie);
  response.headers.append("Set-Cookie", redirectCookie);
  return response;
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
  return normalizeLocationUsageSessionId(value);
}

function matrixCellHasResult(cell: MatrixCell): boolean {
  return Boolean(cell.offer)
    || typeof cell.price?.amount === "number"
    || Boolean(cell.purchasePaths?.length);
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
    cells: job.cells.filter(matrixCellHasResult),
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
    offers: cachedJob.offers.map(stripQuotationPreparation),
    allOffers: cachedJob.allOffers.map(stripQuotationPreparation),
    searchMeta: currentSearchMeta({
      requestedAt: now,
      completedAt: now,
      providersUsed: providerIds,
      warnings,
      partial: true,
      searchState: "search_cached",
    }),
    providerMeta: {
      exactProvider: providerIds[0],
      coverageMode: request.coverageMode,
    },
    warnings,
  };
}

function createCachedMatrixDraftResponse(
  draft: MatrixResponse,
  providerIds: ProviderId[],
  cachedJob: MatrixJobRecord,
): MatrixResponse {
  const now = new Date().toISOString();
  const warnings = uniqueStrings([
    ...(cachedJob.searchMeta.warnings ?? []),
    ...cachedJob.warnings,
    SEARCH_REVALIDATION_CACHE_WARNING,
  ]);

  return {
    ...draft,
    cells: draft.cells.map(stripCachedMatrixCellQuotation),
    searchMeta: currentSearchMeta({
      ...draft.searchMeta,
      requestedAt: now,
      completedAt: now,
      providersUsed: providerIds,
      warnings,
      partial: true,
      searchState: "search_cached",
    }),
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

function isIsoDateValue(value: string | undefined): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function passengerCountFromPath(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function exactCostamarRequestFromFallback(fallback: SearchRequest | undefined): SearchRequest | undefined {
  const leg = fallback?.legs[0];
  if (!fallback || !leg || fallback.tripType === "multi-city" || !isIsoDateValue(leg.departureDate)) {
    return undefined;
  }

  if (fallback.tripType === "round-trip" && !isIsoDateValue(leg.returnDate)) {
    return undefined;
  }

  return {
    ...fallback,
    providerId: "costamar",
    searchMode: "exact",
    flexibleMode: undefined,
    legs: [
      {
        ...leg,
        departureStart: undefined,
        departureEnd: undefined,
        returnStart: undefined,
        returnEnd: undefined,
        stayNights: undefined,
        minNights: undefined,
        maxNights: undefined,
      },
    ],
  };
}

function costamarRedirectRequestFromUrl(
  location: string,
  fallback: SearchRequest | undefined,
): SearchRequest | undefined {
  try {
    const parsed = new URL(location);
    const pathParts = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
    const markerIndex = pathParts.lastIndexOf("b");
    if (markerIndex < 0) {
      return exactCostamarRequestFromFallback(fallback);
    }

    const parts = pathParts.slice(markerIndex + 1);
    if (parts.length !== 6 && parts.length !== 7) {
      return exactCostamarRequestFromFallback(fallback);
    }

    const isRoundTrip = parts.length === 7;
    const origin = parts[0]?.trim().toUpperCase();
    const destination = parts[1]?.trim().toUpperCase();
    const departureDate = parts[2]?.trim();
    const returnDate = isRoundTrip ? parts[3]?.trim() : undefined;
    const passengerOffset = isRoundTrip ? 4 : 3;
    const fallbackPassengers = fallback?.passengers ?? { adults: 1, children: 0, infants: 0 };

    if (!origin || !destination || !isIsoDateValue(departureDate)) {
      return exactCostamarRequestFromFallback(fallback);
    }

    if (isRoundTrip && !isIsoDateValue(returnDate)) {
      return exactCostamarRequestFromFallback(fallback);
    }

    const fallbackLeg = fallback?.legs[0];
    return {
      providerId: "costamar",
      tripType: isRoundTrip ? "round-trip" : "one-way",
      searchMode: "exact",
      legs: [
        {
          ...(fallbackLeg ?? {}),
          origin,
          destination,
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
      passengers: {
        adults: passengerCountFromPath(parts[passengerOffset], fallbackPassengers.adults || 1),
        children: passengerCountFromPath(parts[passengerOffset + 1], fallbackPassengers.children || 0),
        infants: passengerCountFromPath(parts[passengerOffset + 2], fallbackPassengers.infants || 0),
      },
      cabin: fallback?.cabin ?? "ECONOMY",
      filters: fallback?.filters ?? {},
      coverageMode: fallback?.coverageMode ?? "core",
      redirectMode: fallback?.redirectMode ?? "best-effort",
      currencyCode: fallback?.currencyCode ?? "USD",
      locale: fallback?.locale ?? "es-PE",
      market: fallback?.market ?? "PE",
    };
  } catch {
    return exactCostamarRequestFromFallback(fallback);
  }
}

function createProviderSearchStates(
  providerIds: ProviderId[],
  cachedJob?: SearchJobRecord,
): Map<ProviderId, ProviderSearchState> {
  const offersByProvider = new Map<ProviderId, CanonicalOffer[]>(
    providerIds.map((providerId) => [providerId, []]),
  );

  for (const cachedOffer of cachedJob?.allOffers ?? []) {
    const offer = stripQuotationPreparation(cachedOffer);
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
      fresh: false,
    }]),
  );
}

function stripCachedMatrixCellQuotation(cell: MatrixCell): MatrixCell {
  return cell.offer
    ? { ...cell, offer: stripQuotationPreparation(cell.offer) }
    : cell;
}

function createProviderMatrixStates(
  request: SearchRequest,
  providerIds: ProviderId[],
  cachedJob?: MatrixJobRecord,
): Map<ProviderId, ProviderMatrixState> {
  const cachedCellsByProvider = new Map<ProviderId, Map<string, MatrixCell>>();

  for (const cachedCell of cachedJob?.cells ?? []) {
    if (!providerIds.includes(cachedCell.providerSource)) {
      continue;
    }
    const providerCells = cachedCellsByProvider.get(cachedCell.providerSource) ?? new Map();
    providerCells.set(cachedCell.key, stripCachedMatrixCellQuotation(cachedCell));
    cachedCellsByProvider.set(cachedCell.providerSource, providerCells);
  }

  return new Map<ProviderId, ProviderMatrixState>(providerIds.map((providerId) => {
    const adapter = getProgressiveAdapter(providerId);
    const response = adapter.createMatrixDraft(request, {
      exactProvider: providerId,
      coverageMode: request.coverageMode,
    });
    const cachedCells = cachedCellsByProvider.get(providerId);
    const cells = response.cells.map((cell) => cachedCells?.get(cell.key) ?? cell);
    const seededResponse = { ...response, cells };

    return [providerId, {
      response: seededResponse,
      completed: false,
      cellIndex: buildMatrixCellIndex(cells),
    }];
  }));
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
    scheduleGroups: buildOfferScheduleGroups(job.allOffers),
  };
}

function isSearchJobRunning(runtime: ReturnType<typeof getRuntime>, jobId: string): boolean {
  return runtime.sessions.getSearchJob(jobId)?.status === "running";
}

function isMatrixJobRunning(runtime: ReturnType<typeof getRuntime>, jobId: string): boolean {
  return runtime.sessions.getMatrixJob(jobId)?.status === "running";
}

function searchAdmissionKindForRequest(request: SearchRequest): SearchAdmissionKind {
  return request.searchMode === "exact" ? "exact" : "range";
}

function searchAdmissionErrorMessage(error: unknown): string {
  if (error instanceof SearchAdmissionError) {
    switch (error.code) {
      case "queue-full":
        return "La cola de busquedas esta llena. Intenta nuevamente en unos minutos.";
      case "queue-timeout":
        return "La busqueda espero demasiado por capacidad disponible.";
      case "cancelled":
        return "La busqueda fue cancelada antes de iniciar.";
    }
  }

  return "No se pudo iniciar la busqueda.";
}

function admissionFailedProviderDiagnostics(
  entries: ProviderDiagnostics[] | undefined,
  providerIds: ProviderId[],
  message: string,
): ProviderDiagnostics[] {
  return providerIds.reduce((current, providerId) => {
    const withEvent = applyProviderDiagnosticEvent(
      current,
      providerId,
      { name: "admission_failed", detail: message, at: new Date().toISOString() },
      "failed",
    );
    return applyProviderDiagnosticSummary(withEvent, providerId, "failed", {
      offers: 0,
      warningCount: 1,
      error: message,
    });
  }, cloneProviderDiagnosticsList(entries));
}

function failSearchJobForAdmission(
  runtime: ReturnType<typeof getRuntime>,
  jobId: string,
  providerIds: ProviderId[],
  error: unknown,
): void {
  const message = searchAdmissionErrorMessage(error);
  runtime.sessions.updateSearchJob(jobId, (current) => {
    if (current.status !== "running") {
      return current;
    }

    const warnings = uniqueStrings([...current.warnings, message]);
    return {
      ...current,
      status: "failed",
      error: message,
      warnings,
      providerDiagnostics: admissionFailedProviderDiagnostics(current.providerDiagnostics, providerIds, message),
      searchMeta: currentSearchMeta({
        ...current.searchMeta,
        completedAt: new Date().toISOString(),
        warnings: uniqueStrings([...(current.searchMeta.warnings ?? []), message]),
        partial: current.offers.length > 0 || current.allOffers.length > 0 || current.searchMeta.partial,
        searchState: "search_failed",
      }),
    };
  });
}

function failMatrixJobForAdmission(
  runtime: ReturnType<typeof getRuntime>,
  jobId: string,
  providerIds: ProviderId[],
  error: unknown,
): void {
  const message = searchAdmissionErrorMessage(error);
  runtime.sessions.updateMatrixJob(jobId, (current) => {
    if (current.status !== "running") {
      return current;
    }

    const warnings = uniqueStrings([...current.warnings, message]);
    const cells = current.cells.map((cell) => cell.confidence === "loading"
      ? {
          ...cell,
          confidence: "unavailable" as const,
          selectable: false,
          stateCode: "chg" as const,
          tooltip: message,
        }
      : cell);
    return {
      ...current,
      status: "failed",
      error: message,
      warnings,
      cells,
      confidenceSummary: buildMatrixConfidenceSummary(cells),
      providerDiagnostics: admissionFailedProviderDiagnostics(current.providerDiagnostics, providerIds, message),
      searchMeta: currentSearchMeta({
        ...current.searchMeta,
        completedAt: new Date().toISOString(),
        warnings: uniqueStrings([...(current.searchMeta.warnings ?? []), message]),
        partial: true,
        searchState: "search_failed",
      }),
    };
  });
}

function shouldCachePartialCancellation(url: URL): boolean {
  return url.searchParams.get("cachePartial") === "1";
}

function cancelSearchJobResponse(runtime: ReturnType<typeof getRuntime>, jobId: string, url: URL): Response {
  const cachePartial = shouldCachePartialCancellation(url);
  disposePendingProgressSync("search", jobId, cachePartial);
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
  disposePendingProgressSync("matrix", jobId, cachePartial);
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

  const costamarContext = normalizeCostamarProviderContext(payload?.providerConfig?.costamar);
  return {
    costamar: costamarContext,
  };
}

function recordLocationUsageForSearchRequest(
  runtime: ReturnType<typeof getRuntime>,
  request: SearchRequest,
  clientSessionId?: unknown,
): void {
  const firstLeg = request.legs[0];
  if (!firstLeg) {
    return;
  }

  runtime.locationUsage.recordFromSearch({
    origin: firstLeg.origin,
    destination: firstLeg.destination,
  }, Date.now(), 3, normalizeLocationUsageSessionId(clientSessionId));
}

/* The unit that answers `GET /api/location-usage-suggestions` is the unit that
   has to count the search. In production the web unit hands `/api/search` and
   `/api/matrix` to `fly-desk-search.service` (`FLY_DESK_SEARCH_SERVICE_URL`),
   so every executed search used to be counted inside the runner — a different
   process, writing a store the ranking is never read from unless two
   environment variables happen to name the same file. The chips were global by
   coincidence, not by construction, and that is what «una búsqueda bastaría
   para agregar otro comodín» ran into. The web unit now counts the search as it
   delegates it, and the runner ignores what arrives stamped as proxied, so an
   executed search is counted exactly once and always where it is served. */
function isDelegatedLocationUsageRoute(method: string, pathname: string): boolean {
  return method.toUpperCase() === "POST"
    && (pathname === "/api/search" || pathname === "/api/matrix");
}

function shouldRecordLocationUsageInThisUnit(
  request: Request,
  payload: SearchPayload | undefined,
): boolean {
  return payload?.recordLocationUsage !== false && !isSearchServiceProxiedRequest(request);
}

async function proxySearchServiceRequestCountingUsage(
  request: Request,
  url: URL,
): Promise<Response | undefined> {
  if (!isDelegatedLocationUsageRoute(request.method, url.pathname)
    || isSearchServiceProxiedRequest(request)
    || !isSearchServiceDelegationConfigured()) {
    return maybeProxySearchServiceRequest(request, url);
  }

  /* Read rather than streamed through: the two codes this body carries are what
     the ranking is made of, and the runner buffers the same few kilobytes to
     parse them anyway. */
  const body = await request.text();
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const response = await maybeProxySearchServiceRequest(
    new Request(request.url, { method: request.method, headers, body }),
    url,
  );
  /* Only a search the runner accepted counts. A 503 from a runner that is down
     is not a route the desk searched. */
  if (!response || !response.ok) {
    return response;
  }

  let payload: SearchPayload | undefined;
  try {
    payload = JSON.parse(body) as SearchPayload;
  } catch {
    return response;
  }

  if (payload?.recordLocationUsage === false) {
    return response;
  }

  recordLocationUsageForSearchRequest(
    getRuntime(),
    prepareSearchContract(payload).request,
    payload?.clientSessionId,
  );
  return response;
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
  if (shouldRecordLocationUsageInThisUnit(request, payload)) {
    recordLocationUsageForSearchRequest(runtime, normalizedRequest, payload?.clientSessionId);
  }
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
  const quotationRateResolver = createSharedQuotationRateResolver();
  let lastPersistedSearchProgressCount = 0;

  const syncSearchJob = (status: "running" | "completed") => {
    const materialized = materializeAggregatedSearchResponse(
      normalizedRequest,
      sortMode,
      providerIds,
      providerStates,
    );
    const progressCount = (materialized.allOffers ?? materialized.offers).length;
    const persist = status === "completed"
      || shouldPersistProgressSnapshot(lastPersistedSearchProgressCount, progressCount);
    if (status === "running" && persist) {
      lastPersistedSearchProgressCount = progressCount;
    }

    runtime.sessions.updateSearchJob(job.id, (current) => {
      if (current.status !== "running") {
        return current;
      }
      return {
        ...current,
        offers: materialized.offers,
        allOffers: materialized.allOffers ?? materialized.offers,
        searchMeta: currentSearchMeta({
          ...materialized.searchMeta,
          requestedAt: current.searchMeta.requestedAt,
          partial: materialized.searchMeta.partial,
          searchState: materialized.searchMeta.searchState,
        }),
        providerMeta: materialized.providerMeta,
        warnings: materialized.warnings,
        status,
        error: undefined,
      };
    }, { persist });
    return materialized;
  };

  if (shouldRunBackgroundSearchJobs()) {
    const searchProgressSync = createTrailingProgressSync(normalizedRequest.searchMode, () => {
      if (isSearchJobRunning(runtime, job.id)) {
        syncSearchJob("running");
      }
    });
    registerPendingProgressSync("search", job.id, searchProgressSync);
    const syncSearchProgress = searchProgressSync.mark;
    scheduleBackgroundSearchJob(() => {
      void runtime.searchAdmission.run(
        {
          kind: searchAdmissionKindForRequest(normalizedRequest),
          jobId: job.id,
          shouldContinue: () => isSearchJobRunning(runtime, job.id),
        },
        async () => {
          if (!isSearchJobRunning(runtime, job.id)) {
            disposePendingProgressSync("search", job.id);
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
            const onProgress = (partialResult: ProviderSearchResult) => {
              if (!isSearchJobRunning(runtime, job.id)) {
                return false;
              }

              if (!firstProgressReported) {
                firstProgressReported = true;
                recordProviderEvent("first_progress");
              }

              providerStates.set(
                providerId,
                mergeProviderSearchProgress(providerStates.get(providerId), partialResult),
              );
              startQuotationRateResolution(
                normalizedRequest,
                partialResult.offers,
                quotationRateResolver,
              );
              syncSearchProgress();
              return isSearchJobRunning(runtime, job.id);
            };

            try {
              if (!isSearchJobRunning(runtime, job.id)) {
                return;
              }

              runtime.providerStatus.markChecking(providerId, "search");
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
                () => isSearchJobRunning(runtime, job.id),
              );
              if (!isSearchJobRunning(runtime, job.id)) {
                return;
              }

              providerStates.set(providerId, {
                offers: result.offers,
                warnings: result.warnings,
                partial: result.partial,
                completed: true,
                fresh: true,
              });
              runtime.providerStatus.recordSearchResult(providerId, result.partial);
              startQuotationRateResolution(
                normalizedRequest,
                providerIds.flatMap((id) => providerStates.get(id)?.offers ?? []),
                quotationRateResolver,
              );
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
              syncSearchProgress();
            } catch (error) {
              if (!isSearchJobRunning(runtime, job.id)) {
                return;
              }

              runtime.providerStatus.recordSearchFailure(providerId, error);
              const partialState = providerStates.get(providerId);
              const errorMessage = providerPublicFailureMessage(providerId, error);
              providerStates.set(providerId, {
                offers: partialState?.fresh ? partialState.offers : [],
                warnings: uniqueStrings([
                  ...(partialState?.fresh ? partialState.warnings : []),
                  errorMessage,
                ]),
                partial: true,
                completed: true,
                fresh: true,
              });
              failedProviderIds.add(providerId);
              recordProviderEvent("failed", "failed");
              recordProviderSummary("failed", {
                offers: 0,
                warningCount: 1,
                error: errorMessage,
              });
              logPerfSpan("search.provider", providerStart, {
                jobId: job.id,
                providerId,
                status: "failed",
                error: error instanceof Error ? error.name : "Error",
              });
              syncSearchProgress();
            }
          });

          const settled = await Promise.allSettled(resolvers);
          if (!isSearchJobRunning(runtime, job.id)) {
            disposePendingProgressSync("search", job.id);
            logPerfSpan("search.job", requestStart, {
              jobId: job.id,
              status: runtime.sessions.getSearchJob(job.id)?.status ?? "missing",
              providers: providerIds.join(","),
            });
            return;
          }

          const sourceOffers = providerIds.flatMap((providerId) => providerStates.get(providerId)?.offers ?? []);
          const readyOffers = await resolveQuotationReadyOffers(normalizedRequest, sourceOffers, quotationRateResolver);
          const readyBySource = new Map(sourceOffers.map((offer, index) => [offer, readyOffers[index]]));
          providerIds.forEach((providerId) => {
            const state = providerStates.get(providerId);
            if (state) {
              state.offers = state.offers.map((offer) => readyBySource.get(offer) ?? offer);
            }
          });
          if (!isSearchJobRunning(runtime, job.id)) {
            disposePendingProgressSync("search", job.id);
            return;
          }

          disposePendingProgressSync("search", job.id);
          const materialized = syncSearchJob("completed");
          logPerfSpan("search.job", requestStart, {
            jobId: job.id,
            status: "completed",
            providers: providerIds.join(","),
            failedProviders: failedProviderIds.size + settled.filter((result) => result.status === "rejected").length,
            offers: materialized.offers.length,
            partial: materialized.searchMeta.partial,
          });
        },
      ).catch((error) => {
        disposePendingProgressSync("search", job.id, true);
        failSearchJobForAdmission(runtime, job.id, providerIds, error);
        logPerfSpan("search.job", requestStart, {
          jobId: job.id,
          status: runtime.sessions.getSearchJob(job.id)?.status ?? "missing",
          providers: providerIds.join(","),
          admissionError: error instanceof Error ? error.name : "Error",
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
  if (shouldRecordLocationUsageInThisUnit(request, payload)) {
    recordLocationUsageForSearchRequest(runtime, normalizedRequest, payload?.clientSessionId);
  }
  const providerDiagnostics = createProviderDiagnosticsForRun(providerIds, "matrix");
  const cachedJob = runtime.sessions.findRecentCompletedMatrixJob({
    request: normalizedRequest,
    providerContext,
    providerIds,
    maxAgeMs: SEARCH_REVALIDATION_CACHE_TTL_MS,
  });
  const providerStates = createProviderMatrixStates(normalizedRequest, providerIds, cachedJob);
  const materializedDraft = materializeAggregatedMatrixResponse(
    normalizedRequest,
    providerIds,
    providerStates,
  );
  const draft = cachedJob
    ? createCachedMatrixDraftResponse(materializedDraft, providerIds, cachedJob)
    : materializedDraft;
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
    cached: Boolean(cachedJob),
    cells: job.cells.length,
  });
  const quotationRateResolver = createSharedQuotationRateResolver();
  let lastPersistedMatrixProgressCount = 0;

  const syncMatrixJob = (status: "running" | "completed") => {
    const materialized = materializeAggregatedMatrixResponse(
      normalizedRequest,
      providerIds,
      providerStates,
    );
    const progressCount = materialized.cells.filter((cell) => cell.confidence !== "loading").length;
    const persist = status === "completed"
      || shouldPersistProgressSnapshot(lastPersistedMatrixProgressCount, progressCount);
    if (status === "running" && persist) {
      lastPersistedMatrixProgressCount = progressCount;
    }

    runtime.sessions.updateMatrixJob(job.id, (current) => {
      if (current.status !== "running") {
        return current;
      }
      return {
        ...current,
        cells: materialized.cells,
        axes: materialized.axes,
        confidenceSummary: materialized.confidenceSummary,
        recommendations: materialized.recommendations,
        searchMeta: currentSearchMeta({
          ...materialized.searchMeta,
          requestedAt: current.searchMeta.requestedAt,
          searchSessionId: current.id,
        }),
        providerMeta: materialized.providerMeta,
        warnings: materialized.warnings,
        status,
        error: undefined,
      };
    }, { persist });

    return materialized;
  };

  if (shouldRunBackgroundSearchJobs()) {
    const matrixProgressSync = createTrailingProgressSync(normalizedRequest.searchMode, () => {
      if (isMatrixJobRunning(runtime, job.id)) {
        syncMatrixJob("running");
      }
    });
    registerPendingProgressSync("matrix", job.id, matrixProgressSync);
    const syncMatrixProgress = matrixProgressSync.mark;
    scheduleBackgroundSearchJob(() => {
      void runtime.searchAdmission.run(
        {
          kind: "matrix",
          jobId: job.id,
          shouldContinue: () => isMatrixJobRunning(runtime, job.id),
        },
        async () => {
          if (!isMatrixJobRunning(runtime, job.id)) {
            disposePendingProgressSync("matrix", job.id);
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

          runtime.providerStatus.markChecking(providerId, "search");
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

              updateMatrixDraftCell(providerState.response, cell, providerState.cellIndex);
              providerState.completed = false;
              startQuotationRateResolution(
                normalizedRequest,
                cell.offer ? [cell.offer] : [],
                quotationRateResolver,
              );
              syncMatrixProgress();
              return isMatrixJobRunning(runtime, job.id);
            },
            providerDiagnosticSeed ? cloneProviderDiagnostics(providerDiagnosticSeed) : undefined,
            (event) => recordProviderEvent(event),
            () => isMatrixJobRunning(runtime, job.id),
          );
          if (!isMatrixJobRunning(runtime, job.id)) {
            return;
          }

          providerStates.set(providerId, {
            response: result,
            completed: true,
            cellIndex: buildMatrixCellIndex(result.cells),
          });
          runtime.providerStatus.recordSearchResult(
            providerId,
            result.searchMeta.partial,
          );
          startQuotationRateResolution(
            normalizedRequest,
            providerIds.flatMap((id) =>
              providerStates.get(id)?.response.cells.flatMap((entry) => entry.offer ? [entry.offer] : []) ?? []
            ),
            quotationRateResolver,
          );
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

          runtime.providerStatus.recordSearchFailure(providerId, error);
          const partialState = providerStates.get(providerId);
          const partialResponse = partialState?.response ?? draftResponse;
          const errorMessage = providerPublicFailureMessage(providerId, error);
          const failedResponse = materializeFailedMatrixResponse(partialResponse, errorMessage);
          providerStates.set(providerId, {
            response: failedResponse,
            completed: true,
            cellIndex: partialState?.cellIndex ?? buildMatrixCellIndex(failedResponse.cells),
          });
          failedProviderIds.add(providerId);
          recordProviderEvent("failed", "failed");
          recordProviderSummary("failed", {
            offers: 0,
            warningCount: 1,
            error: errorMessage,
          });
          logPerfSpan("matrix.provider", providerStart, {
            jobId: job.id,
            providerId,
            status: "failed",
            error: error instanceof Error ? error.name : "Error",
          });
        }

        if (isMatrixJobRunning(runtime, job.id)) {
          syncMatrixProgress();
        }
      });

          const settled = await Promise.allSettled(resolvers);
          if (!isMatrixJobRunning(runtime, job.id)) {
            disposePendingProgressSync("matrix", job.id);
            logPerfSpan("matrix.job", requestStart, {
              jobId: job.id,
              status: runtime.sessions.getMatrixJob(job.id)?.status ?? "missing",
              providers: providerIds.join(","),
            });
            return;
          }

          const sourceOffers = providerIds.flatMap((providerId) =>
            providerStates.get(providerId)?.response.cells.flatMap((cell) => cell.offer ? [cell.offer] : []) ?? []
          );
          const readyOffers = await resolveQuotationReadyOffers(normalizedRequest, sourceOffers, quotationRateResolver);
          const readyBySource = new Map(sourceOffers.map((offer, index) => [offer, readyOffers[index]]));
          providerIds.forEach((providerId) => {
            const state = providerStates.get(providerId);
            if (state) {
              state.response.cells = state.response.cells.map((cell) => cell.offer
                ? { ...cell, offer: readyBySource.get(cell.offer) ?? cell.offer }
                : cell);
            }
          });
          if (!isMatrixJobRunning(runtime, job.id)) {
            disposePendingProgressSync("matrix", job.id);
            return;
          }

          disposePendingProgressSync("matrix", job.id);
          const materialized = syncMatrixJob("completed");
          logPerfSpan("matrix.job", requestStart, {
            jobId: job.id,
            status: "completed",
            providers: providerIds.join(","),
            failedProviders: failedProviderIds.size + settled.filter((result) => result.status === "rejected").length,
            cells: materialized.cells.length,
            partial: materialized.searchMeta.partial,
          });
        },
      ).catch((error) => {
        disposePendingProgressSync("matrix", job.id, true);
        failMatrixJobForAdmission(runtime, job.id, providerIds, error);
        logPerfSpan("matrix.job", requestStart, {
          jobId: job.id,
          status: runtime.sessions.getMatrixJob(job.id)?.status ?? "missing",
          providers: providerIds.join(","),
          admissionError: error instanceof Error ? error.name : "Error",
        });
      });
    }, cachedJob ? cachedBackgroundSearchStartDelayMs() : backgroundSearchStartDelayMs());
  }

  return json(matrixJobResponse(job));
}

export async function routeRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/login") {
    return handleWebLogin(request);
  }

  if (request.method === "POST" && url.pathname === "/logout") {
    return handleWebLogout(request);
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    return handleWebLogin(request, { jsonResponse: true });
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    return handleWebLogout(request, { jsonResponse: true });
  }

  if (request.method === "GET" && url.pathname === "/api/auth/session") {
    const authenticated = hasValidWebSession(request);
    const response = json(
      {
        webAuthEnabled: isWebAuthEnabled(),
        authenticated,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
    if (authenticated) {
      const redirectCookie = createRedirectSessionCookieForWebSession(request);
      if (redirectCookie) {
        response.headers.append("Set-Cookie", redirectCookie);
      }
    }
    return response;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    return json({ ok: true });
  }

  if (isSearchServiceRoute(request.method, url.pathname) && !isTrustedApiRequest(request)) {
    return apiAuthRequiredResponse();
  }

  const searchServiceResponse = await proxySearchServiceRequestCountingUsage(request, url);
  if (searchServiceResponse) {
    return searchServiceResponse;
  }

  const runtime = getRuntime();

  if (request.method === "GET" && url.pathname === "/api/diagnostics") {
    if (!isTrustedLocalRequest(request)) {
      return json({ error: "This diagnostic endpoint is only available on localhost." }, { status: 403 });
    }

    return json({
      ok: true,
      generatedAt: new Date().toISOString(),
      memoryUsage: process.memoryUsage(),
      locationSuggestions: runtime.locationSuggestions.getDiagnostics(),
      locationUsage: runtime.locationUsage.getDiagnostics(),
      searchAdmission: runtime.searchAdmission.getDiagnostics(),
      sessions: runtime.sessions.getDiagnostics(),
      tempArtifacts: collectTempArtifactDiagnostics(),
    });
  }

  if (request.method === "GET" && url.pathname === "/api/provider-status") {
    const providers = runtime.providerStatus.snapshot().map(({
      id,
      label,
      configured,
      state,
      evidence,
      reasonCode,
      observedAtMs,
      stale,
    }) => ({
      id,
      label,
      configured,
      state,
      evidence,
      reasonCode,
      observedAt: observedAtMs === null
        ? null
        : new Date(observedAtMs).toISOString(),
      stale,
    }));
    return json(
      {
        generatedAt: new Date().toISOString(),
        staleAfterMs: runtime.providerStatus.ttlMs,
        providers,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (request.method === "GET" && url.pathname === "/api/costamar/token-status") {
    if (!isTrustedLocalRequest(request)) {
      return json({ error: "This Click and Book Plus token endpoint is only available on localhost." }, { status: 403 });
    }

    const status = getCostamarTokenStatus();
    const verify = url.searchParams.get("verify") === "true";
    const verification = verify ? await verifyCostamarTokenLive() : undefined;
    const lastWarmup = getLastCostamarWarmupDiagnostics();
    return json({ ...status, verification, lastWarmup });
  }

  if (request.method === "GET" && url.pathname === "/api/locations") {
    if (!isTrustedApiRequest(request)) {
      return apiAuthRequiredResponse();
    }

    const query = stringValue(url.searchParams.get("q"));
    if (query.length > LOCATION_SUGGESTION_CACHE_MAX_QUERY_CHARS) {
      return json({
        errors: [
          `Location suggestion query cannot exceed ${LOCATION_SUGGESTION_CACHE_MAX_QUERY_CHARS} characters.`,
        ],
      }, { status: 400 });
    }
    if (query.length < 1) {
      return json({ query, suggestions: [] });
    }

    const limit = integerParam(url.searchParams.get("limit"), 8, 1, 20);
    const clientSessionId = resolveLocationSuggestionSessionId(url.searchParams.get("clientSessionId"));
    const rawProviderId = stringValue(url.searchParams.get("providerId"));
    const providerIds = rawProviderId
      ? [resolveProviderId(rawProviderId as ProviderId | undefined)]
      : resolveSearchProviderIds();

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

  if (request.method === "GET" && url.pathname === "/api/location-usage-suggestions") {
    if (!isTrustedApiRequest(request)) {
      return apiAuthRequiredResponse();
    }

    const limit = integerParam(url.searchParams.get("limit"), 3, 1, 3);
    const clientSessionId = resolveLocationSuggestionSessionId(url.searchParams.get("clientSessionId"));
    const { frequent, recent } = runtime.locationUsage.getUsageSuggestions(clientSessionId, limit);
    return json(
      { suggestions: frequent, frequent, recent },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (request.method === "POST" && url.pathname === "/api/location-usage-suggestions") {
    if (!isTrustedApiRequest(request)) {
      return apiAuthRequiredResponse();
    }

    return json(
      { error: "Location usage ranking is read-only." },
      {
        status: 405,
        headers: {
          "Allow": "GET",
          "Cache-Control": "no-store",
        },
      },
    );
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

    const preferredBrowser = payload.preferredBrowser === "default" ? "default" : "chrome";
    const launcher = await localOpenUrlOpener(
      targetUrl.toString(),
      preferredBrowser,
      preferredBrowser === "chrome" ? resolveAgilChromeLaunchOptions() : undefined,
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
        const redirectContext = runtime.sessions.getRedirectContext(resolved.sessionId);
        const providerContext = redirectContext?.providerContext;
        const fallbackRequest = redirectContext?.request;
        let canRedirect = false;
        let blockedReason: string | undefined;

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
          const redirectRequest = costamarRedirectRequestFromUrl(location, fallbackRequest);

          if (
            redirectRequest
            && isAllowedCostamarBrandedSearchLocation(location, redirectRequest, fastContext)
          ) {
            const redirectResolution = await withCostamarRedirectTotalTimeout(
              resolveCostamarRedirectForRequest(redirectRequest, fastContext, {
                force: !parsedTokenIsUsable,
                validateLive: true,
                forceOnUnverified: true,
              }),
            );
            blockedReason = redirectResolution.redirectVerification.reason;
            if (redirectResolution.redirectVerification.verified) {
              location = applyCostamarContextToBrandedSearchUrl(location, redirectResolution.context);
              canRedirect = true;
            }
          } else if (!redirectRequest) {
            blockedReason = "No se pudo reconstruir la busqueda Click and Book Plus desde el purchase path.";
          } else {
            blockedReason = "El enlace guardado de Click and Book Plus no pertenece a un origen permitido.";
          }
        } catch (error) {
          blockedReason = safeCostamarRedirectFailureReason(error);
          canRedirect = false;
        }

        if (!canRedirect) {
          return costamarRedirectBlockedResponse(blockedReason);
        }
      }

      return new Response(null, {
        status: 302,
        headers: {
          Location: location,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    }

    if (resolved.path.referenceText) {
      return new Response(resolved.path.referenceText, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
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

    if (!payload.searchSessionId || !payload.offerId) {
      return json({ errors: ["searchSessionId and offerId are required."] }, { status: 400 });
    }

    const source = resolveQuotationSource(runtime, payload.searchSessionId, payload.offerId);
    if (!source) {
      return json({ errors: ["Session or offer not found."] }, { status: 404 });
    }

    const validatedOffer = await resolveValidatedQuotationOffer(source);
    if (!validatedOffer) {
      return json({ errors: ["Selected offer could not be validated for quotation."] }, { status: 409 });
    }

    const offer = storeValidatedQuotationOffer(runtime, source, validatedOffer);
    const usdToPenRateInfo = offerNeedsQuotationRate(offer, source.request)
      ? await resolveStandaloneUsdToPenRateInfo(offer)
      : undefined;
    /* The rate that produced the confirmed text travels with the offer. 05 §5
       has the «Paquete migratorio» toggle rewrite the text live in the browser,
       and without the rate on the offer that rewrite had to find one elsewhere
       — in another provider's offer, or nowhere — which turned a confirmed
       «S/ 361 por adulto» into «USD 100 por adulto». */
    const quotedOffer = isUsableUsdToPenRate(usdToPenRateInfo?.rate)
      ? { ...offer, usdToPenRate: usdToPenRateInfo.rate }
      : offer;

    return json({
      searchSessionId: source.sessionId,
      offer: quotedOffer,
      commercialText: buildCommercialQuotation(quotedOffer, source.request, {
        usdToPenRateInfo,
        migrationPlan: payload.migrationPlan === true,
      }),
    });
  }

  return json({ error: "Not found" }, { status: 404 });
}
