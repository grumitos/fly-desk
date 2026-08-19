import { mkdirSync } from "node:fs";
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
/* Past this, the boot is worth a line in the journal on its own. */
const BOOT_TIMING_REPORT_MS = 1_000;
/*
 * How much of the persisted cache is parsed back into memory before the process
 * can serve anything, and why it is not 128 MB any more.
 *
 * This budget is paid on the boot path: `loadPersisted()` runs in the store's
 * constructor, the runtime is built before `createServer()`, and the port opens
 * only once both are done. On 2026-08-19 the production search runner took **84
 * seconds** to reach `Fly Desk running at http://127.0.0.1:8101` with 55 jobs
 * and 1.78 GB on disk, burning 65s of CPU and peaking at 912 MB with 256 MB of
 * swap on a 3.8 GB box. The release engine's health window is shorter than
 * that, so the deployment failed activation, rolled back — and the rollback
 * restarted the previous release into the same 84 seconds, which is what
 * «previous release did not recover cleanly» meant.
 *
 * Measured on a 382 MB store of the same shape, boot falls with the budget:
 * 2.56s at 128 MB, 1.85s at 32, 1.24s at 8. The rest is the fixed floor (prune,
 * the metadata queries, the first persist), and the part that scales with this
 * number is `JSON.parse` and the memory it holds — the exact cost that turns
 * into swap on the box.
 *
 * 16 MB, then, and it is only a *pre-warm*: what is not restored stays on disk
 * and is read on demand, transparently, which is what the disk-only tier has
 * always done for everything past the budget. What a running desk keeps in
 * memory is a different number with its own env var
 * (`SEARCH_COMPLETED_SESSION_RESIDENT_BUDGET_BYTES`), unchanged at 128 MB.
 */
const PERSISTED_SEARCH_CACHE_RESTORE_DEFAULT_BUDGET_BYTES = 16 * 1024 * 1024;

function persistedRestoreBudgetBytes(configured?: number): number {
  if (typeof configured === "number" && Number.isFinite(configured) && configured >= 0) {
    return configured;
  }

  const raw = process.env.SEARCH_PERSISTED_RESTORE_BUDGET_BYTES?.trim();
  const parsed = raw ? Number(raw) : undefined;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : PERSISTED_SEARCH_CACHE_RESTORE_DEFAULT_BUDGET_BYTES;
}
const COMPLETED_SEARCH_SESSION_RESIDENT_DEFAULT_BUDGET_BYTES = 128 * 1024 * 1024;
export const COMPLETED_SEARCH_SESSION_RESIDENT_GRACE_MS = 5_000;
/* The write debounce. Named so a test can advance exactly one debounce rather
   than sleep for "long enough". */
export const SESSION_STORE_PERSIST_DEBOUNCE_MS = 180;
/*
 * Durability policy, half two: this is the age a finished job may reach before
 * a sweep takes it, and nothing else. It is not a switch for whether the desk
 * stores results at all.
 *
 * So `0` is the shortest lifetime the sweep can express, not a `no-store`: a
 * job is stored the instant it is created, survives a sweep that runs at its
 * own timestamp, and is taken by the first sweep that sees a positive age —
 * which on a running desk is the 60s maintenance interval of `src/index.ts`,
 * not the moment the search ended. Reuse follows the same threshold, so at `0`
 * a completed search is never handed to a second request; only the retention
 * window is longer than the number suggests. A deployment that must not keep
 * finished searches on disk has to say so by not giving the store a database,
 * not by asking this number for a guarantee it does not make.
 */
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

/*
 * The statuses the sweep removes, written out rather than expressed as
 * «anything but completed».
 *
 * `status <> 'completed'` cannot seek an index, so SQLite answered it by
 * reading the table — and this table's rows carry the payloads, which is how a
 * prune that deletes nothing came to cost 16.6 seconds of a 22-second boot on
 * a 1.78 GB store. `IN` over the three seeks `idx_search_jobs_lookup`, which
 * leads with `status`. The list is exhaustive against the union above; a status
 * added there and forgotten here is still swept by age, the branch beside it.
 */
const SWEEPABLE_JOB_STATUSES: readonly SearchJobStatus[] = ["running", "failed", "cancelled"];
const SWEEPABLE_JOB_STATUS_LIST = SWEEPABLE_JOB_STATUSES.map((status) => `'${status}'`).join(", ");

/**
 * What the sweep runs, in order, with the cutoff bound to `?1`.
 *
 * Exported so a test can hold them against `EXPLAIN QUERY PLAN`: every one of
 * them must seek an index. The single `OR` they replaced could not, so SQLite
 * read the table — and these rows carry the payloads.
 */
export const PERSISTED_SWEEP_STATEMENTS: readonly string[] = [
  `DELETE FROM purchase_paths WHERE session_id IN (
     SELECT id FROM search_jobs WHERE idle_at_ms < ?1
     UNION
     SELECT id FROM search_jobs WHERE status IN (${SWEEPABLE_JOB_STATUS_LIST})
     UNION
     SELECT id FROM matrix_jobs WHERE idle_at_ms < ?1
     UNION
     SELECT id FROM matrix_jobs WHERE status IN (${SWEEPABLE_JOB_STATUS_LIST})
   )`,
  "DELETE FROM search_jobs WHERE idle_at_ms < ?1",
  `DELETE FROM search_jobs WHERE status IN (${SWEEPABLE_JOB_STATUS_LIST})`,
  "DELETE FROM matrix_jobs WHERE idle_at_ms < ?1",
  `DELETE FROM matrix_jobs WHERE status IN (${SWEEPABLE_JOB_STATUS_LIST})`,
];

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
  residentCache: {
    budgetBytes: number;
    completedJobs: number;
    completedBytes: number;
    diskOnlyJobs: number;
    diskOnlyBytes: number;
  };
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

export type SessionStoreTimerHandle = unknown;

/*
 * The seam the store reads time through.
 *
 * Two timers make the store's observable behaviour depend on the wall clock:
 * the 180ms persist debounce and the resident-budget grace recheck, which is
 * armed for a full `COMPLETED_SEARCH_SESSION_RESIDENT_GRACE_MS` after a job
 * completes. A test that wanted to watch either had to sleep for real and then
 * poll against a deadline, which is a race it loses as soon as the machine is
 * busy — and the grace recheck gave it a five-second wait to win.
 *
 * `now` and the timers travel together on purpose. A virtual clock paired with
 * real `setTimeout` is not a coherent world: the store computes its delays as
 * `nextEligibleAt - now`, so a caller that could move one without the other
 * would arm timers against a deadline that no longer means anything.
 */
export interface SessionStoreScheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): SessionStoreTimerHandle;
  clearTimeout(handle: SessionStoreTimerHandle): void;
}

const REAL_SESSION_STORE_SCHEDULER: SessionStoreScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    /* A cache sweep is never a reason to hold the process open. */
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

interface SearchSessionStoreOptions {
  dbPath?: string;
  persistedRestoreBudgetBytes?: number;
  completedResidentBudgetBytes?: number;
  scheduler?: SessionStoreScheduler;
}

interface SqlitePayloadRow {
  id: string;
  payload: string;
}

interface PersistedJobRestoreCandidate {
  id: string;
  kind: "matrix" | "search";
  idleAtMs: number;
  payloadBytes: number;
}

interface PersistedEntryState {
  version: string;
  bytes: number;
}

interface ResidentJobCandidate {
  id: string;
  kind: "matrix" | "search";
  bytes: number;
  completedAtMs: number;
  lastAccessedAtMs: number;
}

interface SqliteStoredRedirectRow {
  payload: string;
  idleAtMs: number;
}

interface SqliteStoredRedirectContextRow {
  requestKey?: string;
  providerContextKey?: string;
  payload?: string;
  idleAtMs: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function completedResidentBudgetBytes(configured?: number): number {
  const configuredEnv = process.env.SEARCH_COMPLETED_SESSION_RESIDENT_BUDGET_BYTES?.trim();
  const raw = configured ?? (configuredEnv
    ? Number(configuredEnv)
    : COMPLETED_SEARCH_SESSION_RESIDENT_DEFAULT_BUDGET_BYTES);
  return Number.isFinite(raw) && raw >= 0
    ? raw
    : COMPLETED_SEARCH_SESSION_RESIDENT_DEFAULT_BUDGET_BYTES;
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

function resolveSearchCompletionTimestampMs(record: {
  searchMeta?: Partial<Pick<SearchMeta, "completedAt">>;
  updatedAt?: string;
  createdAt?: string;
}): number {
  for (const value of [record.searchMeta?.completedAt, record.updatedAt, record.createdAt]) {
    const timestamp = Date.parse(value ?? "");
    if (Number.isFinite(timestamp)) {
      return timestamp;
    }
  }
  return 0;
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

function matrixCellHasPersistableResult(cell: MatrixCell): boolean {
  return Boolean(cell.offer)
    || typeof cell.price?.amount === "number"
    || Boolean(cell.purchasePaths?.length);
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
    cells: job.cells.filter(matrixCellHasPersistableResult).map(redactMatrixCellForPersistence),
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

function onlyProviderDiagnosticsChanged(
  current: SearchJobRecord | MatrixJobRecord,
  updated: SearchJobRecord | MatrixJobRecord,
): boolean {
  if (current.providerDiagnostics === updated.providerDiagnostics) {
    return false;
  }

  const currentRecord = current as unknown as Record<string, unknown>;
  const updatedRecord = updated as unknown as Record<string, unknown>;
  const currentKeys = Object.keys(currentRecord).filter((key) => key !== "providerDiagnostics");
  const updatedKeys = Object.keys(updatedRecord).filter((key) => key !== "providerDiagnostics");
  return currentKeys.length === updatedKeys.length
    && currentKeys.every((key) => Object.hasOwn(updatedRecord, key) && currentRecord[key] === updatedRecord[key]);
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
  private readonly persistedRestoreBudgetBytes: number;
  private readonly completedResidentBudgetBytes: number;
  private readonly persistedSearchJobs = new Map<string, PersistedEntryState>();
  private readonly persistedMatrixJobs = new Map<string, PersistedEntryState>();
  private readonly persistedPurchasePaths = new Map<string, PersistedEntryState>();
  private readonly deferredSearchJobs = new Set<string>();
  private readonly deferredMatrixJobs = new Set<string>();
  private readonly diskOnlySearchJobs = new Map<string, number>();
  private readonly diskOnlyMatrixJobs = new Map<string, number>();
  private readonly diskOnlyPurchasePathIds = new Set<string>();
  private readonly diskOnlySessionPurchasePathIds = new Map<string, Set<string>>();
  private readonly scheduler: SessionStoreScheduler;
  private persistTimer: SessionStoreTimerHandle | undefined;
  private residentBudgetTimer: SessionStoreTimerHandle | undefined;
  private residentBudgetDueAt = 0;
  private bootstrapping = false;

  constructor(options?: SearchSessionStoreOptions) {
    this.scheduler = options?.scheduler ?? REAL_SESSION_STORE_SCHEDULER;
    const dbPath = options?.dbPath?.trim() || undefined;
    this.persistedRestoreBudgetBytes = persistedRestoreBudgetBytes(
      options?.persistedRestoreBudgetBytes,
    );
    this.completedResidentBudgetBytes = completedResidentBudgetBytes(
      options?.completedResidentBudgetBytes,
    );

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
      this.scheduler.clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    this.persistNow();
    if (this.residentBudgetTimer) {
      this.scheduler.clearTimeout(this.residentBudgetTimer);
      this.residentBudgetTimer = undefined;
      this.residentBudgetDueAt = 0;
    }
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
    const residentJob = this.searchJobs.get(sessionId);
    const job = residentJob ?? this.readPersistedSearchJob(sessionId);
    if (!job) {
      return undefined;
    }

    const session = this.sessions.get(sessionId);
    const updatedSession = residentJob && session
      ? this.touchSessionMetadata(sessionId, this.touchSearchJob(residentJob)) ?? session
      : job;
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
    const residentJob = this.searchJobs.get(sessionId);
    const job = residentJob ?? this.readPersistedSearchJob(sessionId);
    if (!job) {
      return undefined;
    }

    if (residentJob) {
      const touchedAt = this.touchSearchJob(residentJob);
      this.touchSessionMetadata(sessionId, touchedAt);
    }
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
      return this.readPersistedSearchJob(jobId);
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

    const nowMs = input.nowMs ?? this.scheduler.now();
    const requestKey = serializeForComparison(normalizeSearchRequestForSearchCache(input.request));
    const providerIdsKey = serializeForComparison(input.providerIds);
    const providerContextKey = serializeForComparison(
      normalizeProviderContextForSearchCache(input.providerContext),
    );

    let latest: SearchJobRecord | undefined;
    let latestCompletionTimestamp = 0;

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

      const completionTimestamp = resolveSearchCompletionTimestampMs(candidate);
      if ((nowMs - completionTimestamp) > input.maxAgeMs) {
        continue;
      }

      if (!latest || completionTimestamp > latestCompletionTimestamp) {
        latest = candidate;
        latestCompletionTimestamp = completionTimestamp;
      }
    }

    if (!latest) {
      return undefined;
    }

    const touchedAt = this.touchSearchJob(latest);
    this.touchSessionMetadata(latest.id, touchedAt);
    return latest;
  }

  findRecentCompletedMatrixJob(input: {
    request: SearchRequest;
    providerContext?: ProviderContext;
    providerIds: ProviderId[];
    maxAgeMs: number;
    nowMs?: number;
  }): MatrixJobRecord | undefined {
    if (!Number.isFinite(input.maxAgeMs) || input.maxAgeMs <= 0) {
      return undefined;
    }

    const nowMs = input.nowMs ?? this.scheduler.now();
    const requestKey = serializeForComparison(normalizeSearchRequestForSearchCache(input.request));
    const providerIdsKey = serializeForComparison(input.providerIds);
    const providerContextKey = serializeForComparison(
      normalizeProviderContextForSearchCache(input.providerContext),
    );

    let latest: MatrixJobRecord | undefined;
    let latestCompletionTimestamp = 0;

    for (const candidate of this.matrixJobs.values()) {
      if (candidate.status !== "completed") {
        continue;
      }

      if (!hasCurrentSearchCacheVersion(candidate.searchMeta)) {
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

      const completionTimestamp = resolveSearchCompletionTimestampMs(candidate);
      if ((nowMs - completionTimestamp) > input.maxAgeMs) {
        continue;
      }

      if (!latest || completionTimestamp > latestCompletionTimestamp) {
        latest = candidate;
        latestCompletionTimestamp = completionTimestamp;
      }
    }

    if (!latest) {
      return undefined;
    }

    this.touchMatrixJob(latest);
    return latest;
  }

  updateSearchJob(
    jobId: string,
    updater: (current: SearchJobRecord) => SearchJobRecord,
    options: { persist?: boolean } = {},
  ): SearchJobRecord | undefined {
    const current = this.searchJobs.get(jobId);
    if (!current) {
      return undefined;
    }

    const updated = updater(current);
    if (updated === current) {
      if (options.persist !== false && this.deferredSearchJobs.delete(jobId)) {
        this.schedulePersist();
      }
      return current;
    }

    if (onlyProviderDiagnosticsChanged(current, updated)) {
      current.providerDiagnostics = updated.providerDiagnostics;
      this.searchJobs.set(jobId, current);
      this.syncSearchSessionMetadata(current);
      return current;
    }

    const offersUnchanged = updated.offers === current.offers && updated.allOffers === current.allOffers;
    const timestamp = nowIso();
    const rewrittenAllOffers = offersUnchanged
      ? current.allOffers
      : updated.allOffers.map((offer) => this.rewriteOfferPaths(jobId, offer));
    const rewrittenOffersById = offersUnchanged
      ? undefined
      : new Map(rewrittenAllOffers.map((offer) => [offer.id, offer] as const));
    const rewrittenOffers = offersUnchanged
      ? current.offers
      : updated.offers.map((offer) => rewrittenOffersById?.get(offer.id) ?? this.rewriteOfferPaths(jobId, offer));
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
    if (!offersUnchanged) {
      this.pruneSessionOwners(jobId, new Set([
        ...rewrittenAllOffers.map((offer) => offer.id),
        ...rewrittenOffers.map((offer) => offer.id),
      ]));
    }
    if (options.persist === false) {
      this.deferredSearchJobs.add(jobId);
      this.schedulePersist();
    } else {
      this.deferredSearchJobs.delete(jobId);
      this.schedulePersist();
    }
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
      return this.readPersistedPurchasePath(purchasePathId);
    }

    if (!this.searchJobs.has(stored.sessionId) && !this.matrixJobs.has(stored.sessionId)) {
      this.forgetPurchasePathById(stored.sessionId, purchasePathId);
      return undefined;
    }

    const timestamp = nowIso();
    const persistedPath = this.persistedPurchasePaths.get(purchasePathId);
    const previousPathVersion = purchasePathPersistenceVersion(stored);
    stored.lastAccessedAt = timestamp;
    this.purchasePaths.set(purchasePathId, stored);
    if (persistedPath?.version === previousPathVersion) {
      persistedPath.version = purchasePathPersistenceVersion(stored);
    }
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

  getRedirectContext(sessionId: string): Pick<SearchSessionRecord, "providerContext" | "request"> | undefined {
    const searchJob = this.searchJobs.get(sessionId);
    if (searchJob) {
      return {
        request: searchJob.request,
        providerContext: searchJob.providerContext,
      };
    }

    const matrixJob = this.matrixJobs.get(sessionId);
    if (matrixJob) {
      return {
        request: matrixJob.request,
        providerContext: matrixJob.providerContext,
      };
    }

    if (!this.db) {
      return undefined;
    }

    const searchRow = getSql<SqliteStoredRedirectContextRow>(this.db, `
      SELECT
        request_key AS requestKey,
        provider_context_key AS providerContextKey,
        idle_at_ms AS idleAtMs
      FROM search_jobs
      WHERE id = ?
      LIMIT 1
    `, sessionId);
    if (searchRow && !this.isPersistedJobExpired(searchRow.idleAtMs)) {
      const request = parseJsonPayload<SearchRequest>(searchRow.requestKey ?? "");
      if (request) {
        return {
          request,
          providerContext: parseJsonPayload<ProviderContext | null>(searchRow.providerContextKey ?? "") ?? undefined,
        };
      }
    }

    const matrixRow = getSql<SqliteStoredRedirectContextRow>(this.db, `
      SELECT
        request_key AS requestKey,
        provider_context_key AS providerContextKey,
        idle_at_ms AS idleAtMs
      FROM matrix_jobs
      WHERE id = ?
      LIMIT 1
    `, sessionId);
    if (!matrixRow || this.isPersistedJobExpired(matrixRow.idleAtMs)) {
      return undefined;
    }

    if (matrixRow.requestKey) {
      const request = parseJsonPayload<SearchRequest>(matrixRow.requestKey);
      return request
        ? {
            request,
            providerContext: parseJsonPayload<ProviderContext | null>(matrixRow.providerContextKey ?? "") ?? undefined,
          }
        : undefined;
    }

    const legacyRow = getSql<SqliteStoredRedirectContextRow>(this.db, `
      SELECT payload, idle_at_ms AS idleAtMs
      FROM matrix_jobs
      WHERE id = ?
      LIMIT 1
    `, sessionId);
    const persisted = legacyRow?.payload
      ? parseJsonPayload<MatrixJobRecord>(legacyRow.payload)
      : undefined;
    return persisted ? { request: persisted.request, providerContext: persisted.providerContext } : undefined;
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
      return this.readPersistedMatrixJob(jobId);
    }

    this.touchMatrixJob(job);
    return job;
  }

  updateMatrixJob(
    jobId: string,
    updater: (current: MatrixJobRecord) => MatrixJobRecord,
    options: { persist?: boolean } = {},
  ): MatrixJobRecord | undefined {
    const current = this.matrixJobs.get(jobId);
    if (!current) {
      return undefined;
    }

    const updated = updater(current);
    if (updated === current) {
      if (options.persist !== false && this.deferredMatrixJobs.delete(jobId)) {
        this.schedulePersist();
      }
      return current;
    }

    if (onlyProviderDiagnosticsChanged(current, updated)) {
      current.providerDiagnostics = updated.providerDiagnostics;
      this.matrixJobs.set(jobId, current);
      return current;
    }

    const cellsUnchanged = updated.cells === current.cells;
    const timestamp = nowIso();
    const rewrittenCells = cellsUnchanged
      ? current.cells
      : updated.cells.map((cell) => this.rewriteMatrixCellPaths(jobId, cell));
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
    if (!cellsUnchanged) {
      this.pruneSessionOwners(jobId, new Set(rewrittenCells.map((cell) => cell.key)));
    }
    if (options.persist === false) {
      this.deferredMatrixJobs.add(jobId);
      this.schedulePersist();
    } else {
      this.deferredMatrixJobs.delete(jobId);
      this.schedulePersist();
    }
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

  enforceCompletedResidentBudget(nowMs = this.scheduler.now()): void {
    if (!this.db) {
      return;
    }

    /*
     * A running job is resident too.
     *
     * The budget used to skip everything that was not `completed`, so the jobs
     * costing the most memory were exactly the ones it could not see. A
     * migratory sweep is one server search job per month, up to twelve at once,
     * each holding its full `allOffers` — and while the later months run, the
     * finished ones sat resident under a budget that believed it had room.
     *
     * Running jobs are counted but never evicted: cancelling live work to save
     * memory would be answering the wrong question. What they do is bring the
     * eviction of *completed* jobs forward, which is the relief that was
     * missing.
     */
    const candidates: ResidentJobCandidate[] = [];
    let inFlightBytes = 0;
    for (const job of this.searchJobs.values()) {
      const bytes = this.persistedResidentBytes(job.id, searchJobPersistenceVersion(job), "search");
      if (bytes === undefined) {
        continue;
      }
      if (job.status !== "completed") {
        inFlightBytes += bytes;
        continue;
      }
      candidates.push({
        id: job.id,
        kind: "search",
        bytes,
        completedAtMs: resolveSearchCompletionTimestampMs(job),
        lastAccessedAtMs: resolveIdleTimestampMs(job),
      });
    }
    for (const job of this.matrixJobs.values()) {
      const bytes = this.persistedResidentBytes(job.id, matrixJobPersistenceVersion(job), "matrix");
      if (bytes === undefined) {
        continue;
      }
      if (job.status !== "completed") {
        inFlightBytes += bytes;
        continue;
      }
      candidates.push({
        id: job.id,
        kind: "matrix",
        bytes,
        completedAtMs: resolveSearchCompletionTimestampMs(job),
        lastAccessedAtMs: resolveIdleTimestampMs(job),
      });
    }

    let residentBytes = candidates.reduce((total, candidate) => total + candidate.bytes, inFlightBytes);
    if (residentBytes <= this.completedResidentBudgetBytes) {
      this.clearResidentBudgetTimer();
      return;
    }

    candidates.sort((left, right) =>
      left.lastAccessedAtMs - right.lastAccessedAtMs
      || left.completedAtMs - right.completedAtMs
      || left.kind.localeCompare(right.kind)
      || left.id.localeCompare(right.id));
    let evictedJobs = 0;
    let evictedBytes = 0;
    let nextEligibleAt = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      if (residentBytes <= this.completedResidentBudgetBytes) {
        break;
      }
      if ((nowMs - candidate.completedAtMs) < COMPLETED_SEARCH_SESSION_RESIDENT_GRACE_MS) {
        nextEligibleAt = Math.min(
          nextEligibleAt,
          candidate.completedAtMs + COMPLETED_SEARCH_SESSION_RESIDENT_GRACE_MS,
        );
        continue;
      }

      this.evictResidentJob(candidate);
      residentBytes -= candidate.bytes;
      evictedJobs += 1;
      evictedBytes += candidate.bytes;
    }

    if (evictedJobs > 0) {
      console.warn(
        `Fly Desk resident cache evicted completed jobs: jobs=${evictedJobs} payloadBytes=${evictedBytes} budgetBytes=${this.completedResidentBudgetBytes}`,
      );
    }
    if (residentBytes > this.completedResidentBudgetBytes && Number.isFinite(nextEligibleAt)) {
      this.scheduleResidentBudgetEnforcement(Math.max(1, nextEligibleAt - nowMs));
    } else {
      this.clearResidentBudgetTimer();
    }
  }

  purgeExpired(nowMs = this.scheduler.now()): PurgeSummary {
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
      this.deferredSearchJobs.delete(jobId);
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
      this.deferredMatrixJobs.delete(jobId);
      this.forgetSessionPurchasePaths(jobId);
    }

    if (removedSearchJobs > 0 || removedMatrixJobs > 0) {
      this.schedulePersist();
    }

    this.pruneExpiredDiskOnlyRows(nowMs);
    this.enforceCompletedResidentBudget(nowMs);

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
    const completedSearchJobs = searchJobs.filter((job) => job.status === "completed");
    const completedMatrixJobs = matrixJobs.filter((job) => job.status === "completed");
    const residentCompletedBytes = completedSearchJobs.reduce(
      (total, job) => total + this.persistedSessionBytes(job.id, "search", this.sessionPurchasePathIds.get(job.id)),
      0,
    ) + completedMatrixJobs.reduce(
      (total, job) => total + this.persistedSessionBytes(job.id, "matrix", this.sessionPurchasePathIds.get(job.id)),
      0,
    );
    const diskOnlyIds = [
      ...[...this.diskOnlySearchJobs.keys()].map((id) => [id, "search"] as const),
      ...[...this.diskOnlyMatrixJobs.keys()].map((id) => [id, "matrix"] as const),
    ];
    return {
      generatedAt: nowIso(),
      ttlMs: COMPLETED_SEARCH_SESSION_TTL_MS,
      residentCache: {
        budgetBytes: this.completedResidentBudgetBytes,
        completedJobs: completedSearchJobs.length + completedMatrixJobs.length,
        completedBytes: residentCompletedBytes,
        diskOnlyJobs: diskOnlyIds.length,
        diskOnlyBytes: diskOnlyIds.reduce(
          (total, [id, kind]) => total + this.persistedSessionBytes(
            id,
            kind,
            this.diskOnlySessionPurchasePathIds.get(id),
          ),
          0,
        ),
      },
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

  private persistedResidentBytes(
    sessionId: string,
    version: string,
    kind: ResidentJobCandidate["kind"],
  ): number | undefined {
    const jobState = kind === "search"
      ? this.persistedSearchJobs.get(sessionId)
      : this.persistedMatrixJobs.get(sessionId);
    if (!jobState || jobState.version !== version) {
      return undefined;
    }

    let bytes = jobState.bytes;
    for (const purchasePathId of this.sessionPurchasePathIds.get(sessionId) ?? []) {
      const path = this.purchasePaths.get(purchasePathId);
      const pathState = this.persistedPurchasePaths.get(purchasePathId);
      if (!path || !pathState || pathState.version !== purchasePathPersistenceVersion(path)) {
        return undefined;
      }
      bytes += pathState.bytes;
    }
    return bytes;
  }

  private persistedSessionBytes(
    sessionId: string,
    kind: ResidentJobCandidate["kind"],
    purchasePathIds: Set<string> | undefined,
  ): number {
    let bytes = (kind === "search"
      ? this.persistedSearchJobs.get(sessionId)
      : this.persistedMatrixJobs.get(sessionId))?.bytes ?? 0;
    for (const purchasePathId of purchasePathIds ?? []) {
      bytes += this.persistedPurchasePaths.get(purchasePathId)?.bytes ?? 0;
    }
    return bytes;
  }

  private evictResidentJob(candidate: ResidentJobCandidate): void {
    if (candidate.kind === "search") {
      this.searchJobs.delete(candidate.id);
      this.deferredSearchJobs.delete(candidate.id);
      this.sessions.delete(candidate.id);
      this.diskOnlySearchJobs.set(candidate.id, candidate.lastAccessedAtMs);
    } else {
      this.matrixJobs.delete(candidate.id);
      this.deferredMatrixJobs.delete(candidate.id);
      this.diskOnlyMatrixJobs.set(candidate.id, candidate.lastAccessedAtMs);
    }

    const purchasePathIds = new Set(this.sessionPurchasePathIds.get(candidate.id) ?? []);
    for (const purchasePathId of purchasePathIds) {
      this.purchasePaths.delete(purchasePathId);
      this.diskOnlyPurchasePathIds.add(purchasePathId);
    }
    for (const ownerKey of this.sessionOwnerKeys.get(candidate.id) ?? []) {
      this.ownerPurchasePathIds.delete(ownerKey);
    }
    this.sessionPurchasePathIds.delete(candidate.id);
    this.sessionOwnerKeys.delete(candidate.id);
    if (purchasePathIds.size > 0) {
      this.diskOnlySessionPurchasePathIds.set(candidate.id, purchasePathIds);
    }
  }

  private pruneExpiredDiskOnlyRows(nowMs: number): void {
    if (!this.db) {
      return;
    }

    const cutoffMs = nowMs - COMPLETED_SEARCH_SESSION_TTL_MS;
    const expiredSearchIds = [...this.diskOnlySearchJobs.entries()]
      .filter(([, idleAtMs]) => idleAtMs < cutoffMs)
      .map(([id]) => id);
    const expiredMatrixIds = [...this.diskOnlyMatrixJobs.entries()]
      .filter(([, idleAtMs]) => idleAtMs < cutoffMs)
      .map(([id]) => id);
    if (expiredSearchIds.length === 0 && expiredMatrixIds.length === 0) {
      return;
    }

    const db = this.db;
    const deletePurchasePaths = db.prepare("DELETE FROM purchase_paths WHERE session_id = ?");
    const deleteSearchJob = db.prepare("DELETE FROM search_jobs WHERE id = ?");
    const deleteMatrixJob = db.prepare("DELETE FROM matrix_jobs WHERE id = ?");
    try {
      db.transaction(() => {
        for (const id of expiredSearchIds) {
          deletePurchasePaths.run(id);
          deleteSearchJob.run(id);
        }
        for (const id of expiredMatrixIds) {
          deletePurchasePaths.run(id);
          deleteMatrixJob.run(id);
        }
      })();
    } catch {
      return;
    } finally {
      deletePurchasePaths.finalize();
      deleteSearchJob.finalize();
      deleteMatrixJob.finalize();
    }

    for (const id of [...expiredSearchIds, ...expiredMatrixIds]) {
      this.diskOnlySearchJobs.delete(id);
      this.diskOnlyMatrixJobs.delete(id);
      this.persistedSearchJobs.delete(id);
      this.persistedMatrixJobs.delete(id);
      for (const purchasePathId of this.diskOnlySessionPurchasePathIds.get(id) ?? []) {
        this.diskOnlyPurchasePathIds.delete(purchasePathId);
        this.persistedPurchasePaths.delete(purchasePathId);
      }
      this.diskOnlySessionPurchasePathIds.delete(id);
    }
  }

  private readPersistedPurchasePath(purchasePathId: string): StoredPurchasePath | undefined {
    if (!this.db) {
      return undefined;
    }

    const row = getSql<SqliteStoredRedirectRow>(this.db, `
      SELECT
        purchase_paths.payload,
        COALESCE(search_jobs.idle_at_ms, matrix_jobs.idle_at_ms) AS idleAtMs
      FROM purchase_paths
      LEFT JOIN search_jobs ON search_jobs.id = purchase_paths.session_id
      LEFT JOIN matrix_jobs ON matrix_jobs.id = purchase_paths.session_id
      WHERE purchase_paths.id = ?
        AND (search_jobs.id IS NOT NULL OR matrix_jobs.id IS NOT NULL)
      LIMIT 1
    `, purchasePathId);
    if (!row || this.isPersistedJobExpired(row.idleAtMs)) {
      return undefined;
    }

    const stored = parseJsonPayload<StoredPurchasePath>(row.payload);
    return stored?.path?.id === purchasePathId ? stored : undefined;
  }

  private readPersistedSearchJob(jobId: string): SearchJobRecord | undefined {
    if (!this.db || !this.diskOnlySearchJobs.has(jobId)) {
      return undefined;
    }

    const row = getSql<SqliteStoredRedirectRow>(this.db, `
      SELECT payload, idle_at_ms AS idleAtMs
      FROM search_jobs
      WHERE id = ?
      LIMIT 1
    `, jobId);
    if (!row || this.isPersistedJobExpired(row.idleAtMs)) {
      return undefined;
    }

    const job = parseJsonPayload<SearchJobRecord>(row.payload);
    return job?.id === jobId && job.status === "completed"
      ? redactSearchJobForPersistence(job)
      : undefined;
  }

  private readPersistedMatrixJob(jobId: string): MatrixJobRecord | undefined {
    if (!this.db || !this.diskOnlyMatrixJobs.has(jobId)) {
      return undefined;
    }

    const row = getSql<SqliteStoredRedirectRow>(this.db, `
      SELECT payload, idle_at_ms AS idleAtMs
      FROM matrix_jobs
      WHERE id = ?
      LIMIT 1
    `, jobId);
    if (!row || this.isPersistedJobExpired(row.idleAtMs)) {
      return undefined;
    }

    const job = parseJsonPayload<MatrixJobRecord>(row.payload);
    return job?.id === jobId && job.status === "completed"
      ? redactMatrixJobForPersistence(job)
      : undefined;
  }

  private isPersistedJobExpired(idleAtMs: number): boolean {
    return !Number.isFinite(idleAtMs)
      || idleAtMs <= 0
      || (this.scheduler.now() - idleAtMs) > COMPLETED_SEARCH_SESSION_TTL_MS;
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
    const persisted = this.persistedSearchJobs.get(job.id);
    const previousVersion = searchJobPersistenceVersion(job);
    job.lastAccessedAt = timestamp;
    this.searchJobs.set(job.id, job);
    if (persisted?.version === previousVersion) {
      persisted.version = searchJobPersistenceVersion(job);
    }
    return timestamp;
  }

  private touchMatrixJob(job: MatrixJobRecord, timestamp = nowIso()): string {
    const persisted = this.persistedMatrixJobs.get(job.id);
    const previousVersion = matrixJobPersistenceVersion(job);
    job.lastAccessedAt = timestamp;
    this.matrixJobs.set(job.id, job);
    if (persisted?.version === previousVersion) {
      persisted.version = matrixJobPersistenceVersion(job);
    }
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
  }

  private clearResidentBudgetTimer(): void {
    if (this.residentBudgetTimer) {
      this.scheduler.clearTimeout(this.residentBudgetTimer);
      this.residentBudgetTimer = undefined;
    }
    this.residentBudgetDueAt = 0;
  }

  private scheduleResidentBudgetEnforcement(delayMs: number): void {
    const boundedDelayMs = Math.max(1, Math.trunc(delayMs));
    const dueAt = this.scheduler.now() + boundedDelayMs;
    if (this.residentBudgetTimer && this.residentBudgetDueAt <= dueAt) {
      return;
    }
    this.clearResidentBudgetTimer();
    this.residentBudgetDueAt = dueAt;
    this.residentBudgetTimer = this.scheduler.setTimeout(() => {
      this.residentBudgetTimer = undefined;
      this.residentBudgetDueAt = 0;
      this.enforceCompletedResidentBudget();
    }, boundedDelayMs);
  }

  /*
   * Durability policy, half one: the debounce is the only thing that schedules
   * a write, and a write that fails schedules nothing of its own.
   *
   * That is deliberate rather than an omission. The three `persisted*` maps
   * that decide what a write has to carry are updated only after the
   * transaction commits, so a failed write leaves the whole diff — the changed
   * rows and the deleted ids alike — still owed. The next mutation's debounce
   * carries it, and `close()` carries whatever is left at shutdown; nothing is
   * recomputed and nothing is lost in memory. A retry timer of its own would
   * add a second schedule that, against a disk that is full or read-only,
   * would spin every 180ms for the life of the process without writing a byte.
   *
   * What the policy costs is the window between a failed write and the next
   * mutation on an idle desk: for that stretch the results are memory-only, so
   * the failure is said out loud below rather than swallowed.
   */
  private schedulePersist(): void {
    if (!this.db || this.bootstrapping || this.persistTimer) {
      return;
    }

    this.persistTimer = this.scheduler.setTimeout(() => {
      this.persistTimer = undefined;
      this.persistNow();
    }, SESSION_STORE_PERSIST_DEBOUNCE_MS);
  }

  private persistNow(): boolean {
    if (!this.db) {
      return false;
    }

    const persistStart = startPerfTimer();
    try {
      const persistableSessionIds = new Set<string>([
        ...[...this.searchJobs.values()].filter((job) => isPersistableStatus(job.status)).map((job) => job.id),
        ...[...this.matrixJobs.values()].filter((job) => isPersistableStatus(job.status)).map((job) => job.id),
      ]);
      const activeSearchJobs = [...this.searchJobs.values()].filter(
        (job) => isPersistableStatus(job.status) && !this.deferredSearchJobs.has(job.id),
      );
      const activeMatrixJobs = [...this.matrixJobs.values()].filter(
        (job) => isPersistableStatus(job.status) && !this.deferredMatrixJobs.has(job.id),
      );
      const activeOwnerKeys = new Set(this.ownerPurchasePathIds.keys());
      const activePurchasePaths = [...this.purchasePaths.values()].filter(
        (path) => persistableSessionIds.has(path.sessionId)
          && activeOwnerKeys.has(this.ownerKey(path.sessionId, path.ownerId)),
      );
      const activeSearchJobIds = new Set(activeSearchJobs.map((job) => job.id));
      const activeMatrixJobIds = new Set(activeMatrixJobs.map((job) => job.id));
      const activePurchasePathIds = new Set(activePurchasePaths.map((path) => path.path.id));

      const deletedSearchJobIds = [...this.persistedSearchJobs.keys()]
        .filter((id) => !activeSearchJobIds.has(id)
          && !this.diskOnlySearchJobs.has(id)
          && !this.deferredSearchJobs.has(id));
      const deletedMatrixJobIds = [...this.persistedMatrixJobs.keys()]
        .filter((id) => !activeMatrixJobIds.has(id)
          && !this.diskOnlyMatrixJobs.has(id)
          && !this.deferredMatrixJobs.has(id));
      const deletedPurchasePathIds = [...this.persistedPurchasePaths.keys()]
        .filter((id) => !activePurchasePathIds.has(id) && !this.diskOnlyPurchasePathIds.has(id));
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
          payload,
          payload_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          idle_at_ms = excluded.idle_at_ms,
          status = excluded.status,
          sort_mode = excluded.sort_mode,
          request_key = excluded.request_key,
          provider_ids_key = excluded.provider_ids_key,
          provider_context_key = excluded.provider_context_key,
          payload = excluded.payload,
          payload_bytes = excluded.payload_bytes
      `);
      const upsertMatrixJob = db.prepare(`
        INSERT INTO matrix_jobs (
          id,
          idle_at_ms,
          status,
          request_key,
          provider_context_key,
          payload,
          payload_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          idle_at_ms = excluded.idle_at_ms,
          status = excluded.status,
          request_key = excluded.request_key,
          provider_context_key = excluded.provider_context_key,
          payload = excluded.payload,
          payload_bytes = excluded.payload_bytes
      `);
      const upsertPurchasePath = db.prepare(`
        INSERT INTO purchase_paths (
          id,
          session_id,
          owner_id,
          fingerprint,
          payload,
          payload_bytes
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          session_id = excluded.session_id,
          owner_id = excluded.owner_id,
          fingerprint = excluded.fingerprint,
          payload = excluded.payload,
          payload_bytes = excluded.payload_bytes
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
              Buffer.byteLength(entry.payload, "utf8"),
            );
          }

          for (const entry of changedMatrixJobs) {
            upsertMatrixJob.run(
              entry.job.id,
              resolveIdleTimestampMs(entry.job),
              entry.job.status,
              serializeForComparison(normalizeSearchRequestForSearchCache(entry.job.request)),
              serializeForComparison(normalizeProviderContextForSearchCache(entry.job.providerContext)),
              entry.payload,
              Buffer.byteLength(entry.payload, "utf8"),
            );
          }

          for (const entry of changedPurchasePaths) {
            upsertPurchasePath.run(
              entry.path.path.id,
              entry.path.sessionId,
              entry.path.ownerId,
              entry.path.fingerprint,
              entry.payload,
              Buffer.byteLength(entry.payload, "utf8"),
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
      this.enforceCompletedResidentBudget();

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
    } catch (error) {
      /* The in-memory store stays usable and stays authoritative, so this is
         not a request failure and must not become one. It is still the one
         moment where the desk stops being durable, and the operator is the
         only one who can act on it — see `schedulePersist()` for why no retry
         is armed here. */
      const detail = error instanceof Error ? error.message : "unknown persistence failure";
      console.warn(`Fly Desk session cache write failed; the change stays in memory until the next one: ${detail}`);
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

      -- The sweep's own index. idx_search_jobs_lookup leads with status, so a
      -- range on idle_at_ms alone cannot seek it and the prune fell back to
      -- reading the table: every row, payload and all.
      CREATE INDEX IF NOT EXISTS idx_search_jobs_idle_at
        ON search_jobs (idle_at_ms);

      CREATE TABLE IF NOT EXISTS matrix_jobs (
        id TEXT PRIMARY KEY,
        idle_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        request_key TEXT,
        provider_context_key TEXT,
        payload TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_matrix_jobs_idle
        ON matrix_jobs (status, idle_at_ms);

      CREATE INDEX IF NOT EXISTS idx_matrix_jobs_idle_at
        ON matrix_jobs (idle_at_ms);

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

    const matrixColumns = new Set(
      allSql<{ name: string }>(this.db, "PRAGMA table_info(matrix_jobs)")
        .map((column) => column.name),
    );
    if (!matrixColumns.has("request_key")) {
      runSql(this.db, "ALTER TABLE matrix_jobs ADD COLUMN request_key TEXT");
    }
    if (!matrixColumns.has("provider_context_key")) {
      runSql(this.db, "ALTER TABLE matrix_jobs ADD COLUMN provider_context_key TEXT");
    }

    /*
     * What a row's payload weighs, written down instead of weighed at boot.
     *
     * The restore used to ask SQLite for `length(payload)` on every row of
     * every table — twice: once to pick what fits the resident budget, once to
     * fill the maps that decide what a later write owes. `length` on a stored
     * value is a read, so booting measured the whole store: on the production
     * box that is 55 jobs and 1.78 GB, and the search runner took **84 seconds
     * to open its port**, of which 47 went to the first scan and the rest to
     * the second. The release engine's health window is shorter than that, so
     * every deployment failed activation, rolled back, and paid the same 84
     * seconds again on the way out — «previous release did not recover
     * cleanly», with the port closed throughout.
     *
     * The column is filled on write. A row written before it existed keeps
     * `NULL`, and every read below coalesces that to one byte over the resident
     * budget: an unmeasured row is treated as too big to hold in memory, which
     * is what it was being treated as anyway, and no boot ever reads a payload
     * again to find out.
     */
    for (const table of ["search_jobs", "matrix_jobs", "purchase_paths"] as const) {
      const columns = new Set(
        allSql<{ name: string }>(this.db, `PRAGMA table_info(${table})`)
          .map((column) => column.name),
      );
      if (!columns.has("payload_bytes")) {
        runSql(this.db, `ALTER TABLE ${table} ADD COLUMN payload_bytes INTEGER`);
      }
    }
  }

  /** One byte over the budget: what an unmeasured row is worth to the restore. */
  private get unmeasuredPayloadBytes(): number {
    return this.persistedRestoreBudgetBytes + 1;
  }

  private loadPersisted(): void {
    /*
     * Timed by phase, and said out loud when it is slow.
     *
     * This runs before the port opens, so a slow boot is an outage and a failed
     * deployment (see the restore budget above). Two rounds of local
     * measurement pointed at the wrong phase before the box's own numbers
     * settled it, so the phases now report themselves: one line, no perf flag
     * to remember, and only when the total is worth reading.
     */
    const startedAt = Date.now();
    const nowMs = this.scheduler.now();
    this.pruneExpiredSqliteRows(nowMs);
    const prunedAt = Date.now();
    const restoreCandidates = this.selectPersistedRowsToRestore();
    const selectedAt = Date.now();
    try {
      this.bootstrapping = true;
      this.loadSqlitePayload(restoreCandidates);
    } finally {
      this.bootstrapping = false;
    }
    const loadedAt = Date.now();

    this.purgeExpired(nowMs);
    const purgedAt = Date.now();
    this.persistNow();
    const finishedAt = Date.now();

    const totalMs = finishedAt - startedAt;
    if (totalMs >= BOOT_TIMING_REPORT_MS) {
      console.warn(
        "Fly Desk persisted cache boot: "
        + `totalMs=${totalMs} pruneMs=${prunedAt - startedAt} selectMs=${selectedAt - prunedAt} `
        + `loadMs=${loadedAt - selectedAt} purgeMs=${purgedAt - loadedAt} persistMs=${finishedAt - purgedAt} `
        + `restored=${restoreCandidates.length} budgetBytes=${this.persistedRestoreBudgetBytes}`,
      );
    }
  }

  private selectPersistedRowsToRestore(): PersistedJobRestoreCandidate[] {
    if (!this.db) {
      return [];
    }

    const unmeasured = this.unmeasuredPayloadBytes;
    const candidates = allSql<PersistedJobRestoreCandidate>(this.db, `
      SELECT
        search_jobs.id,
        'search' AS kind,
        search_jobs.idle_at_ms AS idleAtMs,
        COALESCE(search_jobs.payload_bytes, ?1)
          + COALESCE((
            SELECT SUM(COALESCE(path.payload_bytes, ?1))
            FROM purchase_paths AS path
            WHERE path.session_id = search_jobs.id
          ), 0) AS payloadBytes
      FROM search_jobs
      UNION ALL
      SELECT
        matrix_jobs.id,
        'matrix' AS kind,
        matrix_jobs.idle_at_ms AS idleAtMs,
        COALESCE(matrix_jobs.payload_bytes, ?1)
          + COALESCE((
            SELECT SUM(COALESCE(path.payload_bytes, ?1))
            FROM purchase_paths AS path
            WHERE path.session_id = matrix_jobs.id
          ), 0) AS payloadBytes
      FROM matrix_jobs
      ORDER BY idleAtMs DESC, kind ASC, id ASC
    `, unmeasured);
    let retainedBytes = 0;
    const retained: PersistedJobRestoreCandidate[] = [];
    const diskOnly: PersistedJobRestoreCandidate[] = [];
    for (const candidate of candidates) {
      const payloadBytes = Math.max(0, Number(candidate.payloadBytes) || 0);
      if (retainedBytes + payloadBytes > this.persistedRestoreBudgetBytes) {
        diskOnly.push(candidate);
        if (candidate.kind === "search") {
          this.diskOnlySearchJobs.set(candidate.id, candidate.idleAtMs);
        } else {
          this.diskOnlyMatrixJobs.set(candidate.id, candidate.idleAtMs);
        }
        continue;
      }
      retainedBytes += payloadBytes;
      retained.push(candidate);
    }

    if (diskOnly.length === 0) {
      return retained;
    }

    /* Only what was actually measured is summed. A row written before the size
       column existed counts as one byte over the budget — a marker, not a
       weight — and adding those up reported terabytes for a 1.8 GB store. */
    let diskOnlyBytes = 0;
    let unmeasuredJobs = 0;
    for (const candidate of diskOnly) {
      const bytes = Math.max(0, Number(candidate.payloadBytes) || 0);
      if (bytes >= unmeasured) {
        unmeasuredJobs += 1;
        continue;
      }
      diskOnlyBytes += bytes;
    }
    console.warn(
      `Fly Desk persisted cache restore budget kept jobs disk-only: jobs=${diskOnly.length}`
      + ` payloadBytes=${diskOnlyBytes} unmeasuredJobs=${unmeasuredJobs}`
      + ` budgetBytes=${this.persistedRestoreBudgetBytes}`,
    );
    return retained;
  }

  private pruneExpiredSqliteRows(nowMs: number): void {
    if (!this.db) {
      return;
    }

    const cutoffMs = nowMs - COMPLETED_SEARCH_SESSION_TTL_MS;
    const db = this.db;
    /*
     * The condition is split in two, and the halves are `UNION`ed rather than
     * `OR`ed, because an `OR` across two columns leaves SQLite nothing to seek:
     * it read the table, and this table's rows carry the payloads. Measured on
     * the production box, the prune alone was 16.6s of a 22.1s boot with 55
     * jobs and 1.78 GB — while deleting nothing, because none of them had
     * expired. Each half can use an index now: the age against
     * `idx_*_idle_at`, and the status against the lookup index it already
     * leads. What the sweep takes is the rows it actually removes.
     */
    db.transaction(() => {
      for (const statement of PERSISTED_SWEEP_STATEMENTS) {
        runSql(db, statement, cutoffMs);
      }
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

  private loadSqlitePayload(restoreCandidates: PersistedJobRestoreCandidate[]): void {
    if (!this.db) {
      return;
    }

    const unmeasured = this.unmeasuredPayloadBytes;
    const searchRows = allSql<{ id: string; payloadBytes: number }>(
      this.db,
      "SELECT id, COALESCE(payload_bytes, ?1) AS payloadBytes FROM search_jobs",
      unmeasured,
    );
    const matrixRows = allSql<{ id: string; payloadBytes: number }>(
      this.db,
      "SELECT id, COALESCE(payload_bytes, ?1) AS payloadBytes FROM matrix_jobs",
      unmeasured,
    );
    const pathRows = allSql<{ id: string; sessionId: string; payloadBytes: number }>(this.db, `
      SELECT id, session_id AS sessionId, COALESCE(payload_bytes, ?1) AS payloadBytes
      FROM purchase_paths
    `, unmeasured);
    searchRows.forEach((row) => this.persistedSearchJobs.set(row.id, {
      version: "",
      bytes: Math.max(0, Number(row.payloadBytes) || 0),
    }));
    matrixRows.forEach((row) => this.persistedMatrixJobs.set(row.id, {
      version: "",
      bytes: Math.max(0, Number(row.payloadBytes) || 0),
    }));
    pathRows.forEach((row) => {
      this.persistedPurchasePaths.set(row.id, {
        version: "",
        bytes: Math.max(0, Number(row.payloadBytes) || 0),
      });
      if (!this.diskOnlySearchJobs.has(row.sessionId) && !this.diskOnlyMatrixJobs.has(row.sessionId)) {
        return;
      }
      this.diskOnlyPurchasePathIds.add(row.id);
      const pathIds = this.diskOnlySessionPurchasePathIds.get(row.sessionId) ?? new Set<string>();
      pathIds.add(row.id);
      this.diskOnlySessionPurchasePathIds.set(row.sessionId, pathIds);
    });

    const parsedSearchJobs: SearchJobRecord[] = [];
    const parsedMatrixJobs: MatrixJobRecord[] = [];
    const parsedPurchasePaths: StoredPurchasePath[] = [];
    for (const candidate of restoreCandidates) {
      const row = getSql<SqlitePayloadRow>(
        this.db,
        `SELECT id, payload FROM ${candidate.kind === "search" ? "search_jobs" : "matrix_jobs"} WHERE id = ?`,
        candidate.id,
      );
      if (row) {
        if (candidate.kind === "search") {
          const parsed = parseJsonPayload<SearchJobRecord>(row.payload);
          if (parsed) {
            const redacted = redactSearchJobForPersistence(parsed);
            this.persistedSearchJobs.set(row.id, {
              version: parsed.providerContext?.costamar?.token ? "" : searchJobPersistenceVersion(redacted),
              bytes: Buffer.byteLength(row.payload, "utf8"),
            });
            parsedSearchJobs.push(redacted);
          }
        } else {
          const parsed = parseJsonPayload<MatrixJobRecord>(row.payload);
          if (parsed) {
            const redacted = redactMatrixJobForPersistence(parsed);
            this.persistedMatrixJobs.set(row.id, {
              version: parsed.providerContext?.costamar?.token ? "" : matrixJobPersistenceVersion(redacted),
              bytes: Buffer.byteLength(row.payload, "utf8"),
            });
            parsedMatrixJobs.push(redacted);
          }
        }
      }

      const paths = allSql<SqlitePayloadRow>(
        this.db,
        "SELECT id, payload FROM purchase_paths WHERE session_id = ? ORDER BY id",
        candidate.id,
      );
      for (const pathRow of paths) {
        const parsed = parseJsonPayload<StoredPurchasePath>(pathRow.payload);
        if (!parsed) {
          continue;
        }
        const redacted = redactStoredPurchasePathForPersistence(parsed);
        this.persistedPurchasePaths.set(pathRow.id, {
          version: redacted.path.url === parsed.path.url && redacted.fingerprint === parsed.fingerprint
            ? purchasePathPersistenceVersion(redacted)
            : "",
          bytes: Buffer.byteLength(pathRow.payload, "utf8"),
        });
        parsedPurchasePaths.push(redacted);
      }
    }

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
