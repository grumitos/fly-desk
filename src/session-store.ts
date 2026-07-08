import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { logPerfSpan, startPerfTimer } from "./perf";
import {
  CanonicalOffer,
  MatrixCell,
  ProviderContext,
  ProviderDiagnostics,
  ProviderId,
  ProviderMeta,
  PurchasePath,
  SEARCH_CACHE_VERSION,
  SearchMeta,
  SearchRequest,
} from "./core/types";

const COMPLETED_SEARCH_SESSION_DEFAULT_TTL_MS = 4 * 60 * 60 * 1000;
export const COMPLETED_SEARCH_SESSION_TTL_MS = (() => {
  const raw = Number(process.env.SEARCH_COMPLETED_SESSION_TTL_MS ?? COMPLETED_SEARCH_SESSION_DEFAULT_TTL_MS);
  return Number.isFinite(raw) && raw >= 0
    ? raw
    : COMPLETED_SEARCH_SESSION_DEFAULT_TTL_MS;
})();

function withCurrentSearchCacheVersion(searchMeta: SearchMeta): SearchMeta {
  return {
    ...searchMeta,
    cacheVersion: SEARCH_CACHE_VERSION,
  };
}

function hasCurrentSearchCacheVersion(searchMeta: SearchMeta): boolean {
  return searchMeta.cacheVersion === SEARCH_CACHE_VERSION;
}

type SearchJobStatus = "running" | "completed" | "failed" | "cancelled";

interface StoredPurchasePath {
  sessionId: string;
  ownerId: string;
  path: PurchasePath;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
}

interface SearchSessionMetadata {
  id: string;
  request: SearchRequest;
  providerContext?: ProviderContext;
  searchMeta: SearchMeta;
  providerMeta: ProviderMeta;
  warnings: string[];
  providerDiagnostics?: ProviderDiagnostics[];
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  revision: number;
  status: SearchJobStatus;
  error?: string;
}

export interface SearchSessionRecord {
  id: string;
  request: SearchRequest;
  providerContext?: ProviderContext;
  offers: CanonicalOffer[];
  matrix?: MatrixCell[];
  searchMeta: SearchMeta;
  providerMeta: ProviderMeta;
  warnings: string[];
  providerDiagnostics?: ProviderDiagnostics[];
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  revision: number;
  status: SearchJobStatus;
  error?: string;
}

export interface MatrixJobRecord {
  id: string;
  request: SearchRequest;
  providerContext?: ProviderContext;
  cells: MatrixCell[];
  axes: {
    departureDates: string[];
    returnDates: string[];
  };
  confidenceSummary: Record<string, number>;
  recommendations: string[];
  providerMeta: ProviderMeta;
  searchMeta: SearchMeta;
  warnings: string[];
  providerDiagnostics?: ProviderDiagnostics[];
  status: SearchJobStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  revision: number;
}

export interface SearchJobRecord {
  id: string;
  request: SearchRequest;
  providerContext?: ProviderContext;
  offers: CanonicalOffer[];
  allOffers: CanonicalOffer[];
  searchMeta: SearchMeta;
  providerMeta: ProviderMeta;
  warnings: string[];
  providerDiagnostics?: ProviderDiagnostics[];
  sortMode: "cheapest" | "fastest";
  status: SearchJobStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  revision: number;
}

interface StoreDiagnostics {
  generatedAt: string;
  ttlMs: number;
  counts: {
    sessions: number;
    searchJobs: number;
    runningSearchJobs: number;
    completedSearchJobs: number;
    failedSearchJobs: number;
    cancelledSearchJobs: number;
    matrixJobs: number;
    runningMatrixJobs: number;
    completedMatrixJobs: number;
    failedMatrixJobs: number;
    cancelledMatrixJobs: number;
    purchasePaths: number;
  };
  approxBytes: {
    sessionMetadata: number;
    searchJobs: number;
    matrixJobs: number;
    purchasePaths: number;
  };
}

export interface CancelRunningJobsSummary {
  searchJobs: number;
  matrixJobs: number;
}

interface PurgeSummary {
  searchJobs: number;
  matrixJobs: number;
  sessions: number;
  purchasePaths: number;
}

interface SearchSessionStoreOptions {
  dbPath?: string;
  legacyPersistPath?: string;
}

interface LegacyPersistencePayload {
  version?: number;
  searchJobs?: SearchJobRecord[];
  matrixJobs?: MatrixJobRecord[];
  purchasePaths?: StoredPurchasePath[];
}

interface SqlitePayloadRow {
  id: string;
  payload: string;
}

interface PersistedEntryState {
  version: string;
  bytes: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function serializeForComparison(value: unknown): string {
  return JSON.stringify(value);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function safeJsonSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseJsonPayload<T>(payload: string): T | undefined {
  try {
    return JSON.parse(payload) as T;
  } catch {
    return undefined;
  }
}

function runSql(db: Database, sql: string, ...params: any[]): void {
  const statement = db.prepare(sql);
  try {
    statement.run(...params);
  } finally {
    statement.finalize();
  }
}

function getSql<T>(db: Database, sql: string, ...params: any[]): T | undefined {
  const statement = db.prepare(sql);
  try {
    return statement.get(...params) as T | undefined;
  } finally {
    statement.finalize();
  }
}

function allSql<T>(db: Database, sql: string, ...params: any[]): T[] {
  const statement = db.prepare(sql);
  try {
    return statement.all(...params) as T[];
  } finally {
    statement.finalize();
  }
}

function resolveIdleTimestampMs(record: {
  updatedAt?: string;
  lastAccessedAt?: string;
}): number {
  return Math.max(
    Date.parse(record.updatedAt ?? "") || 0,
    Date.parse(record.lastAccessedAt ?? "") || 0,
  );
}

function normalizeProviderContextForSearchCache(
  providerContext: ProviderContext | undefined,
): {
  costamar?: {
    apiBaseUrl: string;
    brandBaseUrl: string;
    terminalId: string;
    lang: string;
  };
} | null {
  if (!providerContext?.costamar) {
    return null;
  }

  return {
    costamar: {
      apiBaseUrl: String(providerContext.costamar.apiBaseUrl ?? "").trim(),
      brandBaseUrl: String(providerContext.costamar.brandBaseUrl ?? "").trim(),
      terminalId: String(providerContext.costamar.terminalId ?? "").trim(),
      lang: String(providerContext.costamar.lang ?? "").trim(),
    },
  };
}

function hasCompatibleCostamarSearchCacheToken(
  requestedContext: ProviderContext | undefined,
  candidateContext: ProviderContext | undefined,
): boolean {
  const requestedCostamar = requestedContext?.costamar;
  const candidateCostamar = candidateContext?.costamar;
  if (!requestedCostamar && !candidateCostamar) {
    return true;
  }
  if (!requestedCostamar || !candidateCostamar) {
    return false;
  }

  const requested = String(requestedCostamar.token ?? "").trim();
  const candidate = String(candidateCostamar.token ?? "").trim();
  if (!requested || !candidate) {
    return false;
  }

  return requested === candidate;
}

function normalizeSearchRequestForSearchCache(request: SearchRequest): SearchRequest {
  const next = cloneJson(request);
  if (next.filters) {
    const checkedBaggageRequired = next.filters.checkedBaggageRequired === true || next.filters.baggageRequired === true;
    if (checkedBaggageRequired) {
      next.filters.checkedBaggageRequired = true;
    } else {
      delete next.filters.checkedBaggageRequired;
    }
    if (next.filters.carryOnRequired !== true) {
      delete next.filters.carryOnRequired;
    }
    delete next.filters.baggageRequired;
  }
  return next;
}

function redactProviderContextForPersistence(providerContext: ProviderContext | undefined): ProviderContext | undefined {
  if (!providerContext?.costamar) {
    return providerContext ? cloneJson(providerContext) : undefined;
  }

  const { token: _token, ...costamar } = providerContext.costamar;
  return {
    ...cloneJson(providerContext),
    costamar,
  } as ProviderContext;
}

function redactCostamarSearchRedirectUrl(url: string | undefined): string | undefined {
  if (!url) {
    return url;
  }

  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("token");
    return parsed.toString();
  } catch {
    return url;
  }
}

function redactPurchasePathForPersistence(path: PurchasePath): PurchasePath {
  const next = { ...path };
  if (next.provider === "costamar" && next.type === "search-redirect") {
    next.url = redactCostamarSearchRedirectUrl(next.url);
  }
  return next;
}

function redactOfferForPersistence(offer: CanonicalOffer): CanonicalOffer {
  return {
    ...offer,
    purchasePaths: offer.purchasePaths.map(redactPurchasePathForPersistence),
  };
}

function redactMatrixCellForPersistence(cell: MatrixCell): MatrixCell {
  return {
    ...cell,
    purchasePaths: cell.purchasePaths?.map(redactPurchasePathForPersistence),
    offer: cell.offer ? redactOfferForPersistence(cell.offer) : undefined,
  };
}

function redactStoredPurchasePathForPersistence(entry: StoredPurchasePath): StoredPurchasePath {
  const path = redactPurchasePathForPersistence(entry.path);
  const occurrence = entry.fingerprint.match(/#(\d+)$/)?.[1] ?? "0";
  const fingerprint = `${serializeForComparison({
    type: path.type,
    provider: path.provider,
    label: path.label,
    url: path.url ?? null,
    precision: path.precision,
    score: path.score,
    requiresNewTab: path.requiresNewTab,
    commercialMode: path.commercialMode,
    state: path.state,
    referenceText: path.referenceText ?? null,
    expiresAt: path.expiresAt ?? null,
  })}#${occurrence}`;

  return {
    ...entry,
    path,
    fingerprint,
  };
}

function publicPurchasePathUrl(purchasePathId: string): string {
  return `/r/${purchasePathId}`;
}

function redactSearchJobForPersistence(job: SearchJobRecord): SearchJobRecord {
  return {
    ...job,
    providerContext: redactProviderContextForPersistence(job.providerContext),
    offers: job.offers.map(redactOfferForPersistence),
    allOffers: job.allOffers.map(redactOfferForPersistence),
  };
}

function redactMatrixJobForPersistence(job: MatrixJobRecord): MatrixJobRecord {
  return {
    ...job,
    providerContext: redactProviderContextForPersistence(job.providerContext),
    cells: job.cells.map(redactMatrixCellForPersistence),
  };
}

function isPersistableStatus(status: SearchJobStatus): boolean {
  return status === "completed" || status === "running";
}

function searchJobPersistenceVersion(job: SearchJobRecord): string {
  return `${job.revision}\u0000${job.status}\u0000${job.updatedAt}\u0000${job.lastAccessedAt}`;
}

function matrixJobPersistenceVersion(job: MatrixJobRecord): string {
  return `${job.revision}\u0000${job.status}\u0000${job.updatedAt}\u0000${job.lastAccessedAt}`;
}

function purchasePathPersistenceVersion(entry: StoredPurchasePath): string {
  return `${entry.fingerprint}\u0000${entry.updatedAt}\u0000${entry.lastAccessedAt}`;
}

function sumPersistedBytes(entries: Map<string, PersistedEntryState>): number {
  let total = 0;
  for (const entry of entries.values()) {
    total += entry.bytes;
  }
  return total;
}

export class SearchSessionStore {
  private readonly sessions = new Map<string, SearchSessionMetadata>();
  private readonly purchasePaths = new Map<string, StoredPurchasePath>();
  private readonly sessionPurchasePathIds = new Map<string, Set<string>>();
  private readonly sessionOwnerKeys = new Map<string, Set<string>>();
  private readonly ownerPurchasePathIds = new Map<string, Map<string, string>>();
  private readonly matrixJobs = new Map<string, MatrixJobRecord>();
  private readonly searchJobs = new Map<string, SearchJobRecord>();
  private db: Database | undefined;
  private readonly legacyPersistPath: string | undefined;
  private readonly persistedSearchJobs = new Map<string, PersistedEntryState>();
  private readonly persistedMatrixJobs = new Map<string, PersistedEntryState>();
  private readonly persistedPurchasePaths = new Map<string, PersistedEntryState>();
  private persistTimer: NodeJS.Timeout | undefined;
  private bootstrapping = false;

  constructor(options?: SearchSessionStoreOptions) {
    const dbPath = options?.dbPath?.trim() || undefined;
    this.legacyPersistPath = options?.legacyPersistPath?.trim() || undefined;

    if (dbPath) {
      mkdirSync(dirname(dbPath), { recursive: true });
      this.db = new Database(dbPath);
      this.db.run("PRAGMA journal_mode = WAL;");
      this.db.run("PRAGMA synchronous = NORMAL;");
      this.db.run("PRAGMA temp_store = MEMORY;");
      this.db.run("PRAGMA busy_timeout = 5000;");
      this.db.run("PRAGMA foreign_keys = ON;");
      this.initializeDatabase();
      this.loadPersisted();
    }
  }

  close(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    this.persistNow();
    const db = this.db;
    if (db) {
      this.db = undefined;
      try {
        db.run("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {
        // Closing the database is still the important cleanup path.
      }
      db.close(true);
    }
  }

  getSession(sessionId: string): SearchSessionRecord | undefined {
    const job = this.searchJobs.get(sessionId);
    const session = this.sessions.get(sessionId);
    if (!job || !session) {
      return undefined;
    }

    const touchedAt = this.touchSearchJob(job);
    const updatedSession = this.touchSessionMetadata(sessionId, touchedAt) ?? session;
    return {
      id: updatedSession.id,
      request: updatedSession.request,
      providerContext: updatedSession.providerContext,
      offers: job.allOffers,
      matrix: undefined,
      searchMeta: {
        ...updatedSession.searchMeta,
        searchSessionId: sessionId,
      },
      providerMeta: updatedSession.providerMeta,
      warnings: [...updatedSession.warnings],
      providerDiagnostics: updatedSession.providerDiagnostics,
      createdAt: updatedSession.createdAt,
      updatedAt: updatedSession.updatedAt,
      lastAccessedAt: updatedSession.lastAccessedAt,
      revision: updatedSession.revision,
      status: updatedSession.status,
      error: updatedSession.error,
    };
  }

  getOffer(sessionId: string, offerId: string): CanonicalOffer | undefined {
    const job = this.searchJobs.get(sessionId);
    if (!job) {
      return undefined;
    }

    const touchedAt = this.touchSearchJob(job);
    this.touchSessionMetadata(sessionId, touchedAt);
    return job.allOffers.find((offer) => offer.id === offerId);
  }

  updateOffer(sessionId: string, updatedOffer: CanonicalOffer): CanonicalOffer | undefined {
    const next = this.updateSearchJob(sessionId, (current) => {
      const rewrittenOffer = this.rewriteOfferPaths(sessionId, updatedOffer);
      return {
        ...current,
        offers: current.offers.map((offer) => offer.id === updatedOffer.id ? rewrittenOffer : offer),
        allOffers: current.allOffers.map((offer) => offer.id === updatedOffer.id ? rewrittenOffer : offer),
      };
    });

    return next?.allOffers.find((offer) => offer.id === updatedOffer.id);
  }

  createSearchJob(input: Omit<SearchJobRecord, "id" | "createdAt" | "updatedAt" | "lastAccessedAt" | "revision">): SearchJobRecord {
    const id = crypto.randomUUID();
    const timestamp = nowIso();
    const rewrittenAllOffers = input.allOffers.map((offer) => this.rewriteOfferPaths(id, offer));
    const rewrittenOffersById = new Map(rewrittenAllOffers.map((offer) => [offer.id, offer] as const));
    const rewrittenOffers = input.offers.map((offer) => rewrittenOffersById.get(offer.id) ?? this.rewriteOfferPaths(id, offer));

    const record: SearchJobRecord = {
      ...input,
      id,
      offers: rewrittenOffers,
      allOffers: rewrittenAllOffers,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastAccessedAt: timestamp,
      revision: 1,
      searchMeta: withCurrentSearchCacheVersion({
        ...input.searchMeta,
        searchSessionId: id,
      }),
    };

    this.searchJobs.set(id, record);
    this.syncSearchSessionMetadata(record);
    this.pruneSessionOwners(id, new Set([
      ...rewrittenAllOffers.map((offer) => offer.id),
      ...rewrittenOffers.map((offer) => offer.id),
    ]));
    this.schedulePersist();
    return record;
  }

  getSearchJob(jobId: string): SearchJobRecord | undefined {
    const job = this.searchJobs.get(jobId);
    if (!job) {
      return undefined;
    }

    const touchedAt = this.touchSearchJob(job);
    this.touchSessionMetadata(jobId, touchedAt);
    return job;
  }

  findRecentCompletedSearchJob(input: {
    request: SearchRequest;
    providerContext?: ProviderContext;
    providerIds: ProviderId[];
    sortMode: SearchJobRecord["sortMode"];
    maxAgeMs: number;
    nowMs?: number;
  }): SearchJobRecord | undefined {
    if (!Number.isFinite(input.maxAgeMs) || input.maxAgeMs <= 0) {
      return undefined;
    }

    const nowMs = input.nowMs ?? Date.now();
    const requestKey = serializeForComparison(normalizeSearchRequestForSearchCache(input.request));
    const providerIdsKey = serializeForComparison(input.providerIds);
    const providerContextKey = serializeForComparison(
      normalizeProviderContextForSearchCache(input.providerContext),
    );

    let latest: SearchJobRecord | undefined;
    let latestIdleTimestamp = 0;

    for (const candidate of this.searchJobs.values()) {
      if (candidate.status !== "completed") {
        continue;
      }

      if (!hasCurrentSearchCacheVersion(candidate.searchMeta)) {
        continue;
      }

      if (candidate.sortMode !== input.sortMode) {
        continue;
      }

      if (serializeForComparison(normalizeSearchRequestForSearchCache(candidate.request)) !== requestKey) {
        continue;
      }

      if (serializeForComparison(candidate.searchMeta.providersUsed ?? []) !== providerIdsKey) {
        continue;
      }

      const candidateContextKey = serializeForComparison(
        normalizeProviderContextForSearchCache(candidate.providerContext),
      );
      if (candidateContextKey !== providerContextKey) {
        continue;
      }

      if (!hasCompatibleCostamarSearchCacheToken(input.providerContext, candidate.providerContext)) {
        continue;
      }

      const idleTimestamp = resolveIdleTimestampMs(candidate);
      if ((nowMs - idleTimestamp) > input.maxAgeMs) {
        continue;
      }

      if (!latest || idleTimestamp > latestIdleTimestamp) {
        latest = candidate;
        latestIdleTimestamp = idleTimestamp;
      }
    }

    if (!latest) {
      return undefined;
    }

    const touchedAt = this.touchSearchJob(latest);
    this.touchSessionMetadata(latest.id, touchedAt);
    return latest;
  }

  updateSearchJob(
    jobId: string,
    updater: (current: SearchJobRecord) => SearchJobRecord,
  ): SearchJobRecord | undefined {
    const current = this.searchJobs.get(jobId);
    if (!current) {
      return undefined;
    }

    const updated = updater(current);
    if (updated === current) {
      return current;
    }

    const timestamp = nowIso();
    const rewrittenAllOffers = updated.allOffers.map((offer) => this.rewriteOfferPaths(jobId, offer));
    const rewrittenOffersById = new Map(rewrittenAllOffers.map((offer) => [offer.id, offer] as const));
    const rewrittenOffers = updated.offers.map((offer) => rewrittenOffersById.get(offer.id) ?? this.rewriteOfferPaths(jobId, offer));
    const base: SearchJobRecord = {
      ...updated,
      id: current.id,
      offers: rewrittenOffers,
      allOffers: rewrittenAllOffers,
      createdAt: current.createdAt,
      updatedAt: timestamp,
      lastAccessedAt: timestamp,
      revision: current.revision,
      searchMeta: withCurrentSearchCacheVersion({
        ...updated.searchMeta,
        searchSessionId: current.id,
      }),
    };
    const next: SearchJobRecord = {
      ...base,
      revision: current.revision + 1,
    };

    this.searchJobs.set(jobId, next);
    this.syncSearchSessionMetadata(next);
    this.pruneSessionOwners(jobId, new Set([
      ...rewrittenAllOffers.map((offer) => offer.id),
      ...rewrittenOffers.map((offer) => offer.id),
    ]));
    this.schedulePersist();
    return next;
  }

  cancelSearchJob(
    jobId: string,
    message = "Search cancelled by user.",
    options: { cachePartial?: boolean } = {},
  ): SearchJobRecord | undefined {
    return this.updateSearchJob(jobId, (current) => {
      if (current.status !== "running") {
        return current;
      }

      const warnings = uniqueStrings([...current.warnings, message]);
      const metaWarnings = uniqueStrings([...(current.searchMeta.warnings ?? []), message]);
      const hasPartialResults = current.offers.length > 0 || current.allOffers.length > 0;
      const cachePartial = Boolean(options.cachePartial && hasPartialResults);
      return {
        ...current,
        status: cachePartial ? "completed" : "cancelled",
        error: cachePartial ? undefined : message,
        warnings,
        searchMeta: {
          ...current.searchMeta,
          completedAt: nowIso(),
          warnings: metaWarnings,
          partial: cachePartial || hasPartialResults,
          searchState: cachePartial ? "search_partial" : "search_cancelled",
        },
      };
    });
  }

  resolvePurchasePath(purchasePathId: string): StoredPurchasePath | undefined {
    const stored = this.purchasePaths.get(purchasePathId);
    if (!stored) {
      return undefined;
    }

    if (!this.searchJobs.has(stored.sessionId) && !this.matrixJobs.has(stored.sessionId)) {
      this.forgetPurchasePathById(stored.sessionId, purchasePathId);
      return undefined;
    }

    const timestamp = nowIso();
    stored.lastAccessedAt = timestamp;
    this.purchasePaths.set(purchasePathId, stored);
    const searchJob = this.searchJobs.get(stored.sessionId);
    if (searchJob) {
      this.touchSearchJob(searchJob, timestamp);
      this.touchSessionMetadata(stored.sessionId, timestamp);
    }
    const matrixJob = this.matrixJobs.get(stored.sessionId);
    if (matrixJob) {
      this.touchMatrixJob(matrixJob, timestamp);
    }
    return stored;
  }

  createMatrixJob(input: Omit<MatrixJobRecord, "id" | "createdAt" | "updatedAt" | "lastAccessedAt" | "revision">): MatrixJobRecord {
    const id = crypto.randomUUID();
    const timestamp = nowIso();
    const record: MatrixJobRecord = {
      ...input,
      cells: input.cells.map((cell) => this.rewriteMatrixCellPaths(id, cell)),
      id,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastAccessedAt: timestamp,
      revision: 1,
      searchMeta: withCurrentSearchCacheVersion({
        ...input.searchMeta,
        searchSessionId: id,
      }),
    };

    this.matrixJobs.set(id, record);
    this.pruneSessionOwners(id, new Set(record.cells.map((cell) => cell.key)));
    this.schedulePersist();
    return record;
  }

  getMatrixJob(jobId: string): MatrixJobRecord | undefined {
    const job = this.matrixJobs.get(jobId);
    if (!job) {
      return undefined;
    }

    this.touchMatrixJob(job);
    return job;
  }

  updateMatrixJob(
    jobId: string,
    updater: (current: MatrixJobRecord) => MatrixJobRecord,
  ): MatrixJobRecord | undefined {
    const current = this.matrixJobs.get(jobId);
    if (!current) {
      return undefined;
    }

    const updated = updater(current);
    if (updated === current) {
      return current;
    }

    const timestamp = nowIso();
    const rewrittenCells = updated.cells.map((cell) => this.rewriteMatrixCellPaths(jobId, cell));
    const base: MatrixJobRecord = {
      ...updated,
      cells: rewrittenCells,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: timestamp,
      lastAccessedAt: timestamp,
      revision: current.revision,
      searchMeta: withCurrentSearchCacheVersion({
        ...updated.searchMeta,
        searchSessionId: current.id,
      }),
    };
    const next: MatrixJobRecord = {
      ...base,
      revision: current.revision + 1,
    };

    this.matrixJobs.set(jobId, next);
    this.pruneSessionOwners(jobId, new Set(rewrittenCells.map((cell) => cell.key)));
    this.schedulePersist();
    return next;
  }

  cancelMatrixJob(
    jobId: string,
    message = "Search cancelled by user.",
    options: { cachePartial?: boolean } = {},
  ): MatrixJobRecord | undefined {
    return this.updateMatrixJob(jobId, (current) => {
      if (current.status !== "running") {
        return current;
      }

      const warnings = uniqueStrings([...current.warnings, message]);
      const metaWarnings = uniqueStrings([...(current.searchMeta.warnings ?? []), message]);
      const hasPartialResults = current.cells.some((cell) => cell.confidence !== "loading");
      const cachePartial = Boolean(options.cachePartial && hasPartialResults);
      return {
        ...current,
        status: cachePartial ? "completed" : "cancelled",
        error: cachePartial ? undefined : message,
        warnings,
        searchMeta: {
          ...current.searchMeta,
          completedAt: nowIso(),
          warnings: metaWarnings,
          partial: true,
          searchState: cachePartial ? "search_partial" : "search_cancelled",
        },
      };
    });
  }

  cancelRunningJobs(
    message = "Search cancelled by user.",
    options: { cachePartial?: boolean } = {},
  ): CancelRunningJobsSummary {
    let searchJobs = 0;
    let matrixJobs = 0;

    const runningSearchJobIds = [...this.searchJobs.values()]
      .filter((job) => job.status === "running")
      .map((job) => job.id);
    for (const jobId of runningSearchJobIds) {
      const updated = this.cancelSearchJob(jobId, message, options);
      if (updated && updated.status !== "running") {
        searchJobs += 1;
      }
    }

    const runningMatrixJobIds = [...this.matrixJobs.values()]
      .filter((job) => job.status === "running")
      .map((job) => job.id);
    for (const jobId of runningMatrixJobIds) {
      const updated = this.cancelMatrixJob(jobId, message, options);
      if (updated && updated.status !== "running") {
        matrixJobs += 1;
      }
    }

    return { searchJobs, matrixJobs };
  }

  purgeExpired(nowMs = Date.now()): PurgeSummary {
    const beforeSessions = this.sessions.size;
    const beforePurchasePaths = this.purchasePaths.size;
    let removedSearchJobs = 0;
    let removedMatrixJobs = 0;

    for (const [jobId, job] of this.searchJobs.entries()) {
      if (job.status === "running") {
        continue;
      }

      if ((nowMs - resolveIdleTimestampMs(job)) <= COMPLETED_SEARCH_SESSION_TTL_MS) {
        continue;
      }

      removedSearchJobs += 1;
      this.searchJobs.delete(jobId);
      this.sessions.delete(jobId);
      this.forgetSessionPurchasePaths(jobId);
    }

    for (const [jobId, job] of this.matrixJobs.entries()) {
      if (job.status === "running") {
        continue;
      }

      if ((nowMs - resolveIdleTimestampMs(job)) <= COMPLETED_SEARCH_SESSION_TTL_MS) {
        continue;
      }

      removedMatrixJobs += 1;
      this.matrixJobs.delete(jobId);
      this.forgetSessionPurchasePaths(jobId);
    }

    if (removedSearchJobs > 0 || removedMatrixJobs > 0) {
      this.schedulePersist();
    }

    return {
      searchJobs: removedSearchJobs,
      matrixJobs: removedMatrixJobs,
      sessions: Math.max(0, beforeSessions - this.sessions.size),
      purchasePaths: Math.max(0, beforePurchasePaths - this.purchasePaths.size),
    };
  }

  getDiagnostics(): StoreDiagnostics {
    const searchJobs = [...this.searchJobs.values()];
    const matrixJobs = [...this.matrixJobs.values()];
    return {
      generatedAt: nowIso(),
      ttlMs: COMPLETED_SEARCH_SESSION_TTL_MS,
      counts: {
        sessions: this.sessions.size,
        searchJobs: searchJobs.length,
        runningSearchJobs: searchJobs.filter((job) => job.status === "running").length,
        completedSearchJobs: searchJobs.filter((job) => job.status === "completed").length,
        failedSearchJobs: searchJobs.filter((job) => job.status === "failed").length,
        cancelledSearchJobs: searchJobs.filter((job) => job.status === "cancelled").length,
        matrixJobs: matrixJobs.length,
        runningMatrixJobs: matrixJobs.filter((job) => job.status === "running").length,
        completedMatrixJobs: matrixJobs.filter((job) => job.status === "completed").length,
        failedMatrixJobs: matrixJobs.filter((job) => job.status === "failed").length,
        cancelledMatrixJobs: matrixJobs.filter((job) => job.status === "cancelled").length,
        purchasePaths: this.purchasePaths.size,
      },
      approxBytes: {
        sessionMetadata: [...this.sessions.values()].reduce((total, session) => total + safeJsonSize(session), 0),
        searchJobs: this.db
          ? sumPersistedBytes(this.persistedSearchJobs)
          : searchJobs.reduce((total, job) => total + safeJsonSize(this.searchJobSnapshot(job)), 0),
        matrixJobs: this.db
          ? sumPersistedBytes(this.persistedMatrixJobs)
          : matrixJobs.reduce((total, job) => total + safeJsonSize(this.matrixJobSnapshot(job)), 0),
        purchasePaths: this.db
          ? sumPersistedBytes(this.persistedPurchasePaths)
          : [...this.purchasePaths.values()].reduce((total, path) => total + safeJsonSize(path), 0),
      },
    };
  }

  private rewriteOfferPaths(sessionId: string, offer: CanonicalOffer): CanonicalOffer {
    return {
      ...offer,
      purchasePaths: this.rewritePurchasePaths(sessionId, offer.id, offer.purchasePaths),
    };
  }

  private rewriteMatrixCellPaths(sessionId: string, cell: MatrixCell): MatrixCell {
    const purchasePaths = this.rewritePurchasePaths(sessionId, cell.key, cell.purchasePaths ?? []);
    return {
      ...cell,
      purchasePaths,
      offer: cell.offer
        ? {
            ...cell.offer,
            purchasePaths,
          }
        : undefined,
    };
  }

  private rewritePurchasePaths(sessionId: string, ownerId: string, paths: PurchasePath[]): PurchasePath[] {
    const ownerKey = this.ownerKey(sessionId, ownerId);
    const trackedIds = this.sessionPurchasePathIds.get(sessionId) ?? new Set<string>();
    const trackedOwners = this.sessionOwnerKeys.get(sessionId) ?? new Set<string>();
    const ownerPaths = this.ownerPurchasePathIds.get(ownerKey) ?? new Map<string, string>();
    const activeFingerprints = new Set<string>();
    const duplicateCounters = new Map<string, number>();
    const timestamp = nowIso();

    this.sessionPurchasePathIds.set(sessionId, trackedIds);
    this.sessionOwnerKeys.set(sessionId, trackedOwners);
    this.ownerPurchasePathIds.set(ownerKey, ownerPaths);
    trackedOwners.add(ownerKey);

    const rewritten = paths.map((path) => {
      const rawPath = this.stripRuntimePath(path);
      const baseFingerprint = serializeForComparison({
        type: rawPath.type,
        provider: rawPath.provider,
        label: rawPath.label,
        url: rawPath.url ?? null,
        precision: rawPath.precision,
        score: rawPath.score,
        requiresNewTab: rawPath.requiresNewTab,
        commercialMode: rawPath.commercialMode,
        state: rawPath.state,
        referenceText: rawPath.referenceText ?? null,
        expiresAt: rawPath.expiresAt ?? null,
      });
      const occurrence = duplicateCounters.get(baseFingerprint) ?? 0;
      duplicateCounters.set(baseFingerprint, occurrence + 1);
      const fingerprint = `${baseFingerprint}#${occurrence}`;
      activeFingerprints.add(fingerprint);

      const existingId = ownerPaths.get(fingerprint);
      const purchasePathId = existingId ?? crypto.randomUUID();
      const previous = existingId ? this.purchasePaths.get(existingId) : undefined;

      ownerPaths.set(fingerprint, purchasePathId);
      trackedIds.add(purchasePathId);
      this.purchasePaths.set(purchasePathId, {
        sessionId,
        ownerId,
        path: {
          ...rawPath,
          id: purchasePathId,
        },
        fingerprint,
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: previous?.updatedAt ?? timestamp,
        lastAccessedAt: previous?.lastAccessedAt ?? timestamp,
      });

      return {
        ...rawPath,
        id: purchasePathId,
        url: publicPurchasePathUrl(purchasePathId),
      };
    });

    for (const [fingerprint, purchasePathId] of [...ownerPaths.entries()]) {
      if (activeFingerprints.has(fingerprint)) {
        continue;
      }

      ownerPaths.delete(fingerprint);
      trackedIds.delete(purchasePathId);
      this.purchasePaths.delete(purchasePathId);
    }

    if (trackedIds.size === 0) {
      this.sessionPurchasePathIds.delete(sessionId);
    }

    if (ownerPaths.size === 0) {
      this.ownerPurchasePathIds.delete(ownerKey);
      trackedOwners.delete(ownerKey);
    }

    if (trackedOwners.size === 0) {
      this.sessionOwnerKeys.delete(sessionId);
    }

    return rewritten;
  }

  private stripRuntimePath(path: PurchasePath): PurchasePath {
    const stored = path.id ? this.purchasePaths.get(path.id) : undefined;
    const rawUrl = stored?.path.url
      ?? (typeof path.url === "string" && !path.url.startsWith("/r/") ? path.url : undefined);

    return {
      ...(stored?.path ?? {}),
      ...path,
      id: stored?.path.id ?? path.id,
      url: rawUrl,
    };
  }

  private syncSearchSessionMetadata(job: SearchJobRecord): void {
    const existing = this.sessions.get(job.id);
    this.sessions.set(job.id, {
      id: job.id,
      request: job.request,
      providerContext: job.providerContext,
      searchMeta: withCurrentSearchCacheVersion({
        ...job.searchMeta,
        searchSessionId: job.id,
      }),
      providerMeta: job.providerMeta,
      warnings: [...job.warnings],
      providerDiagnostics: job.providerDiagnostics,
      createdAt: existing?.createdAt ?? job.createdAt,
      updatedAt: job.updatedAt,
      lastAccessedAt: job.lastAccessedAt,
      revision: job.revision,
      status: job.status,
      error: job.error,
    });
  }

  private touchSearchJob(job: SearchJobRecord, timestamp = nowIso()): string {
    job.lastAccessedAt = timestamp;
    this.searchJobs.set(job.id, job);
    return timestamp;
  }

  private touchMatrixJob(job: MatrixJobRecord, timestamp = nowIso()): string {
    job.lastAccessedAt = timestamp;
    this.matrixJobs.set(job.id, job);
    return timestamp;
  }

  private touchSessionMetadata(sessionId: string, timestamp = nowIso()): SearchSessionMetadata | undefined {
    const existing = this.sessions.get(sessionId);
    if (!existing) {
      return undefined;
    }

    existing.lastAccessedAt = timestamp;
    this.sessions.set(sessionId, existing);
    return existing;
  }

  private pruneSessionOwners(sessionId: string, activeOwnerIds: Set<string>): void {
    const trackedOwnerKeys = this.sessionOwnerKeys.get(sessionId);
    if (!trackedOwnerKeys) {
      return;
    }

    for (const ownerKey of [...trackedOwnerKeys]) {
      const [, ownerId] = this.parseOwnerKey(ownerKey);
      if (activeOwnerIds.has(ownerId)) {
        continue;
      }

      this.dropOwnerPurchasePaths(ownerKey);
    }
  }

  private forgetSessionPurchasePaths(sessionId: string): void {
    const ownerKeys = this.sessionOwnerKeys.get(sessionId);
    if (ownerKeys) {
      for (const ownerKey of [...ownerKeys]) {
        this.dropOwnerPurchasePaths(ownerKey);
      }
    }

    const trackedIds = this.sessionPurchasePathIds.get(sessionId);
    if (trackedIds) {
      for (const purchasePathId of [...trackedIds]) {
        this.purchasePaths.delete(purchasePathId);
      }
    }

    this.sessionPurchasePathIds.delete(sessionId);
    this.sessionOwnerKeys.delete(sessionId);
    this.schedulePersist();
  }

  private forgetPurchasePathById(sessionId: string, purchasePathId: string): void {
    this.purchasePaths.delete(purchasePathId);
    const trackedIds = this.sessionPurchasePathIds.get(sessionId);
    if (trackedIds) {
      trackedIds.delete(purchasePathId);
      if (trackedIds.size === 0) {
        this.sessionPurchasePathIds.delete(sessionId);
      }
    }
    const trackedOwners = this.sessionOwnerKeys.get(sessionId);
    if (trackedOwners) {
      for (const ownerKey of [...trackedOwners]) {
        const ownerPaths = this.ownerPurchasePathIds.get(ownerKey);
        if (!ownerPaths) {
          trackedOwners.delete(ownerKey);
          continue;
        }

        for (const [fingerprint, currentPurchasePathId] of [...ownerPaths.entries()]) {
          if (currentPurchasePathId === purchasePathId) {
            ownerPaths.delete(fingerprint);
          }
        }

        if (ownerPaths.size === 0) {
          this.ownerPurchasePathIds.delete(ownerKey);
          trackedOwners.delete(ownerKey);
        }
      }

      if (trackedOwners.size === 0) {
        this.sessionOwnerKeys.delete(sessionId);
      }
    }

    this.schedulePersist();
  }

  private dropOwnerPurchasePaths(ownerKey: string): void {
    const ownerPaths = this.ownerPurchasePathIds.get(ownerKey);
    if (!ownerPaths) {
      return;
    }

    const [sessionId] = this.parseOwnerKey(ownerKey);
    const trackedIds = this.sessionPurchasePathIds.get(sessionId);
    ownerPaths.forEach((purchasePathId) => {
      this.purchasePaths.delete(purchasePathId);
      trackedIds?.delete(purchasePathId);
    });

    this.ownerPurchasePathIds.delete(ownerKey);
    if (trackedIds && trackedIds.size === 0) {
      this.sessionPurchasePathIds.delete(sessionId);
    }

    const trackedOwners = this.sessionOwnerKeys.get(sessionId);
    if (trackedOwners) {
      trackedOwners.delete(ownerKey);
      if (trackedOwners.size === 0) {
        this.sessionOwnerKeys.delete(sessionId);
      }
    }
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (!this.db || this.bootstrapping || this.persistTimer) {
      return;
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persistNow();
    }, 180);
    this.persistTimer.unref?.();
  }

  private persistNow(): boolean {
    if (!this.db) {
      return false;
    }

    const persistStart = startPerfTimer();
    try {
      const activeSearchJobs = [...this.searchJobs.values()].filter((job) => isPersistableStatus(job.status));
      const activeMatrixJobs = [...this.matrixJobs.values()].filter((job) => isPersistableStatus(job.status));
      const activeSessionIds = new Set<string>([
        ...activeSearchJobs.map((job) => job.id),
        ...activeMatrixJobs.map((job) => job.id),
      ]);
      const activeOwnerKeys = new Set(this.ownerPurchasePathIds.keys());
      const activePurchasePaths = [...this.purchasePaths.values()].filter(
        (path) => activeSessionIds.has(path.sessionId)
          && activeOwnerKeys.has(this.ownerKey(path.sessionId, path.ownerId)),
      );
      const activeSearchJobIds = new Set(activeSearchJobs.map((job) => job.id));
      const activeMatrixJobIds = new Set(activeMatrixJobs.map((job) => job.id));
      const activePurchasePathIds = new Set(activePurchasePaths.map((path) => path.path.id));

      const deletedSearchJobIds = [...this.persistedSearchJobs.keys()]
        .filter((id) => !activeSearchJobIds.has(id));
      const deletedMatrixJobIds = [...this.persistedMatrixJobs.keys()]
        .filter((id) => !activeMatrixJobIds.has(id));
      const deletedPurchasePathIds = [...this.persistedPurchasePaths.keys()]
        .filter((id) => !activePurchasePathIds.has(id));
      const changedSearchJobs = activeSearchJobs
        .filter((job) => this.persistedSearchJobs.get(job.id)?.version !== searchJobPersistenceVersion(job))
        .map((job) => {
          const persisted = redactSearchJobForPersistence(job);
          const payload = JSON.stringify(persisted);
          return {
            job: persisted,
            payload,
            state: {
              version: searchJobPersistenceVersion(job),
              bytes: Buffer.byteLength(payload, "utf8"),
            },
          };
        });
      const changedMatrixJobs = activeMatrixJobs
        .filter((job) => this.persistedMatrixJobs.get(job.id)?.version !== matrixJobPersistenceVersion(job))
        .map((job) => {
          const persisted = redactMatrixJobForPersistence(job);
          const payload = JSON.stringify(persisted);
          return {
            job: persisted,
            payload,
            state: {
              version: matrixJobPersistenceVersion(job),
              bytes: Buffer.byteLength(payload, "utf8"),
            },
          };
        });
      const changedPurchasePaths = activePurchasePaths
        .filter((path) => this.persistedPurchasePaths.get(path.path.id)?.version !== purchasePathPersistenceVersion(path))
        .map((path) => {
          const persisted = redactStoredPurchasePathForPersistence(path);
          const payload = JSON.stringify(persisted);
          return {
            path: persisted,
            payload,
            state: {
              version: purchasePathPersistenceVersion(path),
              bytes: Buffer.byteLength(payload, "utf8"),
            },
          };
        });

      if (
        deletedSearchJobIds.length === 0
        && deletedMatrixJobIds.length === 0
        && deletedPurchasePathIds.length === 0
        && changedSearchJobs.length === 0
        && changedMatrixJobs.length === 0
        && changedPurchasePaths.length === 0
      ) {
        return true;
      }

      const db = this.db;
      const upsertSearchJob = db.prepare(`
        INSERT INTO search_jobs (
          id,
          idle_at_ms,
          status,
          sort_mode,
          request_key,
          provider_ids_key,
          provider_context_key,
          payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          idle_at_ms = excluded.idle_at_ms,
          status = excluded.status,
          sort_mode = excluded.sort_mode,
          request_key = excluded.request_key,
          provider_ids_key = excluded.provider_ids_key,
          provider_context_key = excluded.provider_context_key,
          payload = excluded.payload
      `);
      const upsertMatrixJob = db.prepare(`
        INSERT INTO matrix_jobs (
          id,
          idle_at_ms,
          status,
          payload
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          idle_at_ms = excluded.idle_at_ms,
          status = excluded.status,
          payload = excluded.payload
      `);
      const upsertPurchasePath = db.prepare(`
        INSERT INTO purchase_paths (
          id,
          session_id,
          owner_id,
          fingerprint,
          payload
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          session_id = excluded.session_id,
          owner_id = excluded.owner_id,
          fingerprint = excluded.fingerprint,
          payload = excluded.payload
      `);
      const deleteSearchJob = db.prepare("DELETE FROM search_jobs WHERE id = ?");
      const deleteMatrixJob = db.prepare("DELETE FROM matrix_jobs WHERE id = ?");
      const deletePurchasePath = db.prepare("DELETE FROM purchase_paths WHERE id = ?");
      try {
        const writeChanges = db.transaction(() => {
          for (const id of deletedPurchasePathIds) {
            deletePurchasePath.run(id);
          }
          for (const id of deletedMatrixJobIds) {
            deleteMatrixJob.run(id);
          }
          for (const id of deletedSearchJobIds) {
            deleteSearchJob.run(id);
          }

          for (const entry of changedSearchJobs) {
            upsertSearchJob.run(
              entry.job.id,
              resolveIdleTimestampMs(entry.job),
              entry.job.status,
              entry.job.sortMode,
              serializeForComparison(normalizeSearchRequestForSearchCache(entry.job.request)),
              serializeForComparison(entry.job.searchMeta.providersUsed ?? []),
              serializeForComparison(normalizeProviderContextForSearchCache(entry.job.providerContext)),
              entry.payload,
            );
          }

          for (const entry of changedMatrixJobs) {
            upsertMatrixJob.run(
              entry.job.id,
              resolveIdleTimestampMs(entry.job),
              entry.job.status,
              entry.payload,
            );
          }

          for (const entry of changedPurchasePaths) {
            upsertPurchasePath.run(
              entry.path.path.id,
              entry.path.sessionId,
              entry.path.ownerId,
              entry.path.fingerprint,
              entry.payload,
            );
          }

          runSql(db, `
            INSERT INTO cache_meta (key, value)
            VALUES ('savedAt', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `, nowIso());
        });

        writeChanges();
      } finally {
        upsertSearchJob.finalize();
        upsertMatrixJob.finalize();
        upsertPurchasePath.finalize();
        deleteSearchJob.finalize();
        deleteMatrixJob.finalize();
        deletePurchasePath.finalize();
      }

      deletedSearchJobIds.forEach((id) => this.persistedSearchJobs.delete(id));
      deletedMatrixJobIds.forEach((id) => this.persistedMatrixJobs.delete(id));
      deletedPurchasePathIds.forEach((id) => this.persistedPurchasePaths.delete(id));
      changedSearchJobs.forEach((entry) => this.persistedSearchJobs.set(entry.job.id, entry.state));
      changedMatrixJobs.forEach((entry) => this.persistedMatrixJobs.set(entry.job.id, entry.state));
      changedPurchasePaths.forEach((entry) => this.persistedPurchasePaths.set(entry.path.path.id, entry.state));

      logPerfSpan("sessionStore.persist", persistStart, {
        searchJobsWritten: changedSearchJobs.length,
        matrixJobsWritten: changedMatrixJobs.length,
        purchasePathsWritten: changedPurchasePaths.length,
        rowsDeleted: deletedSearchJobIds.length + deletedMatrixJobIds.length + deletedPurchasePathIds.length,
        bytesWritten: [
          ...changedSearchJobs,
          ...changedMatrixJobs,
          ...changedPurchasePaths,
        ].reduce((total, entry) => total + entry.state.bytes, 0),
      });
      return true;
    } catch {
      // Ignore persistence failures; in-memory store remains usable.
      return false;
    }
  }

  private initializeDatabase(): void {
    if (!this.db) {
      return;
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS search_jobs (
        id TEXT PRIMARY KEY,
        idle_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        sort_mode TEXT NOT NULL,
        request_key TEXT NOT NULL,
        provider_ids_key TEXT NOT NULL,
        provider_context_key TEXT NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_search_jobs_lookup
        ON search_jobs (status, sort_mode, request_key, provider_ids_key, provider_context_key, idle_at_ms);

      CREATE TABLE IF NOT EXISTS matrix_jobs (
        id TEXT PRIMARY KEY,
        idle_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_matrix_jobs_idle
        ON matrix_jobs (status, idle_at_ms);

      CREATE TABLE IF NOT EXISTS purchase_paths (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_purchase_paths_session
        ON purchase_paths (session_id);
    `);
  }

  private loadPersisted(): void {
    const nowMs = Date.now();
    this.pruneExpiredSqliteRows(nowMs);
    const hadSqliteRows = this.hasSqlitePayloadRows();
    try {
      this.bootstrapping = true;
      this.loadSqlitePayload();
      this.migrateLegacyPersistencePayload({ load: !hadSqliteRows });
    } finally {
      this.bootstrapping = false;
    }

    this.purgeExpired(nowMs);
    this.persistNow();
  }

  private hasSqlitePayloadRows(): boolean {
    if (!this.db) {
      return false;
    }

    return Boolean(
      getSql<{ present: number }>(this.db, "SELECT 1 AS present FROM search_jobs LIMIT 1")
        ?? getSql<{ present: number }>(this.db, "SELECT 1 AS present FROM matrix_jobs LIMIT 1")
        ?? getSql<{ present: number }>(this.db, "SELECT 1 AS present FROM purchase_paths LIMIT 1"),
    );
  }

  private migrateLegacyPersistencePayload(options: { load: boolean }): void {
    if (!this.legacyPersistPath || !existsSync(this.legacyPersistPath)) {
      return;
    }

    const parsed = parseJsonPayload<LegacyPersistencePayload>(readFileSync(this.legacyPersistPath, "utf8"));
    if (!parsed) {
      rmSync(this.legacyPersistPath, { force: true });
      return;
    }

    if (options.load) {
      this.loadPersistencePayload(
        Array.isArray(parsed.searchJobs) ? parsed.searchJobs : [],
        Array.isArray(parsed.matrixJobs) ? parsed.matrixJobs : [],
        Array.isArray(parsed.purchasePaths) ? parsed.purchasePaths : [],
      );
    }
    rmSync(this.legacyPersistPath, { force: true });
  }

  private pruneExpiredSqliteRows(nowMs: number): void {
    if (!this.db) {
      return;
    }

    const cutoffMs = nowMs - COMPLETED_SEARCH_SESSION_TTL_MS;
    const db = this.db;
    db.transaction(() => {
      runSql(db, `
        DELETE FROM purchase_paths
        WHERE session_id IN (
          SELECT id FROM search_jobs WHERE status != 'completed' OR idle_at_ms < ?
          UNION
          SELECT id FROM matrix_jobs WHERE status != 'completed' OR idle_at_ms < ?
        )
      `, cutoffMs, cutoffMs);
      runSql(db, "DELETE FROM search_jobs WHERE status != 'completed' OR idle_at_ms < ?", cutoffMs);
      runSql(db, "DELETE FROM matrix_jobs WHERE status != 'completed' OR idle_at_ms < ?", cutoffMs);
      runSql(db, `
        DELETE FROM purchase_paths
        WHERE session_id NOT IN (
          SELECT id FROM search_jobs
          UNION
          SELECT id FROM matrix_jobs
        )
      `);
    })();
  }

  private loadSqlitePayload(): void {
    if (!this.db) {
      return;
    }

    const searchJobs = allSql<SqlitePayloadRow>(this.db, "SELECT id, payload FROM search_jobs ORDER BY id");
    const matrixJobs = allSql<SqlitePayloadRow>(this.db, "SELECT id, payload FROM matrix_jobs ORDER BY id");
    const purchasePaths = allSql<SqlitePayloadRow>(this.db, "SELECT id, payload FROM purchase_paths ORDER BY id");
    const parsedSearchJobs = searchJobs
      .map((row) => {
        const parsed = parseJsonPayload<SearchJobRecord>(row.payload);
        if (!parsed) {
          this.persistedSearchJobs.set(row.id, {
            version: "",
            bytes: Buffer.byteLength(row.payload, "utf8"),
          });
          return undefined;
        }
        const redacted = redactSearchJobForPersistence(parsed);
        this.persistedSearchJobs.set(row.id, {
          version: parsed.providerContext?.costamar?.token
            ? ""
            : searchJobPersistenceVersion(redacted),
          bytes: Buffer.byteLength(row.payload, "utf8"),
        });
        return redacted;
      })
      .filter((job): job is SearchJobRecord => Boolean(job));
    const parsedMatrixJobs = matrixJobs
      .map((row) => {
        const parsed = parseJsonPayload<MatrixJobRecord>(row.payload);
        if (!parsed) {
          this.persistedMatrixJobs.set(row.id, {
            version: "",
            bytes: Buffer.byteLength(row.payload, "utf8"),
          });
          return undefined;
        }
        const redacted = redactMatrixJobForPersistence(parsed);
        this.persistedMatrixJobs.set(row.id, {
          version: parsed.providerContext?.costamar?.token
            ? ""
            : matrixJobPersistenceVersion(redacted),
          bytes: Buffer.byteLength(row.payload, "utf8"),
        });
        return redacted;
      })
      .filter((job): job is MatrixJobRecord => Boolean(job));
    const parsedPurchasePaths = purchasePaths
      .map((row) => {
        const parsed = parseJsonPayload<StoredPurchasePath>(row.payload);
        if (!parsed) {
          this.persistedPurchasePaths.set(row.id, {
            version: "",
            bytes: Buffer.byteLength(row.payload, "utf8"),
          });
          return undefined;
        }
        const redacted = redactStoredPurchasePathForPersistence(parsed);
        this.persistedPurchasePaths.set(row.id, {
          version: redacted.path.url === parsed.path.url && redacted.fingerprint === parsed.fingerprint
            ? purchasePathPersistenceVersion(redacted)
            : "",
          bytes: Buffer.byteLength(row.payload, "utf8"),
        });
        return redacted;
      })
      .filter((path): path is StoredPurchasePath => Boolean(path));

    this.loadPersistencePayload(parsedSearchJobs, parsedMatrixJobs, parsedPurchasePaths);
  }

  private loadPersistencePayload(
    searchJobsInput: SearchJobRecord[],
    matrixJobsInput: MatrixJobRecord[],
    purchasePathsInput: StoredPurchasePath[],
  ): void {
    const searchJobs = searchJobsInput.map(redactSearchJobForPersistence);
    const matrixJobs = matrixJobsInput.map(redactMatrixJobForPersistence);
    const purchasePaths = purchasePathsInput.map(redactStoredPurchasePathForPersistence);

    searchJobs
      .filter((job) => job?.status === "completed" && typeof job?.id === "string")
      .forEach((job) => {
        this.searchJobs.set(job.id, job);
        this.syncSearchSessionMetadata(job);
      });
    matrixJobs
      .filter((job) => job?.status === "completed" && typeof job?.id === "string")
      .forEach((job) => {
        this.matrixJobs.set(job.id, job);
      });

    const activeSessionIds = new Set<string>([
      ...this.searchJobs.keys(),
      ...this.matrixJobs.keys(),
    ]);
    purchasePaths
      .filter((entry) => entry && typeof entry.path?.id === "string" && activeSessionIds.has(entry.sessionId))
      .forEach((entry) => {
        this.trackPersistedPurchasePath(entry);
      });
  }

  private trackPersistedPurchasePath(entry: StoredPurchasePath): void {
    this.purchasePaths.set(entry.path.id, entry);
    const ids = this.sessionPurchasePathIds.get(entry.sessionId) ?? new Set<string>();
    ids.add(entry.path.id);
    this.sessionPurchasePathIds.set(entry.sessionId, ids);

    const ownerKey = this.ownerKey(entry.sessionId, entry.ownerId);
    const ownerKeys = this.sessionOwnerKeys.get(entry.sessionId) ?? new Set<string>();
    ownerKeys.add(ownerKey);
    this.sessionOwnerKeys.set(entry.sessionId, ownerKeys);

    const ownerPaths = this.ownerPurchasePathIds.get(ownerKey) ?? new Map<string, string>();
    ownerPaths.set(entry.fingerprint, entry.path.id);
    this.ownerPurchasePathIds.set(ownerKey, ownerPaths);
  }

  private ownerKey(sessionId: string, ownerId: string): string {
    return `${sessionId}\u0000${ownerId}`;
  }

  private parseOwnerKey(ownerKey: string): [string, string] {
    const parts = ownerKey.split("\u0000");
    return [parts[0] ?? "", parts[1] ?? ""];
  }

  private searchJobSnapshot(job: SearchJobRecord) {
    return {
      request: job.request,
      providerContext: job.providerContext,
      offers: job.offers,
      allOffers: job.allOffers,
      searchMeta: job.searchMeta,
      providerMeta: job.providerMeta,
      warnings: job.warnings,
      providerDiagnostics: job.providerDiagnostics,
      sortMode: job.sortMode,
      status: job.status,
      error: job.error,
    };
  }

  private matrixJobSnapshot(job: MatrixJobRecord) {
    return {
      request: job.request,
      providerContext: job.providerContext,
      cells: job.cells,
      axes: job.axes,
      confidenceSummary: job.confidenceSummary,
      recommendations: job.recommendations,
      providerMeta: job.providerMeta,
      searchMeta: job.searchMeta,
      warnings: job.warnings,
      providerDiagnostics: job.providerDiagnostics,
      status: job.status,
      error: job.error,
    };
  }
}
