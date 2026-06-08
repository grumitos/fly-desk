import { materializeSearchResponse } from "./core/orchestrator";
import { buildMatrixConfidenceSummary } from "./core/matrix";
import { buildCommercialQuotation, shouldIncludePenQuotationPrice } from "./core/quotation";
import { mkdir } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import * as path from "node:path";
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
  resolveCostamarRedirectForRequest,
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
import { resolveQuotationUsdToPenRateInfo, warmQuotationUsdToPenRateInfo } from "./quotation-exchange-rate";
import { SearchAdmissionError, type SearchAdmissionKind } from "./search-admission";
import { resolveAcceptedApiAccessTokens } from "./service-auth";
import { maybeProxySearchServiceRequest } from "./search-service-client";
import { runProviderMatrixInWorker, runProviderSearchInWorker } from "./search-worker-client";
import { collectTempArtifactDiagnostics } from "./temp-artifacts";
import { getRuntime } from "./runtime";
import { logPerfSpan, startPerfTimer } from "./perf";
import {
  clearWebSessionCookie,
  createWebSessionCookie,
  getWebAuthConfigError,
  hasValidWebSession,
  isWebAuthEnabled,
  shouldTrustReverseProxyLoopbackClient,
  shouldTrustLoopbackClient,
  verifyWebPassword,
} from "./web-auth";
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

export function setLocalOpenUrlOpenerForTests(opener?: LocalOpenUrlOpener): void {
  localOpenUrlOpener = opener ?? openUrlLocally;
}

export function setQuotationOfferValidatorForTests(validator?: QuotationOfferValidator): void {
  quotationOfferValidatorOverride = validator;
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
const RESULTS_LAYOUT_DEFAULT_COLUMNS = {
  carrier: 139,
  dates: 371,
  duration: 205,
  stops: 140,
  price: 130,
  links: 54,
} as const satisfies Record<ResultsLayoutColumnKey, number>;
const RESULTS_LAYOUT_TARGET_TOTAL = RESULTS_LAYOUT_COLUMNS.reduce(
  (sum, key) => sum + RESULTS_LAYOUT_DEFAULT_COLUMNS[key],
  0,
);

export const SEARCH_REVALIDATION_CACHE_DEFAULT_TTL_MS = 4 * 60 * 60 * 1000;
export const SEARCH_REVALIDATION_CACHE_TTL_MS = (() => {
  const raw = Number(process.env.SEARCH_REVALIDATION_CACHE_TTL_MS ?? SEARCH_REVALIDATION_CACHE_DEFAULT_TTL_MS);
  return Number.isFinite(raw) && raw >= 0
    ? raw
    : SEARCH_REVALIDATION_CACHE_DEFAULT_TTL_MS;
})();
const SEARCH_REVALIDATION_CACHE_WARNING = "Mostrando resultados cacheados mientras actualizamos en segundo plano.";
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

const RESULTS_LAYOUT_FILE = path.resolve(__dirname, "..", "config", "results-layout.json");
const RESULTS_LAYOUT_VERSION = 2;

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

function readRawResultsLayoutColumns(
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
    columns[key] = Math.max(0, Math.round(numeric));
  }

  return Object.keys(columns).length === RESULTS_LAYOUT_COLUMNS.length
    ? columns
    : undefined;
}

function scaleResultsLayoutColumns(
  columns: Record<ResultsLayoutColumnKey, number>,
): Record<ResultsLayoutColumnKey, number> {
  const total = RESULTS_LAYOUT_COLUMNS.reduce((sum, key) => sum + Math.max(0, columns[key]), 0);
  if (total <= 0) {
    return { ...RESULTS_LAYOUT_DEFAULT_COLUMNS };
  }

  const scaled = RESULTS_LAYOUT_COLUMNS.map((key) => {
    const exact = Math.max(0, columns[key]) / total * RESULTS_LAYOUT_TARGET_TOTAL;
    const floor = Math.floor(exact);
    return { key, floor, fraction: exact - floor };
  });
  let remainder = RESULTS_LAYOUT_TARGET_TOTAL - scaled.reduce((sum, entry) => sum + entry.floor, 0);
  const byFraction = [...scaled].sort((left, right) => right.fraction - left.fraction);
  for (const entry of byFraction) {
    if (remainder <= 0) {
      break;
    }
    entry.floor += 1;
    remainder -= 1;
  }

  return Object.fromEntries(scaled.map((entry) => [entry.key, entry.floor])) as Record<ResultsLayoutColumnKey, number>;
}

function normalizeResultsLayoutColumns(
  input: Partial<Record<ResultsLayoutColumnKey, unknown>> | undefined,
): Record<ResultsLayoutColumnKey, number> | undefined {
  const rawColumns = readRawResultsLayoutColumns(input);
  return rawColumns ? scaleResultsLayoutColumns(rawColumns) : undefined;
}

function resultsLayoutColumnsEqual(
  left: Record<ResultsLayoutColumnKey, number>,
  right: Record<ResultsLayoutColumnKey, number>,
): boolean {
  return RESULTS_LAYOUT_COLUMNS.every((key) => left[key] === right[key]);
}

async function readResultsLayoutFile(): Promise<{
  version: number;
  savedAt: string;
  columns: Record<ResultsLayoutColumnKey, number>;
} | null> {
  try {
    const raw = await Bun.file(RESULTS_LAYOUT_FILE).text();
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      savedAt?: unknown;
      columns?: Partial<Record<ResultsLayoutColumnKey, unknown>>;
    };
    const rawColumns = readRawResultsLayoutColumns(parsed?.columns);
    if (!rawColumns) {
      return null;
    }

    const columns = scaleResultsLayoutColumns(rawColumns);
    if (!columns) {
      return null;
    }

    const savedAt = typeof parsed?.savedAt === "string" ? parsed.savedAt : "";
    const layout = {
      version: RESULTS_LAYOUT_VERSION,
      savedAt,
      columns,
    };

    if (parsed?.version !== RESULTS_LAYOUT_VERSION || !resultsLayoutColumnsEqual(rawColumns, columns)) {
      await writeResultsLayoutFile(columns, savedAt);
    }

    return layout;
  } catch {
    return null;
  }
}

async function writeResultsLayoutFile(
  columns: Record<ResultsLayoutColumnKey, number>,
  savedAt = new Date().toISOString(),
): Promise<{
  version: number;
  savedAt: string;
  columns: Record<ResultsLayoutColumnKey, number>;
}> {
  const normalizedColumns = scaleResultsLayoutColumns(columns);
  const payload = {
    version: RESULTS_LAYOUT_VERSION,
    savedAt,
    columns: normalizedColumns,
  };

  await mkdir(path.dirname(RESULTS_LAYOUT_FILE), { recursive: true });
  await Bun.write(RESULTS_LAYOUT_FILE, JSON.stringify(payload, null, 2));
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
    <title>Renueva la sesion de Click and Book Plus</title>
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
        <h1>Renueva la sesion de Click and Book Plus</h1>
        <p>Fly Desk no encontro un redirect verificado para abrir esta busqueda en Click and Book Plus.</p>
        <p><strong>Motivo:</strong> ${reasonText}</p>
        <p>Abre Click and Book Plus B2B/Chrome, confirma que la sesion este activa y vuelve a intentar desde Fly Desk.</p>
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

function createSearchDraftResponse(
  request: SearchRequest,
  providerIds: ProviderId[],
): SearchResponse {
  const requestedAt = new Date().toISOString();
  const warning = providerIds.length > 1
    ? "Consultando Agil y Click and Book Plus. Los resultados se iran agregando."
    : providerIds[0] === "costamar"
      ? "Consultando Click and Book Plus. Los resultados se iran agregando."
      : "Consultando Agil. Los resultados se iran agregando.";

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
  onProgress: (result: { offers: CanonicalOffer[]; warnings: string[]; partial: boolean }) => boolean | void,
  diagnostics: ProviderDiagnostics | undefined,
  onProviderEvent: ((event: ProviderDiagnosticEvent) => void) | undefined,
  shouldContinue: (() => boolean) | undefined,
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
      shouldContinue,
    });
  }

  const adapter = getProgressiveAdapter(providerId);
  const guardedOnProgress = (result: { offers: CanonicalOffer[]; warnings: string[]; partial: boolean }) => {
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

function isTrustedDirectLocalRequest(request: Request): boolean {
  if (!shouldTrustLoopbackClient() || request.headers.get("x-flydesk-client-loopback") !== "1") {
    return false;
  }

  return !hasForwardedClientMarker(request);
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
  return offer.priceConfidence === "validated" && offer.priceStatus === "verified";
}

function stripQuotationPreparation(offer: CanonicalOffer): CanonicalOffer {
  if (!offer.quotationPreparedAt) {
    return offer;
  }

  const next: CanonicalOffer = { ...offer };
  delete next.quotationPreparedAt;
  return next;
}

function scheduleQuotationWarmupForSearchJob(
  runtime: ReturnType<typeof getRuntime>,
  jobId: string,
): void {
  const session = runtime.sessions.getSession(jobId);
  if (!session || session.offers.length === 0) {
    return;
  }

  void warmQuotationUsdToPenRateInfo(session)?.catch(() => undefined);
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
    filters: {
      ...baseRequest.filters,
      maxResults: Math.max(10, baseRequest.filters.maxResults ?? 10),
      compactAllOffers: true,
    },
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
    filters: {
      ...baseRequest.filters,
      maxResults: Math.max(10, baseRequest.filters.maxResults ?? 10),
      compactAllOffers: true,
    },
  };
}

function buildSyntheticMatrixOffer(cell: MatrixCell, request: SearchRequest): CanonicalOffer | undefined {
  if (!cell.price) {
    return undefined;
  }

  const leg = request.legs[0];
  if (!leg) {
    return undefined;
  }

  const departureAt = `${cell.departureDate}T00:00:00.000Z`;
  const returnAt = cell.returnDate ? `${cell.returnDate}T00:00:00.000Z` : undefined;
  const itineraries: CanonicalOffer["itineraries"] = [
    {
      id: `${cell.key}-outbound`,
      direction: "outbound",
      durationMinutes: 0,
      stops: 0,
      layoverMinutes: [],
      segments: [
        {
          id: `${cell.key}-outbound-segment`,
          marketingCarrier: "",
          flightNumber: "",
          origin: leg.origin,
          destination: leg.destination,
          departureAt,
          arrivalAt: departureAt,
          durationMinutes: 0,
        },
      ],
    },
  ];

  if (request.tripType === "round-trip" && returnAt) {
    itineraries.push({
      id: `${cell.key}-inbound`,
      direction: "inbound",
      durationMinutes: 0,
      stops: 0,
      layoverMinutes: [],
      segments: [
        {
          id: `${cell.key}-inbound-segment`,
          marketingCarrier: "",
          flightNumber: "",
          origin: leg.destination,
          destination: leg.origin,
          departureAt: returnAt,
          arrivalAt: returnAt,
          durationMinutes: 0,
        },
      ],
    });
  }

  return {
    id: cell.key,
    signature: cell.key,
    providerSource: cell.providerSource,
    providerOfferRef: cell.key,
    tripType: request.tripType,
    origin: leg.origin,
    destination: leg.destination,
    itineraries,
    price: {
      total: cell.price,
    },
    priceConfidence: cell.confidence === "validated" || cell.confidence === "live" || cell.confidence === "indicative" || cell.confidence === "stale"
      ? cell.confidence
      : "indicative",
    priceStatus: cell.confidence === "validated" ? "verified" : "unverified",
    purchasePaths: cell.purchasePaths ?? [],
    comparisonMetrics: {
      totalDurationMinutes: 0,
      totalStops: 0,
      baggageScore: 0,
      purchasePathScore: 0,
    },
    tags: [],
    warnings: cell.tooltip ? [cell.tooltip] : [],
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
  const offer = cell.offer ?? (request ? buildSyntheticMatrixOffer(cell, request) : undefined);
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
  return validated ? markOfferValidatedForQuotation(validated) : undefined;
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
  const verification = verifyWebPassword(password);
  if (!verification.ok) {
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

  const sessionCookie = createWebSessionCookie(request);
  if (options.jsonResponse) {
    return json(
      { ok: true },
      {
        headers: {
          "Cache-Control": "no-store",
          "Set-Cookie": sessionCookie,
        },
      },
    );
  }

  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Cache-Control": "no-store",
      "Set-Cookie": sessionCookie,
    },
  });
}

function handleWebLogout(request: Request, options: { jsonResponse?: boolean } = {}): Response {
  const cookie = clearWebSessionCookie(request);
  if (options.jsonResponse) {
    return json(
      { ok: true },
      {
        headers: {
          "Cache-Control": "no-store",
          "Set-Cookie": cookie,
        },
      },
    );
  }

  return new Response(null, {
    status: 303,
    headers: {
      Location: "/login",
      "Cache-Control": "no-store",
      "Set-Cookie": cookie,
    },
  });
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

  return error instanceof Error ? error.message : "No se pudo iniciar la busqueda.";
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

  const costamarContext = normalizeCostamarProviderContext(payload?.providerConfig?.costamar);
  return {
    costamar: costamarContext,
  };
}

function recordLocationUsageForSearchRequest(
  runtime: ReturnType<typeof getRuntime>,
  request: SearchRequest,
): void {
  const firstLeg = request.legs[0];
  if (!firstLeg) {
    return;
  }

  runtime.locationUsage.recordFromSearch({
    origin: firstLeg.origin,
    destination: firstLeg.destination,
  });
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
  recordLocationUsageForSearchRequest(runtime, normalizedRequest);
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

    const updated = runtime.sessions.updateSearchJob(job.id, (current) => ({
      ...current,
      ...(current.status === "cancelled"
        ? {}
        : {
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
          }),
    }));
    if (updated?.offers.length) {
      scheduleQuotationWarmupForSearchJob(runtime, job.id);
    }
    return materialized;
  };

  if (shouldRunBackgroundSearchJobs()) {
    scheduleBackgroundSearchJob(() => {
      void runtime.searchAdmission.run(
        {
          kind: searchAdmissionKindForRequest(normalizedRequest),
          jobId: job.id,
          shouldContinue: () => isSearchJobRunning(runtime, job.id),
        },
        async () => {
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

          const settled = await Promise.allSettled(resolvers);
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
        },
      ).catch((error) => {
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
  recordLocationUsageForSearchRequest(runtime, normalizedRequest);
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
            searchMeta: currentSearchMeta({
              ...materialized.searchMeta,
              requestedAt: current.searchMeta.requestedAt,
              searchSessionId: current.id,
            }),
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
      void runtime.searchAdmission.run(
        {
          kind: "matrix",
          jobId: job.id,
          shouldContinue: () => isMatrixJobRunning(runtime, job.id),
        },
        async () => {
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
            () => isMatrixJobRunning(runtime, job.id),
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

          const settled = await Promise.allSettled(resolvers);
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
        },
      ).catch((error) => {
        failMatrixJobForAdmission(runtime, job.id, providerIds, error);
        logPerfSpan("matrix.job", requestStart, {
          jobId: job.id,
          status: runtime.sessions.getMatrixJob(job.id)?.status ?? "missing",
          providers: providerIds.join(","),
          admissionError: error instanceof Error ? error.name : "Error",
        });
      });
    }, backgroundSearchStartDelayMs());
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
    return json(
      {
        webAuthEnabled: isWebAuthEnabled(),
        authenticated: hasValidWebSession(request),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    return json({ ok: true });
  }

  const searchServiceResponse = await maybeProxySearchServiceRequest(request, url);
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

  if (request.method === "GET" && url.pathname === "/api/results-layout") {
    if (!isTrustedDirectLocalRequest(request)) {
      return json({ error: "This results layout endpoint is only available on localhost." }, { status: 403 });
    }

    const layout = await readResultsLayoutFile();
    return json({ layout });
  }

  if (request.method === "POST" && url.pathname === "/api/results-layout") {
    if (!isTrustedDirectLocalRequest(request)) {
      return json({ error: "This results layout endpoint is only available on localhost." }, { status: 403 });
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
      return json({ error: "This Click and Book Plus token endpoint is only available on localhost." }, { status: 403 });
    }

    const status = getCostamarTokenStatus();
    const verify = url.searchParams.get("verify") === "true";
    const verification = verify ? await verifyCostamarTokenLive() : undefined;
    const lastWarmup = getLastCostamarWarmupDiagnostics();
    return json({ ...status, verification, lastWarmup });
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

    const limit = integerParam(url.searchParams.get("limit"), 3, 1, 20);
    return json({ suggestions: runtime.locationUsage.getSuggestions(limit) });
  }

  if (request.method === "POST" && url.pathname === "/api/location-usage-suggestions") {
    if (!isTrustedApiRequest(request)) {
      return apiAuthRequiredResponse();
    }

    const payload = await readPayload<{ origin?: unknown; destination?: unknown }>(request);
    const limit = integerParam(url.searchParams.get("limit"), 3, 1, 20);
    return json({ suggestions: runtime.locationUsage.recordFromSearch(payload, Date.now(), limit) });
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
        const searchSession = runtime.sessions.getSession(resolved.sessionId);
        const matrixJob = runtime.sessions.getMatrixJob(resolved.sessionId);
        const providerContext = searchSession?.providerContext ?? matrixJob?.providerContext;
        const fallbackRequest = searchSession?.request ?? matrixJob?.request;
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

          if (redirectRequest) {
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
          } else {
            blockedReason = "No se pudo reconstruir la busqueda Click and Book Plus desde el purchase path.";
          }
        } catch (error) {
          blockedReason = error instanceof Error ? error.message : "No se pudo validar el redirect de Click and Book Plus.";
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
    const searchSession = runtime.sessions.getSession(source.sessionId);
    const usdToPenRateInfo = shouldIncludePenQuotationPrice(offer, source.request) && searchSession
      ? await resolveQuotationUsdToPenRateInfo(searchSession, offer)
      : undefined;

    return json({
      searchSessionId: source.sessionId,
      offer,
      commercialText: buildCommercialQuotation(offer, source.request, { usdToPenRateInfo }),
    });
  }

  return json({ error: "Not found" }, { status: 404 });
}
