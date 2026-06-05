export type SearchAdmissionKind = "exact" | "range" | "matrix";

export type SearchAdmissionErrorCode = "queue-full" | "queue-timeout" | "cancelled";

export interface SearchAdmissionLimits {
  capacityUnits: number;
  exactCostUnits: number;
  rangeCostUnits: number;
  matrixCostUnits: number;
  maxQueued: number;
  queueTimeoutMs: number;
}

export interface SearchAdmissionRequest {
  kind: SearchAdmissionKind;
  jobId?: string;
  shouldContinue?: () => boolean;
}

export interface SearchAdmissionLease {
  kind: SearchAdmissionKind;
  jobId?: string;
  costUnits: number;
  queuedMs: number;
  release: () => void;
}

export interface SearchAdmissionDiagnostics {
  capacityUnits: number;
  activeUnits: number;
  queuedUnits: number;
  activeCount: number;
  queuedCount: number;
  maxQueued: number;
  queueTimeoutMs: number;
  active: Array<{
    kind: SearchAdmissionKind;
    jobId?: string;
    costUnits: number;
    activeMs: number;
  }>;
  queued: Array<{
    kind: SearchAdmissionKind;
    jobId?: string;
    costUnits: number;
    queuedMs: number;
  }>;
}

interface ActiveEntry {
  id: symbol;
  kind: SearchAdmissionKind;
  jobId?: string;
  costUnits: number;
  startedAtMs: number;
}

interface QueuedEntry {
  id: symbol;
  kind: SearchAdmissionKind;
  jobId?: string;
  costUnits: number;
  enqueuedAtMs: number;
  shouldContinue?: () => boolean;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (lease: SearchAdmissionLease) => void;
  reject: (error: SearchAdmissionError) => void;
}

const DEFAULT_LIMITS: SearchAdmissionLimits = {
  capacityUnits: 4,
  exactCostUnits: 1,
  rangeCostUnits: 2,
  matrixCostUnits: 2,
  maxQueued: 8,
  queueTimeoutMs: 120_000,
};

export class SearchAdmissionError extends Error {
  constructor(
    public readonly code: SearchAdmissionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SearchAdmissionError";
  }
}

function readPositiveInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveSearchAdmissionLimits(
  env: Record<string, string | undefined> = process.env,
): SearchAdmissionLimits {
  const capacityUnits = readPositiveInteger(env, "FLY_DESK_SEARCH_CAPACITY_UNITS", DEFAULT_LIMITS.capacityUnits);
  return {
    capacityUnits,
    exactCostUnits: Math.min(
      capacityUnits,
      readPositiveInteger(env, "FLY_DESK_SEARCH_EXACT_COST_UNITS", DEFAULT_LIMITS.exactCostUnits),
    ),
    rangeCostUnits: Math.min(
      capacityUnits,
      readPositiveInteger(env, "FLY_DESK_SEARCH_RANGE_COST_UNITS", DEFAULT_LIMITS.rangeCostUnits),
    ),
    matrixCostUnits: Math.min(
      capacityUnits,
      readPositiveInteger(env, "FLY_DESK_SEARCH_MATRIX_COST_UNITS", DEFAULT_LIMITS.matrixCostUnits),
    ),
    maxQueued: readPositiveInteger(env, "FLY_DESK_SEARCH_MAX_QUEUED", DEFAULT_LIMITS.maxQueued),
    queueTimeoutMs: readPositiveInteger(env, "FLY_DESK_SEARCH_QUEUE_TIMEOUT_MS", DEFAULT_LIMITS.queueTimeoutMs),
  };
}

export class SearchAdmissionController {
  private readonly limits: SearchAdmissionLimits;
  private readonly active = new Map<symbol, ActiveEntry>();
  private readonly queued: QueuedEntry[] = [];

  constructor(limits: SearchAdmissionLimits = resolveSearchAdmissionLimits()) {
    this.limits = limits;
  }

  acquire(request: SearchAdmissionRequest): Promise<SearchAdmissionLease> {
    const costUnits = this.costForKind(request.kind);
    if (request.shouldContinue && !this.shouldContinue(request.shouldContinue)) {
      return Promise.reject(new SearchAdmissionError("cancelled", "Search was cancelled before admission."));
    }

    if (this.canStart(costUnits)) {
      return Promise.resolve(this.start({
        kind: request.kind,
        jobId: request.jobId,
        costUnits,
        enqueuedAtMs: Date.now(),
      }));
    }

    if (this.queued.length >= this.limits.maxQueued) {
      return Promise.reject(new SearchAdmissionError("queue-full", "Search queue is full."));
    }

    return new Promise((resolve, reject) => {
      const entry: QueuedEntry = {
        id: Symbol("queued-search"),
        kind: request.kind,
        jobId: request.jobId,
        costUnits,
        enqueuedAtMs: Date.now(),
        shouldContinue: request.shouldContinue,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.removeQueued(entry.id);
          reject(new SearchAdmissionError("queue-timeout", "Search waited too long for capacity."));
        }, this.limits.queueTimeoutMs),
      };

      this.queued.push(entry);
    });
  }

  dispose(message = "Search admission controller disposed."): void {
    const queued = this.queued.splice(0);
    for (const entry of queued) {
      clearTimeout(entry.timeout);
      entry.reject(new SearchAdmissionError("cancelled", message));
    }
    this.active.clear();
  }

  async run<T>(request: SearchAdmissionRequest, run: () => Promise<T>): Promise<T> {
    const lease = await this.acquire(request);
    try {
      return await run();
    } finally {
      lease.release();
    }
  }

  getDiagnostics(nowMs = Date.now()): SearchAdmissionDiagnostics {
    return {
      capacityUnits: this.limits.capacityUnits,
      activeUnits: this.activeUnits(),
      queuedUnits: this.queued.reduce((sum, entry) => sum + entry.costUnits, 0),
      activeCount: this.active.size,
      queuedCount: this.queued.length,
      maxQueued: this.limits.maxQueued,
      queueTimeoutMs: this.limits.queueTimeoutMs,
      active: [...this.active.values()].map((entry) => ({
        kind: entry.kind,
        jobId: entry.jobId,
        costUnits: entry.costUnits,
        activeMs: Math.max(0, nowMs - entry.startedAtMs),
      })),
      queued: this.queued.map((entry) => ({
        kind: entry.kind,
        jobId: entry.jobId,
        costUnits: entry.costUnits,
        queuedMs: Math.max(0, nowMs - entry.enqueuedAtMs),
      })),
    };
  }

  private costForKind(kind: SearchAdmissionKind): number {
    switch (kind) {
      case "matrix":
        return this.limits.matrixCostUnits;
      case "range":
        return this.limits.rangeCostUnits;
      case "exact":
      default:
        return this.limits.exactCostUnits;
    }
  }

  private activeUnits(): number {
    return [...this.active.values()].reduce((sum, entry) => sum + entry.costUnits, 0);
  }

  private canStart(costUnits: number): boolean {
    return this.activeUnits() + costUnits <= this.limits.capacityUnits;
  }

  private start(input: {
    kind: SearchAdmissionKind;
    jobId?: string;
    costUnits: number;
    enqueuedAtMs: number;
  }): SearchAdmissionLease {
    const id = Symbol("active-search");
    const entry: ActiveEntry = {
      id,
      kind: input.kind,
      jobId: input.jobId,
      costUnits: input.costUnits,
      startedAtMs: Date.now(),
    };
    this.active.set(id, entry);
    let released = false;

    return {
      kind: input.kind,
      jobId: input.jobId,
      costUnits: input.costUnits,
      queuedMs: Math.max(0, entry.startedAtMs - input.enqueuedAtMs),
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.active.delete(id);
        this.startQueued();
      },
    };
  }

  private startQueued(): void {
    for (;;) {
      const nextIndex = this.queued.findIndex((entry) => this.canStart(entry.costUnits));
      if (nextIndex < 0) {
        return;
      }

      const [entry] = this.queued.splice(nextIndex, 1);
      clearTimeout(entry.timeout);

      if (entry.shouldContinue && !this.shouldContinue(entry.shouldContinue)) {
        entry.reject(new SearchAdmissionError("cancelled", "Search was cancelled before admission."));
        continue;
      }

      entry.resolve(this.start(entry));
    }
  }

  private removeQueued(id: symbol): void {
    const index = this.queued.findIndex((entry) => entry.id === id);
    if (index >= 0) {
      this.queued.splice(index, 1);
    }
  }

  private shouldContinue(callback: () => boolean): boolean {
    try {
      return callback();
    } catch {
      return false;
    }
  }
}
