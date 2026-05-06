import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import Database = require("better-sqlite3");
import { logPerfSpan, startPerfTimer } from "./perf";
import { LIST_SEARCH_RESULT_LIMIT } from "./search-limits";
import {
  CanonicalOffer,
  MatrixCell,
  ProviderContext,
  ProviderDiagnostics,
  ProviderId,
  ProviderMeta,
  PurchasePath,
  SearchMeta,
  SearchRequest,
} from "./core/types";

const COMPLETED_SEARCH_SESSION_DEFAULT_TTL_MS = 4 * 60 * 60 * 1000;
const PERSISTED_SEARCH_JOB_ALL_OFFERS_LIMIT = (() => {
  const raw = Number(process.env.SEARCH_PERSISTED_JOB_ALL_OFFERS_LIMIT ?? LIST_SEARCH_RESULT_LIMIT);
  return Number.isFinite(raw) && raw > 0
    ? Math.trunc(raw)
    : LIST_SEARCH_RESULT_LIMIT;
})();
export const COMPLETED_SEARCH_SESSION_TTL_MS = (() => {
  const raw = Number(process.env.SEARCH_COMPLETED_SESSION_TTL_MS ?? COMPLETED_SEARCH_SESSION_DEFAULT_TTL_MS);
  return Number.isFinite(raw) && raw >= 0
    ? raw
    : COMPLETED_SEARCH_SESSION_DEFAULT_TTL_MS;
})();

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
  sortMode: "cheapest" | "fastest" | "best-value";
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

interface PurgeSummary {
  searchJobs: number;
  matrixJobs: number;
  sessions: number;
  purchasePaths: number;
}

interface PersistedSearchSessionStore {
  version: 1;
  savedAt: string;
  searchJobs: SearchJobRecord[];
  matrixJobs: MatrixJobRecord[];
  purchasePaths: StoredPurchasePath[];
}

interface SearchSessionStoreOptions {
  dbPath?: string;
  legacyPersistPath?: string;
  persistPath?: string;
}

interface SqlitePayloadRow {
  payload: string;
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

function persistenceComparisonPayload(payload: PersistedSearchSessionStore): PersistedSearchSessionStore {
  return {
    ...payload,
    savedAt: "",
  };
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

function normalizeSearchRequestForSearchCache(request: SearchRequest): SearchRequest {
  const next = cloneJson(request);
  if (next.filters?.compactAllOffers !== true) {
    delete next.filters.compactAllOffers;
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
  const next = cloneJson(path);
  if (next.provider === "costamar" && next.type === "search-redirect") {
    next.url = redactCostamarSearchRedirectUrl(next.url);
  }
  return next;
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
    ...cloneJson(entry),
    path,
    fingerprint,
  };
}

function redactSearchJobForPersistence(job: SearchJobRecord): SearchJobRecord {
  const next = cloneJson(job);

  return {
    ...next,
    offers: next.offers.slice(0, PERSISTED_SEARCH_JOB_ALL_OFFERS_LIMIT),
    allOffers: next.allOffers.slice(0, PERSISTED_SEARCH_JOB_ALL_OFFERS_LIMIT),
    providerContext: redactProviderContextForPersistence(job.providerContext),
  };
}

function redactMatrixJobForPersistence(job: MatrixJobRecord): MatrixJobRecord {
  return {
    ...cloneJson(job),
    providerContext: redactProviderContextForPersistence(job.providerContext),
  };
}

export class SearchSessionStore {
  private readonly sessions = new Map<string, SearchSessionMetadata>();
  private readonly purchasePaths = new Map<string, StoredPurchasePath>();
  private readonly sessionPurchasePathIds = new Map<string, Set<string>>();
  private readonly sessionOwnerKeys = new Map<string, Set<string>>();
  private readonly ownerPurchasePathIds = new Map<string, Map<string, string>>();
  private readonly matrixJobs = new Map<string, MatrixJobRecord>();
  private readonly searchJobs = new Map<string, SearchJobRecord>();
  private readonly db: Database.Database | undefined;
  private readonly legacyPersistPath: string | undefined;
  private persistTimer: NodeJS.Timeout | undefined;
  private bootstrapping = false;
  private lastPersistedPayload = "";

  constructor(options?: SearchSessionStoreOptions) {
    const dbPath = options?.dbPath?.trim() || undefined;
    this.legacyPersistPath = options?.legacyPersistPath?.trim()
      || options?.persistPath?.trim()
      || undefined;

    if (dbPath) {
      mkdirSync(dirname(dbPath), { recursive: true });
      this.db = new Database(dbPath);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.db.pragma("temp_store = MEMORY");
      this.db.pragma("busy_timeout = 5000");
      this.db.pragma("foreign_keys = ON");
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
    this.db?.close();
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
    const id = randomUUID();
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
      searchMeta: {
        ...input.searchMeta,
        searchSessionId: id,
      },
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
      searchMeta: {
        ...updated.searchMeta,
        searchSessionId: current.id,
      },
    };
    const hasChanged = serializeForComparison(this.searchJobSnapshot(base))
      !== serializeForComparison(this.searchJobSnapshot(current));
    const next: SearchJobRecord = {
      ...base,
      revision: hasChanged ? current.revision + 1 : current.revision,
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
    const id = randomUUID();
    const timestamp = nowIso();
    const record: MatrixJobRecord = {
      ...input,
      cells: input.cells.map((cell) => this.rewriteMatrixCellPaths(id, cell)),
      id,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastAccessedAt: timestamp,
      revision: 1,
      searchMeta: {
        ...input.searchMeta,
        searchSessionId: id,
      },
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
      searchMeta: {
        ...updated.searchMeta,
        searchSessionId: current.id,
      },
    };
    const hasChanged = serializeForComparison(this.matrixJobSnapshot(base))
      !== serializeForComparison(this.matrixJobSnapshot(current));
    const next: MatrixJobRecord = {
      ...base,
      revision: hasChanged ? current.revision + 1 : current.revision,
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
        searchJobs: searchJobs.reduce((total, job) => total + safeJsonSize(this.searchJobSnapshot(job)), 0),
        matrixJobs: matrixJobs.reduce((total, job) => total + safeJsonSize(this.matrixJobSnapshot(job)), 0),
        purchasePaths: [...this.purchasePaths.values()].reduce((total, path) => total + safeJsonSize(path), 0),
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
      const purchasePathId = existingId ?? randomUUID();
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
        updatedAt: timestamp,
        lastAccessedAt: timestamp,
      });

      return {
        ...rawPath,
        id: purchasePathId,
        url: `/r/${purchasePathId}`,
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
      searchMeta: {
        ...job.searchMeta,
        searchSessionId: job.id,
      },
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

  private buildPersistencePayload(): PersistedSearchSessionStore {
    const searchJobs = [...this.searchJobs.values()]
      .filter((job) => job.status === "completed")
      .map(redactSearchJobForPersistence)
      .sort((left, right) => left.id.localeCompare(right.id));
    const matrixJobs = [...this.matrixJobs.values()]
      .filter((job) => job.status === "completed")
      .map(redactMatrixJobForPersistence)
      .sort((left, right) => left.id.localeCompare(right.id));
    const activeSessionIds = new Set<string>([
      ...searchJobs.map((job) => job.id),
      ...matrixJobs.map((job) => job.id),
    ]);
    const activeOwnerKeys = new Set<string>();
    for (const job of searchJobs) {
      for (const offer of [...job.offers, ...job.allOffers]) {
        activeOwnerKeys.add(this.ownerKey(job.id, offer.id));
      }
    }
    for (const job of matrixJobs) {
      for (const cell of job.cells) {
        activeOwnerKeys.add(this.ownerKey(job.id, cell.key));
      }
    }
    const purchasePaths = [...this.purchasePaths.values()]
      .filter((path) => activeSessionIds.has(path.sessionId) && activeOwnerKeys.has(this.ownerKey(path.sessionId, path.ownerId)))
      .map(redactStoredPurchasePathForPersistence)
      .sort((left, right) => left.path.id.localeCompare(right.path.id));

    return {
      version: 1,
      savedAt: nowIso(),
      searchJobs,
      matrixJobs,
      purchasePaths,
    };
  }

  private persistNow(): boolean {
    if (!this.db) {
      return false;
    }

    const persistStart = startPerfTimer();
    try {
      const payload = this.buildPersistencePayload();
      const serialized = JSON.stringify(payload);
      const serializedForComparison = JSON.stringify(persistenceComparisonPayload(payload));
      if (serializedForComparison === this.lastPersistedPayload) {
        return true;
      }

      const insertSearchJob = this.db.prepare(`
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
      `);
      const insertMatrixJob = this.db.prepare(`
        INSERT INTO matrix_jobs (
          id,
          idle_at_ms,
          status,
          payload
        ) VALUES (?, ?, ?, ?)
      `);
      const insertPurchasePath = this.db.prepare(`
        INSERT INTO purchase_paths (
          id,
          session_id,
          owner_id,
          fingerprint,
          payload
        ) VALUES (?, ?, ?, ?, ?)
      `);
      const writePayload = this.db.transaction((nextPayload: PersistedSearchSessionStore) => {
        this.db?.prepare("DELETE FROM purchase_paths").run();
        this.db?.prepare("DELETE FROM matrix_jobs").run();
        this.db?.prepare("DELETE FROM search_jobs").run();

        for (const job of nextPayload.searchJobs) {
          insertSearchJob.run(
            job.id,
            resolveIdleTimestampMs(job),
            job.status,
            job.sortMode,
            serializeForComparison(normalizeSearchRequestForSearchCache(job.request)),
            serializeForComparison(job.searchMeta.providersUsed ?? []),
            serializeForComparison(normalizeProviderContextForSearchCache(job.providerContext)),
            JSON.stringify(job),
          );
        }

        for (const job of nextPayload.matrixJobs) {
          insertMatrixJob.run(
            job.id,
            resolveIdleTimestampMs(job),
            job.status,
            JSON.stringify(job),
          );
        }

        for (const path of nextPayload.purchasePaths) {
          insertPurchasePath.run(
            path.path.id,
            path.sessionId,
            path.ownerId,
            path.fingerprint,
            JSON.stringify(path),
          );
        }

        this.db?.prepare(`
          INSERT INTO cache_meta (key, value)
          VALUES ('savedAt', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(nextPayload.savedAt);
      });

      writePayload(payload);
      this.lastPersistedPayload = serializedForComparison;
      logPerfSpan("sessionStore.persist", persistStart, {
        searchJobs: payload.searchJobs.length,
        matrixJobs: payload.matrixJobs.length,
        purchasePaths: payload.purchasePaths.length,
        bytes: Buffer.byteLength(serialized, "utf8"),
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
    try {
      this.bootstrapping = true;
      const migrated = this.migrateLegacyJsonIfNeeded();
      if (!migrated) {
        this.loadSqlitePayload();
      }
    } finally {
      this.bootstrapping = false;
    }

    this.lastPersistedPayload = "";
    this.purgeExpired();
  }

  private migrateLegacyJsonIfNeeded(): boolean {
    if (!this.db || !this.legacyPersistPath || !existsSync(this.legacyPersistPath) || this.databaseHasRows()) {
      return false;
    }

    const parsed = this.readLegacyJsonPayload();
    if (!parsed) {
      return false;
    }

    this.loadPersistencePayload(parsed);
    if (!this.persistNow()) {
      return false;
    }

    try {
      rmSync(this.legacyPersistPath, { force: true });
    } catch {
      // Keep the imported SQLite cache even if the old JSON file cannot be removed.
    }
    return true;
  }

  private readLegacyJsonPayload(): PersistedSearchSessionStore | undefined {
    if (!this.legacyPersistPath) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(readFileSync(this.legacyPersistPath, "utf8")) as PersistedSearchSessionStore;
      if (parsed?.version !== 1) {
        return undefined;
      }
      return parsed;
    } catch {
      // Ignore malformed files and continue with an empty store.
      return undefined;
    }
  }

  private databaseHasRows(): boolean {
    if (!this.db) {
      return false;
    }

    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM search_jobs)
        + (SELECT COUNT(*) FROM matrix_jobs)
        + (SELECT COUNT(*) FROM purchase_paths) AS total
    `).get() as { total?: number } | undefined;
    return Number(row?.total ?? 0) > 0;
  }

  private loadSqlitePayload(): void {
    if (!this.db) {
      return;
    }

    const searchJobs = this.db
      .prepare("SELECT payload FROM search_jobs ORDER BY id")
      .all() as SqlitePayloadRow[];
    const matrixJobs = this.db
      .prepare("SELECT payload FROM matrix_jobs ORDER BY id")
      .all() as SqlitePayloadRow[];
    const purchasePaths = this.db
      .prepare("SELECT payload FROM purchase_paths ORDER BY id")
      .all() as SqlitePayloadRow[];

    this.loadPersistencePayload({
      version: 1,
      savedAt: "",
      searchJobs: searchJobs
        .map((row) => parseJsonPayload<SearchJobRecord>(row.payload))
        .filter((job): job is SearchJobRecord => Boolean(job)),
      matrixJobs: matrixJobs
        .map((row) => parseJsonPayload<MatrixJobRecord>(row.payload))
        .filter((job): job is MatrixJobRecord => Boolean(job)),
      purchasePaths: purchasePaths
        .map((row) => parseJsonPayload<StoredPurchasePath>(row.payload))
        .filter((path): path is StoredPurchasePath => Boolean(path)),
    });
  }

  private loadPersistencePayload(parsed: PersistedSearchSessionStore): void {
    const searchJobs = Array.isArray(parsed.searchJobs)
      ? parsed.searchJobs.map(redactSearchJobForPersistence)
      : [];
    const matrixJobs = Array.isArray(parsed.matrixJobs)
      ? parsed.matrixJobs.map(redactMatrixJobForPersistence)
      : [];
    const purchasePaths = Array.isArray(parsed.purchasePaths)
      ? parsed.purchasePaths.map(redactStoredPurchasePathForPersistence)
      : [];

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
