import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  CanonicalOffer,
  MatrixCell,
  ProviderContext,
  ProviderId,
  ProviderMeta,
  PurchasePath,
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
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  revision: number;
  status: "running" | "completed" | "failed";
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
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  revision: number;
  status: "running" | "completed" | "failed";
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
  status: "running" | "completed" | "failed";
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
  sortMode: "cheapest" | "fastest" | "best-value";
  status: "running" | "completed" | "failed";
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
    matrixJobs: number;
    runningMatrixJobs: number;
    completedMatrixJobs: number;
    failedMatrixJobs: number;
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
  persistPath?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function serializeForComparison(value: unknown): string {
  return JSON.stringify(value);
}

function safeJsonSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
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

export class SearchSessionStore {
  private readonly sessions = new Map<string, SearchSessionMetadata>();
  private readonly purchasePaths = new Map<string, StoredPurchasePath>();
  private readonly sessionPurchasePathIds = new Map<string, Set<string>>();
  private readonly sessionOwnerKeys = new Map<string, Set<string>>();
  private readonly ownerPurchasePathIds = new Map<string, Map<string, string>>();
  private readonly matrixJobs = new Map<string, MatrixJobRecord>();
  private readonly searchJobs = new Map<string, SearchJobRecord>();
  private readonly persistPath: string | undefined;
  private persistTimer: NodeJS.Timeout | undefined;
  private bootstrapping = false;
  private lastPersistedPayload = "";

  constructor(options?: SearchSessionStoreOptions) {
    this.persistPath = options?.persistPath?.trim() || undefined;
    if (this.persistPath) {
      this.loadPersisted();
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
    const requestKey = serializeForComparison(input.request);
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

      if (serializeForComparison(candidate.request) !== requestKey) {
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
        matrixJobs: matrixJobs.length,
        runningMatrixJobs: matrixJobs.filter((job) => job.status === "running").length,
        completedMatrixJobs: matrixJobs.filter((job) => job.status === "completed").length,
        failedMatrixJobs: matrixJobs.filter((job) => job.status === "failed").length,
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
    return {
      ...cell,
      purchasePaths: this.rewritePurchasePaths(sessionId, cell.key, cell.purchasePaths ?? []),
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
    if (!this.persistPath || this.bootstrapping || this.persistTimer) {
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
      .sort((left, right) => left.id.localeCompare(right.id));
    const matrixJobs = [...this.matrixJobs.values()]
      .filter((job) => job.status === "completed")
      .sort((left, right) => left.id.localeCompare(right.id));
    const activeSessionIds = new Set<string>([
      ...searchJobs.map((job) => job.id),
      ...matrixJobs.map((job) => job.id),
    ]);
    const purchasePaths = [...this.purchasePaths.values()]
      .filter((path) => activeSessionIds.has(path.sessionId))
      .sort((left, right) => left.path.id.localeCompare(right.path.id));

    return {
      version: 1,
      savedAt: nowIso(),
      searchJobs,
      matrixJobs,
      purchasePaths,
    };
  }

  private persistNow(): void {
    if (!this.persistPath) {
      return;
    }

    try {
      const payload = this.buildPersistencePayload();
      const serialized = JSON.stringify(payload);
      if (serialized === this.lastPersistedPayload) {
        return;
      }

      mkdirSync(dirname(this.persistPath), { recursive: true });
      const tempPath = `${this.persistPath}.${process.pid}.tmp`;
      writeFileSync(tempPath, serialized, "utf8");
      renameSync(tempPath, this.persistPath);
      this.lastPersistedPayload = serialized;
    } catch {
      // Ignore persistence failures; in-memory store remains usable.
    }
  }

  private loadPersisted(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) {
      return;
    }

    try {
      const parsed = JSON.parse(readFileSync(this.persistPath, "utf8")) as PersistedSearchSessionStore;
      if (parsed?.version !== 1) {
        return;
      }

      const searchJobs = Array.isArray(parsed.searchJobs) ? parsed.searchJobs : [];
      const matrixJobs = Array.isArray(parsed.matrixJobs) ? parsed.matrixJobs : [];
      const purchasePaths = Array.isArray(parsed.purchasePaths) ? parsed.purchasePaths : [];

      this.bootstrapping = true;
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
        });
    } catch {
      // Ignore malformed files and continue with an empty store.
    } finally {
      this.bootstrapping = false;
    }

    this.lastPersistedPayload = JSON.stringify(this.buildPersistencePayload());
    this.purgeExpired();
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
      status: job.status,
      error: job.error,
    };
  }
}
